import { of } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { DeprecationInterceptor } from './deprecation.interceptor';
import { DEPRECATION_METADATA_KEY, DeprecationOptions } from './deprecated.decorator';

function contextWith(res: { setHeader: jest.Mock }) {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getResponse: () => res }),
  } as never;
}

describe('DeprecationInterceptor', () => {
  const next = { handle: () => of('ok') };

  it('sets RFC 8594 Deprecation/Sunset (and Link) headers when a route is marked deprecated', () => {
    const options: DeprecationOptions = { sunset: '2026-12-31', link: 'https://docs.example/v2' };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(options) } as unknown as Reflector;
    const res = { setHeader: jest.fn() };
    const interceptor = new DeprecationInterceptor(reflector);

    interceptor.intercept(contextWith(res), next as never);

    expect(res.setHeader).toHaveBeenCalledWith('Deprecation', 'true');
    expect(res.setHeader).toHaveBeenCalledWith('Sunset', new Date('2026-12-31').toUTCString());
    expect(res.setHeader).toHaveBeenCalledWith('Link', '<https://docs.example/v2>; rel="deprecation"');
  });

  it('sets no headers on a route that is not marked deprecated', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const res = { setHeader: jest.fn() };
    const interceptor = new DeprecationInterceptor(reflector);

    interceptor.intercept(contextWith(res), next as never);

    expect(res.setHeader).not.toHaveBeenCalled();
    // The metadata key is the one the @Deprecated decorator writes.
    expect((reflector.getAllAndOverride as jest.Mock).mock.calls[0][0]).toBe(DEPRECATION_METADATA_KEY);
  });
});
