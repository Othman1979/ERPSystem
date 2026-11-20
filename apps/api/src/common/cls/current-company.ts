import { ClsServiceManager } from 'nestjs-cls';
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
