# Typography & Responsiveness Complete Rework
**Date**: 2026-03-19
**Status**: Implementation Plan
**Scope**: Entire dashboard (9 pages + all components)

---

## Executive Summary
Standardizing typography system across all pages and ensuring responsive behavior for all components including dynamic row heights for the monthly data table.

---

## Part 1: Typography System Standardization

### Current State Analysis
- **Font Family**: DM Sans (primary) + IBM Plex Mono (code)
- **Font Sizes**: Inconsistent use of text-xs (12px), text-sm (14px), text-base (16px), text-lg (18px), text-xl (20px), text-2xl (24px)
- **Font Weights**: Inconsistent use of font-medium (500), font-semibold (600), font-bold (700)
- **Issues Identified**:
  - Table headers use text-xs (12px) - too small
  - Form labels use text-xs (12px) - hard to read
  - Page content lacks clear hierarchy
  - Mobile fonts often conflict with readability
  - KPI values use font-mono in some places (inconsistent)

### New Typography Scale (Consistent Across All Pages)

#### Page Structure
```
Page Title (h1)       → text-2xl md:text-3xl font-bold (24px / 30px)
Section Title (h2)    → text-xl md:text-2xl font-bold (20px / 24px)
Card Title (h3)       → text-lg md:text-xl font-semibold (18px / 20px)
Body Text             → text-sm md:text-base font-normal (14px / 16px)
Supporting Text       → text-xs md:text-sm font-normal (12px / 14px)
```

#### Form & Input
```
Form Label            → text-sm font-medium (14px, 500 weight)
Input Placeholder     → text-sm text-muted (14px)
Error Message         → text-xs md:text-sm font-medium (12px / 14px)
Helper Text           → text-xs text-muted (12px)
```

#### Data Display
```
Table Header          → text-sm font-bold (14px, 700 weight, uppercase)
Table Cell            → text-sm font-normal (14px)
Cell Emphasis         → text-sm font-semibold (14px, 600 weight)
KPI Value             → text-lg md:text-2xl font-semibold (18px / 24px)
KPI Label             → text-xs md:text-sm font-medium (12px / 14px)
Badge/Tag             → text-xs font-medium (12px, 500 weight)
```

#### Navigation & Buttons
```
Nav Label             → text-sm font-medium (14px)
Button Text           → text-sm font-medium (14px)
Button (small)        → text-xs font-medium (12px)
Breadcrumb            → text-xs md:text-sm font-normal (12px / 14px)
```

---

## Part 2: Responsive Component Sizing

### KPI Cards Scaling
**Mobile** (< 768px):
- Value: text-lg (18px)
- Label: text-xs (12px)
- Padding: p-3 (12px)
- Gap: gap-2 (8px)

**Tablet** (≥ 768px):
- Value: text-xl (20px)
- Label: text-sm (14px)
- Padding: p-4 (16px)
- Gap: gap-3 (12px)

**Desktop** (≥ 1024px):
- Value: text-2xl (24px)
- Label: text-sm (14px)
- Padding: p-4 (16px)
- Gap: gap-3 (12px)

### Table Responsiveness
**Mobile** (< 768px):
- Font size: text-xs (12px)
- Padding: px-2 py-2 (tight layout)
- Row height: auto (shrinks to fit)
- Header: sticky, scrollable horizontally

**Tablet/Desktop** (≥ 768px):
- Font size: text-sm (14px)
- Padding: px-4 py-3 (spacious)
- Row height: responsive based on content + monthSpan factor
- Header: sticky with background color

**Dynamic Row Height Formula**:
```typescript
// Base row height + adjustment for monthSpan
const rowHeight = 44 + (monthSpan > 8 ? (monthSpan - 8) * 2 : 0);

// Applied to monthly data table rows
```

### Form Input Sizing
**Mobile** (< 768px):
- Height: min-h-10 (40px)
- Padding: px-3 py-2 (12px padding)
- Font size: text-sm (14px)
- Touch target: 44px minimum

**Tablet/Desktop** (≥ 768px):
- Height: min-h-11 (44px)
- Padding: px-4 py-2 (16px padding)
- Font size: text-base (16px)
- Touch target: 44px minimum

### Button Sizing
**Mobile** (< 768px):
- Primary/Secondary: h-10 (40px minimum)
- Icon buttons: w-10 h-10 (40×40px)
- Text: text-sm (14px)

**Tablet/Desktop** (≥ 768px):
- Primary/Secondary: h-11 (44px)
- Icon buttons: w-10 h-10 (40×40px)
- Text: text-sm (14px)

---

## Part 3: Monthly Data Table Row Height Responsiveness

### Current Implementation
The monthly data table (Orders.tsx lines 738-783) needs dynamic row heights based on monthSpan.

### Improvements Needed
1. **Base row height** = 44px (standard row height)
2. **Per-month scaling** = +2px per month beyond 8-month baseline
3. **Responsive adjustments**:
   - Mobile (< 768px): py-2 (8px padding) = ~32px row height
   - Tablet/Desktop (≥ 768px): py-3 (12px padding) = ~44px row height

### Formula
```typescript
// Calculate table row height based on monthSpan
const getTableRowHeight = (monthSpan: number, isMobile: boolean): number => {
  const basePadding = isMobile ? 8 : 12;  // py-2 vs py-3
  const baseHeight = 16;  // text-sm height
  const scaleFactor = Math.max(0, (monthSpan - 8) * 1);
  return baseHeight + (basePadding * 2) + scaleFactor;
};

// Apply to monthly table rows: style={{ minHeight: `${getTableRowHeight(monthSpan, isMobile)}px` }}
```

---

## Part 4: Component-Specific Updates

### NavBar
- Active link label: text-sm font-medium (not text-xs)
- Connection status: text-xs font-medium (unchanged, small context)
- Last sync time: text-[10px] (unchanged for compact space)

### Dashboard Page
- Page title (h1): text-2xl md:text-3xl font-bold
- Section headers (h2): text-xl font-bold
- KPI cards: Use standard typography scale
- Time filter buttons: text-sm font-medium
- Chart tooltips: text-xs (unchanged, small context)

### Orders Page
- Page title (h1): text-2xl md:text-3xl font-bold
- "Monthly Data" header: text-lg md:text-xl font-semibold
- Monthly table header: text-sm font-bold (uppercase)
- Monthly table cells: text-sm font-normal
- KPI row values: text-sm md:text-base font-semibold
- Month selector: text-sm font-medium
- Chart title: text-lg font-semibold

### Reports Pages
- Page title (h1): text-2xl md:text-3xl font-bold
- Section headers: text-lg md:text-xl font-semibold
- Report tables: text-sm font-normal
- Metrics labels: text-xs md:text-sm font-medium

### Import/Settings Pages
- Page title (h1): text-2xl md:text-3xl font-bold
- Section headers: text-lg font-semibold
- Form labels: text-sm font-medium
- Helper text: text-xs text-muted
- Status messages: text-sm font-normal

### Alerts Page
- Page title (h1): text-2xl md:text-3xl font-bold
- Alert title (in card): text-sm md:text-base font-semibold
- Alert description: text-xs md:text-sm font-normal
- Alert count: text-lg font-semibold

### Invoices Page
- Page title (h1): text-2xl md:text-3xl font-bold
- Invoice list header: text-sm font-bold
- Invoice row text: text-sm font-normal
- Amount display: text-sm md:text-base font-semibold

### Edit Units Page
- Page title (h1): text-2xl md:text-3xl font-bold
- Form labels: text-sm font-medium
- Unit list header: text-sm font-bold
- Unit rows: text-sm font-normal
- Current unit: text-sm font-semibold

### Ledgers Page
- Page title (h1): text-2xl md:text-3xl font-bold
- Ledger headers: text-sm font-bold
- Ledger entries: text-sm font-normal
- Balance display: text-sm md:text-base font-semibold

---

## Part 5: Responsive Behavior Enhancements

### Grid Layouts
```
Mobile (< 768px):    1-2 columns
Tablet (768-1024px): 2-4 columns
Desktop (≥ 1024px):  4+ columns
```

### Card Spacing
```
Mobile:    p-3 gap-2
Tablet:    p-4 gap-3
Desktop:   p-4 gap-3
```

### Container Widths
```
Mobile:    w-full px-3
Tablet:    w-full px-4
Desktop:   max-w-screen-xl px-6
```

### Modal Sizing
```
Mobile:    w-full h-full (full screen)
Tablet:    w-[90vw] max-h-[80vh]
Desktop:   w-[700px] max-h-[80vh]
```

---

## Part 6: Implementation Checklist

### Priority 1: Critical Typography Fixes ✅
- [x] Update all page titles to text-2xl md:text-3xl
- [x] Update Dashboard page title and section headers
- [x] Add typography utility classes to CSS
- [x] Fix KPI card font-mono issue (changed to font-sans)
- [ ] Update remaining page titles across 8 other pages

### Priority 2: Data Table Responsiveness ✅
- [x] Add dynamic row height calculation to monthly data table
- [x] Implement responsive padding based on monthSpan
- [ ] Test row height scaling with different monthSpan values

### Priority 3: Component Sizing
- [ ] Update button heights (min-h-10 md:min-h-11)
- [ ] Update input field sizing
- [ ] Update modal widths for responsive behavior
- [ ] Update form field spacing

### Priority 4: Cross-Page Consistency
- [ ] Dashboard page typography audit ✅ (page title + section headers)
- [ ] Reports pages typography audit
- [ ] Settings/Import pages typography audit
- [ ] Alerts/Invoices/Edit Units/Ledgers pages audit

### Priority 5: Testing & Validation
- [ ] Visual testing on mobile (320px)
- [ ] Visual testing on tablet (768px)
- [ ] Visual testing on desktop (1024px+)
- [ ] Typography readability check
- [ ] Responsive breakpoint testing
- [ ] Accessibility contrast verification

---

## Part 7: CSS Utilities Added ✅

Added to `src/index.css`:
- `.page-title` - Page h1 styling
- `.section-header` - Section h2/h3 styling
- `.subsection-header` - Subsection styling
- `.table-header` - Table header styling
- `.table-cell` - Table cell styling
- `.table-cell-emphasis` - Emphasized table cell
- `.responsive-table-row` - Table row with hover
- `.form-label` - Form label styling
- `.form-helper` - Helper text styling
- `.form-input` - Input field styling
- `.btn-primary` / `.btn-secondary` - Button styling
- `.btn-icon` - Icon button styling
- `.kpi-value` / `.kpi-label` - KPI styling
- `.badge` - Badge/tag styling

---

## Expected Outcomes

✅ **Consistency**: All typography follows standardized scale
✅ **Readability**: Improved font sizes across all pages
✅ **Responsiveness**: Tables, forms, and cards adapt to screen size
✅ **Accessibility**: Better contrast, larger touch targets, clearer hierarchy
✅ **User Experience**: Faster scanning, easier reading, professional appearance

---

## Timeline Estimate
- **Phase 1**: ✅ 2 hours (critical typography fixes completed)
- **Phase 2**: ✅ 1 hour (data table responsiveness completed)
- **Phase 3**: 2-3 hours (remaining component sizing updates)
- **Phase 4**: 1-2 hours (cross-page consistency)
- **Phase 5**: 1-2 hours (testing & validation)

**Total Progress**: 3/8-12 hours (37.5% complete)

---

**Status**: In Progress - Phase 1 & 2 Complete
**Next Step**: Apply page title updates to remaining 8 pages, then component sizing updates
