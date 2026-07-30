import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';

/** Boots the real app (all real guards/filters/modules) against a live test database. */
export async function buildTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  // rawBody: true — POST /v1/billing/webhook needs req.rawBody to verify
  // Stripe's signature; mirrors the same option main.ts passes in production.
  const app = moduleRef.createNestApplication({ rawBody: true });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
  return app;
}
