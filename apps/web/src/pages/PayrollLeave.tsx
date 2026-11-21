import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  leaveControllerAdjustments,
  leaveControllerApprove,
  leaveControllerBalances,
  leaveControllerCancel,
  leaveControllerCreateAdjustment,
  leaveControllerCreateHoliday,
  leaveControllerCreateRequest,
  leaveControllerCreateType,
  leaveControllerDeleteHoliday,
  leaveControllerListHolidays,
  leaveControllerListRequests,
  leaveControllerListTypes,
  leaveControllerReject,
  leaveControllerUpdateType,
  payrollControllerListEmployees,
  payrollControllerListElements,
  type LeaveBalanceResponseDto,
  type LeaveControllerListRequestsStatus,
  type LeaveRequestResponseDto,
  type LeaveTypeResponseDto,
  type PayrollEmployeeDto,
  type PayrollElementDto,
} from '@erp/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Checkbox, Form, Input, InputNumber, Select, Space, Table, Tabs, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { formatAmount } from '../format/number';
import { DatePicker } from '../components/DatePicker';
import { EnterNav } from '../components/EnterNav';
import { FormDialog, FormSection } from '../components/FormDialog';
import { GridSelect } from '../components/GridSelect';

type DateValue = Dayjs | string | null | undefined;
const dateText = (value: DateValue) => dayjs.isDayjs(value) ? value.format('YYYY-MM-DD') : typeof value === 'string' ? value.slice(0, 10) : undefined;
const datePickerValue = (value?: string | null) => value ? dayjs(value.slice(0, 10)) : undefined;

function employeeOptions(rows: PayrollEmployeeDto[] | undefined, language: string) {
  return (rows ?? []).map((row) => ({
    value: row.id,
    label: `${row.code} — ${language === 'en' ? row.nameEn ?? row.nameAr : row.nameAr}`,
  }));
}

function typeName(type: LeaveTypeResponseDto, language: string) {
  return language === 'en' ? type.nameEn ?? type.nameAr : type.nameAr;
}

function RequestsTab() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [employeeId, setEmployeeId] = useState<string>();
  const [status, setStatus] = useState<LeaveControllerListRequestsStatus>();
  const [year, setYear] = useState(String(dayjs().year()));
  const [formOpen, setFormOpen] = useState(false);
  const [lastResult, setLastResult] = useState<LeaveRequestResponseDto>();
  const [form] = Form.useForm();
  const watchedType = Form.useWatch('leaveTypeId', form) as string | undefined;
  const employees = useQuery({ queryKey: ['payroll', 'employees'], queryFn: async () => (await payrollControllerListEmployees()).data });
  const types = useQuery({ queryKey: ['payroll', 'leaveTypes'], queryFn: async () => (await leaveControllerListTypes()).data });
  const requests = useQuery({
    queryKey: ['payroll', 'leaveRequests', employeeId, status, year],
    queryFn: async () => (await leaveControllerListRequests({ employeeId, status, year })).data,
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['payroll', 'leaveRequests'] });
    void queryClient.invalidateQueries({ queryKey: ['payroll', 'leaveBalances'] });
  };
  const create = useMutation({
    mutationFn: async (values: Record<string, unknown>) => (await leaveControllerCreateRequest({
      employeeId: values.employeeId as string,
      leaveTypeId: values.leaveTypeId as string,
      startDate: dateText(values.startDate as DateValue)!,
      endDate: dateText(values.endDate as DateValue)!,
      hospitalised: Boolean(values.hospitalised),
      notes: (values.notes as string | undefined) || undefined,
    })).data,
    onSuccess: (created) => {
      message.success(t('payroll.requestedDays', { days: created.days }));
      setLastResult(created as LeaveRequestResponseDto);
      form.resetFields();
      setFormOpen(false);
      invalidate();
    },
    onError: () => message.error(t('payroll.saveError')),
  });
  const action = useMutation({
    mutationFn: async ({ id, action: actionName }: { id: string; action: 'approve' | 'reject' | 'cancel' }) => {
      if (actionName === 'approve') return leaveControllerApprove(id);
      if (actionName === 'reject') return leaveControllerReject(id);
      return leaveControllerCancel(id);
    },
    onSuccess: invalidate,
    onError: () => message.error(t('payroll.saveError')),
  });
  const selectedType = (types.data as LeaveTypeResponseDto[] | undefined)?.find((type) => type.id === watchedType);
  const rows = requests.data as LeaveRequestResponseDto[] | undefined;
  return <>
    {lastResult && <Alert showIcon type="success" message={t('payroll.requestedDays', { days: lastResult.days })} description={`${datePickerValue(lastResult.startDate)?.format('DD/MM/YYYY')} – ${datePickerValue(lastResult.endDate)?.format('DD/MM/YYYY')} · ${t('payroll.calendarDays')}: ${lastResult.calendarDays}`} closable onClose={() => setLastResult(undefined)} />}
    <Space wrap style={{ marginBottom: 12 }}>
      <Select allowClear showSearch optionFilterProp="label" value={employeeId} onChange={setEmployeeId} placeholder={t('payroll.employee')}
        options={employeeOptions(employees.data as PayrollEmployeeDto[] | undefined, i18n.language)} />
      <Select allowClear value={status} onChange={setStatus} placeholder={t('payroll.status')} options={['SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'].map((value) => ({ value, label: t(`payroll.${value.toLowerCase()}`) }))} />
      <Input value={year} onChange={(event) => setYear(event.target.value)} aria-label={t('payroll.year')} />
      {can(PERMISSIONS.PAYROLL_MANAGE) && <Button type="primary" icon={<PlusOutlined />} onClick={() => setFormOpen(true)}>{t('payroll.requestLeave')}</Button>}
    </Space>
    <Table rowKey="id" loading={requests.isLoading} dataSource={rows} columns={[
      { title: t('payroll.employee'), render: (_: unknown, row) => i18n.language === 'en' ? row.employeeNameEn ?? row.employeeName : row.employeeName },
      { title: t('payroll.leaveTypes'), render: (_: unknown, row) => i18n.language === 'en' ? row.leaveTypeNameEn ?? row.leaveTypeNameAr : row.leaveTypeNameAr },
      { title: t('payroll.from'), dataIndex: 'startDate', render: (value: string) => datePickerValue(value)?.format('DD/MM/YYYY') },
      { title: t('payroll.to'), dataIndex: 'endDate', render: (value: string) => datePickerValue(value)?.format('DD/MM/YYYY') },
      { title: t('payroll.leaveDays'), dataIndex: 'days', render: (value: string) => value },
      { title: t('payroll.status'), dataIndex: 'status', render: (value: string) => <Tag>{t(`payroll.${value.toLowerCase()}`)}</Tag> },
      { title: '', render: (_: unknown, row) => row.status === 'SUBMITTED' && can(PERMISSIONS.PAYROLL_LEAVE_APPROVE) ? <Space>
        <Button onClick={() => action.mutate({ id: row.id, action: 'approve' })}>{t('payroll.approveLeave')}</Button>
        <Button onClick={() => action.mutate({ id: row.id, action: 'reject' })}>{t('payroll.rejectLeave')}</Button>
      </Space> : row.status === 'APPROVED' && can(PERMISSIONS.PAYROLL_LEAVE_APPROVE)
        ? <Button danger onClick={() => action.mutate({ id: row.id, action: 'cancel' })}>{t('payroll.cancelLeave')}</Button> : null },
    ]} />
    <FormDialog open={formOpen} title={t('payroll.requestLeave')} onCancel={() => setFormOpen(false)} onSave={() => void form.submit()} saving={create.isPending}>
      <EnterNav>
        <Form form={form} layout="vertical" onFinish={(values) => create.mutate(values)}>
          <Form.Item name="employeeId" label={t('payroll.employee')} rules={[{ required: true }]}>
            <GridSelect options={employeeOptions(employees.data as PayrollEmployeeDto[] | undefined, i18n.language)} />
          </Form.Item>
          <Form.Item name="leaveTypeId" label={t('payroll.leaveTypes')} rules={[{ required: true }]}>
            <GridSelect options={(types.data as LeaveTypeResponseDto[] | undefined)?.map((type) => ({ value: type.id, label: typeName(type, i18n.language) })) ?? []} />
          </Form.Item>
          <Form.Item name="startDate" label={t('payroll.leaveStart')} rules={[{ required: true }]}><DatePicker /></Form.Item>
          <Form.Item name="endDate" label={t('payroll.leaveEnd')} rules={[{ required: true }]}><DatePicker /></Form.Item>
          {selectedType?.category === 'SICK' && <Form.Item name="hospitalised" valuePropName="checked"><Checkbox>{t('payroll.hospitalised')}</Checkbox></Form.Item>}
          <Form.Item name="notes" label={t('payroll.notes')}><Input.TextArea /></Form.Item>
        </Form>
      </EnterNav>
    </FormDialog>
  </>;
}

function BalancesTab() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [year, setYear] = useState(String(dayjs().year()));
  const [employeeId, setEmployeeId] = useState<string>();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const employees = useQuery({ queryKey: ['payroll', 'employees'], queryFn: async () => (await payrollControllerListEmployees()).data });
  const types = useQuery({ queryKey: ['payroll', 'leaveTypes'], queryFn: async () => (await leaveControllerListTypes()).data });
  const balances = useQuery({
    queryKey: ['payroll', 'leaveBalances', year, employeeId],
    queryFn: async () => (await leaveControllerBalances({ year, employeeId })).data,
  });
  const adjustments = useQuery({
    queryKey: ['payroll', 'leaveAdjustments', year, employeeId],
    queryFn: async () => (await leaveControllerAdjustments({ year, employeeId })).data,
  });
  const save = useMutation({
    mutationFn: async (values: Record<string, unknown>) => leaveControllerCreateAdjustment({
      employeeId: values.employeeId as string,
      leaveTypeId: values.leaveTypeId as string,
      year: String(values.year),
      days: values.days as string,
      reason: values.reason as string,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['payroll', 'leaveBalances'] });
      void queryClient.invalidateQueries({ queryKey: ['payroll', 'leaveAdjustments'] });
      setOpen(false);
      form.resetFields();
    },
    onError: () => message.error(t('payroll.saveError')),
  });
  return <>
    <Space wrap style={{ marginBottom: 12 }}>
      <Input value={year} onChange={(event) => setYear(event.target.value)} aria-label={t('payroll.year')} />
      <Select allowClear showSearch optionFilterProp="label" value={employeeId} onChange={setEmployeeId} placeholder={t('payroll.employee')}
        options={employeeOptions(employees.data as PayrollEmployeeDto[] | undefined, i18n.language)} />
      {can(PERMISSIONS.PAYROLL_MANAGE) && <Button type="primary" onClick={() => setOpen(true)}>{t('payroll.createAdjustment')}</Button>}
    </Space>
    <Table rowKey={(row) => `${row.employeeId}-${row.leaveTypeId}`} loading={balances.isLoading}
      dataSource={balances.data as LeaveBalanceResponseDto[] | undefined} columns={[
        { title: t('payroll.employee'), dataIndex: 'employeeName' },
        { title: t('payroll.leaveTypes'), dataIndex: 'leaveTypeNameAr', render: (_: string, row) => i18n.language === 'en' ? row.leaveTypeNameEn ?? row.leaveTypeNameAr : row.leaveTypeNameAr },
        ...(['entitlement', 'carryInto', 'adjustments', 'taken', 'available'] as const).map((key) => ({
          title: t(`payroll.${key}`), dataIndex: key, render: (value: string) => formatAmount(value),
        })),
      ]} />
    <Table rowKey="id" dataSource={adjustments.data as Array<{ id: string; employeeId: string; year: number; days: string; reason: string }> | undefined}
      columns={[
        { title: t('payroll.employee'), render: (_: unknown, row) => {
          const employee = (employees.data as PayrollEmployeeDto[] | undefined)?.find((item) => item.id === row.employeeId);
          return employee ? i18n.language === 'en' ? employee.nameEn ?? employee.nameAr : employee.nameAr : row.employeeId;
        } },
        { title: t('payroll.year'), dataIndex: 'year' },
        { title: t('payroll.adjustmentDays'), dataIndex: 'days', render: (value: string) => formatAmount(value) },
        { title: t('payroll.leaveReason'), dataIndex: 'reason' },
      ]} />
    <FormDialog open={open} title={t('payroll.createAdjustment')} onCancel={() => setOpen(false)} onSave={() => void form.submit()} saving={save.isPending}>
      <EnterNav><Form form={form} layout="vertical" initialValues={{ year: Number(year) }} onFinish={(values) => save.mutate(values)}>
        <Form.Item name="employeeId" label={t('payroll.employee')} rules={[{ required: true }]}><GridSelect options={employeeOptions(employees.data as PayrollEmployeeDto[] | undefined, i18n.language)} /></Form.Item>
        <Form.Item name="leaveTypeId" label={t('payroll.leaveTypes')} rules={[{ required: true }]}><GridSelect options={(types.data as LeaveTypeResponseDto[] | undefined)?.map((type) => ({ value: type.id, label: typeName(type, i18n.language) })) ?? []} /></Form.Item>
        <Form.Item name="year" label={t('payroll.year')} rules={[{ required: true }]}><InputNumber min={1900} max={2200} precision={0} /></Form.Item>
        <Form.Item name="days" label={t('payroll.adjustmentDays')} rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="reason" label={t('payroll.leaveReason')} rules={[{ required: true }]}><Input.TextArea /></Form.Item>
      </Form></EnterNav>
    </FormDialog>
  </>;
}

export function PayrollLeaveTab() {
  const { t } = useTranslation();
  return <Tabs items={[
    { key: 'requests', label: t('payroll.leaveRequests'), children: <RequestsTab /> },
    { key: 'balances', label: t('payroll.leaveBalances'), children: <BalancesTab /> },
  ]} />;
}

export function LeaveSettingsPanel() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [holidayOpen, setHolidayOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [editing, setEditing] = useState<LeaveTypeResponseDto>();
  const [holidayForm] = Form.useForm();
  const [typeForm] = Form.useForm();
  const elements = useQuery({ queryKey: ['payroll', 'elements'], queryFn: async () => (await payrollControllerListElements()).data });
  const types = useQuery({ queryKey: ['payroll', 'leaveTypes'], queryFn: async () => (await leaveControllerListTypes()).data });
  const holidays = useQuery({ queryKey: ['payroll', 'holidays'], queryFn: async () => (await leaveControllerListHolidays()).data });
  const saveHoliday = useMutation({
    mutationFn: async (values: Record<string, unknown>) => leaveControllerCreateHoliday({
      date: dateText(values.date as DateValue)!,
      nameAr: values.nameAr as string,
      nameEn: values.nameEn as string | undefined,
    }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['payroll', 'holidays'] }); setHolidayOpen(false); holidayForm.resetFields(); },
    onError: () => message.error(t('payroll.saveError')),
  });
  const saveType = useMutation({
    mutationFn: async (values: Record<string, unknown>) => editing
      ? leaveControllerUpdateType(editing.id, values as never)
      : leaveControllerCreateType(values as never),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['payroll', 'leaveTypes'] }); setTypeOpen(false); setEditing(undefined); typeForm.resetFields(); },
    onError: () => message.error(t('payroll.saveError')),
  });
  const deleteHoliday = useMutation({
    mutationFn: (id: string) => leaveControllerDeleteHoliday(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['payroll', 'holidays'] }),
    onError: () => message.error(t('payroll.saveError')),
  });
  const openType = (type?: LeaveTypeResponseDto) => {
    setEditing(type);
    typeForm.resetFields();
    if (type) typeForm.setFieldsValue(type);
    setTypeOpen(true);
  };
  return <>
    <Space style={{ margin: '12px 0' }}>
      {can(PERMISSIONS.PAYROLL_MANAGE) && <>
        <Button onClick={() => setHolidayOpen(true)}>{t('payroll.addHoliday')}</Button>
        <Button type="primary" onClick={() => openType()}>{t('payroll.addLeaveType')}</Button>
      </>}
    </Space>
    <FormSection title={t('payroll.holidays')}>
      <Table rowKey="id" dataSource={holidays.data} columns={[
        { title: t('payroll.from'), dataIndex: 'date', render: (value: string) => datePickerValue(value)?.format('DD/MM/YYYY') },
        { title: t('payroll.nameAr'), dataIndex: 'nameAr' },
        { title: t('payroll.nameEn'), dataIndex: 'nameEn' },
        { title: '', render: (_: unknown, row: { id: string }) => can(PERMISSIONS.PAYROLL_MANAGE) && <Button danger icon={<DeleteOutlined />} onClick={() => deleteHoliday.mutate(row.id)} /> },
      ]} />
    </FormSection>
    <FormSection title={t('payroll.leaveTypes')}>
      <Table rowKey="id" dataSource={types.data} columns={[
        { title: t('payroll.code'), dataIndex: 'code' },
        { title: t('payroll.leaveTypes'), render: (_: unknown, row: LeaveTypeResponseDto) => typeName(row, i18n.language) },
        { title: t('payroll.leaveCategory'), dataIndex: 'category', render: (value: string) => t(`payroll.category${value}`) },
        { title: t('payroll.countBasis'), dataIndex: 'countBasis', render: (value: string) => t(`payroll.${value === 'WORKING_DAYS' ? 'workingDays' : 'calendarBasis'}`) },
        { title: '', render: (_: unknown, row: LeaveTypeResponseDto) => can(PERMISSIONS.PAYROLL_MANAGE) && <Button onClick={() => openType(row)}>{t('payroll.editElement')}</Button> },
      ]} />
    </FormSection>
    <FormDialog open={holidayOpen} title={t('payroll.addHoliday')} onCancel={() => setHolidayOpen(false)} onSave={() => void holidayForm.submit()} saving={saveHoliday.isPending}>
      <Form form={holidayForm} layout="vertical" onFinish={(values) => saveHoliday.mutate(values)}>
        <Form.Item name="date" label={t('payroll.from')} rules={[{ required: true }]}><DatePicker /></Form.Item>
        <Form.Item name="nameAr" label={t('payroll.nameAr')} rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="nameEn" label={t('payroll.nameEn')}><Input /></Form.Item>
      </Form>
    </FormDialog>
    <FormDialog open={typeOpen} title={t('payroll.leaveTypes')} onCancel={() => setTypeOpen(false)} onSave={() => void typeForm.submit()} saving={saveType.isPending}>
      <Form form={typeForm} layout="vertical" onFinish={(values) => saveType.mutate(values)}>
        <Form.Item name="code" label={t('payroll.code')} rules={[{ required: true }]}><Input disabled={Boolean(editing)} /></Form.Item>
        <Form.Item name="nameAr" label={t('payroll.nameAr')} rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="nameEn" label={t('payroll.nameEn')}><Input /></Form.Item>
        <Form.Item name="category" label={t('payroll.leaveCategory')} rules={[{ required: true }]}><Select options={['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'HAJJ', 'UNPAID', 'OTHER'].map((value) => ({ value, label: t(`payroll.category${value}`) }))} /></Form.Item>
        <Form.Item name="countBasis" label={t('payroll.countBasis')} rules={[{ required: true }]}><Select options={[
          { value: 'WORKING_DAYS', label: t('payroll.workingDays') },
          { value: 'CALENDAR_DAYS', label: t('payroll.calendarBasis') },
        ]} /></Form.Item>
        {(['maxDaysPerYear', 'maxDaysPerRequest', 'hospitalExtraDays'] as const).map((field) => <Form.Item key={field} name={field} label={t(`payroll.${field}`)}><Input /></Form.Item>)}
        <Form.Item name="minServiceYears" label={t('payroll.minServiceYears')}><InputNumber min={0} precision={0} /></Form.Item>
        <Form.Item name="payElementId" label={t('payroll.element')}>
          <Select allowClear showSearch optionFilterProp="label" options={(elements.data as PayrollElementDto[] | undefined)
            ?.filter((element) => element.kind === 'DEDUCTION' && element.amountType === 'PER_DAY')
            .map((element) => ({ value: element.id, label: element.code }))} />
        </Form.Item>
        <Form.Item name="oncePerEmployment" valuePropName="checked"><Checkbox>{t('payroll.oncePerEmployment')}</Checkbox></Form.Item>
        {editing && <Form.Item name="isActive" valuePropName="checked"><Checkbox>{t('payroll.active')}</Checkbox></Form.Item>}
      </Form>
    </FormDialog>
  </>;
}
