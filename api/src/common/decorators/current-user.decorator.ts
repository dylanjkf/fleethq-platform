import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequestUser } from '../../auth/jwt-payload.interface';

/** Pulls the request-scoped identity JwtAuthGuard attached to `req.user`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedRequestUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthenticatedRequestUser;
  },
);
