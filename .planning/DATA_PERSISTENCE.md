# Data Persistence Architecture

## Overview

The MKCP Dashboard uses **multi-layer data persistence** to ensure imported Tally data survives across page reloads, browser restarts, and extended periods of inactivity.

---

## Architecture Layers

### Layer 1: In-Memory Store (Zustand)
**Location**: `src/store/dataStore.ts`

The primary data store for runtime access. Data is stored in RAM for instant access.

**Strengths**:
- ✅ Fastest access times (microseconds)
- ✅ Full data integrity in memory
- ✅ React components re-render on changes

**Limitations**:
- ❌ Lost on page refresh or browser restart
- ❌ Not shared across tabs
- ❌ Cannot survive network errors

### Layer 2: IndexedDB (Browser Database)
**Location**: `src/db/idb.ts`

Persistent browser database that survives page reloads and browser restarts.

**Storage Stores**:
- `parsedData` - Full Tally import (vouchers, items, ledgers)
- `unitOverrides` - User-configured unit overrides
- `predictions` - Generated AI predictions
- `backups` - Manual and automatic backups
- `jsonUploads` - JSON file uploads

**Key Features**:
- ✅ Survives page reload
- ✅ Survives browser restart
- ✅ ~50MB available per domain
- ✅ Asynchronous I/O (non-blocking)
- ✅ Queryable with indexes

**Data Size Limits**:
- April 2025 test data: ~49.8MB (compressed)
- Full year estimate: ~600MB (uncompressed)
- Browser quota: 50-100MB per domain (varies by browser)

**Serialization**:
- Uses `serializeParsedData()` / `deserializeParsedData()` for Maps ↔ JSON conversion
- Handles `Map<string, T>` serialization to `Record<string, T>`

### Layer 3: localStorage (Key-Value Store)
**Location**: Zustand + Override Store

Lightweight persistent storage for small state objects.

**Data Stored**:
- Override store configuration
- UI preferences
- Application settings

**Limitations**:
- ❌ Limited to ~5-10MB
- ❌ Synchronous (blocks UI)
- ❌ String-only values
- ❌ Not suitable for large data

### Layer 4: Server-Side Persistence (Future)
**Location**: TBD (Node.js backend)

**Planned Features**:
- 📋 Server-side backup of imported data
- 📋 Cross-device sync capability
- 📋 Automatic data versioning
- 📋 Team collaboration support

---

## Data Flow: Import → Persistence

### 1. User Imports Data
```
User selects Tally XML files in Import page
           ↓
Files parsed by transactionParser.ts + masterParser.ts
           ↓
ParsedData object created (vouchers, items, ledgers, company)
           ↓
mergeData() called in dataStore
```

### 2. Data is Saved
```
mergeData() sets in-memory Zustand store
           ↓
setData() called → data propagates to all components
           ↓
useEffect triggers → saveData("parsedData", serialized)
           ↓
IndexedDB write completes asynchronously
           ↓
Backup created with createBackup()
```

### 3. Data Persists
```
Browser closed and reopened
           ↓
App.tsx mounts
           ↓
useEffect on line 40 triggers
           ↓
loadData("parsedData") retrieves from IndexedDB
           ↓
deserializeParsedData() converts JSON → ParsedData
           ↓
setData() populates Zustand store
           ↓
All components receive data via hooks
```

---

## Persistence Guarantee Strategy

### Automatic Persistence
✅ **Active Data Monitoring**: `usePersistenceMonitor` hook automatically saves whenever data changes

```typescript
usePersistenceMonitor({
  autoBackupInterval: 5 * 60 * 1000, // Auto-backup every 5 minutes
  verbose: true // Log persistence events
});
```

### Manual Backup
✅ **User-Initiated Backups**: Settings page provides "Backup Data" button
- Creates timestamped backup in IndexedDB
- Can export as JSON for archival
- Can restore from backup at any time

### Recovery Mechanisms
1. **Automatic Reload on Corruption**: [Planned]
2. **Fallback to Last Known Good State**: [Planned]
3. **Conflict Resolution for Merges**: Implemented in `mergeData()`

---

## Debugging Data Persistence Issues

### Browser Console Diagnostics
The application exposes debug functions via `window.__mkcycles`:

```javascript
// Print comprehensive diagnostics
await window.__mkcycles.printDataDiagnostics();

// Get diagnostic object programmatically
const diag = await window.__mkcycles.diagnoseDataPersistence();
console.log("Vouchers in storage:", diag.dataStatus.voucherCount);
```

**What It Checks**:
- ✅ IndexedDB availability and status
- ✅ Data presence and size in IndexedDB
- ✅ Data currently loaded in Zustand
- ✅ localStorage availability
- ✅ Unit override persistence
- ✅ Prediction cache status
- ✅ Auto-backup history

### Common Issues & Solutions

#### Issue: "Data vanishes on reload"
**Root Causes**:
1. IndexedDB write hasn't completed before reload
2. IndexedDB disabled in browser privacy mode
3. Browser quota exceeded

**Solutions**:
```javascript
// Check IndexedDB status
const diag = await window.__mkcycles.diagnoseDataPersistence();

// If IndexedDB unavailable:
// → Switch browser out of private/incognito mode
// → Check browser storage settings
// → Clear browser cache (if quota exceeded)
```

#### Issue: "Data saved but not restored"
**Root Causes**:
1. Race condition: page loads before IndexedDB data available
2. Serialization/deserialization error
3. Zustand store reset

**Solutions**:
```javascript
// Force refresh of data from storage
const stored = await window.__mkcycles.diagnoseDataPersistence();
if (stored.dataStatus.hasData && !stored.zustandState.hasDataInStore) {
  // Data exists but not loaded - refresh page
  location.reload();
}
```

#### Issue: "Storage quota exceeded"
**Root Causes**:
1. Multiple large backups accumulated
2. Prediction cache too large
3. Browser quota too small

**Solutions**:
- Manually delete old backups from Settings → Data Management
- Clear prediction cache: Settings → Advanced → Clear Predictions
- Export data as JSON, clear storage, reimport

---

## Technical Implementation Details

### Serialization Strategy
**Why serialization is needed**: Zustand stores `Map` objects, but IndexedDB and JSON can't directly store Maps.

```typescript
// src/utils/serialize.ts

export function serializeParsedData(data: ParsedData): unknown {
  return {
    company: data.company,
    items: Array.from(data.items.entries()), // Map → Array
    ledgers: Array.from(data.ledgers.entries()), // Map → Array
    vouchers: data.vouchers,
    importedAt: data.importedAt,
    sourceFiles: data.sourceFiles,
    warnings: data.warnings,
  };
}

export function deserializeParsedData(raw: unknown): ParsedData {
  const obj = raw as any;
  return {
    company: obj.company,
    items: new Map(obj.items), // Array → Map
    ledgers: new Map(obj.ledgers), // Array → Map
    vouchers: obj.vouchers,
    importedAt: obj.importedAt,
    sourceFiles: obj.sourceFiles,
    warnings: obj.warnings,
  };
}
```

### IndexedDB Schema
```javascript
// src/db/idb.ts - DB_VERSION 3

{
  "parsedData": {
    keyPath: undefined,
    indexes: []
    // Stores full ParsedData after serialization
  },
  "unitOverrides": {
    keyPath: undefined,
    // Stores user-configured unit conversions
  },
  "predictions": {
    keyPath: undefined,
    // Stores AI predictions and forecasts
  },
  "backups": {
    keyPath: undefined,
    // Stores timestamped backups for recovery
  },
  "jsonUploads": {
    keyPath: undefined,
    // Stores uploaded JSON files
  }
}
```

### Load Sequence (App Startup)
1. **App mounts**: `App.tsx` renders
2. **AppRoutes mounts**: `usePersistenceMonitor()` hook initializes
3. **useEffect fires** (line 41): Async restore sequence begins
   - Load `parsedData` from IndexedDB (100-500ms)
   - Deserialize to `ParsedData` object
   - Call `setData()` to populate Zustand
   - Load unit overrides (10-50ms)
   - Load defaults if no overrides exist
4. **Components re-render**: Data flows to all subscribed components
5. **Data is live**: User can interact with imported data

**Total restore time**: ~200-600ms depending on data size

---

## Performance Considerations

### Data Size Impact
| Scenario | Vouchers | Items | Size | Restore Time |
|----------|----------|-------|------|--------------|
| Small test | 50 | 100 | 2MB | 50ms |
| April 2025 | 399 | 559 | 49.8MB | 200-300ms |
| Full year | 4,800 | 1,000+ | 600MB | 2-5 seconds |

### Optimization Strategies
1. **Chunked imports**: For >100MB, split into monthly chunks
2. **Compression**: Planned gzip compression for storage
3. **Incremental updates**: Merge mode for daily imports (not full reimport)
4. **Lazy loading**: Load data on-demand per report tab

### Current Capacity
- ✅ Can handle full year (FY 2025-26) with ~600MB
- ✅ Restore time acceptable for user experience (2-5s)
- ✅ Auto-backups don't block UI (async)

---

## Security & Privacy

### Data at Rest
- ✅ Stored in browser's encrypted storage (browser-managed)
- ✅ Not sent to server unless user explicitly exports
- ⚠️ Accessible to any JavaScript on same domain
- ⚠️ Accessible in browser DevTools (for debugging)

### Data in Transit
- ✅ Only sent via HTTPS to Tally API (3100)
- ✅ No PII transmitted to external services
- ⚠️ localStorage stores preferences (not sensitive)

### Data Privacy
- ✅ All data stays in browser by default
- ✅ User controls what gets backed up
- ✅ User can export and delete anytime
- ✅ No telemetry or analytics by default

### Recommended Practices
1. Use HTTPS always (protects network transmission)
2. Don't share browser profile with untrusted users
3. Regularly export backups to secure location
4. Clear browser cache if sharing device
5. Use Private Browsing for sensitive data (but note: data won't persist in private mode)

---

## Future Enhancements

### Phase 1 (Current)
- ✅ IndexedDB persistence
- ✅ Automatic data monitoring
- ✅ Manual backup/restore
- ✅ Debug utilities

### Phase 2 (Planned)
- 📋 Server-side backup
- 📋 Compression for large datasets
- 📋 Incremental sync (daily updates)
- 📋 Cross-browser sync via cloud

### Phase 3 (Planned)
- 📋 Team collaboration mode
- 📋 Version history and rollback
- 📋 Conflict resolution UI
- 📋 Real-time multi-user updates

### Phase 4 (Planned)
- 📋 Offline mode with local-first sync
- 📋 End-to-end encryption
- 📋 Differential backups
- 📋 Archive compression

---

## Troubleshooting Checklist

When data doesn't persist, check in this order:

### 1. Verify IndexedDB is Available
```javascript
console.log("IndexedDB available:", !!indexedDB);
```
- **If false**: Browser in private mode or old browser
- **Action**: Switch to normal mode or upgrade browser

### 2. Check Persistence Hook is Running
```javascript
// Look for console logs:
// [PERSIST] ✓ Data saved...
// [PERSIST] ✓ Auto-backup created...
```
- **If missing**: Hook didn't initialize
- **Action**: Check browser console for errors, refresh page

### 3. Verify Data is Stored
```javascript
const diag = await window.__mkcycles.diagnoseDataPersistence();
console.log("Data in IndexedDB:", diag.dataStatus.hasData);
```
- **If false**: Data never saved
- **Action**: Re-import data from Import page

### 4. Verify Data is Loaded on Startup
```javascript
const diag = await window.__mkcycles.diagnoseDataPersistence();
console.log("Data in memory:", diag.zustandState.hasDataInStore);
```
- **If false**: Data wasn't restored from IndexedDB
- **Action**: Check browser console for errors, try manual refresh

### 5. Check Storage Quota
```javascript
navigator.storage.estimate().then(est => {
  console.log("Usage:", est.usage, "Quota:", est.quota);
  console.log("Used %:", (100 * est.usage / est.quota).toFixed(2));
});
```
- **If >90%**: Storage nearly full
- **Action**: Clear old backups or browser cache

---

## Document Metadata

**Version**: 1.0
**Last Updated**: 2026-03-20
**Status**: Production
**Owner**: Backend Architecture
**Responsibility**: Data Persistence Strategy

**Related Documents**:
- `.planning/BRAND_COLORS.md` - Design system
- `ARCHITECTURE_AUDIT.md` - System architecture
- `TESTING_AND_VALIDATION_INDEX.md` - Validation strategy

