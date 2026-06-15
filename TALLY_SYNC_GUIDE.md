# Tally Sync Troubleshooting Guide

## ❌ Tally Sync Not Working

The error "Tally sync not working" typically means **Tally Prime is not running or not accessible**.

### Prerequisites

Before syncing with Tally, you MUST have:

1. **Tally Prime Installed** — Not Tally.ERP9
2. **Tally Gateway Enabled** — This exposes an HTTP API on port 9000
3. **Company Configured** — Must match exactly: `M.K.CYCLES (P) LTD.`

---

## Step 1: Start Tally Prime

1. Open **Tally Prime** on your machine
2. Go to **Gateway > Enable Gateway** (or check it's already enabled)
3. Verify the gateway is listening on **localhost:9000**

The console log should show something like:
```
Gateway activated at http://localhost:9000
```

---

## Step 2: Verify Tally Connection

Run the connection test:

```bash
node server/test-tally.js
```

**Expected output:**
```
✅ SUCCESS: Tally is reachable and responding
   Status: 200
   Response length: XXX bytes
```

---

## Step 3: Check Company Name

The company name in the dashboard MUST match Tally EXACTLY:

**Required:** `M.K.CYCLES (P) LTD.`

If your Tally has a different name, update it or create an alias:
1. In Tally: **Gateway > Company Settings**
2. Ensure the full legal name is set
3. It's case-sensitive and spaces/punctuation matter

---

## Step 4: Launch the Dashboard

Once Tally is running and the test passes:

1. **If running from source:**
   ```bash
   npm run dev:electron
   ```

2. **If running from installer:**
   - Launch `MK Cycles Dashboard Setup 1.0.0.exe`
   - Double-click to start

---

## Step 5: Trigger Sync

In the Dashboard:

1. Go to **Import** page
2. Click **Quick Sync** button (or **Manual Sync**)
3. Watch the sync log for progress

---

## 🔍 Common Errors & Fixes

### Error: "ECONNREFUSED localhost:9000"
**Cause:** Tally is not running or gateway is not enabled  
**Fix:**
1. Open Tally Prime
2. Go to Gateway menu → Enable Gateway
3. Restart the Dashboard app

### Error: "Tally connection timeout"
**Cause:** Tally is slow to respond  
**Fix:**
1. Close other apps to free up RAM
2. Restart Tally Prime
3. Increase timeout in settings (default: 5 minutes)

### Error: "Company not found"
**Cause:** Company name doesn't match  
**Fix:**
1. Check Tally's company name in Gateway settings
2. Verify spelling and spaces match exactly
3. Update Dashboard config if needed

### Error: "Invalid XML response"
**Cause:** Tally version incompatibility  
**Fix:**
1. Update Tally Prime to latest version
2. Restart Tally and try again

---

## 🖥️ Node.js 20 Websocket Warning

The warning "Node.js 20 detected without native websocket support" is **NOT an error**. It's an informational message from some dependencies and can be safely ignored. The Dashboard doesn't use websockets — it uses HTTP for Tally communication.

---

## ✅ Verification Checklist

- [ ] Tally Prime is installed and running
- [ ] Gateway is enabled (menu: Gateway > Enable Gateway)
- [ ] Test passes: `node server/test-tally.js`
- [ ] Company name matches exactly: `M.K.CYCLES (P) LTD.`
- [ ] Dashboard app is running
- [ ] Click "Quick Sync" and watch the logs

---

## 📊 What Gets Synced

When sync completes successfully:

- **Masters** (4 parallel requests):
  - Stock Groups
  - Units
  - Godowns
  - Cost Centres

- **Sequentially**:
  - Stock Items (∼600)
  - Ledgers (∼500)
  - Dealer Price Lists

- **Vouchers** (monthly chunks):
  - Sales invoices
  - Purchase orders
  - Receipts & payments
  - Journal entries

- **Supabase** (automatic):
  - All data pushed to cloud database
  - Visible in dashboard after sync

---

## 🛠️ Manual Testing

To test without the Dashboard app:

```bash
cd server
npm install
npm run dev
# Server starts on http://localhost:3100

# In another terminal:
curl -X POST http://localhost:3100/api/sync \
  -H "Content-Type: application/json" \
  -d '{"tallyUrl":"http://localhost:9000","company":"M.K.CYCLES (P) LTD."}'
```

---

## 📞 Still Not Working?

1. **Verify Tally is actually running:**
   - Open Task Manager
   - Look for "Tally.exe" or "TallyPrime.exe"

2. **Check network connectivity:**
   ```bash
   ping localhost:9000
   netstat -ano | findstr :9000
   ```

3. **Check Windows Firewall:**
   - Allow port 9000 through firewall
   - Settings > Firewall > Allow an app

4. **Restart everything:**
   - Close Tally Prime
   - Close Dashboard
   - Restart computer (if still failing)
   - Start Tally first, then Dashboard

---

## 📝 Server Logs

Check server logs for detailed error messages:

**In Dashboard:**
- Go to Import page → Scroll down to see sync logs
- Click "Show Supabase Status" for cloud sync details

**From terminal:**
```bash
cd server
npm run dev
# Watch console for [MASTERS], [VOUCHERS], [Supabase] logs
```
