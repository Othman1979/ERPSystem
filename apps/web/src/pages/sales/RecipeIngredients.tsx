import { useQuery } from '@tanstack/react-query';
import { Alert, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import {
  salesControllerRecipePreview,
  type RecipePreviewComponentDto,
  type RecipePreviewDto,
  type RecipePreviewLineDto,
  type SalesInvoiceLineComponentViewDto,
} from '@erp/api-client';
import { StatusTag } from '../../components/StatusTag';
import { amountCell, qtyCell, unitCostCell } from '../../format/cells';
import { dec } from '../../format/number';
import { codeAndName } from '../../i18n/displayName';

/**
 * The ingredients of the recipe lines of a DRAFT invoice (ADR-032 §12): the
 * components each recipe line takes, what the invoice warehouse holds and the
 * shortage. A recipe with no ACTIVE formula is flagged in the warning colour.
 * Renders nothing when the invoice has no recipe line.
 */
export function RecipeIngredientsPanel({ invoiceId }: { invoiceId: string }) {
  const { t } = useTranslation();
  const preview = useQuery({
    queryKey: ['sales-invoices', 'recipe-preview', invoiceId],
    queryFn: ({ signal }) => salesControllerRecipePreview(invoiceId, { signal }).then((r) => r.data),
  });
  if (preview.isError) return <Alert type="error" showIcon message={t('common.loadFailed')} />;
  if (!preview.data || preview.data.lines.length === 0) return null;
  return <RecipePreviewView preview={preview.data} />;
}

/** The preview's content: a view of the API's figures, with no arithmetic beyond a comparison. */
export function RecipePreviewView({ preview }: { preview: RecipePreviewDto }) {
  const { t } = useTranslation();
  const columns: ColumnsType<RecipePreviewComponentDto> = [
    {
      title: t('sales.recipe.component'),
      render: (_: unknown, c: RecipePreviewComponentDto) => codeAndName(c),
    },
    { title: t('sales.recipe.needed'), dataIndex: 'qtyBase', align: 'right', width: 120, render: qtyCell },
    { title: t('sales.recipe.onHand'), dataIndex: 'onHandBase', align: 'right', width: 120, render: qtyCell },
    {
      title: t('sales.recipe.shortage'),
      dataIndex: 'shortageBase',
      align: 'right',
      width: 150,
      render: (v: string) =>
        dec(v).gt(0) ? (
          <Space size={6}>
            <StatusTag tone="warning">{t('sales.recipe.short')}</StatusTag>
            {qtyCell(v)}
          </Space>
        ) : (
          qtyCell(v)
        ),
    },
  ];

  return (
    <section className="doc-section">
      <Typography.Title level={5}>{t('sales.recipe.ingredients')}</Typography.Title>
      <Typography.Text type="secondary">{t('sales.recipe.ingredientsHint')}</Typography.Text>
      {preview.hasShortage && <Alert type="warning" showIcon style={{ margin: '12px 0' }} message={t('sales.recipe.shortWarning')} />}
      {preview.lines.map((line: RecipePreviewLineDto) => (
        <div key={line.lineId} style={{ marginTop: 12 }}>
          <Space wrap align="center" style={{ marginBottom: 6 }}>
            <Typography.Text strong>{`${t('sales.recipe.line')} ${line.lineNo} · ${line.itemCode}`}</Typography.Text>
            {line.bomMissing && <StatusTag tone="warning">{t('sales.recipe.bomMissing')}</StatusTag>}
          </Space>
          {line.bomMissing ? (
            <Alert type="warning" showIcon message={t('sales.recipe.bomMissingWarning')} />
          ) : (
            <Table<RecipePreviewComponentDto>
              rowKey="componentItemId"
              size="small"
              pagination={false}
              scroll={{ x: 'max-content' }}
              dataSource={line.components}
              columns={columns}
            />
          )}
        </div>
      ))}
    </section>
  );
}

/**
 * The components a posted recipe line took (ADR-032 §12): quantity in the base unit,
 * unit cost and the component's cost. Shown under the line, expanded on demand.
 */
export function PostedRecipeComponents({ components }: { components: SalesInvoiceLineComponentViewDto[] }) {
  const { t } = useTranslation();
  if (components.length === 0) return <Typography.Text type="secondary">{t('sales.recipe.noComponents')}</Typography.Text>;
  return (
    <Table<SalesInvoiceLineComponentViewDto>
      rowKey="id"
      size="small"
      pagination={false}
      scroll={{ x: 'max-content' }}
      dataSource={components}
      columns={[
        { title: t('sales.recipe.component'), render: (_: unknown, c: SalesInvoiceLineComponentViewDto) => codeAndName(c.componentItem) },
        { title: t('stock.qty'), dataIndex: 'qtyBase', align: 'right', width: 120, render: qtyCell },
        { title: t('sales.recipe.unitCost'), dataIndex: 'unitCost', align: 'right', width: 120, render: unitCostCell },
        { title: t('sales.recipe.lineCost'), dataIndex: 'totalCost', align: 'right', width: 120, render: amountCell },
      ]}
    />
  );
}
