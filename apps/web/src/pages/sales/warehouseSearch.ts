export function warehouseSearchText(warehouse: { code: string; nameAr: string; nameEn?: string | null }): string {
  return [warehouse.code, warehouse.nameAr, warehouse.nameEn].filter(Boolean).join(' ');
}

export function warehouseSearchMatches(input: string, searchText: string): boolean {
  return searchText.toLocaleLowerCase().includes(input.toLocaleLowerCase());
}
