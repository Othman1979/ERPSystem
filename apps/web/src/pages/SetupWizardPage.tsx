import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircleFilled } from '@ant-design/icons';
import { Alert, App, Button, Card, DatePicker, Form, Input, Result, Space, Steps, Table, Tag, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import {
  ApiError,
  accountingControllerListAccounts,
  branchesControllerList,
  companyControllerCompleteOnboarding,
  fiscalControllerCreateYear,
  fiscalControllerListYears,
  settingsControllerListTaxCategories,
  treasuryControllerCreateCashBox,
  treasuryControllerListCashBoxes,
  warehousesControllerCreate,
  warehousesControllerList,
} from '@erp/api-client';
import { CompanyProfileForm, useCompany } from '../components/CompanyProfileForm';
import { PageHeader } from '../components/PageHeader';
import { codeAndName, displayName } from '../i18n/displayName';

interface FiscalYear {
  id: string;
  code: string;
  startDate: string;
  endDate: string;
  status: string;
}
interface Named {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
}
interface AccountRow extends Named {
  isPostable: boolean;
  isActive: boolean;
  controlType?: string | null;
}
interface TaxCategory extends Named {
  rate: string;
  isDefault?: boolean;
}
interface CashBox {
  id: string;
  code: string;
  name: string;
}

const day = (v: string) => v.slice(0, 10);

/** A step's "done" mark in the wizard. */
function Done({ children }: { children: ReactNode }) {
  return (
    <Alert type="success" showIcon icon={<CheckCircleFilled />} message={children} style={{ marginBottom: 16 }} />
  );
}

/**
 * Setup wizard (BUILD_PLAN §13.4): company, fiscal year, tax, chart of
 * accounts, main branch / warehouse / cash box, users, opening balances.
 * Each step shows what exists and creates only what is missing; any step can
 * be revisited. Finishing records the date (ADR-009) and opens the home screen.
 */
export function SetupWizardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const company = useCompany();
  const [step, setStep] = useState(0);

  const onError = (err: unknown) =>
    message.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'));

  const years = useQuery({
    queryKey: ['fiscal-years'],
    queryFn: () => fiscalControllerListYears().then((r) => r.data as unknown as FiscalYear[]),
  });
  const taxes = useQuery({
    queryKey: ['tax-categories'],
    queryFn: () => settingsControllerListTaxCategories().then((r) => r.data as unknown as TaxCategory[]),
  });
  const accounts = useQuery({
    queryKey: ['accounts-postable'],
    queryFn: () => accountingControllerListAccounts().then((r) => r.data as unknown as AccountRow[]),
  });
  const branches = useQuery({
    queryKey: ['branches'],
    queryFn: () => branchesControllerList().then((r) => r.data as unknown as Named[]),
  });
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => warehousesControllerList().then((r) => r.data as unknown as Named[]),
  });
  const cashBoxes = useQuery({
    queryKey: ['cash-boxes'],
    queryFn: () => treasuryControllerListCashBoxes().then((r) => r.data as unknown as CashBox[]),
  });

  // --- step 2: fiscal year (default 1 January of this year, §13.4)
  const [fyStart, setFyStart] = useState<Dayjs>(dayjs().startOf('year'));
  const createYear = useMutation({
    mutationFn: () => {
      const end = fyStart.add(1, 'year').subtract(1, 'day');
      const code = fyStart.month() === 0 && fyStart.date() === 1 ? `FY${fyStart.year()}` : `FY${fyStart.format('YYYYMM')}`;
      return fiscalControllerCreateYear({
        code,
        startDate: fyStart.format('YYYY-MM-DD'),
        endDate: end.format('YYYY-MM-DD'),
      } as never);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fiscal-years'] });
      setStep(2);
    },
    onError,
  });

  // --- step 5: main warehouse and cash box
  const [warehouseForm] = Form.useForm<{ nameAr: string }>();
  const [cashForm] = Form.useForm<{ name: string }>();
  const createWarehouse = useMutation({
    mutationFn: (v: { nameAr: string }) => warehousesControllerCreate({ code: '1', nameAr: v.nameAr } as never),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['warehouses'] }),
    onError,
  });
  const cashAccount = (accounts.data ?? []).find((a) => a.controlType === 'CASH' && a.isPostable && a.isActive);
  const createCashBox = useMutation({
    mutationFn: (v: { name: string }) =>
      treasuryControllerCreateCashBox({ code: '1', name: v.name, accountId: cashAccount!.id } as never),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['cash-boxes'] }),
    onError,
  });

  const finish = useMutation({
    mutationFn: () => companyControllerCompleteOnboarding(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['company'] });
      message.success(t('setup.finished'));
      navigate('/');
    },
    onError,
  });

  const openYears = (years.data ?? []).filter((y) => y.status === 'OPEN');
  const postable = (accounts.data ?? []).filter((a) => a.isPostable).length;
  const done = [
    !!company.data?.address || !!company.data?.taxNumber,
    openYears.length > 0,
    true,
    postable > 0,
    (warehouses.data?.length ?? 0) > 0 && (cashBoxes.data?.length ?? 0) > 0,
    true,
    true,
  ];

  const nav = (
    <Space style={{ marginTop: 24 }}>
      {step > 0 && <Button onClick={() => setStep(step - 1)}>{t('setup.previous')}</Button>}
      {step < 6 ? (
        <Button type="primary" onClick={() => setStep(step + 1)}>
          {t('setup.next')}
        </Button>
      ) : (
        <Button type="primary" loading={finish.isPending} onClick={() => finish.mutate()}>
          {t('setup.finish')}
        </Button>
      )}
    </Space>
  );

  const body: ReactNode[] = [
    // 1. company
    <>
      <Typography.Paragraph type="secondary">{t('setup.companyIntro')}</Typography.Paragraph>
      <CompanyProfileForm submitLabel={t('setup.saveAndNext')} onSaved={() => setStep(1)} />
    </>,
    // 2. fiscal year
    <>
      {openYears.length > 0 ? (
        <Done>
          {t('setup.yearExists', {
            years: openYears.map((y) => `${y.code} (${day(y.startDate)} — ${day(y.endDate)})`).join('، '),
          })}
        </Done>
      ) : (
        <>
          <Typography.Paragraph type="secondary">{t('setup.yearIntro')}</Typography.Paragraph>
          <Space wrap>
            <DatePicker value={fyStart} allowClear={false} onChange={(d) => d && setFyStart(d)} />
            <Typography.Text>
              {t('setup.yearEnds', { end: fyStart.add(1, 'year').subtract(1, 'day').format('YYYY-MM-DD') })}
            </Typography.Text>
            <Button type="primary" loading={createYear.isPending} onClick={() => createYear.mutate()}>
              {t('setup.createYear')}
            </Button>
          </Space>
        </>
      )}
    </>,
    // 3. tax
    <>
      <Typography.Paragraph type="secondary">{t('setup.taxIntro')}</Typography.Paragraph>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text>
          {company.data?.taxNumber
            ? t('setup.taxRegistered', { number: company.data.taxNumber })
            : t('setup.taxNotRegistered')}
        </Typography.Text>
        <Typography.Text>
          {company.data?.pricesIncludeTax ? t('setup.pricesInclude') : t('setup.pricesExclude')}
        </Typography.Text>
        <Table<TaxCategory>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={taxes.data ?? []}
          columns={[
            { title: t('settings.code'), dataIndex: 'code', width: 100 },
            { title: t('common.name'), render: (_: unknown, r) => displayName(r) },
            { title: t('settings.rate'), dataIndex: 'rate', width: 100, render: (v: string) => `${v}%` },
            { title: '', dataIndex: 'isDefault', width: 90, render: (v?: boolean) => (v ? <Tag color="blue">{t('settings.isDefault')}</Tag> : null) },
          ]}
        />
        <Button onClick={() => navigate('/settings')}>{t('setup.editInSettings')}</Button>
      </Space>
    </>,
    // 4. chart of accounts
    <>
      {postable > 0 ? (
        <Done>{t('setup.chartReady', { count: postable })}</Done>
      ) : (
        <Alert type="warning" showIcon message={t('setup.chartMissing')} style={{ marginBottom: 16 }} />
      )}
      <Typography.Paragraph type="secondary">{t('setup.chartIntro')}</Typography.Paragraph>
      <Button onClick={() => navigate('/accounts')}>{t('setup.openChart')}</Button>
    </>,
    // 5. branch, warehouse, cash box
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Done>{t('setup.branchExists', { names: (branches.data ?? []).map((b) => codeAndName(b)).join('، ') })}</Done>
      {(warehouses.data?.length ?? 0) > 0 ? (
        <Done>{t('setup.warehouseExists', { names: (warehouses.data ?? []).map((w) => codeAndName(w)).join('، ') })}</Done>
      ) : (
        <Form form={warehouseForm} layout="inline" initialValues={{ nameAr: t('setup.mainWarehouse') }} onFinish={(v) => createWarehouse.mutate(v)}>
          <Form.Item name="nameAr" label={t('setup.warehouseName')} rules={[{ required: true }]}>
            <Input maxLength={191} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={createWarehouse.isPending}>
            {t('setup.createWarehouse')}
          </Button>
        </Form>
      )}
      {(cashBoxes.data?.length ?? 0) > 0 ? (
        <Done>{t('setup.cashBoxExists', { names: (cashBoxes.data ?? []).map((c) => `${c.code} — ${c.name}`).join('، ') })}</Done>
      ) : cashAccount ? (
        <Form form={cashForm} layout="inline" initialValues={{ name: t('setup.mainCashBox') }} onFinish={(v) => createCashBox.mutate(v)}>
          <Form.Item name="name" label={t('setup.cashBoxName')} rules={[{ required: true }]}>
            <Input maxLength={191} />
          </Form.Item>
          <Typography.Text type="secondary">{t('setup.cashBoxAccount', { account: codeAndName(cashAccount) })}</Typography.Text>
          <Button type="primary" htmlType="submit" loading={createCashBox.isPending}>
            {t('setup.createCashBox')}
          </Button>
        </Form>
      ) : (
        <Alert type="warning" showIcon message={t('setup.noCashAccount')} />
      )}
    </Space>,
    // 6. users
    <>
      <Typography.Paragraph type="secondary">{t('setup.usersIntro')}</Typography.Paragraph>
      <Button onClick={() => navigate('/users')}>{t('users.invite')}</Button>
    </>,
    // 7. opening balances
    <>
      <Typography.Paragraph type="secondary">{t('setup.openingIntro')}</Typography.Paragraph>
      <Space wrap>
        <Button onClick={() => navigate('/opening-balances')}>{t('nav.openingBalances')}</Button>
        <Button onClick={() => navigate('/stock?tab=adjustments')}>{t('opening.openStockAdjustments')}</Button>
      </Space>
    </>,
  ];

  const titles = [
    t('setup.stepCompany'),
    t('setup.stepYear'),
    t('setup.stepTax'),
    t('setup.stepChart'),
    t('setup.stepBranch'),
    t('setup.stepUsers'),
    t('setup.stepOpening'),
  ];

  return (
    <div>
      <PageHeader title={t('setup.title')} subtitle={t('setup.subtitle')} />
      {company.data?.onboardingCompletedAt && (
        <Result
          status="success"
          title={t('setup.alreadyDone')}
          subTitle={t('setup.alreadyDoneHint')}
          style={{ padding: '8px 0 16px' }}
        />
      )}
      <Card>
        <Steps
          current={step}
          onChange={setStep}
          size="small"
          items={titles.map((title, i) => ({ title, status: i === step ? 'process' : done[i] && i < step ? 'finish' : 'wait' }))}
          style={{ marginBottom: 24 }}
        />
        <Typography.Title level={5}>{titles[step]}</Typography.Title>
        {body[step]}
        {nav}
      </Card>
    </div>
  );
}
