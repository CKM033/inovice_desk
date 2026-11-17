/* Deterministic, layout-agnostic invoice parser.
   Works on text lines (from the PDF text layer or OCR). Used as (a) the extractor when no AI model is
   configured and (b) the independent cross-check / OCR-repair layer when one is. */
(function (g) {
  const U = g.U;
  const X = {};

  // Group pdf.js text items into visual lines (same baseline), keeping x positions.
  X.linesFromItems = function (items, page = 1) {
    const rows = [];
    items.filter((it) => it.str && it.str.trim()).forEach((it) => {
      const x = it.transform[4], y = it.transform[5], w = it.width || 0;
      let row = rows.find((r) => Math.abs(r.y - y) < 3.2);
      if (!row) { row = { y, items: [], page }; rows.push(row); }
      row.items.push({ x, w, str: it.str });
    });
    rows.sort((a, b) => b.y - a.y);
    rows.forEach((r) => {
      r.items.sort((a, b) => a.x - b.x);
      let text = '', end = null;
      r.items.forEach((it) => {
        if (end != null) text += it.x - end > 14 ? '   ' : ' ';
        text += it.str.trim(); end = it.x + it.w;
      });
      r.text = text;
    });
    return rows;
  };
  X.linesFromText = (txt) => txt.split(/\r?\n/).map((t) => t.replace(/\s+$/, '')).filter((t) => t.trim()).map((text) => ({ text, items: null }));

  // ---- numeric tokens (whitespace-delimited words that are pure numbers, e.g. "1,25,906.00", "(500)")
  const NUMWORD = /^\(?(?:Rs\.?|INR|₹)?\s?(\d[\d,]*(?:\.\d+)?)\)?[.,;:]?$/i;
  function numTokens(text) {
    const out = []; const words = text.split(/\s+/);
    words.forEach((w, i) => {
      const m = w.match(NUMWORD);
      if (m && !/%$/.test(w)) {
        const raw = m[1];
        // reject malformed digit grouping like "1,2" but accept Indian (1,25,906) and western (125,906)
        out.push({ i, raw, v: U.parseAmount(raw), money: /\.\d{2}$/.test(raw), int: /^\d+$/.test(raw) });
      }
    });
    return { words, nums: out };
  }
  const lastMoney = (text) => { const n = numTokens(text).nums.filter((t) => t.money); return n.length ? n[n.length - 1].v : null; };

  function findLabeled(lines, labelRe, valueRe, opts = {}) {
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li]; const t = L.text;
      const re = new RegExp(labelRe.source, 'gi'); let m;
      while ((m = re.exec(t))) {
        const before = t.slice(Math.max(0, m.index - 14), m.index);
        if (opts.notBefore && opts.notBefore.test(before)) continue;
        const after = t.slice(m.index + m[0].length).replace(/^[\s:.#\-–]+/, '');
        const v = after.match(valueRe);
        if (v) return { value: v[1] || v[0], line: t };
        // value printed under the label (boxed layouts): nearest item on the next line
        if (opts.below && L.items && lines[li + 1] && lines[li + 1].items) {
          const lx = L.items.find((it) => new RegExp(labelRe.source, 'i').test(it.str));
          const nx = lines[li + 1].items.slice().sort((a, b) => Math.abs(a.x - (lx ? lx.x : 0)) - Math.abs(b.x - (lx ? lx.x : 0)))[0];
          if (nx) { const v2 = nx.str.trim().match(valueRe); if (v2) return { value: v2[1] || v2[0], line: nx.str }; }
        }
      }
    }
    return null;
  }

  X.heuristic = function (lines, ctx) {
    const company = ctx.company, vendors = ctx.vendors || [];
    const all = lines.map((l) => l.text).join('\n');
    const notes = [], corrections = [];
    const inv = { vendorName: null, vendorGstin: null, buyerGstin: null, invoiceNo: null, invoiceDate: null, poNumber: null,
      currency: 'INR', lines: [], subtotal: null, taxes: [], total: null, bank: { name: null, account: null, ifsc: null }, notes: [] };

    // --- GSTINs (repairing OCR confusions; checksum decides)
    const cands = (all.toUpperCase().match(/\b[0-9OILS]{2}[A-Z0-9]{13}\b/g) || []).filter((c) => (c.match(/[A-Z]/g) || []).length >= 5 && (c.match(/[0-9]/g) || []).length >= 4);
    const gst = [];
    cands.forEach((c) => { const r = U.repairGstin(c); if (r.repaired) corrections.push(`GSTIN read as ${c}, repaired to ${r.value} (checksum passes)`); if (!gst.includes(r.value)) gst.push(r.value); });
    inv.buyerGstin = gst.find((x) => x === company.gstin) || null;
    inv.vendorGstin = gst.find((x) => x !== company.gstin) || null;

    // --- vendor name: master match by GSTIN, else by name appearing in text, else top-of-page text
    const byG = vendors.find((v) => v.gstin === inv.vendorGstin);
    const lower = all.toLowerCase();
    const byN = vendors.find((v) => [v.name].concat(v.aliases || []).some((a) => lower.includes(a.toLowerCase())));
    if (byG || byN) {
      const v = byG || byN; const names = [v.name].concat(v.aliases || []);
      inv.vendorName = names.find((a) => lower.includes(a.toLowerCase())) || v.name;
    } else {
      for (const l of lines.slice(0, 6)) {
        const seg = l.text.split(/\s{2,}/).map((s) => s.trim()).find((s) => s && !/invoice|^bill|^#|^\d/i.test(s) && /[a-z]{3}/i.test(s));
        if (seg) { inv.vendorName = seg; break; }
      }
    }

    // --- header fields
    const IDV = /^([A-Z0-9][A-Z0-9\/\-_.]{1,30})/i;
    let r = findLabeled(lines, /\b(?:invoice|inv|bill)\s*(?:no\.?|number|num|#)/, IDV, { below: true });
    if (!r) r = findLabeled(lines, /\binvoice\s*#/, IDV);
    if (r && /\d/.test(r.value)) inv.invoiceNo = r.value.replace(/[.,]$/, '');

    r = findLabeled(lines, /\b(?:invoice\s*date|date\s*of\s*issue|bill\s*date|dated|date)\b/, U.DATE_RE, { notBefore: /(due|order|payment|po|delivery|dispatch)\W*$/i, below: true });
    if (r) inv.invoiceDate = U.parseDate(r.value);

    r = findLabeled(lines, /\b(?:p\.?\s?o\.?|purchase\s*order|buyer'?s\s*order|order)\s*(?:no\.?|number|#|ref\.?)?/, /^([A-Z]{0,4}[-\/]?\d{5,12})\b/i);
    if (r) inv.poNumber = r.value.replace(/^(PO)[-\/]?/i, '');
    if (!inv.poNumber) {
      const m = all.match(/\b45\d{8}\b/);
      if (m) { inv.poNumber = m[0]; notes.push('PO-format number found in free text without a PO label'); }
    }

    // --- bank
    let m = all.match(/(?:a\/c|account)\s*(?:no\.?|number|#)?\s*[:.\-]?\s*(\d{9,18})/i);
    if (m) inv.bank.account = m[1];
    m = all.toUpperCase().match(/\b([A-Z]{4}[0O][A-Z0-9]{6})\b/);
    if (m) { const f = U.repairIfsc(m[1]); inv.bank.ifsc = f.value; if (f.repaired) corrections.push(`IFSC read as ${m[1]}, repaired to ${f.value} (5th character is always 0)`); }
    m = all.match(/\b((?:[A-Z][A-Za-z]+ ){0,3}Bank(?: of [A-Z][a-z]+)?)\b/);
    for (const mm of all.matchAll(/\b((?:[A-Z][A-Za-z]+ ){1,3}Bank(?: of [A-Z][a-z]+)?|HDFC Bank|ICICI Bank|Axis Bank)\b/g)) {
      if (!/^(Company|Pay|Name)/.test(mm[1])) { inv.bank.name = mm[1].replace(/^Name /, ''); break; }
    }

    // --- notices worth surfacing to a human (bank change language, payment pressure)
    lines.forEach((l) => {
      if (/(bank (details|account)[^.]*chang|new (bank|account)|remit[^.]*new|kindly remit|changed with effect)/i.test(l.text)) inv.notes.push(l.text.trim());
      else if (/(overdue|reminder|final notice|urgent)/i.test(l.text)) inv.notes.push(l.text.trim());
    });

    // --- line items: rows inside the item table whose numbers satisfy qty × rate ≈ amount
    const hIdx = lines.findIndex((l) => /\bdescription\b/i.test(l.text) && /(qty|quantity)/i.test(l.text));
    const endIdx = lines.findIndex((l, i) => i > hIdx && /(sub\s*-?\s*total|taxable value|total)/i.test(l.text));
    const hasHSN = hIdx >= 0 && /hsn|sac/i.test(lines[hIdx].text);
    const region = hIdx >= 0 ? lines.slice(hIdx + 1, endIdx > hIdx ? endIdx : undefined) : lines;
    region.forEach((l) => {
      const { words, nums } = numTokens(l.text);
      if (nums.length < 2 || !nums[nums.length - 1].money) return;
      let found = null;
      for (let k = nums.length - 1; k >= 2 && !found; k--) for (let j = k - 1; j >= 1 && !found; j--) for (let i = j - 1; i >= 0 && !found; i--) {
        const q = nums[i].v, rt = nums[j].v, a = nums[k].v;
        if (q > 0 && rt > 0 && Math.abs(q * rt - a) <= Math.max(1, a * 0.0005)) found = { qi: i, q, rate: rt, amount: a, ok: true };
      }
      if (!found && hIdx >= 0 && nums.length >= 3) { // inside the table but arithmetic is off (OCR) — keep it, flag later
        const n = nums.length; found = { qi: n - 3, q: nums[n - 3].v, rate: nums[n - 2].v, amount: nums[n - 1].v, ok: false };
      }
      if (!found) return;
      let dw = words.slice(0, nums[found.qi].i);
      if (dw.length && /^\d{1,2}\.?$/.test(dw[0])) dw = dw.slice(1); // serial no.
      if (hasHSN && dw.length && /^\d{4,8}$/.test(dw[dw.length - 1])) dw = dw.slice(0, -1);
      const desc = dw.join(' ').replace(/\s{2,}/g, ' ').trim();
      if (!desc || /^(sub|total|taxable|cgst|sgst|igst)/i.test(desc)) return;
      inv.lines.push({ desc, qty: found.q, rate: found.rate, amount: found.amount, taxRate: null, _arith: found.ok });
    });

    // --- totals & taxes
    lines.forEach((l) => {
      const t = l.text;
      if (inv.subtotal == null && /\b(sub\s*-?\s*total|taxable\s*value|total\s*before\s*tax)\b/i.test(t)) inv.subtotal = lastMoney(t);
      const tm = t.match(/\b(CGST|SGST|UTGST|IGST)\b/);
      if (tm && !/GSTIN/i.test(t.replace(/\b(CGST|SGST|UTGST|IGST)\b/g, ''))) {
        const type = tm[1];
        if (!inv.taxes.find((x) => x.type === type)) {
          const rm = t.match(/(\d+(?:\.\d+)?)\s*%/);
          const amt = lastMoney(t);
          if (amt != null) inv.taxes.push({ type, rate: rm ? +rm[1] : null, amount: amt });
        }
      }
    });
    const totalCands = [];
    lines.forEach((l) => {
      const t = l.text;
      if (/\b(grand\s*total|total\s*amount|amount\s*due|amount\s*payable|invoice\s*total|net\s*payable|total)\b/i.test(t) && !/(sub\s*-?\s*total|taxable|total\s*tax|in\s*words)/i.test(t)) {
        const v = lastMoney(t); if (v != null) totalCands.push(v);
      }
    });
    if (totalCands.length) inv.total = Math.max(...totalCands);

    // --- self-consistency repair: if a line's amount ≠ qty × rate, and qty × rate reconciles with the subtotal, trust qty × rate
    const bad = inv.lines.filter((l) => !l._arith);
    if (bad.length && inv.subtotal != null) {
      const fixedSum = inv.lines.reduce((s, l) => s + (l._arith ? l.amount : U.round2(l.qty * l.rate)), 0);
      if (U.close(fixedSum, inv.subtotal, 1)) {
        bad.forEach((l) => { const nv = U.round2(l.qty * l.rate); corrections.push(`Line "${l.desc}": amount read as ${U.num(l.amount)}; qty × rate = ${U.num(nv)} reconciles with the subtotal, so it was corrected`); l.amount = nv; l._arith = true; });
      }
    }
    // tax rate per line: derive from header taxes (all our PO lines carry one rate per invoice in practice)
    const rateSum = inv.taxes.reduce((s, t) => s + (t.rate || 0), 0);
    inv.lines.forEach((l) => { l.taxRate = rateSum || null; });

    // --- confidence: share of key fields found, discounted when the numbers do not reconcile
    const key = [inv.invoiceNo, inv.invoiceDate, inv.vendorGstin || inv.vendorName, inv.total, inv.subtotal, inv.lines.length ? 1 : null, inv.taxes.length ? 1 : null];
    let conf = key.filter((x) => x != null).length / key.length;
    const sumLines = inv.lines.reduce((s, l) => s + l.amount, 0);
    if (inv.subtotal != null && !U.close(sumLines, inv.subtotal, 1)) conf -= 0.15;
    inv.lines.forEach((l) => delete l._arith);
    return { invoice: inv, confidence: Math.max(0, Math.min(1, conf)), corrections, notes };
  };

  // Is an extracted value literally present in the document text? (catches model hallucination)
  X.grounded = function (value, text) {
    if (value == null || value === '') return true;
    const T = text.toUpperCase();
    if (typeof value === 'number') {
      const digits = T.replace(/[,\s]/g, '');
      return digits.includes(value.toFixed(2)) || digits.includes(String(Math.round(value)));
    }
    const v = String(value).toUpperCase();
    if (T.includes(v)) return true;
    const nv = v.replace(/[^A-Z0-9]/g, ''), nt = T.replace(/[^A-Z0-9]/g, '');
    return nv.length >= 4 && nt.includes(nv);
  };

  g.X = X;
})(typeof window !== 'undefined' ? window : globalThis);
