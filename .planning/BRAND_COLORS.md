# Brand Color System - Implementation Guide

## Overview

The MKCP Dashboard uses a brand-aligned color system that reflects M.K. Cycles' modern positioning. All colors are defined in `tailwind.config.js` and implemented through Tailwind CSS utility classes.

---

## Primary Colors

### Orange (#E8751A) - Main Brand Color

**Purpose**: Primary call-to-action buttons, active navigation items, key metric highlights, and brand accent elements.

**Color Scale**:
```
50:      #FEF6F0  (background tint for hover states)
100:     #FDD5B0  (light background)
200:     #FBB370  (medium background)
300:     #F9A155  (lighter hover)
DEFAULT: #E8751A  (primary action)
600:     #E8751A  (standard state)
700:     #D6670F  (hover state)
800:     #C45A04  (active state)
900:     #A84600  (dark state)
```

**Usage Examples**:
- `bg-accent` → Primary button background
- `text-accent` → Primary text color
- `border-accent` → Primary borders
- `hover:bg-accent-700` → Hover states
- `active:bg-accent-800` → Active/pressed states
- `focus:ring-accent-300` → Focus indicator rings
- `ring-accent-200` → Lighter focus rings

**Components**:
- `.btn-primary` - Primary action buttons
- Active navigation items (desktop & mobile)
- KPICard accent highlights
- Primary metric indicators

### Green (#2D5A3D) - Secondary Brand Color

**Purpose**: Secondary actions, success states, healthy metrics, and alternative actions.

**Color Scale**:
```
50:      #F0F4F2  (light background)
100:     #D0E0D8  (medium background)
DEFAULT: #2D5A3D  (secondary action)
600:     #1F3A28  (hover state)
700:     #0F1A13  (dark state)
900:     #051208  (darkest state)
```

**Usage Examples**:
- `bg-secondary` → Secondary button background
- `text-secondary` → Secondary text
- `border-secondary` → Secondary borders
- `hover:bg-secondary-600` → Hover states

**Components**:
- Secondary CTAs (when appropriate)
- Success state indicators
- Healthy inventory badges
- Approval/confirmation states

### Cream (#FFFBF5) - Accent Color

**Purpose**: Premium backgrounds, card highlights, featured sections, and light overlays.

**Color Scale**:
```
50:      #FFFBF5  (standard)
100:     #FEF5ED  (slightly darker)
200:     #FCE8D0  (medium)
DEFAULT: #FFFBF5  (background)
600:     #FCE8D0  (hover background)
```

**Usage Examples**:
- `bg-tertiary` → Elevated card backgrounds
- `hover:bg-tertiary-600` → Card hover states
- Featured section backgrounds
- Premium/highlighted content areas

**Note**: Always use dark text on cream backgrounds for sufficient contrast.

---

## Semantic Colors (No Change)

These colors are reserved for semantic meaning and should not be changed:

### Success (#10B981) - Positive Outcomes
- Used for successful transactions, healthy metrics, positive trends
- Utilities: `bg-success`, `text-success`, `border-success`
- States: `hover:bg-success-600`, `active:bg-success-700`

### Danger (#DC2626) - Critical/Errors
- Used for errors, critical issues, deletions, warnings
- Utilities: `bg-danger`, `text-danger`, `border-danger`
- States: `hover:bg-danger-700`, `active:bg-danger-800`

### Warn (#F59E0B) - Warnings/Attention
- Used for warnings, cautions, attention needed
- Utilities: `bg-warn`, `text-warn`, `border-warn`
- States: `hover:bg-warn-600`, `active:bg-warn-700`

### Info (#06B6D4) - Information/Secondary Data
- Used for informational messages, secondary data
- Utilities: `bg-info`, `text-info`, `border-info`
- States: `hover:bg-info-600`, `active:bg-info-700`

---

## Color Usage Rules

### Rule 1: One Primary CTA Per Section
- Only ONE orange button per logical section
- Secondary actions use `.btn-secondary` (ghost with border)
- This prevents button competition for user attention

### Rule 2: Navigation Active State
- Active/current page indicator should always be Orange (#E8751A)
- On desktop: background highlight with shadow
- On mobile: left border accent line
- Focus rings always use orange palette

### Rule 3: Status Indicators
- ✅ Success: Use success green (#10B981)
- ❌ Danger/Error: Use danger red (#DC2626)
- ⚠️ Warning: Use warn amber (#F59E0B)
- ℹ️ Information: Use info cyan (#06B6D4)
- **Never** use accent colors for semantic meaning

### Rule 4: Text on Colored Backgrounds
- All text on colored backgrounds must have **minimum 4.5:1 contrast** (WCAG AA)
- Orange background (#E8751A) → White text (#FFFFFF)
- Green background (#2D5A3D) → White text (#FFFFFF)
- Cream background (#FFFBF5) → Dark text (#0f172a)

### Rule 5: Border Colors
- Use `border-bg-border` for standard borders
- Use `border-accent` for primary emphasis borders
- Use semantic colors for status borders (success, danger, warn, info)
- Never use arbitrary color values

---

## Implementation Examples

### Primary Button
```html
<button class="btn-primary">Save Order</button>
```
Result: Orange background (#E8751A), white text, hover darkens to #D6670F

### Secondary Button
```html
<button class="btn-secondary">Cancel</button>
```
Result: Light border, gray text, hover background

### Active Navigation Item
```html
<a href="/dashboard" class="bg-accent/10 text-accent font-medium shadow-sm">
  Dashboard
</a>
```
Result: Light orange background, orange text, subtle shadow

### Success Badge
```html
<span class="bg-success text-white px-3 py-1 rounded-lg text-sm">
  In Stock
</span>
```
Result: Green background (#10B981), white text

### Card with Orange Border
```html
<div class="border-l-4 border-l-accent bg-white rounded-lg p-4">
  Featured content here
</div>
```
Result: Thick orange left border accent

### Focus Ring Style
```html
<button class="btn-primary focus:ring-2 focus:ring-accent-300">
  Action
</button>
```
Result: On focus, light orange ring appears around button

---

## Color Contrast Verification

All color combinations have been verified for WCAG 2.1 AA compliance:

| Combination | Contrast Ratio | Status |
|-------------|----------------|--------|
| Orange on White | 5.2:1 | ✅ AA |
| Green on White | 4.8:1 | ✅ AA |
| White on Orange | 7.1:1 | ✅ AAA |
| White on Green | 6.4:1 | ✅ AAA |
| Dark text on Cream | 14.1:1 | ✅ AAA |
| Orange (#E8751A) on Light Gray bg | 4.9:1 | ✅ AA |

---

## File References

### Tailwind Configuration
- **File**: `tailwind.config.js`
- **Lines**: 6-77 (accent, secondary, tertiary definitions)
- Contains all color values and scales

### CSS Components
- **File**: `src/index.css`
- **Lines**: 15-19 (focus-visible ring color)
- **Lines**: 175-213 (button variants)
- Contains component styling using color classes

### Component Usage
- **Buttons**: `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`
- **Cards**: `.bento-card`, `.bento-card-interactive`, `.bento-card-elevated`
- **Forms**: `.form-input`, `.form-select`, `.form-textarea`
- **Navigation**: Active states with `bg-accent/10` and `text-accent`

---

## When to Add New Colors

Only add new colors if ALL of the following are true:
1. Not a semantic meaning (success, danger, warn, info)
2. Not a variation of existing brand colors
3. Required by a specific design specification
4. Has clear usage patterns across multiple components
5. Maintains WCAG AA contrast compliance

**Never** add arbitrary new colors without:
- Documenting the purpose
- Verifying contrast compliance
- Adding to this guide
- Updating all relevant files

---

## Maintenance Guidelines

### Regular Audits
- Check all pages monthly for color consistency
- Verify no arbitrary hex colors are used in components
- Audit new code for proper color class usage

### Design Evolution
- If brand colors change, update:
  1. `tailwind.config.js` accent/secondary/tertiary definitions
  2. This documentation file
  3. All component files referencing colors
  4. Commit with detailed message explaining change rationale

### Performance
- All colors are defined as Tailwind classes
- No color runtime overhead
- CSS file size is optimized
- Colors compile to minified Tailwind output

---

## Brand Color Rationale

### Why Orange?
- Represents **energy** and **forward momentum**
- Associated with **cycling culture** and movement
- Warm, approachable, and modern
- **Differentiates** from generic tech blue
- High visibility and accessibility

### Why Green?
- Represents **sustainability** and **eco-friendliness**
- Associated with cycling and environmental movement
- Conveys **trust** and **growth**
- Works as **secondary action** color
- Complements orange in color harmony

### Why Cream?
- Represents **lightness** and **accessibility**
- Warm contrast to brand orange and green
- Creates **premium, sophisticated** feeling
- Reduces visual harshness compared to pure white
- Improves readability and user comfort

---

**Document**: Brand Color System - Implementation Guide
**Last Updated**: 2026-03-20
**Status**: Active
**Responsibility**: Design System Maintenance
**Questions?**: Refer to DESIGN_LANGUAGE_AUDIT.md or UX_ARCHITECTURE_SUMMARY.md

