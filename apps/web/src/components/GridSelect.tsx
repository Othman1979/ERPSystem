import { Select, type SelectProps } from 'antd';
import { useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Select tuned for keyboard data entry (header fields and line grids):
 *  - Enter on an open list picks the option and moves to the next field in one
 *    keystroke (`onEnterSelect`, or the surrounding Enter handler).
 *  - Enter on a closed list moves on — antd would reopen it, which left a list
 *    hanging open behind the next field and swallowed the next Enter. A list
 *    opens only on typing (autocomplete), ArrowDown/ArrowUp, or a click.
 *  - ArrowDown/ArrowUp while closed opens the list.
 *  - Typing a printable character while closed opens the list pre-filled with
 *    it (type-to-search, Excel-like).
 */
export function GridSelect({
  onEnterSelect,
  onRemoteSearch,
  searching = false,
  ...props
}: SelectProps & {
  /**
   * Server search (ADR-022 §8): every change of the typed text goes here and
   * the options are shown as given (no local filtering). The caller fetches
   * the matches, e.g. with useRemoteOptions.
   */
  onRemoteSearch?: (text: string) => void;
  /**
   * The matches for the typed text are still on their way (useRemoteOptions'
   * `pending`). The list then shows only the chosen option, as loading, so
   * Enter cannot pick a row from the previous search.
   */
  searching?: boolean;
  /** Fired when Enter picks an option (grid advance). Without it, the Enter is
   *  re-sent to the surrounding field handler so header chains move on. */
  onEnterSelect?: (value: unknown, option: unknown) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Set (capture phase) when Enter is pressed on the open list; read by onChange.
  const enterPending = useRef(false);
  // Set (capture phase) when this Enter should navigate, not open the list.
  const passEnter = useRef(false);

  return (
    // display:contents — the wrapper adds no box; it only lets us see the key
    // before antd's own handler runs.
    <span
      style={{ display: 'contents' }}
      onKeyDownCapture={(e) => {
        // Decide before antd's handler: it picks the option (firing onChange)
        // before our onKeyDown ever runs.
        const isEnter = e.key === 'Enter';
        passEnter.current = isEnter && !open;
        enterPending.current = isEnter && open;
      }}
    >
      <Select
        {...props}
        className={[props.className, open ? 'grid-select-open' : '']
          .filter(Boolean)
          .join(' ') || undefined}
        open={open}
        loading={searching || props.loading}
        notFoundContent={searching ? t('common.loading') : props.notFoundContent}
        options={
          searching ? (props.options ?? []).filter((o) => o.value === props.value) : props.options
        }
        showSearch
        {...(onRemoteSearch ? { filterOption: false } : { optionFilterProp: 'label' })}
        searchValue={search}
        onSearch={(text) => {
          setSearch(text);
          onRemoteSearch?.(text);
        }}
        onDropdownVisibleChange={(v) => {
          if (v && passEnter.current) return; // Enter means "next field" here
          setOpen(v);
          if (!v) {
            setSearch('');
            onRemoteSearch?.('');
          }
        }}
        onBlur={(e) => {
          props.onBlur?.(e);
          // A list must never stay open behind the field that has focus.
          setOpen(false);
          setSearch('');
          onRemoteSearch?.('');
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
          } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            setSearch(e.key);
            onRemoteSearch?.(e.key);
            setOpen(true);
          }
        }}
      />
    </span>
  );
}

/** Open a closed antd Select from the keyboard, as a click on it would. */
export function openSelect(select: HTMLElement): void {
  select.querySelector('.ant-select-selector')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
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
  // focused picker and its date is half typed — an empty (optional) date is
  // skipped, and a complete one was already committed by the picker's Enter.
  if (!pickerOpen) return false;
  const picker = scope.matches('.ant-picker-focused')
    ? scope
    : scope.querySelector('.ant-picker-focused');
  return isPartialDateText(picker?.querySelector('input')?.value ?? '');
}

/** A masked date with some digits typed and some format letters left (20/11/YYYY). */
export function isPartialDateText(text: string): boolean {
  return /\d/.test(text) && /[DMY]/.test(text);
}

/**
 * Focus the editable control inside a cell/field wrapper. A select is only
 * focused, never opened: its list opens when the user types or presses an arrow.
 */
export function focusCellEl(el: HTMLElement | null | undefined): void {
  if (!el) return;
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
