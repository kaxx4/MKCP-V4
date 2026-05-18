# PRD: MK Cycles Web Dashboard

**Status:** Draft v1
**Author:** Engineering
**Last Updated:** 2026-05-18
**Source of Truth:** Existing Electron dashboard (`mkcycles-dashboard/src/pages/*`) + Supabase project `vmkytsytxlofjyeotmgb`

---

## 1. Summary

Build a web-based version of the MK Cycles Dashboard that reads/writes the **same Supabase backend** the Electron app already syncs to. The web app delivers the same operational features (orders, discounts, vendor groups, pricing, outreach, reports) but is **multi-device, multi-user, real-time, and zero-install**.

The Electron app remains the **system of record for Tally** (XML imports happen there; pushes back to Tally happen there). The web app is a **read-write companion** for everything the Electron dashboard *edits* (config), and a **read-only companion** for Tally-sourced data (vouchers, masters).

---

## 2. Goals & Non-Goals

### Goals
1. **Operational continuity from anywhere** — sales staff, accountants, and the owner can view + edit config from a browser without installing the Electron app.
2. **Real-time collaboration** — two users editing different parts of the same dataset see each other's changes without a refresh.
3. **Mobile usable** — the calling-list / outreach flow must work on a phone (field salespeople).
4. **Zero deploy friction** — push to Vercel, every commit deploys a preview.
5. **Reuse the existing Supabase schema** — no parallel database, no fork.

### Non-Goals
1. **Replace the Electron app.** Tally XML import lives there. The web app does not parse Tally XML.
2. **Push to Tally from the web.** Stays in Electron until Tally exposes an HTTP API the web can hit (would require port-forwarded or a hosted Tally proxy — out of scope for v1).
3. **Real-time inventory recompute.** Reports/dashboards read pre-computed snapshots from Supabase, not live recompute over millions of voucher rows in the browser.
4. **Offline-first.** Web app requires connectivity. Electron retains offline mode via IndexedDB.

---

## 3. Users & Use Cases

| Persona | Primary Device | Top Tasks |
|---|---|---|
| **Owner / Director** | Desktop + phone | Dashboard KPIs, Reports, approve discount-rule changes |
| **Sales Manager** | Desktop | Orders, discounts, vendor groups, pending deliveries |
| **Field Sales** | Phone | Outreach calling list, party-wise pending orders |
| **Accountant** | Desktop | Ledgers (read-only), invoices (read-only), reconcile against Tally |
| **Owner (also)** | Phone | Spot-check daily sales, outstanding receivables |

---

## 4. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | **Next.js 15 (App Router)** | SSR for fast first paint, server actions for writes, file-based routing |
| Language | TypeScript (strict) | Already in use across Electron dashboard |
| UI | **Tailwind CSS + shadcn/ui** | Same design tokens as Electron app — reuse `src/index.css` utility classes |
| Data | **Supabase JS client (`@supabase/supabase-js`)** | Already on `vmkytsytxlofjyeotmgb` project |
| Auth | **Supabase Auth (email magic link + Google)** | First-party, RLS-aware |
| Real-time | **Supabase Realtime (postgres_changes)** | Already wired in via supabaseSync polyfill |
| State | **Zustand + TanStack Query** | Local UI state in Zustand, server-state cache in TanStack |
| Charts | Recharts | Same lib as Electron app — reuse Reports components |
| Hosting | **Vercel** | Edge-deployed, preview per PR |
| Maps (Routes page) | Leaflet + OSM tiles | Same as Electron app |

---

## 5. Data Model — Supabase Tables

The web app consumes the **exact same tables** the Electron app already syncs to. No schema fork.

### 5.1 Read-only tables (Tally-sourced)
| Table | Used by web pages |
|---|---|
| `tally_companies` | Header (company name), Settings |
| `tally_stock_items` | Orders, Price List, Edit Units, Discounts |
| `tally_ledgers` | Ledgers, Invoices, Outreach, Orders (party picker) |
| `tally_stock_groups` | Orders (group filter), Price List |
| `tally_units` | Edit Units, Orders (display) |
| `tally_godowns` | Reports, Pending Orders |
| `tally_cost_centres` | Reports |
| `tally_price_lists` | Price List (dealer rates), Discounts |
| `tally_vouchers` | Invoices, Orders (history), Reports, Outreach, Discounts |
| `tally_voucher_ledger_entries` | Reports (drill-down), Ledgers |
| `tally_voucher_inventory_entries` | Reports, Discounts, Orders (item history) |
| `tally_sync_history` | Settings (last sync indicator), Dashboard (data freshness) |

### 5.2 Read-write tables (config — web app edits these)
| Table | Used by web pages | Write trigger |
|---|---|---|
| `discount_rules` | Discount Rules editor | Edit category / tier |
| `order_groups` | Orders (group sidebar) | Create / edit / delete group |
| `unit_overrides` | Edit Units | Change pkg unit / units-per-pkg |
| `rate_overrides` | Edit Units, Price List | Custom rate per item |
| `item_category_overrides` | Discount Rules → Item Assignments tab | Reassign item → category |
| `category_colors` | Discount Rules, Discounts | Pick color for category |
| `vendor_group_assignments` | Vendor Groups Summary | Assign item → vendor |
| `item_notes` | Item detail drawer (Orders, Price List) | Add note to item |
| `calling_list_entries` | Outreach | Mark called, add note |
| `tally_price_list_imports` | Price List (Tally rates section) | Upload Tally JSON |

### 5.3 New tables required for the web app
| Table | Purpose |
|---|---|
| `app_users` | Maps `auth.users.id` → role (`owner` / `manager` / `sales` / `accountant`) + `company` scope |
| `audit_log` | Who edited what, when. One row per write to a config table |
| `user_preferences` | Per-user sidebar collapse, theme, default landing page |

---

## 6. Auth & Security

### 6.1 Auth flow
1. User visits `app.mkcycles.in` (or chosen domain).
2. Sign in: email magic link **or** Google OAuth (gated to allowed domain).
3. On first login: must have a matching row in `app_users` (provisioned by owner via Settings → Team).
4. JWT contains `company` claim → all queries scoped automatically via RLS.

### 6.2 Roles & permissions
| Role | Read | Write |
|---|---|---|
| **owner** | All tables | All config tables; Settings → Team |
| **manager** | All tables | Discounts, order_groups, vendor groups, notes |
| **sales** | Stock items, ledgers, vouchers, orders, calling list, notes | calling_list_entries, item_notes only |
| **accountant** | All Tally tables, invoices, ledgers | None (read-only) |

### 6.3 RLS changes required
**Current state:** all migrations (`001_config_tables.sql`, `003_extended_config_tables.sql`) lock writes to `service_role` only. The Electron app talks via a server proxy holding the service key, so RLS is effectively bypassed.

**For web app:** rewrite RLS to authenticate against `auth.uid()` joined with `app_users`. Strategy:

```sql
-- Example for discount_rules
DROP POLICY "Service role can manage discount rules" ON discount_rules;

CREATE POLICY "Users can read their company's discount rules" ON discount_rules
  FOR SELECT USING (
    company = (SELECT company FROM app_users WHERE id = auth.uid())
  );

CREATE POLICY "Managers+ can write their company's discount rules" ON discount_rules
  FOR ALL USING (
    company = (SELECT company FROM app_users WHERE id = auth.uid())
    AND (SELECT role FROM app_users WHERE id = auth.uid()) IN ('owner', 'manager')
  ) WITH CHECK (
    company = (SELECT company FROM app_users WHERE id = auth.uid())
  );
```

Repeat per table with appropriate role gates. **Service role policies stay** so the Electron app's server proxy continues to work — both clients coexist.

### 6.4 Secrets
- **Service-role key never leaves the server.** Currently hardcoded in `supabaseSync.ts:13-14` (flagged in audit) — for the web app, server actions use the service key, browser uses the *anon* key + RLS. Anon key is safe to ship in the bundle.
- Rotate the leaked service key (see audit report) before public deploy.

---

## 7. Information Architecture

### 7.1 Routes
```
/                       — Dashboard (KPIs)
/orders                 — Orders + group sidebar
/orders/[groupId]       — Specific order group
/discounts              — Voucher discount calculator
/discounts/rules        — Edit categories + tiers + colors
/price-list             — Item rates + dealer prices
/price-list/correction  — Recommended rate corrections
/invoices               — Voucher list (sales/delivery)
/invoices/[voucherId]   — Voucher detail
/ledgers                — Party ledgers
/ledgers/[ledgerId]     — Party history + outstanding
/pending-orders         — Outstanding delivery notes
/alerts                 — Auto-generated business alerts
/outreach               — Calling list
/reports                — Financial health + 3 sub-tabs
/calendar               — Schedule / planned deliveries
/routes                 — Map view of parties
/settings               — Team, sync history, preferences
/login                  — Magic link form
```

### 7.2 Layout
- **Desktop:** left sidebar (collapsible), header with company + user, main content area
- **Mobile:** bottom tab bar (5 primary), hamburger for overflow — same pattern as Electron's `NavBar.tsx`
- **Reuse design tokens:** copy `src/index.css` verbatim — same component classes (`.btn-primary`, `.card`, `.kpi-value`, etc.)

---

## 8. Feature Spec — Per Page

### 8.1 Dashboard (`/`)
- 8 KPI cards: revenue, purchases, outstanding receivables, bank balance, items sold, top party, pending orders count, sync freshness
- "Last synced" badge — green if `tally_sync_history` row < 4hrs old, amber 4-24hrs, red >24hrs
- Same KPICard component as Electron (`src/components/KPICard.tsx`)

**Data:** SQL views aggregate `tally_vouchers` server-side; client fetches the view, not raw vouchers.

### 8.2 Orders (`/orders`)
- Item list (virtualized for 500+ items) with closing stock, units-per-pkg, last-bought-by-party
- Group sidebar (from `order_groups`): create/edit/delete, color, items, save lines with quantities
- Multi-select → batch assign to group (same UX as Electron)
- Tabs at top: filter by vendor group (`vendor_group_assignments`)

**Reads:** `tally_stock_items`, `vendor_group_assignments`, `tally_voucher_inventory_entries` (last-bought)
**Writes:** `order_groups`, `vendor_group_assignments`

### 8.3 Discounts (`/discounts`)
- Voucher picker (Sales / Delivery Note tabs)
- Selected voucher → group-wise discount breakdown
- Per-line discount override (inline edit)
- Custom colors per category (live from `category_colors`)

**Reads:** `tally_vouchers`, `tally_voucher_inventory_entries`, `discount_rules`, `category_colors`, `item_category_overrides`
**Writes:** none (overrides are session-only — same as Electron)

### 8.4 Discount Rules (`/discounts/rules`)
- Tabs: Tiers | Item Assignments
- Add / edit / delete categories
- Edit tier breakpoints (min qty, max qty, discount %)
- Color picker per category (writes `category_colors`)
- Item → category override search + reassign (writes `item_category_overrides`)
- Import/Export JSON (round-trip via `app_users.id` as scope)

**Reads/Writes:** `discount_rules`, `item_category_overrides`, `category_colors`

### 8.5 Price List (`/price-list`)
- Sortable, filterable, searchable table of all items
- Columns: name, group, GST%, opening rate, Tally rate (dealer), recommended rate
- Expandable row: full dealer-price-list history
- Upload Tally JSON → writes `tally_price_list_imports`
- Edit rate inline → writes `rate_overrides`

### 8.6 Price List Correction (`/price-list/correction`)
- Auto-suggestions where Tally opening rate diverges from recent sales rate
- "Apply recommended" button per row → writes `rate_overrides`

### 8.7 Invoices (`/invoices`)
- Filter by date, voucher type (Sales / Delivery Note / Purchase / Receipt / Payment / Journal), party
- Click row → drawer with full voucher (header + ledger entries + inventory entries)

**Reads only:** `tally_vouchers` + `tally_voucher_*_entries`

### 8.8 Ledgers (`/ledgers`)
- Sortable list of parties with outstanding balance + last-transacted date
- Click → party detail page with transaction history + aging buckets

### 8.9 Pending Orders (`/pending-orders`)
- All Delivery Notes not yet billed (Sales Invoice with same items)
- Group by party
- Click → "Delivery Note Modal" (reuse Electron's `DNModal` design verbatim)

### 8.10 Alerts (`/alerts`)
- Auto-derived: stock running low, overdue receivable, idle party (no order in 30d), price drift detected
- Snooze / dismiss → writes to a new `alert_dismissals` table

### 8.11 Outreach (`/outreach`)
- **Mobile-first.** Bottom tabs: Today | Pending | Called | History
- Per-party card: phone (tel: link), suggested items (computed from purchase cadence), note
- Swipe right → mark called
- One-tap copy of suggested order text to clipboard for WhatsApp paste

**Reads:** `tally_vouchers`, `tally_ledgers`, `calling_list_entries`
**Writes:** `calling_list_entries`

### 8.12 Reports (`/reports`)
- Tabs: Financial Health | Sales Analysis | Inventory | Party Concentration
- Monthly revenue vs purchases chart
- Drill-down: click bar → voucher list for that month
- Date range picker (last 30d / 90d / FY / custom)

### 8.13 Calendar (`/calendar`)
- Visual calendar of scheduled / planned deliveries
- Drag-drop a pending order onto a date → writes scheduled date

### 8.14 Routes (`/routes`)
- Leaflet map of all parties (geocoded from address — needs geocoding step)
- Color by vendor group / by recency / by outstanding
- Click pin → party info popup

### 8.15 Settings (`/settings`)
- Team: invite / remove users (owner only)
- Sync history: read-only feed from `tally_sync_history`
- Preferences: default landing page, sidebar collapsed by default
- Theme toggle (light only for v1)

---

## 9. Sync Boundary with Electron

| Action | Origin | Sync direction |
|---|---|---|
| Tally XML imported | Electron only | Electron → Supabase. Web reads. |
| Discount rule edited | Either | Last-write-wins via `updated_at`. Both clients see updates. |
| Order group created | Either | Same. |
| Vendor group reassigned | Either | Same. |
| Push to Tally | Electron only | Web disabled / "Open in desktop app" CTA. |

**Conflict resolution:** Use Supabase's built-in `updated_at` column on every config table — last write wins. Real-time sub on each page broadcasts changes to other connected clients.

---

## 10. Phases / Roadmap

### Phase 1 — Foundation (Week 1-2)
- Next.js scaffolding, Tailwind + tokens copied from `src/index.css`
- Supabase client wired with anon key
- Auth (magic link + Google) + `app_users` provisioning by owner
- New RLS policies for authenticated reads on all tables
- `/` Dashboard with 4 KPIs proving the read pipeline works

### Phase 2 — Read-only views (Week 3-4)
- Invoices, Ledgers, Pending Orders, Price List (read), Reports (read)
- TanStack Query for server-state caching
- Mobile bottom-nav layout

### Phase 3 — Config editing (Week 5-7)
- Discount Rules (with color picker)
- Order Groups (with multi-select item assignment)
- Vendor Groups
- Unit / Rate Overrides
- Audit log on every write

### Phase 4 — Outreach + mobile polish (Week 8)
- Calling list with mobile-first UX
- WhatsApp share buttons
- Phone tel: links

### Phase 5 — Real-time + Alerts (Week 9)
- Supabase Realtime subscriptions
- Auto-generated alerts (cron job in Supabase Edge Functions)

### Phase 6 — Beta (Week 10)
- Invite 3 real users (owner, manager, sales)
- Telemetry: Vercel Analytics, Supabase logs
- Iterate

---

## 11. Success Metrics

| Metric | Target by month 3 |
|---|---|
| Active users / week | 5 |
| Edits per week (any config table) | 50+ |
| Mobile session % (outreach) | >40% |
| Dashboard p95 load time | <2s |
| Real-time event latency | <500ms |
| Zero data-loss incidents | 100% |

---

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Leaked service key** in `supabaseSync.ts:13-14` exposes everything via service role | Rotate before web app deploys; never ship service key to browser. |
| **RLS bugs leak cross-company data** | Add automated tests: spawn 2 test users in different companies, assert each can't see the other's rows. |
| **Real-time floods** when multiple users edit | Debounce inbound events client-side; rate-limit at Supabase. |
| **Tally-sync lag** — web shows stale data when Electron hasn't synced | Show last-sync timestamp prominently; cron-trigger sync reminder if >12hrs. |
| **Mobile data costs** (field sales on cellular) | Aggressive caching via TanStack; SWR for stable lists. |
| **Tally items deleted but referenced** in `order_groups.item_ids` etc. | Periodic cleanup edge function; show "missing item" gracefully in UI. |
| **Schema drift** between Electron and web | Both clients import generated types from `supabase gen types typescript` — one source of truth. |

---

## 13. Open Questions

1. **Domain?** `app.mkcycles.in`? `dashboard.mkcycles.in`?
2. **Multi-tenant?** Currently hardcoded to `"M.K.CYCLES (P) LTD."` — should `app_users.company` open the door to other companies' staff using the same deployment, or stay single-tenant?
3. **Tally push from web** via webhook to a long-running Electron instance — out of scope, but worth noting as v2.
4. **Notification channel for alerts** — email? push? WhatsApp? (Affects Phase 5 scope.)
5. **Geocoding budget** for the Routes page (Google / Mapbox / OSM Nominatim free).

---

## 14. Appendix — Reusable Assets from Electron App

These files / patterns transfer directly to the web build with little or no change:

| Asset | Why reusable |
|---|---|
| `src/index.css` — design tokens + utility classes | Tailwind classes are framework-agnostic |
| `src/components/KPICard.tsx` | Pure component, no Electron-specific APIs |
| `src/components/ColorPicker.tsx` | Pure |
| `src/engine/discounts.ts` — discount calculation engine | Pure TS, no DOM |
| `src/utils/format.ts` — INR/date formatters | Pure |
| `src/utils/gstInference.ts` | Pure |
| Discount tier shapes, OrderLine, etc. | Type definitions are portable |

**NOT reusable:**
- IndexedDB layer (`src/db/idb.ts`) — replace with Supabase queries
- Electron preload bridge (`window.electronAPI.*`) — drop entirely
- Tally XML parser & Tally HTTP client — stays in Electron
- `usePerfMonitor` / `usePersistenceMonitor` — replace with Vercel Analytics

---

## 15. Acceptance Criteria for v1 Launch

- [ ] All 11 routes from §7.1 render with real data
- [ ] Owner can create/invite a second user; that user can log in and see only their permitted pages
- [ ] An edit made in the web app appears in the Electron app within 5 seconds (and vice versa)
- [ ] Calling-list page works on iPhone Safari, Android Chrome (tested on real devices)
- [ ] No service-role key in browser bundle (verify via build inspection)
- [ ] Cross-company RLS test passes
- [ ] Lighthouse score >85 on Dashboard
- [ ] Audit log captures every config-table write with user_id + timestamp + before/after
