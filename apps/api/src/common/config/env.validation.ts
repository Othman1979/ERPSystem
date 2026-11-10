import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16).optional(),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // JoFotara (docs/decisions/0005 §13): 32 random bytes, base64; seals the Secret-Key at rest.
  EINVOICE_ENC_KEY: z.string().optional(),
  // The outbox worker: 'off' disables it (e.g. a second API instance that should not send).
  EINVOICE_WORKER: z.enum(['on', 'off']).default('on'),
  EINVOICE_WORKER_INTERVAL_MS: z.coerce.number().int().min(100).default(60_000),
  // Past this the answer is UNKNOWN (never resent automatically).
  EINVOICE_HTTP_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return result.data;
}
