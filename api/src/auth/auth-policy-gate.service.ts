import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { LoginResult } from './auth.service';
import type { LoginMethod, PolicyActionPayload } from './jwt-payload.interface';

const POLICY_ACTION_EXPIRES_IN = '15m';

export interface PolicyCheckUser {
  id: string;
  mfaEnabledAt: Date | null;
  passwordChangedAt: Date;
}

export interface PolicyCheckMembership {
  id: string;
  companyId: string;
  company: { securitySettings: { mfaRequired: boolean; passwordExpiryDays: number | null } | null };
}

export interface PolicyCheckExtra {
  rememberMe?: boolean;
  isNewDeviceLogin?: boolean;
  loginMethod?: LoginMethod;
  /**
   * True when this membership holds an admin-tier permission (see
   * ADMIN_TIER_PERMISSION_KEYS). Forces MFA even if the company hasn't opted
   * into `mfaRequired` — a privileged account must not run on password alone.
   */
  holdsAdminPermission?: boolean;
}

/**
 * Decides whether a company's own security policy (Auth/Billing Platform
 * Phase 3, 22-Auth-Billing-Platform/Overview.md) blocks an otherwise-
 * successful login, and mints/verifies the short-lived token that carries a
 * blocked login through to the matching mfa-setup/password-change endpoint.
 * Deliberately its own tiny service (not folded into AuthService) so it can
 * be unit-tested in isolation and so AuthSessionsService.issueSessionToken
 * (which AuthService's own finishLoginForMembership calls once this gate
 * passes) never has to depend back on AuthService — that would be circular.
 */
@Injectable()
export class AuthPolicyGateService {
  constructor(private readonly jwt: JwtService) {}

  /**
   * Returns a blocking `LoginResult` if the policy isn't satisfied yet, or
   * `null` to proceed. MFA is checked first — an account with no second
   * factor at all is a bigger gap than a stale password. MFA is mandatory
   * when the company opted into `mfaRequired` OR the account holds an
   * admin-tier permission (`extra.holdsAdminPermission`) — a privileged
   * account must not run on password alone even in a company that hasn't
   * turned the policy on. A verified WebAuthn/passkey login always satisfies
   * the MFA requirement on its own — see AuthService.completeWebauthnLogin's
   * doc comment for why a passkey is treated as already MFA-equivalent — and
   * the expiry check applies regardless of loginMethod, since the concern is a
   * stale password sitting there as a fallback credential, not which method
   * this login happened to use.
   */
  checkPolicy(user: PolicyCheckUser, membership: PolicyCheckMembership, extra: PolicyCheckExtra): LoginResult | null {
    const policy = membership.company.securitySettings;

    const mfaRequired = !!policy?.mfaRequired || !!extra.holdsAdminPermission;
    const mfaSatisfied = !mfaRequired || !!user.mfaEnabledAt || extra.loginMethod === 'webauthn';
    if (!mfaSatisfied) {
      return { status: 'mfa_setup_required', setupToken: this.signPolicyToken(user.id, membership, 'mfa_setup', extra) };
    }

    if (policy?.passwordExpiryDays) {
      const ageMs = Date.now() - user.passwordChangedAt.getTime();
      if (ageMs > policy.passwordExpiryDays * 24 * 60 * 60 * 1000) {
        return { status: 'password_expired', changeToken: this.signPolicyToken(user.id, membership, 'password_expired', extra) };
      }
    }

    return null;
  }

  /** Throws INVALID_TOKEN if the token is malformed/expired or was minted for a different purpose. */
  verifyPolicyToken(token: string, purpose: PolicyActionPayload['purpose']): PolicyActionPayload {
    let payload: PolicyActionPayload;
    try {
      payload = this.jwt.verify<PolicyActionPayload>(token);
    } catch {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' });
    }
    if (payload.purpose !== purpose) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' });
    }
    return payload;
  }

  private signPolicyToken(
    userId: string,
    membership: PolicyCheckMembership,
    purpose: PolicyActionPayload['purpose'],
    extra: PolicyCheckExtra,
  ): string {
    const payload: PolicyActionPayload = {
      sub: userId,
      membershipId: membership.id,
      companyId: membership.companyId,
      purpose,
      rememberMe: extra.rememberMe,
      isNewDeviceLogin: extra.isNewDeviceLogin,
      loginMethod: extra.loginMethod,
    };
    return this.jwt.sign(payload, { expiresIn: POLICY_ACTION_EXPIRES_IN });
  }
}
