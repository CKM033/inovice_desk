/* AI extraction adapters. The model only READS the invoice into a fixed schema; it never decides anything.
   Two adapters: Claude via the user's own API key (direct browser call), or Claude through the hosting page
   (claude.ai artifact runtime) when available. Both return the same canonical invoice object. */
(function (g) {
  const U = g.U;
  const AI = {};

  AI.INSTRUCTIONS = `You are reading a vendor invoice for an accounts-payable team in India.
Extract the fields exactly as printed on the document.
Rules:
- Do not calculate, correct or infer anything that is not printed. If a field is absent, use null.
- Dates as YYYY-MM-DD. Indian invoices write numeric dates as DD/MM/YYYY.
- Amounts as plain numbers (no commas, no currency symbols). Copy line amounts as printed even if they look wrong.
- po_number only if the invoice explicitly shows a purchase order / buyer's order number; otherwise null. Do not guess from other references.
- vendor_gstin is the seller's GSTIN; buyer_gstin is the GSTIN of the billed-to company.
- taxes: one entry per tax line (CGST, SGST, UTGST, IGST, or other) with its rate in percent and amount.
- notes: copy verbatim any sentence about changed bank details, new payment instructions, reminders or overdue notices.`;

  AI.SCHEMA = {
    type: 'object',
    properties: {
      vendor_name: { type: ['string', 'null'] }, vendor_gstin: { type: ['string', 'null'] }, buyer_gstin: { type: ['string', 'null'] },
      invoice_number: { type: ['string', 'null'] }, invoice_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
      po_number: { type: ['string', 'null'] }, currency: { type: ['string', 'null'] },
      line_items: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, quantity: { type: ['number', 'null'] }, unit_price: { type: ['number', 'null'] }, amount: { type: ['number', 'null'] } }, required: ['description', 'quantity', 'unit_price', 'amount'] } },
      subtotal: { type: ['number', 'null'] },
      taxes: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, rate: { type: ['number', 'null'] }, amount: { type: ['number', 'null'] } }, required: ['type', 'rate', 'amount'] } },
      total: { type: ['number', 'null'] },
      bank: { type: 'object', properties: { bank_name: { type: ['string', 'null'] }, account_number: { type: ['string', 'null'] }, ifsc: { type: ['string', 'null'] } } },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['vendor_name', 'vendor_gstin', 'invoice_number', 'invoice_date', 'po_number', 'line_items', 'subtotal', 'taxes', 'total'],
  };

  AI.toInvoice = function (j) {
    const num = (v) => (v == null || v === '' ? null : typeof v === 'number' ? v : U.parseAmount(v));
    const taxes = (j.taxes || []).map((t) => ({ type: String(t.type || '').toUpperCase().replace(/[^A-Z]/g, '') || 'TAX', rate: num(t.rate), amount: num(t.amount) })).filter((t) => t.amount != null);
    const rateSum = taxes.reduce((s, t) => s + (t.rate || 0), 0) || null;
    const gstin = (s) => (s ? U.repairGstin(String(s).replace(/\s/g, '').toUpperCase()).value : null);
    const bank = j.bank || {};
    return {
      vendorName: j.vendor_name || null, vendorGstin: gstin(j.vendor_gstin), buyerGstin: gstin(j.buyer_gstin),
      invoiceNo: j.invoice_number ? String(j.invoice_number).trim() : null,
      invoiceDate: j.invoice_date ? U.parseDate(j.invoice_date) : null,
      poNumber: j.po_number ? String(j.po_number).replace(/^(PO)[\s#:\-\/]*/i, '').trim() : null,
      currency: j.currency || 'INR',
      lines: (j.line_items || []).map((l) => ({ desc: l.description, qty: num(l.quantity), rate: num(l.unit_price), amount: num(l.amount), taxRate: rateSum })).filter((l) => l.amount != null),
      subtotal: num(j.subtotal), taxes, total: num(j.total),
      bank: { name: bank.bank_name || null, account: bank.account_number ? String(bank.account_number).replace(/\D/g, '') : null, ifsc: bank.ifsc ? U.repairIfsc(String(bank.ifsc)).value : null },
      notes: (j.notes || []).filter(Boolean),
    };
  };

  const blobToB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });

  // Claude Messages API, called directly from the browser with the user's key. Forced tool call = schema-shaped output.
  AI.anthropic = function (apiKey, model) {
    return {
      label: `Claude (${model.replace(/^claude-/, '')})`,
      async extract({ text, images }) {
        const content = [];
        for (const im of (images || []).slice(0, 2)) content.push({ type: 'image', source: { type: 'base64', media_type: im.blob.type || 'image/jpeg', data: await blobToB64(im.blob) } });
        content.push({ type: 'text', text: text ? `Invoice text (from the PDF text layer):\n\n${text}` : 'The invoice is the scanned image above.' });
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 60000);
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
          body: JSON.stringify({
            model, max_tokens: 2000, system: AI.INSTRUCTIONS,
            tools: [{ name: 'record_invoice', description: 'Record the fields read from the invoice.', input_schema: AI.SCHEMA }],
            tool_choice: { type: 'tool', name: 'record_invoice' },
            messages: [{ role: 'user', content }],
          }),
        }).finally(() => clearTimeout(timer));
        if (!res.ok) { let m = `HTTP ${res.status}`; try { const e = await res.json(); m += ` — ${e.error && e.error.message}`; } catch (_) {} throw new Error(m); }
        const data = await res.json();
        const tu = (data.content || []).find((c) => c.type === 'tool_use');
        if (!tu) throw new Error('Model did not return structured fields');
        return AI.toInvoice(tu.input);
      },
    };
  };

  // Claude through the claude.ai artifact runtime (no key needed when the page is opened there).
  AI.inPage = function (sample, allowImages) {
    return {
      label: 'Claude (in page)',
      async extract({ text, images }) {
        const prompt = `${AI.INSTRUCTIONS}\n\nReturn ONLY a JSON object (no prose, no code fences) matching this JSON Schema:\n${JSON.stringify(AI.SCHEMA)}\n\n${text ? 'Invoice text:\n' + text : 'The invoice is the attached scanned image.'}`;
        const opts = { modelTier: 'default' };
        if (!text && images && images.length) {
          if (!allowImages) throw new Error('Image reading is not available in this view');
          opts.images = images.slice(0, 2).map((i) => i.blob);
        }
        const r = await sample(prompt, opts);
        const raw = String(r.text || '').replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '');
        const s = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
        return AI.toInvoice(JSON.parse(s));
      },
    };
  };

  g.AI = AI;
})(typeof window !== 'undefined' ? window : globalThis);
