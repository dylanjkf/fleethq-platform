import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import * as Sentry from '@sentry/node';

/**
 * Normalizes every error response to one shape, regardless of resource —
 * 12-API/API_Architecture.md: "A permission check failure returns a clear,
 * consistent error shape regardless of which resource was being accessed,"
 * generalized here to all errors so clients only ever parse one envelope.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    // The per-request correlation id (set by pino-http's genReqId, and already
    // echoed on the x-request-id response header). Tying it into the error
    // envelope + Sentry lets a single id join the client's report, the API log
    // line, and the Sentry event.
    const requestId = (request as { id?: string | number }).id;

    // Only genuine failures, never expected client errors (permission
    // denials, validation failures, not-found) — those are normal request
    // handling per this codebase's own permission/validation design, and
    // reporting every 403/404 to Sentry would bury the signal that actually
    // matters (a real bug) under noise from expected traffic.
    if (status >= 500) {
      Sentry.captureException(exception, requestId ? { tags: { request_id: String(requestId) } } : undefined);
    }

    const body = exception instanceof HttpException ? exception.getResponse() : undefined;

    // Only an HttpException's message is ever app-authored and safe to echo
    // back — it was deliberately thrown with a curated string. A raw,
    // unhandled exception's `.message` (a Prisma/driver error, a null-deref,
    // etc.) can contain schema details, file paths, or other internals and
    // must never reach the client; Sentry (above) still gets the real
    // exception for debugging.
    let code = HttpStatus[status] ?? 'INTERNAL_SERVER_ERROR';
    let message = exception instanceof HttpException ? exception.message : 'An unexpected error occurred.';
    let extra: Record<string, unknown> = {};

    if (body && typeof body === 'object') {
      const { code: bodyCode, message: bodyMessage, ...rest } = body as Record<string, unknown>;
      if (typeof bodyCode === 'string') code = bodyCode;
      if (typeof bodyMessage === 'string') message = bodyMessage;
      else if (Array.isArray(bodyMessage)) message = bodyMessage.join(', ');
      extra = rest;
    }

    response.status(status).json({
      error: {
        code,
        message,
        ...extra,
        ...(requestId ? { requestId: String(requestId) } : {}),
      },
    });
  }
}
