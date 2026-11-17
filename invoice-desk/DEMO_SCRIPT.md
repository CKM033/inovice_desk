# 5-minute demo video: what to show and say

Record with Loom or any screen recorder, in your own voice, with no slides and no edits. Speak naturally. The lines below are a guide, not a script to read word for word.

**Before you hit record**
1. Open your deployed link. Go to **Reference data → Reset demo data** (click twice).
2. Click the pill at the top right. Choose rules only or Claude, and keep **"Pace stages"** ticked so each stage is visible.
3. Keep the `samples/` folder open in Finder or Explorer so you can drag a PDF in once (that shows it takes real files).

---

### 0:00 – 0:30 · The problem and the one design rule
> "This is Invoice Desk. It does the job of an AP clerk: open a vendor invoice, find the PO, check the numbers, decide. The one design rule: **AI only reads the document; deterministic rules make every decision**, so a model can never approve a payment and every outcome is explainable. Eight stages, four possible outcomes."

(Hover over the stage list on the empty screen.)

### 0:30 – 1:30 · Happy path: drag in `01_happy_path_apex.pdf`
> "A real PDF goes in. Stage one fingerprints the file for duplicate detection. Two reads the text layer. Three extracts fields and cross-checks them. Four checks the invoice itself: arithmetic, GSTIN checksum, and that it's CGST plus SGST because both parties are in Karnataka. Five matches the vendor master, including bank details. Six looks for duplicates. Seven is the three-way match: price against the PO, and quantity against what was ordered, received and already billed."

When the stamp lands:
> "Approved. It's posted with GL lines and input-tax lines, the due date comes from vendor terms, and it's scheduled into the Friday payment run. Note the pay-to account comes from the vendor master, never from the invoice."

### 1:30 – 2:30 · Edge case: split PO, over-billed (scenario 2)
> "The harder case. Deccan Packaging is on its second invoice against the same PO. The ledger knows 6,000 boxes were already billed and 8,500 of 10,000 have arrived. This invoice bills 5,000 more."

Open the **Three-way match** tab:
> "So the process does the arithmetic a tired clerk gets wrong: 2,500 are payable now, 1,500 are billed before delivery, and 1,000 exceed the PO. It holds the invoice, drafts the credit-note email, and lets me approve just the received portion."

Click **Approve payable portion**.

### 2:30 – 3:20 · Edge case: bank details changed (scenario 5)
> "Everything here matches: PO, prices, receipts. A simple matcher would pay. But the invoice asks us to pay a new account. That's the classic payment-diversion fraud. It's on hold, and notice it does *not* email the sender, who might be compromised. It tells AP to call the contact already on file, not the number printed on the invoice."

### 3:20 – 4:10 · Edge cases: scan with no PO (3) and duplicate (4)
> "A scanned invoice with no text layer and no PO number. OCR reads it, the arithmetic re-checks every number, and it scores the vendor's open POs: 96% for one, 22% for the decoy. It still goes to a person, because inferring a PO isn't the same as the vendor quoting it. One click confirms it."

Run 4:
> "Cloudnest re-sends an 'overdue' invoice as CN-2026-412. We paid CN/2026/0412 on 3 November. Exact-match checks miss this. Normalised, they're the same key, so it's rejected, with an email citing the payment."

### 4:10 – 4:50 · Dashboard and AI guardrails
Open **Runs**:
> "Every run is recorded: outcomes, value posted against value stopped, what's waiting for a person, and time per invoice."

If you're using Claude:
> "Claude does the reading. If it returns a value that isn't in the document, or totals that don't reconcile, an independent rule-based read takes over. If the API is down, the process falls back and says so. It never stops."

### 4:50 – 5:00 · Close
> "AI where documents are messy, rules where money moves, and a person only for the judgement calls. That's the design."

---

## Live interview: order to run
Reset → 1 (approve) → 2 (hold → approve partial) → 3 (review → confirm) → 4 (duplicate) → 5 (bank hold) → re-run 1 (exact duplicate) → **Runs** → **Reference data**: lower the price tolerance to 0 or raise it to 5%, then re-run 6 to show the decision move.

## Likely questions to prepare for
- *Why not let the LLM decide?* Decisions must be auditable and repeatable; a policy change should be a config edit, not a new prompt; and you can't unit-test judgement drift.
- *Why browser-only?* No server to fail during a live demo; the state model (ledger, runs) maps one-to-one onto a DB table later.
- *How would this scale?* Inbox → queue → the same pipeline as a worker → ERP APIs for POs, GRNs and posting → reviewer UI with SLAs. Track reviewer override rates per rule to tune thresholds.
- *What breaks it?* Multi-page invoices with summary tables (the parser takes the first tax line of each type), non-INR invoices, TDS deductions, credit notes. These are on the next-steps list.
