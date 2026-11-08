import { Select, type SelectProps } from 'antd';
import { useRef, useState, type KeyboardEvent } from 'react';

/**
 * Select tuned for data-entry grids:
 *  - ArrowDown/ArrowUp while closed opens the dropdown (keyboard navigation).
 *  - Typing a printable character while closed opens the dropdown pre-filled
 *    with that character (type-to-search, Excel-like).
 *  - `enterOpens`: Enter while closed opens the dropdown (header fields);
 *    default false so grid cells let Enter bubble to row navigation.
 */
export function GridSelect({
  enterOpens = false,
  onEnterSelect,
  ...props
}: SelectProps & {
  enterOpens?: boolean;
  /** Fired when Enter picks an option from the open dropdown (grid advance). */
  onEnterSelect?: (value: unknown, option: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // After an option is picked, the next Enter should move to the next field
  // (not reopen the dropdown).
  const justSelected = useRef(false);
  // Set when Enter is pressed inside the open dropdown; consumed by onChange.
  const enterPending = useRef(false);

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
        if (v) enterPending.current = false;
        if (!v) setSearch('');
      }}
      onChange={(v, opt) => {
        justSelected.current = true;
        const viaEnter = enterPending.current;
        enterPending.current = false;
        props.onChange?.(v, opt);
        if (viaEnter) {
          // antd refocuses the selector right after onChange; close the
          // dropdown and defer the grid advance so it wins the focus race.
          setOpen(false);
          setTimeout(() => onEnterSelect?.(v, opt), 0);
        }
      }}
      onKeyDown={(e) => {
        props.onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (open) {
          if (e.key === 'Enter') enterPending.current = true;
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        } else if (e.key === 'Enter' && enterOpens) {
          if (justSelected.current) {
            justSelected.current = false;
            return; // let Enter bubble → move to next field
          }
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

/** True while any antd select or date-picker dropdown is open (portals). */
export function isSelectDropdownOpen(): boolean {
  return !!document.querySelector(
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-picker-dropdown:not(.ant-picker-dropdown-hidden)',
  );
}

/** Focus the editable control inside a cell/field wrapper (select or input). */
export function focusCellEl(el: HTMLElement | null | undefined): void {
  if (!el) return;
  const select = el.querySelector<HTMLElement>('.ant-select-selector');
  if (select) {
    select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return;
  }
  const input = el.querySelector<HTMLElement>('input, textarea');
  if (input) {
    input.focus();
    (input as HTMLInputElement).select?.();
    return;
  }
  el.focus();
}

/** Focus a header field marked with data-field="key". */
export function focusNamedField(key: string): void {
  focusCellEl(document.querySelector<HTMLElement>(`[data-field="${key}"]`));
}

/** Focus the first editable cell of a lines grid (row 0, first nav column). */
export function focusFirstGridCell(): void {
  focusCellEl(document.querySelector<HTMLElement>('[data-cell="0-1"]'));
}

/** Enter-key handler factory: moves focus to the next form field on Enter. */
export function enterTo(go: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || isSelectDropdownOpen()) return;
    e.preventDefault();
    go();
  };
}
