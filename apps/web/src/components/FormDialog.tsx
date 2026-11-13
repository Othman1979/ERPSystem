import { SaveOutlined } from '@ant-design/icons';
import { Button, ConfigProvider, Modal } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fieldPanelTheme } from '../theme';
import { useDocShortcuts } from './DocLayout';

// Inline styles so they always win over antd's own; colours are the --c-* tokens.
const dialogStyles = {
  content: { padding: 0, borderRadius: 4, border: '1px solid var(--c-grid-frame)' },
  header: {
    margin: 0,
    padding: '10px 16px',
    borderBottom: '1px solid var(--c-grid-frame)',
  },
  // Only the body scrolls, so Save stays in view however long the form is.
  body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' as const },
  footer: {
    margin: 0,
    padding: '8px 12px',
    background: 'var(--c-panel)',
    borderTop: '1px solid var(--c-grid-frame)',
  },
};

/**
 * Dialog for master-data records (items, parties, accounts…): titled sections
 * inside, and a fixed footer — Save (Ctrl+S), optional Save & new, Cancel.
 */
export function FormDialog({
  open,
  title,
  onCancel,
  onSave,
  onSaveAndNew,
  saving,
  width = 760,
  destroyOnHidden,
  children,
}: {
  open: boolean;
  title: ReactNode;
  onCancel: () => void;
  onSave: () => void;
  /** Save, then reopen an empty form for the next record. */
  onSaveAndNew?: () => void;
  saving?: boolean;
  width?: number;
  destroyOnHidden?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  useDocShortcuts({ onSave: open ? () => !saving && onSave() : undefined });
  return (
    <Modal
      open={open}
      title={title}
      onCancel={onCancel}
      width={width}
      destroyOnHidden={destroyOnHidden}
      styles={dialogStyles}
      footer={
        <div className="form-dialog-footer">
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={onSave}>
            {t('common.save')}
            <span className="doc-kbd">Ctrl+S</span>
          </Button>
          {onSaveAndNew && (
            <Button disabled={saving} onClick={onSaveAndNew}>
              {t('common.saveAndNew')}
            </Button>
          )}
          <span style={{ flex: 1 }} />
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      }
    >
      <ConfigProvider theme={fieldPanelTheme}>{children}</ConfigProvider>
    </Modal>
  );
}

/**
 * Titled section of a FormDialog: a gray bar, then its Form.Items in a 2–3
 * column grid. Give a Form.Item className "span-2" or "span-all" to widen it.
 */
export function FormSection({
  title,
  icon,
  extra,
  cols = 3,
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  /** Shown at the end of the bar (e.g. an Active switch). */
  extra?: ReactNode;
  cols?: 2 | 3;
  children: ReactNode;
}) {
  return (
    <section className="form-section">
      <div className="doc-subbar form-section-bar">
        {icon}
        <span className="doc-subbar-title">{title}</span>
        {extra && <span className="form-section-extra">{extra}</span>}
      </div>
      <div className={cols === 2 ? 'form-section-grid cols-2' : 'form-section-grid'}>
        {children}
      </div>
    </section>
  );
}
