import { useTranslation } from 'react-i18next';

/** Keyboard hint (and optional line count) shown under a data-entry grid. */
export function GridHint({ lineCount }: { lineCount?: number }) {
  const { t } = useTranslation();
  return (
    <div className="entry-grid-hint">
      {/* Hidden on touch screens, where there is no keyboard to hint at (UI-19). */}
      <div className="grid-hint-keys">
        <kbd>Enter</kbd> {t('common.gridNextField')} · <kbd>← → ↑ ↓</kbd>{' '}
        {t('common.gridMoveCells')}
      </div>
      {lineCount !== undefined && <div>{t('common.lineCount', { count: lineCount })}</div>}
    </div>
  );
}
