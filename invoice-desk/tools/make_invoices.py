"""Generate realistic, deliberately inconsistent vendor invoice PDFs for the AP demo.

Three different layouts (classic / Tally-style / modern SaaS), different label
vocabularies, Indian vs western digit grouping, and one image-only "scanned" PDF.
"""
import json, os, random, subprocess, tempfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib import colors
from PIL import Image, ImageFilter, ImageOps, ImageChops

SEED = json.load(open(os.path.join(ROOT, "data", "seed.json")))
V = {v["id"]: v for v in SEED["vendors"]}
CO = SEED["company"]
OUT = os.path.join(ROOT, "samples")
W, H = A4


def inr(x):  # Indian grouping 1,25,906.00
    neg = x < 0
    x = abs(x)
    s = f"{x:.2f}"
    whole, dec = s.split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:]); head = head[:-2]
        if head: parts.insert(0, head)
        whole = ",".join(parts) + "," + tail
    return ("-" if neg else "") + whole + "." + dec


def west(x):
    return f"{x:,.2f}"


def words(n):
    ones = "Zero One Two Three Four Five Six Seven Eight Nine Ten Eleven Twelve Thirteen Fourteen Fifteen Sixteen Seventeen Eighteen Nineteen".split()
    tens = "_ _ Twenty Thirty Forty Fifty Sixty Seventy Eighty Ninety".split()
    def two(k):
        return ones[k] if k < 20 else tens[k // 10] + ("" if k % 10 == 0 else " " + ones[k % 10])
    def three(k):
        h, r = divmod(k, 100)
        return ((ones[h] + " Hundred" + (" " if r else "")) if h else "") + (two(r) if r else "")
    n = int(round(n)); out = []
    for div, name in [(10**7, "Crore"), (10**5, "Lakh"), (1000, "Thousand")]:
        q, n = divmod(n, div)
        if q: out.append(three(q) + " " + name)
    if n: out.append(three(n))
    return "Rupees " + " ".join(out) + " Only"


# ---------------------------------------------------------------- layouts
def layout_classic(path, d, accent=colors.HexColor("#1f4e79")):
    c = canvas.Canvas(path, pagesize=A4)
    c.setTitle(f"Invoice {d['no']}")
    v = d["vendor"]
    c.setFillColor(accent); c.rect(0, H - 18, W, 18, fill=1, stroke=0)
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 17); c.drawString(40, H - 60, v["name"])
    c.setFont("Helvetica", 9)
    y = H - 76
    for ln in d["vendor_addr"]:
        c.drawString(40, y, ln); y -= 12
    c.drawString(40, y, f"GSTIN: {v['gstin']}    State: {v['stateName']} ({v['state']})"); y -= 12
    c.setFont("Helvetica-Bold", 20); c.setFillColor(accent)
    c.drawRightString(W - 40, H - 60, "TAX INVOICE"); c.setFillColor(colors.black)
    # meta box
    c.setFont("Helvetica", 9.5)
    my = H - 84
    for k, val in d["meta"]:
        c.drawRightString(W - 150, my, k); c.setFont("Helvetica-Bold", 9.5)
        c.drawString(W - 144, my, val); c.setFont("Helvetica", 9.5); my -= 14
    # bill to
    y = H - 170
    c.setFont("Helvetica-Bold", 9.5); c.drawString(40, y, "Bill To:"); c.setFont("Helvetica", 9.5)
    c.drawString(40, y - 13, CO["name"]); c.drawString(40, y - 25, CO["address"])
    c.drawString(40, y - 37, f"GSTIN: {CO['gstin']}    Place of Supply: {CO['stateName']} ({CO['state']})")
    # table
    y = H - 240
    cols = [40, 64, 300, 352, 400, 438, 500]
    heads = ["#", "Description", "HSN/SAC", "Qty", "Unit", "Rate", "Amount"]
    c.setFillColor(colors.HexColor("#e8eef5")); c.rect(36, y - 5, W - 72, 18, fill=1, stroke=0)
    c.setFillColor(colors.black); c.setFont("Helvetica-Bold", 9)
    for x, h in zip(cols, heads):
        if h in ("Qty", "Rate", "Amount"):
            c.drawRightString(x + (40 if h != "Amount" else 55), y, h)
        else:
            c.drawString(x, y, h)
    c.setFont("Helvetica", 9); y -= 22
    for i, li in enumerate(d["lines"], 1):
        c.drawString(cols[0], y, str(i)); c.drawString(cols[1], y, li["desc"])
        c.drawString(cols[2], y, li["hsn"])
        c.drawRightString(cols[3] + 40, y, f"{li['qty']:g}"); c.drawString(cols[4], y, li["uom"])
        c.drawRightString(cols[5] + 40, y, d["fmt"](li["rate"])); c.drawRightString(cols[6] + 55, y, d["fmt"](li["qty"] * li["rate"]))
        y -= 18
    c.line(36, y + 8, W - 36, y + 8)
    y -= 10
    for k, val, bold in d["totals"]:
        c.setFont("Helvetica-Bold" if bold else "Helvetica", 10 if bold else 9.5)
        c.drawRightString(470, y, k); c.drawRightString(W - 40, y, val); y -= 15
    c.setFont("Helvetica-Oblique", 8.5); c.drawString(40, y - 6, "Amount in words: " + words(d["total"]))
    y -= 40
    c.setFont("Helvetica-Bold", 9.5); c.drawString(40, y, "Bank details for payment"); c.setFont("Helvetica", 9)
    b = d["bank"]
    c.drawString(40, y - 13, f"Bank: {b['name']}"); c.drawString(40, y - 25, f"Account No: {b['account']}")
    c.drawString(40, y - 37, f"IFSC: {b['ifsc']}")
    y -= 52
    if d.get("note"):
        c.setFillColor(colors.HexColor("#fff4d6")); c.rect(36, y - 30, W - 72, 40, fill=1, stroke=0)
        c.setFillColor(colors.black); c.setFont("Helvetica-Bold", 9)
        for i, ln in enumerate(d["note"]):
            c.drawString(44, y - i * 12, ln)
        y -= 48
    c.setFont("Helvetica", 8); c.setFillColor(colors.grey)
    c.drawString(40, 60, f"Payment terms: Net {v['paymentTermsDays']} days. Subject to Bengaluru jurisdiction. This is a computer generated invoice.")
    c.drawRightString(W - 40, 90, f"For {v['name']}"); c.drawRightString(W - 40, 70, "Authorised Signatory")
    c.save()


def layout_tally(path, d):
    """Dense, boxed, Tally-ERP style. Labels differ: Bill No. / Dated / Buyer's Order No."""
    c = canvas.Canvas(path, pagesize=A4); c.setTitle(f"Invoice {d['no']}")
    v = d["vendor"]
    c.setFont("Helvetica-Bold", 12); c.drawCentredString(W / 2, H - 40, "Tax Invoice")
    c.setLineWidth(0.6); c.rect(30, 120, W - 60, H - 175)
    top = H - 55
    c.line(W / 2, top, W / 2, top - 150); c.line(30, top - 75, W - 30, top - 75); c.line(30, top - 150, W - 30, top - 150)
    c.setFont("Helvetica-Bold", 10); c.drawString(36, top - 14, v["name"].upper())
    c.setFont("Helvetica", 8.5)
    yy = top - 26
    for ln in d["vendor_addr"]:
        c.drawString(36, yy, ln); yy -= 11
    c.drawString(36, yy, f"GSTIN/UIN: {v['gstin']}"); c.drawString(36, yy - 11, f"State Name : {v['stateName']}, Code : {v['state']}")
    c.setFont("Helvetica", 8.5)
    yy = top - 14
    for k, val in d["meta"]:
        c.drawString(W / 2 + 6, yy, f"{k}  {val}"); yy -= 13
    c.drawString(36, top - 88, "Buyer (Bill to)")
    c.setFont("Helvetica-Bold", 9); c.drawString(36, top - 100, CO["name"]); c.setFont("Helvetica", 8.5)
    c.drawString(36, top - 112, CO["address"]); c.drawString(36, top - 124, f"GSTIN/UIN : {CO['gstin']}")
    c.drawString(36, top - 136, f"State Name : {CO['stateName']}, Code : {CO['state']}")
    y = top - 166
    heads = [(36, "Sl"), (56, "Description of Goods"), (300, "HSN/SAC"), (395, "Quantity"), (450, "Rate"), (470, "per"), (560, "Amount")]
    c.setFont("Helvetica-Bold", 8.5)
    for x, h in heads:
        (c.drawRightString if h in ("Quantity", "Rate", "Amount") else c.drawString)(x, y, h)
    c.line(30, y - 5, W - 30, y - 5); y -= 20; c.setFont("Helvetica", 9)
    for i, li in enumerate(d["lines"], 1):
        c.drawString(36, y, str(i)); c.setFont("Helvetica-Bold", 9); c.drawString(56, y, li["desc"]); c.setFont("Helvetica", 9)
        c.drawString(300, y, li["hsn"]); c.drawRightString(395, y, f"{li['qty']:,g} {li['uom']}")
        c.drawRightString(450, y, d["fmt"](li["rate"])); c.drawString(470, y, li["uom"]); c.drawRightString(560, y, d["fmt"](li["qty"] * li["rate"]))
        y -= 16
    y -= 8
    for k, val, bold in d["totals"]:
        c.setFont("Helvetica-Bold" if bold else "Helvetica-Oblique", 9)
        if bold: c.line(30, y + 11, W - 30, y + 11)
        c.drawRightString(440, y, k); c.drawRightString(560, y, val); y -= 15
    c.setFont("Helvetica", 8.5); c.drawString(36, y - 6, "Amount Chargeable (in words)")
    c.setFont("Helvetica-Bold", 8.5); c.drawString(36, y - 18, "INR " + words(d["total"]).replace("Rupees ", ""))
    b = d["bank"]; y -= 50
    c.setFont("Helvetica", 8.5); c.drawString(36, y, "Company's Bank Details")
    c.drawString(36, y - 12, f"Bank Name : {b['name']}"); c.drawString(36, y - 24, f"A/c No. : {b['account']}")
    c.drawString(36, y - 36, f"Branch & IFS Code : Begumpet & {b['ifsc']}")
    c.drawRightString(W - 40, 140, f"for {v['name'].upper()}"); c.drawRightString(W - 40, 126, "Authorised Signatory")
    c.setFont("Helvetica", 7.5); c.drawCentredString(W / 2, 105, "This is a Computer Generated Invoice")
    c.save()


def layout_modern(path, d, accent=colors.HexColor("#5b3cc4")):
    c = canvas.Canvas(path, pagesize=A4); c.setTitle(f"Invoice {d['no']}")
    v = d["vendor"]
    c.setFont("Helvetica-Bold", 30); c.setFillColor(accent); c.drawString(48, H - 80, "Invoice"); c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 11); c.drawRightString(W - 48, H - 60, v["name"])
    c.setFont("Helvetica", 8.5)
    yy = H - 74
    for ln in d["vendor_addr"] + [f"GST No. {v['gstin']}"]:
        c.drawRightString(W - 48, yy, ln); yy -= 11
    y = H - 125; c.setFont("Helvetica", 9.5)
    for k, val in d["meta"]:
        c.setFillColor(colors.HexColor("#666666")); c.drawString(48, y, k); c.setFillColor(colors.black)
        c.setFont("Helvetica-Bold", 9.5); c.drawString(150, y, val); c.setFont("Helvetica", 9.5); y -= 15
    y -= 12
    c.setFont("Helvetica-Bold", 9.5); c.drawString(48, y, "Billed to"); c.setFont("Helvetica", 9.5)
    c.drawString(48, y - 13, CO["name"]); c.drawString(48, y - 25, CO["address"]); c.drawString(48, y - 37, f"GST No. {CO['gstin']}")
    y -= 75
    c.setFillColor(colors.HexColor("#666666")); c.setFont("Helvetica", 9)
    c.drawString(48, y, "Description"); c.drawRightString(370, y, "Qty"); c.drawRightString(460, y, "Unit price"); c.drawRightString(W - 48, y, "Amount")
    c.setFillColor(colors.black); c.setStrokeColor(colors.HexColor("#cccccc")); c.line(48, y - 6, W - 48, y - 6)
    y -= 22; c.setFont("Helvetica", 9.5)
    for li in d["lines"]:
        c.drawString(48, y, li["desc"]); c.drawRightString(370, y, f"{li['qty']:g}")
        c.drawRightString(460, y, d["fmt"](li["rate"])); c.drawRightString(W - 48, y, d["fmt"](li["qty"] * li["rate"])); y -= 18
    c.line(300, y + 6, W - 48, y + 6); y -= 10
    for k, val, bold in d["totals"]:
        c.setFont("Helvetica-Bold" if bold else "Helvetica", 11 if bold else 9.5)
        c.drawString(300, y, k); c.drawRightString(W - 48, y, val); y -= 17
    b = d["bank"]; y -= 30
    c.setFont("Helvetica-Bold", 9); c.drawString(48, y, "Pay by bank transfer"); c.setFont("Helvetica", 9)
    c.drawString(48, y - 13, f"{b['name']}  |  Account number {b['account']}  |  IFSC {b['ifsc']}")
    if d.get("note"):
        c.setFillColor(accent); c.setFont("Helvetica-Bold", 9)
        for i, ln in enumerate(d["note"]):
            c.drawString(48, y - 40 - i * 12, ln)
        c.setFillColor(colors.black)
    c.setFont("Helvetica", 8); c.setFillColor(colors.grey)
    c.drawString(48, 50, f"{v['name']}  ·  Questions? {v['contact']['email']}")
    c.save()


def scanify(src_pdf, out_pdf, angle=1.3, seed=7):
    """Rasterise a PDF and degrade it like a phone/scanner capture -> image-only PDF (no text layer)."""
    random.seed(seed)
    tmp = tempfile.mkdtemp()
    subprocess.run(["pdftoppm", "-r", "170", "-gray", "-png", src_pdf, f"{tmp}/p"], check=True)
    img = Image.open(sorted(os.listdir(tmp)) and f"{tmp}/" + sorted(os.listdir(tmp))[0]).convert("L")
    img = img.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=235)
    px = img.load(); w, h = img.size
    for _ in range(int(w * h * 0.004)):
        x, y = random.randrange(w), random.randrange(h); px[x, y] = random.choice([90, 140, 200])
    img = img.filter(ImageFilter.GaussianBlur(0.55))
    img = ImageOps.autocontrast(img, cutoff=1)
    # paper tint + uneven lighting
    grad = Image.linear_gradient("L").rotate(90).resize((w, h)).point(lambda p: 228 + p // 9)
    img = ImageChops.multiply(img, grad)
    img.convert("RGB").save(out_pdf, "PDF", resolution=170.0, quality=70)


# ---------------------------------------------------------------- invoices
def build(d):
    sub = sum(l["qty"] * l["rate"] for l in d["lines"])
    taxes = []
    for t, r in d["tax"]:
        taxes.append((t, r, round(sub * r / 100, 2)))
    total = round(sub + sum(a for _, _, a in taxes), 2)
    d["sub"], d["total"] = sub, total
    f = d["fmt"]
    tl = [(d.get("sub_label", "Sub Total"), f(sub), False)]
    for t, r, a in taxes:
        tl.append((f"{t} @ {r:g}%", f(a), False))
    tl.append((d.get("total_label", "Grand Total (INR)"), f(total), True))
    d["totals"] = tl
    return d


def main():
    os.makedirs(OUT, exist_ok=True)
    apex, deccan, blue, cloud, ever = (V[k] for k in ["V-1001", "V-1002", "V-1003", "V-1004", "V-1005"])

    # 1. Happy path — clean, matches PO 4500001842 and GRN exactly
    d = build(dict(vendor=apex, no="AOS/2026-27/0158", fmt=inr,
        vendor_addr=["No. 18, 2nd Cross, Sampangi Rama Nagar", "Bengaluru, Karnataka 560027"],
        meta=[("Invoice No:", "AOS/2026-27/0158"), ("Invoice Date:", "12-Nov-2026"), ("PO Number:", "4500001842"), ("Due Date:", "12-Dec-2026")],
        lines=[dict(desc="A4 copier paper 75 GSM (ream of 500)", hsn="4802", qty=200, uom="ream", rate=265),
               dict(desc="Toner cartridge HP 88A", hsn="8443", qty=12, uom="pc", rate=3450),
               dict(desc="Whiteboard markers (box of 10)", hsn="9608", qty=30, uom="box", rate=410)],
        tax=[("CGST", 9), ("SGST", 9)], bank=apex["bank"]))
    layout_classic(f"{OUT}/01_happy_path_apex.pdf", d); print("1", d["total"])

    # 2. Split / over-billed PO — second invoice on PO 4500001907 pushes billed qty past both PO and GRN
    d = build(dict(vendor=deccan, no="DPI/1043", fmt=west,
        vendor_addr=["Plot 42, IDA Cherlapally Phase II", "Hyderabad, Telangana 500051"],
        meta=[("Invoice No.:", "DPI/1043"), ("Dated:", "14-Nov-2026"), ("Buyer's Order No.:", "4500001907"), ("Order Dated:", "02-Oct-2026"),
              ("Mode/Terms of Payment:", "45 Days")],
        lines=[dict(desc="5-Ply Corrugated Box 18x12x12 in", hsn="481910", qty=5000, uom="pcs", rate=42)],
        tax=[("IGST", 18)], sub_label="Taxable Value", total_label="Total", bank=deccan["bank"]))
    layout_tally(f"{OUT}/02_split_overbilled_deccan.pdf", d); print("2", d["total"])

    # 3. Scanned invoice, no PO reference — process must OCR and infer the PO
    d = build(dict(vendor=blue, no="BLL/MUM/2026/7781", fmt=inr,
        vendor_addr=["Gala 7, Rahnal Village, Bhiwandi", "Thane, Maharashtra 421302"],
        meta=[("Invoice No:", "BLL/MUM/2026/7781"), ("Invoice Date:", "15/11/2026"), ("Your Ref:", "Oct-Nov dispatches, Bengaluru DC"), ("Vehicle:", "MH04 KF 2291 / 4 trips")],
        lines=[dict(desc="FTL freight Bhiwandi to Bengaluru 32ft MXL", hsn="996511", qty=4, uom="trip", rate=48500),
               dict(desc="Loading and unloading charges", hsn="996719", qty=4, uom="trip", rate=2500)],
        tax=[("IGST", 18)], bank=blue["bank"]))
    tmp = "/tmp/blueline_clean.pdf"
    layout_classic(tmp, d, accent=colors.HexColor("#333333"))
    scanify(tmp, f"{OUT}/03_scanned_no_po_blueline.pdf"); print("3", d["total"])

    # 4. Duplicate re-submission — same bill as CN/2026/0412 (already paid) with a reformatted number
    d = build(dict(vendor=cloud, no="CN-2026-412", fmt=west,
        vendor_addr=["WeWork Galaxy, 43 Residency Road", "Bengaluru 560025"],
        meta=[("Invoice #", "CN-2026-412"), ("Date of issue", "Oct 31, 2026"), ("Purchase order", "4500001810"), ("Payment due", "Nov 15, 2026")],
        lines=[dict(desc="Managed cloud support - October 2026", hsn="998316", qty=1, uom="month", rate=200000)],
        tax=[("CGST", 9), ("SGST", 9)], sub_label="Subtotal", total_label="Amount due (INR)", bank=cloud["bank"],
        note=["Reminder: this invoice is now overdue. Please arrange payment at the earliest."]))
    layout_modern(f"{OUT}/04_duplicate_resubmission_cloudnest.pdf", d); print("4", d["total"])

    # 5. Bank-detail change — everything matches, except where the money goes
    newbank = {"name": "ICICI Bank", "account": "917020045566112", "ifsc": "ICIC0006621"}
    d = build(dict(vendor=ever, no="EFM/2026/1187", fmt=inr,
        vendor_addr=["14/2 Langford Road, Shanthi Nagar", "Bengaluru, Karnataka 560025"],
        meta=[("Invoice No:", "EFM/2026/1187"), ("Invoice Date:", "10-Nov-2026"), ("PO Number:", "4500001950"), ("Service Period:", "Nov 2026")],
        lines=[dict(desc="Housekeeping services - November 2026", hsn="998533", qty=1, uom="month", rate=185000),
               dict(desc="Pantry consumables replenishment", hsn="998533", qty=1, uom="lot", rate=12500)],
        tax=[("CGST", 9), ("SGST", 9)], bank=newbank,
        note=["IMPORTANT: Our bank details have changed with effect from 1 Nov 2026.",
              "Kindly remit all payments to the new account above. For queries call +91 98450 11223."]))
    layout_classic(f"{OUT}/05_bank_change_evergreen.pdf", d, accent=colors.HexColor("#2e7d32")); print("5", d["total"])

    # 6. Bonus: wrong GST type (IGST on an intra-state supply) + unit price above PO
    d = build(dict(vendor=apex, no="AOS/2026-27/0163", fmt=inr,
        vendor_addr=["No. 18, 2nd Cross, Sampangi Rama Nagar", "Bengaluru, Karnataka 560027"],
        meta=[("Invoice No:", "AOS/2026-27/0163"), ("Invoice Date:", "13-Nov-2026"), ("PO Number:", "4500001966"), ("Due Date:", "13-Dec-2026")],
        lines=[dict(desc="Tea bags (pack of 100)", hsn="0902", qty=40, uom="pack", rate=210),
               dict(desc="Filter coffee powder 500 g", hsn="0901", qty=25, uom="pack", rate=540),
               dict(desc="Paper cups 150 ml (pack of 50)", hsn="4823", qty=100, uom="pack", rate=89)],
        tax=[("IGST", 18)], bank=apex["bank"]))
    layout_classic(f"{OUT}/06_wrong_gst_type_apex.pdf", d); print("6", d["total"])

    # 7. Bonus: vendor not in the vendor master, no PO
    qp = {"name": "QuickPrint Solutions", "gstin": "07ABCPQ1234R1ZC", "state": "07", "stateName": "Delhi", "paymentTermsDays": 7,
          "contact": {"email": "hello@quickprint.example"}}
    d = build(dict(vendor=qp, no="QP-2211", fmt=inr,
        vendor_addr=["B-112 Okhla Industrial Area Phase 1", "New Delhi 110020"],
        meta=[("Invoice No:", "QP-2211"), ("Invoice Date:", "11-Nov-2026"), ("Ordered by:", "Mr. Sharma (verbal)")],
        lines=[dict(desc="Flyer printing A5 4-colour", hsn="4911", qty=20000, uom="pcs", rate=2.10),
               dict(desc="Roll-up standee 6x3 ft", hsn="4911", qty=4, uom="pc", rate=1500)],
        tax=[("IGST", 18)], bank={"name": "Punjab National Bank", "account": "0712000100223344", "ifsc": "PUNB0071200"}))
    layout_modern(f"{OUT}/07_unknown_vendor_quickprint.pdf", d, accent=colors.HexColor("#c2185b")); print("7", d["total"])


if __name__ == "__main__":
    main()
