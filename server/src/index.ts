import express from "express";
import cors from "cors";
import { mastersRouter } from "./routes/masters.js";
import { vouchersRouter } from "./routes/vouchers.js";
import { companyRouter } from "./routes/company.js";
import { healthRouter } from "./routes/health.js";
import { syncRouter } from "./routes/sync.js";
import { pushRouter } from "./routes/push.js";
import { debugRouter } from "./routes/debug.js";

const app = express();
const PORT = 3100;
const TALLY_URL = process.env.TALLY_URL || "http://127.0.0.1:9000";

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" }));

// Inject Tally URL into all routes
app.use((req, _res, next) => {
  req.tallyUrl = TALLY_URL;
  next();
});

app.use("/api/tally", healthRouter);
app.use("/api/tally", companyRouter);
app.use("/api/tally", mastersRouter);
app.use("/api/tally", vouchersRouter);
app.use("/api/tally", syncRouter);
app.use("/api/tally", pushRouter);
app.use("/api/tally", debugRouter);

app.listen(PORT, () => {
  console.log(`✅ MKCP Tally Proxy running on http://localhost:${PORT}`);
  console.log(`  → Tally target: ${TALLY_URL}`);
});

// Type augmentation for Express
declare global {
  namespace Express {
    interface Request {
      tallyUrl: string;
    }
  }
}
