import { useEffect, type HTMLAttributes, type KeyboardEvent } from 'react';
import { focusCellEl, isSelectDropdownOpen, isUnfinishedDateText, openSelect } from './GridSelect';

/** Field roots that Enter steps through, in DOM order. */
const FIELD_SELECTOR = [
  '.ant-select:not(.ant-select-disabled)',
  '.ant-picker:not(.ant-picker-disabled)',
  '.ant-input-number:not(.ant-input-number-disabled)',
  'input.ant-input:not([disabled])',
  // A dialog's primary button, or a page form's submit button, ends the chain: Enter there saves.
  '.ant-modal-footer .ant-btn-primary:not([disabled])',
  'button[type="submit"]:not([disabled])',
].join(', ');

/** Enter presses one EnterNav already handled, so an outer (nesting) EnterNav leaves them alone. */
const handledEnters = new WeakSet<Event>();

function isVisible(el: Element): boolean {
  return el.getClientRects().length > 0;
}

function fieldsIn(scope: Element): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(FIELD_SELECTOR)).filter(isVisible);
}

/** Put the caret in a field root (select, date, number, text) or a grid cell. */
function focusField(field: HTMLElement): void {
  const cell = field.closest<HTMLElement>('[data-cell]');
  if (cell) {
    focusCellEl(cell);
  } else if (field.tagName === 'BUTTON' || field.tagName === 'INPUT') {
    field.focus();
    if (field instanceof HTMLInputElement) field.select();
  } else {
    focusCellEl(field);
  }
}

function isEmptyField(field: HTMLElement): boolean {
  if (field.matches('.ant-select')) return !field.querySelector('.ant-select-selection-item');
  const input = field.matches('input') ? field : field.querySelector('input');
  return input instanceof HTMLInputElement && input.value === '';
}

/**
 * Focus the first empty field of the visible EnterNav form (e.g. the party in a
 * receipt, whose date and type have defaults). Call it when a dialog has opened.
 */
export function focusFirstEmptyField(): void {
  const scope = Array.from(document.querySelectorAll('.enter-nav')).filter(isVisible).pop();
  if (!scope) return;
  const fields = fieldsIn(scope).filter((f) => !f.closest('[data-cell]'));
  const target = fields.find(isEmptyField) ?? fields[0];
  if (target) focusField(target);
}

/**
 * Wrap a form (or a dialog's body) so Enter moves to the next field, like Tab —
 * the keyboard flow of the invoice screens, for forms that have no hand-built
 * chain. Lines grids inside handle Enter themselves; the chain jumps into the
 * grid's first cell and, in a dialog, ends on its primary (Save) button.
 */
/**
 * Enter stays in a date field while its date is unfinished (half typed, or no such
 * day), and on a range's start date, where the picker moves on to the end date.
 */
function dateKeepsEnter(field: HTMLElement, target: HTMLElement): boolean {
  const inputs = Array.from(field.querySelectorAll('input'));
  if (target instanceof HTMLInputElement && inputs.length > 1 && target !== inputs[inputs.length - 1]) return true;
  const input = target instanceof HTMLInputElement ? target : inputs[0];
  return isUnfinishedDateText(input?.value ?? '');
}

/** Focus the field after `field` within the dialog (or the EnterNav scope). */
function moveNext(field: HTMLElement, container: HTMLElement): void {
  const scope = container.closest('.ant-modal-content') ?? container;
  const fields = fieldsIn(scope);
  const next = fields[fields.indexOf(field) + 1];
  if (next) focusField(next);
}

export function EnterNav({
  children,
  onKeyDown,
  onKeyDownCapture,
  className,
  autoFocusWhen,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  /** When this turns true (e.g. a dialog's `open`), focus the first empty field. */
  autoFocusWhen?: boolean;
}) {
  useEffect(() => {
    if (!autoFocusWhen) return;
    // Wait out the dialog's opening animation and its own initial focus.
    const id = window.setTimeout(focusFirstEmptyField, 350);
    return () => window.clearTimeout(id);
  }, [autoFocusWhen]);

  // Before the select sees it: Enter on a closed list moves on instead of opening it,
  // and the arrow keys open it (a list opens on typing or the arrows, like an autocomplete).
  const handleKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDownCapture?.(e);
    const target = e.target as HTMLElement;
    if (target.closest('[data-cell]')) return;
    const select = target.closest<HTMLElement>('.ant-select:not(.ant-select-disabled)');
    if (!select || isSelectDropdownOpen(select)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      openSelect(select);
      return;
    }
    if (handledEnters.has(e.nativeEvent) || e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    handledEnters.add(e.nativeEvent);
    moveNext(select, e.currentTarget);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    // Not `defaultPrevented`: antd's Select prevents Enter itself before it bubbles here.
    if (handledEnters.has(e.nativeEvent) || e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    // Grids, buttons and multi-line text keep their own Enter behaviour.
    if (target.closest('[data-cell]') || target.tagName === 'BUTTON' || target.tagName === 'TEXTAREA') {
      return;
    }
    const field = target.closest<HTMLElement>(FIELD_SELECTOR);
    if (!field) return;
    const isDate = field.matches('.ant-picker');
    // A typed date: the picker has already taken this Enter (it commits the date); move on
    // unless the date is unfinished or the range's end date comes next. Other open lists keep their Enter.
    if (isDate ? dateKeepsEnter(field, target) : isSelectDropdownOpen(field)) return;

    // Always stop the browser's implicit form submit on Enter.
    e.preventDefault();
    handledEnters.add(e.nativeEvent);
    moveNext(field, e.currentTarget);
  };

  return (
    <div {...rest} className={['enter-nav', className].filter(Boolean).join(' ')} onKeyDown={handleKeyDown} onKeyDownCapture={handleKeyDownCapture}>
      {children}
    </div>
  );
}
