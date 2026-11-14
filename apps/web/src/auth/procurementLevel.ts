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
 * The current company's procurement level, from the shared company query
 * (the same key as useCompany). `enabled` is false without a company.
 */
export function useProcurementLevel(enabled = true): ProcurementLevel {
  const company = useQuery({
    queryKey: ['company'],
    queryFn: ({ signal }) => companyControllerGet({ signal }).then((r) => r.data),
    enabled,
  });
  return company.data?.procurementLevel ?? ProcurementLevel.SIMPLE;
}
