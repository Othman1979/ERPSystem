import { Select, type SelectProps } from 'antd';
import { useRef, useState, type KeyboardEvent } from 'react';

/**
 * Select tuned for keyboard data entry (header fields and line grids):
 *  - Enter on an open list picks the option and moves to the next field in one
 *    keystroke (`onEnterSelect`, or the surrounding Enter handler).
 *  - Enter on a closed list moves on — antd would reopen it, which left a list
 *    hanging open behind the next field and swallowed the next Enter. Only an
 *    empty field with `enterOpens` opens on Enter.
 *  - ArrowDown/ArrowUp while closed opens the list.
 *  - Typing a printable character while closed opens the list pre-filled with
 *    it (type-to-search, Excel-like).
 */
export function GridSelect({
  enterOpens = false,
  onEnterSelect,
  ...props
}: SelectProps & {
  /** Header fields: Enter on an empty field opens the list. */
  enterOpens?: boolean;
  /** Fired when Enter picks an option (grid advance). Without it, the Enter is
   *  re-sent to the surrounding field handler so header chains move on. */
  onEnterSelect?: (value: unknown, option: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Set (capture phase) when Enter is pressed on the open list; read by onChange.
  const enterPending = useRef(false);
  // Set (capture phase) when this Enter should navigate, not open the list.
  const passEnter = useRef(false);

  const hasValue = props.value !== undefined && props.value !== null && props.value !== '';

  return (
    // display:contents — the wrapper adds no box; it only lets us see the key
    // before antd's own handler runs.
    <span
      style={{ display: 'contents' }}
      onKeyDownCapture={(e) => {
        // Decide before antd's handler: it picks the option (firing onChange)
        // before our onKeyDown ever runs.
        const isEnter = e.key === 'Enter';
        passEnter.current = isEnter && !open && (!enterOpens || hasValue);
        enterPending.current = isEnter && open;
      }}
    >
      <Select
        {...props}
        className={[props.className, open ? 'grid-select-open' : '']
          .filter(Boolean)
          .join(' ') || undefined}
        open={open}
        showSearch
        optionFilterProp="label"
        searchValue={search}
        onSearch={setSearch}
        onDropdownVisibleChange={(v) => {
          if (v && passEnter.current) return; // Enter means "next field" here
          setOpen(v);
          if (!v) setSearch('');
        }}
        onBlur={(e) => {
          props.onBlur?.(e);
          // A list must never stay open behind the field that has focus.
          setOpen(false);
          setSearch('');
        }}
        onChange={(v, opt) => {
          const viaEnter = enterPending.current;
          enterPending.current = false;
          props.onChange?.(v, opt);
          if (viaEnter) {
            // antd refocuses the selector right after onChange; close the
            // dropdown and defer the move so it wins the focus race.
            setOpen(false);
            const origin = document.activeElement;
            setTimeout(() => {
              // A quick second Enter may already have moved on; don't move twice.
              if (document.activeElement !== origin) return;
              if (onEnterSelect) {
                onEnterSelect(v, opt);
              } else {
                // Re-send Enter from the (now closed) select so the field's
                // Enter handler moves to the next field.
                document.activeElement?.dispatchEvent(
                  new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
                );
              }
            }, 0);
          }
        }}
        onKeyDown={(e) => {
          props.onKeyDown?.(e);
          const navigate = passEnter.current;
          passEnter.current = false;
          // onChange has already consumed it if Enter picked an option.
          enterPending.current = false;
          if (navigate) return; // let Enter bubble → move to the next field
          if (open) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          } else if (e.key === 'Enter' && enterOpens) {
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
    </span>
  );
}

/**
 * True while a list or date panel that belongs to `scope` is open — so Enter
 * belongs to that list, not to field navigation. Without a scope, checks the
 * whole page. Scoping matters: a list left open in another cell must not block
 * Enter in this one.
 */
export function isSelectDropdownOpen(scope?: Element | null): boolean {
  const OPEN_SELECT = '.grid-select-open, .ant-select-open';
  const pickerOpen = !!document.querySelector(
    '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)',
  );
  if (!scope) return !!document.querySelector(OPEN_SELECT) || pickerOpen;
  const within = (sel: string) => scope.matches(sel) || !!scope.querySelector(sel);
  if (within(OPEN_SELECT)) return true;
  // Date panels render in a portal; count one only if this field owns the
  // focused picker and something is typed in it — Enter on an empty
  // (optional) date skips the field instead of getting stuck in the panel.
  if (!pickerOpen) return false;
  const picker = scope.matches('.ant-picker-focused')
    ? scope
    : scope.querySelector('.ant-picker-focused');
  return !!picker?.querySelector('input')?.value;
}

/**
 * Focus the editable control inside a cell/field wrapper. An empty select
 * opens its list (ready to type or pick); a filled one is only focused, so
 * Enter moves straight on.
 */
export function focusCellEl(el: HTMLElement | null | undefined): void {
  if (!el) return;
  const select = el.querySelector<HTMLElement>('.ant-select-selector');
  if (select) {
    const input = el.querySelector<HTMLInputElement>('input');
    if (el.querySelector('.ant-select-selection-item')) {
      input?.focus();
      return;
    }
    // antd moves focus into a select on click, not on mousedown — so focus it
    // first, then open the list. (Opening alone left the caret in the previous
    // cell with this cell's list hanging open.)
    input?.focus();
    select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    // Make sure the dropdown actually opens — GridSelect opens on ArrowDown
    // when closed, so nudge it only if nothing opened after the mousedown.
    requestAnimationFrame(() => {
      if (!el.querySelector('.grid-select-open')) {
        select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      }
    });
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
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (isSelectDropdownOpen(e.currentTarget)) return;
    e.preventDefault();
    go();
  };
}
