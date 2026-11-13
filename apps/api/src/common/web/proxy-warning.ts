import { Logger } from '@nestjs/common';

interface Warner {
  warn(message: string): void;
}

/** The parts of express's request this reads (`ips` honours `trust proxy`). */
interface ProxiedRequest {
  headers: Record<string, unknown>;
  ips?: string[];
}

/**
 * A request carrying X-Forwarded-For whose sender is not a trusted proxy
 * (TRUST_PROXY, ADR-011): Express then ignores the header, every client looks
 * like the proxy and all share one rate limit (ADR-010 §10.1). Says so once
 * in the log; never blocks a request.
 */
export function warnOnUntrustedProxy(logger: Warner = new Logger('TrustProxy')) {
  let warned = false;
  return (req: ProxiedRequest, _res: unknown, next: () => void): void => {
    if (!warned && req.headers['x-forwarded-for'] !== undefined && (req.ips?.length ?? 0) === 0) {
      warned = true;
      logger.warn(
        'Requests arrive through a proxy (X-Forwarded-For) that TRUST_PROXY does not name: all clients share one ' +
          'rate limit. Set TRUST_PROXY to that proxy (e.g. loopback, or its address).',
      );
    }
    next();
  };
}
