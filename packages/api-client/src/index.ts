/**
 * @erp/api-client entry point.
 *
 * `src/generated/` is produced by `pnpm api-client:generate` (orval) and must not
 * be edited by hand. Until the first generation runs, this module exposes the
 * runtime helpers plus the few hand-written endpoints needed by Phase 0.
 * After generation, re-export the generated modules here.
 */
import { apiFetchData } from './runtime';

export {
  ApiError,
  apiFetch,
  apiFetchBlob,
  apiFetchData,
  CLIENT_ERROR,
  DOWNLOAD_TIMEOUT_MS,
  filenameFromDisposition,
  getAccessToken,
  getBranchId,
  isConnectionError,
  onApiWrite,
  onSessionChange,
  REQUEST_TIMEOUT_MS,
  setAccessToken,
  setBranchId,
  tokenSession,
} from './runtime';
export type { ApiErrorBody, ApiFile, ApiRequestInit, ApiResponse, ApiWrite } from './runtime';

// orval-generated client (do not edit src/generated/* by hand)
export * from './generated/api';

export interface HealthStatus {
  status: string;
  db: string;
  timestamp: string;
}

export function getHealth(): Promise<HealthStatus> {
  return apiFetchData<HealthStatus>('/health');
}
