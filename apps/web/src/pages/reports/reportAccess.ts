const COMPANY_WIDE_TABS = new Set(['tb', 'is', 'bs', 'cf', 'gl', 'cc']);

export function isReportTabAvailable(tabKey: string, allBranches: boolean): boolean {
  return allBranches || !COMPANY_WIDE_TABS.has(tabKey);
}
