/**
 * Response shapes of the parties routes (PLAT-15). They describe what
 * PartiesService returns today; nothing here changes a body.
 */
import { PartyRow } from '../../../common/openapi/prisma-models.js';

/** A party: every column of `parties` (PartiesService.get, list items). */
export class PartyDto extends PartyRow {}
