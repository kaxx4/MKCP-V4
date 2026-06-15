# PRD: MK Cycles Web Dashboard (Near-Clone of Electron App)

**Status:** v3 (auth-less, exhaustive)
**Author:** Engineering
**Last Updated:** 2026-05-25
**Source of truth:** Electron dashboard at `mkcycles-dashboard/src/*` + Supabase project `vmkytsytxlofjyeotmgb`
**Goal:** Build a Next.js web companion to the Electron dashboard, reading/writing the same Supabase backend, with two exceptions: Tally XML import/push remains in Electron, and there is **no login / no per-user identity** — the web app is treated as a single shared workspace.

---

## Part 0 — How to use this document

This PRD is structured to be **read top-to-bottom once** and then **referenced per page**. The intent is that an engineer who has never seen the Electron app can rebuild the web equivalent of any single page by reading only that page's section plus Parts 2 and 3.

Each page section includes:
1. **Route** + **Source file** (Electron path) so you can A/B against the original.
2. **Purpose** in one sentence.
3. **Layout** — top-to-bottom DOM order.
4. **Components used** — both shared (Part 3.3) and page-local.
5. **Data sources** — every store / engine / query the page reads.
6. **Supabase tables** — what to READ vs WRITE in the web port.
7. **Interactions** — every clickable affordance, keyboard shortcut, drag/drop.
8. **Filters / Sorting / Search** — the live state that affects the visible list.
9. **Modals** — full spec for any in-page modal.
10. **Mobile vs desktop** — responsive behavior.
11. **Edge cases** — empty / loading / error / boundary inputs.

For every formula or sign convention referenced (current stock, monthly buckets, discount tiers, AR/AP outstanding, etc.) the canonical source is [ENGINE_FORMULAS_FOR_WEB.md](../ENGINE_FORMULAS_FOR_WEB.md). Do not reimplement; reuse the rules in that document verbatim.

---

## Part 1 — Overview

### 1.1 Summary

The MK Cycles Electron dashboard already syncs every user-edited piece of state to Supabase (Postgres). This PRD describes a **Next.js 15 web app** that reads/writes the same Supabase project, replicating every page in the Electron app with the same UI, the same data flows, and the same business logic.

Two things stay in Electron, by design:
- **Tally XML import** (the local machine talks to Tally Prime on port 9000 over XML; the web cannot reach that machine).
- **Push to Tally** (same reason).

Everything else — config (discount rules, order groups, vendor groups, item categories, unit/rate overrides, calling list, voucher overrides, app settings), inventory reports, financial dashboards, calendar, distance lookups, route planning — is editable from both clients with last-write-wins on `updated_at`.

### 1.2 No-Auth Model (explicit)

The web app **does not implement login, signup, role gating, or user identity**.

- The deployed URL is the access boundary. Whoever knows the URL can use the app. Protect with **IP allowlist on Vercel**, **VPN**, or a single shared password gate at the edge (e.g. Vercel Password Protection / Cloudflare Access) — outside the app's code.
- The web app reads via Supabase's **anon key** under permissive RLS (`USING (true)` on every table the web reads). It writes through Next.js **Route Handlers / Server Actions** that use the **service role** server-side (never shipped to the browser).
- There is only one company in the system today: `"M.K.CYCLES (P) LTD."`. The `company` column on every config table is filled with that string by the server. The web does not pass a `company` filter from the client — the server derives it from `process.env.COMPANY_NAME`.
- The `audit_log` table records writes with `at` (timestamp) and `client_ip` only — no `user_id`, no `actor`. If you later need attribution, add a header-derived identifier (`X-Forwarded-User` from a future auth proxy); the schema is forward-compatible.
- No "Settings → Team" page. No invitations. No role-based hides.

**Consequence:** every visitor sees the same data and can perform the same edits. This is acceptable because the current operating mode of the business is a single trusted operator. If that changes, layer Supabase Auth + RLS on top (see Part 13 Future Auth Migration).

### 1.3 Goals & Non-Goals

**Goals**
1. Visual + behavioral near-clone of the Electron app — same Tailwind tokens, same component classes, same KPI cards, same modal patterns.
2. Multi-device, multi-browser, no install.
3. Real-time co-edit (Electron ↔ web) via Supabase Realtime — a change in the desktop app appears in the browser within ~500ms.
4. Mobile-first for the calling-list / outreach flow.
5. Reuse pure code (`engine/discounts.ts`, `engine/financial.ts`, `engine/inventory.ts`, `utils/format.ts`, `utils/auditPriceList.ts`, `data/stationData.ts`) by importing from a shared workspace package (`packages/shared`) consumed by both `apps/electron` and `apps/web`.
6. Reuse design tokens by copying `src/index.css` verbatim into `apps/web/app/globals.css`.

**Non-Goals**
1. Replace Electron. Tally XML import stays in Electron.
2. Push to Tally from the web (out of scope for v1; revisit only when Tally exposes an HTTP API).
3. Real-time inventory recompute over millions of voucher rows in the browser → use server-side materialized views (Part 2.5).
4. Offline-first. Electron keeps offline via IndexedDB; web requires connectivity.
5. Per-user auth, per-user roles, per-user audit trails (see no-auth model).

### 1.4 Users & Use Cases

| Persona | Primary device | Top tasks |
|---|---|---|
| **Owner / Director** | Desktop + phone | Dashboard KPIs, Reports, edit discount rules |
| **Sales Manager** | Desktop | Orders, Discounts, vendor groups, pending deliveries |
| **Field Sales** | Phone | Outreach calling list, party-wise pending orders, WhatsApp share, tel: links |
| **Accountant** | Desktop | Ledgers, Invoices, reconcile against Tally |

All personas land on the **same URL** with **the same permissions** in v1. Whoever is on the device is the operator.

### 1.5 Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | **Next.js 15 (App Router)** | RSC for fast first paint, Server Actions for writes, file-based routing |
| Language | TypeScript (strict) | Same as Electron |
| UI | **Tailwind CSS + shadcn/ui (selectively)** | Same tokens — copy `src/index.css`. shadcn only for primitives not already styled (Tooltip, Dialog primitive, Command). |
| Data — read | **`@supabase/supabase-js` v2** + anon key | Public reads under permissive RLS |
| Data — write | **Next.js Server Actions / Route Handlers** + service role | Service key never reaches the browser |
| Real-time | **Supabase Realtime** (postgres_changes) | Cross-client live updates |
| Server cache | **TanStack Query v5** | `staleTime`, optimistic updates, mutation rollback |
| Client state | **Zustand** | Same library as Electron for stores that hold purely UI state (sidebar collapsed, unitMode toggle, active tab) |
| Tables | **TanStack Table v8 + `@tanstack/react-virtual`** | Same `useVirtualizer` already used in Orders/Alerts/Invoices |
| Charts | **Recharts** | Same lib as Electron |
| Maps | **Leaflet (react-leaflet)** dynamic-imported `ssr:false` | Same lib as Electron |
| Excel | **xlsx (SheetJS)** | Order export, unit config Excel |
| PDF | **jsPDF + jspdf-autotable** | Already a dep in Electron for sales PDF |
| Hosting | **Vercel** | Edge-deployed, preview-per-PR |
| Access gate | **Vercel Password Protection** OR **Cloudflare Access** | Outside the app; not in code |

### 1.6 Repo Layout

Recommend a **pnpm + Turborepo monorepo** (so engine and components are shared between Electron and web, not duplicated):

```
mkcycles/
├── apps/
│   ├── electron/                       # current src/ moves here, no behavior change
│   └── web/                            # Next.js 15 app
│       ├── app/
│       │   ├── (dashboard)/
│       │   │   ├── dashboard/page.tsx
│       │   │   ├── orders/page.tsx
│       │   │   ├── … (one per route)
│       │   ├── api/
│       │   │   ├── distance/route.ts   # NIC e-Waybill proxy
│       │   │   ├── config/route.ts     # write proxy → service-role
│       │   ├── layout.tsx
│       │   ├── globals.css             # copied from src/index.css
│       ├── components/                 # web-only wrappers (Server vs Client)
│       ├── lib/
│       │   ├── supabase-browser.ts     # anon client
│       │   ├── supabase-server.ts      # service-role client (server-only)
│       │   ├── queries.ts              # TanStack Query hooks
│       ├── next.config.mjs
│       └── package.json
├── packages/
│   └── shared/                         # exported from both apps
│       ├── engine/
│       │   ├── discounts.ts            # COPIED VERBATIM from src/engine/discounts.ts
│       │   ├── financial.ts
│       │   ├── inventory.ts
│       │   ├── unitEngine.ts
│       │   └── audit/movementTracer.ts
│       ├── components/                 # KPICard, RatePill, AmountPill, ColorPicker, …
│       ├── utils/                      # fmtINR, fmtDate, fmtRate, fmtLakh, auditPriceList, gstInference
│       ├── data/                       # stationData.ts, vendorGroups.ts, discountDefaults.json, defaultOrderGroups.json
│       └── types/                      # canonical.ts + supabase-generated.ts
├── turbo.json
└── pnpm-workspace.yaml
```

The current Electron codebase becomes `apps/electron`. Its pages stay where they are; only their `import` paths change from `../engine/discounts` to `@mkcp/shared/engine/discounts` (where `@mkcp/shared` is the workspace name of `packages/shared`).

---

## Part 2 — Architecture

### 2.1 Data Model — Supabase (already exists)

The web app uses **the same tables the Electron app already syncs to**, plus a few new ones for web-only behavior.

**Existing — read-only for web (Tally-sourced via Electron):**

| Table | Key fields |
|---|---|
| `tally_companies` | `name`, `imported_at`, `fy_start_month` |
| `tally_stock_items` | `item_id`, `name`, `group`, `base_unit`, `pkg_unit`, `units_per_pkg`, `opening_balance`, `opening_rate`, `closing_balance`, `closing_rate`, `gst_rate`, `dealer_prices` (jsonb) |
| `tally_ledgers` | `ledger_id`, `name`, `group`, `opening_balance`, `gstin`, `state`, `pincode`, `credit_days` |
| `tally_stock_groups`, `tally_units`, `tally_godowns`, `tally_cost_centres`, `tally_price_lists` | Standard masters |
| `tally_vouchers` | `voucher_id`, `voucher_number`, `date`, `voucher_type`, `is_cancelled`, `is_optional`, `total_amount`, `party_name`, `party_ledger_id`, `narration` |
| `tally_voucher_ledger_entries` | `voucher_id`, `ledger_id`, `is_debit`, `amount`, `bill_allocations` (jsonb) |
| `tally_voucher_inventory_entries` | `voucher_id`, `item_id`, `qty_base`, `rate_per_base`, `line_amount` |
| `tally_sync_history` | `id`, `started_at`, `completed_at`, `success`, `row_counts` (jsonb) |

**Existing — read/write from web (migrations 001 + 003 + 006–008):**

| Table | Used by |
|---|---|
| `discount_rules` (id TEXT, conditions jsonb={tiers,groupRules}) | Discount Rules page |
| `order_groups` | Orders sidebar |
| `unit_overrides` | Edit Units |
| `rate_overrides` | Edit Units / Price List |
| `item_category_overrides` | Discount Rules → Item Assignments |
| `category_colors` | Discount Rules color picker |
| `vendor_group_assignments` | Orders, Vendor Groups |
| `item_notes` | Item detail drawer |
| `calling_list_entries` | Outreach |
| `tally_price_list_imports` | Price List (Tally JSON upload) |
| `voucher_overrides` | Calendar (status, scheduled_date, notes, follow_ups jsonb) |
| `app_settings` | Settings — key/value bag (unitMode, fyYear, coverMonths, leadTimeMonths, defaultCreditDays, etc.) |
| `order_draft_lines` | Orders — current in-progress draft |

**NEW — required for web-specific functionality:**

| Table | Purpose |
|---|---|
| `audit_log` | Every config-table write: `id`, `table_name`, `row_id`, `action` (insert/update/delete), `before` (jsonb), `after` (jsonb), `at`, `client_ip` |
| `pincode_distances` | Distance page cache: `from_pin`, `to_pin`, `distance_km`, `fetched_at` |
| `ledger_pincode_overrides` | Distance page manual PINs: `ledger_id`, `pincode_override` |
| `sync_logs` | Replacement for Electron's ServerLogs SSE: `id`, `sync_id`, `timestamp`, `level`, `message` |

Migration file naming convention: `migrations/009_audit_log.sql`, `010_pincode_cache.sql`, `011_sync_logs.sql`. Use idempotent `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS`. End each migration with `NOTIFY pgrst, 'reload schema';` to refresh PostgREST.

### 2.2 No-Auth RLS Policy Pattern

Every table the **browser reads directly** (via anon key) needs a permissive SELECT policy:

```sql
-- Drop the existing service-role-only SELECT policy (writes stay service-role only)
DROP POLICY IF EXISTS "Service role can read discount rules" ON discount_rules;

CREATE POLICY "Anon read discount rules" ON discount_rules
  FOR SELECT USING (true);

-- Keep service-role write policy (writes go through server actions)
-- (already present from migration 001)
```

For tables that the browser **writes to**, the browser never writes directly — it calls a Server Action / Route Handler. Server uses the service-role client, which bypasses RLS by design.

**Tables to add anon-SELECT policy to:** every table in the two "Existing" lists above plus the four new tables (except `audit_log`, which is server-only).

**`audit_log` policy:** SELECT for service-role only; the Sync Logs page reads it through a Server Action that paginates.

### 2.3 Network Boundary

```
Browser  ──anon key + RLS──►  Supabase (read tables, subscribe Realtime)
   │
   │  ──fetch /api/config──►  Next.js Server Action
   │                              │
   │                              └──service-role key──►  Supabase (writes)
   │                                       │
   │                                       └──insert audit_log row
   │
   └──fetch /api/distance──►  Next.js Route Handler  ──►  ewaybillgst.gov.in
```

**The service-role key is never sent to the browser.** It lives only in `process.env.SUPABASE_SERVICE_KEY` and is read inside `apps/web/lib/supabase-server.ts`, which is server-only and not importable from client components.

The currently leaked service-role key at `server/src/services/supabaseSync.ts:13-14` **must be rotated** in the Supabase dashboard before any public deploy.

### 2.4 Server Action / Route Handler shape

```ts
// apps/web/app/api/config/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase-server';

export async function POST(req: NextRequest) {
  const { table, row, action } = await req.json();
  const sb = getServerSupabase();
  const company = process.env.COMPANY_NAME ?? 'M.K.CYCLES (P) LTD.';

  // Validate table name against allow-list (prevents arbitrary writes)
  const ALLOWED = new Set([
    'discount_rules', 'order_groups', 'unit_overrides', 'rate_overrides',
    'item_category_overrides', 'category_colors', 'vendor_group_assignments',
    'item_notes', 'calling_list_entries', 'tally_price_list_imports',
    'voucher_overrides', 'app_settings', 'order_draft_lines',
    'ledger_pincode_overrides',
  ]);
  if (!ALLOWED.has(table)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const before = await sb.from(table).select('*').eq('company', company).eq('id', row.id).single();
  const result = action === 'delete'
    ? await sb.from(table).delete().eq('company', company).eq('id', row.id)
    : await sb.from(table).upsert({ ...row, company, updated_at: new Date().toISOString() });

  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });

  await sb.from('audit_log').insert({
    table_name: table,
    row_id: row.id,
    action,
    before: before.data ?? null,
    after: action === 'delete' ? null : row,
    at: new Date().toISOString(),
    client_ip: req.headers.get('x-forwarded-for') ?? null,
  });

  return NextResponse.json({ ok: true });
}
```

TanStack Query mutations call this endpoint and invalidate on success.

### 2.5 Recommended Materialized Views

Computing inventory + financial aggregates over thousands of vouchers in the browser is exactly what kills the Electron app. The web port should push this to materialized views that refresh after every Tally sync.

| View | Refresh trigger | Drives |
|---|---|---|
| `mv_monthly_revenue_purchase(month, sales_total, purchase_total)` | After `syncVouchers` (call `REFRESH MATERIALIZED VIEW CONCURRENTLY`) | Dashboard sales chart, Reports Financial tab |
| `mv_monthly_cash_flow(month, receipts, payments, running_balance)` | Same | Reports Expense tab |
| `mv_item_sales_velocity(item_id, qty, revenue, period_start, period_end)` | Same | Reports Sales tab |
| `mv_expense_by_ledger(period_start, period_end, ledger_id, ledger_name, group, amount, pct_of_total)` | Same | Reports Expense tab |
| `mv_current_stock(item_id, current_stock, stock_value, status)` | Same | Dashboard, Alerts, Reports Inventory tab |
| `mv_outstanding_invoices(voucher_id, party_name, outstanding, aging_bucket)` | Same | Dashboard, Invoices, Reports |
| `mv_item_margins(item_id, avg_sales_rate, avg_purchase_rate)` | Same | Price List, Invoices price verification |
| `mv_low_stock_items(item_id, suggested_reorder, avg_monthly_outward)` | Same | Dashboard, Alerts |
| `mv_party_outreach_stats(party_ledger_id, total_revenue, order_count, last_order_date, predicted_next_order, churn_risk, tier)` | Nightly cron | Outreach |
| `mv_ledger_transactions(ledger_id, voucher_id, date, voucher_type, debit, credit)` | After `syncVouchers` | Ledgers page (avoid full-scan per selection) |
| `mv_pending_delivery_notes_with_readiness(voucher_id, … , ready bool)` | After `syncVouchers` | Pending Orders page |

The SQL for each view derives directly from the formulas in [ENGINE_FORMULAS_FOR_WEB.md](../ENGINE_FORMULAS_FOR_WEB.md) Parts 1–2. Write each as a Postgres function or view; do **not** invent new logic — paste the formula, parameterize, ship.

Refresh hook lives in `server/src/services/supabaseSync.ts` after `syncVouchers` completes:
```ts
await this.client.rpc('refresh_dashboard_views');
```
where `refresh_dashboard_views()` is a SECURITY DEFINER plpgsql that issues `REFRESH MATERIALIZED VIEW CONCURRENTLY` for each view.

### 2.6 Schema Drift Protection

Both Electron and Next.js apps import generated TypeScript types from:

```bash
supabase gen types typescript --project-id vmkytsytxlofjyeotmgb > packages/shared/types/supabase-generated.ts
```

Wire this to a `prebuild` script. Run it manually after every migration and commit the result. The CanonicalDataset type (`packages/shared/types/canonical.ts`) layers app-level shape on top of these.

---

## Part 3 — Cross-Cutting Concerns (Shared UI Surface)

These pieces are used by every page and must be built once before any page work begins.

### 3.1 Layout & Navigation

Implemented in `src/components/Layout.tsx` + `NavBar.tsx`. Clone:

**Layout shell:**
- Root `<div className="min-h-screen bg-neutral-100 text-neutral-950 font-sans">`
- Skip-to-content link at the top (`<a href="#main-content" className="skip-to-content">Skip to content</a>`)
- `<NavBar />` (sidebar on desktop, bottom bar on mobile)
- `<main id="main-content">` with conditional left margin:
  - Mobile: `ml-0 pb-16` (bottom-nav clearance)
  - Desktop sidebar open: `ml-[220px]`
  - Desktop sidebar collapsed: `ml-14`
- Inner padding: `mx-auto max-w-screen-2xl p-3 pt-4` (mobile) or `p-4 lg:p-5` (desktop)

**Mobile/desktop detection:** in `apps/web/components/Layout.tsx`, use a single client component that calls `window.matchMedia("(max-width: 767px)")` inside `useEffect` and writes to a Zustand `useUIStore.isMobile`. Same pattern as Electron — see [Layout.tsx](../src/components/Layout.tsx).

**NavBar — Desktop sidebar (220px / 56px collapsed):**
- Logo + "MK Cycles" wordmark (hidden when collapsed)
- Nav items list (15 items):
  - `/dashboard` (LayoutDashboard) — replaces `/` redirect
  - `/orders` (ShoppingCart)
  - `/alerts` (AlertTriangle)
  - `/invoices` (FileText)
  - `/pending-orders` (Truck)
  - `/price-list` (Tag)
  - `/routes` (Map)
  - `/reports` (BarChart2)
  - `/calendar` (CalendarDays)
  - `/discounts` (Percent)
  - `/edit` (Pencil) — "Edit Units"
  - `/ledgers` (BookOpen)
  - `/distance` (Navigation2)
  - `/settings` (Settings)
  - `/sync-logs` (Terminal) — REPURPOSED from Electron's ServerLogs to read `sync_logs` Supabase table
- Each link: `flex items-center gap-3 px-2.5 py-2 rounded-lg min-h-10 active:scale-[0.96] transition-[background-color,color,transform]`. Active: `bg-accent/8 text-accent font-medium`.
- **Removed in web:** `/import` (Electron-only — Tally is single-machine). Replace its sidebar slot with a **"Last Sync" pill** linking to Settings → Sync History. Pill shows relative time ("5 min ago" / "2 hours ago" / "Never") reading `tally_sync_history.completed_at`.
- **Removed in web:** "Sync Today" button. Tally lives in Electron only.
- Tally connection status NavLink at bottom (Wifi/WifiOff icon) — **in web: replace with "Electron last seen N hours ago"** from latest `tally_sync_history` row.
- Collapse toggle (ChevronLeft).

**NavBar — Mobile bottom tab bar:**
- First 5 nav items (Dashboard, Orders, Alerts, Invoices, Outreach) as bottom tabs
- 6th button "More" (`MoreHorizontal`) → opens bottom-sheet with remaining items
- Bottom sheet: `role=dialog aria-modal`, `rounded-t-2xl`, slide-up animation, drag handle, close X, list of overflow nav items, "Last sync" indicator at bottom

### 3.2 Toast / Notification System

Implemented in `src/components/Toast.tsx`. Provider wraps the app shell at `apps/web/app/layout.tsx`.

- `ToastProvider` exposes `useToast()` returning `toast(message, type)`.
- 4 types: `success` / `error` / `warn` / `info`. Each has its own border + bg tint + icon (CheckCircle / XCircle / AlertTriangle / Info) + iconColor.
- Auto-dismiss after 4 seconds.
- Stack position: `fixed bottom-4 right-4 z-50`, `flex flex-col gap-2 max-w-sm`.
- Each toast: white bg, colored border, icon + message + X dismiss button (40×40 hit area).
- Animation: `animate-slide-in` on enter, fade-out on dismiss.
- `role="region" aria-label="Notifications"` on container; `role="alert"` per toast.

### 3.3 Shared Components Catalog

Build these once in `packages/shared/components`; every page uses them:

| Component | File | Reuse strategy |
|---|---|---|
| `KPICard` | `components/KPICard.tsx` | **Copy 1:1** — pure, no Electron deps. Props: `title, value, sub, icon, trend, accent, danger`. |
| `KPISkeleton` | `components/KPISkeleton.tsx` | **Copy 1:1.** Shimmer placeholder while data loads. |
| `ErrorCard` | `components/ErrorCard.tsx` | **Copy 1:1.** Used inside ErrorBoundary fallback. |
| `ErrorBoundary` | `components/ErrorBoundary.tsx` | **Copy 1:1.** `window.location.reload()` retry. |
| `ColorPicker` | `components/ColorPicker.tsx` | **Copy 1:1.** 12 preset hex colors + manual hex input. |
| `RatePill`, `AmountPill`, `priceMatches`, `PRICE_TOLERANCE=0.01` | `components/PriceVerification.tsx` | **Copy 1:1.** Three-part pill (billed value + icon + ref value). Hover-toggle tooltip explaining match/mismatch with %. `isTotal` boolean enlarges for totals row. |
| `UnitToggle` | `components/UnitToggle.tsx` | **Copy 1:1.** Pill toggle BASE ↔ PKG. |
| `GroupTabs` | `components/GroupTabs.tsx` | **Copy 1:1.** Horizontal scroll pills for order groups with left/right scroll buttons. |
| `VendorGroupsSummary` | `components/VendorGroupsSummary.tsx` | **Copy 1:1.** Vendor-aggregated stats card. |
| `ExpandedGroupsView` | `components/ExpandedGroupsView.tsx` | **Copy 1:1.** Full-detail order groups grid. |
| `Toast`, `ToastProvider`, `useToast` | `components/Toast.tsx` | **Copy 1:1.** |

**Concentric border radius reminder:** when nesting cards, outer radius = inner radius + padding. The shared classes (`.card`, `.bento-card`, `.section-card`) already obey this; preserve it in new compositions.

### 3.4 Design Tokens

**Strategy:** copy `src/index.css` verbatim into `apps/web/app/globals.css`. It defines all utility classes the pages use:

- `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`, `.btn-accent-ghost`, `.btn-icon`, `.btn-sm`
- `.card`, `.card-elevated`, `.card-interactive`, `.bento-card`, `.bento-grid`, `.section-card`
- `.page-title`, `.page-subtitle`, `.section-header`, `.metric-value`, `.metric-label`, `.kpi-value`, `.kpi-label`
- `.form-input`, `.form-select`, `.search-input`, `.form-textarea`
- `.badge`, `.badge-success`, `.badge-danger`, `.badge-warn`, `.badge-muted`, `.status-badge`
- `.alert`, `.alert-info`, `.alert-success`, `.alert-warn`, `.alert-danger`
- `.table-header`, `.table-header-sticky`, `.table-cell`, `.responsive-table-row`
- `.modal-overlay`, `.modal-content`, `.modal-header`, `.modal-body`, `.modal-footer`
- `.tab-list`, `.tab-item`, `.tab-item-active`, `.tab-pill`, `.filter-chip`
- `.num-positive`, `.num-negative`, `.num-highlight`, `.num-muted` (with `tabular-nums`)
- Animation keyframes: `slideIn`, `slideUp`, `fadeUp`, `fadeIn`, `modalPop`, `shake`, `shimmer`
- `.skip-to-content`, `.tabular-nums`

**Color palette:** `accent` (blue), `success` (green), `danger` (red), `warn` (amber), `info` (cyan), `neutral`. Documented in [BRAND_COLORS.md](BRAND_COLORS.md).

**Font smoothing:** root layout applies `-webkit-font-smoothing: antialiased` (`<html className="antialiased">`). Tabular numbers on every dynamic number element via `tabular-nums`.

### 3.5 Data Hook Pattern (TanStack Query)

Replace Zustand's `useDataStore.data` (hydrated from IndexedDB in Electron) with TanStack Query hooks:

```ts
// apps/web/lib/queries.ts
import { useQuery } from '@tanstack/react-query';
import { getBrowserSupabase } from './supabase-browser';

export function useDataset() {
  const sb = getBrowserSupabase();
  return useQuery({
    queryKey: ['dataset'],
    queryFn: async () => {
      const [items, ledgers, company, vouchers, vLedgers, vInv] = await Promise.all([
        sb.from('tally_stock_items').select('*'),
        sb.from('tally_ledgers').select('*'),
        sb.from('tally_companies').select('*').limit(1).single(),
        sb.from('tally_vouchers').select('*'),
        sb.from('tally_voucher_ledger_entries').select('*'),
        sb.from('tally_voucher_inventory_entries').select('*'),
      ]);
      // Stitch into CanonicalDataset shape — same as Electron's dataStore.deserializeParsedData
      return shapeCanonicalDataset({ items, ledgers, company, vouchers, vLedgers, vInv });
    },
    staleTime: 5 * 60 * 1000, // 5 min — Tally sync runs less frequently
    refetchOnWindowFocus: true,
  });
}

export function useOrderGroups() {
  const sb = getBrowserSupabase();
  return useQuery({
    queryKey: ['order_groups'],
    queryFn: () => sb.from('order_groups').select('*').order('updated_at', { ascending: false }).then(r => r.data ?? []),
    staleTime: 30 * 1000,
  });
}

export function useDiscountRules() {
  const sb = getBrowserSupabase();
  return useQuery({
    queryKey: ['discount_rules'],
    queryFn: () => sb.from('discount_rules').select('*').then(r => r.data ?? []),
    staleTime: 30 * 1000,
  });
}

// … one hook per config table
```

For pages that only need a slice (e.g. just vouchers in a date range), prefer **scoped queries** over loading the whole dataset:

```ts
export function useVouchersInRange(from: string, to: string) {
  const sb = getBrowserSupabase();
  return useQuery({
    queryKey: ['vouchers', from, to],
    queryFn: () => sb.from('tally_vouchers').select('*').gte('date', from).lte('date', to).then(r => r.data ?? []),
    staleTime: 60 * 1000,
  });
}
```

Materialized-view-backed queries (e.g. `mv_outstanding_invoices`) have `staleTime: 5 * 60 * 1000` since they only refresh on sync.

### 3.6 Mutation Pattern

```ts
// apps/web/lib/mutations.ts
export function useUpsertOrderGroup() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (group: OrderGroup) => {
      const res = await fetch('/api/config', {
        method: 'POST',
        body: JSON.stringify({ table: 'order_groups', row: group, action: 'upsert' }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      return res.json();
    },
    onMutate: async (group) => {
      // Optimistic update
      await qc.cancelQueries({ queryKey: ['order_groups'] });
      const prev = qc.getQueryData<OrderGroup[]>(['order_groups']) ?? [];
      qc.setQueryData(['order_groups'], [group, ...prev.filter(g => g.id !== group.id)]);
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['order_groups'], ctx.prev);
      toast('Failed to save order group', 'error');
    },
    onSuccess: () => {
      toast('Saved', 'success');
      qc.invalidateQueries({ queryKey: ['order_groups'] });
    },
  });
}
```

### 3.7 Real-time Subscriptions

Per page, set up Supabase Realtime channels on the tables that page reads, so a teammate's change (or an Electron sync) appears within ~500ms:

```tsx
// apps/web/lib/realtime.ts
export function useTableRealtime(table: string, queryKey: any[]) {
  const sb = getBrowserSupabase();
  const qc = useQueryClient();
  useEffect(() => {
    const ch = sb.channel(`${table}_changes`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, () => {
        qc.invalidateQueries({ queryKey });
      })
      .subscribe();
    return () => { sb.removeChannel(ch); };
  }, [table, queryKey, sb, qc]);
}
```

**Subscription map (page → tables):**

| Page | Tables to subscribe |
|---|---|
| Orders | `order_groups`, `vendor_group_assignments`, `order_draft_lines` |
| Outreach | `calling_list_entries` |
| Calendar | `voucher_overrides` |
| Discounts / DiscountRules | `discount_rules`, `category_colors`, `item_category_overrides` |
| Edit Units | `unit_overrides` |
| Price List | `tally_price_list_imports` |
| Distance | `ledger_pincode_overrides`, `pincode_distances` |
| Settings | `app_settings`, `tally_sync_history` |
| Sync Logs | `sync_logs` (INSERT only) |
| Dashboard / Invoices / Reports / Ledgers / Pending Orders / Alerts | none on config — but invalidate the Tally dataset whenever `tally_sync_history` gets a new row with `success=true` |

### 3.8 Engine Reuse — Hard Rule

Every formula referenced from the page specs below is **defined exactly once** in [ENGINE_FORMULAS_FOR_WEB.md](../ENGINE_FORMULAS_FOR_WEB.md). Do not duplicate the math in the page sections. Page specs say "use [Engine §1.1 Current Stock]" and the implementer opens that section.

The shared package `packages/shared/engine/*` provides the executable version of every formula:

| Engine module | Functions |
|---|---|
| `engine/inventory.ts` | `getCurrentStockIndexed`, `avgMonthlyOutwardIndexed`, `suggestedReorderIndexed`, `computeMonthlyBucketsIndexed`, `buildVoucherIndex`, `computeItemTurnover`, `computeABCXYZ`, `computePeriodComparison` |
| `engine/financial.ts` | `computeOutstandingInvoices`, `computeBankBalance`, `monthlyTotals`, `computeItemMargins` |
| `engine/discounts.ts` | `calculateVoucherDiscount`, `DEFAULT_DISCOUNT_CATEGORIES`, `DEFAULT_ITEM_CATEGORY_MAP`, `DEFAULT_GROUP_RULES` (defaults seeded from `data/discountDefaults.json`) |
| `engine/unitEngine.ts` | `toDisplay`, `fromDisplay` |
| `engine/audit/movementTracer.ts` | `getItemMovements`, `getItemOrderDocs` |

Do not modify any of these. The web port consumes them as-is.

---

## Part 4 — Page Specifications (Exhaustive, Per-Page)

> Every page in the Electron app, replicated with the same layout, components, interactions, edge cases. Cite the original file path so reviewers can A/B against the source. Pages marked **READ-ONLY** in v1 don't need write logic. Pages marked **NOT APPLICABLE** are skipped or replaced.

---

### Page: Dashboard
**Route:** `/dashboard` (also serves `/`)
**Source:** [src/pages/Dashboard.tsx](../src/pages/Dashboard.tsx)
**Purpose:** Landing page providing financial + operational overview — latest-day and current-month sales, AR/AP, cash position, stock value, sales-trend chart, top items, low-stock alerts. Navigation hub.

#### Layout (top → bottom)
1. **Empty state** (when no dataset): 64×64 muted icon, h2 "No Data Loaded", description "Tally sync hasn't run yet — open the Electron app on the Tally machine to import data." Button "Open Sync Logs" → `/sync-logs`.
2. **Page Header**:
   - Left: `h1.page-title` = `data.company.name` or "Dashboard". Subtitle: `${items.size} items · ${vouchers.length} vouchers · ${periodLabel} · Synced ${fmtDate(lastSyncAt)}`.
   - Right: pill segmented control with 5 options: **All / Month / Quarter / FY / Custom**. Active = white pill with `shadow-sm` on neutral-100 background. When "Custom" selected, two `<input type="date">` (from/to) with "to" separator appear.
3. **KPI Grid** — `.bento-grid` of 4 `KPICard`s:
   - "Sales (latestDate)" — accent, `TrendingUp` icon
   - "Month Sales" — `ShoppingCart` icon
   - "Cash + Bank" — `DollarSign` icon
   - "Stock Value" — `Package` icon
4. **AR / AP Cards** — 2-col grid, each `.card-interactive` → `/invoices`:
   - Left: green icon tile + "Receivable" label + green AR value
   - Right: red icon tile + "Payable" label + red AP value
5. **Charts Row**:
   - **Sales Trend** card with `<select>` (3 / 6 / 12 / 24 months, default 6). Recharts `BarChart`, X = month label, Y = amount in lakhs (`fmtLakh`), tooltip shows `fmtINR`, bars `#2563eb`, radius `[4,4,0,0]`, `barSize 28`.
   - **Top Items (by Qty)** card with `<select>` (This month / Last 3 months / Last 12 months). Horizontal `BarChart`, green bars `#16a34a`, Y category truncated to 110px. Empty: "No sales this period".
6. **Low Stock Alert Card** (only if items exist) — `border-l-4 border-l-warn`, header `bg-warn/[0.04]` with `AlertCircle` + "Low Stock Items" + "View All →" → `/alerts`. Up to 5 items: name (truncate 32) + Stock badge (sm+) + Avg/mo (md+) + Reorder amber badge.

#### Components used
- `KPICard`, lucide `TrendingUp, DollarSign, Package, AlertCircle, ShoppingCart, ArrowRight, Calendar`, recharts `BarChart / Bar / XAxis / YAxis / CartesianGrid / Tooltip / ResponsiveContainer`.

#### Data sources
- `useDataset()` (TanStack Query) → CanonicalDataset
- Engine: see ENGINE_FORMULAS_FOR_WEB.md §1.1 (`getCurrentStockIndexed`), §1.4 (`avgMonthlyOutwardIndexed`), §1.5 (`suggestedReorderIndexed`), §2.2 (`computeOutstandingInvoices`), §2.4 (`computeBankBalance`), §2.5 (`monthlyTotals`).
- Derived: `latestDate`, `latestMonth`, `periodRange` (algorithm: `month`→{from:`{latestMonth}-01`, to:`latestDate`}; `quarter`→latestDate minus 2 months day 1; `ytd`→Apr 1 current FY (Apr-Mar fiscal); `custom`→user dates), `filteredVouchers`, `kpis`, `salesTrend`, `topItems` (top 5 with name truncated to 20 chars), `lowStockItems` (top 5 where `reorder>0 AND avg>0.5`).

#### Supabase tables (web port)
**READ ONLY:**
- `tally_companies`: `name`, `imported_at`
- `tally_stock_items`: `item_id, name, opening_rate`
- `tally_ledgers`: `ledger_id, name, group, opening_balance`
- `tally_vouchers`, `tally_voucher_ledger_entries`, `tally_voucher_inventory_entries`
- Prefer materialized views: `mv_monthly_revenue_purchase`, `mv_current_stock`, `mv_low_stock_items`, `mv_outstanding_invoices`

#### Interactions
- Period pills (All / Month / Quarter / FY / Custom) → update `periodFilter` state
- Custom date pickers → updates `customFrom` / `customTo`; range applied only if both filled
- Sales chart `<select>` → 3 / 6 / 12 / 24 months
- Top Items `<select>` → month / quarter / year
- AR / AP card click → `/invoices`
- "View All" in low-stock → `/alerts`
- Low-stock row click → `/alerts`

#### Filters / Sorting / Search
Single period filter applies globally. No search. Sort: top items by qty desc; low stock by suggested reorder desc.

#### Mobile vs desktop
KPI grid `.bento-grid` (1/2/4 cols). AR/AP always 2 cols. Charts 1-col mobile, 2-col `lg`. Low-stock row: "Stock:" badge hidden `<sm`; "Avg/mo" hidden `<md`. Period chips wrap.

#### Edge cases
- No data → empty state
- `kpis === null` → defaults to ₹0
- Top items empty → "No sales this period"
- Low stock empty → card not rendered
- Custom range without both dates → no filter applied
- Voucher amount missing → falls back to sum of inventory line amounts
- `latestDate` empty → today's date fallback

---

### Page: Orders
**Route:** `/orders`
**Source:** [src/pages/Orders.tsx](../src/pages/Orders.tsx)
**Purpose:** Three-pane order entry workspace. Left: virtualized item list with filters. Center: item analytics (stock buckets, monthly movement, transaction drill-down). Right: virtualized order entry, one input per item. Supports order groups (named, savable, exportable) and movement audit modal.

#### Layout

**Order Groups Bar** (sticky): `.bento-card !rounded-b-none`. Toggle "Order Groups (N)" (`FolderOpen` icon). When closed and groups exist: shows `<GroupTabs>`. Right: "N items in order".

**Order Groups Expanded Panel** (conditional):
- Tabs: **"Manage Groups"** / **"Assign Items"** (`px-4 py-2.5`, border-b-2 active accent)
- **Manage Groups**:
  - Create row: "Group Name" + "Description (optional)" + "Create & Save Current Order" button. Placeholders: `e.g. Weekly Order, Premium Items, Urgent Restock…`, `Notes about this order group…`. Enter key triggers create.
  - Export / Import row (file picker reads JSON `{ version, exportedAt, groups[] }`).
  - `<VendorGroupsSummary />` block.
  - "All Order Groups" + `<ExpandedGroupsView>`.
- **Assign Items**:
  - Search input
  - 2-col grid with sticky header "Item" / "Assigned Group"
  - Per-row: item name + `<select>` (Unassigned / each group)

**Mobile Tab Switcher** (isMobile only): three pills "Items" / "Detail" / "Order (N)".

**Three-Panel Main Area:**

**LEFT — Item List** (~26% width desktop):
- Header: search input (`Ctrl+F` placeholder).
- Filter row: "Stock" toggle → `<select>` (≤/≥/=) + numeric input. "Multi-Select (N)" toggle (right).
- Batch assign row (when multi-select + selections): group dropdown ("Select group to assign N items…") + Assign / Clear buttons.
- Virtualized list (`useVirtualizer`, `estimateSize 30`, `overscan 15`). Row: optional checkbox + name + colored stock value + accent dot if in order.

**CENTER — Item Detail & Graph:**
- No focused item: centered "Select an item from the list".
- Focused: `h2` item name + group/unit subline.
- **Mini KPIs** — 4 bento cards (2/4 cols mobile/md): "Opening", "In", "Out", "Closing". "In" and "Out" clickable → opens movement modal for current month.
- **Monthly Data Table**: sticky header Month/Opening/In/Out/Closing. "In"/"Out" clickable. Zero = neutral-300, non-zero = success/danger. Dynamic padding when `monthSpan > 12`. See ENGINE_FORMULAS_FOR_WEB.md §1.3 for the bucket formula.
- **Chart Toggle + Data Span**: "BarChart3 + N-Month History". Span select 3 / 6 / 8 / 12 / 24. ComposedChart: green In bars, red Out bars, blue Stock line. Height scales `max(180, 180 + (monthSpan-8) * 15)`.
- **Movement Transaction Modal**. See modals section.

**RIGHT — Order Entry** (~28% width desktop):
- Header: "Order" label + accent count pill + `<UnitToggle>` + `Download` (export Excel) + `Trash` (clear) icons.
- Sticky col header "Item" / "Qty".
- Virtualized rows (`estimateSize 40`): name + `<input inputMode="decimal">`. Accent bg/border when has value. Arrow keys + Enter navigate.
- Footer: "N items ordered" + Export button.

#### Components used
- `UnitToggle, GroupTabs, VendorGroupsSummary, ExpandedGroupsView`
- lucide: `Plus, Minus, Trash2, Download, X, Upload, Package, Filter, FolderPlus, FolderOpen, Save, Copy, ChevronDown, ChevronUp, BarChart3`
- `fuse.js` (search keys name+group, threshold 0.4), `@tanstack/react-virtual`, recharts `ComposedChart / Bar / Line`, `xlsx` (dynamic-imported for export).

#### Data sources
- `useDataset()`
- `useUIStore`: `unitMode, coverMonths, setCoverMonths, isMobile`
- `useOrderDraft()` (TanStack Query backed by `order_draft_lines`) — replaces Electron's local `useOrderStore`
- `useOrderGroups()` + `useUpsertOrderGroup, useDeleteOrderGroup, useDuplicateOrderGroup`
- `useVendorGroupAssignments()` + `useUpsertVendorGroupAssignment`
- Engine: see ENGINE_FORMULAS_FOR_WEB.md §1.1, §1.3, §1.4, §1.5, §5

#### Supabase tables (web port)
- **READ:** `tally_stock_items`, `tally_vouchers`, `tally_voucher_inventory_entries`, `vendor_group_assignments`
- **READ + WRITE:**
  - `order_groups` (`id, company, name, description, color, tags[], item_ids[], lines jsonb, created_at, updated_at`)
  - `vendor_group_assignments` (`item_id, vendor_group_id`)
  - `order_draft_lines` (current in-progress order — `company, item_id, item_name, base_unit, pkg_unit, units_per_pkg, qty_base, rate_per_base, updated_at`). Realtime-subscribed so Electron + web stay in sync if the user keeps both open.

#### Interactions
- **Ctrl+F** / **`/`**: focus search
- **Escape**: clear search + blur
- **Click item row**: normal mode → select item, pre-fill orderQty with existing or suggested reorder; multi-select mode → toggle checkbox
- **Arrow Up/Down on search**: navigate selection
- **Enter on search** with item selected: focus qty input
- **Order input keyboard**: Enter / ArrowDown → next row; ArrowUp → previous; selects text on focus
- **Order input change**: parses float; ≤0 calls `removeLine`, else `setLine` with computed qtyBase via [Engine §4.1]
- **UnitToggle**: switches base ↔ package display
- **Download icon**: dynamic-import xlsx, builds sheet `[Item, Qty, Unit]`, downloads `order_YYYY-MM-DD.xlsx`
- **Trash icon**: `clearAll` — clears `order_draft_lines` for this company
- **Group panel toggle**: opens/closes
- **Create group**: writes new group with current draft as its `lines`, sets active
- **Export/Import groups**: JSON file roundtrip (`{ version, exportedAt, groups[] }`)
- **Stock filter toggle**: enables filter chain
- **Multi-select toggle**: shows checkboxes; allows batch group assignment
- **Mobile tab buttons**: list/detail/order navigation
- **KPI "In"/"Out" tile click**: opens movement modal for that month
- **Table In/Out cell click**: opens movement modal for that row's month

#### Filters / Sorting / Search
- **Search**: fuse.js fuzzy over `item.name + item.group`, 150ms debounce
- **Group filter**: "ALL" + sorted distinct groups, exact match
- **Stock filter**: ≤/≥/= threshold against current stock
- **Active group**: items belonging to active order group
- No sort UI; filteredItems preserves source order

#### Modals

**Movement Transaction Modal**:
- Backdrop `fixed inset-0 bg-black/40 z-50`, click to close
- Panel 760px wide, `max-h 82vh` (full-screen mobile)
- Header: `{itemName} — {Inward|Outward} Details`, "Month: MMM YY"
- Outward only: tabs "Dispatched / Billed (N)" vs "Orders & Quotes (N)"
- Body: table cols Date / Voucher / Type / Party / Qty / Rate / Amount + totals footer
- Type colored: Sales Order = blue-600, Quotation = amber-600
- Empty: "No {direction} transactions found" or "No sales orders or quotations found"
- Close X
- Formulas: see ENGINE_FORMULAS_FOR_WEB.md §5

#### Mobile vs desktop
- Mobile: three-tab navigation (Items/Detail/Order). One panel visible at a time. Modal full-screen.
- Desktop: 3-pane fixed-width (26%/flex/28%). All visible.
- Mobile tap on item auto-switches to "detail" tab.

#### Edge cases
- No data → centered Package icon + "No Data Loaded"
- Item already in order → input pre-fills with current qty
- Suggested reorder = 0 → empty string in qty input
- Input ≤0 → removes line (deletes from `order_draft_lines`)
- Multi-select with 0 selections → assign button disabled
- Importing groups with invalid JSON → toast "Invalid JSON file"

---

### Page: Invoices
**Route:** `/invoices`
**Source:** [src/pages/Invoices.tsx](../src/pages/Invoices.tsx)
**Purpose:** Unified transaction list — invoices (Sales/Purchase) and payments/receipts in one table. Shows outstanding totals at top, searchable/filterable list, rich voucher detail modal with price verification (Sales only).

#### Layout
1. **Empty state**: `FileText`, "No Data Loaded", "Open Sync Logs" button → `/sync-logs`
2. **Page Header**: `h1` "Invoices"
3. **Summary Grid**: 2-col mobile / 4-col md. Four `.bento-card`s: "Outstanding AR" (success), "Outstanding AP" (danger), "Receipts" (primary), "Payments" (warn)
4. **Filter Bar**: search input ("Search party / voucher#") + 5 `.filter-chip` buttons (All / Sales / Purchase / Receipt / Payment) + From/To date inputs (hidden mobile) + "N rows" counter
5. **Table / Cards**: desktop `<TxTable>`; mobile `<MobileCards>`
6. **Voucher Modal** — see modals

#### Components used
- `RatePill, AmountPill, priceMatches` from `PriceVerification.tsx`
- lucide: `FileText, X, CheckCircle2, XCircle`
- `useVirtualizer` (desktop)
- Engine: see ENGINE_FORMULAS_FOR_WEB.md §2.2 (`computeOutstandingInvoices`), §2.6 (`computeItemMargins`)

#### Data sources
- `useDataset()`
- `useTallyPriceListImports()` (TanStack Query on `tally_price_list_imports`)
- Derived:
  - `invoices = computeOutstandingInvoices(vouchers, ledgers, 30)`
  - `rows = buildTxRows(invoices, vouchers, ledgers)` — combines invoice + Payment/Receipt rows
  - `filtered` = type filter + dateFrom/dateTo + search, sorted by date desc
  - `totals` = AR/AP/receipts/payments
  - `priceList`: uses Tally price entries (keyed uppercase) else item margins' `avgSalesRate` else `closingRate` else `openingRate`

#### Supabase tables (web port)
- **READ:** `tally_vouchers`, `tally_voucher_*_entries`, `tally_ledgers`, `tally_stock_items`, `tally_price_list_imports`
- **Prefer:** `mv_outstanding_invoices`, `mv_item_margins`

#### Interactions
- Search: live filter (no debounce)
- Type chips: exclusive filter
- Date pickers: range filter
- Row click → opens `VoucherModal`
- **Escape**: close modal
- Backdrop click / X / Close: close modal
- Hover on rate/amount pills → price comparison tooltip

#### Filters / Sorting / Search
- Search: case-insensitive contains on `partyName + voucherNumber`
- Type: All / Sales / Purchase / Receipt / Payment
- Date range: inclusive
- Sort: date desc (always)

#### Modals

**TxTable (desktop)**: 6-col grid `100px 130px 90px 1fr 120px 100px`: Date / Voucher# / Type / Party / Amount / Outstanding. Virtualized (`estimateSize 48, overscan 10`), `max-h 60vh`. Outstanding: red `fmtINR` if >₹0.01, green "Paid" if ≤₹0.01, "—" muted if null. `min-width 720px`. Empty: "No records found".

**MobileCards**: First 100 rows + "Showing first 100 of N rows" footer.

**VoucherModal**:
- Backdrop `bg-black/50 animate-fade-in`, `role=dialog aria-modal`
- Panel: `bg-white rounded-2xl shadow-2xl max-w-5xl max-h-[90vh] animate-modal-pop`
- **Header**: gradient `from-neutral-50 to-white`. Party + voucher# badge + type badge. Date + narration. Right: for Sales with inv lines, "Prices Verified" pill (blue) if all match else "Price Mismatch" pill (amber). X close.
- **Body**:
  - **Sales price verification table**: Item / Qty / Rate (`RatePill`) / Amount (`AmountPill`). Footer total row `colspan=3` + total `AmountPill isTotal={true}`.
  - **Non-sales items list**: simpler, no price verification
  - **Ledger Entries**: each with "Dr" (blue) / "Cr" (orange) badge + ledger name + amount. Bill allocations indented (`pl-10`): `billType: billRef` + amount
  - **Outstanding Amount panel**: amber if > 0.01, green "Fully Paid" if ≤ 0.01 (Sales/Purchase only). Hidden for Payment/Receipt.
  - **Empty**: `FileText` + "No line details available."
- **Footer**: "N items · N ledger entries" + Close button

#### Mobile vs desktop
- Desktop: virtualized table 6 cols, date inputs visible
- Mobile: card stack capped 100, date inputs hidden, summary 2 cols
- Modal: same on both, `max-w-5xl`

#### Edge cases
- Payment/Receipt with no party → "—"
- No Tally price entries → falls back to computed margins
- Bill allocations empty → skipped
- All prices match → "Prices Verified" badge; any mismatch → "Price Mismatch"

---

### Page: Ledgers
**Route:** `/ledgers`
**Source:** [src/pages/Ledgers.tsx](../src/pages/Ledgers.tsx)
**Purpose:** Browse all ledger accounts grouped by category, with full transaction history per ledger including running balance (Dr/Cr) from opening balance forward.

#### Layout
- **Empty state**: `BookOpen` icon, "No Data Loaded"
- **Mobile detail view**: "← Back to list" + `h2` ledger name + group/opening/GSTIN. Scrollable card list: "Opening Balance" first, then per-tx cards (`date · type / voucher# / Dr or Cr / running balance`)
- **Mobile list view**: page-header "Ledgers" + filter card (search + group select) + scrollable ledger list (name / group / opening Dr/Cr)
- **Desktop**: `h1.sr-only`
  - **Left panel (w-80)**: search with magnifier, group select, scrollable list (active gets accent border/bg)
  - **Right panel (flex-1)**: empty-state "Select a ledger to view transactions" or header (name, Group / Opening / Credit Days / GSTIN) + table (Date / Voucher# / Type / Debit / Credit / Balance, sticky header). Opening Balance row first with `colspan=3`

#### Components used
- lucide `Search, BookOpen, ArrowLeft`
- HTML table (consider `useVirtualizer` for very active accounts)

#### Data sources
- `useDataset()`
- `useUIStore.isMobile`
- Derived:
  - `allLedgers = Array.from(data.ledgers.values())`
  - `groups = ["ALL", ...sorted distinct l.group]`
  - `filtered` = name contains search AND (group ALL || exact match)
  - `ledgerTransactions` — see ENGINE_FORMULAS_FOR_WEB.md §2.1 for the algorithm.
  - **Bug fix in web port:** Electron's original excludes cancelled but NOT optional. Web port: exclude both, matching the rest of the app's convention (Engine §0.1).

#### Supabase tables (web port)
- **READ:** `tally_ledgers`, `tally_vouchers`, `tally_voucher_ledger_entries`
- **Prefer:** `mv_ledger_transactions(ledger_id, voucher_id, date, voucher_type, debit, credit)` — avoid full-scan per selection

#### Interactions
- Search live filter
- Group select filter
- Click ledger → sets `selectedLedgerId`
- Mobile "← Back" → null

#### Filters / Sorting / Search
- Search: case-insensitive contains on `ledger.name`
- Group: "ALL" or exact match
- Sort: ledgers source order; transactions ascending date

#### Mobile vs desktop
- Mobile: single-pane, tap → full-screen detail, back arrow returns
- Desktop: master-detail split

#### Edge cases
- No data → empty state
- No ledger selected (desktop) → "Select a ledger..."
- Zero transactions → "No transactions for this ledger"
- Opening balance ≥0 = "Dr", <0 = "Cr"; absolute value
- Multiple lines per voucher touching same ledger → all rows captured
- GSTIN/creditDays optional → only rendered when truthy

---

### Page: PendingOrders
**Route:** `/pending-orders`
**Source:** [src/pages/PendingOrders.tsx](../src/pages/PendingOrders.tsx)
**Purpose:** Lists all non-cancelled Delivery Notes (open dispatch instructions) and shows readiness — stock availability + price-match status. Click row → detail modal with per-item stock + price verification.

#### Layout
- **Empty state**: `Truck` icon, "No Data Loaded"
- **Page Header**: `h1` "Pending Orders"
- **List**: desktop `<DesktopTable>`, mobile `<MobileList>`
- **DNModal** on selection

#### Components used
- lucide `Truck, X, PackageCheck`
- `RatePill, AmountPill, priceMatches, PRICE_TOLERANCE`

#### Data sources
- `useDataset()`, `useItemMargins()`, `useTallyPriceListImports()`
- Derived:
  - `deliveryNotes` = vouchers where `voucherType === "Delivery Note" && !isCancelled && !isOptional`, sorted date desc
  - `priceList` via `getPriceList(data, tallyEntries, itemMargins)`
  - `stockCache`: precompute current stock once per item (Engine §1.1)
  - `readinessMap`: `{ allInStock, allPricesMatch, ready }` per DN
  - **Readiness rule (current behavior — confirmed by user 2026-05-25):** `ready = allInStock` (price mismatch alone does NOT block; an informational amber "rate Δ" badge shows separately)

#### Supabase tables (web port)
- **READ:** `tally_vouchers WHERE voucher_type='Delivery Note'`, `tally_voucher_*_entries`, `tally_stock_items`, `tally_ledgers`, `tally_price_list_imports`, `mv_item_margins`
- **Prefer:** `mv_pending_delivery_notes_with_readiness` pre-computes `ready` boolean

#### Interactions
- Click DN row → opens `DNModal`
- **Escape**: close
- Backdrop click / X / Close: close
- Hover row → `bg-neutral-50`

#### Filters / Sorting / Search
- **No filters or search** (only DN type implicit filter)
- Sort: date desc

#### Modals

**DNModal** — see [DELIVERY_MODAL_FINAL_SUMMARY.md](DELIVERY_MODAL_FINAL_SUMMARY.md) for the design system reference.
- Backdrop `bg-black/50 animate-fade-in`, `role=dialog aria-modal`
- Panel: `bg-white rounded-2xl shadow-2xl max-w-5xl max-h-[90vh] animate-modal-pop`
- **Header** gradient `from-neutral-50 to-white`: party name + voucher# pill + date + narration. Right: "Ready to Deliver" green pill if `ready`; otherwise neutral pill with amber dot — "Stock issues" / "Price mismatch" / both joined " · ". Small amber "rate Δ" badge appears separately when `ready && !allPricesMatch`. X close.
- **Body**:
  - **Items for Delivery table**: 5 cols Item Name / Qty / Rate (`RatePill`) / Amount (`AmountPill`) / Stock Status (dedicated column).
    - Stock label logic:
      - `null` (no item) → no badge
      - `stock >= qty` → "{stock} in stock" (green)
      - `stock > 0 && < qty` → "only {stock} in stock" (red)
      - `stock === 0` → "out of stock" (red)
      - `stock < 0` → "{stock} (short by {abs(stock)})" (red)
    - Footer total row: `colspan=3` + `AmountPill isTotal={true}` + empty stock cell
  - **Ledger Entries**: same Dr/Cr pattern as Invoices modal
  - **Empty**: `Truck` + "No line details available."
- **Footer**: "N items · N ledger entries" + Close

**DesktopTable**: sticky grid `90px 120px 1fr 60px 140px 110px`: Date / DN# / Party / Pkgs / status col / Value. Each clickable, "Ready to Deliver" green pill if applicable. `totalPkgs = Σ qtyBase`. `max-h calc(100vh - 240px)`. Empty: `Truck` + "No delivery notes found".

**MobileList**: stacked cards; party (or voucher#), small "Ready" pill if applicable, `date · N items · N pkgs · narration`, value right.

#### Mobile vs desktop
- Desktop: tabular with explicit pkgs column
- Mobile: card list with inline metadata
- Modal: same on both (`max-w-5xl`)

#### Edge cases
- No DNs → "No delivery notes found"
- DN with no inventory lines → table not rendered, only ledger + footer "0 items · N ledger entries"
- Item not in stock cache (not in `data.items`) → stock = null, no badge
- `partyName` null → "—" desktop or voucher# fallback mobile
- `isOptional` and `isCancelled` excluded

---

### Page: Discounts
**Route:** `/discounts`
**Source:** [src/pages/Discounts.tsx](../src/pages/Discounts.tsx)
**Purpose:** Select a Sales or Delivery Note voucher and inspect auto-calculated group-wise discount breakdown for each line item. Per-item manual override of discount %.

#### Layout
- **Empty state**: `%` glyph, h2 "No Data Loaded"
- **Page header**: title "Discounts" + subtitle "Group-wise automatic discounts for Sales invoices". Right: `Edit Rules` button (Pencil) → `/discount-rules`
- **Voucher Selector card**: tabs + search + table + pagination
  - **Tabs**: `Sales` / `Delivery Note` (default). Active: `border-blue-500 text-blue-600 bg-blue-50`
  - **Search**: "Search party or voucher #" + "{N} found" pill
  - **Table**: cols empty-radio (`w-8`) / Voucher / Date / Party / Amount (right). Voucher# mono blue, party truncated, amount bold right `tabular-nums`
  - **Pagination**: 20 per page, prev `‹`, up to 7 numbered, next `›`
  - **Empty**: "No delivery notes found" / "No sales vouchers found"
- **Discount Breakdown card** (when voucher selected):
  - Voucher header: party name (bold xl), uppercase voucher-type chip, mono voucher#, formatted date. Right: "Invoice Total" + large bold INR.
  - **Totals strip**: 3-col gradient green band — Subtotal / Total Discount (with `−`) / Effective Rate (%).
  - Collapsible "Discount by Category (Group-wise)".
  - **Group cards grid**: 1/2 cols. Colored from palette (NEUTRAL for `NO_DISCOUNT`). Each: category name + total packages + large %, Subtotal, Discount line, optional Base Tier badge + Group Rule Applied blue badge, `View Items in Group →`.
  - Collapsible "Items in Invoice".
  - **Items table**: cols Item / Qty (`qtyBase + "{pkg} pkgs"`) / Category (colored badge) / Amount / Disc% (click-to-edit) / Discount. Row bg uses per-category palette. Manual overrides in amber.
  - "No items with discounts" empty state.
- **Group Details Modal** mount.

#### Components used
- lucide `Pencil, X, RotateCcw, ChevronDown`
- `calculateVoucherDiscount`, `fmtINR/fmtNum/fmtDate`
- Inline: `VoucherSelector, DiscountBreakdown, GroupDetailsModal`

#### Data sources
- `useDataset()` (`data.vouchers` filter `!isCancelled && !isOptional`)
- `useDiscountRules()`, `useItemCategoryOverrides()`, `useCategoryColors()`
- `discountResult = calculateVoucherDiscount(voucher, items, categories, itemCategoryOverrides)` → `{ lines, groupSummaries, totalLineAmount, totalDiscountAmount, effectivePct }`. See ENGINE_FORMULAS_FOR_WEB.md §3.4 for the full pipeline.
- `displayResult`: overlays `manualOverrides` (local state) on each line. Algorithm: for any item where `manualOverrides[itemName]` defined, replace `discountPct`, recompute `discountAmount = lineAmount * pct / 100`, set `tierLabel = "Manual: {pct}%"`. Group lines once by `categoryId`. Recompute `groupSummary.totalDiscount`, `totalDiscountAmount`, `effectivePct`.
- `useDeferredValue(selectedVoucherId)` defers heavy math.
- `useEffect` on `deferredVoucherId` clears `manualOverrides` when voucher changes.

#### Supabase tables (web port)
- **READ:** `tally_vouchers`, `tally_voucher_inventory_entries`, `tally_stock_items`, `discount_rules`, `category_colors`, `item_category_overrides`
- **WRITE:** None (manual overrides are session-only)

#### Interactions
- Tab click: switch Sales / Delivery Note, reset page+search
- Search: live filter, reset page
- Row/radio click: select voucher
- Pagination prev/page#/next
- `Edit Rules` → `/discount-rules`
- Collapse toggles (Groups, Items)
- Group card click + `View Items in Group →`: open `GroupDetailsModal`
- **Disc% cell click**: becomes number input (`min=0 max=100 step=0.5`, auto-selected). Enter or blur commits, validates 0-100. Escape cancels.
- **RotateCcw button**: clears that item's manual override

#### Filters / Sorting / Search
- Tab filter: Sales / Delivery Note. Both exclude cancelled/optional.
- Search: lowercase substring on `partyName + voucherNumber`
- Sort: date desc (ISO compare)
- Pagination: 20/page

#### Modals

**GroupDetailsModal**: `.modal-overlay`. Backdrop click closes. Header: group name + X. Body: accent "Total Packages in Group" pill + integer; "Items in This Group" list (white cards: item name + `"{qty} units = {pkg} pkg(s)"` pluralized). Footer: full-width Close (`.btn-primary`).

#### Mobile vs desktop
- Voucher search row `flex` wraps; pagination wraps
- Totals strip: `grid-cols-1 sm:grid-cols-3`
- Group cards: `grid-cols-1 md:grid-cols-2`
- Items table: horizontal scroll inside card

#### Edge cases
- No data → empty state
- No vouchers in tab → "No {x} found"
- No items with discounts → "No items with discounts in this invoice"
- Invalid manual % (NaN, <0, >100) → silently rejected
- Categories changing while override live: overrides keyed by `itemName`, so renamed categories still preserve %
- Invalid hex color stored → `hexToRGB` returns null, falls through to base palette

---

### Page: DiscountRules
**Route:** `/discount-rules`
**Source:** [src/pages/DiscountRules.tsx](../src/pages/DiscountRules.tsx)
**Purpose:** CRUD for discount categories, qty-based tiers, per-item category assignments. JSON import/export, category color editing, reset-to-defaults. Persists via Supabase config writes (replaces Electron's Zustand + local file).

#### Layout
- Empty state: `%` glyph, "No Data Loaded"
- Hidden file input
- `AddCategoryModal` mount
- Color Picker modal mount (conditional on `colorCatId`)
- **Header**: Back → `/discounts`, title "Edit Discount Rules", subtitle. Right: `Import` (Upload) + `Export` (Download)
- **Status message**: auto-hides 4s
- **Tab list**: `Discount Tiers` / `Item Assignments`
- **Tiers tab**:
  - List of category cards. Each: chevron + name + "{N} tier(s)" subtitle. Right: `Color` (Palette), `Add Tier` (Plus), `Delete` (Trash2, hidden for NO_DISCOUNT)
  - Expanded body: tiers in grid `[1fr 1fr 1fr auto]` columns Min Qty / Max Qty / Discount % / per-row X
  - Empty-tier: "No tiers — items in this category get 0% discount"
  - Dashed `+ Add New Category` button
- **Item Assignments tab**:
  - Search + "{filtered}/{total}" counter
  - Sticky "Item Name" / "Category". Scrollable `max-h-96`. Items: name + `NEW` blue pill for new items + category select
  - Empty: "No items found"
- **Fixed footer**: `Reset to Defaults` (RotateCcw) left. `Cancel` / `Save Changes` (disabled unless `hasChanges`) right

#### Components used
- lucide `ChevronDown, ChevronRight, X, Plus, Trash2, RotateCcw, ArrowLeft, Download, Upload, Palette`
- `ColorPicker` component
- Inline `AddCategoryModal`

#### Data sources
- `useDataset()` for `data.items` keys → new-items pill
- `useDiscountRules(), useItemCategoryOverrides(), useCategoryColors()` + matching mutations
- Local state: `localCats` (deep clone), `localOverrides`, `activeTab`, `itemSearch`, `expandedCatId`, `hasChanges`, `fileMsg`, `addCatOpen`, `colorCatId`, `fileInputRef`
- `mergedMap = { ...DEFAULT_ITEM_CATEGORY_MAP, ...localOverrides }`
- `allItems`: defaults map keys then extra item ids from `data.items` not in defaults
- `filteredItems`: lowercase substring on `itemSearch`
- `buildPayload(cats, overrides)`: `{ version:"2", exportedAt, categories, groupRules:DEFAULT_GROUP_RULES, itemCategoryOverrides, allItemAssignments }`

#### Supabase tables (web port)
- **READ + WRITE:**
  - `discount_rules` (`id TEXT, company, name, category, discount_type='tiered', conditions jsonb={tiers,groupRules}, priority, enabled`)
  - `item_category_overrides` (`company, item_id, category_id`)
  - `category_colors` (`company, category_id, color hex`)
- **READ:** `tally_stock_items` for `allItems` enumeration

#### Interactions
- **Back** → `/discounts`
- **Import**: opens hidden file input. On success: `applyImportedRules(data)` + mark dirty
- **Export**: blob download `discount-rules-{YYYY-MM-DD}.json`
- **Tab buttons**: switch tiers/items
- **Category row click**: toggle expanded
- **`Color` button**: open color picker modal for that category
- **`Add Tier`**: append `{minQty:1, maxQty:null, discountPct:0}`, auto-expand
- **`Delete` category**: `window.confirm("Delete category \"{name}\"?")`, then remove
- **Tier inputs**: `updateTier(catId, idx, field, value)`. `maxQty` empty → null. Mark dirty
- **Tier remove X**: remove by index
- **`Add New Category`**: opens `AddCategoryModal`
- **Item search**: live filter
- **Item category select**: if user picks default, override is deleted; else stored in `localOverrides`. Mark dirty
- **Reset to Defaults**: confirm, re-seed from `data/discountDefaults.json`, navigate to `/discounts`
- **Cancel** → `/discounts` without saving
- **Save Changes**: writes via mutations (one upsert per discount rule, replace overrides, replace colors). Disabled unless `hasChanges`

#### Filters / Sorting / Search
- Item search: substring lowercased on `itemId` (=item name). No sort.

#### Modals

**AddCategoryModal**: centered `bg-black/40` overlay. Title "New Category". Single input "Category Name", placeholder "e.g. PUMP TOGO ALL TYPES". Live hint: `ID: {name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`. Buttons Cancel / Add Category (disabled until trimmed). Enter confirms, Escape cancels. Confirm appends `{id, name, tiers:[]}`, auto-expand, close.

**Color Picker modal**: uses external `ColorPicker`. Backdrop or `Done` closes. Each color change calls `setCategoryColor(colorCatId, color)` immediately (optimistic mutation).

#### Mobile vs desktop
- Header `flex-wrap`
- Tier rows 4-col grid stays grid-shaped (no responsive variant)
- Fixed footer with 20px spacer prevents clipping

#### Edge cases
- No data → empty state, page locked
- Empty tier list inside category → italic message
- Renaming category not implemented (add/delete only)
- Invalid JSON import → red toast "Invalid JSON file"; missing categories array → "Invalid file: missing categories"
- Save with no changes → button disabled
- Default seed: 16 categories + ~420 item assignments from `data/discountDefaults.json` (seeded 2026-05-23 from user's exports)

---

### Page: PriceList
**Route:** `/price-list`
**Source:** [src/pages/PriceList.tsx](../src/pages/PriceList.tsx)
**Purpose:** Read-only browser of every item's pricing — Tally master rate, inferred/master GST %, price+GST, dealer price lists. Imports JSON Tally rates file to overlay selling/cost.

#### Layout
- Empty state: `Tag` icon, "No Data Loaded"
- **Page header**:
  - Left: title "Dealer Price List", subtitle
  - Right: hidden file input + emerald `Import Tally Rates` (FileUp) + red trash when rates present. Below: "{count} rates loaded · {date}", red error text if any
- **Filters card**: h2 "Filters & Search". 3-col grid: search box (Search icon, "Search by item name or group…") spans 2/3, `Filter by Group` select 1/3. Below: "{N} item(s) found"
- **Table card**:
  - Sticky grid header. Two layouts:
    - With Tally data (`tallyItemCount > 0`): `48px 1fr 160px 80px 140px 150px` → expander | Item Name | Group | GST % | Tally Rate | Price + GST
    - Without: `48px 1fr 160px 80px`
    - "Item Name" + "Group" sortable (up/down arrow). "GST %" orange right-aligned. "Tally Rate" emerald. "Price + GST" purple.
  - Body `overflow-y-auto, maxHeight: calc(100vh - 340px)`. Rows: expander chevron (only when `dealerPrices` exist), item name (bold truncated), group pill (`slate-100 rounded-full`), GST badge (3 styles: default grey, inferred amber with `~`, master orange), Tally rate (emerald + cost subline), Price + GST (purple)
  - Empty: `Tag` + "No items match your filters"
  - Expanded panel: blue-50 strip with `h3` "Dealer Price Lists"; each dealer price row: list name, dealer rate (blue `tabular-nums`), optional red `-{discount}%` pill

#### Components used
- lucide `Tag, ChevronDown, Search, FileUp, Trash2`
- `fmtRate`, `parseTallyPriceListJson`, `inferGstRatesFromVouchers`

#### Data sources
- `useDataset()` for items + vouchers
- `useTallyPriceListImports()` for `entries` (uppercase keys), `importedAt`, `itemCount`
- `inferGstRatesFromVouchers(vouchers)` → `Map<itemId, number>`. See ENGINE_FORMULAS_FOR_WEB.md §6.5
- `rows`: maps every item to `PriceRow`. GST: master `item.gstRate` → inferred → default 5; flags `gstRateInferred`, `gstRateDefault`
- `groups`: "ALL" + sorted unique groups
- `filtered`: substring filter on name OR group + group dropdown filter
- `sorted`: `name` or `group` (group tie-breaks by name); direction toggle

#### Supabase tables (web port)
- **READ:** `tally_stock_items` (`item_id, name, group, gst_rate, base_unit, dealer_prices jsonb`), `tally_vouchers` + `tally_voucher_inventory_entries` for GST inference (or `mv_item_gst_inferred`)
- **READ + WRITE:** `tally_price_list_imports` (`company, item_name uppercased, selling_rate, cost_price, unit, imported_at`)

#### Interactions
- **Import Tally Rates**: triggers hidden file input
- **File change**: detects BOM (UTF-16 LE/BE) else UTF-8, decodes, calls `parseTallyPriceListJson`. Success: bulk upsert into `tally_price_list_imports`. Empty: "No items with selling rates found in the file." Errors in red
- **Trash icon** (visible when `tallyItemCount > 0`): clears all `tally_price_list_imports` rows for this company
- **Search**: live filter
- **Group select**: filter
- **Sort headers**: click toggles direction or sets new key; Enter/Space accessible. Icons `↕ ↑ ↓`
- **Expand chevron**: per-row `toggleExpanded(itemId)`, only when item has dealer prices. `aria-expanded`/`aria-label` set

#### Filters / Sorting / Search
- Search: lowercase substring on name OR group
- Group: ALL or unique group exact
- Sort: name (default asc) or group (asc/desc), group tie-broken by name

#### Mobile vs desktop
- Header `flex-col sm:flex-row sm:items-start sm:justify-between`
- Filters `grid-cols-1 md:grid-cols-3` with search spanning 2/3
- Table fixed-width via CSS grid → narrow screens scroll horizontally
- Dealer prices expansion indented `ml-12`

#### Edge cases
- No data → empty state
- No filter results → `Tag` icon "No items match your filters"
- Tally rate missing for item → em-dash in Tally Rate + Price+GST
- GST tooltips:
  - Default 5% → "Default 5% — no master or voucher data"
  - Inferred → "Rate inferred from past vouchers"
  - Master → "Rate from Tally master"
- No dealer prices → expander chevron not rendered
- BOM detection: UTF-16 LE/BE/UTF-8
- `importing` flag disables button

---

### Page: PriceListCorrection
**Route:** `/price-correction`
**Source:** [src/pages/PriceListCorrection.tsx](../src/pages/PriceListCorrection.tsx)
**Purpose:** Audits opening balances to surface items priced like cost (baby items <₹500, items <₹50). Recommends corrected rate using median of recent sales. Exports CSV for Tally re-import.

#### Layout
- Empty state: `Upload` icon, "No Data Loaded"
- **Page header**: title "Price List Correction", subtitle "Fix {N} cost prices using recent sales data". Right: `Export` (Download) with count badge `(N)` when selected; disabled if 0
- **Summary cards**: 3-col grid bento-cards — `Critical` (danger) "Baby items under ₹500"; `High Priority` (warn) "Items under ₹50"; `Medium Priority` (info) "Other anomalies"
- **Selection controls**: section-card row — `Select All`, `Select Critical (N)`, `Select High (N)`, `Clear`, right counter `{selected}/{total} selected`
- **Items table**: inside section-card, cols checkbox / Item Name / Current Rate / Recent Sales / Recommended / Priority / Issue. Selected rows `bg-accent/10`. Critical rows have `border-l-4 border-l-danger`
- **Instructions card**: info-tinted with `AlertTriangle`, `h3` "How to Fix" + 6-step ordered list (Select → Review → Export → Update → Re-export → Re-import)

#### Components used
- lucide `Download, AlertTriangle, TrendingUp`
- `auditPriceList`, `useToast`
- formatters `fmtINR / fmtNum`

#### Data sources
- `useDataset()` for items Map, vouchers (Sales / Delivery Note non-cancelled)
- `auditPriceList(data)`: `{ totalItems, anomalies: PriceAnomaly[], summary }`. Each anomaly: `itemId, itemName, openingRate, openingValue, openingQty, calculatedRate, flags[]`
- Filtering: anomalies with `BABY_ITEM_COST_PRICE` OR `SUSPICIOUSLY_LOW_RATE` flags
- Recent sales rate: for each candidate, scan all vouchers; for Sales / containing "delivery" non-cancelled, walk inventory lines, collect `ratePerBase > 0`. Median = `recentSalesRate` = `recommendedRate`
- Priority: `critical` if name contains "baby" or "tricycle"; else `high` if `openingRate === 0`; else `medium`
- Sort: priority then `openingValue` desc

#### Supabase tables (web port)
- **READ:** `tally_stock_items` (`item_id, name, opening_rate, opening_qty_base, opening_value`), `tally_vouchers`, `tally_voucher_inventory_entries` — or `mv_recent_sales_rates`
- **WRITE:** None (CSV download only). Future: `price_corrections` table

#### Interactions
- Row checkbox: `toggleSelection` (the row itself is not click-to-toggle despite `cursor-pointer`)
- `Select All`: union
- `Select Critical (N)` / `Select High (N)`: union by priority
- `Clear`: empty
- `Export`: builds CSV (header `Item Name,Current Rate,Recommended Rate,Recent Sales Rate,Notes`, blank line, then `Instructions:` lines), downloads `cost-price-fixes-{YYYY-MM-DD}.csv`. Toast: "Exported {N} items to CSV". Empty selection → yellow "Select items to export"

#### Filters / Sorting / Search
- No filter/search. Fixed sort: priority desc by criticality then `openingValue` desc

#### Mobile vs desktop
- Summary cards always `grid-cols-3`
- Items table `overflow-x-auto -mx-5 -mb-5`

#### Edge cases
- No data → empty state
- No anomalies → empty table, summary zeros, export disabled
- No recent sales for item → Recent Sales `—`, Recommended yellow `Manual`, CSV `?` for recommended and `No sales data`
- Opening rate 0 → delta % indicator suppressed
- CSV quoting: itemName + flags string in double quotes; commas not otherwise escaped

---

### Page: Edit (Edit Units)
**Route:** `/edit`
**Source:** [src/pages/Edit.tsx](../src/pages/Edit.tsx)
**Purpose:** Inline editor for per-item unit conversion data — base unit, packaging unit, units per pack. Batched local edits committed via `saveAll` to `unit_overrides` + `audit_log`.

#### Layout
- Empty state: `Package` icon, "No Data Loaded"
- **Page header**:
  - Left: title "Edit Units"
  - Right toolbar: `Auto-fill from Tally` (Wand2, secondary sm) always visible. When `dirtyCount > 0`: `{N} unsaved` (warn `tabular-nums`), `Reset` (RotateCcw), `Save All` (Save primary sm)
- **Filters row**: search input ("Search items…" `flex-1`) + group `<select>` (All Groups + unique groups)
- **Table card**: scrollable `maxHeight: min(65vh, 640px)`. Sticky header (`.table-header-sticky`). Cols `Item` / `Group` / `Base Unit` (`w-24`) / `Pkg Unit` (`w-24`) / `Units/Pkg` (`w-28`). Dirty rows: `bg-accent/5`

#### Components used
- lucide `Save, RotateCcw, Package, Wand2`
- `Fuse.js` (fuzzy)

#### Data sources
- `useDataset()` — `data.items` Map
- `useUnitOverrides()` + `useUpsertUnitOverride`
- `allItems` from data
- `groups` = ALL + sorted unique
- `fuse` index on `name + group`, threshold 0.4
- `filteredItems`: apply group filter then Fuse search
- Local `rows`: per-itemId `EditRow` cache; `getRow` returns stored or seeds from item
- `dirtyCount`: dirty rows count

#### Supabase tables (web port)
- **READ:** `tally_stock_items` (`item_id, name, group, base_unit, pkg_unit, units_per_pkg`)
- **WRITE:**
  - `unit_overrides` (`item_id, pkg_unit, units_per_pkg, source='manual', confidence=1, updated_at`)
  - `audit_log` row (server-action side effect)

#### Interactions
- Search: Fuse re-filters
- Group select: filter
- **baseUnit input**: uppercase-cast onChange
- **pkgUnit input**: uppercase-cast onChange (placeholder `—`)
- **unitsPerPkg**: number `min=1`, `parseInt(value) || 1`
- All changes call `updateRow` → mark dirty
- **`Auto-fill from Tally`**: iterates items with `pkgUnit`, seeds row + mark dirty
- **`Reset`**: clears local `rows` (no confirm)
- **`Save All`**: per dirty row, trim and apply. Empty pkgUnit → null + force `unitsPerPkg=1`; else `max(1, unitsPerPkg)`. Batched upsert via Server Action; one audit_log row per change

#### Filters / Sorting / Search
- Search: Fuse fuzzy on name + group
- Group: ALL or exact
- No explicit sort

#### Mobile vs desktop
- Filter row `flex` without breakpoint
- Table `min-w-[540px]`, horizontal scroll on small mobile

#### Edge cases
- No data → empty state
- pkgUnit cleared → persisted as null, `unitsPerPkg` forced to 1
- Auto-fill skips items without Tally pkgUnit
- Save All with no dirty: no-op
- Reset silent
- `unitsPerPkg` non-numeric: fallback 1
- No persistence between sessions for in-progress edits — local `rows` wiped on nav. (To add: persist drafts via TanStack mutation cache.)

---

### Page: Outreach
**Route:** `/outreach`
**Source:** [src/pages/Outreach.tsx](../src/pages/Outreach.tsx)
**Purpose:** Sales-intelligence console surfacing upsell, reactivation, retention opportunities from Tally sales vouchers. Per-party analytics (RFM, churn risk, predicted next order). **Web port adds tel/WhatsApp/copy actions for field sales** — see Interactions.

#### Layout
1. **Page header**: h1 "Outreach Intelligence" + strapline "AI-powered sales opportunities, churn detection & predictive analytics" (hidden mobile). Desktop only: search input "Search parties…" `max-w-xs` in right
2. **KPI grid** — 2/4 cols:
   - "Potential Revenue" (Σ `estimatedValue` opps, sub `{n} opportunities`, accent)
   - "At-Risk Revenue" (Σ totalRevenue parties `churnRisk>65 && tier!=longtail`, danger)
   - "Avg Confidence" (avg `conversionProbability` as %, success)
   - "Urgent Actions" (opps with `daysToAct===0`, warn)
3. **Mobile search** — duplicate of desktop
4. **Tabs** — bottom-bordered row: `Opportunities`, `Parties`, `Churn Risks`, `Predictions` (icons Target/Users/AlertTriangle/Calendar). Pill counts. Labels hidden `sm:` — icons only
5. **Content** — flex row desktop when party selected (left 58%, right 280px); else full-width
   - **Opportunities tab**: chip filter "All Types/Upsell/Reactivation/Retention" + counts. Vertical scroll `OppCard` list (`max-h min(65vh, 600px)`). Empty: `CheckCircle` + "No opportunities match"
   - **Parties tab**: section-card sticky header (`Party / Revenue (md) / Orders (lg) / Trend / Churn / chevron`) + virtualized list (row 60, overscan 12, h `min(65vh, 500px)`)
   - **Churn Risks tab**: section-card header (`Party / Risk bar (md) / Score / Revenue (md)`) + stacked `ChurnRow` sorted by churn desc, filter `churnRisk>40`. Empty: `CheckCircle` + "No churn risks detected"
   - **Predictions tab**: section-card "Predicted Orders — Next 30 Days" (`Clock` icon). Stacked `CalendarItem` sorted by predictedNextOrder asc. Empty: "No predictions yet / Need ≥2 orders per party"
6. **Party detail**: desktop right column `section-card p-4` (`PartyPanel`). Mobile: full-screen overlay with backdrop + bottom-sheet (`animate-slide-up`, drag handle, `rounded-t-2xl`)
7. **Empty states**: if `!data`: `Phone` icon, "No Data Loaded". If no parties: `Users` icon, "No Sales Data Found"

#### Components used
- lucide: `Phone, TrendingUp, TrendingDown, Users, Calendar, AlertTriangle, ChevronRight, ArrowUpRight, ArrowDownRight, X, CheckCircle, Zap, Target, BarChart2, Clock, MessageCircle, Copy, ExternalLink`
- recharts: `AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar` (inside PartyPanel)
- `@tanstack/react-virtual`
- `PartyPanel`, `OppCard`, `ChurnRow`, `CalendarItem`

#### Data sources & algorithms
- `useDataset()`
- `useUIStore.isMobile`
- Algorithm: full per-party stats + opportunity generation pipeline is detailed in **ENGINE_FORMULAS_FOR_WEB.md §7** (RFM scoring, churn risk, predicted next order, opportunity generation, dedup, sort).
- **Recommended:** prefer `mv_party_outreach_stats` (refreshed nightly) over client-side `computePartyStats` to avoid 1-2s freeze on Outreach mount with 500 parties.

#### Supabase tables (web port)
- **READ:** `tally_vouchers` + `tally_voucher_inventory_entries` + `tally_ledgers` + `tally_stock_items`
- **Prefer:** `mv_party_outreach_stats(party_ledger_id, total_revenue, order_count, last_order_date, predicted_next_order, churn_risk, tier, …)`
- **READ + WRITE:** `calling_list_entries` — when sales adds a party to "today's calls" via the bottom-sheet action button

#### Interactions
- Tab buttons: switch `activeTab`
- Type filter chips (Opp tab): set `typeFilter`
- Search input: substring per tab
- Opportunity card click: toggle `selectedPartyId`. Same party twice → clear
- Party row click (Parties/Churn/Calendar): same handler. Calendar additionally switches `activeTab` to "parties"
- PartyPanel close X: clear `selectedPartyId`
- Mobile sheet backdrop click: closes panel
- **Web port additions (must be implemented):**
  - **`tel:` link** on party phone if present in `tally_ledgers.phone` (Electron port adds via Tally extension)
  - **WhatsApp share** button → `https://wa.me/{phone}?text={encoded_message}` where message = `"Hi {partyName}, your typical order is due in {N} days. Should I prepare a quote?"` (or per opp type)
  - **Copy** button → clipboard.writeText `"{partyName} - ₹{predictedValue} expected by {predictedNextOrder}"`
  - **"Add to today's calls"** button → upserts `calling_list_entries` with `called=false, added_at=now()`

#### Filters / Sorting / Search
- Filters: type chip (ALL/upsell/reactivation/retention) on Opportunities tab only
- Sort: implicit (opps by `priorityScore` desc, parties by `totalRevenue` desc, churn by `churnRisk` desc, calendar by `predictedNextOrder` asc)
- Search: party name (all tabs) + opp rationale (Opportunities)

#### Modals / sub-components

**PartyPanel**: Header (tier badge + trend badge + name + "X orders · ₹Y avg"). KPI grid 2x2 (Annual Revenue, Churn Risk colored, Orders/Month, Last Order colored by recency). 6-Month Revenue area chart (h 80, indigo gradient `#6366f1`). RFM bar chart (h 60, 3 bars + value/label triplets). Predicted Next Order card (conditional, border colored by confidence ≥70 accent vs warn). Top Items list (names truncate >28 chars). **Web port adds:** action button row (Call / WhatsApp / Copy / Add to calls) above KPI grid.

**OppCard**: icon bubble (color by type), party name, rationale (1-line), action line (accent arrow), right column `estimatedValue` + conversion% + "URGENT" badge or "Act in Nd"

**ChurnRow**: name + tier badge + trend% + days-since-last + risk bar (desktop) + numeric score /100 + total revenue (desktop)

**CalendarItem**: date block (colored by overdue/<=3d/normal) + party name + relative label (`Today`/`Tomorrow`/`In Nd`/`Nd overdue`) + predicted value + confidence%

#### Mobile vs desktop
- `useUIStore.isMobile` controls: search position (header vs full-width), party detail bottom sheet vs right column, hidden columns on Parties/Churn rows (`md/lg` modifiers)
- KPI grid 2/4. Tabs hide labels on small screens
- Bottom-sheet overlay: `fixed inset-0 z-50` + backdrop + slide-up
- **Web port additions:** tel: links, WhatsApp share buttons, one-tap clipboard copy of suggested order text

#### Edge cases
- `data===null` → empty state
- 0 parties → "No Sales Data Found"
- `filteredOpps` empty → in-tab empty card
- `calendarParties` empty → "No predictions yet / Need ≥2 orders"
- Party with `sorted.length<2` → no predicted order, no UPSELL opp generated
- `prevRev===0 && recentRev===0` → trend stable, trendPct 0
- Top item lookup undefined → fallback to itemId as name

---

### Page: Alerts (Low Stock)
**Route:** `/alerts`
**Source:** [src/pages/Alerts.tsx](../src/pages/Alerts.tsx)
**Purpose:** Lists stock items below safe levels (Critical / Low / Reorder) from Tally inventory + voucher consumption. Adds recommended reorder qty directly into central Order draft.

#### Layout
1. **Header**: `h1` "Low Stock Alerts" + muted "{N} items". Right: "Add All" (`ShoppingCart`)
2. **KPI grid** (2/4): "Need Reorder" (warn), "Reorder Value" (accent ₹), "Zero Stock" (danger), "< 1 Month" (warn)
3. **Filter bar** (wraps mobile): Group select ("All Groups" + each unique), Severity select ("All", "Critical", "Low", "Reorder"), search input `flex-1 min-w-120px`
4. **List/Table**:
   - **Mobile**: `.bento-card` per item — name + group + severity badge; 3-col mini-grid Stock/Avg-mo/Reorder; "Add to Order" / "Added" button when `suggested>0`
   - **Desktop**: section-card sticky header `Item / Group (lg) / Stock / Avg/Mo (md) / Mo Left (md) / Reorder / Status / Action`. Virtualized body (row 48, overscan 20, container `min(65vh, 600px)`)
5. **Empty state**: `AlertTriangle` 64px + "No Data Loaded"

#### Components used
- lucide `AlertTriangle, ShoppingCart, Check`
- `@tanstack/react-virtual`
- Engine: see ENGINE_FORMULAS_FOR_WEB.md §1.1, §1.4, §1.5, §1.6 (severity ladder)

#### Data sources
- `useDataset()`, `useOrderDraft()` mutations
- `useUIStore.{unitMode, isMobile}`
- `alertData`: for each item:
  - `stock = getCurrentStockIndexed(item, voucherIndex)`
  - `avgOut = avgMonthlyOutwardIndexed(item, voucherIndex, 3)` (3-month trailing avg)
  - `suggested = suggestedReorderIndexed(item, voucherIndex, stock)`
  - `monthsRemaining = avgOut>0 ? stock/avgOut : Infinity`
  - **Severity ladder**: `stock≤0`→Critical, `avgOut>0 && stock<avgOut`→Low, `suggested>0`→Reorder, else OK. OK filtered out
- Sort: Critical < Low < Reorder < OK

#### Supabase tables (web port)
- **READ:** `tally_stock_items`, `tally_voucher_inventory_entries`, `mv_low_stock_items`
- **WRITE:** `order_draft_lines` via `Add to Order` action

#### Interactions
- Filters: group / severity / search — update state
- **Add All**: iterates `filtered` rows where `suggested>0`, calls `handleAdd`. Marks in `addedItems` Set; button label switches to "Added" with `Check`
- **Per-item Add** (mobile + desktop): same `handleAdd` — upserts `order_draft_lines` row `{ item_id, item_name, base_unit, pkg_unit, units_per_pkg, qty_base: suggested, rate_per_base: openingRate }`

#### Filters / Sorting / Search
- Filters: group, severity
- Sort: severity order (hardcoded)
- Search: substring on `item.name` lowercase

#### Mobile vs desktop
- Two render paths. Mobile cards; desktop virtualized flex-row table with extra cols (`Group` hidden `<lg`, `Avg/Mo` and `Mo Left` hidden `<md`)
- `unitMode` toggles base/package display via `toDisplay`

#### Edge cases
- No data → empty state
- `avgOut===0 && stock>0` → infinity glyph in Mo Left
- `stock≤0` → "0" months, danger
- `suggested===0` → reorder col `-`, no Add button
- Items lacking pkgUnit/unitsPerPkg → `toDisplay` falls back to base

---

### Page: Calendar
**Route:** `/calendar`
**Source:** [src/pages/Calendar.tsx](../src/pages/Calendar.tsx)
**Purpose:** Visual ops console for delivery/sales workflow. Shows Tally vouchers (DN/Sales/Purchase/Receipt/Payment) on a month grid, day rows, or list, overlaid with per-voucher kanban status, scheduled-date override, notes, follow-up log. Persists to `voucher_overrides` (already wired in Electron).

#### Layout
1. **Header**: title "Orders Calendar" + strapline "{N} vouchers from Tally · drag to reschedule · drag to change stage". Right: `Filter` icon + 5 type-toggle pills (DN/Sales/Purchase/Receipt/Payment) — active inverted black
2. **AnalyticsBar**: 4 KPI cards — "Total Orders" (count), "Total Value" (`fmtLakh`), "Completion" (% done/invoiced), "Overdue" (count). Color: completion green ≥60% else amber; overdue red if >0 else green
3. **View selector + status chips row**: segmented "Month / Days / List" (CalendarDays/Rows3/List). Right: status chips "All ({N})" + per non-empty status (`pending/confirmed/dispatched/delivered/invoiced/done`) colored by `STATUS_CFG`. Hidden when `viewType==="month"`
4. **Main + detail panel** flex row:
   - **Views (`flex-1`)**:
     - **MonthView**: 7-col grid. Month nav `ChevronLeft / Month Year / ChevronRight`. Day-of-week row. Cells `min-h 100px`, today accent. Up to 3 colored chips per cell (party first word + amount + status color), `+N more` if overflow. Empty cells slate
     - **DayRowsView (kanban)**: sticky month nav, status legend row, day rows. Today amber tint, weekends neutral. Row: 16px left col (circular day number, today filled accent), day-name, daily total. Right: horizontal-scroll `DayCard`s (`w-44`, party / amount / voucher# / status dot / rescheduled "↷"). Entire row is a drop target; "Drop here" placeholder when empty + dragOver
     - **ListView**: top sort bar (Date / Amount / Party with `ChevronDown`). Table: `Party / Type No. / Status / Date / Amount / Items`. Selected row accent left border; overdue red tinted. Empty: `List` icon + "No vouchers match the current filter"
   - **DetailPanel** (sticky right, 320/384px `lg/xl`, `max-h calc(100vh-200px)`): header (party / type / number / close X). Body: current status badge + 5-button quick-move grid; metric pair (Amount, Date with rescheduled strikethrough); item list (inventory lines, qty × rate); narration block; editable notes (amber bg when set); follow-up log; "Reset to original date" if `isRescheduled`. Footer: "Log Follow-up" button transforms to input + Save/Cancel
5. **Empty state**: `CalendarDays` icon, "No Tally data imported"

#### Components used
- lucide `CalendarDays, Rows3, List, ChevronLeft, ChevronRight, X, Clock, TrendingUp, AlertTriangle, CheckCircle2, Activity, MessageSquarePlus, GripVertical, ChevronDown, Package, Filter, RotateCcw`
- Internal: `StatusBadge`, `DayCard`, `DayRowsView`, `MonthView`, `ListView`, `DetailPanel`, `AnalyticsBar`
- HTML5 native drag/drop on desktop; `react-dnd-touch-backend` on mobile (REQUIRED — Electron's HTML5 DnD doesn't work on touch)

#### Data sources
- `useVoucherOverrides()` (TanStack Query on `voucher_overrides`) + mutations `useUpsertVoucherOverride, useDeleteVoucherOverride`
- `useDataset()` for `data.vouchers`
- Local UI Zustand `useCalendarUIStore` for `viewType, selectedId, currentMonth, showTypes` (these don't need to persist server-side — local prefs)
- Derived:
  - `allDisplayVouchers`: vouchers matching `showTypes && !isCancelled`, merged with override `{ status, scheduledDate, notes, followUps, isRescheduled }`. Default status `"pending"`, default `displayDate = voucher.date`
  - `filteredForMonth`: displayDate matches `currentMonth`
  - `filteredAll`: optionally narrowed by `statusFilter`
  - `viewItems`: month → filteredForMonth; kanban/list → filteredAll
  - `selectedDV`: lookup by voucherId

#### Supabase tables (web port)
- **READ:** `tally_vouchers`, `tally_voucher_*_entries`
- **READ + WRITE:**
  - `voucher_overrides` (`voucher_id PK, status TEXT, scheduled_date DATE NULL, notes TEXT NULL, follow_ups JSONB DEFAULT '[]', updated_at`)

#### Interactions
- Type toggle pills: add/remove from `showTypes`
- View buttons: `setViewType`
- Status chips: set `statusFilter`
- Month nav: `navigateMonth(-1|1)`
- Voucher card click: `setSelectedId`
- **Drag voucher** (Month + DayRows): `onDragStart` writes `voucherId` to dataTransfer; `onDrop` calls `setScheduledDate(voucherId, isoDate)` — upserts `voucher_overrides`
- Drag visual: `onDragOver` highlights with accent ring; `onDragLeave` resets
- List sort buttons: click active col toggles direction; click different col resets to desc
- **DetailPanel**:
  - Status grid → `setStatus` mutation
  - Notes Add/Edit → textarea + Save (calls `setNotes`)/Cancel
  - "Log Follow-up" → input; Enter or Save → appends to `follow_ups` jsonb array (timestamp = now ISO); Cancel hides
  - "Reset to original date" → `deleteVoucherOverride(voucherId)` (clears notes + status too)
  - Close X → `setSelectedId(null)`

#### Filters / Sorting / Search
- Filters: type pills + status chips (kanban/list). No text search
- Sort: list view only — date/amount/party, asc/desc, default date desc

#### Mobile vs desktop
- When `selectedDV` set, views get `hidden lg:block` → detail panel takes over screen on mobile. `lg+` side-by-side
- Type pills wrap. AnalyticsBar 2/4
- MonthView cells `min-h 100px` (cramped on mobile)
- **Touch DnD: use `react-dnd-touch-backend`** so mobile users can reschedule

#### Edge cases
- `data.vouchers.length===0` → "No Tally data imported"
- Empty month + month view → hint to navigate
- Cancelled vouchers excluded unconditionally
- Overdue: `displayDate < today && status not in ('done', 'invoiced')` → red left border + red date text + red row tint
- Rescheduled: original date strikethrough + arrow → displayDate; `↷` glyph in DayCard
- No partyName → "—". No inventory lines → no "X items" sub-text

---

### Page: Routes (Map)
**Route:** `/routes`
**Source:** [src/pages/Routes.tsx](../src/pages/Routes.tsx)
**Purpose:** Interactive Leaflet map of West-Bengal delivery network. Howrah godown, every freight station, freight rate / distance / drive-time, dashed-line route pairs for trucks serving 2 stations per trip. Highlights stations with pending DNs.

#### Layout
- Outer: `flex flex-col`, `height: calc(100vh - 56px)`, padding 12/16
1. **Header row**: `h1` "Routes Map" + strapline with godown address
2. **Body** `flex gap-3 flex-1 min-h-0`:
   - **Side panel** (`w-[340px]`): search + Sort/Zone selects, scrollable station list, footer "Showing X of Y stations" + zone legend (color dots near/short/medium/long/far with km ranges)
   - **Map + detail col**: `<div ref=mapRef>` Leaflet container fills remaining. When selected, `section-card p-4` below with details

#### Components used
- `leaflet` (`L.map, L.tileLayer, L.marker, L.polyline, L.divIcon`). `leaflet/dist/leaflet.css`
- lucide `Navigation, ExternalLink, X, AlertTriangle, MapPin`
- Static data file `packages/shared/data/stationData`: `STATIONS, GODOWN, ROUTE_PAIRS, ZONE_COLORS, ZONE_LABELS, ZONE_RANGES, formatDriveTime, getDistanceZone, StationData`
- Marker factories in-file: `makeDotIcon, makeBeaconIcon` (animated pulse), `makePairedIcon` (white inner), `makeGodownIcon` (square blue + center dot). `beacon-pulse` keyframe injected once into `<head>` — needs SSR safety in Next.js: wrap in `useEffect(() => { … }, [])` and guard `typeof document !== "undefined"`.
- Icons cached at module scope via `_iconCache` Map keyed by `${variant}|${color}|${selected}` (already done in Electron — copy verbatim)

#### Data sources
- Static: `STATIONS` (~85 stations: `id, name, district, lat, lng, freightRate, distanceKm, estimatedDriveMinutes, googleMapsQuery, notes, salesInvoices, salesValueINR, parties`), `GODOWN`, `ROUTE_PAIRS`
- Dynamic: `useDataset().data.vouchers` filtered to non-cancelled non-optional DNs. For each DN, lowercase `partyName` matched against `station.parties` — first match increments `pendingCountMap.get(station.id)`

#### Supabase tables (web port)
- **READ:** `tally_vouchers` (`voucher_type='Delivery Note', party_name, is_cancelled, is_optional`)
- Station/route data: bundle as JSON in web app. If editable: `stations` + `route_pairs` tables

#### Interactions
- Search input: substring on `name + district + parties.join(" ")`
- Sort select: freight asc / distance asc / invoices desc / name A-Z
- Zone select: filter by `getDistanceZone(distanceKm)`
- **Station card click**: `setSelectedId(isSelected ? null : station.id)`. Triggers:
  - Map flyTo `[lat,lng] zoom 12` (or back to `[22.8, 88.2] zoom 8` when deselected) — 700ms
  - Polylines from godown → selected → each pair, indigo dashed `6 5`, weight 2.5, opacity 0.65
  - Markers updated: selected uses larger dot or beacon; paired use `makePairedIcon`; previous selection's pairs revert
  - Popup re-content includes pending count badge + pair badge
- **Map marker click**: `onSelectRef.current(station.id)` — toggle
- **Detail panel**:
  - Header: zone dot, name, district, pending pill, warn icon if `hasWarning` (`freight > 8000` OR notes mention "actual"/"special"). Close X clears
  - 3-stat grid: Freight (₹/truck, colored), Distance (km), Drive Time
  - Parties list (comma-joined)
  - Notes (warn-styled) if `station.notes`
  - Route pairings list: clickable buttons — clicking switches selection
  - **Get Directions** → `https://www.google.com/maps/dir/?api=1&origin=B20+KMDA+Kona+Truck+Terminal+Howrah+West+Bengal+India&destination={station.googleMapsQuery}&travelmode=driving` (new tab)
  - **View on Map** → `https://www.google.com/maps/search/?api=1&query={station.googleMapsQuery}`
- Marker popups: inline HTML strings with Get-directions anchor

#### Filters / Sorting / Search
- Search (case-insensitive substring on name + district + parties)
- Sort: freight asc / distance asc / invoices desc / name asc
- Zone filter: all / near / short / medium / long / far

#### Mobile vs desktop
- **In Electron:** hard-coded `w-[340px]` panel + `flex-1` map. On <700px doesn't fit
- **Web port (required):** stack panel under map on `<lg`, with a toggle button; ensure map container has explicit pixel height (`h-[60vh]` or similar) on mobile so Leaflet renders
- Leaflet: dynamic-import in Next.js (`ssr:false`)

#### Edge cases
- `selectedId` not in `ROUTE_PAIRS` → no polylines
- `station.distanceKm===null` → "— km", popup hides distance, sort treats as 9999
- `station.salesInvoices===0` → "No sales" pill
- No DNs → all markers normal dot
- Tile errors: Leaflet blank tiles; set fallback `errorTileUrl`
- Marker icons update only `toUpdate` set (prev + new selection + their pairs) — important optim for 80-100 stations

---

### Page: Distance
**Route:** `/distance`
**Source:** [src/pages/DistancePage.tsx](../src/pages/DistancePage.tsx)
**Purpose:** Compute road distance from Kolkata 700001 to each party's PIN via NIC e-Waybill distance API (proxied through Next.js API route in web). Manual PIN overrides + bulk fetch with cache.

#### Layout
1. **Header**: `h1` "Party Distances" + strapline "Distance from Kolkata 700001 via NIC e-Waybill". Right: "Fetch All ({withPinCount})" (`RefreshCw` spinning when batchRunning, disabled if 0 PINs)
2. **Filters card**: white `rounded-xl`. 2-col grid (md+) — Search (label "Search", magnifier, placeholder "Search by party name, PIN, state, GSTIN…") and Party Type select (Sundry Debtors / Sundry Creditors / All Ledgers). Footer: "{sorted.length} parties" + "{withPinCount} with PIN" + "{loadedCount} distances loaded"
3. **Table**:
   - Sticky grid `1fr 120px 120px 180px 56px`: Party / PIN Code / State / Distance (e-Waybill) / edit
   - Body scroll `max-height: calc(100vh - 360px)`
   - Empty inside: `Navigation2` + "No parties found"
4. **No-data state**: full-page `Navigation2`, "No Data Loaded"

#### Components used
- lucide `Navigation2, Search, RefreshCw, Pencil, Check, X`
- No external libs beyond lucide + clsx

#### Data sources
- `useDataset()` for `data.ledgers`
- `useLedgerPincodeOverrides()`, `useUpsertLedgerPincodeOverride`
- `usePincodeDistances()` (cache table)
- Local state: `search`, `groupFilter` ("Sundry Debtors" default), `editingPin`, `editValue`, `batchRunning`
- Derived:
  - `rows`: ledgers filtered by group, mapping to `PartyRow` with `pincode = overrides[id] ?? l.pincode`
  - `filtered`: substring search across `name + pincode + state + gstin`
  - `sorted`: by loaded distance asc (Infinity if not fetched), tiebreak name
  - `withPinCount`: rows with 6-digit pincode
- Server: `GET /api/distance?from=700001&to={pin}` (Next.js Route Handler that calls `https://ewaybillgst.gov.in/apipre/api/v1.0/Distance/pincode?...`). Response cached in `pincode_distances` table; route handler returns cached value if `fetched_at` < 30 days old

#### Supabase tables (web port)
- **READ:** `tally_ledgers`, `pincode_distances`
- **READ + WRITE:**
  - `ledger_pincode_overrides` (`ledger_id PK, pincode_override TEXT`)
  - `pincode_distances` (`from_pin, to_pin, distance_km, fetched_at`)

#### Interactions
- Search input: controlled, no debounce
- Party Type select: `groupFilter`
- **Fetch All**: iterates `filtered` with valid PIN, calls `/api/distance` sequentially with `setTimeout(250ms)`. Disabled while running or 0 PINs
- **Per-row Fetch link**: single row
- **Edit PIN pencil**: sets `editingPin = ledgerId`, `editValue = current pin`
- **PIN edit input**: `maxLength=6` digits. Enter commits, Escape cancels; tick / X buttons
- **Commit**: trims if non-empty writes to `ledger_pincode_overrides`; if empty deletes override
- **Errors**: red "Error" text with `title=dist.error`

#### Filters / Sorting / Search
- Filters: party group (3 options)
- Sort: distance asc (unfetched last), then name
- Search: `name + pincode + state + gstin` substring

#### Mobile vs desktop
- No `isMobile` branch in Electron
- Fixed grid `1fr 120px 120px 180px 56px` — narrow screens overflow without scroll
- **Web port (required):** collapse to cards on `<md` OR horizontal overflow with sticky party col

#### Edge cases
- `data===null` → empty state
- pincode missing or not 6 digits → "—", no Fetch button, ineligible for Fetch All
- `pincodeOverrides[id]` present → "manual" amber pill; revert via edit-save-empty
- NIC API failure → red "Error" with tooltip; retryable
- API returns null → row stays in "click to fetch" state
- Concurrent batch runs prevented by `batchRunning`

---

### Page: Reports
**Route:** `/reports`
**Source:** [src/pages/Reports.tsx](../src/pages/Reports.tsx)
**Purpose:** 4-tab BI dashboard: financial health, sales performance, inventory health, expense/cash-flow. Renders KPI cards, recharts viz, breakdown tables, click-through drill-down modals.

#### Layout

**Sticky page header**: white bg, bottom border, `z-20`
- **Page title** "Reports" (`text-3xl md:text-4xl font-bold`)
- **Date Range row**: 3 presets `This Month / Last Month / YTD` (active = `bg-accent text-white`); active detected by string equality `dateRange.from === fn().from`. Right: two `<input type="date">` for from/to
- **Tab bar**: 4 tabs (underline-on-active) — `Financial Health`, `Sales Performance`, `Inventory & WC`, `Expense & Cash Flow`. Horizontally scrollable

**Content area** (`max-w-7xl mx-auto px-4 py-8 md:px-6`): renders active tab (each via `React.lazy` to avoid mounting all four)

**Empty state**: when `filteredVouchers.length===0` → "No transactions found for the selected date range."

**Top-level no-data**: centered "No data loaded. Tally sync hasn't run yet." with link to `/sync-logs`

**Drill-down modals**: full-screen overlay (40% black backdrop, `fixed inset-4`, `md:inset-[10vh] lg:inset-[5vh]`). 3 variants: `revenue`, `purchases`, `outstanding`. Each: header (title + X), scrollable list

**Tab 1 — Financial Health**:
- 6 KPI cards in grid `grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4`:
  - Gross Revenue (clickable, trend arrow)
  - Gross Profit (green/red)
  - Gross Margin % (green ≥15%, amber ≥10%, red <10%)
  - Total Purchases (clickable)
  - Bank + Cash (green/red)
  - Net Outstanding (amber/green, clickable)
- **Monthly Chart card**: "Monthly Revenue vs Purchases" → `ComposedChart` 300px, two `Bar`s (Revenue `#3b82f6`, Purchases `#f97316`) on left Y
- **P&L Breakdown card**: 2-col grid `Income / Expenses`. Each lists ledgers from `data.ledgers` where `group === "Income"` or `"Expenses"` as expandable buttons (chevron up/down)

**Tab 2 — Sales Performance**:
- **Top 20 Items chart card**: vertical bar chart 400px, `margin={{left:200, right:20}}`, name truncated 28 chars
- **Sales Velocity table**: heading + search ("Search items…"). Columns Item / Units / Revenue / Avg Rate. Up to 50 filtered. "Show all N items" toggle when >50

**Tab 3 — Inventory & WC**:
- 4-card KPI grid `grid-cols-2 md:grid-cols-4 gap-4`: Total Inventory, Zero Stock (red), Dead Stock, Avg Turnover (currently hardcoded `"2.3x"` in Electron — web port: replace with real `computeItemTurnover` from Engine §1 or `mv_item_turnover`)
- **Filters card**: search + 5 status buttons (All / IN / LOW / ZERO / DEAD); active accent
- **Stock Status table**: Item / Group / Current Stock / Stock Value / Status (color-coded pill). Capped 100

**Tab 4 — Expense & Cash Flow**:
- **Monthly Cash Flow chart**: `ComposedChart` 300px — Receipts green `#22c55e`, Payments red `#ef4444` on left + blue running Balance `Line` on right
- **Expense Breakdown card**: collapsible groups. Each header: sum + chevron. Body: each ledger name + amount + `(pctOfTotal%)`

#### Components used
- Recharts: `BarChart, Bar, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer`
- lucide: `TrendingUp, TrendingDown, X, ChevronDown, ChevronUp, Search`
- Internal: `KPICard`, `DrillDownModal`, four tab components (lazy-mounted)

#### Data sources
- `useDataset()`
- Engine: see ENGINE_FORMULAS_FOR_WEB.md §1, §2 — `computeOutstandingInvoices`, `computeBankBalance`, `getCurrentStockIndexed`, `computeItemTurnover`
- Derived (see Electron source for the verbatim algorithms):
  - `filteredVouchers`: excludes cancelled/optional, filters `dateRange.from ≤ date ≤ dateRange.to`
  - `priorVouchers`: same-length window immediately before from
  - `monthlyChartData`: groups by `date.substring(0,7)`, sums sales/purchases, sorted chronologically
  - `financials`: revenue, purchases, outstanding, bankBalance, priorRevenue
  - `trends.revenue` pct = `(curr-prior)/prior*100`
  - `grossProfit = revenue - purchases`; `grossMarginPct = grossProfit/revenue*100`
  - `topItems`: walks Sales voucher inventory lines, accumulates revenue/qty/lineCount per itemId, sorts by revenue desc, top 20 or all
  - `stockMap`: per item via `getCurrentStockIndexed`
  - `inventory[]`: per item — stock, outwards = Σ qtyBase across Sales lines, periodDays from first/last filtered, `avgMonthlyOutward = outwards / max(1, periodDays/30)`, status:
    - `stock≤0` → "zero"
    - `outwards===0` → "dead"
    - `stock<avgMonthlyOutward*2` → "low"
    - else "in"
    - `stockValue = stock * (item.openingRate || 0)`
  - `monthlyFlow`: sorted by date, accumulates receipts/payments per month, running balance `+totalAmount` Receipt, `-totalAmount` Payment
  - `expensesByLedger`: walks every voucher's ledger lines where `isDebit`, sums by `ledgerId`, computes `pctOfTotal`, sorted desc

#### Supabase tables (web port)
- **READ:** `tally_vouchers`, `tally_voucher_*_entries`, `tally_ledgers`, `tally_stock_items`, `mv_outstanding_invoices`
- **Prefer views**: `mv_monthly_revenue_purchase`, `mv_monthly_cash_flow`, `mv_item_sales_velocity`, `mv_expense_by_ledger`, `mv_current_stock`
- **WRITE:** None

#### Interactions
- Date preset buttons: reset `dateRange` via `setDateRange(fn())`
- Date inputs: live edits
- Tab buttons: switch `activeTab` — tabs lazy-mounted (each is `React.lazy(() => import('./tabs/Financial'))`)
- KPI cards with `onClick`: Gross Revenue → revenue modal; Total Purchases → purchases; Net Outstanding → outstanding
- DrillDownModal: backdrop or X close
- P&L Breakdown ledger rows: toggle `expandedGroup` (only one)
- Sales Performance search: filters by name
- "Show all N items" toggle
- Inventory search + status filter: compose filtering
- Expense Breakdown group headers: toggle expand

#### Filters / Sorting / Search
- Date range: 3 presets + manual inputs
- Sales: name search, 50 cap with expand
- Inventory: search + status `all/in/low/zero/dead`, 100 cap
- Sort: topItems by revenue desc; monthly chronological; expenses by amount desc

#### Modals
- **KPICard**: label/value, optional trend `{pct, direction}`, color, optional onClick + loading
- **DrillDownModal**: full-page with backdrop, title, X close. Animations
- **Modal variants**:
  - **Revenue**: list `{partyName, date}` left, `formatINR(totalAmount)` right
  - **Purchases**: same
  - **Outstanding**: party + `agingBucket` pill + `formatINR(outstanding)`

#### Mobile vs desktop
- KPI grids responsive
- Filters: `flex-col md:flex-row`
- Page title `text-3xl md:text-4xl`
- Modal sizing: `inset-4` mobile, lg `inset-[5vh]`
- Tabs `overflow-x-auto`

#### Edge cases
- No data: link to Sync Logs
- Empty date range: "No transactions found"
- No prior revenue: trend pill suppressed
- Division by zero: `grossMarginPct` returns 0 if revenue=0; `pctOfTotal` returns 0 if total=0
- Item missing from items map: filtered out
- Avg Turnover hardcoded "2.3x" — TODO replace with real metric (`computeItemTurnover` from Engine)

---

### Page: Settings
**Route:** `/settings`
**Source:** [src/pages/Settings.tsx](../src/pages/Settings.tsx)
**Purpose:** Central control: storage diagnostics, sync history, unit mode, financial year, planning constants, unit Excel import/export, data integrity audit, audit log export.
**Web port differences:** no Electron-only sections (Tally proxy URL, local backups, "erase all data" with backup, IDB diagnostics). Add: Sync History from `tally_sync_history`.

#### Layout
- Single `max-w-2xl space-y-6` column. Each section is a `Section` card with `.section-header`
1. **Page header**: `SettingsIcon` (24px accent) + "Settings"
2. **Data Overview section**: `HardDrive` icon + descriptor. 3-col `Stat` grid (Items / Ledgers / Vouchers) sourced from `useDataset()` size. Last imported from `tally_companies.imported_at`.
3. **Sync History section** (NEW): reads `tally_sync_history` last 20 rows. Per row: status icon (green check / red X) + started_at + duration + `row_counts.items / ledgers / vouchers`. Subscription via Realtime so the page auto-updates when Electron pushes a sync.
4. **Unit Mode**: "Currently: BASE/PKG" + button "Switch to PKG/BASE" — persists via `app_settings` upsert (key=`unitMode`)
5. **Financial Year**: `<select>` from year-3 to year+1, format `YYYY-YYYY` — persists `app_settings.fyYear`
6. **Default Cover Months**: 4 pill buttons `1, 1.5, 2, 3`; active = `.btn-primary` — persists `app_settings.coverMonths`
7. **Lead Time Months**: `<input type="number" min=0.5 max=6 step=0.5>` fallback 1.5 — persists `app_settings.leadTimeMonths`
8. **Default Credit Days**: `<input type="number" min=0 max=365>` fallback 30 — persists `app_settings.defaultCreditDays`
9. **Unit Configuration**: `Export Template` (`FileSpreadsheet`) + `Import Excel` (`Upload`, hidden `<input type="file" accept=".xlsx,.xls">`). Shows "N unit override(s) currently applied"
10. **Diagnostics**: `Run Audit` button. If `auditResults` exists:
    - Summary: 2 bento-cards "Items Passed N/M" and "Chain Valid N/M"
    - Invoice Balance: 3-col Billed / Paid / Outstanding (in ₹L)
    - Voucher Types: 2-col grid type → active count, `(-X)` cancelled, `(~Y)` optional
    - Issues Found: collapsible discrepancies (table Item × Opening × In × Out × Discrepancy), Negative Stock list, Items without GST grid. `▶`/`▼` arrows
    - Dead Items: info line "ℹ N dead item(s)"
11. **Audit Log**: `Export Audit Log` — paginated server-action download of `audit_log` rows (last 30 days by default)
12. **Reset Defaults** (replaces Electron's Danger Zone):
    - **Reset discount rules to defaults** (button, confirm dialog) — re-seeds from `data/discountDefaults.json`
    - **Reset order groups to defaults** (button, confirm) — re-seeds from `data/defaultOrderGroups.json`

#### Components used
- lucide `Settings as SettingsIcon, Trash2, Download, Upload, AlertTriangle, FileSpreadsheet, Archive, RotateCcw, Shield, HardDrive, Activity, RefreshCw, CheckCircle, XCircle`
- Internal: `Section`, `Stat`, `SyncHistoryRow`, `useToast`

#### Data sources
- `useDataset()`, `useUnitOverrides()`, `useAppSettings()` + matching mutations
- `useTallySyncHistory()` (latest 20)
- `useAuditEngine()` — dynamic import of `engine/audit` for `auditAllItems, auditInvoiceBalance, getVoucherTypeDistribution, findNegativeStockItems, findDeadItems, findItemsWithoutGST`
- Excel: `exportUnitsToExcel, importUnitsFromExcel`

#### Supabase tables (web port)
- **READ:** `tally_sync_history`, `tally_companies`, `tally_stock_items` (counts), `tally_ledgers`, `tally_vouchers`, `unit_overrides`, `app_settings`, `audit_log`
- **READ + WRITE:** `app_settings` (settings keys), `unit_overrides` (Excel import)

#### Interactions
- Toggle Unit Mode → upsert `app_settings.unitMode`
- FY select → upsert `app_settings.fyYear`
- Cover Months pills → upsert `app_settings.coverMonths`
- Lead Time / Credit Days inputs → upsert
- Export Template → `exportUnitsToExcel(data.items, units)` + toast
- Import Excel → hidden file input; per-row upsert + toast errors
- Run Audit → `runningAudit=true`, dynamic-import engine, compute 6 audits, toast
- Toggle Discrepancies / NegativeStock / NoGstItems: 3 independent expand toggles
- Export Audit Log → Server Action paginates `audit_log`, returns blob → `audit_log_YYYY-MM-DD.json`
- Reset discount rules: 2-step confirm — first click sets `confirmReset=true`; second click runs server action that DELETEs `discount_rules` + `category_colors` + `item_category_overrides` for the company and re-inserts from defaults JSON
- Reset order groups: same pattern with `order_groups` + `vendor_group_assignments`

#### Filters / Sorting / Search
None.

#### Mobile vs desktop
- `max-w-2xl` → narrow desktop, full-width mobile
- FY dates `grid-cols-2` always
- Storage stats `grid-cols-3` always

#### Edge cases
- No data → Local Storage shows "No data loaded"; Diagnostics + Unit Export/Import disabled
- No sync history → "No syncs yet"
- No unit overrides → hides "N unit override(s)"
- No audit yet → hides audit summary
- All passing audit → success toast; no Issues block

#### Sections explicitly removed from Electron's Settings page
- ❌ Tally Connection (Electron-only — there's no local proxy in the browser)
- ❌ Backup Management (lives in Supabase / handled by their backup retention)
- ❌ Clear Working Data / Erase All Data (Tally is the source of truth; the web can't erase Tally)
- ❌ Team management (no auth in v1)

---

### Page: Sync Logs (replaces ServerLogs)
**Route:** `/sync-logs`
**Source (template):** [src/pages/ServerLogs.tsx](../src/pages/ServerLogs.tsx)
**Purpose:** Live log viewer reading `sync_logs` Supabase table via Realtime (replaces Electron's SSE to local Express).

#### Layout
- `flex flex-col h-full bg-neutral-950 text-neutral-100 font-mono`
1. **Header bar**: dark `bg-neutral-900`
   - **Left**: `Terminal` icon + "Sync Logs" + `Circle` indicator (emerald connected / red disconnected) + label
   - **Right**: 3 filter pills `All (N) / Errors (N) / Warn (N)` (active: `bg-neutral-700 / bg-red-900 / bg-yellow-900`) + Reconnect (`RefreshCw`) + Copy all (`Copy / CheckCheck`) + Clear (`Trash2`, red hover — UI-only)
2. **Log body**: scrollable `space-y-0.5 text-xs leading-5`. Per line colored:
   - success → emerald-400
   - error → red-400
   - warn → yellow-400
   - info → neutral-300
   - `whitespace-pre-wrap break-all`
   - Empty: "No log entries yet." in neutral-600
   - `bottomRef` for auto-scroll
3. **Footer scroll-to-latest**: when `autoScroll===false`. Centered "↓ scroll to latest" resumes auto-scroll

#### Components used
- lucide `Terminal, Trash2, Copy, CheckCheck, RefreshCw, Circle`
- Supabase Realtime channel (replaces `EventSource`)
- `navigator.clipboard`

#### Data sources
- Initial fetch: `useQuery(['sync_logs'], () => sb.from('sync_logs').select('*').order('timestamp', { ascending: false }).limit(2000))`
- Realtime subscription on `sync_logs` INSERT — prepends new rows
- Classification (replicates Electron logic):
  - success: contains `✓ / ready / success / ✅`
  - error: `❌ / ✗ / error / Error / failed / Failed`
  - warn: `⚠ / warn / Warn / timeout / retry`
  - default info
- State: `lines: LogLine[]` capped 2000; `autoScroll, connected, copied` (2-sec reset), `filterLevel`

#### Supabase tables (web port)
- **READ + Realtime:** `sync_logs` (`id BIGSERIAL, sync_id UUID, timestamp TIMESTAMPTZ, level TEXT, message TEXT`)
- **No write** from web

#### Interactions
- Filter pill: `setFilterLevel`
- Reconnect: refetches buffer + re-subscribes Realtime
- Copy all: joins all (unfiltered) `\n`-separated, clipboard.write, `CheckCheck` for 2s
- Clear: `setLines([])` client-side only (does not delete from DB)
- Scroll: detect bottom (within 60px) → `autoScroll=true`; scroll up → `autoScroll=false`
- Scroll-to-latest button: smooth scroll + `autoScroll=true`
- Auto-scroll effect: every new lines array, if `autoScroll`, scroll into view

#### Filters / Sorting / Search
- Filter: all / error / warn (info shows only in "all")
- Sort: implicit chronological
- Search: none in v1

#### Mobile vs desktop
- No explicit responsive logic — `flex-col h-full`
- Toolbar may overflow narrow widths — consider wrapping

#### Edge cases
- Empty buffer: "No log entries yet."
- Disconnected: red indicator
- 2000-line cap: oldest truncated
- No clipboard API: silent fail

---

### Page: PerfLog (optional)
**Route:** `/perf-log`
**Source:** [src/pages/PerfLog.tsx](../src/pages/PerfLog.tsx)
**Purpose:** Live perf instrumentation. **Web port recommendation: DROP this page** and rely on Vercel Speed Insights + Web Vitals instead. If kept for parity, gate behind a query param `?devtools=1`.

If kept (verbatim spec for completeness):
- 5-sec memory snapshots (`performance.memory` — Chromium only)
- Long-task observer (PerformanceObserver `longtask`)
- Route timing
- FPS via rAF deltas
- User markers
- KPI cards + 5 detail tabs + JSON export

The `useElapsed` hook in Electron has a bug (uses `useState(initializer)` instead of `useEffect`); fix when porting.

---

## Part 5 — Sync Boundary with Electron

| Action | Origin | Sync direction |
|---|---|---|
| Tally XML imported | Electron only | Electron → Supabase. Web reads. |
| Discount rule edited | Either | Last-write-wins via `updated_at`. Both see updates via Realtime. |
| Order group created | Either | Same. |
| Vendor group reassigned | Either | Same. |
| Calendar status / scheduled date edited | Either | Same — already promoted to `voucher_overrides` (migration 007). |
| Item category override edited | Either | Same. |
| Calling list entry added | Either | Same. |
| Unit/rate override edited | Either | Same. |
| Tally price list imported | Either | Either client can run JSON upload; both write to `tally_price_list_imports`. |
| App setting toggled | Either | Same (`app_settings`). |
| Order draft line edited | Either | Same (`order_draft_lines`) — useful for picking up draft on a different device. |
| Push to Tally | Electron only | Web disabled. No CTA — silently absent. |

**Conflict resolution:** Last-write-wins on every config table's `updated_at`. Acceptable because edits are infrequent and concurrent edits are rare.

**Sync triggers in Electron (already implemented):**
- 2 s debounce after a config edit → POST to `/api/supabase/sync-config`
- 5 min after Tally sync completes → push items + ledgers + vouchers + config
- 15 min interval (in case the user is editing without triggering Tally sync) → push everything

The web app does not need a debounce strategy — every Server Action write is immediate, and Realtime propagates to other clients.

---

## Part 6 — Engine Reference

The web app's business logic is **defined exclusively** in:

**[ENGINE_FORMULAS_FOR_WEB.md](../ENGINE_FORMULAS_FOR_WEB.md)** (920+ lines)

Sections:
- **Part 0** — Foundational rules: voucher exclusion, types, line types, sign conventions, date format
- **Part 1** — Inventory engine: current stock, voucher index, monthly buckets, avg monthly outward, suggested reorder, severity ladder, months remaining
- **Part 2** — Financial engine: ledger classification, outstanding invoices, aging buckets, bank+cash, monthly totals, item margins
- **Part 3** — Discount engine: data sources, package count formula, tier matching, voucher discount calculation (full pipeline)
- **Part 4** — Unit conversion: display → base, base → display
- **Part 5** — Movement tracer: direction per voucher type, get movements, get pending order docs
- **Part 6** — Edge cases & common bugs

Every page section in Part 4 above cites the relevant Engine sections. **Do not reimplement** — import from `packages/shared/engine/*`.

---

## Part 7 — Phases / Roadmap

### Phase 0 — Repo + foundation (Week 1)
- Move Electron `src/` → `apps/electron/`. Verify it still builds and runs.
- Create `packages/shared/` and move pure modules (engine, components, utils, data, types) into it. Update Electron imports to `@mkcp/shared/*`. Verify Electron still works.
- Scaffold `apps/web/` Next.js 15 + Tailwind. Copy `src/index.css` → `apps/web/app/globals.css`.
- Wire generated Supabase types: `pnpm gen:types` script that runs `supabase gen types typescript` and writes to `packages/shared/types/supabase-generated.ts`.
- Rotate the leaked service-role key.
- Stand up Vercel project. Add Vercel Password Protection (or Cloudflare Access). No code in the app handles auth.

### Phase 1 — Read pipeline + materialized views (Week 2)
- Migrations 009–011 (audit_log, pincode_distances, ledger_pincode_overrides, sync_logs)
- Migration 012: anon-SELECT RLS policies on every read table
- Migration 013: materialized views (Part 2.5)
- Migration 014: `refresh_dashboard_views()` plpgsql + hook into `syncVouchers`
- Layout shell + NavBar + Toast + skip-to-content
- TanStack Query provider + `useDataset()` + 1 KPI on `/dashboard` proving data round-trips
- **Goal:** Dashboard renders 4 KPI cards with real Supabase data.

### Phase 2 — Read-only views (Week 3-4)
- Invoices, Ledgers, Pending Orders, Price List (read), Reports (all 4 tabs read), Alerts
- TanStack Query caching + Realtime invalidation on `tally_sync_history`
- Mobile bottom-nav + sheet
- All shared modals (VoucherModal, DNModal, GroupDetailsModal)
- Shared components: `KPICard, RatePill, AmountPill, UnitToggle, VendorGroupsSummary, ExpandedGroupsView`
- **Goal:** all read-only pages render with parity to Electron.

### Phase 3 — Config editing (Week 5-6)
- Server Action `/api/config` with allow-list (Part 2.4)
- Mutation hooks (`useUpsert*, useDelete*`) for every config table
- Discount Rules (with color picker)
- Order Groups (with multi-select item assignment)
- Edit Units (with audit_log writes)
- Vendor Groups assignment (via Orders sidebar)
- Item Notes
- App Settings (Unit Mode, FY, Cover Months, Lead Time, Default Credit Days)
- Reset-to-defaults flows
- **Goal:** every config table writable from web with optimistic updates + audit log.

### Phase 4 — Outreach + mobile polish (Week 7)
- Outreach page with `mv_party_outreach_stats` backend
- WhatsApp share buttons + tel: links + clipboard copy (web-only enhancements)
- Bottom-sheet party panel
- Calling list mutations
- **Goal:** field sales can run their day off the web app on a phone.

### Phase 5 — Real-time + Calendar (Week 8)
- Supabase Realtime channels on every config table (Part 3.7)
- Calendar page with drag-and-drop (`react-dnd-touch-backend` on mobile)
- Voucher overrides via mutations
- **Goal:** two browsers open in different windows reflect each other's edits within 500 ms.

### Phase 6 — Routes + Distance + Settings + Sync Logs (Week 9)
- Routes map (Leaflet dynamic-import, `ssr:false`)
- Distance page (Next.js API route `/api/distance` + `pincode_distances` cache)
- Settings (data overview, sync history, audit, reset defaults)
- Sync Logs page (Realtime on `sync_logs`)
- **Goal:** every page from Part 4 implemented.

### Phase 7 — Polish + perf + beta (Week 10)
- Lighthouse audit on each page; fix anything <80
- Bundle split — Recharts + Leaflet + xlsx into separate chunks; lazy per page
- Verify `React.memo` on list cards (`OppCard`, `ChurnRow`, `CalendarItem`, `VoucherCard`, `DayCard`)
- Vercel Speed Insights enabled
- Invite 3 real users (operators) for paced rollout
- Iterate based on feedback
- **Goal:** v1 launch.

---

## Part 8 — Success Metrics

| Metric | Target by month 3 |
|---|---|
| Edits per week (any config table, web) | 50+ |
| Mobile session % (outreach) | >40% |
| Dashboard p95 load time | <2 s |
| Real-time event latency (Electron edit → web visible) | <500 ms |
| Zero data-loss incidents | 100% |
| Lighthouse score (Dashboard) | >85 |
| Number of pages that render with NO client-side compute (use only views) | 6+ (Dashboard, Invoices, Reports, Ledgers, PendingOrders, Outreach) |

---

## Part 9 — Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Leaked service-role key** in `supabaseSync.ts:13-14` | **Rotate before web deploy.** Never ship to browser. Server Actions only. |
| **No auth = anyone with URL has full access** | Gate at the edge: Vercel Password Protection / Cloudflare Access / IP allowlist. Document the access policy in the Settings page. |
| **Realtime floods** during edits | Debounce inbound query invalidation (250 ms); drop duplicate INSERT events. |
| **Tally-sync lag** — web shows stale data | Prominent "Last synced X ago" indicator in NavBar; warning banner if >12 h. |
| **Mobile data costs** (field sales) | Aggressive TanStack caching (5–10 min); SWR for stable lists; avoid loading full voucher dataset on Outreach (use `mv_party_outreach_stats`). |
| **Orphaned references** when Tally deletes items | Periodic cleanup edge function; UI shows "missing item" gracefully with em-dash + tooltip. |
| **Schema drift** between Electron and web | Both import generated types from `supabase gen types typescript`. Run `pnpm gen:types` on every migration. |
| **Calendar HTML5 DnD doesn't work on touch** | Use `react-dnd-touch-backend`. Tested on iOS Safari + Android Chrome. |
| **PerfLog: `performance.memory` Chromium-only** | Drop the page; use Vercel Speed Insights. |
| **Routes Leaflet SSR** | Dynamic-import with `ssr:false`; explicit pixel height on map container. |
| **Discount rule data loss** if SCHEMA_VERSION bumped without migration | Migration logic preserves `itemCategoryOverrides + categoryColors` (already done — see commit history). |
| **Big initial dataset** — first page load tries to fetch all 5000 vouchers | Use materialized views per page (Part 2.5). The Dashboard never reads `tally_vouchers` directly — it reads `mv_monthly_revenue_purchase` + `mv_current_stock`. |
| **Optimistic update rollback feels janky** | Use TanStack's `onMutate`/`onError` to restore the prior cached value; toast on error. |
| **Web user accidentally overwrites Electron-side edit mid-sync** | Last-write-wins is acceptable in this org; for a high-stakes field add a `updated_at` check inside the Server Action ("optimistic concurrency") that returns 409 if the stored row is newer than what the client started editing. |

---

## Part 10 — Open Questions

1. **Domain?** `app.mkcycles.in`? `dashboard.mkcycles.in`?
2. **Edge gate?** Vercel Password Protection (built-in, $$ per user) vs Cloudflare Access (free up to 50 users) vs IP allowlist (works for office only). Likely Cloudflare Access.
3. **Notification channel for alerts** — email? push? WhatsApp? — if low-stock or churn-risk thresholds breached, do we ping someone? Out of v1 scope.
4. **Geocoding budget** for Routes if we ever want geocoded party addresses — Google Maps / Mapbox / OSM Nominatim. v1 sidesteps by using static `STATIONS` + NIC PIN distance.
5. **Should Calendar drag-drop be replaced with explicit "Move to date" picker on mobile?** Touch DnD is fragile even with backends.
6. **PerfLog**: keep, or drop entirely?
7. **Reports tab "Avg Turnover" hardcoded `"2.3x"`** — replace with `computeItemTurnover` median, or drop the card?
8. **Multi-company support**: hardcoded `"M.K.CYCLES (P) LTD."`. If a sister company is added, every config table's `company` column already supports it — just thread an `app_settings.activeCompany` switcher into the UI.

---

## Part 11 — Reusable Assets Inventory

Direct moves into `packages/shared/`:

| Asset | Status |
|---|---|
| `src/index.css` (design tokens + utility classes) | **Copy verbatim → `apps/web/app/globals.css`** |
| `src/components/KPICard.tsx` | **Move to `packages/shared/components/`** |
| `src/components/ColorPicker.tsx` | Move |
| `src/components/PriceVerification.tsx` (`RatePill, AmountPill, priceMatches, PRICE_TOLERANCE`) | Move |
| `src/components/UnitToggle.tsx` | Move |
| `src/components/GroupTabs.tsx` | Move |
| `src/components/VendorGroupsSummary.tsx` | Move |
| `src/components/ExpandedGroupsView.tsx` | Move |
| `src/components/Toast.tsx` | Move |
| `src/components/ErrorBoundary.tsx` | Move |
| `src/components/KPISkeleton.tsx`, `ErrorCard.tsx` | Move |
| `src/engine/discounts.ts` (engine + DEFAULT_DISCOUNT_CATEGORIES + `calculateVoucherDiscount`) | Move |
| `src/engine/financial.ts` (`computeOutstandingInvoices, computeBankBalance, monthlyTotals, computeItemMargins`) | Move |
| `src/engine/inventory.ts` (`getCurrentStockIndexed, avgMonthlyOutwardIndexed, suggestedReorderIndexed, computeMonthlyBucketsIndexed`, etc.) | Move (but **prefer materialized views in the web**) |
| `src/engine/unitEngine.ts` (`toDisplay, fromDisplay`) | Move |
| `src/engine/audit/movementTracer.ts` (`getItemMovements, getItemOrderDocs`) | Move |
| `src/utils/format.ts` (`fmtINR, fmtRate, fmtNum, fmtDate, fmtLakh`) | Move |
| `src/utils/gstInference.ts` (`inferGstRatesFromVouchers`) | Move |
| `src/utils/auditPriceList.ts` | Move |
| `src/data/stationData.ts` (`STATIONS, GODOWN, ROUTE_PAIRS, ZONE_*`) | Move |
| `src/data/vendorGroups.ts` | Move |
| `src/data/discountDefaults.json` (16 categories + ~420 item assignments) | Move |
| `src/data/defaultOrderGroups.json` (19 groups) | Move |
| `src/parser/tallyPriceListParser.ts` (`parseTallyPriceListJson`) | Move |
| Type definitions (`src/types/canonical.ts`) | Move + generated Supabase types |

**Stays in Electron, NOT reusable for web:**
- `src/db/idb.ts` — replaced by Supabase queries
- Electron preload bridge `window.electronAPI.*` — N/A
- `src/parser/transactionParser.ts`, `masterParser.ts` — stays in Electron
- `src/api/tallyApi.ts` — stays in Electron
- `src/hooks/useTallyAutoSync.ts` — stays in Electron
- `src/hooks/usePerfMonitor.ts`, `usePersistenceMonitor.ts` — replaced with Vercel Speed Insights
- `src/store/dataStore.ts`, `tallyStore.ts` — replaced with TanStack Query hooks
- All Electron-side store persist middleware — N/A

---

## Part 12 — Acceptance Criteria for v1 Launch

- [ ] All 17 routes from Part 4 render with real data from Supabase
- [ ] An edit in the web app appears in the Electron app within 5 seconds (and vice versa) — verified by opening both clients side-by-side and editing a discount tier
- [ ] Outreach calling-list works on iPhone Safari and Android Chrome (tested on real devices) — `tel:`, WhatsApp share, and "Add to today's calls" all work
- [ ] **No service-role key in the browser bundle** — verify via:
  ```bash
  pnpm --filter web build && grep -r 'SUPABASE_SERVICE_KEY\|eyJ' apps/web/.next/static
  ```
  Should return zero matches.
- [ ] Lighthouse score >85 on Dashboard
- [ ] `audit_log` captures every config-table write with `timestamp` + `before` + `after`
- [ ] Calendar drag-and-drop works on both desktop and touch devices
- [ ] Routes map loads on mobile with usable panel toggle
- [ ] Reset-to-defaults round-trips: clicking "Reset discount rules" in web replaces all rows; Electron picks up the change via its 2 s debounce subscription
- [ ] Realtime invalidation budget: a single config edit produces ≤ 1 query refetch on other clients (no thrash)
- [ ] Materialized views refresh within 30 s of `syncVouchers` completing
- [ ] The leaked service-role key (`supabaseSync.ts:13-14`) is rotated; the old key is invalid against the project
- [ ] Edge access gate (Vercel Password / Cloudflare Access) is configured and documented; opening the URL incognito requires the gate password

---

## Part 13 — Future Auth Migration (out of scope for v1)

If at any point the org needs per-user audit trails or role-based gating, layer Supabase Auth on top **without rewriting the data layer**:

1. Add `app_users` table with `id (uuid → auth.users.id), role TEXT, created_at`.
2. Enable Supabase Auth (email magic link is simplest). Provision the existing operators by creating an admin-only invite flow.
3. Replace permissive `USING (true)` RLS with `USING (auth.uid() IS NOT NULL)` initially (any authenticated user can read).
4. For role gating (e.g. sales can't edit discount rules), tighten to:
   ```sql
   USING (auth.uid() IS NOT NULL)
   WITH CHECK (
     (SELECT role FROM app_users WHERE id = auth.uid()) IN ('owner', 'manager')
   );
   ```
5. Replace the Server Action's `service_role` client with the authenticated user's JWT. RLS now applies on writes too.
6. Populate `audit_log.user_id` from `req.user.id` in the Server Action.
7. Add a Settings → Team subsection to invite users and set roles.

The schema, materialized views, page implementations, and Realtime subscriptions are unchanged. Only RLS policies and the auth provider on the client side change. This migration is incremental and reversible.

---

**End of PRD.**
