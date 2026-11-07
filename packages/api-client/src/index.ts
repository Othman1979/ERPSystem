/**
 * @erp/api-client entry point.
 *
 * `src/generated/` is produced by `pnpm api-client:generate` (orval) and must not
 * be edited by hand. Until the first generation runs, this module exposes the
 * runtime helpers plus the few hand-written endpoints needed by Phase 0.
 * After generation, re-export the generated modules here.
 */
import { apiFetch } from './runtime';

export { ApiError, apiFetch } from './runtime';
export type { ApiErrorBody } from './runtime';

// orval-generated client (do not edit src/generated/* by hand)
export * from './generated/api';

export interface HealthStatus {
  status: string;
  db: string;
  timestamp: string;
}

export function getHealth(): Promise<HealthStatus> {
  return apiFetch<HealthStatus>('/health');
}
