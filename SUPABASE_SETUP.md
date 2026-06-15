# Supabase Setup Guide

## Overview

The Dashboard now syncs to Supabase:
- **Masters**: Stock items, ledgers, groups, units, godowns, cost centres, price lists (auto-synced on Tally import)
- **Transactions**: Vouchers with ledger & inventory entries (auto-synced on Tally import)
- **Configuration**: Discount rules, order groups, unit overrides, rate overrides (auto-synced when changed)

---

## Setup Steps

### 1. Create the Tables

Run these SQL migrations in your Supabase project:

**Supabase Dashboard:**
1. Go to SQL Editor
2. Create a new query
3. Copy & paste each migration file's contents
4. Execute

**Migration Files (in order):**
1. `migrations/001_config_tables.sql` — Creates discount rules, order groups, unit overrides, rate overrides
2. `migrations/002_add_company_to_sync_history.sql` — Adds company column to sync history

---

## Tables Created

### discount_rules
Stores discount rules configured in the app
```
- id: Text (Primary Key)
- company: Text
- name: Text
- category: Text
- discount_type: Text
- discount_value: Decimal
- conditions: JSONB
- priority: Integer
- enabled: Boolean
- synced_at: Timestamp
```

### order_groups
Stores order groups (batches of items to order together)
```
- id: Text (Primary Key)
- company: Text
- name: Text
- description: Text
- color: Text (hex color)
- tags: Text[] (array)
- item_ids: Text[] (array of item IDs)
- lines: JSONB (order line details)
- created_at: Timestamp
- updated_at: Timestamp
- synced_at: Timestamp
```

### unit_overrides
Stores alternative unit configurations (e.g., items sold by box but stock in pieces)
```
- id: Serial (Primary Key)
- item_id: Text
- company: Text
- pkg_unit: Text (e.g., "BOX", "DOZEN")
- units_per_pkg: Decimal (e.g., 12 pieces per box)
- source: Text ('manual' or 'import')
- confidence: Decimal (0-1)
- updated_at: Timestamp
- synced_at: Timestamp
- UNIQUE: company + item_id
```

### rate_overrides
Stores custom rates for items (overrides prices from Tally)
```
- id: Serial (Primary Key)
- item_id: Text
- company: Text
- unit_rate: Decimal (rate per base unit)
- pkg_rate: Decimal (rate per package)
- updated_at: Timestamp
- synced_at: Timestamp
- UNIQUE: company + item_id
```

### tally_sync_history (modified)
Audit log for all syncs (now includes company field)
```
- id: Serial (Primary Key)
- company: Text (NEW - identifies which company was synced)
- sync_type: Text ('masters' or 'vouchers')
- started_at: Timestamp
- completed_at: Timestamp
- row_counts: JSONB
- errors: Text[] (error messages if any)
- success: Boolean
- created_at: Timestamp
```

---

## API Endpoints

### POST /api/supabase/sync
Syncs Tally data (masters and vouchers)

**Request:**
```json
{
  "company": "M.K.CYCLES (P) LTD.",
  "items": [...],
  "ledgers": [...],
  "vouchers": [...]
}
```

**Response:**
```json
{
  "success": true,
  "message": "...",
  "itemsCount": 500,
  "ledgersCount": 300,
  "vouchersCount": 1000
}
```

### POST /api/supabase/sync-config
Syncs configuration data (discount rules, order groups, unit overrides)

**Request:**
```json
{
  "company": "M.K.CYCLES (P) LTD.",
  "discountRules": [...],
  "orderGroups": [...],
  "unitOverrides": { ... },
  "rateOverrides": [...]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Configuration data synced to Supabase",
  "discountRulesCount": 5,
  "orderGroupsCount": 3,
  "unitOverridesCount": 12,
  "rateOverridesCount": 8
}
```

---

## How Syncing Works

### Automatic Syncing

1. **Masters & Vouchers** (on Tally import):
   - When you click "Quick Sync" in the Import page
   - Automatically syncs to Supabase in the background
   - Non-blocking (doesn't delay the UI)

2. **Configuration Data** (on local changes):
   - Whenever you edit discount rules, order groups, or unit overrides
   - Automatically syncs to Supabase with a 2-second debounce
   - Silent (no UI notification, just logs in console)

### Manual Trigger

**Supabase Tab in Import Page:**
1. Go to Import page
2. Scroll down to "Supabase Status" section
3. Click "Push to Supabase" button to manually trigger sync

---

## Verification

### Check Synced Data

1. **Supabase Dashboard:**
   - Go to your Supabase project
   - Click Table Editor
   - View tables: `discount_rules`, `order_groups`, `unit_overrides`, `rate_overrides`

2. **Via SQL Query:**
   ```sql
   -- View all discount rules
   SELECT * FROM discount_rules WHERE company = 'M.K.CYCLES (P) LTD.';

   -- View all order groups
   SELECT * FROM order_groups WHERE company = 'M.K.CYCLES (P) LTD.';

   -- View sync history
   SELECT * FROM tally_sync_history ORDER BY created_at DESC LIMIT 10;
   ```

3. **In Dashboard App:**
   - Open Browser DevTools (F12)
   - Go to Console tab
   - Look for `[Config Sync]` logs
   - Shows synced data counts on every change

---

## Troubleshooting

### "column 'company' does not exist"

**Cause:** Table missing company column

**Fix:** Run migration `002_add_company_to_sync_history.sql`

```sql
ALTER TABLE tally_sync_history ADD COLUMN IF NOT EXISTS company TEXT;
```

### "Failed to run sql query: ERROR: 23505: duplicate key value"

**Cause:** Trying to insert duplicate record (unique constraint violated)

**Fix:** Delete existing records and retry
```sql
DELETE FROM discount_rules WHERE id = 'xxx';
```

### Config sync not working

**Check:**
1. Is the server running? (http://localhost:3100)
2. Are Supabase credentials set? (check server logs)
3. Open DevTools → Console → look for `[Config Sync]` messages

**Debug:** Add this to browser console:
```javascript
fetch('http://localhost:3100/api/supabase/sync-config', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    company: 'M.K.CYCLES (P) LTD.',
    discountRules: [],
    orderGroups: [],
    unitOverrides: {},
    rateOverrides: []
  })
}).then(r => r.json()).then(console.log)
```

---

## Performance Notes

- **Config sync debounce:** 2 seconds (waits for rapid changes to settle)
- **Batch size for masters:** 100-200 rows per request (REST payload limit)
- **Batch size for vouchers:** 200 rows per request (to avoid JSONB payload limit)
- **Async & non-blocking:** All syncs happen in background, never block the UI

---

## Security

- **RLS Policies:** Only service_role can write to these tables
- **API Key:** Service role key (hidden in .env) used server-side only
- **No client-side writes:** Frontend can't directly write to Supabase
- **Audit trail:** All syncs logged in tally_sync_history

---

## Next Steps

1. **Run migrations** in Supabase SQL Editor
2. **Restart the Dashboard** app
3. **Edit a discount rule** → watch it sync to Supabase
4. **Create an order group** → watch it sync automatically
5. **Check Supabase dashboard** to verify data appears
