import json

# Read real master data
with open('C:/Users/kanis/Desktop/MKCP/TALLY JSON/Master.json', encoding='utf-16') as f:
    mdata = json.load(f)

msgs = mdata.get('tallymessage', [])

# Get 5 stock items with opening balance
items_found = []
for m in msgs:
    if m.get('metadata', {}).get('type') == 'Stock Item':
        if 'openingbalance' in m and m['openingbalance']:
            items_found.append(m)
            if len(items_found) >= 5:
                break

# Get ledgers (3 debtors/creditors)
ledgers_found = []
for m in msgs:
    if m.get('metadata', {}).get('type') == 'Ledger':
        parent = str(m.get('parent', '')).lower()
        if 'sundry' in parent and 'openingbalance' in m:
            ledgers_found.append(m)
            if len(ledgers_found) >= 3:
                break

print("Items:", [i['metadata']['name'] for i in items_found])
print("Ledgers:", [l['metadata']['name'] for l in ledgers_found])

# Write sample masters.json
masters_sample = {
    "tallymessage": [
        {
            "metadata": {"type": "Company", "name": "MK CYCLES"},
            "name": "MK CYCLES",
            "gstin": "19AADCM6953C1ZE",
            "fystart": 4
        }
    ] + items_found[:5] + ledgers_found[:3]
}

with open('C:/Users/kanis/Desktop/MKCP/mkcycles-dashboard/public/sample/masters.json', 'w', encoding='utf-8') as f:
    json.dump(masters_sample, f, ensure_ascii=False, indent=2)
print("masters.json written")

# Read a sample of transactions
with open('C:/Users/kanis/Desktop/MKCP/TALLY JSON/Transactions.json', encoding='utf-16', errors='ignore') as f:
    content = f.read()
tdata = json.loads(content)
tvouchers = tdata.get('tallymessage', [])

# Get 20 vouchers that have inventory entries for our items
item_names = set(i['metadata']['name'].upper() for i in items_found)
sample_vouchers = []
for v in tvouchers:
    ie = v.get('allinventoryentries', [])
    if ie:
        for e in ie:
            sn = str(e.get('stockitemname', '')).upper()
            if sn in item_names:
                sample_vouchers.append(v)
                break
    if len(sample_vouchers) >= 20:
        break

# Also add some payment/receipt vouchers
for v in tvouchers:
    if v.get('vouchertypename') in ('Receipt', 'Payment'):
        sample_vouchers.append(v)
        if len(sample_vouchers) >= 30:
            break

# Write sample transactions.json
tx_sample = {"tallymessage": sample_vouchers}
with open('C:/Users/kanis/Desktop/MKCP/mkcycles-dashboard/public/sample/transactions.json', 'w', encoding='utf-8') as f:
    json.dump(tx_sample, f, ensure_ascii=False, indent=2)
print(f"transactions.json written with {len(sample_vouchers)} vouchers")
