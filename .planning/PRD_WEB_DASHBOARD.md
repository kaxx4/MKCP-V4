# PRD: MK Cycles Web Dashboard (Near-Clone of Electron App)

**Status:** Draft v2 (exhaustive)
**Author:** Engineering
**Last Updated:** 2026-05-18
**Source of truth:** Electron dashboard at `mkcycles-dashboard/src/*` + Supabase project `vmkytsytxlofjyeotmgb`
**Goal:** Build a near-identical Next.js web companion to the Electron dashboard, reading/writing the same Supabase backend, with one exception: Tally XML import/push remains in Electron.

---

## Part 1 — Overview

### 1.1 Summary

The MK Cycles Electron dashboard already syncs every user-edited piece of state to Supabase. This PRD describes a **Next.js 15 web app** that reads/writes that same Supabase project, replicating every page in the Electron app with the same UI, the same data flows, and the same business logic.

The web app delivers operational continuity from anywhere (no install), works on mobile (especially for the outreach calling-list flow), supports multi-user with Supabase Auth + RLS, and updates in near-real-time when the Electron app or a teammate edits something.

The Electron app remains the **system of record for Tally** (XML import and push back to Tally happen there). Everything else — config, orders, discounts, pricing, outreach — is editable from both clients with last-write-wins on `updated_at`.

### 1.2 Goals & Non-Goals

**Goals**
1. Visual + behavioral near-clone of the Electron app — same Tailwind tokens, same component classes, same KPI cards, same modal patterns.
2. Multi-device + multi-user from a browser, no install.
3. Real-time co-edit (Electron ↔ web) via Supabase Realtime.
4. Mobile-first for the calling-list / outreach flow.
5. Reuse pure code (`engine/discounts.ts`, `engine/financial.ts`, `engine/inventory.ts`, `utils/format.ts`, `utils/auditPriceList.ts`, `data/stationData.ts`).
6. Reuse design tokens by copying `src/index.css` verbatim.

**Non-Goals**
1. Replace Electron. Tally XML import stays in Electron.
2. Push to Tally from the web (out of scope for v1; revisit when Tally exposes an HTTP API).
3. Real-time inventory recompute over millions of voucher rows in the browser → server-side materialized views.
4. Offline-first. Electron keeps offline via IndexedDB; web requires connectivity.

### 1.3 Users & Use Cases

| Persona | Primary device | Top tasks |
|---|---|---|
| **Owner / Director** | Desktop + phone | Dashboard KPIs, Reports, approve discount rule edits, Settings → Team |
| **Sales Manager** | Desktop | Orders, Discounts, vendor groups, pending deliveries |
| **Field Sales** | Phone | Outreach calling list, party-wise pending orders |
| **Accountant** | Desktop | Ledgers (read-only), Invoices (read-only), reconcile against Tally |

### 1.4 Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | **Next.js 15 (App Router)** | SSR for first paint, server actions for writes, file-based routing |
| Language | TypeScript (strict) | Same as Electron |
| UI | **Tailwind CSS + shadcn/ui** | Same tokens — copy `src/index.css` |
| Data | **`@supabase/supabase-js` v2** | Already in `server/services/supabaseSync.ts` |
| Auth | **Supabase Auth** (email magic link + Google) | First-party, RLS-aware |
| Real-time | **Supabase Realtime** (postgres_changes) | Already polyfilled in supabaseSync |
| State | **Zustand + TanStack Query** | UI state in Zustand; server cache in TanStack |
| Tables | **TanStack Table + React Virtual** | Same `useVirtualizer` already used in Orders/Alerts/Invoices |
| Charts | **Recharts** | Same lib as Electron |
| Maps | **Leaflet (react-leaflet)** dynamic-imported `ssr:false` | Same lib as Electron |
| Excel | **xlsx (SheetJS)** | Order export, Unit config Excel |
| Hosting | **Vercel** | Edge-deployed, preview per PR |

---

## Part 2 — Architecture

### 2.1 Data Model — Supabase

The web app uses the **same tables the Electron app already syncs to** plus a few new ones for multi-user (auth, audit, prefs).

**Existing — read-only for web (Tally-sourced):**

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

**Existing — read/write from web (config tables already in migrations 001 + 003):**

| Table | Used by |
|---|---|
| `discount_rules` | Discount Rules page (categories + tiers in `conditions.tiers` jsonb) |
| `order_groups` | Orders sidebar |
| `unit_overrides` | Edit Units page |
| `rate_overrides` | Edit Units, Price List |
| `item_category_overrides` | Discount Rules → Item Assignments |
| `category_colors` | Discount Rules color picker |
| `vendor_group_assignments` | Orders, Vendor Groups |
| `item_notes` | Item detail drawer |
| `calling_list_entries` | Outreach |
| `tally_price_list_imports` | Price List (Tally JSON upload) |

**NEW — required for web-app-specific functionality:**

| Table | Purpose |
|---|---|
| `app_users` | `auth.users.id` → `role` (`owner`/`manager`/`sales`/`accountant`) + `company` scope |
| `user_preferences` | Per-user UI prefs (sidebar collapsed, default page, theme) |
| `audit_log` | Every config-table write: `id`, `user_id`, `table`, `row_id`, `action`, `before` (jsonb), `after` (jsonb), `at` |
| `voucher_overrides` | Calendar page status/scheduled-date/notes: `voucher_id`, `status`, `scheduled_date`, `notes`, `updated_at` |
| `voucher_follow_ups` | Calendar follow-up log: `id`, `voucher_id`, `action`, `notes`, `created_at` |
| `pincode_distances` | Distance page cache: `from_pin`, `to_pin`, `distance_km`, `fetched_at` |
| `ledger_pincode_overrides` | Distance page manual PINs: `ledger_id`, `pincode_override` |
| `sync_logs` | Replacement for ServerLogs page: `id`, `sync_id`, `timestamp`, `level`, `message` |

**Recommended materialized views (refreshed nightly or on sync):**

| View | Purpose |
|---|---|
| `mv_monthly_revenue_purchase(month, sales_total, purchase_total)` | Dashboard, Reports |
| `mv_monthly_cash_flow(month, receipts, payments, running_balance)` | Reports Expense tab |
| `mv_item_sales_velocity(item_id, qty, revenue, period_start, period_end)` | Reports Sales tab |
| `mv_expense_by_ledger(period_start, period_end, ledger_id, ledger_name, group, amount, pct_of_total)` | Reports Expense tab |
| `mv_current_stock(item_id, current_stock, stock_value, status)` | Dashboard, Alerts, Reports Inventory tab |
| `mv_outstanding_invoices(voucher_id, party_name, outstanding, aging_bucket)` | Dashboard, Invoices, Reports |
| `mv_item_margins(item_id, avg_sales_rate, avg_purchase_rate)` | Price List, Invoices price verification |
| `mv_low_stock_items(item_id, suggested_reorder, avg_monthly_outward)` | Dashboard, Alerts |
| `mv_party_outreach_stats(party_ledger_id, total_revenue, order_count, last_order_date, predicted_next_order, churn_risk, tier)` | Outreach |

### 2.2 Auth & Security

**Flow:**
1. User visits `app.mkcycles.in` (or chosen domain).
2. Magic link or Google OAuth.
3. First login: must have a row in `app_users` (provisioned by owner via Settings → Team).
4. JWT carries `company` claim → RLS scopes every query.

**Roles & permissions:**

| Role | Reads | Writes |
|---|---|---|
| **owner** | All tables | All config tables + Settings → Team |
| **manager** | All tables | Discounts, order_groups, vendor groups, notes, unit/rate overrides, calling list |
| **sales** | Items, ledgers, vouchers, orders, calling list, notes | `calling_list_entries`, `item_notes`, `voucher_overrides` only |
| **accountant** | All Tally tables, invoices, ledgers | None (read-only) |

**RLS rewrite (required):** Current migrations lock writes to `service_role` only (the Electron server proxy bypasses RLS). For the web app, add authenticated-user policies that join through `app_users`:

```sql
DROP POLICY "Service role can manage discount rules" ON discount_rules;

CREATE POLICY "Read own company discount rules" ON discount_rules
  FOR SELECT USING (
    company = (SELECT company FROM app_users WHERE id = auth.uid())
  );

CREATE POLICY "Managers+ write own company discount rules" ON discount_rules
  FOR ALL USING (
    company = (SELECT company FROM app_users WHERE id = auth.uid())
    AND (SELECT role FROM app_users WHERE id = auth.uid()) IN ('owner', 'manager')
  ) WITH CHECK (
    company = (SELECT company FROM app_users WHERE id = auth.uid())
  );
```

Repeat per table with appropriate role gates. **Keep the service-role policies** so the Electron proxy still works in parallel.

**Secrets:**
- Browser ships the **anon key** only (safe to bundle, gated by RLS).
- Service-role key stays in Next.js server actions / API routes (`process.env.SUPABASE_SERVICE_KEY`).
- **Rotate the leaked service key** that's currently in `server/src/services/supabaseSync.ts:13-14` before public deploy.

---

## Part 3 — Cross-Cutting Concerns (Shared UI Surface)

These pieces are used by every page and must be implemented once before any page work begins.

### 3.1 Layout & Navigation

Implemented in `src/components/Layout.tsx` + `NavBar.tsx`. To clone:

**Layout shell:**
- Root `<div className="min-h-screen bg-neutral-100 text-neutral-950 font-sans">`
- Skip-to-content link at the top (`a href="#main-content" className="skip-to-content"`)
- `<NavBar />` (sidebar on desktop, bottom bar on mobile)
- `<main id="main-content">` with conditional left margin:
  - Mobile: `ml-0 pb-16` (bottom-nav clearance)
  - Desktop sidebar open: `ml-[220px]`
  - Desktop sidebar collapsed: `ml-14`
- Inner padding: `mx-auto max-w-screen-2xl p-3 pt-4` (mobile) or `p-4 lg:p-5` (desktop)

**Mobile/desktop detection:** `window.matchMedia("(max-width: 767px)")` listener in Layout sets `useUIStore.isMobile` and auto-collapses sidebar on mobile.

**NavBar — Desktop sidebar (220px / 56px collapsed):**
- Logo + "MK Cycles" wordmark (hidden when collapsed)
- Nav items list (15 items):
  - `/import` (Upload icon) — **REMOVE from web; replaced by sync indicator**
  - `/dashboard` (LayoutDashboard)
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
  - `/settings` (Settings)
  - `/server-logs` (Terminal) — **REPURPOSE to "Sync Logs" reading `sync_logs` table**
  - `/perf-log` (Activity) — **OPTIONAL admin-only**
- Each link: `flex items-center gap-3 px-2.5 py-2 rounded-lg min-h-10 active:scale-[0.96] transition-[background-color,color,transform]`. Active: `bg-accent/8 text-accent font-medium`.
- "Sync Today" button (RefreshCw icon) — **in web: replace with "View sync status" linking to Settings**
- Tally connection status NavLink at bottom (Wifi/WifiOff icon) — **in web: show last sync time from `tally_sync_history`**
- Collapse toggle (ChevronLeft)

**NavBar — Mobile bottom tab bar:**
- First 5 nav items (Import, Dashboard, Orders, Alerts, Invoices) as bottom tabs
- 6th button "More" with `MoreHorizontal` icon → opens bottom-sheet with remaining items
- Bottom sheet (role=dialog, aria-modal): rounded-t-2xl, slide-up animation, drag handle, close X, list of overflow nav items, Tally connection status block at bottom

### 3.2 Toast / Notification System

Implemented in `src/components/Toast.tsx`. Provider wraps the app shell.

- `ToastProvider` exposes `useToast()` returning `toast(message, type)`.
- 4 types: `success` / `error` / `warn` / `info`. Each has its own border + bg tint + icon (CheckCircle / XCircle / AlertTriangle / Info) + iconColor.
- Auto-dismiss after 4 seconds.
- Stack position: `fixed bottom-4 right-4 z-50`, `flex flex-col gap-2 max-w-sm`.
- Each toast: white bg, colored border, icon + message + X dismiss button (40×40 hit area).
- Animation: `animate-slide-in` on enter.
- `role="region" aria-label="Notifications"` on container; `role="alert"` per toast.

### 3.3 Shared Components Catalog

Build these once; every page uses them:

| Component | File | Reuse strategy |
|---|---|---|
| `KPICard` | `components/KPICard.tsx` | **Copy 1:1** — pure, no Electron deps. Props: title, value, sub, icon, trend, accent, danger. |
| `ColorPicker` | `components/ColorPicker.tsx` | **Copy 1:1.** 12 preset hex colors + manual hex input. |
| `RatePill`, `AmountPill`, `priceMatches`, `PRICE_TOLERANCE=0.01` | `components/PriceVerification.tsx` | **Copy 1:1.** Three-part pill (billed value + icon + ref value). Hover-toggle tooltip explaining match/mismatch with %. `isTotal` boolean enlarges for totals row. |
| `UnitToggle` | `components/UnitToggle.tsx` | Copy 1:1. Pill toggle BASE ↔ PKG. |
| `GroupTabs` | `components/GroupTabs.tsx` | Copy 1:1. Horizontal scroll pills for order groups with left/right scroll buttons. Already fixed for the new-array re-render bug in commit b2c753e. |
| `VendorGroupsSummary` | `components/VendorGroupsSummary.tsx` | Copy 1:1. Vendor-aggregated stats card. |
| `ExpandedGroupsView` | `components/ExpandedGroupsView.tsx` | Copy 1:1. Full-detail order groups grid. |
| `KPISkeleton`, `ErrorCard` | `components/KPISkeleton.tsx`, `ErrorCard.tsx` | Copy 1:1. Loading/error fallbacks. |
| `ErrorBoundary` | `components/ErrorBoundary.tsx` | Copy 1:1 (uses `window.location.reload()` after fix in commit b2c753e). |
| `PriceVerification.tsx` helpers | as above | Used by Invoices + PendingOrders modals |

### 3.4 Design Tokens

**Strategy:** copy `src/index.css` verbatim into the Next.js app (`app/globals.css`). It defines all utility classes the pages use:

- `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`, `.btn-accent-ghost`, `.btn-icon`, `.btn-sm`
- `.card`, `.card-elevated`, `.card-interactive`, `.bento-card`, `.bento-grid`, `.section-card`
- `.page-title`, `.page-subtitle`, `.section-header`, `.metric-value`, `.metric-label`, `.kpi-value`, `.kpi-label`
- `.form-input`, `.form-select`, `.search-input`, `.form-textarea`
- `.badge`, `.badge-success`, `.badge-danger`, `.badge-warn`, `.badge-muted`, `.status-badge`
- `.alert`, `.alert-info`, `.alert-success`, `.alert-warn`, `.alert-danger`
- `.table-header`, `.table-header-sticky`, `.table-cell`, `.responsive-table-row`
- `.modal-overlay`, `.modal-content`, `.modal-header`, `.modal-body`, `.modal-footer`
- `.tab-list`, `.tab-item`, `.tab-item-active`, `.tab-pill`, `.filter-chip`
- `.num-positive`, `.num-negative`, `.num-highlight`, `.num-muted` (with tabular-nums)
- Animation keyframes: `slideIn`, `slideUp`, `fadeUp`, `fadeIn`, `modalPop`, `shake`, `shimmer`
- `skip-to-content`, `tabular-nums`

**Color palette:** accent (blue), success (green), danger (red), warn (amber), info (cyan), neutral. Brand colors documented in `.planning/BRAND_COLORS.md`.

### 3.5 Data Hook Pattern

Replace Zustand's `useDataStore.data` (which is hydrated from IndexedDB) with a TanStack Query hook:

```tsx
// app/lib/queries.ts
export function useDataset() {
  return useQuery({
    queryKey: ['dataset'],
    queryFn: async () => {
      const [items, ledgers, vouchers, company, ...] = await Promise.all([
        supabase.from('tally_stock_items').select('*'),
        supabase.from('tally_ledgers').select('*'),
        supabase.from('tally_vouchers').select('*'),
        supabase.from('tally_companies').select('*').limit(1).single(),
        // ... voucher_lines via paginated stream
      ]);
      return shapeAsCanonicalDataset(items, ledgers, vouchers, ...);
    },
    staleTime: 5 * 60 * 1000, // 5 min — Tally sync runs less frequently
  });
}
```

For pages that need only a slice (e.g. just vouchers for a date range), prefer **scoped queries** over loading the whole dataset, especially since Reports + Outreach + Calendar can all be served from materialized views.

### 3.6 Real-time Subscriptions

Per page, set up Supabase Realtime channels on the tables that page edits, so a teammate's change appears within ~500ms:

```tsx
useEffect(() => {
  const channel = supabase
    .channel('order_groups_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_groups' }, payload => {
      queryClient.invalidateQueries(['order_groups']);
    })
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}, []);
```

Pages requiring realtime: Orders (`order_groups`, `vendor_group_assignments`), Outreach (`calling_list_entries`), Calendar (`voucher_overrides`, `voucher_follow_ups`), Discounts/DiscountRules (`discount_rules`, `category_colors`, `item_category_overrides`), Settings (`app_users` for Team).

---

## Part 4 — Page Specifications (Exhaustive, Per-Page)

> Every page in the Electron app, replicated with the same layout, components, interactions, edge cases. Cite the original file path so reviewers can A/B against the source. Pages marked **READ-ONLY** in v1 don't need write logic. Pages marked **NOT APPLICABLE** are skipped or replaced.

---

### Page: Dashboard
**Route:** `/dashboard` (and `/` redirects here when data is loaded)
**Source:** `src/pages/Dashboard.tsx`
**Purpose:** Landing page providing financial + operational overview — latest-day and current-month sales, AR/AP, cash position, stock value, sales-trend chart, top items, low-stock alerts. Acts as a navigation hub.

#### Layout (top → bottom)
1. **Empty state** (Dashboard.tsx:182-196): 64x64 muted icon, h2 "No Data Loaded", description "Import your Tally data to see your dashboard", "Go to Import" button → `/import`. **Web:** replace CTA with "Wait for Tally sync — last attempted N hours ago" reading `tally_sync_history`.
2. **Page Header** (201-242):
   - Left: `h1` page-title = `data.company.name` or "Dashboard". Subtitle: `${items.size} items · ${vouchers.length} vouchers · ${periodLabel} · Imported ${fmtDate(importedAt)}`.
   - Right: pill segmented control with 5 options: **All / Month / Quarter / FY / Custom**. Active = white pill with shadow-sm on neutral-100 background. When "Custom" selected, two `<input type="date">` (from/to) with "to" separator appear.
3. **KPI Grid** (245-267) — `.bento-grid` of 4 `KPICard`s:
   - "Sales (latestDate)" — accent, `TrendingUp` icon
   - "Month Sales" — `ShoppingCart` icon
   - "Cash + Bank" — `DollarSign` icon
   - "Stock Value" — `Package` icon
4. **AR / AP Cards** (270-295) — 2-col grid, each `card-interactive` → `/invoices`:
   - Left: green icon tile + "Receivable" label + green AR value
   - Right: red icon tile + "Payable" label + red AP value
5. **Charts Row** (298-359):
   - **Sales Trend** card with `<select>` (3/6/12/24 months, default 6). Recharts `BarChart`, X = month label, Y = amount in lakhs (`/100000+L`), tooltip shows `fmtINR`, bars blue `#2563eb`, radius `[4,4,0,0]`, barSize 28.
   - **Top Items (by Qty)** card with `<select>` (This month / Last 3 months / Last 12 months). Horizontal `BarChart`, green bars `#16a34a`, Y category truncated to 110px. Empty: "No sales this period".
6. **Low Stock Alert Card** (362-403, only if items exist) — `border-l-4 border-l-warn`, header `bg-warn/[0.04]` with AlertCircle + "Low Stock Items" + "View All →" → `/alerts`. Up to 5 items: name (truncate 32) + Stock badge (sm+) + Avg/mo (md+) + Reorder amber badge.

#### Components used
- `KPICard`, lucide `TrendingUp, DollarSign, Package, AlertCircle, ShoppingCart, Upload, ArrowRight, Calendar`, recharts `BarChart/Bar/XAxis/YAxis/CartesianGrid/Tooltip/ResponsiveContainer`, `useNavigate`.

#### Data sources
- `useDataStore`: `data`, `voucherIndex`.
- Engine: `computeOutstandingInvoices`, `computeBankBalance`, `monthlyTotals` from `engine/financial`; `getCurrentStockIndexed`, `avgMonthlyOutwardIndexed`, `suggestedReorderIndexed` from `engine/inventory`.
- Derived (lines 44-180): `latestDate`, `latestMonth`, `periodRange` (algorithm: "month"→{from:`{latestMonth}-01`,to:`latestDate`}; "quarter"→latestDate minus 2 months day 1; "ytd"→Apr 1 current FY (Apr-Mar fiscal); "custom"→user dates), `filteredVouchers`, `kpis`, `salesTrend`, `topItems` (top 5 with name truncated to 20 chars), `lowStockItems` (top 5 where reorder>0 AND avg>0.5).

#### Supabase tables (web port)
**READ ONLY:**
- `tally_companies`: `name`, `imported_at`
- `tally_stock_items`: `item_id`, `name`, `opening_rate`
- `tally_ledgers`: `ledger_id`, `name`, `group`, `opening_balance`
- `tally_vouchers`, `tally_voucher_*_entries`
- Recommended views: `mv_monthly_revenue_purchase`, `mv_current_stock`, `mv_low_stock_items`, `mv_outstanding_invoices`

#### Interactions
- Period pills (All/Month/Quarter/FY/Custom) → update `periodFilter` state.
- Custom date pickers → updates `customFrom`/`customTo`; range applied only if both filled.
- Sales chart `<select>` → 3/6/12/24 months.
- Top Items `<select>` → month/quarter/year.
- AR / AP card click → `/invoices`.
- "View All" in low-stock → `/alerts`.
- Low-stock row click → `/alerts`.

#### Filters / Sorting / Search
Single period filter applies globally. No search. Sort: top items by qty desc; low stock by suggested reorder desc.

#### Mobile vs desktop
KPI grid `bento-grid` (1/2/4 cols). AR/AP always 2 cols. Charts 1-col mobile, 2-col `lg`. Low-stock row: "Stock:" badge hidden `<sm`; "Avg/mo" hidden `<md`. Period chips wrap.

#### Edge cases
- No data → empty state.
- `kpis === null` → defaults to ₹0.
- Top items empty → "No sales this period".
- Low stock empty → card not rendered.
- Custom range without both dates → no filter applied.
- Voucher amount missing → falls back to sum of inventory line amounts.
- `latestDate` empty → today's date fallback.

---

### Page: Orders
**Route:** `/orders`
**Source:** `src/pages/Orders.tsx`
**Purpose:** Three-pane order entry workspace. Left: virtualized item list with filters. Center: item analytics (stock buckets, monthly movement, transaction drill-down). Right: virtualized order entry, one input per item. Supports order groups (named, savable, exportable) and movement audit modal.

#### Layout (top → bottom)

**Order Groups Bar** (505-526, sticky): `bento-card !rounded-b-none`. Toggle "Order Groups (N)" (FolderOpen icon). When closed and groups exist: shows `<GroupTabs>`. Right: "N items in order".

**Order Groups Expanded Panel** (529-722, conditional):
- Tabs: **"Manage Groups"** / **"Assign Items"** (px-4 py-2.5, border-b-2 active accent)
- **Manage Groups** (559-644):
  - Create row: "Group Name" + "Description (optional)" + "Create & Save Current Order" button. Placeholders: "e.g. Weekly Order, Premium Items, Urgent Restock…", "Notes about this order group…". Enter key triggers create.
  - Export / Import row.
  - `<VendorGroupsSummary />` block.
  - "All Order Groups" + `<ExpandedGroupsView>`.
- **Assign Items** (647-718):
  - Search input
  - 2-col grid with sticky header "Item" / "Assigned Group"
  - Per-row: item name + `<select>` (Unassigned / each group)

**Mobile Tab Switcher** (725-740, isMobile only): three pills "Items" / "Detail" / "Order (N)".

**Three-Panel Main Area** (743-1274):

**LEFT — Item List** (744-902, ~26% width desktop):
- Header: search input (Ctrl+F placeholder).
- Filter row: "Stock" toggle → `<select>` (≤/≥/=) + numeric input. "Multi-Select (N)" toggle (right).
- Batch assign row (when multi-select + selections): group dropdown ("Select group to assign N items…") + Assign / Clear buttons.
- Virtualized list (`useVirtualizer`, estimateSize 30, overscan 15). Row: optional checkbox + name + colored stock value + accent dot if in order.

**CENTER — Item Detail & Graph** (905-1169):
- No focused item: centered "Select an item from the list".
- Focused: `h2` item name + group/unit subline.
- **Mini KPIs** (917-944): 4 bento cards (2/4 cols mobile/md). "Opening", "In", "Out", "Closing". "In" and "Out" are clickable → opens movement modal for current month.
- **Monthly Data Table** (947-996): sticky header Month/Opening/In/Out/Closing. "In"/"Out" clickable. Zero = neutral-300, non-zero = success/danger. Dynamic padding when `monthSpan > 12`.
- **Chart Toggle + Data Span** (999-1050): "BarChart3 + N-Month History". Span select 3/6/8/12/24. ComposedChart: green In bars, red Out bars, blue Stock line. Height scales `max(180, 180+(monthSpan-8)*15)`.
- **Movement Transaction Modal** (1053-1161). See modals section.

**RIGHT — Order Entry** (1172-1273, ~28% width desktop):
- Header: "Order" label + accent count pill + `<UnitToggle>` + Download (export Excel) + Trash (clear) icons.
- Sticky col header "Item" / "Qty".
- Virtualized rows (estimateSize 40): name + `<input inputMode="decimal">`. Accent bg/border when has value. Arrow keys + Enter navigate.
- Footer: "N items ordered" + Export button.

#### Components used
- `UnitToggle, GroupTabs, VendorGroupsSummary, ExpandedGroupsView`
- lucide: `Plus, Minus, Trash2, Download, X, Upload, Package, Filter, FolderPlus, FolderOpen, Save, Copy, ChevronDown, ChevronUp, BarChart3`
- `fuse.js` (search keys name+group, threshold 0.4), `@tanstack/react-virtual`, recharts `ComposedChart/Bar/Line`, `xlsx` (dynamic import for export).

#### Data sources
- `useDataStore`: `data, voucherIndex`
- `useUIStore`: `unitMode, coverMonths, setCoverMonths, isMobile`
- `useOrderStore`: `lines, setLine, removeLine, clearAll, getAllLines`
- `useOrderGroupStore`: `groups, activeGroupId, createGroup, updateGroup, deleteGroup, duplicateGroup, setActiveGroup, setGroupLines, addLinesToGroup, getAllGroups, assignItemToGroup, removeItemFromGroup, getGroupItems, getItemGroups`
- Engine: `getCurrentStockIndexed, computeMonthlyBucketsIndexed, suggestedReorderIndexed, avgMonthlyOutwardIndexed, getItemMovements, getItemOrderDocs`

#### Supabase tables (web port)
- **READ:** `tally_stock_items`, `tally_vouchers`, `tally_voucher_inventory_entries`, `vendor_group_assignments`
- **READ + WRITE:**
  - `order_groups` (id, company, name, description, color, tags[], item_ids[], lines jsonb, created_at, updated_at)
  - `vendor_group_assignments` (item_id, vendor_group_id)
- **Draft order state:** persist current order as a "draft" `order_groups` row OR a separate `order_drafts` table per user (recommended) — currently Electron uses Zustand `orderStore` which is localStorage-only and not synced.

#### Interactions
- **Ctrl+F** / **`/`**: focus search (line 99-106)
- **Escape**: clear search + blur
- **Click item row**: normal mode → select item, pre-fill orderQty with existing or suggested reorder; multi-select mode → toggle checkbox
- **Arrow Up/Down on search**: navigate selection
- **Enter on search** with item selected: focus qty input
- **Order input keyboard** (290-327): Enter / ArrowDown → next row; ArrowUp → previous; selects text on focus
- **Order input change**: parses float; ≤0 calls `removeLine`, else `setLine` with computed qtyBase
- **UnitToggle**: switches base ↔ package display
- **Download icon**: dynamic-import xlsx, builds sheet [Item, Qty, Unit], downloads `order_YYYY-MM-DD.xlsx`
- **Trash icon**: `clearAll`
- **Group panel toggle**: opens/closes
- **Create group**: writes new group, saves current order as its lines, sets active
- **Export/Import groups**: JSON file roundtrip (version, exportedAt, groups[])
- **Stock filter toggle**: enables filter chain
- **Multi-select toggle**: shows checkboxes; allows batch group assignment
- **Mobile tab buttons**: list/detail/order navigation
- **KPI "In"/"Out" tile click**: opens movement modal for that month
- **Table In/Out cell click**: opens movement modal for that row's month

#### Filters / Sorting / Search
- **Search**: fuse.js fuzzy over `item.name + item.group`, 150ms debounce
- **Group filter**: "ALL" + sorted distinct groups, exact match
- **Stock filter**: ≤/≥/= threshold against current stock
- **Active group**: items belonging to active order group (via `getGroupItems`)
- No sort UI; filteredItems preserves source order

#### Modals

**Movement Transaction Modal** (1111-1160):
- Backdrop `fixed inset-0 bg-black/40 z-50`, click to close
- Panel 760px wide, max-h 82vh (full-screen mobile)
- Header: `{itemName} — {Inward|Outward} Details`, "Month: MMM YY"
- Outward only: tabs "Dispatched / Billed (N)" vs "Orders & Quotes (N)"
- Body: table cols Date / Voucher / Type / Party / Qty / Rate / Amount + totals footer
- Type colored: Sales Order = blue-600, Quotation = amber-600
- Empty: "No {direction} transactions found" or "No sales orders or quotations found"
- Close X

#### Mobile vs desktop
- Mobile: three-tab navigation (Items/Detail/Order). One panel visible at a time. Modal full-screen.
- Desktop: 3-pane fixed-width (26%/flex/28%). All visible.
- Mobile tap on item auto-switches to "detail" tab.

#### Edge cases
- No data → centered Package icon + "No Data Loaded".
- Item already in order → input pre-fills with current qty.
- Suggested reorder = 0 → empty string in qty input.
- Input ≤0 → removes line.
- Multi-select with 0 selections → assign button disabled.
- Importing groups with invalid JSON → `alert("Invalid JSON file")`.

---

### Page: Invoices
**Route:** `/invoices`
**Source:** `src/pages/Invoices.tsx`
**Purpose:** Unified transaction list — invoices (Sales/Purchase) and payments/receipts in one table. Shows outstanding totals at top, searchable/filterable list, rich voucher detail modal with price verification (Sales only).

#### Layout (top → bottom)
1. **Empty state** (179-189): FileText, "No Data Loaded", Import button.
2. **Page Header**: h1 "Invoices" (195).
3. **Summary Grid** (199-216): 2-col mobile / 4-col md. Four `bento-card`s: "Outstanding AR" (success), "Outstanding AP" (danger), "Receipts" (primary), "Payments" (warn).
4. **Filter Bar** (219-241): search input ("Search party / voucher#") + 5 `filter-chip` buttons (All / Sales / Purchase / Receipt / Payment) + From/To date inputs (hidden mobile) + "N rows" counter.
5. **Table / Cards** (244-248): desktop `<TxTable>`; mobile `<MobileCards>`.
6. **Voucher Modal** (252-260) — see modals.

#### Components used
- `RatePill, AmountPill, priceMatches` from `PriceVerification.tsx`
- lucide: `Upload, FileText, X, CheckCircle2, XCircle`
- `useVirtualizer` (desktop)
- Engine: `computeOutstandingInvoices, computeItemMargins, InvoiceRecord`

#### Data sources
- `useDataStore`: `data`
- `useUIStore`: `isMobile`
- `useTallyPriceListStore`: `entries`
- Derived:
  - `invoices = computeOutstandingInvoices(vouchers, ledgers, 30)`
  - `rows = buildTxRows(invoices, vouchers, ledgers)` — combines invoice + Payment/Receipt rows (30-84)
  - `filtered` = type filter + dateFrom/dateTo + search, sorted by date desc
  - `totals` = AR/AP/receipts/payments (149-158)
  - `priceList` (86-107): uses Tally price entries (keyed uppercase) else item margins' avgSalesRate else closingRate else openingRate

#### Supabase tables (web port)
- **READ:** `tally_vouchers`, `tally_voucher_*_entries`, `tally_ledgers`, `tally_stock_items`, `tally_price_list_imports`
- **Recommended:** `mv_outstanding_invoices`, `mv_item_margins`

#### Interactions
- Search: live filter (no debounce)
- Type chips: exclusive filter
- Date pickers: range filter
- Row click → opens `VoucherModal`
- **Escape**: close modal
- Backdrop click / X / Close: close modal
- Hover on rate/amount pills → price comparison tooltip

#### Filters / Sorting / Search
- Search: case-insensitive contains on `partyName` + `voucherNumber`
- Type: All / Sales / Purchase / Receipt / Payment
- Date range: inclusive
- Sort: date desc (always)

#### Modals

**TxTable (desktop)** (535-596): 6-col grid `100px 130px 90px 1fr 120px 100px`: Date / Voucher# / Type / Party / Amount / Outstanding. Virtualized (estimateSize 48, overscan 10), max-h 60vh. Outstanding: red `fmtINR` if >₹0.01, green "Paid" if ≤₹0.01, "—" muted if null. Min width 720px. Empty: "No records found".

**MobileCards** (599-637): First 100 rows + "Showing first 100 of N rows" footer.

**VoucherModal** (276-532):
- Backdrop `bg-black/50 animate-fade-in`, role=dialog aria-modal
- Panel: `bg-white rounded-2xl shadow-2xl max-w-5xl max-h-[90vh] animate-modal-pop`
- **Header**: gradient `from-neutral-50 to-white`. Party + voucher# badge + type badge. Date + narration. Right: for Sales with inv lines, "Prices Verified" pill (blue) if all match else "Price Mismatch" pill (amber). X close.
- **Body**:
  - **Sales price verification table** (357-411): Item / Qty / Rate (`RatePill`) / Amount (`AmountPill`). Footer total row colspan=3 + total AmountPill `isTotal={true}`.
  - **Non-sales items list** (414-453): simpler, no price verification
  - **Ledger Entries** (456-491): each with "Dr" (blue) / "Cr" (orange) badge + ledger name + amount. Bill allocations indented (pl-10): `billType: billRef` + amount
  - **Outstanding Amount panel** (494-505): amber if > 0.01, green "Fully Paid" if ≤ 0.01 (Sales/Purchase only). Hidden for Payment/Receipt.
  - **Empty**: FileText + "No line details available."
- **Footer**: "N items · N ledger entries" + Close button

#### Mobile vs desktop
- Desktop: virtualized table 6 cols, date inputs visible
- Mobile: card stack capped 100, date inputs hidden, summary 2 cols
- Modal: same on both, max-w-5xl

#### Edge cases
- Payment/Receipt with no party → "—"
- No Tally price entries → falls back to computed margins
- Bill allocations empty → skipped
- All prices match → "Prices Verified" badge; any mismatch → "Price Mismatch"

---

### Page: Ledgers
**Route:** `/ledgers`
**Source:** `src/pages/Ledgers.tsx`
**Purpose:** Browse all ledger accounts grouped by category, with full transaction history per ledger including running balance (Dr/Cr) from opening balance forward.

#### Layout
- **Empty state**: BookOpen icon, "No Data Loaded", Import button (61-71).
- **Mobile detail view** (76-134): "← Back to list" + h2 ledger name + group/opening/GSTIN. Scrollable card list: "Opening Balance" first, then per-tx cards (date · type / voucher# / Dr or Cr / running balance).
- **Mobile list view** (138-171): page-header "Ledgers" + filter card (search + group select) + scrollable ledger list (name / group / opening Dr/Cr).
- **Desktop** (175-292): h1 sr-only.
  - **Left panel (w-80)**: search with magnifier, group select, scrollable list (active gets accent border/bg).
  - **Right panel (flex-1)**: empty-state "Select a ledger to view transactions" or header (name, Group / Opening / Credit Days / GSTIN) + table (Date / Voucher# / Type / Debit / Credit / Balance, sticky header). Opening Balance row first with colspan=3.

#### Components used
- lucide `Search, Upload, BookOpen, ArrowLeft`. Pure HTML table (no virtualization — consider for very active accounts).

#### Data sources
- `useDataStore`: `data`
- `useUIStore`: `isMobile`
- Derived:
  - `allLedgers = Array.from(data.ledgers.values())`
  - `groups = ["ALL", ...sorted distinct l.group]`
  - `filtered` = name contains search AND (group ALL || exact match)
  - `ledgerTransactions` (41-59): iterate ALL vouchers, find ones with matching ledger line, sort by date asc, build rows with running balance. Algorithm: `running = openingBalance`; for each line, `debit = isDebit?amount:0`, `credit = !isDebit?amount:0`, `running += debit - credit`. Excludes cancelled but not optional vouchers (potential issue — fix in web port).

#### Supabase tables (web port)
- **READ:** `tally_ledgers`, `tally_vouchers`, `tally_voucher_ledger_entries`
- Recommended view: `mv_ledger_transactions(ledger_id, voucher_id, date, voucher_type, debit, credit)` to avoid full-scan per selection

#### Interactions
- Search live filter
- Group select filter
- Click ledger → sets selectedLedgerId
- Mobile "← Back" → null
- Import button → /import

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
**Source:** `src/pages/PendingOrders.tsx`
**Purpose:** Lists all non-cancelled Delivery Notes (open dispatch instructions) and shows readiness — stock availability + price-match status. Click row → detail modal with per-item stock + price verification.

#### Layout
- **Empty state** (130-140): Truck icon, "No Data Loaded".
- **Page Header**: h1 "Pending Orders" (146).
- **List** (149-152): desktop `<DesktopTable>`, mobile `<MobileList>`.
- **DNModal** on selection (156).

#### Components used
- lucide `Upload, Truck, X, PackageCheck`
- `RatePill, AmountPill, priceMatches, PRICE_TOLERANCE`

#### Data sources
- `useDataStore`: `data, voucherIndex, itemMargins`
- `useUIStore`: `isMobile`
- `useTallyPriceListStore`: `entries`
- Derived:
  - `deliveryNotes` = vouchers where `voucherType === "Delivery Note" && !isCancelled && !isOptional`, sorted date desc
  - `priceList` via `getPriceList(data, tallyEntries, itemMargins)`
  - `stockCache` (96-110): precompute current stock once per item
  - `readinessMap` (113-120): `{ allInStock, allPricesMatch, ready }` per DN

#### Supabase tables (web port)
- **READ:** `tally_vouchers` where `voucher_type='Delivery Note'`, `tally_voucher_*_entries`, `tally_stock_items`, `tally_ledgers`, `tally_price_list_imports`, `mv_item_margins`
- Recommended view: `mv_pending_delivery_notes_with_readiness` pre-computes `ready` boolean

#### Interactions
- Click DN row → opens `DNModal`
- **Escape**: close (123-128)
- Backdrop click / X / Close: close
- Hover row → bg-neutral-50
- Import → /import

#### Filters / Sorting / Search
- **No filters or search** (only DN type implicit filter)
- Sort: date desc

#### Modals

**DNModal** (163-372): see project memory "Delivery Note Modal" for Phase 1+2 redesign history.
- Backdrop `bg-black/50 animate-fade-in`, role=dialog aria-modal
- Panel: `bg-white rounded-2xl shadow-2xl max-w-5xl max-h-[90vh] animate-modal-pop`
- **Header** gradient `from-neutral-50 to-white`: party name + voucher# pill + date + narration. Right: "Ready to Deliver" green pill if `ready`, else "Stock issues" / "Price mismatch" / both joined " · " in neutral pill with amber dot. X close.
- **Body**:
  - **Items for Delivery table** (240-318): 5 cols Item Name / Qty / Rate (`RatePill`) / Amount (`AmountPill`) / Stock Status (dedicated column).
    - Stock label logic (268-272):
      - `null` (no item) → no badge
      - `stock >= qty` → "{stock} in stock" (green)
      - `stock > 0 && < qty` → "only {stock} in stock" (red)
      - `stock === 0` → "out of stock" (red)
      - `stock < 0` → "{stock} (short by {abs(stock)})" (red)
    - Footer total row: colspan=3 + AmountPill `isTotal={true}` + empty stock cell
  - **Ledger Entries** (321-347): same Dr/Cr pattern as Invoices modal
  - **Empty** (349-354): Truck + "No line details available."
- **Footer**: "N items · N ledger entries" + Close

**DesktopTable** (375-448): sticky grid `90px 120px 1fr 60px 140px 110px`: Date / DN# / Party / Pkgs / status col / Value. Each clickable, "Ready to Deliver" green pill if applicable. `totalPkgs = Σ qtyBase`. Max-h `calc(100vh - 240px)`. Empty: Truck + "No delivery notes found".

**MobileList** (451-511): stacked cards; party (or voucher#), small "Ready" pill if applicable, date · N items · N pkgs · narration, value right.

#### Mobile vs desktop
- Desktop: tabular with explicit pkgs column
- Mobile: card list with inline metadata
- Modal: same on both (max-w-5xl)

#### Edge cases
- No DNs → "No delivery notes found"
- DN with no inventory lines → table not rendered, only ledger + footer "0 items · N ledger entries"
- Item not in stock cache (not in `data.items`) → stock = null, no badge
- `partyName` null → "—" desktop or voucher# fallback mobile
- `isOptional` and `isCancelled` excluded

---

### Page: Discounts
**Route:** `/discounts`
**Source:** `src/pages/Discounts.tsx`
**Purpose:** Select a Sales or Delivery Note voucher and inspect auto-calculated group-wise discount breakdown for each line item. Per-item manual override of discount %.

#### Layout
- **Empty state** (789-800): `%` glyph, h2 "No Data Loaded", "Import your Tally data to calculate discounts", `Import Data` button → `/import`.
- **Page header** (804-815): title "Discounts" + subtitle "Group-wise automatic discounts for Sales invoices". Right: `Edit Rules` button (Pencil) → `/discount-rules`.
- **Voucher Selector card** (818-824): tabs + search + table + pagination.
  - **Tabs** (188-203): `Sales` / `Delivery Note` (default). Active: `border-blue-500 text-blue-600 bg-blue-50`.
  - **Search** (205-218): "Search party or voucher #" + "{N} found" pill.
  - **Table** (226-276): cols empty-radio (w-8) / Voucher / Date / Party / Amount (right). Voucher# mono blue, party truncated, amount bold right tabular-nums.
  - **Pagination** (278-319): 20 per page, prev `‹`, up to 7 numbered, next `›`.
  - **Empty**: "No delivery notes found" / "No sales vouchers found".
- **Discount Breakdown card** (827-838, when voucher selected):
  - Voucher header (375-394): party name (bold xl), uppercase voucher-type chip, mono voucher#, formatted date. Right: "Invoice Total" + large bold INR.
  - **Totals strip** (399-412): 3-col gradient green band — Subtotal / Total Discount (with `−`) / Effective Rate (%).
  - Collapsible "Discount by Category (Group-wise)" (416-428).
  - **Group cards grid** (430-525): 1/2 cols. Colored from palette (NEUTRAL for `NO_DISCOUNT`). Each: category name + total packages + large %, Subtotal, Discount line, optional Base Tier badge + Group Rule Applied blue badge, `View Items in Group →`.
  - Collapsible "Items in Invoice" (531-543).
  - **Items table** (545-672): cols Item / Qty (qtyBase + "{pkg} pkgs") / Category (colored badge) / Amount / Disc% (click-to-edit) / Discount. Row bg uses per-category palette. Manual overrides in amber.
  - "No items with discounts" (678-681).
- **Group Details Modal** (683-698).

#### Components used
- lucide `Pencil, Upload, X, RotateCcw, ChevronDown`
- `useDataStore, useDiscountStore, calculateVoucherDiscount`, `fmtINR/fmtNum/fmtDate`
- Inline: `VoucherSelector, DiscountBreakdown, GroupDetailsModal`

#### Data sources
- `data.vouchers` (filter `!isCancelled && !isOptional`)
- `useDiscountStore.{categories, itemCategoryOverrides, categoryColors}` (read-only)
- `discountResult = calculateVoucherDiscount(voucher, items, categories, itemCategoryOverrides)` → `{ lines, groupSummaries, totalLineAmount, totalDiscountAmount, effectivePct }`
- `displayResult` (740-775): overlays `manualOverrides` (local state) on each line. Algorithm: for any item where `manualOverrides[itemName]` defined, replace `discountPct`, recompute `discountAmount = lineAmount * pct / 100`, set `tierLabel = "Manual: {pct}%"`. Group lines once by `categoryId`. Recompute `groupSummary.totalDiscount`, `totalDiscountAmount`, `effectivePct`.
- `useDeferredValue(selectedVoucherId)` defers heavy math.
- `useEffect` on `deferredVoucherId` clears `manualOverrides` when voucher changes.

#### Supabase tables (web port)
- **READ:** `tally_vouchers`, `tally_voucher_inventory_entries`, `tally_stock_items`, `discount_rules`, `category_colors`, `item_category_overrides`
- **WRITE:** None (overrides are session-only)

#### Interactions
- Tab click: switch Sales / Delivery Note, reset page+search
- Search: live filter, reset page
- Row/radio click: select voucher
- Pagination prev/page#/next
- `Edit Rules` → `/discount-rules`
- Collapse toggles (Groups, Items)
- Group card click + `View Items in Group →`: open `GroupDetailsModal`
- **Disc% cell click**: becomes number input (min 0 max 100 step 0.5, auto-selected). Enter or blur commits, validates 0-100. Escape cancels.
- **RotateCcw button**: clears that item's manual override

#### Filters / Sorting / Search
- Tab filter: Sales / Delivery Note. Both exclude cancelled/optional.
- Search: lowercase substring on partyName + voucherNumber
- Sort: date desc (ISO compare)
- Pagination: 20/page

#### Modals

**GroupDetailsModal** (83-140): `modal-overlay`. Backdrop click closes. Header: group name + X. Body: accent "Total Packages in Group" pill + integer; "Items in This Group" list (white cards: item name + `"{qty} units = {pkg} pkg(s)"` pluralized). Footer: full-width Close (`btn-primary`).

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
**Source:** `src/pages/DiscountRules.tsx`
**Purpose:** CRUD for discount categories, qty-based tiers, per-item category assignments. JSON import/export, category color editing, reset-to-defaults. Persists into Zustand `discountStore` + Electron local file.

#### Layout
- Empty state (331-339): `%` glyph, "No Data Loaded", "Import your Tally data first".
- Hidden file input (344-350).
- `AddCategoryModal` mount (353-357).
- Color Picker modal mount (360-386, conditional on `colorCatId`).
- **Header** (389-415): Back (`/discounts`), title "Edit Discount Rules", subtitle. Right: `Import` (Upload) + `Export` (Download).
- **Status message** (418-429): auto-hides 4s.
- **Tab list** (432-442): `Discount Tiers` / `Item Assignments`.
- **Tiers tab** (445-563):
  - List of category cards. Each: chevron + name + "{N} tier(s)" subtitle. Right: `Color` (Palette), `Add Tier` (Plus), `Delete` (Trash2, hidden for NO_DISCOUNT).
  - Expanded body: tiers in grid `[1fr 1fr 1fr auto]` columns Min Qty / Max Qty / Discount % / per-row X.
  - Empty-tier: "No tiers — items in this category get 0% discount".
  - Dashed `+ Add New Category` button (557-561).
- **Item Assignments tab** (565-637):
  - Search + "{filtered}/{total}" counter.
  - Sticky "Item Name" / "Category". Scrollable max-h-96. Items: name + `NEW` blue pill for new items + category select.
  - Empty: "No items found".
- **Fixed footer** (640-664): `Reset to Defaults` (RotateCcw) left. `Cancel` / `Save Changes` (disabled unless `hasChanges`) right.

#### Components used
- lucide `ChevronDown, ChevronRight, X, Plus, Trash2, RotateCcw, ArrowLeft, Download, Upload, Palette`
- `ColorPicker` component
- Inline `AddCategoryModal`

#### Data sources
- `useDataStore.data` (for `data.items` keys → new-items pill)
- `useDiscountStore.{categories, itemCategoryOverrides, categoryColors, setCategories, setItemCategoryOverrides, setCategoryColor, resetToDefaults}`
- Local state: `localCats` (deep clone), `localOverrides`, `activeTab`, `itemSearch`, `expandedCatId`, `hasChanges`, `fileMsg`, `addCatOpen`, `colorCatId`, `fileInputRef`
- `mergedMap = { ...DEFAULT_ITEM_CATEGORY_MAP, ...localOverrides }`
- `allItems`: defaults map keys then extra item ids from `data.items` not in defaults
- `filteredItems`: lowercase substring on `itemSearch`
- `buildPayload(cats, overrides)`: `{ version:"2", exportedAt, categories, groupRules:DEFAULT_GROUP_RULES, itemCategoryOverrides, allItemAssignments }`

#### Supabase tables (web port)
- **READ + WRITE:**
  - `discount_rules` (id, company, name, category, discount_type='tiered', conditions jsonb={tiers:[...]}, priority, enabled)
  - `item_category_overrides` (company, item_id, category_id)
  - `category_colors` (company, category_id, color hex)
- **READ:** `tally_stock_items` for `allItems` enumeration

#### Interactions
- **Back** → `/discounts`
- **Import**: Electron native dialog if `window.electronAPI.discountRules` else hidden file input. On success: `applyImportedRules(data)` + mark dirty
- **Export**: Electron save dialog else blob download `discount-rules-{YYYY-MM-DD}.json`
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
- **Reset to Defaults**: confirm, `resetToDefaults()`, navigate to `/discounts`
- **Cancel** → `/discounts` without saving
- **Save Changes**: `setCategories(localCats)`, `setItemCategoryOverrides(localOverrides)`, optional Electron file save, navigate to `/discounts`. Disabled unless `hasChanges`

#### Filters / Sorting / Search
- Item search: substring lowercased on `itemId` (=item name). No sort.

#### Modals

**AddCategoryModal** (57-140): centered `bg-black/40` overlay. Title "New Category". Single input "Category Name", placeholder "e.g. PUMP TOGO ALL TYPES". Live hint: `ID: {name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`. Buttons Cancel / Add Category (disabled until trimmed). Enter confirms, Escape cancels. Confirm appends `{id, name, tiers:[]}`, auto-expand, close.

**Color Picker modal** (360-386): uses external `ColorPicker`. Backdrop or `Done` closes. Each color change calls `setCategoryColor(colorCatId, color)` immediately.

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

---

### Page: PriceList
**Route:** `/price-list`
**Source:** `src/pages/PriceList.tsx`
**Purpose:** Read-only browser of every item's pricing — Tally master rate, inferred/master GST %, price+GST, dealer price lists. Imports JSON Tally rates file to overlay selling/cost.

#### Layout
- Empty state (149-163): Tag icon, "No Data Loaded", `Import Data` → `/import`
- **Page header** (168-209):
  - Left: title "Dealer Price List", subtitle
  - Right: hidden file input + emerald `Import Tally Rates` (FileUp) + red trash when rates present. Below: "{count} rates loaded · {date}", red error text if any
- **Filters card** (212-256): h2 "Filters & Search". 3-col grid: search box (Search icon, "Search by item name or group…") spans 2/3, `Filter by Group` select 1/3. Below: "{N} item(s) found"
- **Table card** (259-434):
  - Sticky grid header. Two layouts:
    - With Tally data (`tallyItemCount > 0`): `48px 1fr 160px 80px 140px 150px` → expander | Item Name | Group | GST % | Tally Rate | Price + GST
    - Without: `48px 1fr 160px 80px`
    - "Item Name" + "Group" sortable (up/down arrow). "GST %" orange right-aligned. "Tally Rate" emerald. "Price + GST" purple.
  - Body overflow-y-auto, `maxHeight: calc(100vh - 340px)`. Rows: expander chevron (only when `dealerPrices` exist), item name (bold truncated), group pill (slate-100 rounded-full), GST badge (3 styles: default grey, inferred amber with `~`, master orange), Tally rate (emerald + cost subline), Price + GST (purple)
  - Empty (300-305): Tag + "No items match your filters"
  - Expanded panel (406-428): blue-50 strip with h3 "Dealer Price Lists"; each dealer price row: list name, dealer rate (blue tabular-nums), optional red `-{discount}%` pill

#### Components used
- lucide `Upload, Tag, ChevronDown, Search, FileUp, Trash2`
- `useDataStore, useTallyPriceListStore`, `fmtRate`, `parseTallyPriceListJson`, `inferGstRatesFromVouchers`

#### Data sources
- `useDataStore.data` — `data.items`, `data.vouchers`
- `useTallyPriceListStore` — `entries` (uppercase keys), `importedAt`, `itemCount`, `setPriceList`, `clearPriceList`
- `inferGstRatesFromVouchers(vouchers)` → `Map<itemId, number>`
- `rows` (79-105): maps every item to `PriceRow`. GST: master `item.gstRate` → inferred → default 5; flags `gstRateInferred`, `gstRateDefault`
- `groups` (107-110): "ALL" + sorted unique groups
- `filtered` (112-119): substring filter on name OR group + group dropdown filter
- `sorted` (121-128): `name` or `group` (group tie-breaks by name); direction toggle

#### Supabase tables (web port)
- **READ:** `tally_stock_items` (item_id, name, group, gst_rate, base_unit, dealer_prices jsonb), `tally_vouchers` + `tally_voucher_inventory_entries` for GST inference (or `mv_item_gst_inferred`)
- **READ + WRITE:** `tally_price_list_imports` (company, item_name uppercased, selling_rate, cost_price, unit, imported_at)
- Web port: parse JSON client-side, upsert rows; OR upload to Supabase Storage + edge function process

#### Interactions
- **Import Tally Rates**: triggers hidden file input
- **File change** (40-72): detects BOM (UTF-16 LE/BE) else UTF-8, decodes, calls `parseTallyPriceListJson`. Success: `setPriceList(entries, ISO)`. Empty: "No items with selling rates found in the file." Errors in red
- **Trash icon** (visible when `tallyItemCount > 0`): `clearPriceList()`
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
- No filter results → Tag icon "No items match your filters"
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
**Source:** `src/pages/PriceListCorrection.tsx`
**Purpose:** Audits opening balances to surface items priced like cost (baby items <₹500, items <₹50). Recommends corrected rate using median of recent sales. Exports CSV for Tally re-import.

#### Layout
- Empty state (167-175): Upload icon, "No Data Loaded", "Import your Tally data first to audit prices"
- **Page header** (184-198): title "Price List Correction", subtitle "Fix {N} cost prices using recent sales data". Right: `Export` (Download) with count badge `(N)` when selected; disabled if 0
- **Summary cards** (201-217): 3-col grid bento-cards — `Critical` (danger) "Baby items under ₹500"; `High Priority` (warn) "Items under ₹50"; `Medium Priority` (info) "Other anomalies"
- **Selection controls** (220-250): section-card row — `Select All`, `Select Critical (N)`, `Select High (N)`, `Clear`, right counter `{selected}/{total} selected`
- **Items table** (253-350): inside section-card, cols checkbox / Item Name / Current Rate / Recent Sales / Recommended / Priority / Issue. Selected rows `bg-accent/10`. Critical rows have `border-l-4 border-l-danger`
- **Instructions card** (353-377): info-tinted with AlertTriangle, h3 "How to Fix" + 6-step ordered list (Select → Review → Export → Update → Re-export → Re-import)

#### Components used
- lucide `Upload, Download, AlertTriangle, TrendingUp`
- `useDataStore`, `auditPriceList`, `useToast`
- formatters `fmtINR`/`fmtNum`

#### Data sources
- `useDataStore.data` — items Map, vouchers (Sales/Delivery Note non-cancelled)
- `auditPriceList(data)` (33): `{ totalItems, anomalies: PriceAnomaly[], summary }`. Each anomaly: `itemId, itemName, openingRate, openingValue, openingQty, calculatedRate, flags[]`
- Filtering (36-40): anomalies with `BABY_ITEM_COST_PRICE` OR `SUSPICIOUSLY_LOW_RATE` flags
- Recent sales rate (43-68): for each candidate, scan all vouchers; for Sales / containing "delivery" non-cancelled, walk inventory lines, collect `ratePerBase > 0`. Median = `recentSalesRate` = `recommendedRate`
- Priority (70-77): `critical` if name contains "baby" or "tricycle"; else `high` if `openingRate === 0`; else `medium`
- Sort (87-94): priority then `openingValue` desc

#### Supabase tables (web port)
- **READ:** `tally_stock_items` (item_id, name, opening_rate, opening_qty_base, opening_value), `tally_vouchers`, `tally_voucher_inventory_entries` — or `mv_recent_sales_rates`
- **WRITE:** None (CSV download only). If persistence wanted: `price_corrections` (item_id, recommended_rate, applied_at)

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
**Source:** `src/pages/Edit.tsx`
**Purpose:** Inline editor for per-item unit conversion data — base unit, packaging unit, units per pack. Batched local edits committed via `saveAll` to both data store items Map and `overrideStore` audit log.

#### Layout
- Empty state (137-151): Package icon, "No Data Loaded", `Import Data` → `/import`
- **Page header** (156-179):
  - Left: title "Edit Units"
  - Right toolbar: `Auto-fill from Tally` (Wand2, secondary sm) always visible. When `dirtyCount > 0`: `{N} unsaved` (warn tabular-nums), `Reset` (RotateCcw), `Save All` (Save primary sm)
- **Filters row** (182-200): search input ("Search items…" flex-1) + group `<select>` (All Groups + unique groups)
- **Table card** (203-256): scrollable `maxHeight: min(65vh, 640px)`. Sticky header (`table-header-sticky`). Cols `Item` / `Group` / `Base Unit` (w-24) / `Pkg Unit` (w-24) / `Units/Pkg` (w-28). Dirty rows: `bg-accent/5`

#### Components used
- lucide `Save, RotateCcw, Upload, Package, Wand2`
- `Fuse.js` (fuzzy)

#### Data sources
- `useDataStore.data` — `data.items` Map; `setData` replaces Map on save
- `useOverrideStore.setUnitOverride(itemId, override)` — writes persisted store + IDB + audit log
- `allItems` from data
- `groups` = ALL + sorted unique
- `fuse` index on `name + group`, threshold 0.4
- `filteredItems`: apply group filter then Fuse search
- Local `rows`: per-itemId `EditRow` cache; `getRow` returns stored or seeds from item
- `dirtyCount`: dirty rows count

#### Supabase tables (web port)
- **READ:** `tally_stock_items` (item_id, name, group, base_unit, pkg_unit, units_per_pkg)
- **WRITE:**
  - `tally_stock_items` UPSERT (base_unit, pkg_unit, units_per_pkg) — OR
  - `unit_overrides` (item_id, pkg_unit, units_per_pkg, source='manual', confidence=1, updated_at)
  - `audit_log` row (type='unit_override', item_id, new_value jsonb, at, by)

#### Interactions
- Search: Fuse re-filters
- Group select: filter
- **baseUnit input**: uppercase-cast onChange
- **pkgUnit input**: uppercase-cast onChange (placeholder `—`)
- **unitsPerPkg**: number min=1, `parseInt(value) || 1`
- All changes call `updateRow` → mark dirty
- **`Auto-fill from Tally`**: iterates items with `pkgUnit`, seeds row + mark dirty
- **`Reset`**: clears local `rows` (no confirm)
- **`Save All`**: per dirty row, trim and apply. Empty pkgUnit → null + force `unitsPerPkg=1`; else `max(1, unitsPerPkg)`. Update items Map, `setData(...)`, `setUnitOverride` per item (triggers audit), clear `rows`

#### Filters / Sorting / Search
- Search: Fuse fuzzy on name + group
- Group: ALL or exact
- No explicit sort

#### Mobile vs desktop
- Filter row flex without breakpoint
- Table `min-w-[540px]`, horizontal scroll on small mobile

#### Edge cases
- No data → empty state
- pkgUnit cleared → persisted as null, `unitsPerPkg` forced to 1
- Auto-fill skips items without Tally pkgUnit
- Save All with no dirty: no-op
- Reset silent
- `unitsPerPkg` non-numeric: fallback 1
- No persistence between sessions for in-progress edits — local `rows` wiped on nav

---

### Page: Outreach
**Route:** `/outreach`
**Source:** `src/pages/Outreach.tsx`
**Purpose:** Sales-intelligence console surfacing upsell, reactivation, retention opportunities from Tally sales vouchers. Per-party analytics (RFM, churn risk, predicted next order). Computed client-side.

#### Layout
1. **Page header**: h1 "Outreach Intelligence" + strapline "AI-powered sales opportunities, churn detection & predictive analytics" (hidden mobile). Desktop only: search input "Search parties…" max-w-xs in right
2. **KPI grid** — 2/4 cols:
   - "Potential Revenue" (Σ `estimatedValue` opps, sub `{n} opportunities`, accent)
   - "At-Risk Revenue" (Σ totalRevenue parties churnRisk>65 and tier!=longtail, danger)
   - "Avg Confidence" (avg `conversionProbability` as %, success)
   - "Urgent Actions" (opps with `daysToAct===0`, warn)
3. **Mobile search** — duplicate of desktop
4. **Tabs** — bottom-bordered row: `Opportunities`, `Parties`, `Churn Risks`, `Predictions` (icons Target/Users/AlertTriangle/Calendar). Pill counts. Labels hidden `sm:` — icons only
5. **Content** — flex row desktop when party selected (left 58%, right 280px); else full-width
   - **Opportunities tab**: chip filter "All Types/Upsell/Reactivation/Retention" + counts. Vertical scroll `OppCard` list (max-h `min(65vh,600px)`). Empty: CheckCircle + "No opportunities match"
   - **Parties tab**: section-card sticky header (`Party / Revenue (md) / Orders (lg) / Trend / Churn / chevron`) + virtualized list (row 60, overscan 12, h `min(65vh,500px)`)
   - **Churn Risks tab**: section-card header (`Party / Risk bar (md) / Score / Revenue (md)`) + stacked `ChurnRow` sorted by churn desc, filter `churnRisk>40`. Empty: CheckCircle + "No churn risks detected"
   - **Predictions tab**: section-card "Predicted Orders — Next 30 Days" (Clock icon). Stacked `CalendarItem` sorted by predictedNextOrder asc. Empty: "No predictions yet / Need ≥2 orders per party"
6. **Party detail**: desktop right column `section-card p-4` (`PartyPanel`). Mobile: full-screen overlay with backdrop + bottom-sheet (`animate-slide-up`, drag handle, `rounded-t-2xl`)
7. **Empty states**: if `!data`: Phone icon, "No Data Loaded" + import CTA. If no parties: Users icon, "No Sales Data Found"

#### Components used
- lucide: `Upload, Phone, TrendingUp, TrendingDown, Users, Calendar, AlertTriangle, ChevronRight, ArrowUpRight, ArrowDownRight, X, CheckCircle, Zap, Target, BarChart2, Clock`
- recharts: `AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar` (inside PartyPanel)
- `@tanstack/react-virtual`
- `PartyPanel` (426-662), `OppCard` (668-738), `ChurnRow` (744-816), `CalendarItem` (822-897)

#### Data sources & algorithms
- `useDataStore`: `data` (vouchers + ledgers + items)
- `useUIStore.isMobile`

**Per-party stats (`computePartyStats`, 83-276):**
1. Filter `data.vouchers` for Sales non-cancelled non-optional with `partyLedgerId`
2. Group by `partyLedgerId` → Map
3. For each party sorted by date asc:
   - `totalRevenue = Σ totalAmount`; `orderCount`; `avgOrderValue`
   - `lastOrderDate`; `daysSinceLast = floor((now - lastDate)/86_400_000)` clamped ≥0
   - `monthsActive = max(1, (now - firstDate)/(86400e3*30))`; `ordersPerMonth = orderCount/monthsActive`
   - **Trend**: compare revenue last 3 months vs prior 3 months. If `prevRev > 0`: `trendPct = (recent-prev)/prev*100`. `>10`→growing, `<-10`→declining, else stable. `prevRev==0 && recent>0` → growing 100%
   - **RFM**:
     - `rfmR` bucketed: <10→100, <20→80, <30→60, <60→40, <90→20, else 0
     - `rfmF = min(100, ordersPerMonth/2*100)` (2/mo = 100)
     - `rfmM = min(100, avgOrderValue/200000*100)` (₹2L avg = 100)
     - `rfmScore = R*0.4 + F*0.3 + M*0.3`. `churnRisk = round(max(0, 100-rfmScore))`
   - **Tier**: `totalRevenue ≥ 5_00_00_000` (₹5Cr) → `anchor`; `≥ 20_00_000` (₹20L) → `secondary`; else `longtail`
   - **Predicted next order** (only if `sorted.length ≥ 2`):
     - Intervals = pairwise day-diffs
     - `avgInterval = mean`; `stdDev = sqrt(variance)`; `cv = stdDev/avgInterval`
     - `predictedNextOrder = lastDate + round(avgInterval)` days, ISO YYYY-MM-DD
     - `consistency = max(0, 1 - min(cv,1))`
     - `recencyFactor`: <30d→1.0, <60d→0.8, else 0.6
     - `countFactor = min(1, sorted.length/12)`
     - `predictedConfidence = round(consistency * recencyFactor * countFactor * 100)`
     - `predictedValue = avgOrderValue`
   - **monthlyRevenue**: 6 entries (5..0 months back), `{label:'MMM YY', amount}`
   - **topItems**: per-itemId Σ `line.lineAmount` (inventory), sort desc, top 5. Names enriched from `data.items`
4. Final sorted by `totalRevenue` desc

**Opportunity generation (`generateOpportunities`, 278-377):**
- **UPSELL** (282-315): if `predictedNextOrder && predictedConfidence≥50` and `daysToOrder ∈ [-2, 14]`. `daysToAct = max(0, daysToOrder - 3)`. `priorityScore = predictedConfidence * (totalRevenue/1Cr)`. `estimatedValue = predictedValue`. `conversionProbability = predictedConfidence/100`. Action: "Call TODAY — order window open" or "Schedule call for {date}". Offer: "2% early-order discount if confirmed within 48 hours"
- **REACTIVATION** (318-339): if `churnRisk>60 && tier!=longtail` and `daysSinceLast > expectedInterval*1.5` where `expectedInterval = max(7, 30/max(0.5, ordersPerMonth))`. `priorityScore = churnRisk * (totalRevenue/1Cr) * 0.8`. `estimatedValue = avgOrderValue`. `conversionProbability = 0.55`. `daysToAct=0`. Offer: "3-5% loyalty discount"
- **RETENTION** (342-362): if `trend==="declining" && trendPct<-15 && tier!=longtail`. `priorityScore = |trendPct| * (totalRevenue/1Cr) * 0.6`. `estimatedValue = totalRevenue*0.1`. `conversionProbability = 0.65`. `daysToAct = 3`. Offer: "Volume commitment 3-5% discount"
- Dedupe by `${ledgerId}-${type}`, sort by priorityScore desc

**Filtered views (936-978):**
- `filteredOpps`: typeFilter + substring match on party.name or rationale
- `filteredParties`: substring on name
- `churnParties`: churnRisk>40 sorted desc
- `calendarParties`: predictedNextOrder!=null && predictedConfidence≥50 sorted asc

#### Supabase tables (web port)
- **READ:** `tally_vouchers` + `tally_voucher_inventory_entries` + `tally_ledgers` + `tally_stock_items`
- Recommended view: `mv_party_outreach_stats(party_ledger_id, total_revenue, order_count, last_order_date, predicted_next_order, churn_risk, tier, ...)` — pre-compute nightly to save client compute
- **WRITE:** None (read-only intelligence). Future: `outreach_actions` (id, party_ledger_id, opp_type, action_taken_at, user_id)

#### Interactions
- Tab buttons: switch `activeTab`
- Type filter chips (Opp tab): set `typeFilter`
- Search input: substring per tab
- Opportunity card click: toggle `selectedPartyId`. Same party twice → clear
- Party row click (Parties/Churn/Calendar): same handler. Calendar additionally switches activeTab to "parties"
- PartyPanel close X: clear selectedPartyId
- Mobile sheet backdrop click: closes panel
- Import CTA empty state: `/import`
- **No tel/WhatsApp/copy** on this page (opps show recommended action text only) — **web port should add these for field sales**

#### Filters / Sorting / Search
- Filters: type chip (ALL/upsell/reactivation/retention) on Opportunities tab only
- Sort: implicit (opps by priorityScore desc, parties by totalRevenue desc, churn by churnRisk desc, calendar by predictedNextOrder asc)
- Search: party name (all tabs) + opp rationale (Opportunities)

#### Modals / sub-components

**PartyPanel** (426-662): Header (tier badge + trend badge + name + "X orders · ₹Y avg"). KPI grid 2x2 (Annual Revenue, Churn Risk colored, Orders/Month, Last Order colored by recency). 6-Month Revenue area chart (h 80, indigo gradient `#6366f1`). RFM bar chart (h 60, 3 bars + value/label triplets). Predicted Next Order card (conditional, border colored by confidence ≥70 accent vs warn). Top Items list (names truncate >28 chars)

**OppCard** (668-738): icon bubble (color by type), party name, rationale (1-line), action line (accent arrow), right column estimatedValue + conversion% + "URGENT" badge or "Act in Nd"

**ChurnRow** (744-816): name + tier badge + trend% + days-since-last + risk bar (desktop) + numeric score /100 + total revenue (desktop)

**CalendarItem** (822-897): date block (colored by overdue/<=3d/normal) + party name + relative label (`Today`/`Tomorrow`/`In Nd`/`Nd overdue`) + predicted value + confidence%

#### Mobile vs desktop
- `useUIStore.isMobile` controls: search position (header vs full-width), party detail bottom sheet vs right column, hidden columns on Parties/Churn rows (md/lg modifiers)
- KPI grid 2/4. Tabs hide labels on small screens
- Bottom-sheet overlay: `fixed inset-0 z-50` + backdrop + slide-up
- **Web port additions:** tel: links, WhatsApp share buttons, one-tap clipboard copy of suggested order text

#### Edge cases
- `data===null` → empty state
- 0 parties → "No Sales Data Found"
- filteredOpps empty → in-tab empty card
- calendarParties empty → "No predictions yet / Need ≥2 orders"
- Party with `sorted.length<2` → no predicted order, no UPSELL opp generated
- `prevRev===0 && recentRev===0` → trend stable, trendPct 0
- Top item lookup undefined → fallback to itemId as name

---

### Page: Alerts (Low Stock)
**Route:** `/alerts`
**Source:** `src/pages/Alerts.tsx`
**Purpose:** Lists stock items below safe levels (Critical / Low / Reorder) from Tally inventory + voucher consumption. Adds recommended reorder qty directly into central Order draft.

#### Layout
1. **Header**: h1 "Low Stock Alerts" + muted "{N} items". Right: "Add All" (ShoppingCart)
2. **KPI grid** (2/4): "Need Reorder" (warn), "Reorder Value" (accent ₹), "Zero Stock" (danger), "< 1 Month" (warn)
3. **Filter bar** (wraps mobile): Group select ("All Groups" + each unique), Severity select ("All", "Critical", "Low", "Reorder"), search input flex-1 min-w 120px
4. **List/Table**:
   - **Mobile**: `bento-card` per item — name + group + severity badge; 3-col mini-grid Stock/Avg-mo/Reorder; "Add to Order" / "Added" button when `suggested>0`
   - **Desktop**: section-card sticky header `Item / Group (lg) / Stock / Avg/Mo (md) / Mo Left (md) / Reorder / Status / Action`. Virtualized body (row 48, overscan 20, container `min(65vh,600px)`)
5. **Empty state**: AlertTriangle 64px + "No Data Loaded" + import CTA

#### Components used
- lucide `AlertTriangle, Upload, ShoppingCart, Check`
- `@tanstack/react-virtual`
- Engine: `getCurrentStockIndexed, avgMonthlyOutwardIndexed, suggestedReorderIndexed, toDisplay`

#### Data sources
- `useDataStore.{data, voucherIndex}`
- `useOrderStore.setLine`
- `useUIStore.{unitMode, isMobile}`
- `alertData` (40-55): for each item:
  - `stock = getCurrentStockIndexed(item, voucherIndex)`
  - `avgOut = avgMonthlyOutwardIndexed(item, voucherIndex, 3)` (3-month trailing avg)
  - `suggested = suggestedReorderIndexed(item, voucherIndex, stock)`
  - `monthsRemaining = avgOut>0 ? stock/avgOut : Infinity`
  - **Severity ladder**: `stock≤0`→Critical, `avgOut>0 && stock<avgOut`→Low, `suggested>0`→Reorder, else OK. OK filtered out
- Sort: Critical < Low < Reorder < OK

#### Supabase tables (web port)
- **READ:** `tally_stock_items`, `tally_voucher_inventory_entries`, `mv_low_stock_items`
- **WRITE:** None directly. Adding to Order calls `useOrderStore.setLine` which writes via Orders page save

#### Interactions
- Filters: group / severity / search — update state
- **Add All**: iterates `filtered` rows where `suggested>0`, calls `handleAdd`. Marks in `addedItems` Set; button label switches to "Added" with Check
- **Per-item Add** (mobile + desktop): same `handleAdd` — pushes line `{itemId, itemName, baseUnit, pkgUnit, unitsPerPkg, qtyBase:suggested, ratePerBase:openingRate}` into order draft

#### Filters / Sorting / Search
- Filters: group, severity
- Sort: severity order (hardcoded)
- Search: substring on `item.name` lowercase

#### Mobile vs desktop
- Two render paths (231-376). Mobile cards; desktop virtualized flex-row table with extra cols (`Group` hidden <lg, `Avg/Mo` and `Mo Left` hidden <md)
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
**Source:** `src/pages/Calendar.tsx`
**Purpose:** Visual ops console for delivery/sales workflow. Shows Tally vouchers (DN/Sales/Purchase/Receipt/Payment) on a month grid, day rows, or list, overlaid with per-voucher local kanban status, scheduled-date override, notes, follow-up log. Persists to localStorage in Electron (must promote to Supabase in web).

#### Layout
1. **Header** (1085-1124): title "Orders Calendar" + strapline "{N} vouchers from Tally · drag to reschedule · drag to change stage". Right: `Filter` icon + 5 type-toggle pills (DN/Sales/Purchase/Receipt/Payment) — active inverted black
2. **AnalyticsBar** (967-999): 4 KPI cards — "Total Orders" (count), "Total Value" (`fmtLakh`), "Completion" (% done/invoiced), "Overdue" (count). Color: completion green ≥60% else amber; overdue red if >0 else green
3. **View selector + status chips row** (1131-1184): segmented "Month / Days / List" (CalendarDays/Rows3/List). Right: status chips "All ({N})" + per non-empty status (`pending/confirmed/dispatched/delivered/invoiced/done`) colored by `STATUS_CFG`. Hidden when viewType==="month"
4. **Main + detail panel** flex row:
   - **Views (flex-1)**:
     - **MonthView** (437-581): 7-col grid. Month nav `ChevronLeft / Month Year / ChevronRight`. Day-of-week row. Cells min-h 100px, today accent. Up to 3 colored chips per cell (party first word + amount + status color), `+N more` if overflow. Empty cells slate
     - **DayRowsView (kanban)** (296-433): sticky month nav, status legend row, day rows. Today amber tint, weekends neutral. Row: 16px left col (circular day number, today filled accent), day-name, daily total. Right: horizontal-scroll `DayCard`s (w-44, party / amount / voucher# / status dot / rescheduled "↷"). Entire row is a drop target; "Drop here" placeholder when empty + dragOver
     - **ListView** (585-751): top sort bar (Date / Amount / Party with ChevronDown). Table: `Party / Type No. / Status / Date / Amount / Items`. Selected row accent left border; overdue red tinted. Empty: List icon + "No vouchers match the current filter"
   - **DetailPanel** (sticky right, 320/384px lg/xl, max-h `calc(100vh-200px)`, 755-963): header (party / type / number / close X). Body: current status badge + 5-button quick-move grid; metric pair (Amount, Date with rescheduled strikethrough); item list (inventory lines, qty × rate); narration block; editable notes (amber bg when set); follow-up log; "Reset to original date" if `isRescheduled`. Footer: "Log Follow-up" button transforms to input + Save/Cancel
5. **Empty state** (1190-1198): CalendarDays icon, "No Tally data imported"

#### Components used
- lucide `CalendarDays, Rows3, List, ChevronLeft, ChevronRight, X, Clock, TrendingUp, AlertTriangle, CheckCircle2, Activity, MessageSquarePlus, GripVertical, ChevronDown, Package, Filter, RotateCcw`
- Internal: `StatusBadge` (133-144), `DayCard` (239-294), `DayRowsView`, `MonthView`, `ListView`, `DetailPanel`, `AnalyticsBar`
- HTML5 native drag/drop

#### Data sources
- `useCalendarStore` (`overrides, viewType, selectedId, currentMonth, showTypes`) + actions `setStatus, setScheduledDate, setNotes, addFollowUp, resetOverride, setViewType, setSelectedId, setCurrentMonth, setShowTypes`. Persisted to localStorage `mkcycles-calendar-v2`
- `useDataStore.data.vouchers`
- Derived (1027-1057):
  - `allDisplayVouchers`: vouchers matching `showTypes && !isCancelled`, merged with override `{status, scheduledDate, notes, followUps, isRescheduled}`. Default status `"pending"`, default `displayDate = voucher.date`
  - `filteredForMonth`: displayDate matches `currentMonth`
  - `filteredAll`: optionally narrowed by `statusFilter`
  - `viewItems`: month → filteredForMonth; kanban/list → filteredAll
  - `selectedDV`: lookup by voucherId

#### Supabase tables (web port)
- **READ:** `tally_vouchers`, `tally_voucher_*_entries`
- **WRITE:**
  - `voucher_overrides` (voucher_id PK, status TEXT, scheduled_date DATE NULL, notes TEXT NULL, created_at, updated_at)
  - `voucher_follow_ups` (id, voucher_id FK, action TEXT, notes TEXT NULL, created_at TIMESTAMPTZ)
  - `user_calendar_prefs` (user_id PK, view_type, current_month, show_types JSONB)

#### Interactions
- Type toggle pills: add/remove from `showTypes`
- View buttons: `setViewType`
- Status chips: set `statusFilter`
- Month nav: `navigateMonth(-1|1)`
- Voucher card click: `setSelectedId`
- **Drag voucher** (Month + DayRows): `onDragStart` writes `voucherId` to dataTransfer; `onDrop` calls `setScheduledDate(voucherId, isoDate)`
- Drag visual: `onDragOver` highlights with accent ring; `onDragLeave` resets
- List sort buttons: click active col toggles direction; click different col resets to desc
- **DetailPanel**:
  - Status grid → `setStatus`
  - Notes Add/Edit → textarea + Save (calls `setNotes`)/Cancel
  - "Log Follow-up" → input; Enter or Save → `addFollowUp(action.trim())` (timestamp = now ISO); Cancel hides
  - "Reset to original date" → `resetOverride(voucherId)` deletes whole record (clears notes + status too)
  - Close X → `setSelectedId(null)`

#### Filters / Sorting / Search
- Filters: type pills + status chips (kanban/list). No text search
- Sort: list view only — date/amount/party, asc/desc, default date desc

#### Mobile vs desktop
- When `selectedDV` set, views get `hidden lg:block` → detail panel takes over screen on mobile. lg+ side-by-side
- Type pills wrap. AnalyticsBar 2/4
- MonthView cells min-h 100px (cramped on mobile)
- **Touch DnD limitation**: HTML5 DnD poor on touch — touch users can't reschedule. Consider `react-dnd-touch-backend` for web port

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
**Source:** `src/pages/Routes.tsx`
**Purpose:** Interactive Leaflet map of West-Bengal delivery network. Howrah godown, every freight station, freight rate / distance / drive-time, dashed-line route pairs for trucks serving 2 stations per trip. Highlights stations with pending DNs.

#### Layout
- Outer: `flex flex-col`, `height: calc(100vh - 56px)`, padding 12/16
1. **Header row** (335-340): h1 "Routes Map" + strapline with godown address
2. **Body** `flex gap-3 flex-1 min-h-0`:
   - **Side panel** (`w-[340px]`, 344-438): search + Sort/Zone selects, scrollable station list, footer "Showing X of Y stations" + zone legend (color dots near/short/medium/long/far with km ranges)
   - **Map + detail col** (442-557): `<div ref=mapRef>` Leaflet container fills remaining. When selected, `section-card p-4` below with details

#### Components used
- `leaflet` (`L.map, L.tileLayer, L.marker, L.polyline, L.divIcon`). `leaflet/dist/leaflet.css`
- lucide `Navigation, ExternalLink, X, AlertTriangle, MapPin`
- Static data file `../data/stationData`: `STATIONS, GODOWN, ROUTE_PAIRS, ZONE_COLORS, ZONE_LABELS, ZONE_RANGES, formatDriveTime, getDistanceZone, StationData`
- Marker factories in-file (42-93): `makeDotIcon, makeBeaconIcon` (animated pulse), `makePairedIcon` (white inner), `makeGodownIcon` (square blue + center dot). `beacon-pulse` keyframe injected once into `<head>` (20-26) — needs SSR safety (`typeof document !== "undefined"`) in Next.js

#### Data sources
- Static: `STATIONS` (~85 stations: `id, name, district, lat, lng, freightRate, distanceKm, estimatedDriveMinutes, googleMapsQuery, notes, salesInvoices, salesValueINR, parties`), `GODOWN`, `ROUTE_PAIRS`
- Dynamic: `useDataStore.data.vouchers` filtered to non-cancelled non-optional DNs (123-140). For each DN, lowercase `partyName` matched against `station.parties` — first match increments `pendingCountMap.get(station.id)`

#### Supabase tables (web port)
- **READ:** `tally_vouchers` (voucher_type='Delivery Note', party_name, is_cancelled, is_optional)
- Station/route data: bundle as JSON in web app. If editable: `stations` + `route_pairs` tables

#### Interactions
- Search input: substring on name + district + parties.join(" ")
- Sort select: freight asc / distance asc / invoices desc / name A-Z
- Zone select: filter by `getDistanceZone(distanceKm)`
- **Station card click**: `setSelectedId(isSelected ? null : station.id)`. Triggers:
  - Map flyTo `[lat,lng] zoom 12` (or back to `[22.8, 88.2] zoom 8` when deselected) — 700ms
  - Polylines from godown → selected → each pair, indigo dashed `6 5`, weight 2.5, opacity 0.65
  - Markers updated: selected uses larger dot or beacon; paired use `makePairedIcon`; previous selection's pairs revert
  - Popup re-content includes pending count badge + pair badge
- **Map marker click**: `onSelectRef.current(station.id)` — toggle
- **Detail panel** (449-556):
  - Header: zone dot, name, district, pending pill, warn icon if `hasWarning` (freight > 8000 OR notes mention "actual"/"special"). Close X clears
  - 3-stat grid: Freight (₹/truck, colored), Distance (km), Drive Time
  - Parties list (comma-joined)
  - Notes (warn-styled) if `station.notes`
  - Route pairings list (510-541): clickable buttons — clicking switches selection
  - **Get Directions** → `https://www.google.com/maps/dir/?api=1&origin=B20+KMDA+Kona+Truck+Terminal+Howrah+West+Bengal+India&destination={station.googleMapsQuery}&travelmode=driving` (new tab)
  - **View on Map** → `https://www.google.com/maps/search/?api=1&query={station.googleMapsQuery}`
- Marker popups: inline HTML strings with Get-directions anchor

#### Filters / Sorting / Search
- Search (case-insensitive substring on name + district + parties)
- Sort: freight asc / distance asc / invoices desc / name asc
- Zone filter: all / near / short / medium / long / far

#### Mobile vs desktop
- **No responsive rewrites** — hard-coded `w-[340px]` panel + flex-1 map. On <700px doesn't fit
- Web port: stack panel under map on `<lg`, toggle panel, ensure map container explicit pixel height
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
**Source:** `src/pages/DistancePage.tsx`
**Purpose:** Compute road distance from Kolkata 700001 to each party's PIN via NIC e-Waybill distance API (proxied through local Express). Manual PIN overrides + bulk fetch.

#### Layout
1. **Header** (139-154): h1 "Party Distances" + strapline "Distance from Kolkata 700001 via NIC e-Waybill". Right: "Fetch All ({withPinCount})" (RefreshCw spinning when batchRunning, disabled if 0 PINs)
2. **Filters card** (157-194): white rounded-xl. 2-col grid (md+) — Search (label "Search", magnifier, placeholder "Search by party name, PIN, state, GSTIN…") and Party Type select (Sundry Debtors / Sundry Creditors / All Ledgers). Footer: "{sorted.length} parties" + "{withPinCount} with PIN" + "{loadedCount} distances loaded"
3. **Table** (197-320):
   - Sticky grid `1fr 120px 120px 180px 56px`: Party / PIN Code / State / Distance (e-Waybill) / edit
   - Body scroll `max-height: calc(100vh - 360px)`
   - Empty inside: Navigation2 + "No parties found"
4. **No-data state** (120-133): full-page Navigation2, "No Data Loaded", blue CTA → `/import`

#### Components used
- lucide `Navigation2, Upload, Search, RefreshCw, Pencil, Check, X`
- No external libs beyond lucide+clsx

#### Data sources
- `useDataStore.data.ledgers` — `ledgerId, name, group, gstin, pincode, state`
- Local state: `search`, `groupFilter` ("Sundry Debtors" default), `distances` (`Record<ledgerId, {km, error?, loading}>`), `pincodeOverrides`, `editingPin`, `editValue`, `batchRunning`
- Derived:
  - `rows`: ledgers filtered by group, mapping to PartyRow with `pincode = overrides[id] ?? l.pincode`
  - `filtered`: substring search across name + pincode + state + gstin
  - `sorted`: by loaded distance asc (Infinity if not fetched), tiebreak name
  - `withPinCount`: rows with 6-digit pincode
- Server: `GET ${SERVER}/api/distance?from=700001&to={pin}` where `SERVER=http://localhost:3100`. Server proxies to `https://ewaybillgst.gov.in/apipre/api/v1.0/Distance/pincode?srcpincode=...&dstpincode=...`

#### Supabase tables (web port)
- **READ:** `tally_ledgers`
- **WRITE:**
  - `ledger_pincode_overrides` (ledger_id PK, pincode_override TEXT)
  - `pincode_distances` (from_pin, to_pin, distance_km, fetched_at) — cache
- NIC fetch moves to Next.js API route `/api/distance` with caching

#### Interactions
- Search input: controlled, no debounce
- Party Type select: `groupFilter`
- **Fetch All** (147-153): iterates `filtered` with valid PIN, calls `fetchOne` sequentially with `setTimeout(250ms)`. Disabled while running or 0 PINs
- **Per-row Fetch link** (292-297): single row
- **Edit PIN pencil** (304-313): sets `editingPin = ledgerId`, `editValue = current pin`
- **PIN edit input** (243-254): maxLength=6 digits. Enter commits, Escape cancels; tick / X buttons
- **Commit** (111-116): trims if non-empty writes to `pincodeOverrides`; if empty deletes override
- **Errors**: red "Error" text with `title=dist.error`

#### Filters / Sorting / Search
- Filters: party group (3 options)
- Sort: distance asc (unfetched last), then name
- Search: name + pincode + state + gstin substring

#### Mobile vs desktop
- No `isMobile` branch
- Fixed grid `1fr 120px 120px 180px 56px` — narrow screens overflow without scroll
- **Web port**: collapse to cards on `<md` OR horizontal overflow with sticky party col

#### Edge cases
- `data===null` → empty state
- pincode missing or not 6 digits → "—", no Fetch button, ineligible for Fetch All
- `pincodeOverrides[id]` present → "manual" amber pill; revert via edit-save-empty
- NIC API failure → red "Error" with tooltip; retryable
- API returns null → row stays in "click to fetch" state
- Concurrent batch runs prevented by `batchRunning`
- `SERVER` hardcoded — replace with env-driven `/api/distance`

---

### Page: Reports
**Route:** `/reports`
**Source:** `src/pages/Reports.tsx`
**Purpose:** 4-tab BI dashboard: financial health, sales performance, inventory health, expense/cash-flow. Reads from in-memory data store, renders KPI cards, recharts viz, breakdown tables, click-through drill-down modals.

#### Layout

**Sticky page header** (953-1015): white bg, bottom border, z-20
- **Page title** "Reports" (text-3xl md:text-4xl font-bold)
- **Date Range row** (958-993): 3 presets `This Month / Last Month / YTD` (active = `bg-accent text-white`); active detected by string equality `dateRange.from === fn().from`. Right: two `<input type="date">` for from/to
- **Tab bar** (997-1014): 4 tabs (underline-on-active) — `Financial Health`, `Sales Performance`, `Inventory & WC`, `Expense & Cash Flow`. Horizontally scrollable

**Content area** (`max-w-7xl mx-auto px-4 py-8 md:px-6`, 1018-1054): renders active tab

**Empty state** (1019-1022): when `filteredVouchers.length===0` → "No transactions found for the selected date range."

**Top-level no-data** (930-941): centered "No data loaded. Please sync from Tally on the Import page." with `<Link to="/import">Go to Import</Link>`

**Drill-down modals** (1056-1117): full-screen overlay (40% black backdrop, `fixed inset-4`, `md:inset-[10vh] lg:inset-[5vh]`). 3 variants: `revenue`, `purchases`, `outstanding`. Each: header (title + X), scrollable list

**Tab 1 — Financial Health** (`FinancialHealthTab`, 216-444):
- 6 KPI cards in grid `grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4` (311-356):
  - Gross Revenue (clickable, trend arrow)
  - Gross Profit (green/red)
  - Gross Margin % (green ≥15%, amber ≥10%, red <10%)
  - Total Purchases (clickable)
  - Bank + Cash (green/red)
  - Net Outstanding (amber/green, clickable)
- **Monthly Chart card** (359-380): "Monthly Revenue vs Purchases" → `ComposedChart` 300px, two `Bar`s (Revenue `#3b82f6`, Purchases `#f97316`) on left Y
- **P&L Breakdown card** (383-441): 2-col grid `Income / Expenses`. Each lists ledgers from `data.ledgers` where `group === "Income"` or `"Expenses"` as expandable buttons (chevron up/down)

**Tab 2 — Sales Performance** (`SalesPerformanceTab`, 450-570):
- **Top 20 Items chart card** (497-508): vertical bar chart 400px, `margin={{left:200, right:20}}`, name truncated 28 chars
- **Sales Velocity table** (511-567): heading + search ("Search items…"). Columns Item / Units / Revenue / Avg Rate. Up to 50 filtered. "Show all N items" toggle when >50

**Tab 3 — Inventory & WC** (`InventoryTab`, 576-758):
- 4-card KPI grid `grid-cols-2 md:grid-cols-4 gap-4` (677-682): Total Inventory, Zero Stock (red), Dead Stock, Avg Turnover (hardcoded `"2.3x"` — TODO web port)
- **Filters card** (685-712): search + 5 status buttons (All / IN / LOW / ZERO / DEAD); active accent
- **Stock Status table** (715-755): Item / Group / Current Stock / Stock Value / Status (color-coded pill). Capped 100

**Tab 4 — Expense & Cash Flow** (`ExpenseTab`, 764-889):
- **Monthly Cash Flow chart** (830-845): `ComposedChart` 300px — Receipts green `#22c55e`, Payments red `#ef4444` on left + blue running Balance `Line` on right
- **Expense Breakdown card** (848-887): collapsible groups. Each header: sum + chevron. Body: each ledger name + amount + `(pctOfTotal%)`

#### Components used
- Recharts: `BarChart, Bar, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer` (3-14)
- lucide: `TrendingUp, TrendingDown, X, ChevronDown, ChevronUp, Search` (15-22)
- `Link` from react-router-dom for `/import` fallback
- Internal: `KPICard`, `DrillDownModal`, four tab components

#### Data sources
- Store: `useDataStore` → `data` + `voucherIndex`
- Engine: `computeOutstandingInvoices(filteredVouchers, ledgers, 30)`, `computeBankBalance(ledgers, filteredVouchers)`, `getCurrentStockIndexed(item, voucherIndex)`
- Derived:
  - `filteredVouchers` (905-914): excludes cancelled/optional, filters `dateRange.from ≤ date ≤ dateRange.to`
  - `priorVouchers` (916-928): same-length window immediately before from
  - `monthlyChartData`: groups by `date.substring(0,7)`, sums sales/purchases, sorted chronologically (230-258)
  - `financials`: revenue, purchases, outstanding, bankBalance, priorRevenue (260-288)
  - `trends.revenue` pct = `(curr-prior)/prior*100` (290-302)
  - `grossProfit = revenue - purchases`; `grossMarginPct = grossProfit/revenue*100`
  - `topItems`: walks Sales voucher inventory lines, accumulates revenue/qty/lineCount per itemId, sorts by revenue desc, top 20 or all (460-487)
  - `stockMap`: per item via `getCurrentStockIndexed`
  - `inventory[]` (596-631): per item — stock, outwards = Σ qtyBase across Sales lines, periodDays from first/last filtered, `avgMonthlyOutward = outwards / max(1, periodDays/30)`, status:
    - `stock≤0` → "zero"
    - `outwards===0` → "dead"
    - `stock<avgMonthlyOutward*2` → "low"
    - else "in"
    - `stockValue = stock * (item.openingRate || 0)`
  - `monthlyFlow` (773-797): sorted by date, accumulates receipts/payments per month, running balance `+totalAmount` Receipt, `-totalAmount` Payment
  - `expensesByLedger` (799-825): walks every voucher's ledger lines where `isDebit`, sums by `ledgerId`, computes `pctOfTotal`, sorted desc

#### Supabase tables (web port)
- **READ:** `tally_vouchers`, `tally_voucher_*_entries`, `tally_ledgers`, `tally_stock_items`, `mv_outstanding_invoices`
- **Recommended views**: `mv_monthly_revenue_purchase`, `mv_monthly_cash_flow`, `mv_item_sales_velocity`, `mv_expense_by_ledger`, `mv_current_stock`
- **WRITE:** None

#### Interactions
- Date preset buttons: reset `dateRange` via `setDateRange(fn())`
- Date inputs: live edits
- Tab buttons: switch `activeTab`
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
- **KPICard** (119): label/value, optional trend `{pct, direction}`, color, optional onClick + loading
- **DrillDownModal** (177): full-page with backdrop, title, X close. Animations
- **Modal variants**:
  - **Revenue** (1057-1075): list `{partyName, date}` left, `formatINR(totalAmount)` right
  - **Purchases** (1077-1095): same
  - **Outstanding** (1097-1117): party + `agingBucket` pill + `formatINR(outstanding)`

#### Mobile vs desktop
- KPI grids responsive
- Filters: `flex-col md:flex-row`
- Page title `text-3xl md:text-4xl`
- Modal sizing: `inset-4` mobile, lg `inset-[5vh]`
- Tabs `overflow-x-auto`

#### Edge cases
- No data: Link to Import
- Empty date range: "No transactions found"
- No prior revenue: trend pill suppressed
- Division by zero: grossMarginPct returns 0 if revenue=0; pctOfTotal returns 0 if total=0
- Item missing from items map: filtered out
- Avg Turnover hardcoded "2.3x" — TODO replace with real metric in web port

---

### Page: Settings
**Route:** `/settings`
**Source:** `src/pages/Settings.tsx`
**Purpose:** Central control: local storage diagnostics, Tally proxy connection, unit mode, financial year, planning constants, unit Excel import/export, data integrity audit, audit log export, backup restore/download/delete, data clear/erase flows. **In web port:** also add Team management (invite users).

#### Layout
- Single `max-w-xl space-y-6` column. Each section is a `Section` card (659-666) with `section-header`
1. **Page header**: `SettingsIcon` (24px accent) + "Settings" (257-262)
2. **Local Data Storage section** (265-291): HardDrive icon + descriptor. If data loaded: 3-col `Stat` grid (Items / Ledgers / Vouchers) + JSON-uploads + `data.sourceFiles` joined. Else "No data loaded"
3. **Tally Connection section** (`TallyConnectionSection`, 677-813):
   - Status banner green/red, Wifi icon, "Connected" / "Not Connected", subtext `Proxy: {proxyUrl}` or "Start proxy: cd server && npm run dev", **Test** button (spinning RefreshCw when testing)
   - Proxy URL input
   - Company Name read-only (`M.K.CYCLES (P) LTD.`)
   - FY From / To (grid-cols-2 `YYYYMMDD`)
   - Auto-sync info accent banner: "Today's vouchers auto-sync every 30 minutes when connected."
   - Last Sync timestamp via `formatLastSync()`
4. **Unit Mode** (297-305): "Currently: BASE/PKG" + button "Switch to PKG/BASE"
5. **Financial Year** (308-313): `<select>` from year-3 to year+1, format `YYYY-YYYY`
6. **Default Cover Months** (316-325): 4 pill buttons `1, 1.5, 2, 3`; active = `btn-primary`
7. **Lead Time Months** (328-332): `<input type="number" min=0.5 max=6 step=0.5>` fallback 1.5
8. **Default Credit Days** (335-339): `<input type="number" min=0 max=365>` fallback 30
9. **Unit Configuration** (342-378): `Export Template` (FileSpreadsheet) + `Import Excel` (Upload, hidden `<input type="file" accept=".xlsx,.xls">`). Shows "N unit override(s) currently applied"
10. **Diagnostics** (381-546): `Run Audit` button. If `auditResults` exists:
    - Summary: 2 bento-cards "Items Passed N/M" and "Chain Valid N/M"
    - Invoice Balance: 3-col Billed / Paid / Outstanding (in ₹L)
    - Voucher Types: 2-col grid type → active count, `(-X)` cancelled, `(~Y)` optional
    - Issues Found: collapsible discrepancies (table Item × Opening × In × Out × Discrepancy), Negative Stock list, Items without GST grid. `▶`/`▼` arrows
    - Dead Items: info line "ℹ N dead item(s)"
11. **Audit Log** (549-554): `Export Audit Log`
12. **Backup Management** (557-597): list of backups (max-h-72). Per row: Archive icon, label, formatted createdAt, **Restore** (two-step confirm — text "Confirm?"), **Download**, **Delete**. Empty: "No backups yet". Warning when >15
13. **Danger Zone** (600-654):
    - **Clear Working Data**: descriptor + `confirmClear` alert + red button "Clear Working Data" / "Confirm Clear Working Data"
    - **Erase All Data** (separator border-t): Shield icon + bold red header, state-driven button: idle → "Erase All Data (with backup)" / confirm → "Confirm — Download Backup & Erase" / downloading → "Erasing..." / done → "Done". Alerts per state

#### Components used
- lucide `Settings as SettingsIcon, Trash2, Download, Upload, AlertTriangle, FileSpreadsheet, Archive, RotateCcw, Shield, HardDrive, Activity, Wifi, RefreshCw`
- Internal: `Section`, `Stat`, `TallyConnectionSection`, `useToast`

#### Data sources
- Stores:
  - `useUIStore` (15): `unitMode, toggleUnitMode, fyYear, setFyYear, coverMonths, setCoverMonths, leadTimeMonths, setLeadTimeMonths, defaultCreditDays, setDefaultCreditDays`
  - `useDataStore`: `data, clearData, refreshOverrides, voucherIndex`
  - `useOverrideStore`: `exportAuditLog, units, setUnitOverride`
  - `useTallyStore` (678): `proxyUrl, companyName, isConnected, lastSyncAt, fyFromDate, fyToDate, setProxyUrl, setConnected, setFyDates`
- IDB: `clearAllData, listBackups, loadBackup, deleteBackup, exportBackupAsJSON, exportFullBackupAsJSON, eraseAllStores, listJsonUploads`
- API: `checkTallyHealth()`
- Excel: `exportUnitsToExcel, importUnitsFromExcel`
- Audit engine (dynamic import 212): `auditAllItems, auditInvoiceBalance, getVoucherTypeDistribution, findNegativeStockItems, findDeadItems, findItemsWithoutGST`

#### Supabase tables (web port)
- `app_settings` (per-user/org): `unit_mode, fy_year, cover_months, lead_time_months, default_credit_days`
- `tally_connection` (per-user): `proxy_url, company_name='M.K.CYCLES (P) LTD.', is_connected, last_sync_at, fy_from_date, fy_to_date`
- `unit_overrides` (already exists): import Excel writes here
- `audit_log`: write-only — `id, user_id, timestamp, action_type, payload_json`
- `backups` metadata: `backup_id, created_at, label, size_bytes, storage_path` (Supabase Storage `backups/`)
- `tally_sync_history` (already exists): surface in web port (currently absent on page)
- **Storage:** Supabase Storage `backups/` for JSON snapshots + `audit_log_YYYY-MM-DD.json`
- **NEW for web:** `app_users` editable here (Team subsection)

#### Interactions
- Toggle Unit Mode → `toggleUnitMode()`
- FY select → `setFyYear`
- Cover Months pills → `setCoverMonths(m)`
- Lead Time / Credit Days inputs → setters with fallback
- Export Template → `exportUnitsToExcel(data.items, units)` + toast
- Import Excel → hidden file input; after import `setUnitOverride` per row + `refreshOverrides()`; toast errors
- Run Audit → `runningAudit=true`, dynamic-import engine, compute 6 audits, toast
- Toggle Discrepancies / NegativeStock / NoGstItems: 3 independent expand toggles
- Export Audit Log → `exportAuditLog()` → Blob → `audit_log_YYYY-MM-DD.json`
- Restore backup: 2-step — first click `confirmRestore=key`; second click on same key → `loadBackup → deserializeParsedData → clearData() → setData(parsed)`
- Download backup → `exportBackupAsJSON(key)`
- Delete backup → `deleteBackup(key)` + refresh
- Clear Working Data: 2-step — first click sets `confirmClear=true`; second click `clearData() + clearAllData()`
- Erase All Data: state machine `idle → confirm → downloading → done → idle`. In downloading exports full backup (`MKCP_full_backup_<timestamp>.json`), waits 1.5s, calls `eraseAllStores() + clearData() + removes 3 localStorage keys`. Resets to idle after 3s
- Test Connection → `checkTallyHealth()` + toast

#### Filters / Sorting / Search
None.

#### Mobile vs desktop
- `max-w-xl` → narrow desktop, full-width mobile
- FY dates `grid-cols-2` always
- Local Storage stats `grid-cols-3` always

#### Edge cases
- No data → Local Storage shows "No data loaded"; Diagnostics + Unit Export/Import disabled
- No backups → "No backups yet"; deletion list hidden
- Backup overflow (>15) → warning
- No unit overrides → hides "N unit override(s)"
- No audit yet → hides audit summary
- `lastSyncAt=null` → "Never"; row hidden
- No orphaned payments → warning hidden
- All passing audit → success toast; no Issues block

#### Web port special considerations
- **Backups** → Supabase Storage + `backups` table
- **Erase All Data** → RPC, no localStorage
- **Tally connection** → in web environment, the local Express proxy is not present. Repurpose as remote sync agent indicator OR cloud-hosted proxy URL OR drop entirely
- **Sync history** → add `tally_sync_history` table view here (missing currently)
- **NEW: Team subsection** — owner-only — invite users via Supabase Auth admin API, set role from dropdown

---

### Page: PerfLog (admin only)
**Route:** `/perf-log` (gate behind admin role in web port)
**Source:** `src/pages/PerfLog.tsx`
**Purpose:** Live perf instrumentation: heap memory (5s snapshots), long tasks (>50ms), route timings, FPS samples (1/sec), user markers. KPI cards, 5 detail tabs, JSON export.

#### Layout
1. **Header row** (216-271): Activity icon + "Performance Log" + subtitle `Auto-recording · {elapsed} elapsed · N snapshots · M long tasks`. Right: Mark Event (input + Save/×), Pause/Resume (icon switches), Clear (confirm), Export JSON
2. **Recording badge** (274-283): pill with pulsing dot (green=recording, gray=paused) + label + start timestamp
3. **KPI cards** (286-315) — `grid-cols-2 md:grid-cols-4 gap-3`:
   - Peak Heap: `summary.peakHeapMB MB`, sub `avg X MB`. Accent: ok<150, warn<400, bad ≥400
   - Long Tasks: count + total ms. Accent: 0=ok, <5=warn, else bad
   - Slowest Route: ms + route slug. Accent: <300=ok, <800=warn, else bad
   - Avg FPS: number + min N fps. Accent: ≥55=ok, ≥35=warn, else bad
4. **Tab bar** (319-342): 6 tabs `Overview / Memory / Long Tasks / Routes / FPS / Export`. Long Tasks has count badge (red ≥300ms, else amber); Routes neutral
5. **Tab panels** (344-723):
   - **Overview**: heap AreaChart (160px) + FPS LineChart (100px, ref lines 60+30). Markers list (Flag icon, label, hh:mm:ss, route, heap MB)
   - **Memory**: full AreaChart (240px); raw table (max-h-48) — Time/Used/Total/Limit/Route — reversed
   - **Long Tasks**: empty "No long tasks detected" or severity legend (warn/orange/danger) + sort toggle + table (# / Time / Duration colored / Route / Severity) + BarChart top 30 (ref lines 100ms/300ms)
   - **Routes**: empty "Navigate between pages…" or table Time / From / To (ArrowRight) / Render ms (colored badge) / Heap Δ
   - **FPS**: legend + full LineChart (220px, ref 60+30); if any <35, "Low-FPS Events" table
   - **Export**: blue info alert with how-to; Session Summary key→value tiles; "Export Full JSON" + count tooltip

#### Components used
- Recharts: `ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine`
- lucide: `Activity, Play, Pause, Trash2, Download, Flag, AlertTriangle, Zap, Clock, ArrowRight, MemoryStick, Gauge, ChevronDown, ChevronUp, CheckCircle`
- Internal: `MemTooltip, FpsTooltip, KpiCard`

#### Data sources
- `usePerfStore`: `recording, startedAt, memorySnapshots, longTasks, routeChanges, markers, fpsSamples` + actions
- Task severity (63-67): <100=low, <300=med, else high

#### Supabase tables (web port)
- **Renderer-internal page.** For web port: optional persistence:
  - `perf_sessions, perf_memory_snapshots, perf_long_tasks, perf_route_changes, perf_fps_samples, perf_markers`
- **Web port note:** `performance.memory` is Chromium-only with `--enable-precise-memory-info`; consider `performance.measureUserAgentSpecificMemory()`
- **Recommend:** drop or replace with Vercel Speed Insights / Web Vitals; gate behind admin role

#### Interactions
- Mark Event → inline input; Enter submits via `handleMark`; route captured
- Pause / Resume → store actions
- Clear → confirm dialog + `clearAll()`
- Export JSON → Blob → `mkcp-perf-<ISO>.json`
- Tab buttons → set `tab`
- Long Tasks sort toggle → flip
- No keyboard shortcuts

#### Filters / Sorting / Search
- Long Tasks: sort by duration asc/desc only
- No search

#### Mobile vs desktop
- KPI row 2/4
- Export summary 2/3
- Header `flex-wrap`

#### Edge cases
- Paused: KPI still last values
- <2 snapshots: "Collecting data…"
- 0 long tasks: CheckCircle
- 0 route changes: prompt
- <3 FPS: placeholder
- No markers: section hidden
- `useElapsed` hook bug: `useState(initializer)` misused as `useEffect` (interval keeps stale closure) — fix in web port

---

### Page: ServerLogs → Sync Logs (web port)
**Route:** `/server-logs`
**Source:** `src/pages/ServerLogs.tsx`
**Purpose:** Terminal-style live log viewer for the local Node Express proxy. **Web port: rewrite as Sync Logs reading from `sync_logs` Supabase table.**

#### Layout
- `flex flex-col h-full bg-neutral-950 text-neutral-100 font-mono`
1. **Header bar** (109-171): dark `bg-neutral-900`
   - **Left**: Terminal icon + "Server Logs" + Circle indicator (emerald connected / red disconnected) + label
   - **Right**: 3 filter pills `All (N) / Errors (N) / Warn (N)` (active: bg-neutral-700 / bg-red-900 / bg-yellow-900) + Reconnect (RefreshCw) + Copy all (Copy / CheckCheck) + Clear (Trash2, red hover)
2. **Log body** (174-197): scrollable `space-y-0.5 text-xs leading-5`. Per line colored:
   - success → emerald-400
   - error → red-400
   - warn → yellow-400
   - info → neutral-300
   - `whitespace-pre-wrap break-all`
   - Empty: "No log entries yet." in neutral-600
   - `bottomRef` for auto-scroll
3. **Footer scroll-to-latest** (200-209): when `autoScroll===false`. Centered "↓ scroll to latest" resumes auto-scroll

#### Components used
- lucide `Terminal, Trash2, Copy, CheckCheck, RefreshCw, Circle`
- Raw `EventSource` for SSE (web port: replace with Supabase Realtime)
- `navigator.clipboard`

#### Data sources
- REST: `GET ${BASE}/api/tally/logs` (45) initial buffer
- SSE: `${BASE}/api/tally/progress` (55) streaming
- `BASE = import.meta.env.VITE_TALLY_PROXY || "http://localhost:3100"`
- Classification (12-20):
  - success: contains `✓ / ready / success / ✅`
  - error: `❌ / ✗ / error / Error / failed / Failed`
  - warn: `⚠ / warn / Warn / timeout / retry`
  - default info
- State: `lines: LogLine[]` capped 2000 (`next.slice(-2000)`); `autoScroll, connected, copied` (2-sec reset), `filterLevel`

#### Supabase tables (web port — full rewrite)
- **READ + Realtime:** `sync_logs` (id BIGSERIAL, sync_id UUID, timestamp TIMESTAMPTZ, level TEXT, message TEXT)
- Page reads latest 2000 by `timestamp desc`
- Subscribe via Realtime channel for inserts
- Filters: server-side `level IN ('error', 'warn')`
- Clear button = UI-only (no server mutation)
- **No write**

#### Interactions
- Filter pill: `setFilterLevel`
- Reconnect: refetches buffer + reopens EventSource (web: re-subscribes Realtime)
- Copy all: joins all (unfiltered) `\n`-separated, clipboard.write, CheckCheck for 2s
- Clear: `setLines([])` client-side only
- Scroll: detect bottom (within 60px) → autoScroll=true; scroll up → autoScroll=false
- Scroll-to-latest button: smooth scroll + autoScroll=true
- Auto-scroll effect: every new lines array, if `autoScroll`, scroll into view
- SSE lifecycle: onopen/onmessage/onerror

#### Filters / Sorting / Search
- Filter: all / error / warn (info shows only in "all")
- Sort: implicit chronological
- Search: none

#### Mobile vs desktop
- No explicit responsive logic — `flex-col h-full`
- Toolbar may overflow narrow widths — consider wrapping

#### Edge cases
- Empty buffer: "No log entries yet."
- Disconnected: red indicator
- 2000-line cap: oldest truncated
- Logs paused: not applicable
- No clipboard API: silent fail

---

## Part 5 — Sync Boundary with Electron

| Action | Origin | Sync direction |
|---|---|---|
| Tally XML imported | Electron only | Electron → Supabase. Web reads. |
| Discount rule edited | Either | Last-write-wins via `updated_at`. Both see updates via Realtime. |
| Order group created | Either | Same. |
| Vendor group reassigned | Either | Same. |
| Calendar status / scheduled date edited | Either | Same — currently localStorage-only in Electron → must promote to `voucher_overrides`. |
| Push to Tally | Electron only | Web disabled / "Open in desktop" CTA. |

**Conflict resolution:** Last-write-wins on every config table's `updated_at`.

---

## Part 6 — Phases / Roadmap

### Phase 1 — Foundation (Week 1-2)
- Next.js scaffold + Tailwind tokens (copy `src/index.css`)
- Supabase client with anon key, auth (magic link + Google)
- `app_users` provisioning by owner
- RLS rewrite for authenticated reads on every table
- Layout + NavBar + Toast + skip-to-content
- **Goal:** Dashboard renders with 4 KPI cards proving read pipeline works

### Phase 2 — Read-only views (Week 3-5)
- Invoices, Ledgers, Pending Orders, Price List (read), Reports (all 4 tabs read)
- TanStack Query + caching
- Materialized views deployed in Supabase
- Mobile bottom-nav + sheet
- All shared modals (VoucherModal, DNModal, GroupDetailsModal)
- Shared components: `KPICard, RatePill, AmountPill, UnitToggle`

### Phase 3 — Config editing (Week 6-8)
- Discount Rules (with color picker)
- Order Groups (with multi-select item assignment)
- Edit Units (with audit log)
- Vendor Groups assignment
- Item Notes
- Audit log on every config write

### Phase 4 — Outreach + mobile polish (Week 9)
- Outreach calling list with mobile-first UX
- WhatsApp share buttons + tel: links (improvements over Electron)
- One-tap clipboard copy of suggested order text
- Bottom-sheet party panel

### Phase 5 — Real-time, Alerts, Calendar (Week 10-11)
- Supabase Realtime channels on every config table
- Alerts page with virtualized list
- Calendar page (replace HTML5 DnD with react-dnd-touch-backend for mobile)
- Voucher overrides promoted from localStorage to Supabase

### Phase 6 — Routes + Distance + Settings + Sync Logs (Week 12)
- Routes map (Leaflet dynamic-import, ssr:false)
- Distance page (Next.js API route + pincode cache)
- Settings (team management, backups via Supabase Storage)
- Sync Logs page (replace SSE with Realtime on `sync_logs` table)

### Phase 7 — Beta + Polish (Week 13-14)
- Invite 3 real users (owner, manager, sales)
- Telemetry: Vercel Analytics
- Iterate based on feedback
- Lighthouse audit

---

## Part 7 — Success Metrics

| Metric | Target by month 3 |
|---|---|
| Active users / week | 5 |
| Edits per week (any config table) | 50+ |
| Mobile session % (outreach) | >40% |
| Dashboard p95 load time | <2s |
| Real-time event latency | <500ms |
| Zero data-loss incidents | 100% |
| Lighthouse score (Dashboard) | >85 |

---

## Part 8 — Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Leaked service-role key** in `supabaseSync.ts:13-14` | Rotate before web deploy; never ship to browser. |
| **RLS bugs leak cross-company data** | Automated tests: 2 test users in different companies, assert isolation. |
| **Realtime floods** during edits | Debounce inbound; rate-limit channel. |
| **Tally-sync lag** — web shows stale data | Prominent "Last synced X ago" badge; cron-trigger reminder >12h. |
| **Mobile data costs** (field sales) | Aggressive TanStack caching; SWR for stable lists. |
| **Orphaned references** when Tally deletes items | Periodic cleanup edge function; UI shows "missing item" gracefully. |
| **Schema drift** between Electron and web | Both import generated types from `supabase gen types typescript`. |
| **Calendar HTML5 DnD doesn't work on touch** | Use `react-dnd-touch-backend`. |
| **PerfLog: `performance.memory` Chromium-only** | Gate behind admin role; or replace with Vercel Speed Insights. |
| **Settings: Tally proxy doesn't exist in web** | Repurpose Tally Connection section as remote-sync-agent indicator. |
| **Routes Leaflet SSR** | Dynamic-import with `ssr:false`; ensure non-zero container height. |
| **Discount rule data loss** if SCHEMA_VERSION bumped without migration | Migration logic in store preserves `itemCategoryOverrides + categoryColors` (already done in commit b2c753e). |

---

## Part 9 — Open Questions

1. **Domain?** `app.mkcycles.in`? `dashboard.mkcycles.in`?
2. **Multi-tenant?** Currently hardcoded `"M.K.CYCLES (P) LTD."` — should `app_users.company` enable other companies?
3. **Tally push from web** via webhook to long-running Electron instance — v2 scope.
4. **Notification channel for alerts** — email? push? WhatsApp?
5. **Geocoding budget** for Routes (Google / Mapbox / OSM Nominatim).
6. **Should Calendar drag-drop be replaced with explicit "Move to date" picker on mobile?**
7. **PerfLog**: keep, or replace entirely with Vercel Speed Insights?

---

## Part 10 — Reusable Assets Inventory

Direct copies from Electron:

| Asset | Status |
|---|---|
| `src/index.css` (design tokens + utility classes) | **Copy verbatim** |
| `src/components/KPICard.tsx` | **Copy 1:1** |
| `src/components/ColorPicker.tsx` | **Copy 1:1** |
| `src/components/PriceVerification.tsx` (RatePill, AmountPill, priceMatches, PRICE_TOLERANCE) | **Copy 1:1** |
| `src/components/UnitToggle.tsx` | **Copy 1:1** |
| `src/components/GroupTabs.tsx` | **Copy 1:1** (already fixed for re-render bug) |
| `src/components/VendorGroupsSummary.tsx` | **Copy 1:1** |
| `src/components/ExpandedGroupsView.tsx` | **Copy 1:1** |
| `src/components/Toast.tsx` | **Copy 1:1** |
| `src/components/ErrorBoundary.tsx` | **Copy 1:1** (uses `window.location.reload()`) |
| `src/engine/discounts.ts` (discount engine, DEFAULT_DISCOUNT_CATEGORIES, calculateVoucherDiscount) | **Copy 1:1** |
| `src/engine/financial.ts` (computeOutstandingInvoices, computeBankBalance, monthlyTotals, computeItemMargins) | **Copy 1:1** |
| `src/engine/inventory.ts` (getCurrentStockIndexed, avgMonthlyOutwardIndexed, suggestedReorderIndexed, computeMonthlyBucketsIndexed) | **Copy 1:1** (but consider replacing with server-side mv queries) |
| `src/engine/unitEngine.ts` (toDisplay, fromDisplay) | **Copy 1:1** |
| `src/engine/audit/movementTracer.ts` (getItemMovements, getItemOrderDocs) | **Copy 1:1** |
| `src/utils/format.ts` (fmtINR, fmtRate, fmtNum, fmtDate, fmtLakh) | **Copy 1:1** |
| `src/utils/gstInference.ts` (inferGstRatesFromVouchers) | **Copy 1:1** |
| `src/utils/auditPriceList.ts` | **Copy 1:1** |
| `src/data/stationData.ts` (STATIONS, GODOWN, ROUTE_PAIRS, ZONE_*) | **Copy 1:1** as bundled JSON |
| `src/data/vendorGroups.ts` | **Copy 1:1** |
| `src/parser/tallyPriceListParser.ts` (parseTallyPriceListJson) | **Copy 1:1** |
| Type definitions (`src/types/canonical.ts`) | **Copy 1:1** + generated Supabase types |

**NOT reusable (drop or rewrite):**
- `src/db/idb.ts` — replace with Supabase queries
- Electron preload bridge `window.electronAPI.*` — drop entirely
- `src/parser/transactionParser.ts`, `masterParser.ts` — stays in Electron
- `src/api/tallyApi.ts` — stays in Electron
- `src/hooks/useTallyAutoSync.ts` — stays in Electron
- `src/hooks/usePerfMonitor.ts`, `usePersistenceMonitor.ts` — replace with Vercel Analytics + TanStack
- `src/store/dataStore.ts`, `tallyStore.ts` — replace with TanStack Query hooks pulling from Supabase

---

## Part 11 — Acceptance Criteria for v1 Launch

- [ ] All 17 routes from Part 4 render with real data
- [ ] Owner can invite a second user; that user logs in and sees only their permitted pages
- [ ] An edit in the web app appears in the Electron app within 5 seconds (and vice versa)
- [ ] Outreach calling-list works on iPhone Safari and Android Chrome (tested on real devices)
- [ ] No service-role key in browser bundle (verify via build inspection)
- [ ] Cross-company RLS isolation test passes
- [ ] Lighthouse score >85 on Dashboard
- [ ] Audit log captures every config-table write with user_id + timestamp + before/after
- [ ] Calendar drag-and-drop works on both desktop and touch devices
- [ ] Routes map loads on mobile with usable panel toggle
- [ ] Backup restore from Settings round-trips successfully (Electron-created backup restorable from web and vice versa)

---

**End of PRD.**

*This document is intentionally exhaustive so any frontend dev can build the web port without reverse-engineering the Electron app. Every layout, every interaction, every edge case, every data source is mapped. Where the Electron app has a known weakness (touch DnD, localStorage-only state, Chromium-only APIs), the recommended web-port adaptation is called out.*
