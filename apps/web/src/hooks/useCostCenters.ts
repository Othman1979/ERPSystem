import { useQuery } from '@tanstack/react-query';
import { costCentersControllerList, type CostCenterDto } from '@erp/api-client';
import { useCompany } from '../components/CompanyProfileForm';
import { codeAndName } from '../i18n/displayName';

/** The one cache key of the cost centre list (reference data, referenceData.ts). */
export const COST_CENTERS_QUERY_KEY = ['cost-centers'] as const;

export type CostCenterRow = CostCenterDto;

/** Centres a line or a document may post to: active leaves (ADR-024 §1.4). */
export const postableCostCenters = (rows: readonly CostCenterRow[] | undefined): CostCenterRow[] =>
  (rows ?? []).filter((c) => c.isActive && c.isPostable);

/** Select options of the postable centres, plus any id already chosen (a saved line keeps its label). */
export function costCenterOptions(
  rows: readonly CostCenterRow[] | undefined,
  keep: readonly (string | null | undefined)[] = [],
): { value: string; label: string }[] {
  const kept = new Set(keep.filter((id): id is string => !!id));
  return (rows ?? [])
    .filter((c) => (c.isActive && c.isPostable) || kept.has(c.id))
    .map((c) => ({ value: c.id, label: codeAndName(c) }));
}

/**
 * Cost centres for the screens (ADR-024 §1.6): `enabled` follows the
 * company's switch; the list is fetched only while it is on (the settings
 * tab passes `always` to manage the tree with the switch off).
 */
export function useCostCenters({ always = false }: { always?: boolean } = {}) {
  const company = useCompany();
  const enabled = company.data?.costCentersEnabled === true;
  const list = useQuery({
    queryKey: COST_CENTERS_QUERY_KEY,
    queryFn: ({ signal }) => costCentersControllerList({ signal }).then((r) => r.data),
    enabled: enabled || always,
  });
  const byId = new Map((list.data ?? []).map((c) => [c.id, c]));
  return {
    /** The company has cost centres switched on. */
    enabled,
    /** The company query has answered (until then `enabled` is false). */
    ready: company.isSuccess,
    list,
    rows: list.data ?? [],
    /** "CODE — Name" of a centre, or undefined when unknown. */
    nameOf: (id: string | null | undefined) => codeAndName(id ? byId.get(id) : undefined),
  };
}
