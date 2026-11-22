import { SaveOutlined } from '@ant-design/icons';
import { Button, ConfigProvider, Form, Modal } from 'antd';
import { Children, Fragment, isValidElement, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { fieldPanelTheme } from '../theme';
import { useDocShortcuts } from './DocLayout';
import { EnterNav } from './EnterNav';
import { WinField } from './WinForm';

// Inline styles so they always win over antd's own; colours are the --c-* tokens.
const dialogStyles = {
  content: { padding: 0, borderRadius: 4, border: '1px solid var(--c-grid-frame)', overflow: 'hidden' as const },
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
  useDocShortcuts({ onSave: open ? () => !saving && onSave() : undefined }, { allowInModal: true });
  return (
    <Modal
      open={open}
      title={title}
      onCancel={onCancel}
      // Never wider than the screen; opens in the middle with a fade, not a zoom from the click.
      width={`min(${width}px, 96vw)`}
      centered
      transitionName="ant-fade"
      className="form-dialog"
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
      <ConfigProvider theme={fieldPanelTheme}>
        <EnterNav autoFocusWhen={open}>{children}</EnterNav>
      </ConfigProvider>
    </Modal>
  );
}

/**
 * Titled group box for form fields and full-row content.
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
  cols?: 1 | 2 | 3;
  children: ReactNode;
}) {
  const toGridChildren = (nodes: ReactNode): ReactNode[] => {
    const gridChildren: ReactNode[] = [];
    Children.forEach(nodes, (child, index) => {
      if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
        gridChildren.push(...toGridChildren(child.props.children));
      } else if (isValidElement(child) && (child.type === Form.Item || child.type === WinField)) {
        gridChildren.push(child);
      } else {
        gridChildren.push(
          <div
            key={isValidElement(child) ? child.key ?? index : index}
            className="form-section-full-row"
          >
            {child}
          </div>,
        );
      }
    });
    return gridChildren;
  };
  const gridChildren = toGridChildren(children);

  return (
    <fieldset className="form-section win-group">
      <legend className="form-section-bar">
        <span className="form-section-title">
          {icon}
          <span className="doc-subbar-title">{title}</span>
        </span>
        {extra && <span className="form-section-extra">{extra}</span>}
      </legend>
      <div
        className={`form-section-grid win-grid${cols === 2 ? ' cols-2' : ''}`}
        style={{ '--cols': cols } as CSSProperties}
      >
        {gridChildren}
      </div>
    </fieldset>
  );
}
