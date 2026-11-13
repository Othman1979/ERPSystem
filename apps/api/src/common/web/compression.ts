import compression from 'compression';
import type { Request, Response } from 'express';

/**
 * Responses that carry an access token: never compressed, because a
 * compressed body whose length an attacker can observe leaks the token
 * (BREACH-style). /auth/* (login, register, refresh) and the tenant switch.
 */
export function carriesToken(path: string): boolean {
  return path.startsWith('/api/v1/auth/') || path === '/api/v1/me/switch-tenant';
}

/** Gzip/brotli for API JSON and other on-the-fly responses (WEB-11), except token responses. */
export function apiCompression() {
  return compression({
    filter: (req: Request, res: Response): boolean => {
      if (carriesToken(req.path)) return false;
      return compression.filter(req, res);
    },
  });
}
