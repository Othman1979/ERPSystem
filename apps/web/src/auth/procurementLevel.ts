import { useQuery } from '@tanstack/react-query';
import { companyControllerGet, ProcurementLevel } from '@erp/api-client';

export { ProcurementLevel };

/** The levels from the smallest purchasing cycle to the largest (ADR-013 §1, ADR-024 §2). */
export const PROCUREMENT_LEVELS: readonly ProcurementLevel[] = [
  ProcurementLevel.SIMPLE,
  ProcurementLevel.MEDIUM,
  ProcurementLevel.FULL,
];

/**
 * True when a company at `level` uses screens that need `min`. No minimum:
 * always. An unknown level (the company is still loading) counts as SIMPLE,
 * so a cycle screen never flashes into the menu of a simple company.
 */
export function meetsProcurementLevel(level: ProcurementLevel | undefined, min: ProcurementLevel | undefined): boolean {
  if (!min) return true;
  return PROCUREMENT_LEVELS.indexOf(level ?? ProcurementLevel.SIMPLE) >= PROCUREMENT_LEVELS.indexOf(min);
}

/**
 * The current company's procurement level and whether it is still loading,
 * from the shared company query (the same key as useCompany). `enabled` is
 * false without a company. `level` falls back to SIMPLE until the company loads.
 */
export function useProcurementLevelState(enabled = true): { level: ProcurementLevel; loading: boolean } {
  const company = useQuery({
    queryKey: ['company'],
    queryFn: ({ signal }) => companyControllerGet({ signal }).then((r) => r.data),
    enabled,
  });
  return {
    level: company.data?.procurementLevel ?? ProcurementLevel.SIMPLE,
    loading: company.isLoading,
  };
}

/** The current company's procurement level (SIMPLE while it loads). */
export function useProcurementLevel(enabled = true): ProcurementLevel {
  return useProcurementLevelState(enabled).level;
}
