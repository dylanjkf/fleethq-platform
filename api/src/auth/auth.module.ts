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
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '12h') },
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
    MfaService,
    OidcVerifierService,
    WebauthnService,
    JwtStrategy,
  ],
  exports: [AuthService, AuthTokensService, AuthMailService, AuthRecoveryService],
})
export class AuthModule {}
