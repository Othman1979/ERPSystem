import { useTranslation } from 'react-i18next';

/** Keyboard hint (and optional line count) shown under a data-entry grid. */
export function GridHint({ lineCount }: { lineCount?: number }) {
  const { t } = useTranslation();
  return (
    <div className="entry-grid-hint">
      <div>
        <kbd>Enter</kbd> {t('common.gridNextField')} · <kbd>← → ↑ ↓</kbd>{' '}
        {t('common.gridMoveCells')}
      </div>
      {lineCount !== undefined && <div>{t('common.lineCount', { count: lineCount })}</div>}
    </div>
  );
}
