# MK CYCLES MOBILE APP – QUICK INDEX

## 📄 DOCUMENTATION FILES

### 1. **MOBILE_PRD_SUMMARY.md** (2-page executive summary)
   - Start here for quick overview
   - Vision, screens, features, timeline
   - Success metrics, next steps
   - **Read time: 10 minutes**

### 2. **MK_CYCLES_MOBILE_APP_PRD.md** (Complete 13-section PRD, 3,500+ lines)
   - Section 1: Executive Summary + Desktop Analysis
   - Section 2: Mobile Architecture & Navigation
   - Section 3: P1 Core Screens (detailed specs)
   - Section 4: P2 Secondary Screens
   - Section 5: P3 Utility Screens
   - Section 6: Default Content & Seed Data
   - Section 7: Core Engines (Financial, Inventory, Discounts, Outreach)
   - Section 8: Data Structures & Stores (Zustand + AsyncStorage)
   - Section 9: API Integration & Sync Strategy
   - Section 10: Screen Flows & User Journeys
   - Section 11: Technical Implementation
   - Section 12: Feature Parity & Gaps
   - Section 13: Rollout Plan & Timeline
   - **Read time: 60-90 minutes (reference document)**

---

## 🎯 KEY HIGHLIGHTS

### Platform
- **React Native (Expo)** for iOS/Android cross-platform
- **TypeScript** for type safety
- **Zustand + Context** for state management (same as desktop)
- **AsyncStorage + WatermelonDB** for offline persistence

### 5 Primary Tabs
1. **Home** – Dashboard + quick actions
2. **Orders** – Order capture + history + pending
3. **Inventory** – Stock search + reorder alerts
4. **Customers** – Contacts + call log + priority scoring
5. **More** – Reports, Price List, Routes, Settings, etc.

### Target Users
- Business owner (founder-level visibility)
- Sales team (order capture, customer calls)
- Warehouse manager (inventory, receiving)
- Delivery drivers (routes, customer addresses)
- Dealers (order placement, pricing)

---

## 💾 PRE-LOADED DATA (Ready to Demo)

### Items (3 samples, full details)
- Atlas 18T Hero 21SPD Bicycle – ₹2,080/PC, 45 units
- Chain Shimano SRAM 21SPD – ₹185.71/PC, 240 units (box of 5)
- Brake Pads Disc Organic – ₹125/SET, 150 units (box of 10)

### Customers (3 samples)
- Rajesh Dhal Cycle Mart (Delhi) – ₹45K outstanding
- Sharma Cycles (Bangalore) – ₹78.5K outstanding
- Metro Bike Rentals (Mumbai) – ₹12.3K outstanding

### Discount Rules (3 pre-configured categories)
- Chains/Freewheels: 0% → 2% → 4% → 6%
- Brake Pads: 0% → 3% → 5% → 8%
- Complete Bicycles: 0% → 5% → 10%

### Vouchers (2 recent sales for demo)
- SO-00001 & SO-00002 with full line items + amounts

---

## 🔄 CORE ENGINES (Reused from Desktop)

1. **Financial** – Outstanding invoices, bank balance, monthly totals, daily/7-day sales
2. **Inventory** – Current stock (indexed), suggested reorder qty, stock status badges
3. **Discounts** – Tier-based auto-calculation, category mapping
4. **Outreach** – Call logging, priority scoring (40% outstanding + 30% recency + 20% value + 10% frequency)

---

## 🗓️ PHASED ROLLOUT

| Phase | Duration | Scope |
|-------|----------|-------|
| **Phase 1: MVP** | 3 months | P1 screens (Home, Orders, Inventory, Customers, Reports) |
| **Phase 2: Polish** | 2 months | P2 screens + notifications + offline badge |
| **Phase 3: Hardening** | 2 months | Beta testing with dealers + App Store submission |
| **Phase 4: Launch** | Ongoing | Marketing rollout + user support |

---

## 📊 SUCCESS METRICS

- **DAU**: 5+ field team users
- **Order capture via app**: 40%+ of new orders
- **Sync reliability**: 99%+ success
- **7-day retention**: 80%+
- **Crash-free sessions**: 99.5%+
- **Offline functionality**: 95%+ features work without network

---

## 🚀 QUICK START (For Stakeholders)

1. Read `MOBILE_PRD_SUMMARY.md` (10 min)
2. Review Section 3 of full PRD for screen details (20 min)
3. Check "4. Default Content & Seed Data" for demo payload (5 min)
4. Review "7. Core Engines" for business logic confirmation (10 min)
5. Discuss rollout timeline with dev team

---

## 💬 QUESTIONS?

**On Desktop Analysis?** See Section 1.1 (page inventory, criticality, feature parity)

**On Architecture?** See Section 2 (app shell, data persistence, sync strategy)

**On Data Models?** See Section 8 (Zustand stores, AsyncStorage schema)

**On Implementation?** See Section 11 (tech stack, performance, offline strategy)

**On Timeline?** See Section 13 (4 phases, 9-10 months total)

---

**Document Status:** ✅ Complete PRD ready for stakeholder review and dev team kickoff

**Last Updated:** May 2026
