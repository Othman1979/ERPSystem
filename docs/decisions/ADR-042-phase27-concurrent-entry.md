# ADR-042 — Phase 27: Concurrent document entry

**Status:** Accepted  
**Date:** 2026-11-21

## Context

Long-running entry work must survive navigation away from the form, and users must not overwrite one another's edits. Phase 27 is delivered in three pull requests.

## Decision

### PR A — quick-create and local drafts

Journal entries, receipts, payments, and sales/purchase invoices can create missing accounts, parties, or items in place when the user's role has the corresponding create permission. New unsaved entry forms are autosaved in user-, tenant-, company-, and screen-scoped browser storage. The user can restore or discard an unexpired draft; saved documents are never restored as new drafts. Dirty forms warn before browser close or explicit navigation.

### PR B — edit locks

The document is locked for whoever opened it first. A holder is identified by `(userId, holderToken)`, where the UUID token is stored in per-tab `sessionStorage`. A lock is unique by tenant, company, document type, and document id. Edit calls must present the holder token; a successful edit deletes the lock in the same transaction. Other mutations that can invalidate the editor are rejected while a different holder has a live lease. Members with `document.unlock` can force-release a lock, with the actor and previous holder written to the audit log.

Leases last 120 seconds and the browser renews them every 30 seconds. All expiry comparisons and lease timestamps use MariaDB `NOW(3)`. The application is hosted on Hostinger Web/Cloud, which does not provide inbound WebSockets and has a 120-second request limit. A short database lease and bounded heartbeat requests therefore fit the deployment constraints without a daemon or external coordination service.

### PR C — freshness and presence (implemented)

Document lists poll every 30 seconds while visible; document details poll only on view screens. Lock status polls every 15 seconds and refreshes when the page regains focus. Remote and grid pickers refresh their options on open when the cached data is older than 10 seconds. The existing focus refresh in `main.tsx` remains in place, and sales e-invoice processing keeps its faster four-second refresh.

## Consequences

Local drafts are recovery aids, not a replacement for server-side document state or authorization. A browser tab that loses its lease cannot save until it reacquires a lock, and its in-memory draft remains available.

List rows do not show lock icons. WebSockets are not used; they would require moving the application to a VPS with inbound WebSocket support.
