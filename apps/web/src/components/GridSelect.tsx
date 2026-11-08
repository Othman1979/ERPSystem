import { Select, type SelectProps } from 'antd';
import { useState } from 'react';

/**
 * Select tuned for data-entry grids:
 *  - ArrowDown/ArrowUp while closed opens the dropdown (keyboard navigation).
 *  - Typing a printable character while closed opens the dropdown pre-filled
 *    with that character (type-to-search, Excel-like).
 *  - While open, antd handles arrows/Enter; the search box filters options.
 */
export function GridSelect(props: SelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  return (
    <Select
      {...props}
      open={open}
      showSearch
      optionFilterProp="label"
      searchValue={search}
      onSearch={setSearch}
      onDropdownVisibleChange={(v) => {
        setOpen(v);
        if (!v) setSearch('');
      }}
      onKeyDown={(e) => {
        props.onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (open) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          setSearch(e.key);
          setOpen(true);
        }
      }}
    />
  );
}

/** True while any antd select dropdown is open (dropdowns render in a portal). */
export function isSelectDropdownOpen(): boolean {
  return !!document.querySelector(
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
  );
}
