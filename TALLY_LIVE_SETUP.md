# TallyPrime Live Integration Setup Guide

## Overview

The MKCP Dashboard now supports **live TallyPrime integration** via a local Express proxy server. Data syncs automatically from Tally running on your machine in real-time.

## Architecture

```
┌─────────────────────┐     JSON      ┌─────────────────────┐     XML       ┌──────────────┐
│  React Frontend     │ ────────────► │  Express Proxy      │ ────────────► │ TallyPrime  │
│  (Vite, port 5173)  │  fetch()     │  (Node, port 3100)   │  HTTP POST   │ (port 9000) │
│                     │              │  xml2js conversion   │              │             │
│  src/api/tally.ts   │              │  server/index.ts     │              │ Company DB  │
└─────────────────────┘              └─────────────────────┘              └──────────────┘
```

- **Frontend**: React app makes JSON API calls to proxy
- **Proxy**: Converts JSON ↔ Tally XML format, handles communication
- **TallyPrime**: Runs locally with ODBC server enabled on port 9000

## Prerequisites

1. **TallyPrime** installed and running
2. **Node.js** v18+ installed
3. **npm** or **pnpm** package manager
4. **Company loaded** in TallyPrime

## Step 1: Enable TallyPrime ODBC Server

1. Open TallyPrime (Run as Administrator)
2. Navigate to: **Gateway of Tally → F12 (Configure) → Advanced Configuration**
3. Set **Enable ODBC Server** = **Yes**
4. Set **Port Number** = **9000**
5. Press **Ctrl+A** to save
6. Tally will restart automatically
7. Load your company (e.g., MK CYCLES)

## Step 2: Install Dependencies

Open terminal in the project root:

```bash
# Install frontend dependencies
npm install

# Install proxy server dependencies
cd server
npm install
cd ..
```

## Step 3: Start the Application

You have two options:

### Option A: Start Both Together (Recommended)

```bash
npm run dev
```

This starts:
- Proxy server on `http://localhost:3100`
- React app on `http://localhost:5173`

### Option B: Start Separately

Terminal 1 (Proxy):
```bash
cd server
npm run dev
```

Terminal 2 (Frontend):
```bash
npm run dev:app
```

## Step 4: Connect to Tally

1. Open browser at `http://localhost:5173`
2. Go to **Import** page
3. Click **"Live Tally Connection"** tab
4. You should see:
   - ✅ **Connected to Tally** (green) if Tally is running
   - ❌ **Not Connected** (red) if Tally is not running

5. Enter your **Company Name** (must match exactly as in Tally, e.g., "MK CYCLES")
6. Set **FY Date Range**:
   - From: `20240401` (April 1, 2024)
   - To: `20250331` (March 31, 2025)
7. Click **"Sync Now"**

## Step 5: Verify Data

After sync completes:
1. Review the **Import Summary** showing items, ledgers, and vouchers
2. Click **"Accept & Continue to Orders"**
3. Your live Tally data is now loaded!

## Features

### 1. Live Sync
- One-click sync from **Import → Live Tally** tab
- Pulls fresh data from Tally: stock items, ledgers, vouchers
- Uses existing parsers (zero changes to business logic)

### 2. Auto-Sync (Background)
- Configure in **Settings → Tally Connection**
- Options: 5min, 15min, 30min, 1hr
- Runs automatically in background
- Shows toast notification on completion

### 3. Connection Status Indicator
- Green dot in sidebar = Connected
- Red dot = Disconnected
- Click to navigate to Import page
- Shows last sync time on hover

### 4. Fallback to JSON Upload
- **Import → Upload JSON Files** tab still works
- Use this if Tally is not running
- Perfect for offline work or demo data

## Settings

Go to **Settings → Tally Connection** to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| **Proxy URL** | `http://localhost:3100` | Express proxy endpoint |
| **Company Name** | _(empty)_ | Tally company name (case-sensitive) |
| **FY From Date** | `20240401` | Financial year start (YYYYMMDD) |
| **FY To Date** | `20250331` | Financial year end (YYYYMMDD) |
| **Auto-Sync** | Disabled | Automatic sync interval |

## Troubleshooting

### ❌ "Tally Not Connected"

**Problem**: Proxy can't reach Tally

**Solutions**:
1. Ensure Tally is running
2. Verify ODBC server is enabled (Gateway → F12 → Advanced Config)
3. Check port 9000 is open (not blocked by firewall)
4. Try running Tally as Administrator

### ❌ "Proxy server not reachable"

**Problem**: Frontend can't reach proxy

**Solutions**:
1. Ensure proxy is running: `cd server && npm run dev`
2. Check `http://localhost:3100/api/tally/health` in browser
3. Restart proxy server

### ❌ "Company not found"

**Problem**: Company name mismatch

**Solutions**:
1. Verify company is loaded in Tally
2. Check exact spelling and capitalization
3. Try company name from Tally's title bar

### ⚠ Sync takes too long

**Problem**: Large datasets slow down sync

**Solutions**:
1. Narrow FY date range (sync only needed months)
2. First sync is slowest; subsequent syncs are faster
3. Disable auto-sync if network is slow

### ⚠ Some vouchers missing

**Problem**: Date filter excluding vouchers

**Solutions**:
1. Expand FY date range in Settings
2. Check voucher dates in Tally
3. Re-sync after adjusting dates

## API Endpoints

The proxy exposes these endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tally/health` | Check Tally connection |
| GET | `/api/tally/company` | Get active company info |
| GET | `/api/tally/masters?company=X` | Fetch stock items + ledgers |
| GET | `/api/tally/vouchers?company=X&from=...&to=...` | Fetch vouchers |
| POST | `/api/tally/sync` | Full sync (masters + transactions) |
| POST | `/api/tally/push/voucher` | Write voucher to Tally (future) |

## File Structure

```
server/
├── package.json           # Proxy dependencies
├── tsconfig.json          # TypeScript config
└── src/
    ├── index.ts           # Express entry point
    ├── tallyXml.ts        # XML ↔ JSON converters
    └── routes/
        ├── health.ts      # Connection check
        ├── company.ts     # Company info
        ├── masters.ts     # Stock items + ledgers
        ├── vouchers.ts    # Voucher data
        ├── sync.ts        # Full sync
        └── push.ts        # Write to Tally

src/
├── api/
│   └── tallyApi.ts        # Frontend API service
├── store/
│   └── tallyStore.ts      # Tally connection state (Zustand)
├── hooks/
│   └── useTallyAutoSync.ts  # Background sync hook
└── pages/
    └── Import.tsx         # Dual-tab UI (Live + Upload)
```

## Important Notes

1. **Zero Changes to Parsers**: The existing `masterParser.ts` and `transactionParser.ts` are **unchanged**. The proxy converts Tally's XML into the exact `tallymessage` JSON format these parsers already consume.

2. **All Features Work**: Orders, Invoices, Reports, Alerts, Predictions — everything works identically whether data comes from live Tally or uploaded JSON.

3. **Data Privacy**: All data stays **local**. The proxy runs on `localhost:3100`, frontend on `localhost:5173`. Nothing is sent to external servers.

4. **Backup Recommendation**: Before first live sync, create a backup of your existing data using **Settings → Backups → Download Backup**.

5. **Production Use**: For production deployment:
   - Set `TALLY_URL` environment variable for remote Tally
   - Update `VITE_TALLY_PROXY` for hosted proxy
   - Configure CORS appropriately

## Development

```bash
# Frontend only
npm run dev:app

# Proxy only
cd server && npm run dev

# Both together
npm run dev

# Build frontend
npm run build

# Build proxy
npm run build:proxy
```

## Environment Variables

**Frontend** (`.env`):
```
VITE_TALLY_PROXY=http://localhost:3100
```

**Proxy** (server environment):
```
TALLY_URL=http://localhost:9000
PORT=3100
```

## Support

If you encounter issues:
1. Check browser console for frontend errors
2. Check proxy terminal for server errors
3. Verify Tally ODBC server status
4. Review this README's Troubleshooting section

---

**Congratulations!** Your MKCP Dashboard is now connected to TallyPrime. 🎉

Enjoy real-time data syncing and all existing features working seamlessly with live Tally data.
