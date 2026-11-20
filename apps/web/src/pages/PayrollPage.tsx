import { DeleteOutlined, FilePdfOutlined, PlusOutlined } from '@ant-design/icons';
import {
  payrollControllerAddSalary,
  payrollControllerCreateEmployee,
  payrollControllerCreateElement,
  payrollControllerCreateInput,
  payrollControllerCreateRun,
  payrollControllerCreateSettings,
  payrollControllerDeleteInput,
  payrollControllerDeleteRecurring,
  payrollControllerGetEmployee,
  payrollControllerGetRun,
  payrollControllerListEmployees,
  payrollControllerListElements,
  payrollControllerListInputs,
  payrollControllerListRuns,
  payrollControllerListSettings,
  payrollControllerPayRun,
  payrollControllerPostRun,
  payrollControllerReverseRun,
  payrollControllerSetIncomeTax,
  payrollControllerUpdateElement,
  payrollControllerUpdateEmployee,
  accountingControllerListAccounts,
  payrollControllerCreateRecurring,
  payrollControllerDeleteRun,
  treasuryControllerListBankAccounts,
  treasuryControllerListCashBoxes,
  costCentersControllerList,
  apiFetchBlob,
  type PayrollEmployeeDto,
  type PayrollEmployeeDetailDto,
  type PayrollElementDto,
  type PayrollRunDto,
  type CashBoxListItemDto,
  type BankAccountListItemDto,
} from '@erp/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, DatePicker as AntDatePicker, Form, Input, Radio, Select, Space, Switch, Table, Tabs } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { formatAmount, formatQty } from '../format/number';
import { DatePicker } from '../components/DatePicker';
import { ExportButtons, saveBlob } from '../components/ExportButtons';
import { EnterNav } from '../components/EnterNav';
import { FormDialog, FormSection } from '../components/FormDialog';
import { GridSelect } from '../components/GridSelect';

type DateFormValue = Dayjs | string | null | undefined;
type EmployeeForm = {
  code: string; nameAr: string; nameEn?: string | null; hireDate: DateFormValue; payMethod: 'BANK' | 'CASH';
  branchId?: string | null; costCenterId?: string | null; sscCovered?: boolean; sscHazardous?: boolean;
  nationalId?: string | null; sscNumber?: string | null; leaveDate?: DateFormValue; iban?: string | null; isActive?: boolean;
  salaryEffectiveFrom?: DateFormValue; basicSalary?: string; payElementId?: string; recurringAmount?: string;
  recurringQuantity?: string; recurringValidFrom?: DateFormValue;
};
type InputForm = { employeeId: string; payElementId: string; period: string; workDate?: DateFormValue; quantity?: string; amount?: string; note?: string };

export function dateOnly(value: DateFormValue): string | undefined {
  if (value == null || value === '') return undefined;
  return dayjs.isDayjs(value) ? value.format('YYYY-MM-DD') : value.slice(0, 10);
}

export function monthToPayrollPeriod(value: Dayjs | null) {
  return value?.format('YYYY-MM');
}

function PayrollMonthPicker({ period, onChange }: { period: string; onChange: (period: string) => void }) {
  return (
    <AntDatePicker
      picker="month"
      format="MM/YYYY"
      value={dayjs(`${period}-01`)}
      onChange={(month) => {
        const nextPeriod = monthToPayrollPeriod(month);
        if (nextPeriod) onChange(nextPeriod);
      }}
    />
  );
}

export function datePickerValue(value?: string | null) {
  return value ? dayjs(value.slice(0, 10)) : undefined;
}

export function employeeEditDateValues(employee: Pick<PayrollEmployeeDetailDto, 'hireDate' | 'leaveDate'>) {
  return {
    hireDate: datePickerValue(employee.hireDate),
    leaveDate: datePickerValue(employee.leaveDate),
  };
}

export function buildSettingsPayload(values: Record<string, unknown> & { effectiveFrom?: DateFormValue }) {
  return { ...values, effectiveFrom: dateOnly(values.effectiveFrom)! };
}

export function buildElementPayload(values: Record<string, unknown>, editing: boolean) {
  if (editing) {
    const { code: _code, ...update } = values;
    return update;
  }
  const { isActive: _isActive, ...create } = values;
  return create;
}

export function buildPaymentSourceOptions(
  sourceType: 'cash' | 'bank',
  cashBoxes: Array<Pick<CashBoxListItemDto, 'id' | 'name'>>,
  bankAccounts: Array<Pick<BankAccountListItemDto, 'id' | 'bankName' | 'accountNoMasked' | 'ibanMasked'>>,
) {
  if (sourceType === 'cash') return cashBoxes.map(({ id, name }) => ({ value: id, label: name }));
  return bankAccounts.map(({ id, bankName, accountNoMasked, ibanMasked }) => {
    const identifier = accountNoMasked || ibanMasked;
    return { value: id, label: identifier ? `${bankName} — ${identifier}` : bankName };
  });
}

export function buildEmployeePayload(values: EmployeeForm, editing = false) {
  const { salaryEffectiveFrom: _salaryDate, basicSalary: _salary, payElementId: _element, recurringAmount: _amount, recurringQuantity: _quantity, recurringValidFrom: _validFrom, ...card } = values;
  const nullable = (value?: string | null) => editing && (value == null || value === '') ? null : value;
  return {
    ...card,
    hireDate: dateOnly(card.hireDate)!,
    nameEn: nullable(card.nameEn),
    nationalId: nullable(card.nationalId),
    sscNumber: nullable(card.sscNumber),
    leaveDate: editing ? dateOnly(card.leaveDate) ?? null : dateOnly(card.leaveDate),
    branchId: nullable(card.branchId),
    costCenterId: nullable(card.costCenterId),
    iban: nullable(card.iban),
    sscCovered: card.sscCovered ?? true,
    sscHazardous: card.sscHazardous ?? false,
  };
}

export function buildInputPayload(values: InputForm, amountType: string, daily: boolean) {
  return {
    employeeId: values.employeeId,
    payElementId: values.payElementId,
    period: values.period,
    ...(daily && values.workDate ? { workDate: dateOnly(values.workDate)! } : {}),
    ...(amountType === 'FIXED' ? { amount: values.amount } : { quantity: values.quantity }),
    ...(values.note ? { note: values.note } : {}),
  };
}

export function runAvailability(status: string) {
  return { taxEditable: status === 'DRAFT', canPost: status === 'DRAFT', canPay: status === 'POSTED', canReverse: status === 'POSTED' || status === 'PAID' };
}

export function payrollTabSearchParams(current: URLSearchParams, tab: string) {
  const next = new URLSearchParams(current);
  next.set('tab', tab);
  return next;
}

function usePayrollData() {
  const employees = useQuery({ queryKey: ['payroll', 'employees'], queryFn: async () => (await payrollControllerListEmployees()).data });
  const elements = useQuery({ queryKey: ['payroll', 'elements'], queryFn: async () => (await payrollControllerListElements()).data });
  return { employees, elements };
}

function EmployeesTab() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const { can, me } = useAuth();
  const { employees, elements } = usePayrollData();
  const costCenters = useQuery({ queryKey: ['payroll', 'costCenters'], queryFn: async () => (await costCentersControllerList()).data });
  const branchOptions = me?.currentMembership?.branches.map((branch) => ({
    value: branch.id, label: i18n.language === 'en' ? branch.nameEn ?? branch.nameAr : branch.nameAr,
  })) ?? [];
  const costCenterOptions = (costCenters.data ?? []).filter((row) => row.isActive && row.isPostable)
    .map((row) => ({ value: row.id, label: `${row.code} — ${i18n.language === 'en' ? row.nameEn ?? row.nameAr : row.nameAr}` }));
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PayrollEmployeeDto>();
  const [detail, setDetail] = useState<PayrollEmployeeDetailDto>();
  const [form] = Form.useForm<EmployeeForm>();
  const recurringElementId = Form.useWatch('payElementId', form);
  const recurringElement = (elements.data as PayrollElementDto[] | undefined)?.find((element) => element.id === recurringElementId);
  const save = useMutation({
    mutationFn: async (values: EmployeeForm) => {
      const card = buildEmployeePayload(values, Boolean(editing));
      if (editing) await payrollControllerUpdateEmployee(editing.id, card);
      else await payrollControllerCreateEmployee(card as never);
      let id = editing?.id;
      if (!id) {
        const created = await payrollControllerListEmployees();
        id = (created.data as PayrollEmployeeDto[]).find((employee) => employee.code === values.code)?.id;
      }
      if (id && values.basicSalary && values.salaryEffectiveFrom) {
        await payrollControllerAddSalary(id, { effectiveFrom: dateOnly(values.salaryEffectiveFrom)!, basicSalary: values.basicSalary });
      }
      if (id && values.payElementId && values.recurringValidFrom) {
        await payrollControllerCreateRecurring(id, {
          payElementId: values.payElementId,
          ...(recurringElement?.amountType === 'FIXED' ? { amount: values.recurringAmount } : { quantity: values.recurringQuantity }),
          validFrom: dateOnly(values.recurringValidFrom)!,
        } as never);
      }
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['payroll'] }); setOpen(false); },
    onError: () => message.error(t('payroll.saveError')),
  });
  const start = async (employee?: PayrollEmployeeDto) => {
    setEditing(employee);
    if (employee) {
      const employeeDetail = (await payrollControllerGetEmployee(employee.id)).data;
      setDetail(employeeDetail);
      form.resetFields();
      form.setFieldsValue({
        code: employeeDetail.code, nameAr: employeeDetail.nameAr, nameEn: employeeDetail.nameEn ?? undefined,
        ...employeeEditDateValues(employeeDetail),
        payMethod: employeeDetail.payMethod as 'BANK' | 'CASH', nationalId: employeeDetail.nationalId ?? undefined,
        sscNumber: employeeDetail.sscNumber ?? undefined, iban: employeeDetail.iban ?? undefined,
        branchId: employeeDetail.branchId ?? undefined, costCenterId: employeeDetail.costCenterId ?? undefined,
        sscCovered: employeeDetail.sscCovered, sscHazardous: employeeDetail.sscHazardous, isActive: employeeDetail.isActive,
      });
    } else { setDetail(undefined); form.resetFields(); }
    setOpen(true);
  };
  return <>
    <Space style={{ marginBottom: 12 }}>{can(PERMISSIONS.PAYROLL_MANAGE) && <Button type="primary" icon={<PlusOutlined />} onClick={() => void start()}>{t('payroll.addEmployee')}</Button>}</Space>
    <Table rowKey="id" loading={employees.isLoading} dataSource={employees.data as PayrollEmployeeDto[] | undefined} onRow={(row) => ({ onDoubleClick: () => void start(row) })} columns={[
      { title: t('payroll.code'), dataIndex: 'code' },
      { title: t('payroll.employee'), render: (_, row: PayrollEmployeeDto) => i18n.language === 'en' ? row.nameEn ?? row.nameAr : row.nameAr },
      { title: t('payroll.branch'), render: (_, row: PayrollEmployeeDto) => i18n.language === 'en' ? row.branchNameEn ?? row.branchNameAr : row.branchNameAr },
      { title: t('payroll.basicSalary'), dataIndex: 'currentBasicSalary', render: (v: string | null) => formatAmount(v) },
      { title: t('payroll.sscCovered'), dataIndex: 'sscCovered', render: (v: boolean) => v ? t('common.yes') : t('common.no') },
      { title: t('payroll.active'), dataIndex: 'isActive', render: (v: boolean) => v ? t('common.yes') : t('common.no') },
      { title: '', render: (_, row) => can(PERMISSIONS.PAYROLL_MANAGE) && <Button onClick={() => void start(row)}>{t('payroll.editEmployee')}</Button> },
    ]} />
    <FormDialog open={open} title={editing ? t('payroll.editEmployee') : t('payroll.addEmployee')} onCancel={() => setOpen(false)} onSave={() => void form.submit()} saving={save.isPending}>
      <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
        <FormSection title={t('payroll.employee')}>
          <Form.Item name="code" label={t('payroll.code')} rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="nameAr" label={t('payroll.nameAr')} rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="nameEn" label={t('payroll.nameEn')}><Input /></Form.Item>
          <Form.Item name="nationalId" label={t('payroll.nationalId')}><Input /></Form.Item>
          <Form.Item name="sscNumber" label={t('payroll.sscNumber')}><Input /></Form.Item>
          <Form.Item name="hireDate" label={t('payroll.hireDate')} rules={[{ required: true }]}><DatePicker /></Form.Item>
          <Form.Item name="leaveDate" label={t('payroll.leaveDate')}><DatePicker /></Form.Item>
          <Form.Item name="payMethod" label={t('payroll.payMethod')} rules={[{ required: true }]}><Select options={['BANK', 'CASH'].map((v) => ({ value: v, label: t(`payroll.${v.toLowerCase()}`) }))} /></Form.Item>
          <Form.Item name="branchId" label={t('payroll.branch')}><GridSelect allowClear options={branchOptions} /></Form.Item>
          <Form.Item name="costCenterId" label={t('payroll.costCenter')}><GridSelect allowClear options={costCenterOptions} /></Form.Item>
          <Form.Item name="iban" label={t('payroll.iban')}><Input /></Form.Item>
        <Form.Item name="sscCovered" label={t('payroll.sscCovered')} valuePropName="checked" initialValue={true}><Switch /></Form.Item>
          <Form.Item name="sscHazardous" label={t('payroll.sscHazardous')} valuePropName="checked"><Switch /></Form.Item>
          {editing && <Form.Item name="isActive" label={t('payroll.active')} valuePropName="checked"><Switch /></Form.Item>}
        </FormSection>
        <FormSection title={t('payroll.salaryHistory')}>
          <Form.Item name="salaryEffectiveFrom" label={t('payroll.effectiveFrom')}><DatePicker /></Form.Item>
          <Form.Item name="basicSalary" label={t('payroll.basicSalary')}><Input /></Form.Item>
          <Space direction="vertical">{detail?.salaries.map((salary) => <span key={salary.id}>{dateOnly(salary.effectiveFrom)}: {formatAmount(salary.basicSalary)}</span>)}</Space>
        </FormSection>
        <FormSection title={t('payroll.recurring')}>
          <Form.Item name="payElementId" label={t('payroll.element')}><Select options={(elements.data as PayrollElementDto[] | undefined)?.map((e) => ({ value: e.id, label: i18n.language === 'en' ? e.nameEn ?? e.nameAr : e.nameAr }))} /></Form.Item>
          <Form.Item name="recurringValidFrom" label={t('payroll.effectiveFrom')} rules={[{ required: Boolean(recurringElementId) }]}><DatePicker /></Form.Item>
          {recurringElement?.amountType === 'FIXED'
            ? <Form.Item name="recurringAmount" label={t('payroll.amount')} rules={[{ required: Boolean(recurringElementId) }]}><Input /></Form.Item>
            : <Form.Item name="recurringQuantity" label={t('payroll.quantity')} rules={[{ required: Boolean(recurringElementId) }]}><Input /></Form.Item>}
          {detail?.recurringElements.map((recurring) => <Space key={recurring.id}>
            <span>{i18n.language === 'en' ? recurring.payElement.nameEn ?? recurring.payElement.nameAr : recurring.payElement.nameAr} — {recurring.amount !== null ? formatAmount(recurring.amount) : formatQty(recurring.quantity)} · {dateOnly(recurring.validFrom)} – {dateOnly(recurring.validTo) ?? '—'}</span>
            <Button danger title={t('common.delete')} icon={<DeleteOutlined />} onClick={() => void payrollControllerDeleteRecurring(editing!.id, recurring.id)
              .then(async () => {
                setDetail((await payrollControllerGetEmployee(editing!.id)).data);
                void queryClient.invalidateQueries({ queryKey: ['payroll'] });
              }).catch(() => message.error(t('payroll.saveError')))} />
          </Space>)}
        </FormSection>
      </Form>
    </FormDialog>
  </>;
}

function ElementsTab() {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const { message } = App.useApp();
  const { can } = useAuth();
  const { elements } = usePayrollData();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: async () => (await accountingControllerListAccounts()).data });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PayrollElementDto>();
  const [form] = Form.useForm();
  const kind = Form.useWatch('kind', form) as string | undefined;
  const accountOptions = (accounts.data ?? []).filter((account) =>
    account.isActive && account.isPostable && !account.isControl && account.controlType === null &&
    (kind === 'EARNING' ? account.accountType === 'EXPENSE' : account.accountType === 'ASSET' || account.accountType === 'LIABILITY'),
  ).map((account) => ({ value: account.id, label: `${account.code} — ${i18n.language === 'en' ? account.nameEn ?? account.nameAr : account.nameAr}` }));
  const save = useMutation({ mutationFn: async (value: Record<string, unknown>) => {
    const payload = buildElementPayload(value, Boolean(editing));
    if (editing) await payrollControllerUpdateElement(editing.id, payload as never);
    else await payrollControllerCreateElement(payload as never);
  }, onSuccess: () => { void client.invalidateQueries({ queryKey: ['payroll', 'elements'] }); setOpen(false); }, onError: () => message.error(t('payroll.saveError')) });
  return <>
    {can(PERMISSIONS.PAYROLL_MANAGE) && <Button type="primary" icon={<PlusOutlined />} onClick={() => { setEditing(undefined); form.resetFields(); setOpen(true); }}>{t('payroll.addElement')}</Button>}
    <Table rowKey="id" dataSource={elements.data as PayrollElementDto[] | undefined} onRow={(row) => ({ onDoubleClick: () => { setEditing(row); form.setFieldsValue(row); setOpen(true); } })} columns={[
      { title: t('payroll.code'), dataIndex: 'code' },
      { title: t('payroll.element'), render: (_, row: PayrollElementDto) => i18n.language === 'en' ? row.nameEn ?? row.nameAr : row.nameAr },
      { title: t('payroll.kind'), dataIndex: 'kind', render: (v: string) => t(`payroll.${v.toLowerCase()}`) },
      { title: t('payroll.amountType'), dataIndex: 'amountType', render: (v: string) => t(`payroll.${v === 'PER_HOUR' ? 'perHour' : v === 'PER_DAY' ? 'perDay' : 'fixed'}`) },
      { title: t('payroll.factor'), dataIndex: 'rateFactor', render: (v: string) => formatQty(v) },
      { title: t('payroll.sscSubject'), dataIndex: 'sscSubject', render: (v: boolean) => v ? t('common.yes') : t('common.no') },
      { title: t('payroll.account'), dataIndex: 'accountId', render: (id: string) => {
        const account = accounts.data?.find((row) => row.id === id);
        return account ? `${account.code} — ${i18n.language === 'en' ? account.nameEn ?? account.nameAr : account.nameAr}` : id;
      } },
      { title: t('payroll.active'), dataIndex: 'isActive', render: (v: boolean) => v ? t('common.yes') : t('common.no') },
      { title: '', render: (_, row) => can(PERMISSIONS.PAYROLL_MANAGE) && <Button onClick={() => { setEditing(row); form.setFieldsValue(row); setOpen(true); }}>{t('payroll.editElement')}</Button> },
    ]} />
    <FormDialog open={open} title={editing ? t('payroll.editElement') : t('payroll.addElement')} onCancel={() => setOpen(false)} onSave={() => void form.submit()} saving={save.isPending}>
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}><FormSection title={t('payroll.element')}>
        {(['code', 'nameAr', 'nameEn', 'rateFactor'] as const).map((field) => <Form.Item key={field} name={field} label={t(`payroll.${field}`)} rules={[{ required: field !== 'nameEn' && !(editing && field === 'code') }]}><Input disabled={Boolean(editing && field === 'code')} /></Form.Item>)}
        <Form.Item name="kind" label={t('payroll.kind')} initialValue="EARNING"><Select options={['EARNING', 'DEDUCTION'].map((v) => ({ value: v, label: t(`payroll.${v.toLowerCase()}`) }))} /></Form.Item>
        <Form.Item name="amountType" label={t('payroll.amountType')} initialValue="FIXED"><Select options={['FIXED', 'PER_HOUR', 'PER_DAY'].map((v) => ({ value: v, label: t(`payroll.${v === 'PER_HOUR' ? 'perHour' : v === 'PER_DAY' ? 'perDay' : 'fixed'}`) }))} /></Form.Item>
        <Form.Item name="accountId" label={t('payroll.account')} rules={[{ required: true }]}><GridSelect options={accountOptions} /></Form.Item>
        <Form.Item name="sscSubject" label={t('payroll.sscSubject')} valuePropName="checked" initialValue={true}><Switch /></Form.Item>
        {editing && <Form.Item name="isActive" label={t('payroll.active')} valuePropName="checked"><Switch /></Form.Item>}
      </FormSection></Form>
    </FormDialog>
  </>;
}

function InputsTab() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { can } = useAuth();
  const { employees, elements } = usePayrollData();
  const [period, setPeriod] = useState(dayjs().format('YYYY-MM'));
  const [employeeId, setEmployeeId] = useState<string>();
  const [payElementId, setPayElementId] = useState<string>();
  const [daily, setDaily] = useState(false);
  const [form] = Form.useForm<InputForm>();
  const inputs = useQuery({ queryKey: ['payroll', 'inputs', period, employeeId], queryFn: async () => (await payrollControllerListInputs({ period, employeeId })).data });
  const selected = (elements.data as PayrollElementDto[] | undefined)?.find((e) => e.id === payElementId);
  const save = useMutation({ mutationFn: (values: InputForm) => payrollControllerCreateInput(buildInputPayload(values, selected?.amountType ?? 'FIXED', daily) as never), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['payroll', 'inputs'] }); form.resetFields(); }, onError: () => message.error(t('payroll.saveError')) });
  const remove = useMutation({
    mutationFn: (id: string) => payrollControllerDeleteInput(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['payroll', 'inputs'] }),
    onError: () => message.error(t('payroll.saveError')),
  });
  return <>
    <Space wrap style={{ marginBottom: 12 }}>
      <PayrollMonthPicker period={period} onChange={setPeriod} />
      <Select allowClear placeholder={t('payroll.employee')} value={employeeId} onChange={setEmployeeId} options={(employees.data as PayrollEmployeeDto[] | undefined)?.map((e) => ({ value: e.id, label: `${e.code} — ${i18n.language === 'en' ? e.nameEn ?? e.nameAr : e.nameAr}` }))} />
      <Radio.Group value={daily} onChange={(e) => setDaily(e.target.value)} options={[{ value: false, label: t('payroll.monthlyTotal') }, { value: true, label: t('payroll.dailyDate') }]} />
    </Space>
    {can(PERMISSIONS.PAYROLL_MANAGE) && <EnterNav><Form form={form} layout="inline" onFinish={(v) => save.mutate({ ...v, period })}>
      <Form.Item name="employeeId" rules={[{ required: true }]}><Select placeholder={t('payroll.employee')} options={(employees.data as PayrollEmployeeDto[] | undefined)?.map((e) => ({ value: e.id, label: i18n.language === 'en' ? e.nameEn ?? e.nameAr : e.nameAr }))} /></Form.Item>
      <Form.Item name="payElementId" rules={[{ required: true }]}><Select placeholder={t('payroll.element')} onChange={setPayElementId} options={(elements.data as PayrollElementDto[] | undefined)?.map((e) => ({ value: e.id, label: i18n.language === 'en' ? e.nameEn ?? e.nameAr : e.nameAr }))} /></Form.Item>
      {daily && <Form.Item name="workDate" rules={[{ required: true }]}><DatePicker /></Form.Item>}
      <Form.Item name={selected?.amountType === 'FIXED' ? 'amount' : 'quantity'} rules={[{ required: true }]}><Input placeholder={t(selected?.amountType === 'FIXED' ? 'payroll.amount' : 'payroll.quantity')} /></Form.Item>
      <Button htmlType="submit" type="primary" loading={save.isPending}>{t('common.save')}</Button>
    </Form></EnterNav>}
    <Table rowKey="id" dataSource={inputs.data as Array<{ id: string; amount?: string; quantity?: string; workDate?: string; payElement?: { nameAr: string }; employee?: { nameAr: string } }> | undefined} columns={[
      { title: t('payroll.employee'), render: (_, r) => r.employee?.nameAr }, { title: t('payroll.element'), render: (_, r) => r.payElement?.nameAr },
      { title: t('payroll.workDate'), dataIndex: 'workDate', render: (value?: string | null) => dateOnly(value) ?? '—' },
      { title: t('payroll.amount'), dataIndex: 'amount', render: (v: string | null) => formatAmount(v) },
      { title: t('payroll.quantity'), dataIndex: 'quantity', render: (v: string | null) => formatQty(v) },
      { title: '', render: (_, r) => can(PERMISSIONS.PAYROLL_MANAGE) && <Button danger title={t('common.delete')} icon={<DeleteOutlined />} onClick={() => remove.mutate(r.id)} /> },
    ]} />
  </>;
}

function RunsTab({ createOnLoad = false }: { createOnLoad?: boolean }) {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['payroll', 'runs'], queryFn: async () => (await payrollControllerListRuns()).data });
  const [runId, setRunId] = useState<string>();
  const run = useQuery({ queryKey: ['payroll', 'run', runId], queryFn: async () => runId ? (await payrollControllerGetRun(runId)).data : undefined, enabled: Boolean(runId) });
  const [period, setPeriod] = useState(dayjs().format('YYYY-MM'));
  const [sourceType, setSourceType] = useState<'cash' | 'bank'>('cash');
  const [sourceId, setSourceId] = useState<string>();
  const cashBoxes = useQuery({ queryKey: ['payroll', 'cashBoxes'], queryFn: async () => (await treasuryControllerListCashBoxes()).data });
  const bankAccounts = useQuery({ queryKey: ['payroll', 'bankAccounts'], queryFn: async () => (await treasuryControllerListBankAccounts()).data });
  const sourceOptions = buildPaymentSourceOptions(
    sourceType,
    (cashBoxes.data ?? []) as Array<Pick<CashBoxListItemDto, 'id' | 'name'>>,
    (bankAccounts.data ?? []) as Array<Pick<BankAccountListItemDto, 'id' | 'bankName' | 'accountNoMasked' | 'ibanMasked'>>,
  );
  const create = useMutation({ mutationFn: () => payrollControllerCreateRun({ period }), onSuccess: (r) => { setRunId(r.data.id); void qc.invalidateQueries({ queryKey: ['payroll', 'runs'] }); }, onError: () => message.error(t('payroll.saveError')) });
  const { mutate: createRun } = create;
  const createdFromQuickAction = useRef(false);
  useEffect(() => {
    if (!createOnLoad) {
      createdFromQuickAction.current = false;
      return;
    }
    if (createOnLoad && can(PERMISSIONS.PAYROLL_MANAGE) && !createdFromQuickAction.current) {
      createdFromQuickAction.current = true;
      createRun();
    }
  }, [createOnLoad, can, createRun]);
  const mutate = useMutation({ mutationFn: async (action: string) => {
    if (!runId) return;
    const options = { headers: { 'Idempotency-Key': crypto.randomUUID() } };
    if (action === 'post') await payrollControllerPostRun(runId, options);
    if (action === 'pay' && sourceId) await payrollControllerPayRun(runId, {
      date: dateOnly(dayjs())!, ...(sourceType === 'cash' ? { cashBoxId: sourceId } : { bankAccountId: sourceId }),
    }, options);
    if (action === 'reverse') await payrollControllerReverseRun(runId, { date: dateOnly(dayjs())! }, options);
    if (action === 'recompute') await (await import('@erp/api-client')).payrollControllerRecomputeRun(runId);
    if (action === 'delete') await payrollControllerDeleteRun(runId);
  }, onSuccess: (_result, action) => { if (action === 'delete') setRunId(undefined); void qc.invalidateQueries({ queryKey: ['payroll'] }); }, onError: () => message.error(t('payroll.saveError')) });
  const data = run.data as (PayrollRunDto & { lines?: Array<{ id: string; employeeName: string; basic: string; earnings: string; gross: string; sscBase: string; sscEmployee: string; sscEmployer: string; incomeTax: string; deductions: string; net: string }> }) | undefined;
  const available = runAvailability(data?.status ?? '');
  const printPayslip = async (lineId: string) => {
    const preview = window.open('about:blank', '_blank');
    try {
      const file = await apiFetchBlob(`/payroll/runs/${data!.id}/lines/${lineId}/payslip?lang=${i18n.language === 'en' ? 'en' : 'ar'}`);
      if (preview) preview.location.href = URL.createObjectURL(file.blob);
      else saveBlob(file.blob, file.filename ?? 'payslip.pdf');
    } catch {
      preview?.close();
      message.error(t('payroll.saveError'));
    }
  };
  return <>
    <Space wrap style={{ marginBottom: 12 }}>
      <PayrollMonthPicker period={period} onChange={setPeriod} />
      {can(PERMISSIONS.PAYROLL_MANAGE) && <Button type="primary" onClick={() => create.mutate()} loading={create.isPending}>{t('payroll.newRun')}</Button>}
      <Select style={{ minWidth: 180 }} placeholder={t('payroll.run')} value={runId} onChange={setRunId} options={(runs.data as PayrollRunDto[] | undefined)?.map((r) => ({ value: r.id, label: `${r.period} · ${t(`payroll.${r.status.toLowerCase()}`)}` }))} />
      <Select value={sourceType} onChange={(value) => { setSourceType(value); setSourceId(undefined); }} options={['cash', 'bank'].map((v) => ({ value: v, label: t(`payroll.${v}`) }))} />
      <Select placeholder={t('payroll.paymentAccount')} value={sourceId} onChange={setSourceId} options={sourceOptions} />
      {can(PERMISSIONS.PAYROLL_MANAGE) && <Button disabled={!runId} onClick={() => mutate.mutate('recompute')}>{t('payroll.recompute')}</Button>}
      {can(PERMISSIONS.PAYROLL_MANAGE) && data?.status === 'DRAFT' && <Button danger disabled={!runId} onClick={() => mutate.mutate('delete')}>{t('payroll.deleteDraft')}</Button>}
      {can(PERMISSIONS.PAYROLL_POST) && <Button disabled={!available.canPost} onClick={() => mutate.mutate('post')}>{t('payroll.post')}</Button>}
      {can(PERMISSIONS.PAYROLL_POST) && <Button disabled={!available.canPay || !sourceId} onClick={() => mutate.mutate('pay')}>{t('payroll.pay')}</Button>}
      {can(PERMISSIONS.PAYROLL_POST) && <Button disabled={!available.canReverse} onClick={() => mutate.mutate('reverse')}>{t('payroll.reverse')}</Button>}
    </Space>
    {data && <Space wrap style={{ marginBottom: 12 }}>
      <span>{t('payroll.basicSalary')}: {formatAmount(data.basicTotal)}</span>
      <span>{t('payroll.gross')}: {formatAmount(data.grossTotal)}</span>
      <span>{t('payroll.sscBase')}: {formatAmount(data.sscBaseTotal)}</span>
      <span>{t('payroll.sscEmployeeTotal')}: {formatAmount(data.sscEmployeeTotal)}</span>
      <span>{t('payroll.sscEmployerTotal')}: {formatAmount(data.sscEmployerTotal)}</span>
      <span>{t('payroll.incomeTax')}: {formatAmount(data.incomeTaxTotal)}</span>
      <span>{t('payroll.deductions')}: {formatAmount(data.deductionsTotal)}</span>
      <span>{t('payroll.net')}: {formatAmount(data.netTotal)}</span>
    </Space>}
    {data && <Table rowKey="id" dataSource={data.lines} columns={[
      { title: t('payroll.employee'), dataIndex: 'employeeName' },
      { title: t('payroll.basicSalary'), dataIndex: 'basic', render: (v: string) => formatAmount(v) },
      { title: t('payroll.earnings'), dataIndex: 'earnings', render: (v: string) => formatAmount(v) },
      { title: t('payroll.gross'), dataIndex: 'gross', render: (v: string) => formatAmount(v) },
      { title: t('payroll.sscBase'), dataIndex: 'sscBase', render: (v: string) => formatAmount(v) },
      { title: t('payroll.sscEmployeeTotal'), dataIndex: 'sscEmployee', render: (v: string) => formatAmount(v) },
      { title: t('payroll.sscEmployerTotal'), dataIndex: 'sscEmployer', render: (v: string) => formatAmount(v) },
      { title: t('payroll.incomeTax'), dataIndex: 'incomeTax', render: (v: string, row) => available.taxEditable && can(PERMISSIONS.PAYROLL_MANAGE) ? <Input defaultValue={v} onBlur={(e) => void payrollControllerSetIncomeTax(data.id, row.id, { incomeTax: e.target.value }).then(() => qc.invalidateQueries({ queryKey: ['payroll', 'run', runId] })).catch(() => message.error(t('payroll.saveError')))} /> : formatAmount(v) },
      { title: t('payroll.deductions'), dataIndex: 'deductions', render: (v: string) => formatAmount(v) },
      { title: t('payroll.net'), dataIndex: 'net', render: (v: string) => formatAmount(v) },
      { title: t('payroll.payslip'), render: (_, row) => <Button icon={<FilePdfOutlined />} onClick={() => void printPayslip(row.id)}>{t('payroll.print')}</Button> },
    ]} />}
  </>;
}

function SettingsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { can } = useAuth();
  const settings = useQuery({ queryKey: ['payroll', 'settings'], queryFn: async () => (await payrollControllerListSettings()).data });
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const save = useMutation({ mutationFn: (v: Record<string, unknown> & { effectiveFrom?: DateFormValue }) => payrollControllerCreateSettings(buildSettingsPayload(v) as never), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['payroll', 'settings'] }); form.resetFields(); }, onError: () => message.error(t('payroll.saveError')) });
  return <>
    {can(PERMISSIONS.PAYROLL_MANAGE) && <EnterNav><Form form={form} layout="inline" onFinish={(v) => save.mutate(v)}>
      <Form.Item name="effectiveFrom" label={t('payroll.effectiveFrom')} rules={[{ required: true }]}><DatePicker /></Form.Item>
      {['sscEmployeeRate', 'sscEmployerRate', 'sscHazardousExtra', 'sscMinWage', 'sscMaxWage', 'hoursPerMonth', 'daysPerMonth'].map((key) => <Form.Item key={key} name={key} label={t(`payroll.${key}`)}><Input /></Form.Item>)}
      <Button type="primary" htmlType="submit">{t('payroll.addSetting')}</Button>
    </Form></EnterNav>}
    <Table rowKey="id" dataSource={settings.data as Array<Record<string, string | null>> | undefined} columns={[
      ...['effectiveFrom', 'sscEmployeeRate', 'sscEmployerRate', 'sscHazardousExtra', 'sscMinWage', 'sscMaxWage', 'hoursPerMonth', 'daysPerMonth']
        .map((key) => ({
          title: t(`payroll.${key}`),
          dataIndex: key,
          render: (value: string | null) => key === 'effectiveFrom'
            ? dateOnly(value) ?? '—'
            : key.endsWith('Wage') ? formatAmount(value) : formatQty(value),
        })),
    ]} />
  </>;
}

function ReportsTab() {
  const { t } = useTranslation();
  const [period, setPeriod] = useState(dayjs().format('YYYY-MM'));
  return <Space wrap><PayrollMonthPicker period={period} onChange={setPeriod} />
    {(['register', 'ssc', 'tax-withheld'] as const).map((report) => <Space key={report}>
      <strong>{t(`payroll.reports.${report}`)}</strong>
      <ExportButtons path={`/payroll/reports/${report}`} params={{ period }} />
    </Space>)}
  </Space>;
}

export function PayrollPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const activeKey = params.get('tab') ?? 'employees';
  const createOnLoad = params.get('new') === '1';
  const changeTab = (tab: string) => setParams(payrollTabSearchParams(params, tab), { replace: true });
  const tabs = useMemo(() => [
    { key: 'employees', label: t('payroll.employees'), children: <EmployeesTab /> },
    { key: 'elements', label: t('payroll.elements'), children: <ElementsTab /> },
    { key: 'inputs', label: t('payroll.inputs'), children: <InputsTab /> },
    { key: 'runs', label: t('payroll.runs'), children: <RunsTab createOnLoad={createOnLoad} /> },
    { key: 'settings', label: t('payroll.settings'), children: <SettingsTab /> },
    { key: 'reports', label: t('payroll.reports.title'), children: <ReportsTab /> },
  ], [t, createOnLoad]);
  return <Tabs activeKey={activeKey} onChange={changeTab} items={tabs} />;
}
