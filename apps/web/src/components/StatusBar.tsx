import { useTranslation } from 'react-i18next';

/**
 * Status bar for documents: Draft → Posted, as two chips joined by an arrow.
 * Documents with a middle state (a count is submitted before it is posted)
 * pass `stages`. The current state is ink, past states success, future states neutral.
 * Styles: `.status-bar*` in index.css.
 */
export function StatusBar({
  status,
  stages = ['DRAFT', 'POSTED'],
}: {
  status: 'DRAFT' | 'POSTED' | string;
  stages?: readonly string[];
}) {
  const { t, i18n } = useTranslation();
  const labelOf: Record<string, string> = {
    DRAFT: t('common.draft'),
    SUBMITTED: t('stockCount.statusSubmitted'),
    POSTED: t('common.posted'),
  };
  const steps = stages.map((key) => ({ key, label: labelOf[key] ?? key }));
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
