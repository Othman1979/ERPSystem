import { SetMetadata } from '@nestjs/common';

export const REQUIRES_IDEMPOTENCY_KEY = 'requiresIdempotencyKey';

/**
 * Marks a handler as a posting action that must carry an `Idempotency-Key`
 * header (CLAUDE.md «الترحيل», docs/BUILD_PLAN.md §10.3): /post, /reverse,
 * documents that post on creation, and allocation changes.
 *
 * The rule is attached to the matched route, not to the raw URL, so every
 * spelling Express routes to the handler (trailing slash, other letter case)
 * is covered. test/static/idempotency-routes.spec.ts fails if a posting route
 * lacks the marker.
 */
export const RequiresIdempotencyKey = () => SetMetadata(REQUIRES_IDEMPOTENCY_KEY, true);
