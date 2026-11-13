import { Tag } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Semantic tones for status tags. Colour carries meaning only (UI-13):
 *  - success: a finished, good state (posted, accepted)
 *  - warning: needs attention (reversed, past due, invited)
 *  - danger:  blocked or failed (suspended, rejected)
 *  - info:    in progress (sending, trial)
 *  - neutral: everything else, including types and categories
 * All five pass AA (see docs/design/tokens.md).
 */
export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TAG_COLOR: Record<StatusTone, string | undefined> = {
  success: 'success',
  warning: 'warning',
  danger: 'error',
  info: 'processing',
  neutral: undefined,
};

export function StatusTag({ tone = 'neutral', children }: { tone?: StatusTone; children: ReactNode }) {
  return (
    <Tag className="status-tag" color={TAG_COLOR[tone]} bordered>
      {children}
    </Tag>
  );
}

/**
 * Active / inactive marker for master data. Active is the normal state and
 * shows nothing; only «غير نشط» / "Inactive" is shown (owner decision).
 */
export function ActiveTag({ active }: { active: boolean }) {
  const { t } = useTranslation();
  if (active) return null;
  return <StatusTag tone="neutral">{t('common.inactive')}</StatusTag>;
}
