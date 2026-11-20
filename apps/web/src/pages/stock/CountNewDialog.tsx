import { InfoCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Checkbox, Form, Input, Radio, Select, Switch, TreeSelect } from 'antd';
import { DatePicker } from '../../components/DatePicker';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import {
  catalogControllerListGroups,
  stockDocumentsControllerCreateCount,
  type CreateStockCountDtoScope,
} from '@erp/api-client';
import { EnterNav } from '../../components/EnterNav';
import { FormDialog, FormSection } from '../../components/FormDialog';
import { GridSelect } from '../../components/GridSelect';
import { buildCreateCountPayload, groupTreeData } from './countPayload';
import { itemOptionsOf, useLookups, useStockItemPicker } from './stockHooks';

interface CountFormValues {
  countDate: Dayjs;
  warehouseId: string;
  description?: string;
  blind: boolean;
  scope: CreateStockCountDtoScope;
  itemGroupId?: string;
  itemIds: string[];
  includeZero: boolean;
}

const SCOPES: CreateStockCountDtoScope[] = ['WAREHOUSE', 'GROUP', 'ITEMS'];

/**
 * The form of a new count (ADR-030 §1, §6, §7). Saving opens the new count's
 * sheet straight away.
 */
export function CountNewDialog({
  open,
  onClose,
  onCreated,
  show,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
  show: (err: unknown) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<CountFormValues>();
  const { whOptions } = useLookups();
  const scope: CreateStockCountDtoScope = Form.useWatch('scope', form) ?? 'WAREHOUSE';
  const selectedItemIds: string[] = Form.useWatch('itemIds', form) ?? [];
  const items = useStockItemPicker(open && scope === 'ITEMS');
  const groups = useQuery({
    queryKey: ['item-groups'],
    queryFn: ({ signal }) => catalogControllerListGroups({ signal }).then((r) => r.data),
    enabled: open && scope === 'GROUP',
  });

  const create = useMutation({
    mutationFn: (v: CountFormValues) =>
      stockDocumentsControllerCreateCount(
        buildCreateCountPayload({
          countDate: v.countDate.format('YYYY-MM-DD'),
          warehouseId: v.warehouseId,
          description: v.description,
          blind: v.blind,
          scope: v.scope,
          itemGroupId: v.itemGroupId,
          itemIds: v.itemIds,
          includeZero: v.includeZero,
        }),
      ),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['stock-counts'] });
      form.resetFields();
      onCreated(res.data.id);
    },
    onError: show,
  });

  return (
    <FormDialog
      title={t('stock.newCount')}
      open={open}
      onCancel={onClose}
      onSave={() => form.submit()}
      saving={create.isPending}
    >
      <EnterNav autoFocusWhen={open}>
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => create.mutate(v)}
          initialValues={{ countDate: dayjs(), blind: false, scope: 'WAREHOUSE', itemIds: [], includeZero: false }}
        >
          <FormSection title={t('stock.countDetails')} icon={<InfoCircleOutlined />}>
            <Form.Item
              name="countDate"
              label={t('stock.date')}
              extra={t('stockCount.dateHint')}
              rules={[{ required: true }]}
            >
              <DatePicker disabledDate={(d: Dayjs) => d.isAfter(dayjs(), 'day')} />
            </Form.Item>
            <Form.Item name="warehouseId" label={t('stock.warehouse')} rules={[{ required: true }]}>
              <GridSelect options={whOptions} />
            </Form.Item>
            <Form.Item name="description" label={t('common.description')}>
              <Input maxLength={500} />
            </Form.Item>
            <Form.Item
              name="blind"
              valuePropName="checked"
              label={t('stockCount.blind')}
              extra={t('stockCount.blindHint')}
            >
              <Switch checkedChildren={t('stockCount.yes')} unCheckedChildren={t('stockCount.no')} />
            </Form.Item>
          </FormSection>
          <FormSection title={t('stockCount.scopeSection')} icon={<InfoCircleOutlined />}>
            <Form.Item name="scope" label={t('stockCount.scopeLabel')} extra={t(`stockCount.scopeHint.${scope}`)}>
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                options={SCOPES.map((s) => ({ value: s, label: t(`stockCount.scope.${s}`) }))}
              />
            </Form.Item>
            {scope === 'WAREHOUSE' && (
              <Form.Item name="includeZero" valuePropName="checked" extra={t('stockCount.includeZeroHint')}>
                <Checkbox>{t('stockCount.includeZero')}</Checkbox>
              </Form.Item>
            )}
            {scope === 'GROUP' && (
              <Form.Item
                name="itemGroupId"
                label={t('stockCount.group')}
                rules={[{ required: true, message: t('stockCount.groupRequired') }]}
              >
                <TreeSelect
                  allowClear
                  showSearch
                  treeDefaultExpandAll
                  treeNodeFilterProp="title"
                  placeholder={t('stockCount.groupPlaceholder')}
                  treeData={groupTreeData(groups.data ?? [])}
                  loading={groups.isLoading}
                />
              </Form.Item>
            )}
            {scope === 'ITEMS' && (
              <Form.Item
                name="itemIds"
                label={t('stockCount.items')}
                rules={[{ required: true, type: 'array', min: 1, message: t('stockCount.itemsRequired') }]}
              >
                <Select
                  mode="multiple"
                  showSearch
                  filterOption={false}
                  onSearch={items.onSearch}
                  loading={items.loading}
                  placeholder={t('stockCount.itemsPlaceholder')}
                  notFoundContent={items.pending ? t('common.loading') : undefined}
                  options={itemOptionsOf(items.withSelected(selectedItemIds))}
                />
              </Form.Item>
            )}
          </FormSection>
        </Form>
      </EnterNav>
    </FormDialog>
  );
}
