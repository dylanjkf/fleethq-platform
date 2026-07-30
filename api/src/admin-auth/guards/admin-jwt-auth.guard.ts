import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Validates the bearer token against the `admin-jwt` Passport strategy and
 * populates `req.user` with an `AuthenticatedAdminRequestUser`. Applied only
 * within AdminAuthModule's own controllers and any future /admin/v1
 * controller — never mixed with the customer-facing JwtAuthGuard on the same
 * route. There is no `@Public()` escape hatch here on purpose: every
 * /admin/v1 route requires a real admin session (the only unauthenticated
 * admin routes — login, mfa/verify — live on AdminAuthController directly,
 * outside this guard).
 */
@Injectable()
export class AdminJwtAuthGuard extends AuthGuard('admin-jwt') {}
