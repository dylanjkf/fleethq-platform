import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedAdminRequestUser } from '../admin-jwt-payload.interface';

/** Pulls the request-scoped identity AdminJwtAuthGuard attached to `req.user`. */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedAdminRequestUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthenticatedAdminRequestUser;
  },
);
