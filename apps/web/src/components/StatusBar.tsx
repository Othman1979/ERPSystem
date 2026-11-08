import { useTranslation } from 'react-i18next';

/**
 * Odoo-style status bar for documents: Draft → Posted.
 * Rendered as two chips joined by a connector; the current state is
 * highlighted, future states are dimmed.
 */
export function StatusBar({ status }: { status: 'DRAFT' | 'POSTED' | string }) {
  const { t } = useTranslation();
  const steps = [
    { key: 'DRAFT', label: t('common.draft') },
    { key: 'POSTED', label: t('common.posted') },
  ];
  const currentIdx = steps.findIndex((s) => s.key === status);

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {steps.map((s, i) => {
        const done = i < currentIdx;
        const current = i === currentIdx;
        return (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {i > 0 && <span style={{ color: '#c0c4cc' }}>→</span>}
            <span
              style={{
                padding: '2px 12px',
                borderRadius: 12,
                fontSize: 12,
                fontWeight: current ? 600 : 400,
                background: current ? '#714B67' : done ? '#f6ffed' : '#f5f5f5',
                color: current ? '#fff' : done ? '#389e0d' : '#8c8c8c',
                border: `1px solid ${current ? '#714B67' : done ? '#b7eb8f' : '#d9d9d9'}`,
              }}
            >
              {s.label}
            </span>
          </span>
        );
      })}
    </div>
  );
}
