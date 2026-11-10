import { Button, DatePicker, Popconfirm, Space, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * "Reverse" with a confirmation that asks for the reversal date (§8.3: a
 * posted document is corrected by a mirror entry, never edited).
 */
export function ReverseButton({
  onReverse,
  loading,
  size = 'small',
}: {
  onReverse: (reversalDate: string) => void;
  loading?: boolean;
  size?: 'small' | 'middle';
}) {
  const { t } = useTranslation();
  const [date, setDate] = useState<Dayjs>(dayjs());
  return (
    <Popconfirm
      title={t('treasury.reverseConfirm')}
      description={
        <Space direction="vertical" size={4}>
          <Typography.Text type="secondary">{t('treasury.reversalDate')}</Typography.Text>
          <DatePicker
            value={date}
            allowClear={false}
            onChange={(d) => d && setDate(d)}
            // Keep the calendar inside the popover so picking a day doesn't close it.
            getPopupContainer={(node) => node.parentElement ?? document.body}
          />
        </Space>
      }
      okText={t('treasury.reverse')}
      okButtonProps={{ danger: true }}
      cancelText={t('common.cancel')}
      onConfirm={() => onReverse(date.format('YYYY-MM-DD'))}
    >
      <Button size={size} danger loading={loading}>
        {t('treasury.reverse')}
      </Button>
    </Popconfirm>
  );
}
