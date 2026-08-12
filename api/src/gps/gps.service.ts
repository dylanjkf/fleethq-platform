import { createHash, randomBytes } from 'crypto';
import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemPrismaService } from '../prisma/system-prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { IngestGpsDto, RegisterGpsDeviceDto, UpdateGpsDeviceDto } from './dto/gps.dto';

/** How long a fix stays "live" on the map. */
const LIVE_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Per-device ingest ceiling: at most this many positions per window. A normal
 *  tracker reports every few seconds; this allows 2/second, which is generous
 *  headroom, while stopping a leaked key from flooding the ping table. */
const INGEST_WINDOW_MS = 60_000;
const INGEST_MAX_PER_WINDOW = 120;
/** Cap the in-memory counter map so a churn of many device ids can't grow it
 *  without bound; oldest windows are pruned first. */
const INGEST_TRACKER_MAX_KEYS = 10_000;

function newDeviceKey(): string {
  // 32 bytes of entropy, url-safe. Prefixed so it's recognisable in logs/config.
  return `gps_${randomBytes(24).toString('base64url')}`;
}

/**
 * Deterministic SHA-256 of a device key — what we actually store and look up.
 * A fast hash is the right tool here (not bcrypt): the key is high-entropy, so
 * there's nothing to brute-force, and a deterministic digest keeps the ingest
 * lookup a single indexed query instead of scanning every device.
 */
function hashDeviceKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Universal GPS ingest + device registry. Hardware trackers authenticate with
 * their own `deviceKey` (a bearer secret), not a user login, so the ingest path
 * resolves the tenant *from the key* — a global lookup that no per-tenant GUC
 * could scope, which is why that one path runs through the BYPASSRLS
 * `fleetos_auth` role (`systemPrisma`).
 *
 * `gps_devices` and `gps_pings` ARE row-level-security protected (a FORCEd
 * `tenant_isolation` policy, added alongside the rest of the tenant tables), so
 * every user-facing method here goes through the RLS-enforced tenant role via
 * `withTenant` and *additionally* filters by companyId as defence in depth.
 */
@Injectable()
export class GpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemPrisma: SystemPrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Per-device fixed-window ingest counters. In-memory and therefore
   *  per-instance (best-effort behind a load balancer) — a deliberate,
   *  dependency-free flood guard on top of the global per-IP throttle, not a
   *  distributed quota. */
  private readonly ingestWindows = new Map<string, { windowStart: number; count: number }>();

  /** Reject a device that is POSTing positions faster than the ceiling. */
  private assertIngestWithinRate(deviceId: string): void {
    const now = Date.now();
    const entry = this.ingestWindows.get(deviceId);
    if (!entry || now - entry.windowStart >= INGEST_WINDOW_MS) {
      if (this.ingestWindows.size >= INGEST_TRACKER_MAX_KEYS) this.pruneIngestWindows(now);
      this.ingestWindows.set(deviceId, { windowStart: now, count: 1 });
      return;
    }
    if (entry.count >= INGEST_MAX_PER_WINDOW) {
      throw new HttpException(
        { code: 'GPS_INGEST_RATE_LIMITED', message: 'Too many positions for this device; slow down.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    entry.count += 1;
  }

  private pruneIngestWindows(now: number): void {
    for (const [id, entry] of this.ingestWindows) {
      if (now - entry.windowStart >= INGEST_WINDOW_MS) this.ingestWindows.delete(id);
    }
  }

  // ---- Device registry (user-facing, companyId-scoped) ----

  async listDevices(companyId: string) {
    // withTenant sets the company GUC, which now scopes the gps_* tables
    // themselves as well as the joined `asset` — both gps_devices and gps_pings
    // carry a FORCEd tenant_isolation RLS policy. The explicit companyId filter
    // is kept as defence in depth, not because RLS is absent.
    return this.prisma.withTenant(companyId, async (tx) => {
      const devices = await tx.gpsDevice.findMany({
        where: { companyId, archivedAt: null },
        orderBy: { name: 'asc' },
        include: { asset: { select: { id: true, name: true } } },
      });
      // Never return the secret key in a list.
      return {
        items: devices.map((d) => ({
          id: d.id,
          name: d.name,
          provider: d.provider,
          asset: d.asset,
          lastLat: d.lastLat,
          lastLng: d.lastLng,
          lastLocationAt: d.lastLocationAt,
        })),
      };
    });
  }

  async register(companyId: string, dto: RegisterGpsDeviceDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      if (dto.assetId) await this.assertAsset(tx, companyId, dto.assetId);
      const deviceKey = newDeviceKey();
      const device = await tx.gpsDevice.create({
        data: { companyId, name: dto.name.trim(), provider: dto.provider?.trim() || null, assetId: dto.assetId ?? null, deviceKeyHash: hashDeviceKey(deviceKey) },
      });
      // The plaintext key is returned exactly once, at registration, to configure
      // the tracker — only its hash is stored, so it's unrecoverable afterwards.
      return { id: device.id, name: device.name, provider: device.provider, assetId: device.assetId, deviceKey };
    });
  }

  async update(companyId: string, id: string, dto: UpdateGpsDeviceDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireDevice(tx, companyId, id);
      if (dto.assetId) await this.assertAsset(tx, companyId, dto.assetId);
      const device = await tx.gpsDevice.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          provider: dto.provider === undefined ? undefined : dto.provider?.trim() || null,
          assetId: dto.assetId === undefined ? undefined : dto.assetId,
        },
        include: { asset: { select: { id: true, name: true } } },
      });
      return { id: device.id, name: device.name, provider: device.provider, asset: device.asset };
    });
  }

  /** Issue a fresh key (invalidates the old one) — returned once. */
  async rotateKey(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const device = await this.requireDevice(tx, companyId, id);
      const deviceKey = newDeviceKey();
      await tx.gpsDevice.update({ where: { id }, data: { deviceKeyHash: hashDeviceKey(deviceKey) } });

      // Rotating a device's bearer secret invalidates the old key everywhere —
      // a credential-lifecycle event worth an audit line (never the key itself).
      await this.audit.recordInTx(tx, companyId, {
        actorUserId,
        action: AUDIT_ACTIONS.GPS_KEY_ROTATED,
        targetType: 'gps_device',
        targetId: id,
        metadata: { deviceName: device.name },
      });

      return { id, deviceKey };
    });
  }

  async archive(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const device = await this.requireDevice(tx, companyId, id);
      if (!device.archivedAt) await tx.gpsDevice.update({ where: { id }, data: { archivedAt: new Date() } });
      return { id };
    });
  }

  /** Asset positions from GPS hardware — for the live map, companyId-scoped. */
  async positions(companyId: string) {
    const since = new Date(Date.now() - LIVE_WINDOW_MS);
    return this.prisma.withTenant(companyId, async (tx) => {
      const devices = await tx.gpsDevice.findMany({
        where: { companyId, archivedAt: null, lastLocationAt: { gte: since }, lastLat: { not: null }, lastLng: { not: null } },
        include: { asset: { select: { id: true, name: true } } },
      });
      return {
        items: devices.map((d) => ({
          deviceId: d.id,
          deviceName: d.name,
          asset: d.asset,
          lat: d.lastLat!,
          lng: d.lastLng!,
          lastLocationAt: d.lastLocationAt!,
        })),
      };
    });
  }

  // ---- Ingest (device-key authenticated, no user context) ----

  /**
   * Accept a position from a tracker. Authenticated purely by `deviceKey`; this
   * is the one place we look a device up globally (no company context yet), then
   * write only to that device's own rows.
   */
  async ingest(dto: IngestGpsDto) {
    // The GPS tables are RLS-protected (tenant_isolation policy), but ingest has
    // no user/company context — it resolves the tenant *from the device key*, a
    // global lookup no per-tenant GUC could scope. So this one path runs through
    // the BYPASSRLS `fleetos_auth` role (systemPrisma): it can look a device up
    // globally and then write only to that device's own rows. Every user-facing
    // GPS method still goes through the RLS-enforced tenant role.
    const device = await this.systemPrisma.gpsDevice.findUnique({ where: { deviceKeyHash: hashDeviceKey(dto.deviceKey) } });
    if (!device || device.archivedAt) {
      throw new NotFoundException({ code: 'GPS_DEVICE_UNKNOWN', message: 'Unknown or disabled device key.' });
    }
    this.assertIngestWithinRate(device.id);
    const recordedAt = dto.recordedAt ? new Date(dto.recordedAt) : new Date();
    if (Number.isNaN(recordedAt.getTime())) throw new BadRequestException({ code: 'BAD_TIMESTAMP', message: 'recordedAt is not a valid date.' });

    // The device row holds the *live* position (drives the live map). A ping
    // that arrives late (buffered on the device, then flushed) must not move the
    // live marker backwards in time, so only advance the device's last-known
    // position when this reading is newer than what's already stored. The ping
    // itself is always recorded for history, ordered by recordedAt.
    const isNewerFix = !device.lastLocationAt || recordedAt > device.lastLocationAt;
    await this.systemPrisma.$transaction([
      ...(isNewerFix
        ? [this.systemPrisma.gpsDevice.update({ where: { id: device.id }, data: { lastLat: dto.lat, lastLng: dto.lng, lastLocationAt: recordedAt } })]
        : []),
      this.systemPrisma.gpsPing.create({ data: { companyId: device.companyId, deviceId: device.id, lat: dto.lat, lng: dto.lng, recordedAt } }),
    ]);
    return { accepted: true };
  }

  private async assertAsset(tx: Prisma.TransactionClient, companyId: string, assetId: string) {
    const found = await tx.asset.findFirst({ where: { id: assetId, companyId } });
    if (!found) throw new BadRequestException({ code: 'ASSET_NOT_FOUND', message: 'Asset not found.' });
  }

  private async requireDevice(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const device = await tx.gpsDevice.findUnique({ where: { id } });
    if (!device || device.companyId !== companyId) {
      throw new NotFoundException({ code: 'GPS_DEVICE_NOT_FOUND', message: 'GPS device not found.' });
    }
    return device;
  }
}
