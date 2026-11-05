# server/scripts/rigs

**Purpose:** the ERP rebuild's test rigs (task 1-0). Each prints a report and, with `--out <file.json>`, saves it.

**Lives here:**
- `test-queue-e2e.ts`: the laptop agent takes a ZZ TEST job from the live ERP test queue `erp_push_queue_test`, books it on the dummy Tally, reads it back, marks it, then sweeps the dummy and deletes its row. Also asks the fenced client for the real `push_queue` and `claim_push_jobs` and expects refusals. Needs the Tally slot and `MKCP_ERP_TEST_QUEUE=on` for that one process.
- `r1-replay-and-mock.ts`: R1, the captured-fixture replay suites plus 20 jobs through the claim path against the simulated Tally. Offline.
- `r2-fault-proxy.ts`: R2, one fault at a time between the agent and Tally and between the agent and the queue. Offline. A failed scenario is a finding for task 1-3.
- `r3-crowd.ts`: R3, 10 people, 60 pushes, 100 reading connections, 3 agents, on the live test queue with the simulated Tally. Deletes its rows.
- `r7-chaos.ts`: R7, a timed schedule of Tally faults and agent kills over 30 jobs. Offline.
- `mirror-sync-dummy.ts`: task 1-5, the ERP mirror sync on the dummy Tally: seven days ending on the dummy's latest voucher date into the ERP's own test mirror (`erp_mirror_rows`, a ZZTEST company key, names scrubbed), step by step in `erp_sync_runs`; a repeat full sync changes nothing; one ZZTEST Contra is picked up by the incremental sync and the mark moves; after the sweep the next full sync prunes it. Needs the Tally slot and `MKCP_ERP_TEST_QUEUE=on` for that one process.
- `lib/simTally.ts`: the simulated Tally at the `safePush` seam, with its fault switch.
- R5 (shadow compare) is in the web repo, `web-dashboard/src/lib/rigs/`. R4 (the bench) does not exist (decision D-1-0.1v). R6 is built in task 1-7, R8 and R9 in task 1-9.

**Never here:** anything that writes a table main uses, or a Tally write without `guardScriptWrites`.

**Owner:** lane T2 Plumbing.
