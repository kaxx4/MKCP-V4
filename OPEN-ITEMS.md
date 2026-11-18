# Open items (sync agent), handed over 16-Nov-2026

Read this first when you resume, here or in a cloud session. The owner's planning folders (`MKCP\handoff\`, `MKCP\rebuild-plan\`) live only on the owner's laptop and are not in this repo. The web app's own list is `OPEN-ITEMS.md` in kaxx4/MKCPWEB. Tick an item off by deleting it, in the same commit as the fix.

## Where things stand (16-Nov-2026)

- `main` now equals `erp-rebuild` (fast-forward to cfca69a, the 1.5.17 agent window). `lane/tallycheck` holds nothing beyond it.
- Moving `main` released nothing: the agent updates only from published GitHub Releases (`public/autoUpdate.js`, `electron-builder.json5`). There are no GitHub Actions in this repo. A new release is still made only by the steps in `CLAUDE.md`, "Build and OTA release".
- The web app's sending to Tally is on (the web repo's `OPEN-ITEMS.md` has the switches and the undo scripts). The office PC agent claims the pushes and posts them through `tallyPost()`, `pushGuard` and `safePush`.
- The owner's laptop has the Tally role `sandbox`: it must never post to the live company.

## Waiting on the owner

1. **Office PC:** restart the agent on 1.5.17 (tag `v1.5.17`) so the office window shows the new layout.
2. **First real bill (M11):** check the first ERP bill the office agent posts against Tally (number, party, lines, GST, round-off).

## Code follow-ups

1. **Worktree `wt\erp-rebuild-agent`** on the owner's laptop: leave it as it is; it may hold the owner's uncommitted work.
2. **`server/scripts/probe-creditor-pan.ts`** is an untracked file in the owner's main checkout; it is the owner's, never commit or delete it without asking.
3. **`ENGINE_FORMULAS_FOR_WEB.md`** is stale on the discount (the web's rule is whole packages only, 19-Oct); the web's `engine/discounts.ts` is the one home.
4. **"Check again" readback (audit M1, lane/readback):** the agent half is built (`services/erpReadback.ts`) but answers nothing until the owner applies `erp_agent_readback_open` and `erp_agent_readback_answer` in the database, and it ships only with the next release. Until then the office agent logs one line and asks again every 15 minutes.

## Rules that still hold

Read `CLAUDE.md` before any change. Never write to the live Tally from a laptop; never restart Tally; no secrets, real names or GSTINs in commits or releases; the machine key never goes in a release or a chat.
