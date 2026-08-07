import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthTokensService } from './auth-tokens.service';
import { AuthMailService } from './auth-mail.service';
import { AuthSessionsService } from './auth-sessions.service';
import { AuthRecoveryService } from './auth-recovery.service';
import { PasswordPolicyService } from './password-policy.service';
import { BreachedPasswordService } from './breached-password.service';
import { AuthPolicyGateService } from './auth-policy-gate.service';
import { MfaService } from './mfa/mfa.service';
import { OidcVerifierService } from './oidc-verifier.service';
import { WebauthnService } from './webauthn/webauthn.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    PassportModule,
    NotificationsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        // Pin the algorithm on both sides. The main session path
        // (jwt.strategy.ts) already pins `algorithms: ['HS256']`; setting it
        // here as the module-level default applies the same pin to every
        // ad-hoc jwt.verify() in this module — the pre-auth, MFA-challenge,
        // policy-action, and WebAuthn-challenge tokens — closing an
        // algorithm-confusion / `alg:none` gap without repeating it per call.
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '12h'), algorithm: 'HS256' },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthTokensService,
    AuthMailService,
    AuthSessionsService,
    AuthRecoveryService,
    PasswordPolicyService,
    BreachedPasswordService,
    AuthPolicyGateService,
    MfaService,
    OidcVerifierService,
    WebauthnService,
    JwtStrategy,
  ],
  exports: [AuthService, AuthTokensService, AuthMailService, AuthRecoveryService, AuthSessionsService, BreachedPasswordService],
})
export class AuthModule {}
