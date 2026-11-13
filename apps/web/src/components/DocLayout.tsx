import { ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { AutoComplete, Button, ConfigProvider, DatePicker, Input, InputNumber, Radio, Select } from 'antd';
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEventHandler,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { fieldPanelTheme } from '../theme';
import { GridSelect } from './GridSelect';
import { StatusBar } from './StatusBar';

// Kept here as well: pages import the panel theme from DocLayout.
export { fieldPanelTheme };

/**
 * Shared frame for document screens (invoices, journal entries, stock notes…):
 * a sticky toolbar — back, title, document number, status, actions — above the
 * header-field panel, the lines grid and the totals.
 */
export function DocLayout({
  title,
  docNo,
  status,
  onBack,
  actions,
  children,
}: {
  title: ReactNode;
  /** Document number once assigned (e.g. SI-FY2026-000012); omitted for new drafts. */
  docNo?: string | null;
  status?: string;
  onBack?: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  return (
    <section className="doc-layout">
      <div className="doc-toolbar">
        {onBack && (
          <Button
            type="text"
            icon={i18n.dir() === 'rtl' ? <ArrowRightOutlined /> : <ArrowLeftOutlined />}
            onClick={onBack}
            aria-label={t('common.back')}
          />
        )}
        <h2 className="doc-title">{title}</h2>
        {docNo && <span className="doc-no">{docNo}</span>}
        {status && <StatusBar status={status} />}
        {actions && <div className="doc-toolbar-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Panel laying header fields out in a responsive grid (3–4 columns on desktop). */
export function DocFields({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider theme={fieldPanelTheme}>
      <div className="doc-fields">{children}</div>
    </ConfigProvider>
  );
}

/** Controls whose `id` lands on the focusable input, so `<label htmlFor>` names them. */
const LABELABLE: ReadonlySet<unknown> = new Set<unknown>([
  Input,
  Input.TextArea,
  Input.Password,
  InputNumber,
  Select,
  GridSelect,
  AutoComplete,
  DatePicker,
]);

const NAMEABLE_CONTROL =
  'input:not([type="hidden"]):not([type="radio"]), textarea, [role="combobox"], [role="radiogroup"], [role="switch"], button[role="checkbox"]';

type ControlProps = {
  id?: string;
  role?: string;
  'aria-labelledby'?: string;
  'aria-required'?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
};

/**
 * One labelled header field; `field` is the data-field key used by Enter navigation.
 *
 * Accessible name (UI-02): the label is a real `<label for>` bound to the
 * control's input; a radio group is named through aria-labelledby. Anything
 * else that renders a control (wrapped controls, custom pickers) is named
 * after mount by pointing its first unnamed control at the label.
 */
export function DocField({
  label,
  required,
  error,
  field,
  wide,
  onKeyDown,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  /** Shown under the control in red (e.g. after a save attempt with the field empty). */
  error?: ReactNode;
  field?: string;
  /** Span two columns (long text such as a description). */
  wide?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const errorId = `${baseId}-error`;
  const ref = useRef<HTMLDivElement>(null);

  const only = Children.count(children) === 1 && isValidElement(children) ? children : null;
  const a11y: ControlProps = {
    'aria-required': required || undefined,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined,
  };

  let control: ReactNode = children;
  let htmlFor: string | undefined;
  if (only && LABELABLE.has(only.type)) {
    const el = only as ReactElement<ControlProps>;
    htmlFor = el.props.id ?? `${baseId}-control`;
    control = cloneElement(el, { ...a11y, id: htmlFor });
  } else if (only && only.type === Radio.Group) {
    control = cloneElement(only as ReactElement<ControlProps>, {
      ...a11y,
      role: 'radiogroup',
      'aria-labelledby': labelId,
    });
  }

  // Fallback naming for anything the clone above did not cover. Read-only
  // values and radio groups need none.
  const needsFallback = !htmlFor && only?.type !== Radio.Group && only?.type !== DocValue;
  useLayoutEffect(() => {
    if (!needsFallback || !ref.current) return;
    const target = ref.current.querySelector<HTMLElement>(NAMEABLE_CONTROL);
    if (!target || target.hasAttribute('aria-label') || target.hasAttribute('aria-labelledby')) return;
    if (target.id && ref.current.querySelector(`label[for="${CSS.escape(target.id)}"]`)) return;
    target.setAttribute('aria-labelledby', labelId);
    if (required) target.setAttribute('aria-required', 'true');
  });

  const labelContent = (
    <>
      {label}
      {required && (
        <span className="doc-field-req" aria-hidden="true">
          *
        </span>
      )}
    </>
  );

  return (
    <div
      ref={ref}
      className={wide ? 'doc-field doc-field-wide' : 'doc-field'}
      data-field={field}
      onKeyDown={onKeyDown}
    >
      {htmlFor ? (
        <label id={labelId} htmlFor={htmlFor} className="doc-field-label">
          {labelContent}
        </label>
      ) : (
        <span id={labelId} className="doc-field-label">
          {labelContent}
        </span>
      )}
      {control}
      {error && (
        <div id={errorId} className="doc-field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** Read-only value in a DocField (posted documents). */
export function DocValue({ children }: { children: ReactNode }) {
  return <div className="doc-field-value">{children ?? '—'}</div>;
}

/**
 * Document keyboard shortcuts: Ctrl+S saves, Ctrl+Enter posts. Matches the
 * physical key (KeyS) so it also works on an Arabic keyboard layout, and runs
 * in the capture phase so a grid cell's own Enter handling doesn't also fire.
 */
export function useDocShortcuts(handlers: { onSave?: () => void; onPost?: () => void }) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
      const handler =
        e.code === 'KeyS' ? ref.current.onSave : e.key === 'Enter' ? ref.current.onPost : undefined;
      if (!handler) return;
      e.preventDefault();
      e.stopPropagation();
      handler();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}
