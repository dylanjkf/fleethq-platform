import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminMfaService } from './mfa/admin-mfa.service';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

/**
 * Deliberately its own `JwtModule.registerAsync` (a separate `JwtService`
 * instance, signing with `ADMIN_JWT_SECRET`) rather than importing the
 * customer AuthModule's — the two token spaces must never share a signing
 * key, so a leaked or forged customer token can never be replayed as an
 * admin session token.
 */
@Module({
  imports: [
    PassportModule,
    AdminAuditModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('ADMIN_JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('ADMIN_JWT_EXPIRES_IN', '12h') },
      }),
    }),
  ],
  controllers: [AdminAuthController],
  providers: [AdminAuthService, AdminMfaService, AdminJwtStrategy],
  exports: [AdminAuthService, AdminMfaService],
})
export class AdminAuthModule {}
