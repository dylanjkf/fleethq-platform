import './instrument'; // must run before any other import — see instrument.ts's own header comment
import { NestFactory } from '@nestjs/core';
import { VersioningType, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  // bufferLogs holds Nest's own bootstrap logs until the pino logger below is
  // attached, so nothing gets lost or falls back to plain console output.
  // rawBody: true preserves the raw request buffer on req.rawBody alongside
  // Nest's normal JSON parsing — POST /v1/billing/webhook needs the exact
  // raw bytes (not a re-serialized object) to verify Stripe's signature;
  // everything else keeps using the normal parsed req.body.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));

  // Production traffic passes through one reverse-proxy hop before reaching
  // this process (Railway's edge, or CloudFront/an ALB on other deploy
  // targets) — Express needs to trust its X-Forwarded-For append. Without
  // this, req.ip is the proxy's IP for every request — every user behind it
  // would share one bucket for @nestjs/throttler's per-IP rate limiting
  // below, letting one user's traffic throttle everyone else's.
  app.set('trust proxy', 1);

  // fleethq-frontend (Vercel) and this API are deployed to separate origins,
  // so the browser needs an explicit CORS allowlist — see
  // 16-Deployment/Deployment_Overview.md. CORS_ALLOWED_ORIGINS is a
  // comma-separated list, e.g.
  // "https://app.fleethq.online,https://fleethq-frontend.vercel.app". Unset
  // leaves CORS off entirely, the correct default when a proxy/edge serves
  // both origins as one. No `credentials: true` — auth is a Bearer token in
  // the Authorization header (see tokenStore/apiClient), never a cookie, so
  // there's no cross-origin cookie behaviour to opt into.
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (allowedOrigins.length > 0) {
    app.enableCors({
      origin: allowedOrigins,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });
  }

  // Photos (proof of delivery, fault/damage) arrive as base64 inside JSON so a
  // single request replays cleanly through DriverOS's offline outbox. Raise the
  // JSON body limit accordingly; the AttachmentsService still caps decoded bytes.
  app.useBodyParser('json', { limit: '15mb' });

  // helmet() sets the standard security headers. HSTS is made explicit and
  // strong rather than left on helmet's 180-day default: a 2-year max-age with
  // includeSubDomains + preload is the Cyber Essentials / HSTS-preload-list
  // expectation, so a browser that has ever seen us over HTTPS refuses to talk
  // to us over plain HTTP thereafter. TLS is terminated at the platform edge
  // (Railway, or CloudFront/ALB on other deploy targets — see
  // 16-Deployment), so the header rides out to the browser from there;
  // sending it from the origin too is belt-and-braces and correct.
  app.use(
    helmet({
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
    }),
  );

  // Without this, a rolling deploy (SIGTERM to an old instance while new
  // ones come up) hard-kills in-flight requests instead of letting Nest's
  // lifecycle hooks (PrismaService.onModuleDestroy, etc.) run first. Required
  // for zero-downtime deploys to actually be zero-downtime.
  app.enableShutdownHooks();

  // 12-API/API_Architecture.md: "A single versioned API (e.g. /v1/...) is the
  // only way any client — internal or external — reads or writes FleetOS data."
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
}

bootstrap();
