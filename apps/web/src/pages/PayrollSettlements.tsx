import { DeleteOutlined } from '@ant-design/icons';
import {
  payrollControllerListEmployees,
  payrollSettlementControllerCreate,
  payrollSettlementControllerDelete,
  payrollSettlementControllerList,
  payrollSettlementControllerPay,
  payrollSettlementControllerPost,
  payrollSettlementControllerRecompute,
  payrollSettlementControllerReverse,
  treasuryControllerListBankAccounts,
  treasuryControllerListCashBoxes,
  type PayrollEmployeeDto,
  type PayrollSettlementDto,
  type PayrollSettlementDtoStatus,
} from '@erp/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Descriptions, Form, Popconfirm, Select, Space, Table, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { DatePicker } from '../components/DatePicker';
import { FormDialog } from '../components/FormDialog';
import { GridSelect } from '../components/GridSelect';
import { formatAmount } from '../format/number';
import { idemHeaders } from '../idempotency';

type DateValue = Dayjs | string | null | undefined;
type EmployeeOption = Pick<PayrollEmployeeDto, 'id' | 'code' | 'nameAr' | 'nameEn' | 'leaveDate' | 'sscCovered'>;
type PaymentForm = { paymentDate: DateValue; sourceType: 'cash' | 'bank'; sourceId: string };
type ReverseForm = { reversalDate: DateValue };

function dateOnly(value: DateValue): string | undefined {
  if (value == null || value === '') return undefined;
  return dayjs.isDayjs(value) ? value.format('YYYY-MM-DD') : value.slice(0, 10);
}

export function settlementEligibleEmployees(rows: EmployeeOption[]): EmployeeOption[] {
  return rows.filter((row) => !row.sscCovered && row.leaveDate != null);
}

function employeeOptions(rows: EmployeeOption[] | undefined, language: string) {
  return (rows ?? []).map((row) => ({
    value: row.id,
    label: `${row.code} — ${language === 'en' ? row.nameEn ?? row.nameAr : row.nameAr}`,
  }));
}

function employeeName(row: PayrollSettlementDto, employees: PayrollEmployeeDto[] | undefined, language: string) {
  const employee = employees?.find((item) => item.id === row.employeeId);
  return language === 'en' ? employee?.nameEn ?? row.employeeNameAr : row.employeeNameAr;
}

export function PayrollSettlementsTab() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [employeeId, setEmployeeId] = useState<string>();
  const [status, setStatus] = useState<PayrollSettlementDtoStatus>();
  const [selectedId, setSelectedId] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [createForm] = Form.useForm<{ employeeId: string }>();
  const [paymentForm] = Form.useForm<PaymentForm>();
  const [reverseForm] = Form.useForm<ReverseForm>();
  const paymentSourceType = (Form.useWatch('sourceType', paymentForm) as PaymentForm['sourceType'] | undefined) ?? 'cash';
  const employees = useQuery({
    queryKey: ['payroll', 'employees'],
    queryFn: async () => (await payrollControllerListEmployees()).data,
  });
  const settlements = useQuery({
    queryKey: ['payroll', 'settlements', employeeId, status],
    queryFn: async () => (await payrollSettlementControllerList({ employeeId, status })).data,
  });
  const cashBoxes = useQuery({
    queryKey: ['payroll', 'cashBoxes'],
    queryFn: async () => (await treasuryControllerListCashBoxes()).data,
  });
  const bankAccounts = useQuery({
    queryKey: ['payroll', 'bankAccounts'],
    queryFn: async () => (await treasuryControllerListBankAccounts()).data,
  });
  const selected = settlements.data?.find((row) => row.id === selectedId);
  const eligibleEmployees = settlementEligibleEmployees(employees.data ?? []);
  const sourceOptions = paymentSourceType === 'cash'
    ? (cashBoxes.data ?? []).map((row) => ({ value: row.id, label: row.name }))
    : (bankAccounts.data ?? []).map((row) => {
      const identifier = row.accountNoMasked || row.ibanMasked;
      return { value: row.id, label: identifier ? `${row.bankName} — ${identifier}` : row.bankName };
    });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['payroll', 'settlements'] });
  const showError = () => message.error(t('payroll.saveError'));
  const create = useMutation({
    mutationFn: async (values: { employeeId: string }) =>
      payrollSettlementControllerCreate({ employeeId: values.employeeId }),
    onSuccess: (result) => {
      setEmployeeId(result.data.employeeId);
      setStatus(undefined);
      setSelectedId(result.data.id);
      setCreateOpen(false);
      createForm.resetFields();
      message.success(t('payroll.settlementCreated'));
      invalidate();
    },
    onError: showError,
  });
  const recompute = useMutation({
    mutationFn: (id: string) => payrollSettlementControllerRecompute(id),
    onSuccess: () => {
      message.success(t('payroll.settlementRecomputed'));
      invalidate();
    },
    onError: showError,
  });
  const post = useMutation({
    mutationFn: (id: string) => payrollSettlementControllerPost(id, { headers: idemHeaders() }),
    onSuccess: () => {
      message.success(t('payroll.settlementPosted'));
      invalidate();
    },
    onError: showError,
  });
  const pay = useMutation({
    mutationFn: ({ id, values }: { id: string; values: PaymentForm }) =>
      payrollSettlementControllerPay(id, {
        paymentDate: dateOnly(values.paymentDate)!,
        ...(values.sourceType === 'cash' ? { cashBoxId: values.sourceId } : { bankAccountId: values.sourceId }),
      }, { headers: idemHeaders() }),
    onSuccess: () => {
      setPaymentOpen(false);
      message.success(t('payroll.settlementPaid'));
      invalidate();
    },
    onError: showError,
  });
  const reverse = useMutation({
    mutationFn: ({ id, values }: { id: string; values: ReverseForm }) =>
      payrollSettlementControllerReverse(id, { reversalDate: dateOnly(values.reversalDate)! }, { headers: idemHeaders() }),
    onSuccess: () => {
      setReverseOpen(false);
      message.success(t('payroll.settlementReversed'));
      invalidate();
    },
    onError: showError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => payrollSettlementControllerDelete(id),
    onSuccess: () => {
      setSelectedId(undefined);
      message.success(t('payroll.settlementDraftDeleted'));
      invalidate();
    },
    onError: showError,
  });
  const openPayment = () => {
    paymentForm.resetFields();
    paymentForm.setFieldsValue({ paymentDate: dayjs(), sourceType: 'cash' });
    setPaymentOpen(true);
  };
  const openReverse = () => {
    reverseForm.resetFields();
    reverseForm.setFieldsValue({ reversalDate: dayjs() });
    setReverseOpen(true);
  };
  const statusOptions = (['DRAFT', 'POSTED', 'PAID', 'REVERSED'] as const)
    .map((value) => ({ value, label: t(`payroll.${value.toLowerCase()}`) }));

  return <>
    <Space wrap style={{ marginBottom: 12 }}>
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        value={employeeId}
        onChange={setEmployeeId}
        placeholder={t('payroll.employee')}
        options={employeeOptions(employees.data, i18n.language)}
      />
      <Select
        allowClear
        value={status}
        onChange={setStatus}
        placeholder={t('payroll.status')}
        options={statusOptions}
      />
      {can(PERMISSIONS.PAYROLL_MANAGE) && (
        <Button type="primary" onClick={() => { createForm.resetFields(); setCreateOpen(true); }}>
          {t('payroll.createSettlement')}
        </Button>
      )}
    </Space>
    <Table
      rowKey="id"
      loading={settlements.isLoading}
      dataSource={settlements.data}
      columns={[
        { title: t('payroll.employee'), render: (_: unknown, row: PayrollSettlementDto) => employeeName(row, employees.data, i18n.language) },
        { title: t('payroll.settlementNo'), dataIndex: 'settlementNo' },
        { title: t('payroll.settlementDate'), dataIndex: 'settlementDate', render: (value: string) => dayjs(value).format('DD/MM/YYYY') },
        { title: t('payroll.status'), dataIndex: 'status', render: (value: PayrollSettlementDtoStatus) => <Tag>{t(`payroll.${value.toLowerCase()}`)}</Tag> },
        { title: t('payroll.settlementEosAmount'), dataIndex: 'eosAmount', render: (value: string) => formatAmount(value) },
        { title: t('payroll.settlementNet'), dataIndex: 'net', render: (value: string) => formatAmount(value) },
        { title: '', render: (_: unknown, row: PayrollSettlementDto) => (
          <Button onClick={() => setSelectedId(row.id)}>{t('payroll.viewSettlement')}</Button>
        ) },
      ]}
     scroll={{ x: 'max-content' }}/>
    {selected && <>
      <Descriptions
        bordered
        size="small"
        column={{ xs: 1, sm: 2, md: 3 }}
        style={{ marginTop: 16 }}
        items={[
          { key: 'status', label: t('payroll.status'), children: <Tag>{t(`payroll.${selected.status.toLowerCase()}`)}</Tag> },
          { key: 'number', label: t('payroll.settlementNo'), children: selected.settlementNo ?? '—' },
          { key: 'date', label: t('payroll.settlementDate'), children: dayjs(selected.settlementDate).format('DD/MM/YYYY') },
          { key: 'years', label: t('payroll.settlementServiceYears'), children: formatAmount(selected.serviceYears) },
          { key: 'before2010', label: t('payroll.settlementServiceBefore2010'), children: String(selected.serviceDaysBefore2010) },
          { key: '2010to2014', label: t('payroll.settlementService2010To2014'), children: String(selected.serviceDays2010To2014) },
          { key: 'from2015', label: t('payroll.settlementServiceFrom2015'), children: String(selected.serviceDaysFrom2015) },
          { key: 'wage', label: t('payroll.settlementLastWage'), children: formatAmount(selected.lastWage) },
          { key: 'eos', label: t('payroll.settlementEosAmount'), children: formatAmount(selected.eosAmount) },
          { key: 'taxable', label: t('payroll.settlementTaxableAmount'), children: formatAmount(selected.taxableAmount) },
          { key: 'tax', label: t('payroll.settlementEosTax'), children: formatAmount(selected.eosTax) },
          { key: 'national', label: t('payroll.settlementNationalContribution'), children: formatAmount(selected.nationalContribution) },
          { key: 'provision', label: t('payroll.settlementProvisionUsed'), children: formatAmount(selected.provisionUsed) },
          { key: 'net', label: t('payroll.settlementNet'), children: formatAmount(selected.net) },
        ]}
      />
      <Space wrap style={{ marginTop: 12 }}>
        {selected.status === 'DRAFT' && can(PERMISSIONS.PAYROLL_MANAGE) && (
          <>
            <Button loading={recompute.isPending} onClick={() => recompute.mutate(selected.id)}>{t('payroll.recomputeSettlement')}</Button>
            <Popconfirm title={t('payroll.confirmDeleteSettlement')} onConfirm={() => remove.mutate(selected.id)}>
              <Button danger icon={<DeleteOutlined />} loading={remove.isPending}>{t('payroll.deleteSettlement')}</Button>
            </Popconfirm>
          </>
        )}
        {selected.status === 'DRAFT' && can(PERMISSIONS.PAYROLL_POST) && (
          <Button type="primary" loading={post.isPending} onClick={() => post.mutate(selected.id)}>{t('payroll.postSettlement')}</Button>
        )}
        {selected.status === 'POSTED' && can(PERMISSIONS.PAYROLL_POST) && (
          <Button type="primary" onClick={openPayment}>{t('payroll.paySettlement')}</Button>
        )}
        {(selected.status === 'POSTED' || selected.status === 'PAID') && can(PERMISSIONS.PAYROLL_POST) && (
          <Button danger onClick={openReverse}>{t('payroll.reverseSettlement')}</Button>
        )}
      </Space>
    </>}
    <FormDialog
      open={createOpen}
      title={t('payroll.createSettlement')}
      onCancel={() => setCreateOpen(false)}
      onSave={() => void createForm.submit()}
      saving={create.isPending}
    >
      <Form form={createForm} layout="vertical" onFinish={(values) => create.mutate(values)}>
        <Form.Item name="employeeId" label={t('payroll.employee')} rules={[{ required: true }]}>
          <GridSelect options={employeeOptions(eligibleEmployees, i18n.language)} />
        </Form.Item>
      </Form>
    </FormDialog>
    <FormDialog
      open={paymentOpen}
      title={t('payroll.paySettlement')}
      onCancel={() => setPaymentOpen(false)}
      onSave={() => void paymentForm.submit()}
      saving={pay.isPending}
      width={620}
    >
      <Form form={paymentForm} layout="vertical" onFinish={(values) => selected && pay.mutate({ id: selected.id, values })}>
        <Form.Item name="paymentDate" label={t('payroll.settlementPaymentDate')} rules={[{ required: true }]}>
          <DatePicker />
        </Form.Item>
        <Form.Item name="sourceType" label={t('payroll.paymentSourceType')} rules={[{ required: true }]}>
          <Select
            options={[
              { value: 'cash', label: t('payroll.cash') },
              { value: 'bank', label: t('payroll.bank') },
            ]}
            onChange={() => paymentForm.setFieldValue('sourceId', undefined)}
          />
        </Form.Item>
        <Form.Item name="sourceId" label={t('payroll.paymentAccount')} rules={[{ required: true }]}>
          <Select options={sourceOptions} />
        </Form.Item>
      </Form>
    </FormDialog>
    <FormDialog
      open={reverseOpen}
      title={t('payroll.reverseSettlement')}
      onCancel={() => setReverseOpen(false)}
      onSave={() => void reverseForm.submit()}
      saving={reverse.isPending}
    >
      <Form form={reverseForm} layout="vertical" onFinish={(values) => selected && reverse.mutate({ id: selected.id, values })}>
        <Form.Item name="reversalDate" label={t('payroll.settlementReversalDate')} rules={[{ required: true }]}>
          <DatePicker />
        </Form.Item>
      </Form>
    </FormDialog>
  </>;
}
