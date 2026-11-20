import { InputNumber, Select, Space } from 'antd';
import { useTranslation } from 'react-i18next';

export type InvoiceDiscountType = 'PERCENT' | 'AMOUNT';

export function InvoiceDiscountField({
  type,
  value,
  onTypeChange,
  onValueChange,
}: {
  type: InvoiceDiscountType;
  value?: string;
  onTypeChange: (type: InvoiceDiscountType) => void;
  onValueChange: (value: string | undefined) => void;
}) {
  const { t } = useTranslation();
  return (
    <Space>
      <Select
        aria-label={t('sales.invoiceDiscount')}
        value={type}
        onChange={onTypeChange}
        options={[
          { value: 'PERCENT', label: t('sales.invoiceDiscountPercent') },
          { value: 'AMOUNT', label: t('sales.invoiceDiscountAmount') },
        ]}
      />
      <InputNumber<string>
        aria-label={type === 'PERCENT' ? t('sales.invoiceDiscountPercent') : t('sales.invoiceDiscountAmount')}
        stringMode
        min="0"
        max={type === 'PERCENT' ? '100' : undefined}
        value={value}
        onChange={(next) => onValueChange(next ?? undefined)}
        style={{ width: 170 }}
      />
    </Space>
  );
}
