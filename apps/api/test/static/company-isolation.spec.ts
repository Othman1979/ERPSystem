import { readFileSync } from 'node:fs';
import path from 'node:path';
import { COMPANY_MODEL_EXCLUSIONS, COMPANY_MODELS, TENANT_MODELS } from '../../src/prisma/tenant-prisma.js';
import { API_DIR } from './isolation-scan.js';

describe('Company isolation — schema coverage (ADR-040)', () => {
  it('accounts for every tenant model with a companyId field', () => {
    const schema = readFileSync(path.join(API_DIR, 'prisma', 'schema.prisma'), 'utf8');
    const companyModels = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter((match) => /^\s+companyId\s/m.test(match[2]))
      .map((match) => match[1])
      .filter((model) => (TENANT_MODELS as readonly string[]).includes(model));
    const accountedFor = [...COMPANY_MODELS, ...COMPANY_MODEL_EXCLUSIONS].sort();

    expect(accountedFor).toEqual(companyModels.sort());
    expect(COMPANY_MODEL_EXCLUSIONS).toEqual(['MembershipCompany']);
  });
});
