import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

/**
 * Where an attachment's bytes actually live. Two backends, chosen per
 * deployment by config (`ATTACHMENTS_BUCKET`):
 *   - unset  → inline in Postgres (the Attachment.data column). Zero infra,
 *     fine for a pilot; the historical default.
 *   - set    → the named S3 bucket, so real photo/scan volume (POD photos,
 *     licence scans) doesn't bloat the database — the deploy-time swap the
 *     Attachment model always anticipated.
 *
 * This service only knows how to move bytes to/from S3 and whether S3 is
 * configured; AttachmentsService owns the DB row and picks the backend based
 * on `isConfigured()`. Object keys are namespaced by company so the bucket is
 * legible and a future per-tenant lifecycle/export is straightforward — but
 * tenant *isolation* is still enforced by the DB row's RLS + the download
 * path checking companyId, never by the key alone.
 */
@Injectable()
export class AttachmentStorage {
  private readonly logger = new Logger(AttachmentStorage.name);
  private client: S3Client | null = null;
  private readonly bucket: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.bucket = config.get<string>('ATTACHMENTS_BUCKET') || undefined;
  }

  isConfigured(): boolean {
    return !!this.bucket;
  }

  private getClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client({ region: this.config.get<string>('AWS_REGION') });
    }
    return this.client;
  }

  /** Uploads bytes and returns the object key to persist on the Attachment row. */
  async put(companyId: string, contentType: string, body: Buffer): Promise<string> {
    const key = `${companyId}/${randomUUID()}`;
    await this.getClient().send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return key;
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.getClient().send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) {
      this.logger.error(`S3 object ${key} returned an empty body`);
      throw new Error('Attachment object was empty.');
    }
    return Buffer.from(bytes);
  }

  /**
   * Permanently and *completely* deletes an object — used by the Privacy Act
   * erasure path so an erased licence/medical scan stored in S3 is actually
   * destroyed. The attachments bucket has versioning enabled (for accidental-
   * delete recovery), which means a plain DeleteObject only writes a delete
   * marker and leaves prior *versions* recoverable — an erasure that didn't
   * erase. So this enumerates every version and delete-marker for the key and
   * removes each by VersionId. Idempotent (no versions → no-op).
   */
  async remove(key: string): Promise<void> {
    const client = this.getClient();
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;

    // Page through all versions + delete markers for exactly this key.
    do {
      const listed = await client.send(
        new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }),
      );
      const targets = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
        .filter((v) => v.Key === key && v.VersionId) // exact key only, not prefix neighbours
        .map((v) => ({ Key: key, VersionId: v.VersionId! }));

      if (targets.length > 0) {
        await client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: targets, Quiet: true } }));
      }

      keyMarker = listed.IsTruncated ? listed.NextKeyMarker : undefined;
      versionIdMarker = listed.IsTruncated ? listed.NextVersionIdMarker : undefined;
    } while (keyMarker || versionIdMarker);

    // Backstop for an unversioned bucket (no versions listed): a plain delete.
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
