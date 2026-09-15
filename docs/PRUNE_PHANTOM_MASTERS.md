# Pruning the name-keyed master rows

**Status: NOT APPLIED. Needs the owner.** Every statement below was measured
read-only against `vmkytsytxlofjyeotmgb` on 2026-09-15.

## What is there

`POST /api/supabase/sync` forwards the browser's canonical masters, whose ids
are `normalizeId(name)` — the uppercased name. `hasRealGuid` tested only that
the guid was non-empty, so those passed, and because the upsert key IS the guid
they landed as a second row per master that can never reconcile with the real
one. The guard is fixed (`9954fa1`); this is about the rows already written.

| Table | Rows | Real GUID | Name-keyed |
|---|---|---|---|
| `tally_stock_items` | 951 | 492 | **459** |
| `tally_ledgers` | 940 | 485 | **455** |
| `tally_stock_groups` | 22 | 22 | 0 |
| `tally_units` | 9 | 9 | 0 |
| `tally_godowns` | 1 | 1 | 0 |
| `tally_cost_centres` | 0 | — | — |

All 914 were written **2026-09-15 05:11**. The 2026-09-14 backup holds 7. This
is recent and was growing until the guard was fixed.

The phantoms carry `parent` and nothing else — `category`, `base_units`, the
opening/closing triples, `gst_type_of_supply`, `gst_details` and `hsn_details`
are all NULL.

## The rule the prune must follow

**Key on "this guid is not GUID-shaped". NEVER on "absent from today's pull".**

The sandbox and production Tally companies share one company name, and the
mirror is keyed on that name alone. A prune that deletes what today's pull did
not return will delete production data the moment it runs against the sandbox.
That is guardrail G6, and migration 026's backstop exists because of one
September incident already.

The predicate, matching the shipped guard:

```sql
guid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]+$'
```

Verified to select exactly the phantoms and no real row, in both tables.

## The hazard: 11 names exist ONLY as phantoms

There is no real-GUID row to fall back on for these, so deleting them removes
the name from the mirror entirely:

**Stock items (7)** — `BABY WALKER S.H. ( TIGER )`, `BICYCLE BRAVO 14T X 2.80`,
`BICYCLE BRAVO 16T X 2.125`, `BICYCLE BRAVO 20T X 2.125`,
`BICYCLE FLY CARRIER 26T DD DAR`, `BICYCLE SNOOPY 14T X 2.80`,
`BICYCLE SNOOPY 16T X 2.125`

**Ledgers (4)** — `AMRIT SALES ( INDIA )`, `Printing & Stationery`,
`SHARES (INVESTMENT) (500 SHARES OF NSE)`, `SK RABIUL ISLAM (NANDORAMPUR)`

These read like genuine masters that simply were not in the last masters pull.
`AMRIT SALES ( INDIA )` is already known: `dataset.ts` drops it at source as a
phantom, and it is the ledger behind cheque `CHQ-545/26-27`'s three refused
pushes.

**So: run a fresh masters sync FIRST.** If Tally has them, they arrive with real
GUIDs and the hazard disappears. Only the names still orphaned after that are a
judgement call, and the safe answer for those is to leave them.

## Nothing references these rows

No foreign key in the database points at `tally_stock_items`, `tally_ledgers`,
`tally_stock_groups`, `tally_units` or `tally_godowns` (checked via
`information_schema.referential_constraints`). Deleting a row orphans nothing at
the database level. Application code joins on NAME, not guid, which is why the
phantoms have been invisible rather than fatal.

## The steps

1. **Back up.** `scripts/backup-supabase.ts` — 31,772 rows, 87 tables. Guardrail
   P4. The irreplaceable config (discount rules, order groups, packing rules,
   unit overrides, vendor-group assignments) does not rebuild from Tally.
2. **Run a full masters sync** so the 11 orphan names get their real rows.
3. **Re-count**, and confirm the orphan list is empty or understood:

```sql
select 'stock_items' as tbl, count(*) filter (where not has_real) as orphan_names
from (select upper(trim(name)) n,
             bool_or(guid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]+$') has_real
      from tally_stock_items group by 1) s
union all
select 'ledgers', count(*) filter (where not has_real)
from (select upper(trim(name)) n,
             bool_or(guid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]+$') has_real
      from tally_ledgers group by 1) l;
```

4. **Dry run — count before deleting.** Expect 459 and 455, adjusted by whatever
   step 2 converted:

```sql
select 'tally_stock_items' t, count(*) from tally_stock_items
 where guid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]+$'
union all
select 'tally_ledgers', count(*) from tally_ledgers
 where guid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]+$';
```

5. **Delete, one table at a time, inside a transaction, with the count asserted.**
   The `RETURNING` count must match step 4 before committing.

```sql
begin;

-- Refuses to run if it would delete a name that has no real row behind it.
with orphan_names as (
  select upper(trim(name)) n from tally_stock_items
  group by 1
  having bool_or(guid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]+$') = false
)
delete from tally_stock_items
 where guid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]+$'
   and upper(trim(name)) not in (select n from orphan_names)
returning guid;

-- inspect the count, then either:
-- commit;
-- rollback;
```

Repeat for `tally_ledgers`. **Do not write a single statement that does both
tables** — if the second is wrong you want the first already committed and
verified, not rolled back together.

6. **Verify from the app, not from SQL.** Open the price list and the ledger
   list and confirm the counts read 499 items and ~489 ledgers as before. The
   app already dedupes by name (`richness()` in `dataset.ts` picks the more
   complete row), so a correct prune should change nothing on screen. If
   something disappears, the prune was wrong.

## What this does not fix

The phantoms came from `POST /api/supabase/sync` forwarding canonical masters at
all. The guard now rejects them, so they are dropped silently at the boundary.
Worth asking separately whether that route should be forwarding masters in the
first place, or whether it should refuse and say so — a route whose payload is
always discarded is a route doing nothing, and nothing on screen would say.
