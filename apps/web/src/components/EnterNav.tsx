import { useEffect, type HTMLAttributes, type KeyboardEvent } from 'react';
import { focusCellEl, isSelectDropdownOpen } from './GridSelect';

/** Field roots that Enter steps through, in DOM order. */
const FIELD_SELECTOR = [
  '.ant-select:not(.ant-select-disabled)',
  '.ant-picker:not(.ant-picker-disabled)',
  '.ant-input-number:not(.ant-input-number-disabled)',
  'input.ant-input:not([disabled])',
  // A dialog's primary button ends the chain: Enter there saves.
  '.ant-modal-footer .ant-btn-primary:not([disabled])',
].join(', ');

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
export function EnterNav({
  children,
  onKeyDown,
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

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    // Grids, buttons and multi-line text keep their own Enter behaviour.
    if (target.closest('[data-cell]') || target.tagName === 'BUTTON' || target.tagName === 'TEXTAREA') {
      return;
    }
    const field = target.closest<HTMLElement>(FIELD_SELECTOR);
    if (!field || isSelectDropdownOpen(field)) return;

    // Always stop the browser's implicit form submit on Enter.
    e.preventDefault();
    const scope = e.currentTarget.closest('.ant-modal-content') ?? e.currentTarget;
    const fields = fieldsIn(scope);
    const next = fields[fields.indexOf(field) + 1];
    if (next) focusField(next);
  };

  return (
    <div {...rest} className={['enter-nav', className].filter(Boolean).join(' ')} onKeyDown={handleKeyDown}>
      {children}
    </div>
  );
}
