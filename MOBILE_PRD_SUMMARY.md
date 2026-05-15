# MK CYCLES MOBILE APP – EXECUTIVE SUMMARY

## 📋 DOCUMENT LOCATION
Full PRD: `MK_CYCLES_MOBILE_APP_PRD.md` (3,500+ lines)

---

## 🎯 APP VISION

**Transform field operations into real-time business intelligence**

A native React Native app extending the Electron dashboard to dealers, sales teams, and warehouse staff. Enable order capture, inventory visibility, customer management, and financial insights from anywhere.

---

## 📱 CORE SCREENS & PRIORITY

### P1: LAUNCH MVP (Must-Have)
1. **Home** – KPI dashboard + quick actions
2. **Orders** – Order capture + history + pending
3. **Inventory** – Stock search + reorder alerts + low-stock filter
4. **Customers** – Contact list + purchase history + call log + priority scoring
5. **Reports** – 4 tabs (Financial, Sales, Inventory, Expense) with date filtering

### P2: SECONDARY (Nice-to-Have)
6. **Pending Orders** – Delivery note viewer
7. **Price List** – Item search + dealer rates
8. **Discounts** – Calculator integrated into order flow
9. **Routes** – Map view of dealers + directions
10. **Invoices** – Read-only sales voucher list
11. **Ledgers** – Customer/supplier ledger detail

### P3: UTILITY (Future)
12. **Settings** – Proxy config, sync settings, cache management
13. **Edit Units** – Per-item unit overrides
14. **Discount Rules** – Tier editor (admin)

---

## 🏗️ TECHNICAL ARCHITECTURE

```
React Native (Expo) + TypeScript
├─ State: Zustand + Context API
├─ Storage: AsyncStorage + WatermelonDB
├─ Network: Axios (via proxy at :3100)
├─ UI: React Native Paper + custom components
├─ Charts: Victory (RN) or Skia Canvas
├─ Maps: React Native Maps
├─ Background: Expo Task Scheduler (30-min sync)
└─ Offline: Full app works without network
```

---

## 🔄 DATA SYNC FLOW

```
First Launch:
  1. Load cached data from AsyncStorage (instant)
  2. Show cached data (greyed if > 24h old)
  3. Attempt HTTP sync to proxy (:3100)
  4. Merge results + update cache
  5. Show "synced at X" timestamp

Periodic Sync (background, every 30 min):
  - Check network (Wi-Fi only toggle in settings)
  - Fetch today's day book
  - Merge with cache
  - Push pending orders
  - Send notification on complete

Manual Sync (user tap):
  - Show [Syncing...] spinner
  - Full sync: masters + date range
  - Display progress ETA
```

---

## 💾 PRE-LOADED DEFAULT DATA

### Sample Items (3 items with full details)
- **Atlas 18T Hero 21SPD Bicycle** – ₹2,080/PC, 45 units stock
- **Chain Shimano SRAM 21SPD** – ₹185.71/PC, 240 units (in box of 5)
- **Brake Pads Disc Organic** – ₹125/SET, 150 units (in box of 10)

### Sample Customers (3 dealers)
- **Rajesh Dhal Cycle Mart** (Delhi) – ₹45K outstanding, 30-day credit
- **Sharma Cycles** (Bangalore) – ₹78.5K outstanding, 45-day credit
- **Metro Bike Rentals** (Mumbai) – ₹12.3K outstanding, 15-day credit

### Sample Discount Rules (3 tiers per category)
- **Chains/Freewheels** – 0% (0-10 qty) → 2% (10-25) → 4% (25-50) → 6% (50+)
- **Brake Pads** – 0% (0-20) → 3% (20-50) → 5% (50-100) → 8% (100+)
- **Complete Bicycles** – 0% (0-5) → 5% (5-10) → 10% (10+)

### Sample Vouchers (2 recent sales)
- SO-00001: Rajesh (50 chains + 20 brake pads) = ₹12,500
- SO-00002: Sharma (8 bicycles + 5 chains) = ₹18,500

---

## 🎯 KEY FEATURES BY SCREEN

### Home Screen
- 4 KPI cards (Daily Sales, Bank Balance, Outstanding, Top Item)
- Action buttons (New Order, Call Customer, Check Stock, View Reports, Sync)
- Mini 7-day sales chart
- Alerts section (reorder count, low stock, overdue invoices)

### Order Capture
- Party search (dropdown with recent)
- Item search (shows stock availability)
- Unit toggle (Base ↔ Package with ratio)
- Auto-calculate rate + total
- Apply discount (tier-based, auto-calc)
- Save as draft → AsyncStorage
- Send to Tally → /api/tally/import endpoint
- Generate PDF + share

### Inventory Search
- Fuzzy search (item name + group)
- Stock status badges (IN STOCK / LOW / ZERO / DEAD)
- Suggested reorder qty (auto-calculated)
- Monthly trend chart (last 6 months)
- Transaction history (expandable)
- One-tap order creation

### Customer Management
- Searchable contact list
- Priority scoring (red/amber/green badge)
- Outstanding balance + aging buckets
- Last 10 orders with amounts
- [Call] [Email] [Create Order] buttons
- Call log with outcome tracking (call/follow-up/closed/lost)
- Next follow-up date reminder

### Reports (Bottom Sheet)
- **Financial**: Revenue, Profit, Margin %, Bank Balance + monthly chart
- **Sales**: Top 10 items (bar chart) + sales velocity table
- **Inventory**: Stock KPIs + stock status filter by urgency
- **Expense**: Cash flow chart + expense breakdown (collapsible)
- Date range presets (This Month, Last Month, YTD) + custom picker

---

## 🔌 API INTEGRATION (All via :3100 Proxy)

```typescript
// Sync (initial or manual)
POST /api/tally/sync
  → { success, masters, transactions }

// Day book (today only, for background sync)
POST /api/tally/daybook
  → { success, data }

// Push order to Tally
POST /api/tally/import
  → { success, createdGuids[] }

// Health check
GET /
  → { ok: true, version }
```

---

## 📊 CORE ENGINES (Reused from Desktop)

### Financial Engine
- `computeOutstandingInvoices()` – Aging buckets (current, 1-30, 31-60, 61-90, 90+)
- `computeBankBalance()` – Cash position
- `dailySales()` / `last7DaysSales()` – Trending

### Inventory Engine
- `getCurrentStockIndexed()` – Current qty (optimized lookup)
- `suggestedReorderQty()` – Auto-calc based on avg outward + cover months
- `stockStatus()` – Badge (in/low/zero/dead)

### Discount Engine
- `calculateDiscount()` – Tier lookup + auto-apply based on qty
- Pre-loaded 3 sample categories with tiers

### Outreach Engine
- `logCall()` – Create call record (outcome, notes, follow-up date)
- `priorityScore()` – Rank customers by urgency
- Factors: outstanding (40%) + recency (30%) + value (20%) + frequency (10%)

---

## 💡 OFFLINE CAPABILITY (Critical for India)

```
✅ Works without network:
  - View cached data (items, ledgers, vouchers)
  - Create orders offline (saved to AsyncStorage)
  - Search inventory
  - View customer history
  - Calculate discounts
  - View call log

❌ Requires network:
  - Sync fresh data from Tally
  - Push orders to Tally
  - Download new masters

Strategy:
  - Data loaded on first network sync
  - Background task re-syncs every 30 min
  - Pending orders queue + retry on reconnect
  - Offline banner shows "Last synced: X hours ago"
```

---

## 📈 SUCCESS METRICS

| Metric | Target |
|--------|--------|
| DAU (field team) | 5+ |
| Order capture via app | 40%+ of new orders |
| Sync reliability | 99%+ success |
| 7-day retention | 80%+ |
| Crash-free sessions | 99.5%+ |
| Offline functionality | 95%+ features work |

---

## 🗓️ ROLLOUT TIMELINE

| Phase | Duration | Deliverables |
|-------|----------|--------------|
| **Phase 1: MVP** | 3 months | P1 screens, core engines, sync |
| **Phase 2: Polish** | 2 months | P2 screens, notifications, offline badge |
| **Phase 3: Hardening** | 2 months | Beta testing, optimizations, store submission |
| **Phase 4: Launch** | Ongoing | Marketing, onboarding, support |

---

## 🚀 NEXT STEPS

1. ✅ **PRD Validation** – Review with sales team, warehouse, owner
2. ⏳ **Design Mockups** – Figma wireframes for all P1 screens
3. ⏳ **Tech Setup** – Expo project init, Zustand stores scaffold
4. ⏳ **Engine Adaptation** – Port desktop engines to React Native
5. ⏳ **Screen Implementation** – Build P1 screens in parallel (5 developers)
6. ⏳ **Integration Testing** – Test sync, offline, error handling
7. ⏳ **Beta Launch** – 10-15 dealers on TestFlight/Google Play
8. ⏳ **App Store Submission** – Both iOS + Android
9. ⏳ **Launch Marketing** – Sales team training, promo videos
10. ⏳ **Ops Support** – Monitor crashes, fix bugs, gather feedback

---

## 📎 FULL DOCUMENTATION

The complete PRD includes:
- Detailed screen specifications with wireframes (in text)
- Complete data models (TypeScript interfaces)
- Sync flow diagrams (ASCII)
- API endpoint documentation
- Sample seed data (JSON)
- Code structure template
- Performance targets
- Security considerations
- Feature parity analysis (desktop → mobile)

**File:** `MK_CYCLES_MOBILE_APP_PRD.md`

---

**Questions?** Reach out to the dev team.
