# Contra test on the dummy Tally: checklist for Vishal

A Contra is a move of your own money: cash to bank, bank to cash, or one of your banks to another. The web app will draft own-account bank transfers as Contra. This test proves the office agent writes a Contra into Tally correctly, then removes every test entry by itself.

Nothing here touches the real books. It only works when the dummy company is the one open in Tally, and it stops without writing anything if it is not.

Run one step at a time. Wait for each step to finish before starting the next.

## Before you start

1. In Tally, close the real company. Open only the dummy company. The program checks this itself, and refuses if the real books are open, or if two companies are open.
2. In the dummy company, make sure there are two bank ledgers (any two ledgers under "Bank Accounts"). If there is only one, the bank to bank case is reported as "NOT RUN". That is not a failure, but it means the case was not tested.
3. Open the Day Book for today (Display More Reports, then Day Book). Write down how many vouchers it shows. You will compare this number at the end.
4. Make sure nobody is typing in Tally and that no message box is open on the Tally screen. An open message box freezes Tally's data port until a person restarts Tally.

## Run the test (one request at a time)

5. Open a terminal in the agent's `server` folder.
6. Type this one command and press Enter. Do not start anything else while it runs:

   `npx tsx scripts/rigs/t11-money.ts --part contras --out contra-run.json`

7. It first prints "preflight ok (dummy is the only company open ...)". If it prints "refused", "Stopped; nothing was sent", or says the role is not sandbox, stop here. Nothing was written. Do not change any setting to get past it. Send the line to Claude. (This test program deliberately refuses to run on a machine set up as the real office machine.)
8. Wait for it to finish. It is not timed here, so allow several minutes. If Tally shows a message box at any point, leave it and tell Claude what it says. Tally may need a restart, and the program prints the cleanup line to use afterwards (step 16).

## Read the result

9. At the end it prints a count such as "61 passed, 0 failed". What it checked, in plain words:
   - Cash to bank: 1,234.00 goes in. The bank is debited and the cash is credited, by the same amount.
   - Bank to cash: 567.00. The cash is debited and the bank is credited.
   - Bank to bank: 890.00 (only if you have two bank ledgers). The receiving bank is debited and the sending bank is credited.
   - Each entry was read back from Tally and compared field by field with what was sent: date, number, narration, both ledgers, which side is debit and which is credit, the amount, and the bank reference number.
   - It also changed, cancelled and deleted one entry of each kind (Receipt, Payment, Contra) to prove those work.
10. Pass means: "0 failed", and no line starting with a cross mark. Anything else, copy the failed lines to Claude.
11. The test entries are numbered `ZZTEST` followed by a stamp, then `/K1`, `/K2`, `/K3`. They exist in Tally only while the test runs.

## Confirm in Tally, and that everything was removed

12. Open the Day Book for today again and count the vouchers. The number must be exactly the one you wrote down in step 3.
13. In the Day Book, look for any voucher whose number starts with `ZZTEST`. There must be none.
14. Check the two bank ledgers' closing balances (Display More Reports, Account Books, Ledger). They must be what they were before the test. The test moves money in and out, and the removal puts it back.

## If the test stopped half way (a freeze, a power cut, a message box)

15. Restart Tally if it is frozen, and open the dummy company again.
16. The test printed a line like "cd server; npx tsx scripts/rigs/t11-money.ts --cleanup 123456". Run exactly that line, with the stamp it printed. It deletes every voucher and test ledger of that run. Run it once and wait for it to finish.
17. Do steps 12 to 14 again to confirm nothing is left.

## Deleting one by hand, if ever needed

18. In the dummy company, open the Day Book, find the voucher (its number starts with `ZZTEST`), press Enter to open it, then press Alt+D and confirm. Only ever do this in the dummy company.

## What this test does not cover

- It uses the test numbers (`ZZTEST...`), not the ERP's own numbers (`ERP-7/26-27` style). The ERP number format and the rule that each Contra gets its own number are proven offline by `server/scripts/test-contra-golden.ts`.
- It does not go through the web app's queue. That path is switched on only at go-live.
