import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { DEPRECATION_METADATA_KEY, DeprecationOptions } from './deprecated.decorator';

/**
 * Emits the RFC 8594 deprecation signal for any route (or controller) marked
 * with `@Deprecated(...)`. Registered globally (app.module), so it's a no-op on
 * every route that isn't decorated — the mechanism exists and is exercised the
 * moment the first route is deprecated, without touching call sites elsewhere.
 */
@Injectable()
export class DeprecationInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<DeprecationOptions | undefined>(DEPRECATION_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (options) {
      const res = context.switchToHttp().getResponse<{ setHeader?: (name: string, value: string) => void }>();
      if (res && typeof res.setHeader === 'function') {
        res.setHeader('Deprecation', 'true');
        res.setHeader('Sunset', new Date(options.sunset).toUTCString());
        if (options.link) res.setHeader('Link', `<${options.link}>; rel="deprecation"`);
      }
    }
    return next.handle();
  }
}
