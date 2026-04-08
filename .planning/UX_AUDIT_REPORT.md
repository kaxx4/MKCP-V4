# MKCP Dashboard -- Comprehensive UX Audit Report

**Auditor:** UX Research Analysis
**Date:** 2026-03-21
**Branch:** TALLYLIVE
**Scope:** Full frontend codebase (React + Vite + Tailwind)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Usability Issues](#2-usability-issues)
3. [Sizing Issues](#3-sizing-issues)
4. [Color Issues](#4-color-issues)
5. [Anti-Patterns & UX Violations](#5-anti-patterns--ux-violations)
6. [Navigation & Information Architecture](#6-navigation--information-architecture)
7. [Error Handling & Feedback](#7-error-handling--feedback)
8. [Responsive Design](#8-responsive-design)
9. [Form UX](#9-form-ux)
10. [Data Presentation](#10-data-presentation)
11. [Cognitive Load](#11-cognitive-load)
12. [Page-by-Page Findings](#12-page-by-page-findings)
13. [Component Findings](#13-component-findings)
14. [Priority Matrix](#14-priority-matrix)

---

## 1. Executive Summary

The MKCP Dashboard is a feature-rich Tally integration tool with strong foundations: a well-organized design system in `index.css`, solid accessibility basics (skip-to-content, ARIA labels, focus-visible rings), and consistent use of design tokens. However, the audit reveals **12 Critical**, **28 Major**, and **35+ Minor** issues across usability, sizing, color consistency, responsive design, and cognitive load.

**Key Themes:**
- Inconsistent styling approaches (design system classes vs. inline Tailwind vs. raw CSS tokens)
- Several pages have high cognitive load with too many controls visible at once
- Mobile experience is significantly degraded on complex pages (Orders, Reports)
- Missing confirmation dialogs for destructive actions
- Color semantics are sometimes contradictory (e.g., green used for both "Debit" and "success")
- The Reports page with 18 tabs is overwhelming
- Form validation feedback is inconsistent across pages

---

## 2. Usability Issues

### CRITICAL

**U-01: Orders page -- useRef inside render function body (line ~943)**
- `useRef` is called inside a render callback `(() => { ... })()`, which violates React's Rules of Hooks
- This can cause unpredictable behavior, stale refs, or crashes
- **File:** `src/pages/Orders.tsx`, line 943
- **Severity:** Critical

**U-02: Orders page -- useVirtualizer called inside render callback (line ~613)**
- `useVirtualizer` hook is called inside `(() => { ... })()` render function
- Hooks must be called at the top level of a component, not inside callbacks
- **File:** `src/pages/Orders.tsx`, lines 613 and 944
- **Severity:** Critical

**U-03: No confirmation before clearing all order items**
- The clear button (trash icon) in Orders page wipes the entire order with a single click
- No undo mechanism or confirmation dialog
- **File:** `src/pages/Orders.tsx`, line 931 (`onClick={clearAll}`)
- **Severity:** Critical

**U-04: Tally push has no confirmation dialog**
- "Push to Tally" button in Sales page sends data to an external system without any confirmation
- This is an irreversible action affecting real accounting data
- **File:** `src/pages/Sales.tsx`, lines 529-540
- **Severity:** Critical

### MAJOR

**U-05: Search input in Orders does not indicate result count**
- After filtering, there is no text like "Showing 42 of 559 items"
- Users cannot tell if their search returned 0 results or the list is loading
- **File:** `src/pages/Orders.tsx`, line 566-573
- **Severity:** Major

**U-06: No visual distinction between CSV and XLSX export buttons**
- Both export buttons in Orders use identical `<Download>` icons at size 12
- Only differentiated by tooltip (title attribute)
- **File:** `src/pages/Orders.tsx`, lines 925-929
- **Severity:** Major

**U-07: "Accept & Continue to Orders" button color is misleading**
- Uses `bg-success hover:bg-success/80` which looks like a success indicator, not an action button
- Could be confused with a completed state rather than an actionable button
- **File:** `src/pages/Import.tsx`, line 1293
- **Severity:** Major

**U-08: Movement modal has no close-on-Escape support**
- The movement transaction modal in Orders uses `onClick` on overlay to close but lacks keyboard Escape handler
- **File:** `src/pages/Orders.tsx`, line 851
- **Severity:** Major

**U-09: Delete group uses browser `confirm()` instead of styled dialog**
- `confirm()` breaks the visual design language and is inaccessible
- **File:** `src/pages/Orders.tsx`, line 520
- **Severity:** Major

**U-10: Sales page has no empty state for Tally data**
- When tallyData is null/empty, selects show empty dropdowns with no explanation
- No guidance like "Import data first" appears
- **File:** `src/pages/Sales.tsx`, lines 266-272
- **Severity:** Major

**U-11: No loading indicator for initial data restore**
- App.tsx restores from IndexedDB on mount but shows no loading state
- Users see the LoadingFallback spinner but get no context on what is happening
- **File:** `src/App.tsx`, lines 46-83
- **Severity:** Major

### MINOR

**U-12:** Orders page h1 is `sr-only` -- users have no visible page title (line 390)
**U-13:** Ledger desktop h1 is `sr-only` -- inconsistent with other pages that show visible titles (line 179)
**U-14:** No breadcrumb or back navigation on detail views
**U-15:** Toast notifications auto-dismiss at 4s which may be too fast for error messages (Toast.tsx, line 23)
**U-16:** Order group color dots have no legend explaining what colors mean

---

## 3. Sizing Issues

### MAJOR

**S-01: KPI values may overflow on mobile**
- `.metric-value` is `text-3xl` (30px) with `truncate`
- Large INR values like "12,34,56,789" will be truncated on mobile, losing critical financial data
- **File:** `src/index.css`, line 176; `src/components/KPICard.tsx`, line 41-48
- **Severity:** Major

**S-02: Sales page title is oversized compared to design system**
- Uses `text-3xl md:text-4xl` while the design system `.page-title` is `text-4xl`
- Inconsistent with the global typography scale
- **File:** `src/pages/Sales.tsx`, line 277
- **Severity:** Major

**S-03: Movement modal table text is too small**
- Uses `text-xs` (12px) for financial data in a dense table
- Hard to read amounts and voucher numbers at this size
- **File:** `src/pages/Orders.tsx`, line 864
- **Severity:** Major

**S-04: Order entry right panel item names use text-xs**
- At 12px, item names with long Tally names are nearly illegible
- **File:** `src/pages/Orders.tsx`, line 973
- **Severity:** Major

### MINOR

**S-05:** Touch targets on mobile tab bar are at minimum (52px) but could be larger for fat-finger scenarios (NavBar.tsx, line 82)
**S-06:** Stock filter inputs are only `w-16` (64px) which is tight for numbers > 999 (Orders.tsx, line 601)
**S-07:** Chart Y-axis labels use 11px which is below WCAG recommended 12px minimum (Dashboard.tsx, line 239)
**S-08:** The Ledger desktop search input uses custom inline classes instead of the `search-input` design system class (Ledgers.tsx, line 186)
**S-09:** Report tab list with 18 items cannot fit without horizontal scrolling even on large screens

---

## 4. Color Issues

### CRITICAL

**C-01: Green used for both "Debit" and "success" -- contradictory semantics**
- In Ledgers page, debit amounts use `text-success` (green)
- In accounting, debits and credits are neutral -- using green for Dr and red for Cr implies "debit is good, credit is bad"
- This conflicts with the KPI cards where green means "positive trend"
- **Files:** `src/pages/Ledgers.tsx`, lines 106, 122, 163, 202, etc.
- **Severity:** Critical

**C-02: Inconsistent accent color opacity across components**
- `COLORS.accentBg` in NavBar uses `bg-accent/8` (8% opacity)
- Badge uses `bg-accent/10` (10%)
- Various components use `bg-accent/15`, `bg-accent/5`, `bg-accent/10` inconsistently
- This creates visual inconsistency in hover and active states
- **Files:** Multiple components
- **Severity:** Major (accumulative)

### MAJOR

**C-03: "Reset to Current FY" button uses non-standard color classes**
- `bg-warn/20 hover:bg-warn/30 text-warn` -- not using any button design system class
- This is a one-off style that could confuse the color hierarchy
- **File:** `src/pages/Import.tsx`, line 1074
- **Severity:** Major

**C-04: The `text-muted` class is undefined in the design system**
- Multiple pages use `text-muted`, `text-primary`, `text-danger`, `text-success`, `text-accent` etc.
- These appear to be Tailwind custom theme tokens but `text-muted` is not defined in `index.css`
- If these are from `tailwind.config`, they are a separate system from the CSS layer classes
- **Files:** All pages
- **Severity:** Major (consistency)

**C-05: Low stock color function returns bare Tailwind classes**
- `getStockColor()` returns `"text-danger"`, `"text-warn"`, `"text-success"` (Orders.tsx, line 345)
- These semantic colors may not meet WCAG AA contrast on the white item list background
- No contrast verification for warn-on-white specifically
- **File:** `src/pages/Orders.tsx`, lines 345-351
- **Severity:** Major

### MINOR

**C-06:** Chart tooltip uses hardcoded hex colors instead of CSS variables (Dashboard.tsx, line 19-27)
**C-07:** Orders chart uses different color palette from Dashboard charts (`#10b981` vs `CHART_COLORS.green = #16a34a`) -- inconsistent greens
**C-08:** Error card uses `text-primary` for the title which conflicts with its danger context (ErrorCard.tsx, line 17)

---

## 5. Anti-Patterns & UX Violations

### CRITICAL

**AP-01: Hooks called inside render callbacks (React Rules of Hooks violation)**
- Already documented as U-01/U-02 but warrants emphasis
- `useVirtualizer` and `useRef` inside `(() => { ... })()` IIFE in render
- **File:** `src/pages/Orders.tsx`, lines 613, 943
- **Severity:** Critical

### MAJOR

**AP-02: Overuse of `!important`-style overrides via `!` prefix**
- Multiple uses of `!p-0`, `!rounded-b-none`, `!mb-0`, `!p-4` to override design system classes
- This indicates the design system classes are not flexible enough, leading to "escape hatch" abuse
- **Files:** `src/pages/Orders.tsx` (lines 393, 557, 735, etc.), `src/pages/Ledgers.tsx` (lines 143, 181)
- **Severity:** Major

**AP-03: Mixed styling paradigms**
- Some components use design system classes (`.btn-primary`, `.card`, `.form-input`)
- Others use raw Tailwind (`bg-bg border border-bg-border rounded-lg pl-8 pr-3 py-1.5 text-sm`)
- Some use inline styles
- This makes maintenance difficult and appearance inconsistent
- **Files:** `src/pages/Ledgers.tsx` (line 186 vs. line 148), Orders.tsx throughout
- **Severity:** Major

**AP-04: CSS class `card-standard` and `card-premium` used in Sales.tsx but not defined in index.css**
- `card-standard` (line 282) and `card-premium` (line 457) are not in the design system
- Either these are defined elsewhere or they produce no styling
- **File:** `src/pages/Sales.tsx`, lines 282, 457
- **Severity:** Major

**AP-05: `font-mono` used for financial amounts in Sales but design system uses `tabular-nums`**
- The design system specifically chose `tabular-nums` over `font-mono` for number alignment
- Sales page reverts to `font-mono` on rate and amount columns (lines 407, 413)
- **File:** `src/pages/Sales.tsx`, lines 407, 413
- **Severity:** Minor

### MINOR

**AP-06:** Using Unicode "x" character instead of icon for remove button in Sales (line 421)
**AP-07:** `bg-bg-border`, `bg-bg-card`, `bg-bg`, `border-bg-border` tokens used extensively but not defined in index.css -- must be in Tailwind config, creating a hidden dependency
**AP-08:** Multiple pages re-implement empty states with slightly different markup instead of using a shared component

---

## 6. Navigation & Information Architecture

### MAJOR

**N-01: "Sales" page is not in the NavBar navigation**
- NAV_ITEMS in NavBar.tsx (line 37-46) does not include a link to `/sales`
- Users can only reach Sales if they know the URL or it is linked from elsewhere
- **File:** `src/components/NavBar.tsx`, lines 37-46; `src/App.tsx`, line 94
- **Severity:** Critical

**N-02: Reports page has 18 tabs -- information overload**
- TABS array contains 18 items: Inventory, Sales Trend, Top Items, Turnover, Predictions, Purchase Orders, Calendar, ABC-XYZ, Period Compare, Margins, GST Summary, Balance Sheet, Advance Tax, Financial HQ, Cashflow Intel, Ledger Intel, Tax Radar, Business Intel
- This exceeds cognitive processing limits (Miller's Law: 7 +/- 2)
- Should be grouped into categories or use a sub-navigation pattern
- **File:** `src/pages/Reports.tsx`, line 28
- **Severity:** Major

**N-03: "Edit Units" is a confusing nav label**
- Most users would not understand what "Edit Units" means without context
- Better: "Unit Settings" or "Item Units"
- **File:** `src/components/NavBar.tsx`, line 44
- **Severity:** Minor

**N-04: No route for stock summary despite references**
- The user's request mentions `StockSummary.tsx` but no such page is in the routes
- Stock data is scattered across Dashboard, Orders, Alerts, and Reports
- **Severity:** Minor

**N-05: Mobile bottom nav shows only 5 items, hiding 3 behind "More"**
- The overflow items (Reports, Edit Units, Settings) are important power-user features
- Reports especially should be in the primary nav
- **File:** `src/components/NavBar.tsx`, lines 48-49
- **Severity:** Minor

### MINOR

**N-06:** Sidebar collapsed state shows only icons -- no tooltips appear on hover for icon-only mode
**N-07:** Tally connection status link at bottom of sidebar always navigates to /import, even when already on /import

---

## 7. Error Handling & Feedback

### MAJOR

**E-01: ErrorBoundary exists but no per-page error handling**
- If a single page component throws, the entire app shows the error boundary
- Individual pages should catch and display errors locally
- **File:** `src/App.tsx`, line 109
- **Severity:** Major

**E-02: Import page silently fails on malformed JSON**
- The UTF-16 fallback in `runImport()` can still throw with no user-friendly message
- Error ends up in `addLog()` which requires scrolling to the debug log
- **File:** `src/pages/Import.tsx`, lines 660-668
- **Severity:** Major

**E-03: Loading state for "Loading invoice..." has no styling**
- Plain `<div className="p-6">Loading invoice...</div>` with no spinner or design system class
- **File:** `src/pages/Sales.tsx`, line 263
- **Severity:** Major

**E-04: No loading states shown during data computations**
- Dashboard and Reports perform heavy `useMemo` computations but show no loading indicator
- Users may see a frozen/unresponsive UI during computation
- **Severity:** Major

### MINOR

**E-05:** Toast z-index (z-50) may conflict with modal overlays which also use z-50 (Toast.tsx, line 29)
**E-06:** Debug log in Import page uses checkmark/warning emojis that may not render on all systems
**E-07:** No network error detection or retry UI when Tally proxy is unreachable during sync
**E-08:** Quantity input in Sales allows 0 and negative values -- the `min="0"` attribute does not prevent typing negative numbers (Sales.tsx, line 399)

---

## 8. Responsive Design

### CRITICAL

**R-01: Orders page is nearly unusable on mobile**
- Three-panel layout with tab switching between "Items", "Detail", and "Order"
- Loses all context when switching tabs -- user cannot see list and detail simultaneously
- The order entry panel shows truncated item names at text-xs
- **File:** `src/pages/Orders.tsx`, lines 538-554
- **Severity:** Critical

### MAJOR

**R-02: Import page drop zones use `grid-cols-2` on all screen sizes**
- On mobile, two drop zones side by side are too narrow to show file names
- Should stack vertically on mobile
- **File:** `src/pages/Import.tsx`, line 1142
- **Severity:** Major

**R-03: Dashboard AR/AP cards use `grid-cols-2` on all sizes**
- On very narrow screens (<320px), these cards can overlap or truncate amounts
- No `grid-cols-1` breakpoint for smallest screens
- **File:** `src/pages/Dashboard.tsx`, line 190
- **Severity:** Major

**R-04: Sales page header grid does not stack well on mobile**
- `grid-cols-1 md:grid-cols-3` -- good, but the items table uses text-sm with 6 columns
- On mobile, the table requires horizontal scrolling
- **File:** `src/pages/Sales.tsx`, lines 365-429
- **Severity:** Major

**R-05: Ledger desktop uses fixed `w-80` for sidebar**
- On medium-width screens (768px-1024px), 320px sidebar + detail area is cramped
- Should use relative widths or responsive breakpoint
- **File:** `src/pages/Ledgers.tsx`, line 181
- **Severity:** Major

### MINOR

**R-06:** Low stock items in Dashboard hide "Stock: X" badge on mobile (`hidden sm:inline-flex`) -- removes useful information (Dashboard.tsx, line 307)
**R-07:** Movement modal is full-screen on mobile with no padding -- feels like a different app (Orders.tsx, line 852)
**R-08:** Chart height is fixed at 200px regardless of screen size (Dashboard.tsx, line 235)

---

## 9. Form UX

### MAJOR

**F-01: Select dropdowns with hundreds of items have no search/filter**
- Party selection in Sales has all Customer-type ledgers in a native `<select>`
- Item selection dropdown has all available items
- With 500+ items, scrolling a native dropdown is terrible UX
- Needs a searchable combobox/autocomplete component
- **File:** `src/pages/Sales.tsx`, lines 285-296 (party), 433-444 (items)
- **Severity:** Critical

**F-02: No input validation for date fields in Import page**
- Users can set FY From Date after FY To Date
- The UI warns about it but does not prevent submission
- **File:** `src/pages/Import.tsx`, lines 1032-1061
- **Severity:** Major

**F-03: Company name input has no autocomplete/suggestions**
- Must match EXACTLY as shown in TallyPrime -- this is error-prone
- Auto-detect button helps but should be the primary path, not secondary
- **File:** `src/pages/Import.tsx`, lines 996-1029
- **Severity:** Major

**F-04: Order quantity input has no unit label visible next to it**
- The order quantity input in the right panel of Orders has no indication of which unit (base/pkg) is active
- Users must remember which unit mode they selected in the header
- **File:** `src/pages/Orders.tsx`, line 977
- **Severity:** Major

**F-05: Sales quantity input lacks step validation**
- `step="0.01"` allows decimals, but some units (Nos, Pcs) should only allow integers
- **File:** `src/pages/Sales.tsx`, line 401
- **Severity:** Minor

### MINOR

**F-06:** Import page "FY From Date" and "FY To Date" labels do not use `htmlFor` to associate with inputs
**F-07:** Form labels in Sales page use `form-label` class but no `htmlFor` association
**F-08:** Search inputs have placeholder text but no visible label -- screen readers rely on placeholder which disappears on focus

---

## 10. Data Presentation

### MAJOR

**D-01: KPI values use `truncate` which can hide financial data**
- A value like "12,34,56,789.00" being truncated to "12,34,5..." loses meaning
- Should use responsive font sizing or text wrapping instead
- **File:** `src/components/KPICard.tsx`, line 42
- **Severity:** Major

**D-02: No pagination on Ledger transaction list**
- A ledger with thousands of transactions renders all at once
- Desktop table and mobile card list both lack virtualization
- **File:** `src/pages/Ledgers.tsx`, lines 244-274 (desktop), 114-131 (mobile)
- **Severity:** Major

**D-03: Chart axis labels are abbreviated without explanation**
- Y-axis shows "19L" format meaning "19 Lakhs" -- no legend or tooltip explaining the abbreviation
- Users unfamiliar with Indian numbering may not understand
- **File:** `src/pages/Dashboard.tsx`, line 239
- **Severity:** Minor

**D-04: "Top Items" chart truncates item names to 20 characters**
- Long item names become "CHAIN SET HEAVY DU..." which loses meaning
- Tooltip should show full name
- **File:** `src/pages/Dashboard.tsx`, line 115
- **Severity:** Minor

**D-05: Monthly table in Orders shows all months with equal visual weight**
- No visual emphasis on the most recent/current month
- Makes it hard to find "this month's" data quickly
- **File:** `src/pages/Orders.tsx`, lines 747-775
- **Severity:** Minor

### MINOR

**D-06:** Invoice aging colors are inconsistent with the badge system (Invoices.tsx, line 44-48)
**D-07:** Opening balance row in Ledger table uses `colSpan={3}` which misaligns with header columns
**D-08:** Low stock "Reorder" badge values show decimal places for whole numbers (Dashboard.tsx, line 316)

---

## 11. Cognitive Load

### CRITICAL

**CL-01: Reports page presents 18 tabs with no grouping**
- Users must scan all 18 tab labels to find what they need
- No categorization (e.g., "Financial", "Inventory", "Tax", "Intelligence")
- The tab list requires horizontal scrolling
- **File:** `src/pages/Reports.tsx`, line 28
- **Severity:** Critical

### MAJOR

**CL-02: Import page has too many sync options visible simultaneously**
- Primary: "Import All from Tally"
- Secondary row: "Masters Only", "Vouchers Only", "Incremental Sync"
- Plus: Sync mode radio (Monthly/Weekly/Daily), date pickers, company name, auto-detect
- New users will be overwhelmed
- **File:** `src/pages/Import.tsx`, lines 1097-1133
- **Severity:** Major

**CL-03: Orders page has 15+ state variables creating complex interaction model**
- Search, group filter, stock filter, selected item, order quantity, focused item, mobile tab, month span, movement modal, chart toggle, group panel -- all simultaneously active
- **File:** `src/pages/Orders.tsx`, lines 48-63
- **Severity:** Major

**CL-04: Dashboard shows all KPIs, charts, and alerts on a single scroll**
- No progressive disclosure -- everything loads and renders at once
- Could benefit from collapsible sections or "show more" patterns
- **File:** `src/pages/Dashboard.tsx`, lines 154-325
- **Severity:** Minor

### MINOR

**CL-05:** Order groups panel adds another layer of complexity to an already complex Orders page
**CL-06:** The "Cover Months" setting in Orders affects calculations but is buried in UI store, not visible on the page
**CL-07:** Unit toggle affects all pages globally but there is no persistent indicator of which mode is active

---

## 12. Page-by-Page Findings

### App.tsx
| ID | Issue | Severity |
|----|-------|----------|
| APP-01 | Root redirect logic `data ? "/orders" : "/import"` -- should go to `/dashboard` if data exists | Minor |
| APP-02 | No 404 page -- wildcard redirects silently to `/` | Minor |
| APP-03 | Console.log statements with emojis in production code (lines 54, 56, 67) | Minor |

### NavBar.tsx
| ID | Issue | Severity |
|----|-------|----------|
| NAV-01 | `/sales` route not in nav items | Critical |
| NAV-02 | Mobile "More" overlay backdrop `role="button"` on a div -- should be semantic | Minor |
| NAV-03 | No tooltip on collapsed sidebar icons | Major |
| NAV-04 | Connection status always links to /import | Minor |

### Dashboard.tsx
| ID | Issue | Severity |
|----|-------|----------|
| DASH-01 | No loading skeleton while KPIs compute | Major |
| DASH-02 | Click handlers on AR/AP cards have no keyboard support (`onClick` on div, no `onKeyDown`, no `role="button"`, no `tabIndex`) | Major |
| DASH-03 | Empty chart state "No sales this period" could suggest the item filter, not just show text | Minor |
| DASH-04 | Low stock items are clickable but have no focus indicator or keyboard support | Major |

### Orders.tsx
| ID | Issue | Severity |
|----|-------|----------|
| ORD-01 | React hooks called inside render callbacks | Critical |
| ORD-02 | 15+ state variables -- needs decomposition into sub-components | Major |
| ORD-03 | No visible page title | Major |
| ORD-04 | Export buttons visually identical | Major |
| ORD-05 | Clear all has no confirmation | Critical |
| ORD-06 | Movement modal lacks keyboard close | Major |

### Sales.tsx
| ID | Issue | Severity |
|----|-------|----------|
| SAL-01 | Native selects with 500+ items | Critical |
| SAL-02 | Push to Tally has no confirmation | Critical |
| SAL-03 | Uses undefined CSS classes (card-standard, card-premium) | Major |
| SAL-04 | Uses font-mono instead of design system tabular-nums | Minor |
| SAL-05 | No empty state guidance when Tally data not loaded | Major |
| SAL-06 | Loading state is unstyled plain text | Major |

### Import.tsx
| ID | Issue | Severity |
|----|-------|----------|
| IMP-01 | Drop zones do not stack on mobile | Major |
| IMP-02 | Too many sync options visible at once | Major |
| IMP-03 | Date validation is advisory only, not enforced | Major |
| IMP-04 | Debug log uses emojis for status indicators | Minor |
| IMP-05 | Accept button color mimics "completed" state | Major |

### Ledgers.tsx
| ID | Issue | Severity |
|----|-------|----------|
| LED-01 | Desktop search uses inline styles instead of design system classes | Major |
| LED-02 | Debit = green, Credit = red color semantics are misleading | Critical |
| LED-03 | No virtualization on transaction list | Major |
| LED-04 | Mobile and desktop versions have different input styling | Minor |

### Invoices.tsx
| ID | Issue | Severity |
|----|-------|----------|
| INV-01 | Missing visible page title on mobile | Minor |
| INV-02 | Export button in page header has no label text, just icon | Minor |

### Reports.tsx
| ID | Issue | Severity |
|----|-------|----------|
| RPT-01 | 18 tabs with no grouping | Critical |
| RPT-02 | 20+ state variables at component top level | Major |
| RPT-03 | Sub-report pages imported but large combined bundle | Minor |

### Alerts.tsx
| ID | Issue | Severity |
|----|-------|----------|
| ALT-01 | Virtualized list is good | Positive |
| ALT-02 | "Add to Order" feedback is limited to a Set tracker -- no visual toast | Minor |

### Settings.tsx
| ID | Issue | Severity |
|----|-------|----------|
| SET-01 | Page is a power-user page with many destructive actions | Minor |
| SET-02 | Backup restore uses two-click confirm which is good | Positive |

### Edit.tsx
| ID | Issue | Severity |
|----|-------|----------|
| EDT-01 | Dirty count tracking is good UX | Positive |
| EDT-02 | No indication of which fields are editable vs. read-only | Minor |

---

## 13. Component Findings

### KPICard.tsx
| ID | Issue | Severity |
|----|-------|----------|
| KPI-01 | Good: Uses semantic `<article>`, `<h3>`, `aria-label` | Positive |
| KPI-02 | Value truncation can hide financial data | Major |
| KPI-03 | No responsive font sizing for values | Minor |

### KPISkeleton.tsx
| ID | Issue | Severity |
|----|-------|----------|
| SKL-01 | Good: Matches KPICard structure | Positive |
| SKL-02 | Not actually used by Dashboard -- Dashboard has no loading state | Major |

### ErrorCard.tsx
| ID | Issue | Severity |
|----|-------|----------|
| ERR-01 | Good: Retry button available | Positive |
| ERR-02 | Not used by any page currently | Minor |

### Toast.tsx
| ID | Issue | Severity |
|----|-------|----------|
| TST-01 | Good: ARIA role="alert", dismiss button | Positive |
| TST-02 | Auto-dismiss at 4s may be too fast for error toasts | Minor |
| TST-03 | z-50 may conflict with modals | Minor |

### Layout.tsx
| ID | Issue | Severity |
|----|-------|----------|
| LAY-01 | Good: Skip-to-content link | Positive |
| LAY-02 | Good: Responsive margin handling | Positive |
| LAY-03 | Mobile breakpoint at 767px -- consider 640px for small phones | Minor |

### index.css (Design System)
| ID | Issue | Severity |
|----|-------|----------|
| CSS-01 | Good: Comprehensive component classes, well-organized | Positive |
| CSS-02 | Good: prefers-reduced-motion handling | Positive |
| CSS-03 | Good: Focus-visible styling | Positive |
| CSS-04 | Missing: No dark mode support (by design per memory) | N/A |
| CSS-05 | Some classes defined but unused (tooltip, progress-bar) | Minor |
| CSS-06 | `text-2xs` class used in NavBar but not standard Tailwind -- must be custom | Minor |

---

## 14. Priority Matrix

### Must Fix (Before Next Release)
1. **N-01:** Add `/sales` to NavBar navigation
2. **AP-01/U-01/U-02:** Extract hooks from render callbacks in Orders.tsx
3. **U-03:** Add confirmation dialog for clearing all order items
4. **U-04:** Add confirmation dialog for Push to Tally
5. **F-01:** Replace native selects with searchable combobox in Sales page
6. **C-01:** Fix debit/credit color semantics in Ledgers (use neutral blue/orange or just labels)

### Should Fix (Next Sprint)
7. **CL-01/RPT-01:** Group the 18 Reports tabs into categories
8. **S-01/D-01:** Handle KPI value overflow with responsive sizing instead of truncation
9. **R-01:** Improve mobile Orders experience (consider single-column flow)
10. **CL-02:** Progressive disclosure for Import sync options (show "Advanced" for individual syncs)
11. **DASH-02/DASH-04:** Add keyboard support to clickable cards and list items
12. **E-03:** Style the Sales loading state with skeleton or spinner
13. **NAV-03:** Add tooltips to collapsed sidebar icons
14. **SAL-03:** Define or replace undefined CSS classes in Sales page
15. **LED-01/AP-03:** Standardize Ledger inputs to use design system classes

### Nice to Have (Backlog)
16. AP-02: Reduce `!` prefix overrides by adding flexible card variants
17. U-05: Show result count after search filtering
18. R-02: Stack import drop zones vertically on mobile
19. D-02: Add virtualization to Ledger transaction list
20. U-15: Increase toast duration for error messages to 6-8 seconds
21. CL-04: Add collapsible sections to Dashboard
22. S-09: Add tab categories or overflow handling for Reports

---

## Appendix: Positive Findings

The audit also identified strong UX patterns already in place:

1. **Design system is comprehensive** -- 25+ utility classes covering cards, buttons, forms, tables, badges, alerts, and more
2. **Accessibility basics are solid** -- skip-to-content, ARIA labels, focus-visible rings, reduced-motion support
3. **KPICard semantics** -- uses `<article>`, `<h3>`, proper aria-labels
4. **Toast system** -- well-implemented with ARIA, dismiss capability, and visual variety
5. **Skeleton loading component** exists (KPISkeleton.tsx) even though it is not yet widely used
6. **Error boundary** wraps the entire application
7. **Virtualized lists** in Orders and Alerts for performance
8. **Keyboard shortcuts** in Orders (Ctrl+F, /, Escape, arrow keys)
9. **Debounced search** prevents excessive re-renders
10. **Data persistence** with IndexedDB + backup system
11. **Empty states** with clear CTAs directing users to Import

---

*End of Audit Report*
