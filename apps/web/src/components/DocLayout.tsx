import { ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { Button, ConfigProvider } from 'antd';
import { useEffect, useRef, type KeyboardEventHandler, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { palette } from '../theme';
import { StatusBar } from './StatusBar';

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

// Field panel controls get the darker grid border so they stand out on the gray panel.
const fieldPanelTheme = {
  token: { colorBorder: palette.grid.border },
  components: {
    Radio: {
      buttonSolidCheckedBg: palette.grid.bar,
      buttonSolidCheckedHoverBg: palette.grid.bar,
      buttonSolidCheckedActiveBg: palette.grid.bar,
      buttonSolidCheckedColor: palette.grid.barText,
    },
  },
};

/** Gray panel laying header fields out in a responsive grid (3–4 columns on desktop). */
export function DocFields({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider theme={fieldPanelTheme}>
      <div className="doc-fields">{children}</div>
    </ConfigProvider>
  );
}

/** One labelled header field; `field` is the data-field key used by Enter navigation. */
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
  return (
    <div
      className={wide ? 'doc-field doc-field-wide' : 'doc-field'}
      data-field={field}
      onKeyDown={onKeyDown}
    >
      <span className="doc-field-label">
        {label}
        {required && <span className="doc-field-req">*</span>}
      </span>
      {children}
      {error && <div className="doc-field-error">{error}</div>}
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
