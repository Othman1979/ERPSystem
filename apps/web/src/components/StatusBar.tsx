import { useTranslation } from 'react-i18next';
import { palette } from '../theme';

/**
 * Odoo-style status bar for documents: Draft → Posted.
 * Rendered as two chips joined by a connector; the current state is
 * highlighted, past states are green, future states are dimmed.
 */
export function StatusBar({ status }: { status: 'DRAFT' | 'POSTED' | string }) {
  const { t, i18n } = useTranslation();
  const steps = [
    { key: 'DRAFT', label: t('common.draft') },
    { key: 'POSTED', label: t('common.posted') },
  ];
  const currentIdx = steps.findIndex((s) => s.key === status);
  // The flow reads in the page's direction: → in English, ← in Arabic.
  const arrow = i18n.dir() === 'rtl' ? '←' : '→';

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {steps.map((s, i) => {
        const done = i < currentIdx;
        const current = i === currentIdx;
        return (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {i > 0 && <span style={{ color: palette.borderStrong }}>{arrow}</span>}
            <span
              style={{
                padding: '2px 12px',
                borderRadius: 12,
                fontSize: 12,
                fontWeight: current ? 600 : 400,
                background: current ? palette.primary : done ? palette.successBg : palette.headerBg,
                color: current ? palette.textOnPrimary : done ? palette.success : palette.textMuted,
                border: `1px solid ${
                  current ? palette.primary : done ? palette.successBorder : palette.borderStrong
                }`,
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
