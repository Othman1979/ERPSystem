import {
  AppstoreOutlined,
  DatabaseOutlined,
  InfoCircleOutlined,
  TagOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Form, Input, InputNumber, Radio, Select, Switch, message } from 'antd';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  catalogControllerCreateItem,
  catalogControllerListGroups,
  catalogControllerUpdateItem,
  settingsControllerListTaxCategories,
  settingsControllerListUnits,
  warehousesControllerList,
  type ItemDetailDto,
  type ItemDto,
  type ItemListItemDto,
} from '@erp/api-client';
import { FormDialog, FormSection } from './FormDialog';
import { codeAndName } from '../i18n/displayName';
import { itemCreateBody, itemUpdateBody, type ItemFormValues } from '../pages/items/itemPayload';
import { holdsStock, isRecipe, ITEM_KIND_LABEL_KEY, ITEM_KINDS, ownsFormula } from '../pages/items/itemKinds';
import { ItemFormulas } from '../pages/manufacturing/ItemFormulas';

export type ItemFormDialogSaved = ItemDetailDto | ItemDto;

export interface ItemFormDialogProps {
  open: boolean;
  editing?: ItemListItemDto | null;
  initialValues?: Partial<ItemFormValues>;
  onSaved: (created: ItemFormDialogSaved) => void;
  onCancel: () => void;
}

export function ItemFormDialog({
  open,
  editing,
  initialValues,
  onSaved,
  onCancel,
}: ItemFormDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ItemFormValues>();
  const [apiMessage, contextHolder] = message.useMessage();
  const saveAndNew = useRef(false);
  const { data: units } = useQuery({
    queryKey: ['units'],
    queryFn: ({ signal }) => settingsControllerListUnits({ signal }).then((response) => response.data),
  });
  const { data: groups } = useQuery({
    queryKey: ['item-groups'],
    queryFn: ({ signal }) => catalogControllerListGroups({ signal }).then((response) => response.data),
  });
  const { data: warehouses } = useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) => warehousesControllerList({ signal }).then((response) => response.data),
  });
  const { data: taxCategories } = useQuery({
    queryKey: ['tax-categories'],
    queryFn: ({ signal }) => settingsControllerListTaxCategories({ signal }).then((response) => response.data),
  });

  useEffect(() => {
    if (!open) return;
    saveAndNew.current = false;
    form.resetFields();
    if (editing) {
      form.setFieldsValue({
        code: editing.code,
        nameAr: editing.nameAr,
        nameEn: editing.nameEn,
        description: editing.description,
        itemKind: editing.itemKind,
        baseUnitId: undefined,
        itemGroupId: editing.itemGroup?.id ?? undefined,
        taxCategoryId: editing.taxCategoryId ?? undefined,
        defaultWarehouseId: editing.defaultWarehouseId ?? undefined,
        salePrice: editing.salePrice ?? undefined,
        purchasePrice: editing.purchasePrice ?? undefined,
        minStock: editing.minStock ?? undefined,
        maxStock: editing.maxStock ?? undefined,
        salePriceIncludesTax: editing.salePriceIncludesTax,
        imageUrl: editing.imageUrl ?? undefined,
      });
    } else {
      form.setFieldsValue({
        itemKind: 'STOCK',
        salePriceIncludesTax: false,
        ...initialValues,
      });
    }
  }, [editing, form, initialValues, open]);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['items'] });
  const save = useMutation({
    mutationFn: async (values: ItemFormValues) => {
      if (editing) {
        const response = await catalogControllerUpdateItem(editing.id, itemUpdateBody(values));
        return response.data;
      }
      const response = await catalogControllerCreateItem(itemCreateBody(values));
      return response.data;
    },
    onSuccess: (created) => {
      invalidate();
      if (saveAndNew.current) {
        saveAndNew.current = false;
        form.resetFields();
        form.setFieldsValue({ itemKind: 'STOCK', salePriceIncludesTax: false });
        requestAnimationFrame(() => form.getFieldInstance('code')?.focus?.());
        return;
      }
      onSaved(created);
    },
    onError: (err) => {
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      );
    },
  });

  return (
    <>
      {contextHolder}
      <FormDialog
        title={editing ? t('items.edit') : t('items.add')}
        open={open}
        onCancel={onCancel}
        onSave={() => {
          saveAndNew.current = false;
          form.submit();
        }}
        onSaveAndNew={
          editing
            ? undefined
            : () => {
                saveAndNew.current = true;
                form.submit();
              }
        }
        saving={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
          <FormSection title={t('common.basicInfo')} icon={<InfoCircleOutlined />}>
            <Form.Item name="code" label={t('items.code')} rules={[{ required: true }]}>
              <Input maxLength={50} disabled={!!editing} />
            </Form.Item>
            <Form.Item name="itemKind" label={t('items.kind')} initialValue="STOCK" className="span-2">
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                disabled={!!editing}
                options={ITEM_KINDS.map((kind) => ({ value: kind, label: t(ITEM_KIND_LABEL_KEY[kind]) }))}
              />
            </Form.Item>
            <Form.Item name="nameAr" label={t('items.nameAr')} rules={[{ required: true }]} className="span-2">
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="nameEn" label={t('items.nameEn')}>
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="description" label={t('common.description')} className="span-all">
              <Input.TextArea rows={2} maxLength={500} />
            </Form.Item>
            <Form.Item name="imageUrl" label={t('items.imageUrl')} className="span-all">
              <Input maxLength={512} placeholder="https://…" />
            </Form.Item>
          </FormSection>

          <FormSection title={t('items.classification')} icon={<AppstoreOutlined />}>
            <Form.Item name="baseUnitId" label={t('items.baseUnit')} rules={[{ required: true }]}>
              <Select
                showSearch
                optionFilterProp="label"
                disabled={!!editing}
                options={(units ?? [])
                  .filter((unit) => unit.id)
                  .map((unit) => ({
                    value: unit.id,
                    label: `${codeAndName(unit)}${unit.unEceCode ? ` (${unit.unEceCode})` : ''}`,
                  }))}
              />
            </Form.Item>
            <Form.Item name="itemGroupId" label={t('items.group')}>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                options={(groups ?? [])
                  .filter((group) => group.isActive)
                  .map((group) => ({ value: group.id, label: codeAndName(group) }))}
              />
            </Form.Item>
            <Form.Item name="taxCategoryId" label={t('items.taxCategory')}>
              <Select
                allowClear
                options={(taxCategories ?? []).map((taxCategory) => ({
                  value: taxCategory.id,
                  label: `${codeAndName(taxCategory)} (${taxCategory.rate}%)`,
                }))}
              />
            </Form.Item>
          </FormSection>

          <FormSection title={t('items.pricing')} icon={<TagOutlined />}>
            <Form.Item name="salePrice" label={t('items.salePrice')}>
              <InputNumber<string> stringMode min="0" step="0.001" />
            </Form.Item>
            <Form.Item name="purchasePrice" label={t('items.purchasePrice')}>
              <InputNumber<string> stringMode min="0" step="0.001" />
            </Form.Item>
            <Form.Item name="salePriceIncludesTax" label={t('items.priceIncludesTax')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </FormSection>

          <Form.Item noStyle shouldUpdate>
            {({ getFieldValue }) =>
              holdsStock(getFieldValue('itemKind')) ? (
                <FormSection title={t('items.inventory')} icon={<DatabaseOutlined />}>
                  <Form.Item name="minStock" label={t('items.minStock')}>
                    <InputNumber<string> stringMode min="0" step="0.000001" />
                  </Form.Item>
                  <Form.Item name="maxStock" label={t('items.maxStock')}>
                    <InputNumber<string> stringMode min="0" step="0.000001" />
                  </Form.Item>
                  <Form.Item name="defaultWarehouseId" label={t('items.defaultWarehouse')}>
                    <Select
                      allowClear
                      options={(warehouses ?? []).map((warehouse) => ({
                        value: warehouse.id,
                        label: codeAndName(warehouse),
                      }))}
                    />
                  </Form.Item>
                </FormSection>
              ) : isRecipe(getFieldValue('itemKind')) ? (
                <Alert type="info" showIcon style={{ marginBottom: 16 }} message={t('items.recipeHint')} />
              ) : null
            }
          </Form.Item>
        </Form>
        {editing && ownsFormula(editing.itemKind) && <ItemFormulas itemId={editing.id} />}
      </FormDialog>
    </>
  );
}
