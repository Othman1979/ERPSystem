import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export type WinFieldSize = 'date' | 'num' | 'md' | 'full';

export function WinPanel({
  title,
  footer,
  children,
  wide = false,
}: {
  title: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={`win-panel${wide ? ' win-panel-wide' : ''}`}>
      <div className="doc-subbar win-panel-titlebar">
        <span className="doc-subbar-title">{title}</span>
      </div>
      <div className="win-panel-body">{children}</div>
      {footer && <div className="win-panel-footer">{footer}</div>}
    </section>
  );
}

export function WinGroup({
  title,
  cols = 2,
  children,
}: {
  title: ReactNode;
  cols?: 1 | 2 | 3;
  children: ReactNode;
}) {
  return (
    <fieldset className="win-group">
      <legend>{title}</legend>
      <div className="win-grid" style={{ '--cols': cols } as CSSProperties}>
        {children}
      </div>
    </fieldset>
  );
}

export function WinField({
  label,
  children,
  size,
}: {
  label: ReactNode;
  children: ReactNode;
  size?: WinFieldSize;
}) {
  return (
    <label className={`win-field${size ? ` win-w-${size}` : ''}`}>
      <span className="win-field-label">{label}</span>
      <span className="win-field-control">{children}</span>
    </label>
  );
}

export function ReportCriteria({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="win-group report-criteria">
      <legend>{t('reports.criteria')}</legend>
      <div className="report-criteria-row">
        <div className="report-criteria-fields">{children}</div>
        {actions && <div className="win-actions">{actions}</div>}
      </div>
    </fieldset>
  );
}
