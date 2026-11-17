# Invoice Desk: from vendor PDF to a reasoned payment decision

**Zamp · AI Solutions Analyst case study · PS-1 (Finance / AP: invoice processing)**
Candidate: Sayantan Sarkar, IIT Delhi

An AP clerk opens every vendor invoice, finds the purchase order, checks whether the numbers line up, and decides what to do with it. Invoice Desk does that job end to end. It takes a real invoice (text PDF, scanned PDF or phone photo), runs it through eight visible stages, and ends with one of four decisions. Each decision comes with its reasons and a prepared next action: an ERP posting, a vendor email, or an internal escalation.

**Live process:** `<your deployed URL>`. To deploy it, see "Run it" below. The deployed copy is the full app; nothing is simulated.

---

## The design principle: AI reads, rules decide

AI does one job here: turning a messy document into fields. Every validation and every decision is a deterministic rule, so a model can never approve a payment. That also makes each decision explainable, repeatable and auditable.

The AI step is still boxed in:

| Guardrail | What it catches |
|---|---|
| **Grounding check.** Every identifier and amount the model returns must appear verbatim in the document text. | Hallucinated invoice numbers, totals, GSTINs and bank accounts |
| **Two independent reads.** A rule-based, layout-agnostic parser also reads every text PDF. If totals disagree, the read that is grounded *and* reconciles wins; if both look valid, a person decides. | Model misreads; parser misreads |
| **Arithmetic as a lie detector.** qty × rate → lines → subtotal → tax → total must reconcile. | Extraction errors, OCR digit errors (repaired automatically and shown), vendor maths errors |
| **Graceful degradation.** No key, API outage or rate limit → falls back to the rule-based parser and says so in the stage. | The process never stops because a model is unavailable |

## The eight stages (all visible live in the UI)

1. **Receive document.** SHA-256 fingerprint for exact-duplicate detection; file-type check.
2. **Read the document.** Uses the PDF text layer, or self-hosted Tesseract OCR for scans and photos.
3. **Extract invoice fields.** Claude (optional, via API key or the claude.ai page) and/or the rule-based parser, plus the grounding and cross-checks above, OCR auto-repair (IFSC, GSTIN checksum, line amounts) and a confidence score.
4. **Check the invoice itself.** Mandatory fields, arithmetic, GSTIN format and checksum, billed to our GSTIN, correct GST head for place of supply (CGST+SGST vs IGST), date sanity.
5. **Verify the vendor.** Vendor master match by GSTIN (by name only as a fallback, which raises a flag), approval status, and bank details against the master.
6. **Look for duplicates.** Same file; same invoice number after normalisation (`CN/2026/0412` = `CN-2026-412`) against the ledger and the open queue; same vendor + same amount within 15 days under a different number.
7. **Match PO and receipts (three-way match).** Explicit PO, or a PO inferred from line items and prices across the vendor's open POs. Line by line: price vs PO (±2%), quantity vs ordered, received (GRN / service entry) and *already invoiced* (the ledger, so split invoices are handled), and GST rate vs PO.
8. **Decide and route.** Policy precedence REJECTED > HOLD > REVIEW > APPROVED, plus the auto-approval limit (₹5,00,000). The stage produces:
   - **Approved:** ERP posting (GL expense lines, input CGST/SGST/IGST lines, due date from vendor terms, Friday payment run). The pay-to account always comes from the vendor master, never from the invoice.
   - **Needs review:** the specific question for the reviewer, plus one-click approve or reject.
   - **On hold:** what is blocked and why, the payable portion, an internal action, and a vendor email where appropriate. Overriding a hold requires a written note.
   - **Rejected:** a vendor email explaining why. Nothing is posted.

Approved invoices are written into the AP ledger, so the next invoice on the same PO sees them. The **Runs** dashboard shows history, outcomes, value posted vs held, the queue waiting for a person, and timing. The **Reference data** tab shows the vendor master, POs with live received/invoiced/billable quantities, the ledger, and an editable policy (change a tolerance, re-run, and watch the decision move).

## Scenarios (prepared inputs in `samples/`, one click in the UI)

| # | Scenario | Expected decision | Why it matters |
|---|---|---|---|
| 1 | **Happy path.** Apex Office Supplies, clean PDF, PO 4500001842, fully received | **Approved**, posted, scheduled for the 11 Dec payment run | Straight-through processing with a full audit trail |
| 2 | **Edge: second invoice on a split PO.** Deccan Packaging bills 5,000 boxes; 6,000 already invoiced, 8,500 of 10,000 received | **On hold.** ₹1,23,900 payable now (2,500 units); 1,500 awaiting receipt; 1,000 beyond PO, so a credit note is requested | One invoice vs one PO is easy. Money leaks on the 2nd and 3rd invoice against the same PO. |
| 3 | **Edge: scanned, no PO number.** BlueLine Logistics, image-only PDF | **Needs review.** OCR, then PO 4500001933 inferred at 96% (decoy PO scores 22%); a reviewer confirms with one click | Inference is not the same as the vendor quoting a PO, so it is never auto-approved |
| 4 | **Edge: duplicate with a re-typed number.** Cloudnest re-sends `CN-2026-412` as an "overdue" reminder; `CN/2026/0412` was paid on 3 Nov | **Rejected.** Duplicate; vendor email cites the payment | Exact-match duplicate checks miss this; it is the most common way duplicate payments happen |
| 5 | **Edge: bank details changed.** Evergreen FM invoice matches its PO perfectly but asks for payment to a new ICICI account | **On hold.** Fraud risk; no email to the (possibly compromised) sender; call the contact *on file*, not the number on the invoice | Business-email-compromise payment diversion: everything "matches", so a naive matcher pays the fraudster |
| 6 | Wrong GST head + price creep. IGST on an intra-state supply; cups at ₹89 vs PO ₹85 | **Needs review.** Both issues in one vendor email | Input tax credit is lost if the GST head is wrong |
| 7 | Unknown vendor. QuickPrint, not in the master, no PO | **Rejected.** Vendor email plus a procurement escalation (maverick spend) | |
| — | Re-run scenario 1 | **Rejected.** Exact same file already processed | Shows the ledger and queue are live |

All of these were run end to end in a headless Chrome. The Claude path was tested against a mocked API, including a deliberately hallucinated total (caught by the grounding check, so the rule-based read was used) and a 529 outage (fell back cleanly).

## Assumptions (noted for the interview)

- Indian GST invoices in INR for one buyer entity, Northwind Retail Pvt Ltd (Karnataka, GSTIN 29AAACN4821K1ZB). All companies, GSTINs (with valid checksums) and bank details are fictional.
- PO, receipt and vendor master data are mock ERP extracts (`data/seed.json`). The AP ledger is maintained by the process.
- Policy: ±2% unit-price tolerance; auto-approve up to ₹5,00,000; invoices older than 180 days or future-dated go to review; payment runs on Fridays; due date = invoice date + vendor terms.
- An inferred PO always goes to review. Changed bank details always hold. Billing beyond receipts always holds, and the received portion can be approved on its own.
- Invoices arrive as files. In production an email inbox or SFTP drop feeds the same entry point.
- Runs and the ledger live in the browser (localStorage), so the demo needs no server. **Reset demo data** restores the starting position before a demo.

## Run it

It is a static site with no backend and no build step.

**Deploy (pick one, about 2 minutes):**
- **GitHub Pages:** create a public repo, upload the contents of this folder (keep `index.html` at the root), then Settings → Pages → Deploy from branch → `main` / root. URL: `https://<user>.github.io/<repo>/`
- **Netlify:** app.netlify.com → Add new site → Deploy manually → drag this folder in.
- **Vercel:** `npx vercel --prod` from this folder.

**Locally:** `python3 -m http.server 8000` in this folder, then open http://localhost:8000. Opening `index.html` directly from disk also works, except the self-hosted OCR, which browsers block on `file://`.

**Optional AI reading:** click the pill at the top right → "Claude, with your API key". The key stays in your browser and is sent only to api.anthropic.com. Without a key, the rule-based parser handles all prepared scenarios.

**Regenerate the sample invoices:** `python3 tools/make_invoices.py` (needs reportlab, Pillow, poppler-utils). **Run the engine headless:** `npm i pdfjs-dist@3.11.174 && node tests/run_samples.mjs` (needs the `tesseract` CLI for the scan).

## Files

```
index.html            UI shell + styles
js/util.js            money, Indian dates, GSTIN checksum + OCR repair, invoice-number normalisation, fuzzy match
js/extract.js         layout-agnostic rule-based parser (qty × rate ≈ amount row detection), grounding check
js/ai.js              Claude adapters: forced tool call with a JSON schema; in-page variant
js/pipeline.js        the eight stages, policy, three-way match, PO inference, decision, posting, vendor email
js/app.js             live run view, reviewer actions, dashboard, reference data, settings
js/samples.js         the prepared invoices (real PDF bytes) + reference data
data/seed.json        vendor master, POs, receipts, invoice history, policy
samples/*.pdf         the seven test invoices as files (drag them in during the demo)
vendor/               pdf.js and Tesseract OCR, self-hosted so the demo has no CDN dependency
tools/, tests/        sample generator and headless test runner
```

## What I would build next

Mailbox ingestion and ERP connectors (SAP / Tally) in place of mock data · a reviewer queue with assignment and SLAs · automatic release of held quantities when the GRN posts · per-vendor tolerances · learning from reviewer overrides to tune thresholds · multi-currency and TDS deduction.
