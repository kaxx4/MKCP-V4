/** Stage 6 — the trigger routine. Run on demand or hourly. */
import { runStatusCheck, formatStatus } from "../src/services/statusRoutine.js";

const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";
const days = parseInt(process.argv.find(a => /^\d+$/.test(a)) ?? "7", 10);

runStatusCheck(TALLY_URL, { reconcileDays: days })
  .then(r => {
    console.log("\n" + formatStatus(r) + "\n");
    if (process.argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
    process.exit(r.overall === "alert" ? 1 : 0);
  })
  .catch(e => { console.error(`✗ status check failed: ${e.message}`); process.exit(1); });
