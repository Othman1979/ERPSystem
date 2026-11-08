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
      ...(path.endsWith('/post') || path.endsWith('/reverse') || path.endsWith('/approve')
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

  // ---- inventory demo data (Arabic) ----
  await seedInventory(H.token);

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

interface Unit {
  id: string;
  code: string;
}
interface Item {
  id: string;
  code: string;
}
interface Warehouse {
  id: string;
  code: string;
}

async function seedInventory(token: string): Promise<void> {
  const H = token;
  const get = (p: string) => req(p, H, undefined, 'GET');
  const post = (p: string, body: unknown) => req(p, H, body);

  const items = (await get('/items')) as Item[];
  if (items.some((i) => i.code === 'RICE-5KG')) {
    console.log('inventory demo data exists — skipping');
    return;
  }

  const units = (await get('/units')) as Unit[];
  const unit = (code: string) => {
    const u = units.find((x) => x.code === code);
    if (!u) throw new Error(`unit ${code} not found`);
    return u.id;
  };
  const pcs = unit('PCS');
  const box = unit('BOX');
  const kg = unit('KG');
  const l = unit('L');

  // Item groups
  const groups: Record<string, string> = {};
  for (const g of [
    { code: 'FOOD', nameAr: 'مواد غذائية' },
    { code: 'CLEAN', nameAr: 'مواد تنظيف' },
    { code: 'OFFICE', nameAr: 'أدوات مكتبية' },
  ]) {
    const created = (await post('/item-groups', g)) as { id: string };
    groups[g.code] = created.id;
  }
  console.log('item groups created');

  // Warehouse (TRIAL plan allows one)
  const warehouses = (await get('/warehouses')) as Warehouse[];
  let wh = warehouses[0];
  if (!wh) {
    wh = (await post('/warehouses', {
      code: 'MAIN',
      nameAr: 'المستودع الرئيسي',
      address: 'عمّان — المنطقة الصناعية',
    })) as Warehouse;
    console.log('warehouse created');
  }

  // Items
  const itemDefs = [
    {
      code: 'RICE-5KG',
      nameAr: 'أرز بسمتي 5 كغ',
      nameEn: 'Basmati Rice 5KG',
      group: 'FOOD',
      base: pcs,
      units: [{ unitId: box, factorToBase: '12' }],
      sale: '4.500',
      purchase: '3.200',
      min: '10',
    },
    {
      code: 'OIL-15L',
      nameAr: 'زيت دوار الشمس 1.5 لتر',
      nameEn: 'Sunflower Oil 1.5L',
      group: 'FOOD',
      base: l,
      sale: '2.800',
      purchase: '2.100',
      min: '5',
    },
    {
      code: 'SUGAR-1KG',
      nameAr: 'سكر ناعم 1 كغ',
      nameEn: 'White Sugar 1KG',
      group: 'FOOD',
      base: kg,
      sale: '0.850',
      purchase: '0.620',
      min: '20',
    },
    {
      code: 'SOAP-100G',
      nameAr: 'صابون غسيل 100 غ',
      nameEn: 'Laundry Soap 100G',
      group: 'CLEAN',
      base: pcs,
      sale: '0.450',
      purchase: '0.300',
      min: '30',
    },
    {
      code: 'PEN-BLUE',
      nameAr: 'قلم جاف أزرق',
      nameEn: 'Blue Ballpoint Pen',
      group: 'OFFICE',
      base: pcs,
      sale: '0.250',
      purchase: '0.150',
      min: '50',
    },
  ];

  const itemIds: Record<string, string> = {};
  for (const d of itemDefs) {
    const created = (await post('/items', {
      code: d.code,
      nameAr: d.nameAr,
      nameEn: d.nameEn,
      itemGroupId: groups[d.group],
      itemKind: 'STOCK',
      baseUnitId: d.base,
      units: d.units ?? [],
      salePrice: d.sale,
      purchasePrice: d.purchase,
      minStock: d.min,
    })) as { id: string };
    itemIds[d.code] = created.id;
  }
  console.log('items created:', itemDefs.length);

  // Opening stock adjustment (posts stock + journal)
  const opening = (await post('/stock-adjustments', {
    adjustmentDate: '2026-03-01',
    adjustmentType: 'OPENING',
    warehouseId: wh.id,
    description: 'جرد افتتاحي — مخزون أول المدة',
    lines: [
      { itemId: itemIds['RICE-5KG'], qty: '100', unitCost: '3.200' },
      { itemId: itemIds['OIL-15L'], qty: '60', unitCost: '2.100' },
      { itemId: itemIds['SUGAR-1KG'], qty: '80', unitCost: '0.620' },
      { itemId: itemIds['SOAP-100G'], qty: '120', unitCost: '0.300' },
      { itemId: itemIds['PEN-BLUE'], qty: '200', unitCost: '0.150' },
    ],
  })) as { id: string };
  await req(`/stock-adjustments/${opening.id}/post`, H, {});
  console.log('posted: opening stock adjustment');

  // Purchase IN
  const purchase = (await post('/stock-adjustments', {
    adjustmentDate: '2026-03-10',
    adjustmentType: 'IN',
    warehouseId: wh.id,
    description: 'شراء بضاعة — أرز وصابون',
    lines: [
      { itemId: itemIds['RICE-5KG'], qty: '50', unitCost: '3.250' },
      { itemId: itemIds['SOAP-100G'], qty: '100', unitCost: '0.310' },
    ],
  })) as { id: string };
  await req(`/stock-adjustments/${purchase.id}/post`, H, {});
  console.log('posted: purchase IN adjustment');

  // Issue OUT (sales issue)
  const issue = (await post('/stock-adjustments', {
    adjustmentDate: '2026-03-15',
    adjustmentType: 'OUT',
    warehouseId: wh.id,
    description: 'صرف بضاعة — مبيعات اليوم',
    lines: [
      { itemId: itemIds['RICE-5KG'], qty: '20' },
      { itemId: itemIds['SUGAR-1KG'], qty: '15' },
    ],
  })) as { id: string };
  await req(`/stock-adjustments/${issue.id}/post`, H, {});
  console.log('posted: issue OUT adjustment');

  // Stock count → approve (generates count adjustment if differences)
  const count = (await post('/stock-counts', {
    countDate: '2026-03-20',
    warehouseId: wh.id,
    description: 'جرد دوري — نهاية مارس',
    lines: [
      { itemId: itemIds['RICE-5KG'], countedQty: '129' }, // system has 130 → -1
      { itemId: itemIds['OIL-15L'], countedQty: '60' },
      { itemId: itemIds['SUGAR-1KG'], countedQty: '65' }, // system has 65 → 0
      { itemId: itemIds['SOAP-100G'], countedQty: '220' }, // system has 220 → 0
      { itemId: itemIds['PEN-BLUE'], countedQty: '200' },
    ],
  })) as { id: string; status?: string };
  await req(`/stock-counts/${count.id}/approve`, H, {});
  console.log('posted: stock count approved');

  console.log('inventory demo data created');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
