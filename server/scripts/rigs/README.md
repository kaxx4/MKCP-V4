# server/scripts/rigs

**Purpose:** the ERP rebuild's test rigs (task 1-0). Each prints a report and, with `--out <file.json>`, saves it.

**Lives here:**
- `test-queue-e2e.ts`: the laptop agent takes a ZZ TEST job from the live ERP test queue `erp_push_queue_test`, books it on the dummy Tally, reads it back, marks it, then sweeps the dummy and deletes its row. Also asks the fenced client for the real `push_queue` and `claim_push_jobs` and expects refusals. Needs the Tally slot and `MKCP_ERP_TEST_QUEUE=on` for that one process.
- `r1-replay-and-mock.ts`: R1, the captured-fixture replay suites plus 20 jobs through the claim path against the simulated Tally. Offline.
- `r2-fault-proxy.ts`: R2, one fault at a time between the agent and Tally and between the agent and the queue. Offline. A failed scenario is a finding for task 1-3.
- `r3-crowd.ts`: R3, 10 people, 60 pushes, 100 reading connections, 3 agents, on the live test queue with the simulated Tally. Deletes its rows.
- `r7-chaos.ts`: R7, a timed schedule of Tally faults and agent kills over 30 jobs. Offline.
- `mirror-sync-dummy.ts`: task 1-5, the ERP mirror sync on the dummy Tally at volume: the busiest window of days the rig can read (a few hundred vouchers, picked from Tally's own count per day) into the ERP's own test mirror (`erp_mirror_rows`, a ZZTEST company key, names scrubbed with a keyed hash), step by step in `erp_sync_runs`; the mirror matches Tally's count; a repeat full sync changes nothing; a busy day forced empty is refused by the per-day floor and a re-read then swaps; one ZZTEST Contra is picked up by the incremental; after the sweep Tally's highest AlterID falls below the mark, the incremental is refused ("needs a full run"), and the full run prunes the Contra and lowers the mark. Needs the Tally slot and `MKCP_ERP_TEST_QUEUE=on` for that one process.
- `bank-mail-dummy.ts`: lane T7m, the laptop's half of the bank-mail test, in three modes. `--ledgers` (read only) lists the ZZ TEST ledgers, says whether HDFC BANK exists and takes a voucher census. `--book --job <uuid>` has the ERP job agent claim and book that one test job (refuses unless it is the only claimable test job) and prints the voucher read back from Tally. `--sweep --job <uuid> --census-from <ledgers.json>` deletes that voucher and the job's live rows and compares the census. It never creates or submits a draft: that runs on the server. Test bank-mail vouchers are numbered ZZTESTBM plus 8 hex characters, which the shared sweep and census patterns do not match, so this rig has its own strict guard. Needs the Tally slot and `MKCP_ERP_TEST_QUEUE=on` for that one process.
- `lib/simTally.ts`: the simulated Tally at the `safePush` seam, with its fault switch.
- R5 (shadow compare) is in the web repo, `web-dashboard/src/lib/rigs/`. R4 (the bench) does not exist (decision D-1-0.1v). R6 is built in task 1-7, R8 and R9 in task 1-9.

**Never here:** anything that writes a table main uses, or a Tally write without `guardScriptWrites`.

**Owner:** lane T2 Plumbing.
