import express from "express";
import cors from "cors";
import { healthHandler, companyHandler, syncHandler, mastersHandler, vouchersHandler, debugHandler } from "./handlers.js";

const app = express();
const PORT = 3100;
const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Inject config
app.use((req, _res, next) => {
  (req as any).tallyUrl = TALLY_URL;
  next();
});

// Routes
app.get("/api/tally/health", healthHandler);
app.get("/api/tally/company", companyHandler);
app.get("/api/tally/masters", mastersHandler);
app.get("/api/tally/vouchers", vouchersHandler);
app.post("/api/tally/sync", syncHandler);
app.post("/api/tally/debug", debugHandler);

app.listen(PORT, () => {
  console.log(`\n✅ MKCP Tally Proxy on http://localhost:${PORT}`);
  console.log(`   Tally target: ${TALLY_URL}\n`);
});

declare global { namespace Express { interface Request { tallyUrl: string } } }
