# Tally Connection Error - Quick Fix Guide

## Symptoms
- Frontend shows "Not Connected" or "Tally Offline"
- Connection error when trying to sync

## Root Cause
The company info fetch XML format may be incompatible with your Tally Prime version.

## Quick Fix Solution

### Option 1: Skip Company Name Auto-Detection (Recommended)

Instead of relying on auto-detection, **manually enter your company name**:

1. Open TallyPrime
2. Note the EXACT company name (from title bar or company select screen)
3. In the dashboard Import page:
   - Enter company name EXACTLY as shown in Tally (case matters!)
   - Example: `MK CYCLES` or `MK_CYCLES` or whatever shows in Tally
4. Click "Sync Now"

### Option 2: Use Settings Page

1. Go to **Settings** → **Tally Connection**
2. Enter the company name manually
3. Click "Test Connection"
4. Once connected, go back to Import and sync

## Testing Connection

Run this in a separate terminal to test if Tally is responding:

```bash
curl http://localhost:9000
```

Expected response: Some XML (even an error XML is OK - it means Tally is listening)

## Common Issues

### 1. "ECONNRESET" Error

**Solution**: Restart Tally's ODBC server
- Gateway of Tally → F12 → Advanced Configuration
- Toggle "Enable ODBC Server" to No, then back to Yes
- Port = 9000
- Ctrl+A to save

### 2. "Connection Refused"

**Solutions**:
- Ensure Tally is running
- Check Gateway → F12 → ODBC Server = Yes
- Verify port 9000 in Advanced Configuration
- Run Tally as Administrator

### 3. "Company Not Found"

**Solutions**:
- Company must be LOADED in Tally (not just Tally running)
- Company name is case-sensitive
- Try copying company name directly from Tally

### 4. Firewall Blocking

**Solution**:
```cmd
# Run as Administrator
netsh advfirewall firewall add rule name="Tally ODBC" dir=in action=allow protocol=TCP localport=9000
```

## Manual Test Steps

### Step 1: Check Tally is Running
```bash
netstat -ano | findstr :9000
```
Should show: `LISTENING` on port 9000

### Step 2: Check Proxy is Running
```bash
netstat -ano | findstr :3100
```
Should show: `LISTENING` on port 3100

### Step 3: Test Health Endpoint
```bash
curl http://localhost:3100/api/tally/health
```
Should return: `{"connected":true,"status":200,"tallyUrl":"http://localhost:9000"}`

### Step 4: Test Sync (Replace COMPANY_NAME)
```bash
curl -X POST http://localhost:3100/api/tally/sync ^
  -H "Content-Type: application/json" ^
  -d "{\"company\":\"MK CYCLES\",\"fromDate\":\"20240401\",\"toDate\":\"20250331\"}"
```

## Workaround: Use JSON Upload

If Tally connection continues to fail:

1. Export data from Tally:
   - Gateway → Display → Statements of Accounts → Stock Summary
   - Gateway → Display → Statements of Accounts → Voucher Register
   - Export each as XML
   - Convert to JSON using provided converters

2. Use **Import → Upload JSON Files** tab (fallback mode)

## Still Not Working?

### Check These:

1. **Tally Version**: Ensure TallyPrime Release 3.0 or later
2. **Company Loaded**: A company must be open in Tally
3. **Port Conflicts**: Nothing else using port 9000 or 3100
4. **Permissions**: Run both Tally and the proxy as Administrator

### Enable Debug Logging:

Edit `server/src/index.ts` and add after line 20:

```typescript
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});
```

Restart proxy and check console for errors.

## Success Indicators

✅ Health endpoint returns `connected: true`
✅ Company name auto-fills after first sync
✅ Green dot shows in sidebar
✅ Last sync time updates
✅ Data appears in Orders/Dashboard

---

**Need More Help?**

Check the full [TALLY_LIVE_SETUP.md](TALLY_LIVE_SETUP.md) guide for detailed troubleshooting.
