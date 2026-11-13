import { useTranslation } from 'react-i18next';

/**
 * Status bar for documents: Draft → Posted, as two chips joined by an arrow.
 * The current state is ink, past states success, future states neutral.
 * Styles: `.status-bar*` in index.css.
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
    <div className="status-bar">
      {steps.map((s, i) => {
        const state = i < currentIdx ? ' is-done' : i === currentIdx ? ' is-current' : '';
        return (
          <span key={s.key} className="status-bar-item">
            {i > 0 && (
              <span className="status-bar-arrow" aria-hidden="true">
                {arrow}
              </span>
            )}
            <span className={`status-bar-step${state}`} aria-current={i === currentIdx ? 'step' : undefined}>
              {s.label}
            </span>
          </span>
        );
      })}
    </div>
  );
}
