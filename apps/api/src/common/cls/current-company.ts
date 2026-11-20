import { ClsServiceManager } from 'nestjs-cls';
import { Prisma } from '../../generated/prisma/client.js';
import type { RequestContext } from './cls.types.js';

/**
 * ADR-040 §1: narrows a `company` lookup to the request's company (set by CompanyGuard).
 * Outside a request (Cron jobs, tests) there is none, and the lookup keeps the first company.
 */
export function currentCompanyFilter(): { id?: bigint } {
  const cls = ClsServiceManager.getClsService<RequestContext>();
  const id = cls.isActive() ? cls.get('companyId') : undefined;
  return id === undefined ? {} : { id };
}

/** SQL condition for company-owned tables; without a request company it is intentionally empty. */
export function currentCompanySqlFilter(alias?: string): Prisma.Sql {
  const id = currentCompanyFilter().id;
  if (id === undefined) return Prisma.empty;
  const column = alias ? Prisma.raw(`${alias}.company_id`) : Prisma.raw('company_id');
  return Prisma.sql`AND ${column} = ${id}`;
}
