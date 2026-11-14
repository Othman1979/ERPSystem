import type { CostCenterDto } from '@erp/api-client';

/** A cost centre with its sub-centres, for the settings tree table. */
export interface CostCenterNode extends CostCenterDto {
  children?: CostCenterNode[];
}

/**
 * Builds the centre tree from the flat list. A centre whose parent is missing
 * from the list becomes a root, so no row is lost. Siblings are ordered by code.
 */
export function costCenterTree(rows: readonly CostCenterDto[] | undefined): CostCenterNode[] {
  const byId = new Map<string, CostCenterNode>();
  for (const row of rows ?? []) byId.set(row.id, { ...row });

  const roots: CostCenterNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) {
      parent.children = [...(parent.children ?? []), node];
    } else {
      roots.push(node);
    }
  }

  const sortRec = (nodes: CostCenterNode[]) => {
    nodes.sort((a, b) => a.code.localeCompare(b.code));
    for (const n of nodes) if (n.children) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}
