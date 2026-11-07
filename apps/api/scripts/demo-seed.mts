/**
 * Demo data seed — drives the running API (default http://localhost:3001)
 * to create a demo tenant with a fiscal year, opening balances and a set
 * of posted journal entries so every screen has data to show.
 *
 * Run: pnpm --filter api demo:seed   (or: npx tsx scripts/demo-seed.mts)
 * Idempotent-ish: reuses the demo login if it exists; entries are only
 * created when the trial balance is still empty.
 */
const API = process.env.API_URL ?? 'http://localhost:3001/api/v1';
const EMAIL = 'demo@erp.local';
const PASSWORD = 'Demo12345';

async function req(path: string, token?: string, body?: unknown, method = 'POST') {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(path.endsWith('/post') || path.endsWith('/reverse')
        ? { 'Idempotency-Key': `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function login(): Promise<string> {
  try {
    const r = await req('/auth/login', undefined, { email: EMAIL, password: PASSWORD }, 'POST');
    return r.accessToken as string;
  } catch {
    const r = await req('/auth/register', undefined, {
      tenantName: 'شركة النور للتجارة',
      companyNameAr: 'شركة النور للتجارة ذ.م.م',
      ownerName: 'أحمد الخطيب',
      email: EMAIL,
      password: PASSWORD,
      locale: 'ar',
    });
    return r.accessToken as string;
  }
}

async function main() {
  const token = await login();
  console.log('logged in as', EMAIL);
  const H = { token };

  // Fiscal year covering today
  const years = (await req('/fiscal-years', H.token, undefined, 'GET')) as { code: string }[];
  if (!years.some((y) => y.code === 'FY2026')) {
    await req('/fiscal-years', H.token, {
      code: 'FY2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    console.log('fiscal year FY2026 created (12 periods + sequences)');
  } else {
    console.log('fiscal year FY2026 exists');
  }

  // Chart of accounts → code map
  const accounts = (await req('/accounts', H.token, undefined, 'GET')) as {
    id: string;
    code: string;
  }[];
  const acct = (code: string) => {
    const a = accounts.find((x) => x.code === code);
    if (!a) throw new Error(`account ${code} not found`);
    return a.id;
  };

  // Skip data creation if entries already exist
  const existing = (await req('/journal-entries', H.token, undefined, 'GET')) as {
    description?: string | null;
    status?: string;
  }[];
  if (existing.some((e) => e.description === 'سداد جزئي للمورد' && e.status === 'POSTED')) {
    console.log(`demo entries already exist (${existing.length}) — nothing to do`);
    return;
  }
  if (existing.length > 0) {
    console.log('opening entry exists — skipping opening, adding sample entries');
  }
  const done = new Set(
    existing.filter((e) => e.status === 'POSTED').map((e) => e.description),
  );

  // Opening balances (difference auto-plugs to OPENING_BALANCE_EQUITY)
  if (existing.length === 0)
  await req('/journal-entries/opening', H.token, {
    entryDate: '2026-01-01',
    description: 'الأرصدة الافتتاحية',
    lines: [
      { accountId: acct('1101'), debit: '5000' },
      { accountId: acct('1102'), debit: '25000' },
      { accountId: acct('1104'), debit: '40000' },
      { accountId: acct('1201'), debit: '8000' },
      {
        accountId: acct('2101'),
        credit: '30000',
        partyType: 'SUPPLIER',
        partyId: '1',
      },
    ],
  });
  console.log('opening entry posted');

  const post = async (
    entryDate: string,
    description: string,
    lines: Record<string, unknown>[],
  ) => {
    if (done.has(description)) {
      console.log('skip (exists):', description);
      return;
    }
    const draft = await req('/journal-entries', H.token, { entryDate, description, lines });
    await req(`/journal-entries/${draft.id}/post`, H.token, {});
    console.log('posted:', description);
  };

  await post('2026-01-15', 'مبيعات نقدية', [
    { accountId: acct('1101'), debit: '1160' },
    { accountId: acct('4101'), credit: '1000' },
    { accountId: acct('2102'), credit: '160' },
  ]);

  await post('2026-01-15', 'تكلفة البضاعة المباعة', [
    { accountId: acct('5101'), debit: '600' },
    { accountId: acct('1104'), credit: '600' },
  ]);

  await post('2026-02-01', 'إيجار شهر فبراير', [
    { accountId: acct('5202'), debit: '500' },
    { accountId: acct('1101'), credit: '500' },
  ]);

  await post('2026-02-10', 'مبيعات آجلة للعميل', [
    { accountId: acct('1103'), debit: '2320', partyType: 'CUSTOMER', partyId: '1' },
    { accountId: acct('4101'), credit: '2000' },
    { accountId: acct('2102'), credit: '320' },
  ]);

  await post('2026-02-12', 'سداد جزئي للمورد', [
    { accountId: acct('2101'), debit: '500', partyType: 'SUPPLIER', partyId: '1' },
    { accountId: acct('1102'), credit: '500' },
  ]);

  // Leave one draft for the user to post from the UI
  if (!existing.some((e) => e.description === 'مصروفات إدارية — مسودة'))
  await req('/journal-entries', H.token, {
    entryDate: '2026-02-15',
    description: 'مصروفات إدارية — مسودة',
    lines: [
      { accountId: acct('5204'), debit: '120' },
      { accountId: acct('1101'), credit: '120' },
    ],
  });
  console.log('draft entry left for manual posting');

  console.log('\nDone. Login: demo@erp.local / Demo12345');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
