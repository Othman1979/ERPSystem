/**
 * Response shapes of the cost-centre routes (ADR-023): the Prisma row, as
 * CostCentersService returns it.
 */
import { CostCenterRow } from '../../../common/openapi/prisma-models.js';

/** A cost centre: every column of `cost_centers` (CostCentersService.list, create, update). */
export class CostCenterDto extends CostCenterRow {}
