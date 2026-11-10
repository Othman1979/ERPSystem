# ADR-002: Web routing with react-router; self-hosted Arabic font

**الحالة:** مقبول — Phase 5 (UI/UX pass)
**التاريخ:** 2026-11-09

## السياق
The web app switched screens with a `useState` in `App.tsx`. Refresh always
returned to the home screen, the browser Back button left the app, and no screen
could be bookmarked or opened in a new tab. BUILD_PLAN §3 lists the web stack
(React, Vite, Ant Design, TanStack Query, react-i18next) but names no router.

The UI also had no Arabic web font: the font stack named `Noto Kufi Arabic`
without loading it, so text fell back to whatever the OS had (Tahoma, Arial).

Options considered for routing:
1. **react-router 7** (library mode, `BrowserRouter`) — clean URLs (`/sales`),
   room for document links later (`/sales/invoices/42`). Needs one rewrite rule
   on the host.
2. A ~40-line in-house hash router — no dependency, URLs like `/#/sales`, no
   server config, but awkward once screens need nested or parameterised URLs.

## القرار
- **Routing:** `react-router` 7 in library mode. One URL per module (see
  `apps/web/src/routes.tsx`); unknown paths redirect to `/`. Guests see the login
  screen on any path and land back on that path after signing in.
- **Font:** IBM Plex Sans Arabic, self-hosted through `@fontsource/ibm-plex-sans-arabic`
  (weights 400/500/600/700), bundled by Vite — no request to Google Fonts.
  Latin text uses the same family's Latin glyphs, Segoe UI/Tahoma as fallback.
- **Colour:** keep Windows blue `#0078d4` as the primary colour (owner's choice).

## العواقب
- **Hosting:** any path the server doesn't know must return `index.html`
  (history API fallback). Vite's dev server already does this. On Hostinger /
  Apache, the production deploy needs a rewrite such as:
  `FallbackResource /index.html` (or the equivalent `.htaccess` RewriteRule),
  excluding `/api`. Add this when the deployment phase sets up static hosting.
- Bundle grows by ~20 KB (router, gzipped) and the font files (~40 KB per weight,
  Arabic subset, woff2).
- Document-level URLs (`/sales/invoices/:id`) are a follow-up; pages still keep
  their open-document state internally.
