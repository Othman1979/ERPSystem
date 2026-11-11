import { Logger } from '@nestjs/common';

interface Warner {
  warn(message: string): void;
}

/**
 * With TRUST_PROXY=0, requests that still arrive through a proxy (they carry
 * X-Forwarded-For) all look like the proxy: every client shares one rate
 * limit (ADR-010 §10.1). Says so once in the log; never blocks a request.
 */
export function warnOnUntrustedProxy(logger: Warner = new Logger('TrustProxy')) {
  let warned = false;
  return (req: { headers: Record<string, unknown> }, _res: unknown, next: () => void): void => {
    if (!warned && req.headers['x-forwarded-for'] !== undefined) {
      warned = true;
      logger.warn(
        'Requests arrive through a proxy (X-Forwarded-For) but TRUST_PROXY=0: all clients share one rate limit. ' +
          'Set TRUST_PROXY to the number of proxies in front of the API.',
      );
    }
    next();
  };
}
