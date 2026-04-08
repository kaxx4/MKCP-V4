# UI Visual Consistency & Cohesion Audit

**Date**: 2026-03-21
**Branch**: TALLYLIVE
**Auditor**: Claude Opus 4.6 (Senior UI Design Audit)
**Scope**: All pages, components, design system CSS, tailwind config

---

## Executive Summary

The design system (index.css + tailwind.config.js) is well-architected with a comprehensive component library. However, **page-level adoption is inconsistent** -- the Dashboard page and shared components (KPICard, KPISkeleton, ErrorCard) fully leverage the design system, while the Sales page, Orders page, and several others bypass it entirely with ad-hoc inline Tailwind classes and undefined CSS classes. This creates a two-tier visual experience.

**Critical Finding**: The **Sales page** was built independently and uses CSS classes (`card-standard`, `card-premium`, `btn-accent`, `text-primary`, `text-muted`, `border-bg-border`, `bg-bg-hover`) that either do not exist in the design system or refer to raw Tailwind color aliases rather than the design system's component classes.

**Missing Feature**: The **Dashboard page has no period/date-range filter**. All data is computed from the full imported dataset with no ability to scope to a date range.

---

## Issue Index (45 Issues Found)

| Priority | Count | Category |
|----------|-------|----------|
| P0 Critical | 4 | Undefined CSS classes, broken styling |
| P1 High | 12 | Design system bypass, inconsistent patterns |
| P2 Medium | 18 | Spacing, color, typography inconsistencies |
| P3 Low | 11 | Minor polish, naming conventions |

---

## P0 CRITICAL -- Broken or Undefined Styles

### P0-1: Sales page uses undefined CSS class `card-standard`
- **File**: `src/pages/Sales.tsx`, lines 282, 365
- **What's wrong**: `card-standard` is not defined anywhere in `index.css` or tailwind config. This means these containers get **zero styling** -- no background, no border, no padding, no border-radius.
- **Fix**: Replace with `card` (the design system equivalent: white bg, rounded-xl, border, p-5/p-6)

### P0-2: Sales page uses undefined CSS class `card-premium`
- **File**: `src/pages/Sales.tsx`, line 457
- **What's wrong**: `card-premium` is not defined anywhere. The invoice summary section has no card styling.
- **Fix**: Replace with `card-elevated` or `card` from the design system

### P0-3: Sales page uses undefined CSS class `btn-accent`
- **File**: `src/pages/Sales.tsx`, line 532
- **What's wrong**: `btn-accent` is not defined in the design system. The "Push to Tally" button has only base inline styles, missing the full button treatment (min-height, padding, focus ring, disabled state).
- **Fix**: Replace with `btn-primary` (which is accent-colored) or create a proper `btn-accent` class in index.css

### P0-4: Missing Dashboard Period Filter
- **File**: `src/pages/Dashboard.tsx`
- **What's wrong**: The Dashboard has no date range or period filter. KPIs are always computed from the full dataset. Users cannot scope to "This Month", "Last Quarter", custom date range, etc.
- **Fix**: Add a period filter control in the page-header area (date range picker or quick presets like "This Month" / "Last Quarter" / "YTD" / "Custom"). Filter `data.vouchers` by date before computing KPIs, charts, and low stock alerts.

---

## P1 HIGH -- Design System Bypass / Inconsistent Patterns

### P1-1: Sales page bypasses entire design system
- **File**: `src/pages/Sales.tsx`
- **What's wrong**: Uses ad-hoc classes throughout instead of design system:
  - `text-primary` / `text-muted` (raw Tailwind color aliases) instead of `text-neutral-950` / `text-neutral-500`
  - `border-bg-border` / `bg-bg-hover` instead of `border-neutral-200` / `bg-neutral-50`
  - `text-3xl md:text-4xl font-bold text-primary` (line 277) instead of `page-title`
  - `text-xl font-semibold text-primary` (line 334) instead of `section-header`
  - `text-sm text-muted` (line 278) instead of `page-subtitle`
  - `form-label` on line 284 is correct, but other labels use ad-hoc `text-sm text-muted`
  - Table header uses `font-semibold` instead of the design system's `table-header` (which uses `font-medium uppercase tracking-wide text-neutral-500`)
- **Fix**: Migrate all Sales.tsx classes to use design system tokens consistently

### P1-2: Two competing color naming conventions
- **Files**: All pages
- **What's wrong**: The codebase uses TWO different color systems simultaneously:
  1. **Design system** (index.css): `text-neutral-950`, `text-neutral-500`, `bg-neutral-50`, `border-neutral-200`
  2. **Legacy aliases** (tailwind.config): `text-primary`, `text-muted`, `bg-bg`, `border-bg-border`, `bg-bg-card`, `bg-bg-hover`

  Dashboard.tsx uses the design system colors. Orders, Ledgers, Invoices, Import, Edit, Alerts, Settings, Reports all use the legacy aliases. This creates a maintenance burden and potential visual mismatches.
- **Fix**: Standardize on ONE naming convention. Recommend keeping the legacy aliases in tailwind.config for backward compatibility but documenting that new code should use `neutral-*` tokens.

### P1-3: Page title inconsistency across pages
- **Files**: Multiple
- **What's wrong**: Different pages use different patterns for the page title:
  - Dashboard: `page-title` class (correct)
  - Sales: `text-3xl md:text-4xl font-bold text-primary` (ad-hoc, and 4xl is larger than other pages)
  - Orders: `sr-only` (hidden entirely -- no visible h1)
  - Invoices: `page-title` class (correct)
  - Ledgers: `page-title` class (correct)
  - Edit: `page-title` class (correct)
  - Alerts: `page-title` class (correct)
  - Import: `page-title` class (correct)
  - Settings: `page-title flex items-center gap-3` with icon inline (inconsistent -- no other page puts an icon in the title)
- **Fix**: All pages should use `page-title` consistently. Orders needs a visible h1. Settings should remove the inline icon. Sales should use `page-title`.

### P1-4: Page wrapper pattern inconsistency
- **Files**: Multiple
- **What's wrong**: Different pages use different root containers:
  - Dashboard: `page-section` (correct, provides `space-y-8 md:space-y-10`)
  - Sales: `space-y-6 p-6` (ad-hoc)
  - Orders: `flex flex-col h-screen gap-0` (custom layout)
  - Invoices: `page-section` (correct)
  - Ledgers: custom flex layout
  - Edit: `flex flex-col h-[calc(100vh-112px)] gap-3`
  - Alerts: `flex flex-col h-[calc(100vh-112px)] gap-3 md:gap-4`
  - Import: `max-w-4xl mx-auto` (constrained width, no page-section)
  - Settings: `max-w-xl space-y-6` (constrained width)
  - Reports: `page-section` (correct)
- **Fix**: Pages that need full-height layouts (Orders, Ledgers, Alerts, Edit) are fine with custom containers. But Sales and Import should use `page-section` for consistent spacing. Sales has a manual `p-6` that competes with the Layout component's padding.

### P1-5: Inconsistent KPI card patterns
- **Files**: `Dashboard.tsx`, `Alerts.tsx`, `Invoices.tsx`
- **What's wrong**: Three different KPI rendering approaches:
  1. Dashboard: Uses `<KPICard>` component with `bento-grid` (correct)
  2. Alerts: Uses raw `bento-card` + manual `metric-value`/`metric-label` (skips KPICard)
  3. Invoices: Uses raw `bento-card` + manual `metric-value`/`metric-label` (skips KPICard)
  4. Sales summary: Uses undefined `card-premium` + ad-hoc `text-2xl font-bold`
- **Fix**: Use `<KPICard>` component everywhere. If bento-card + metric classes are needed for inline use, that's acceptable but should be documented as the alternative pattern.

### P1-6: Sales page table doesn't use design system table classes
- **File**: `src/pages/Sales.tsx`, lines 366-428
- **What's wrong**: Uses raw `<table className="w-full text-sm">` with ad-hoc header styling (`font-semibold`) instead of design system's `data-table`, `table-header`, `table-cell`, `responsive-table-row` classes.
- **Fix**: Apply `data-table` to table, `table-header` to th cells, `table-cell` to td cells, `responsive-table-row` to tr elements.

### P1-7: Inconsistent empty state styling
- **Files**: `Dashboard.tsx` vs `Ledgers.tsx`, `Invoices.tsx`, `Alerts.tsx`, `Edit.tsx`
- **What's wrong**: Dashboard empty state uses manual classes (`flex flex-col items-center...`) while other pages correctly use the `empty-state` design system class. Dashboard also uses `bg-muted-100` which is not a standard token.
- **Fix**: Dashboard should use `empty-state`, `empty-state-icon`, `empty-state-title`, `empty-state-description` classes.

### P1-8: Search input inconsistency in Ledgers desktop view
- **File**: `src/pages/Ledgers.tsx`, line 186
- **What's wrong**: Desktop ledger search uses raw inline classes (`w-full bg-bg border border-bg-border rounded-lg pl-8 pr-3 py-1.5 text-sm text-primary placeholder-muted outline-none`) instead of the `search-input` design system class used on the mobile view (line 148) and all other pages.
- **Fix**: Replace with `search-input pl-8` for consistency.

### P1-9: Select input inconsistency in Ledgers desktop view
- **File**: `src/pages/Ledgers.tsx`, line 189
- **What's wrong**: Desktop select uses raw inline classes (`w-full bg-bg border border-bg-border rounded-lg px-2 py-1.5 text-sm text-primary outline-none`) instead of the `form-select` design system class used on the mobile view (line 151) and all other pages.
- **Fix**: Replace with `form-select`.

### P1-10: Invoices filter buttons don't use design system tab/button classes
- **File**: `src/pages/Invoices.tsx`, lines 114-119
- **What's wrong**: Uses ad-hoc button styling (`px-2.5 md:px-3 py-1.5 rounded-lg text-xs md:text-sm transition`) with inline active state instead of the `tab-pill` / `tab-pill-active` or `filter-chip` / `filter-chip-active` design system classes.
- **Fix**: Use `filter-chip` and `filter-chip-active` classes.

### P1-11: Orders page delete button uses ad-hoc danger styling
- **File**: `src/pages/Orders.tsx`, line 521
- **What's wrong**: Delete button uses manual inline styles (`text-xs px-2 py-1 bg-danger/10 text-danger hover:bg-danger/20 rounded transition duration-150 ml-auto`) instead of a design system button class.
- **Fix**: Use `btn-ghost btn-sm text-danger hover:text-danger-700 hover:bg-danger/10` or create a `btn-danger-ghost` variant.

### P1-12: Sales page unit toggle buttons don't use design system
- **File**: `src/pages/Sales.tsx`, lines 338-358
- **What's wrong**: Custom toggle with raw `px-3 py-1 text-sm` and ad-hoc active styling. No border-radius on individual buttons. Uses `border-bg-border` (legacy alias).
- **Fix**: Use `tab-pill` / `tab-pill-active` or the existing `filter-chip` pattern.

---

## P2 MEDIUM -- Spacing, Color, Typography Issues

### P2-1: Gap inconsistency between pages
- **What's wrong**: Different gap values used for similar layouts:
  - Dashboard AR/AP cards: `gap-4 md:gap-5`
  - Dashboard chart row: `gap-5`
  - Alerts KPI grid: `gap-2 md:gap-3`
  - Invoices KPI grid: `gap-2 md:gap-3`
  - Sales form grid: `gap-4`
  - Sales summary: `gap-4 md:gap-6`
- **Fix**: Standardize: KPI grids should use `gap-4 md:gap-5` (or use the `bento-grid` class which handles this). Content sections should use `gap-5`.

### P2-2: `font-mono` used inconsistently for numerical data
- **Files**: `Sales.tsx` lines 407, 413; `Import.tsx` lines 1196, 1259, 1275, 1281, 1351
- **What's wrong**: Sales page uses `font-mono` for rates and amounts. But Dashboard, Alerts, Invoices, and Ledgers all use `tabular-nums` (from the design system's `metric-value` class) for numbers. `font-mono` changes the entire font appearance while `tabular-nums` only adjusts number spacing.
- **Fix**: Use `tabular-nums` for financial numbers (already set in `.metric-value`, `.table-cell-mono`). Reserve `font-mono` for code/log output only (like Import debug log).

### P2-3: Sales page subtitle pattern differs
- **File**: `src/pages/Sales.tsx`, line 278
- **What's wrong**: Uses `text-muted mt-2` instead of `page-subtitle` (which is `text-md text-neutral-600 mt-1`). The `mt-2` makes the gap slightly larger.
- **Fix**: Use `page-subtitle` class.

### P2-4: Validation status card in Sales uses different border-radius
- **File**: `src/pages/Sales.tsx`, line 479
- **What's wrong**: Uses `rounded-lg` (12px) while the design system's `alert` class uses `rounded-xl` (16px). Also doesn't use the `alert` / `alert-success` / `alert-danger` design system classes.
- **Fix**: Use `alert alert-success` or `alert alert-danger` classes.

### P2-5: Dashboard empty state icon uses non-standard color token
- **File**: `src/pages/Dashboard.tsx`, line 141
- **What's wrong**: Uses `bg-muted-100` which resolves to a gray from the muted palette. The design system's `empty-state-icon` class uses `text-neutral-300`. Also line 143 uses `text-muted-400`.
- **Fix**: Use `empty-state-icon` class or `text-neutral-300`.

### P2-6: Orders page header gap-0 creates cramped layout
- **File**: `src/pages/Orders.tsx`, line 388
- **What's wrong**: `gap-0` between the main content areas creates a visually cramped interface. Every other page has spacing between sections.
- **Fix**: Consider `gap-1` or `gap-2` minimum for visual breathing room, or use a border/divider.

### P2-7: Inconsistent padding in card-like containers
- **What's wrong**: Some pages add `!p-0` to override bento-card padding (Ledgers line 143, line 181, line 212; Orders line 540). This is a code smell -- if no padding is needed, use `section-card` with `section-card-body-flush` instead.
- **Fix**: Use `section-card` + `section-card-body-flush` for zero-padding cards.

### P2-8: Ledger detail header uses non-standard `card-title text-lg`
- **File**: `src/pages/Ledgers.tsx`, line 216
- **What's wrong**: `card-title text-lg` overrides the card-title size (14px) to 16px. The design system has `subsection-header` for 16px/600 headings.
- **Fix**: Use `subsection-header` instead.

### P2-9: Inconsistent action button alignment on page headers
- **Files**: Multiple
- **What's wrong**: Some pages put action buttons inline with the title (Invoices, Alerts, Edit), while Dashboard and Import put the subtitle below with no actions. Sales puts no header actions at all -- the action buttons are at the bottom.
- **Fix**: Standardize: all page headers should use `page-header-row` for title + actions side by side, with `page-subtitle` below.

### P2-10: Reports tab bar doesn't use design system `tab-list` / `tab-item`
- **File**: `src/pages/Reports.tsx`
- **What's wrong**: With 18 tabs, the Reports page likely uses a custom tab implementation. These should use the design system's `tab-list`, `tab-item`, `tab-item-active` classes for consistency.
- **Fix**: Verify and migrate to design system tab classes.

### P2-11: Settings Section component likely uses custom styling
- **File**: `src/pages/Settings.tsx`
- **What's wrong**: Uses a `<Section title="">` custom component. While this is fine architecturally, the sections should use `section-card` / `section-card-header` / `section-card-body` for visual consistency with the rest of the app.
- **Fix**: Verify Section component renders as `section-card` variant.

### P2-12: Inconsistent use of `text-success` vs `text-success-600`
- **Files**: `Dashboard.tsx` (uses `text-success-600`), `Ledgers.tsx` (mixes `text-success` and `text-success-600`), `Invoices.tsx` (uses both)
- **What's wrong**: `text-success` resolves to `#16a34a` (the DEFAULT). `text-success-600` resolves to `#15803d` (slightly darker). Mixing them creates subtle visual inconsistency.
- **Fix**: Standardize on `text-success-600` for text (better contrast) and `text-success` / `bg-success/10` for backgrounds/badges.

### P2-13: Inconsistent icon sizing in buttons
- **What's wrong**: Button icons vary between `size={12}`, `size={14}`, `size={16}`, `size={18}`, `size={20}` across pages.
  - `btn-sm` buttons: size={11} to size={14}
  - Regular buttons: size={16} to size={18}
  - Page header icons: size={20} to size={24}
- **Fix**: Standardize: `btn-sm` = 14px icons, regular buttons = 16px, `btn-lg` = 18px.

### P2-14: Alerts badge for "Reorder" severity uses wrong style
- **File**: `src/pages/Alerts.tsx`, line 171
- **What's wrong**: Reorder severity maps to `badge-muted` which is gray. Logically, a reorder alert should use `badge-info` or `badge` (accent blue) since it's actionable but not urgent.
- **Fix**: Use `badge` (accent) for Reorder severity, `badge-warn` for Low, `badge-danger` for Critical.

### P2-15: Sales page remove button uses emoji character
- **File**: `src/pages/Sales.tsx`, line 419
- **What's wrong**: Uses the Unicode character `X` for the remove button instead of a Lucide icon (all other pages use Lucide icons like `<Trash2>`, `<X>`, etc.). This breaks icon consistency.
- **Fix**: Use `<X size={14} />` or `<Trash2 size={14} />` from lucide-react.

### P2-16: Inconsistent border-radius on filter/toggle buttons
- **What's wrong**: Different border-radius values used for similar toggle/filter buttons:
  - Orders stock filter: `rounded-lg` (12px)
  - Orders mobile tab: `rounded-lg` (12px)
  - Invoices type filter: `rounded-lg` (12px)
  - Import tab switcher: `rounded-md` (8px) inside `rounded-lg` container
  - Alerts severity filter: likely varies
  - Design system `filter-chip`: `rounded-full` (9999px)
- **Fix**: Segmented controls/toggles should consistently use `rounded-lg`. Pill-style filters should use `rounded-full` via `filter-chip`.

### P2-17: Import page tab switcher is ad-hoc
- **File**: `src/pages/Import.tsx`, lines 885-897
- **What's wrong**: The Live/Upload tab switcher uses custom styling (`bg-bg-card border border-bg-border rounded-lg p-1` container + `rounded-md` buttons) instead of the design system's `tab-list`/`tab-item` or `tab-pills`/`tab-pill` classes.
- **Fix**: Use `tab-pills` or create a proper segmented control component.

### P2-18: Inconsistent height calc patterns
- **What's wrong**: Several pages use `h-[calc(100vh-112px)]` (Alerts, Edit, Ledgers) while Orders uses `h-screen`. The 112px offset presumably accounts for the Layout padding + navbar, but this is a magic number that will break if the layout changes.
- **Fix**: Consider using CSS variables or a shared constant for the layout offset. Alternatively, use `flex-1 min-h-0` within the Layout's flex container.

---

## P3 LOW -- Minor Polish Issues

### P3-1: `text-2xs` used in NavBar but may not be universally supported
- **File**: `src/components/NavBar.tsx`, lines 89, 100, 156, 227
- **What's wrong**: `text-2xs` is a custom size (11px) defined in tailwind.config but not in the design system's typography hierarchy (index.css). It works but is undocumented.
- **Fix**: Document `text-2xs` in the typography section or add a `.caption-mini` class.

### P3-2: ErrorCard uses `text-primary` and `text-muted` (legacy tokens)
- **File**: `src/components/ErrorCard.tsx`, lines 17-18
- **What's wrong**: Uses legacy color aliases instead of design system tokens. Also uses `bento-card` (backward compat alias for `card`).
- **Fix**: Use `text-neutral-900` and `text-neutral-500`. Use `card` instead of `bento-card`.

### P3-3: KPISkeleton uses `bento-card` instead of `card`
- **File**: `src/components/KPISkeleton.tsx`, line 5
- **What's wrong**: Uses backward-compatible alias `bento-card` instead of canonical `card`.
- **Fix**: Use `card` for new code. `bento-card` alias is fine functionally but inconsistent.

### P3-4: NavBar has hard-coded `w-[220px]` sidebar width
- **File**: `src/components/NavBar.tsx`, line 174
- **What's wrong**: Magic number. Should be a CSS variable or tailwind config value.
- **Fix**: Low priority, but adding `--sidebar-width: 220px` as a CSS variable would be cleaner.

### P3-5: Dashboard chart tooltip styles are inline JS objects
- **File**: `src/pages/Dashboard.tsx`, lines 29-32
- **What's wrong**: Chart tooltip styles are defined as JS objects with hard-coded values (#ffffff, #e5e5ea, etc.) instead of referencing the design system tokens.
- **Fix**: This is a Recharts limitation (requires inline styles). Consider extracting to a shared chart theme constant.

### P3-6: `disabled:opacity-50 disabled:cursor-not-allowed` repeated manually
- **Files**: `Settings.tsx` lines 345, 353, 384
- **What's wrong**: These disabled styles are already included in `btn-base` (which `btn-primary` and `btn-secondary` extend). The manual repetition suggests the author wasn't aware of the design system.
- **Fix**: Remove redundant `disabled:opacity-50 disabled:cursor-not-allowed` when using `btn-primary` or `btn-secondary`.

### P3-7: Orders page `bento-card !rounded-b-none !mb-0` overrides
- **File**: `src/pages/Orders.tsx`, line 393
- **What's wrong**: Using `!important` overrides on design system classes is a code smell. It suggests the card class doesn't fit the use case.
- **Fix**: Use a custom class or `section-card-header` pattern instead.

### P3-8: Some pages import `clsx`, others don't
- **What's wrong**: Minor inconsistency. Pages like Dashboard.tsx don't import `clsx` and use ternary expressions for conditional classes, while most other pages use `clsx`. Both work but the pattern should be consistent.
- **Fix**: Prefer `clsx` everywhere for readability.

### P3-9: Ledgers page text size uses `text-xs font-sans`
- **File**: `src/pages/Ledgers.tsx`, lines 160, 199
- **What's wrong**: Explicitly sets `font-sans` which is already the body default. Unnecessary class.
- **Fix**: Remove redundant `font-sans`.

### P3-10: Sales page `space-y-6 p-6` root wrapper
- **File**: `src/pages/Sales.tsx`, line 275
- **What's wrong**: Manual `p-6` padding likely conflicts with the Layout component's padding, creating double padding.
- **Fix**: Remove `p-6` if Layout already provides padding, or verify and adjust.

### P3-11: No consistent loading state pattern
- **What's wrong**: Some pages show a raw "Loading..." text (Sales.tsx line 263), App.tsx uses `<Loader2>` spinner, and some pages just don't show a loading state. The design system has a `skeleton` class but no standardized page-level loading component.
- **Fix**: Create a `<PageSkeleton>` component or standardize on the `LoadingFallback` pattern from App.tsx.

---

## MISSING FEATURE: Dashboard Period Filter

### Current State
The Dashboard page (`src/pages/Dashboard.tsx`) computes all metrics from the full voucher dataset. It has local period selectors for individual charts (salesPeriod for Sales Trend, topItemsPeriod for Top Items), but **no global date range filter** for the page.

### What's Needed
A period filter in the `page-header` area that allows:
1. Quick presets: "This Month", "Last Month", "This Quarter", "Last Quarter", "YTD", "Full Year"
2. Custom date range: From/To date pickers
3. The selected period should filter ALL dashboard data: KPIs, AR/AP cards, charts, and low stock alerts

### Suggested Implementation
```
<div className="page-header">
  <div className="page-header-row">
    <div>
      <h1 className="page-title">{company name}</h1>
      <p className="page-subtitle">{summary line}</p>
    </div>
    <div className="flex items-center gap-2">
      {/* Period preset pills */}
      <div className="tab-pills">
        <button className="tab-pill tab-pill-active">This Month</button>
        <button className="tab-pill">Last Month</button>
        <button className="tab-pill">YTD</button>
        <button className="tab-pill">All</button>
      </div>
      {/* Or custom date inputs */}
      <input type="date" className="form-input" />
      <input type="date" className="form-input" />
    </div>
  </div>
</div>
```

### Technical Notes
- Filter `data.vouchers` by date before passing to KPI computation
- Store selected period in `useUIStore` for persistence
- The individual chart period selectors can remain as secondary filters within their cards

---

## Summary of Required Actions

### Immediate (P0)
1. Define or replace `card-standard`, `card-premium`, `btn-accent` in Sales.tsx
2. Add Dashboard period filter

### Short-term (P1)
3. Migrate Sales.tsx to design system classes throughout
4. Standardize color naming (document which to use)
5. Ensure all pages use `page-title` class for h1
6. Fix Ledgers desktop search/select to use design system classes

### Medium-term (P2)
7. Standardize gap values for KPI grids and content sections
8. Replace `font-mono` with `tabular-nums` for numbers
9. Standardize icon sizes in buttons
10. Migrate filter/toggle buttons to design system patterns

### Ongoing (P3)
11. Remove backward-compat aliases (`bento-card` -> `card`) in new code
12. Remove redundant disabled state classes
13. Document typography scale including `text-2xs`

---

## Design System Strengths (What's Working Well)

1. **Comprehensive component library**: Cards, tables, buttons, badges, alerts, forms, tabs, tooltips, modals, empty states, skeleton loading -- all well-defined.
2. **Typography hierarchy**: Clear scale from `page-title` down to `caption-text` with consistent weight/size/color.
3. **Color system**: Well-organized 9-tier palette with semantic colors (accent, success, danger, warn, info).
4. **Accessibility**: Focus-visible rings, reduced-motion support, skip-to-content link, ARIA labels on NavBar.
5. **KPICard component**: Good semantic HTML (article/h3), proper ARIA labels, memoized.
6. **Responsive grid**: `bento-grid` handles 2->3->4 column progression cleanly.
7. **Dashboard page**: Fully leverages the design system. Best reference implementation.
