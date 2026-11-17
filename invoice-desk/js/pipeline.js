/* The invoice process. Eight stages, each emitting findings. AI may read the document; only these rules decide.
   Environment-agnostic: the browser and the Node test-runner inject document reading, OCR and AI. */
(function (g) {
  const U = g.U, X = g.X;
  const P = {};

  P.STAGES = [
    { id: 'ingest', name: 'Receive document', blurb: 'Fingerprint the file and check it is something we can read.' },
    { id: 'read', name: 'Read the document', blurb: 'Use the PDF text layer, or OCR the page if it is a scan.' },
    { id: 'extract', name: 'Extract invoice fields', blurb: 'Turn the page into structured fields, then cross-check them.' },
    { id: 'validate', name: 'Check the invoice itself', blurb: 'Mandatory fields, arithmetic, GST rules and dates.' },
    { id: 'vendor', name: 'Verify the vendor', blurb: 'Vendor master, approval status and bank details.' },
    { id: 'duplicate', name: 'Look for duplicates', blurb: 'Same file, same invoice number, or same bill re-dated.' },
    { id: 'match', name: 'Match PO and receipts', blurb: 'Three-way match: invoice vs purchase order vs goods/services received.' },
    { id: 'decide', name: 'Decide and route', blurb: 'Apply policy, choose an outcome and prepare the next action.' },
  ];
  const RANK = { ok: 0, info: 1, warn: 2, fail: 3 };
  const OUT_RANK = { APPROVED: 0, REVIEW: 1, HOLD: 2, REJECTED: 3 };
  const GL = {
    'Office supplies': '520100 Office supplies', 'Packaging material': '510300 Packing material', 'Freight & logistics': '530200 Freight inward',
    'IT services': '540100 IT services', 'Facility services': '550100 Facility management',
  };
  const TAX_GL = { CGST: '153100 Input CGST', SGST: '153200 Input SGST', UTGST: '153200 Input UTGST', IGST: '153300 Input IGST' };

  P.reconciles = function (inv) {
    if (!inv || inv.total == null) return false;
    const lines = (inv.lines || []).reduce((s, l) => s + (l.amount || 0), 0);
    const tax = (inv.taxes || []).reduce((s, t) => s + (t.amount || 0), 0);
    const sub = inv.subtotal != null ? inv.subtotal : lines;
    return (!inv.lines.length || U.close(lines, sub, 1)) && U.close(sub + tax, inv.total, 1);
  };

  P.ledgerFor = (state, po) => state.ledger.filter((e) => e.po === po && ['Posted', 'Paid', 'Approved'].includes(e.status));
  P.billedQty = (state, po, line) => P.ledgerFor(state, po).reduce((s, e) => s + (e.lines || []).filter((l) => l.poLine === line).reduce((a, l) => a + l.qty, 0), 0);
  P.receivedQty = (state, po, line) => state.ref.receipts.filter((r) => r.po === po).reduce((s, r) => s + r.lines.filter((l) => l.line === line).reduce((a, l) => a + l.qty, 0), 0);

  function lineMatch(invLines, po, tolPct) {
    const used = new Set();
    return invLines.map((il) => {
      let best = null;
      po.lines.forEach((pl) => {
        if (used.has(pl.line)) return;
        const sim = U.similarity(il.desc, pl.desc);
        const priceOk = Math.abs(il.rate - pl.price) / pl.price * 100 <= tolPct;
        const s = 0.65 * sim + 0.35 * (priceOk ? 1 : 0);
        if (!best || s > best.score) best = { pl, sim, score: s, priceOk };
      });
      if (best && best.sim >= 0.3) { used.add(best.pl.line); return { il, ...best }; }
      return { il, pl: null, sim: best ? best.sim : 0, score: 0 };
    });
  }

  function scorePO(state, inv, po, tol) {
    const lm = lineMatch(inv.lines, po, tol);
    const lineAvg = lm.reduce((s, m) => s + m.score, 0) / (lm.length || 1);
    const fits = lm.every((m) => m.pl && m.il.qty <= m.pl.qty - P.billedQty(state, po.po, m.pl.line) + 1e-9);
    return { po, score: U.round2(0.8 * lineAvg + 0.2 * (fits ? 1 : 0.4)), lm };
  }

  /* ------------------------------------------------------------------ run */
  P.run = async function (file, env) {
    const state = env.state, ref = state.ref, policy = ref.policy, company = ref.company;
    const run = {
      id: env.newRunId(), fileName: file.name, startedAt: new Date().toISOString(), stages: [], invoice: null,
      engine: null, vendorId: null, po: null, decision: null, match: null, preview: null,
    };
    const ctx = {};
    let current = null;
    const emit = (type, extra) => env.emit && env.emit({ type, run, stage: current, ...extra });
    const begin = async (id) => {
      const def = P.STAGES.find((s) => s.id === id);
      current = { id, name: def.name, status: 'running', findings: [], startedAt: performance.now(), ms: 0, summary: '' };
      run.stages.push(current); emit('stage-start');
      if (env.pace) await U.sleep(env.pace);
    };
    const f = (sev, text, o = {}) => { const item = { sev, text, ...o }; current.findings.push(item); emit('finding', { finding: item }); return item; };
    const end = (summary) => {
      current.ms = Math.round(performance.now() - current.startedAt);
      current.status = current.findings.reduce((w, x) => (RANK[x.sev] > RANK[w] ? x.sev : w), 'ok');
      current.summary = summary || '';
      emit('stage-end');
    };
    const skip = (id, why) => {
      const def = P.STAGES.find((s) => s.id === id);
      current = { id, name: def.name, status: 'skipped', findings: [{ sev: 'info', text: why }], ms: 0, summary: why };
      run.stages.push(current); emit('stage-end');
    };
    const T0 = performance.now();

    /* 1 ─ ingest */
    await begin('ingest');
    run.hash = await U.sha256(file.bytes);
    run.size = file.bytes.byteLength;
    const head = new Uint8Array(file.bytes.slice(0, 8));
    const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
    const isImg = (head[0] === 0x89 && head[1] === 0x50) || (head[0] === 0xff && head[1] === 0xd8);
    run.fileKind = isPdf ? 'pdf' : isImg ? 'image' : 'unknown';
    if (run.fileKind === 'unknown') {
      f('fail', 'File is not a PDF or an image', { outcome: 'REJECTED', ask: 'Please resend the invoice as a PDF.' });
      end('Unsupported file');
      P.STAGES.slice(1, -1).forEach((s) => skip(s.id, 'Skipped: unsupported file'));
      return finish();
    }
    f('ok', `${run.fileKind === 'pdf' ? 'PDF' : 'Image'} received · ${(run.size / 1024).toFixed(1)} KB`);
    f('info', `SHA-256 fingerprint ${run.hash.slice(0, 16)}…`, { detail: 'Used to detect the exact same file being submitted twice.' });
    end(`${run.fileKind.toUpperCase()}, ${(run.size / 1024).toFixed(0)} KB`);

    /* 2 ─ read */
    await begin('read');
    let doc;
    try { doc = await env.readDocument(file, run.fileKind); } catch (e) { doc = { pages: 0, lines: [], text: '', images: [], error: e.message }; }
    run.preview = doc.preview || null;
    run.pages = doc.pages;
    ctx.lines = doc.lines; ctx.text = doc.text; ctx.images = doc.images || [];
    if (doc.error) f('fail', 'Could not open the document', { detail: doc.error, outcome: 'REVIEW' });
    else if (doc.text.replace(/\s/g, '').length > 60) {
      run.readMode = 'text';
      f('ok', `Machine-readable text layer found on ${doc.pages} page${doc.pages > 1 ? 's' : ''}`, { detail: `${doc.text.length} characters, ${doc.lines.length} lines` });
    } else {
      run.readMode = 'scan';
      f('warn', 'No text layer — this is a scanned image', { detail: 'Scans are read with OCR, which can misread digits. Later stages re-check every number.' });
      if (env.ocr) {
        try {
          const o = await env.ocr(ctx.images, (p) => emit('progress', { progress: p }));
          ctx.lines = X.linesFromText(o.text); ctx.text = o.text; run.ocrConfidence = o.confidence;
          f(o.confidence != null && o.confidence < 70 ? 'warn' : 'ok', `OCR read ${ctx.lines.length} lines${o.confidence != null ? ` · engine confidence ${Math.round(o.confidence)}%` : ''}`);
        } catch (e) { f('warn', 'OCR failed', { detail: e.message }); }
      } else f('info', 'OCR engine not available in this view');
    }
    end(run.readMode === 'scan' ? 'Scanned image · OCR' : `Text layer · ${doc.lines.length} lines`);

    /* 3 ─ extract */
    await begin('extract');
    const heur = ctx.lines.length ? X.heuristic(ctx.lines, { company, vendors: ref.vendors }) : null;
    let inv = null, conf = 0;
    if (env.ai) {
      try {
        f('info', `Asking ${env.ai.label} to read the ${run.readMode === 'scan' ? 'page image' : 'document text'}…`);
        const t0 = performance.now();
        const ai = await env.ai.extract({ text: run.readMode === 'text' ? ctx.text : null, images: run.readMode === 'scan' ? ctx.images : [], ocrText: run.readMode === 'scan' ? ctx.text : null });
        run.engine = env.ai.label;
        f('ok', `${env.ai.label} returned structured fields in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
        // grounding: every identifier/amount the model returned must exist in the source text
        let miss = [];
        if (ctx.text) {
          const checks = [['Invoice number', ai.invoiceNo], ['Vendor GSTIN', ai.vendorGstin], ['PO number', ai.poNumber], ['Total', ai.total], ['Bank account', ai.bank && ai.bank.account]];
          miss = checks.filter(([, v]) => v != null && v !== '' && !X.grounded(v, ctx.text)).map((m) => m[0]);
        }
        const grounded = run.readMode !== 'text' || !miss.length;
        const aiOk = P.reconciles(ai) && grounded, hOk = !!(heur && P.reconciles(heur.invoice));
        if (heur && heur.invoice.total != null && !U.close(heur.invoice.total, ai.total, 1)) {
          if (!aiOk && hOk) { inv = heur.invoice; f('warn', `Model read ${U.money(ai.total)}${!grounded ? ` and returned values not in the document (${miss.join(', ')})` : ' which does not reconcile'}; the rule-based read ${U.money(heur.invoice.total)} reconciles — using it`); }
          else if (aiOk && !hOk) { inv = ai; f('info', 'Rule-based parser disagreed on the total; the model\'s figures are grounded and reconcile, so they were kept'); }
          else { inv = ai; f('warn', `Two independent reads disagree on the total (${U.money(ai.total)} vs ${U.money(heur.invoice.total)})`, { outcome: 'REVIEW' }); }
        } else { inv = ai; if (heur && heur.invoice.total != null) f('ok', 'Independent rule-based read agrees on the total'); }
        if (inv === ai) {
          if (miss.length && run.readMode === 'text') f('warn', `Not found verbatim in the document: ${miss.join(', ')}`, { outcome: 'REVIEW', detail: 'The model returned values that do not appear in the text. A person must confirm them.' });
          else if (miss.length) f('info', `OCR text does not contain: ${miss.join(', ')} — expected on scans; the vision read is cross-checked by arithmetic`);
          else if (ctx.text) f('ok', 'Grounding check: every key value appears verbatim in the document');
        }
        conf = inv === ai ? (aiOk ? 0.95 : 0.7) : heur.confidence;
        if (inv !== ai) run.engine = `${env.ai.label} → rule-based`;
      } catch (e) {
        f('warn', `${env.ai.label} unavailable — fell back to the rule-based parser`, { detail: String(e.message || e).slice(0, 240) });
      }
    }
    if (!inv && heur) { inv = heur.invoice; conf = heur.confidence; run.engine = 'Rule-based parser'; f('ok', `Rule-based parser extracted ${inv.lines.length} line item${inv.lines.length === 1 ? '' : 's'}`); }
    if (heur && heur.corrections.length) heur.corrections.forEach((c) => f('warn', 'Auto-corrected a misread value', { detail: c }));
    if (inv && inv.notes && inv.notes.length) inv.notes.forEach((n) => f('info', 'Notice printed on the invoice', { detail: n }));
    if (!inv || (!inv.total && !inv.invoiceNo)) {
      f('fail', 'Could not read invoice fields from this document', { outcome: 'REVIEW', internal: 'Key the invoice in manually, or ask the vendor for a clearer copy.' });
      run.invoice = inv; run.extractConfidence = 0;
      end('Unreadable');
      ['validate', 'vendor', 'duplicate', 'match'].forEach((id) => skip(id, 'Skipped: nothing reliable to check'));
      return finish();
    }
    run.invoice = inv; run.extractConfidence = conf;
    if (conf < policy.minExtractionConfidence) f('warn', `Extraction confidence ${Math.round(conf * 100)}% is below the ${Math.round(policy.minExtractionConfidence * 100)}% bar`, { outcome: 'REVIEW' });
    else f('ok', `Extraction confidence ${Math.round(conf * 100)}%`);
    end(`${run.engine} · ${inv.lines.length} lines · ${U.money(inv.total)}`);

    /* 4 ─ validate the document */
    await begin('validate');
    const missing = [['invoice number', inv.invoiceNo], ['invoice date', inv.invoiceDate], ['total amount', inv.total], ['vendor GSTIN', inv.vendorGstin]].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) f('fail', `Missing on the invoice: ${missing.join(', ')}`, { outcome: 'REVIEW', ask: `The invoice does not show the ${missing.join(', ')}. Please send a corrected invoice that includes ${missing.length > 1 ? 'them' : 'it'}.` });
    else f('ok', 'All mandatory fields present');
    const lineSum = inv.lines.reduce((s, l) => s + l.amount, 0);
    const badLines = inv.lines.filter((l) => !U.close(l.qty * l.rate, l.amount, 1));
    const taxSum = inv.taxes.reduce((s, t) => s + t.amount, 0);
    if (badLines.length) f('fail', `Line arithmetic wrong on ${badLines.length} line(s)`, { outcome: 'REVIEW', detail: badLines.map((l) => `${l.desc}: ${l.qty} × ${U.num(l.rate)} ≠ ${U.num(l.amount)}`).join('; ') });
    else if (inv.subtotal != null && !U.close(lineSum, inv.subtotal, 1)) f('fail', `Line items add up to ${U.money(lineSum)} but subtotal says ${U.money(inv.subtotal)}`, { outcome: 'REVIEW' });
    else if (inv.total != null && !U.close((inv.subtotal ?? lineSum) + taxSum, inv.total, 1)) f('fail', `Subtotal + tax = ${U.money((inv.subtotal ?? lineSum) + taxSum)} but total says ${U.money(inv.total)}`, { outcome: 'REVIEW' });
    else f('ok', 'Arithmetic reconciles: lines → subtotal → tax → total');
    // GST registration checks
    if (inv.vendorGstin) {
      if (!U.gstinValid(inv.vendorGstin)) f('fail', `Vendor GSTIN ${inv.vendorGstin} fails the format/checksum test`, { outcome: 'HOLD', detail: 'An invalid GSTIN means no input tax credit and is a common sign of a fabricated invoice.' });
      else f('ok', `Vendor GSTIN ${inv.vendorGstin} is well-formed (checksum valid)`);
    }
    if (inv.buyerGstin && inv.buyerGstin !== company.gstin) f('fail', `Invoice is billed to GSTIN ${inv.buyerGstin}, not ours (${company.gstin})`, { outcome: 'REVIEW', ask: `Please re-issue the invoice to ${company.name}, GSTIN ${company.gstin}.` });
    else if (!inv.buyerGstin) f('warn', 'Our GSTIN is not printed on the invoice', { outcome: 'REVIEW', detail: 'Without it we cannot claim input tax credit.', ask: `Please include our GSTIN ${company.gstin} on the invoice.` });
    else f('ok', 'Billed to our GSTIN');
    // place of supply → which GST applies
    const vState = U.stateOf(inv.vendorGstin), intra = vState === company.state;
    const types = inv.taxes.map((t) => t.type);
    if (vState && inv.taxes.length) {
      const expect = intra ? 'CGST + SGST' : 'IGST';
      const right = intra ? types.includes('CGST') && types.includes('SGST') && !types.includes('IGST') : types.includes('IGST') && !types.includes('CGST');
      if (right) f('ok', `Tax type correct: ${intra ? 'intra-state' : 'inter-state'} supply → ${expect}`);
      else f('fail', intra ? `Wrong GST type: vendor and buyer are both registered in ${company.stateName}, so CGST + SGST applies, but the invoice charges ${types.join(' + ')}` : `Wrong GST type: vendor (state ${vState}) and buyer (${company.stateName}) are in different states, so IGST applies, but the invoice charges ${types.join(' + ')}`, {
        outcome: 'REVIEW', detail: 'Tax charged under the wrong head cannot be claimed as input credit; the vendor must re-issue.',
        ask: `The invoice charges ${types.join(' + ')}, but as both our GSTINs are registered in ${company.stateName} this is an intra-state supply that should carry CGST + SGST. Please issue a revised invoice (or a credit note and a fresh invoice) with the correct tax heads.`,
      });
      if (intra) { const c = inv.taxes.find((t) => t.type === 'CGST'), s = inv.taxes.find((t) => t.type === 'SGST'); if (c && s && !U.close(c.amount, s.amount, 1)) f('fail', 'CGST and SGST amounts differ', { outcome: 'REVIEW' }); }
    }
    // dates
    const today = U.today();
    if (inv.invoiceDate) {
      const age = U.daysBetween(inv.invoiceDate, today);
      if (age < 0) f('fail', `Invoice is dated in the future (${U.fmtDate(inv.invoiceDate)})`, { outcome: 'REVIEW' });
      else if (age > policy.maxInvoiceAgeDays) f('warn', `Invoice is ${age} days old (limit ${policy.maxInvoiceAgeDays})`, { outcome: 'REVIEW' });
      else f('ok', `Dated ${U.fmtDate(inv.invoiceDate)} (${age} day${age === 1 ? '' : 's'} ago)`);
    }
    end();

    /* 5 ─ vendor */
    await begin('vendor');
    let vendor = ref.vendors.find((v) => v.gstin === inv.vendorGstin);
    if (vendor) f('ok', `Matched vendor master ${vendor.id} by GSTIN`, { detail: vendor.name });
    else {
      const byName = ref.vendors.map((v) => ({ v, s: Math.max(...[v.name].concat(v.aliases || []).map((n) => U.similarity(n, inv.vendorName || ''))) })).sort((a, b) => b.s - a.s)[0];
      if (byName && byName.s >= 0.75) {
        vendor = byName.v;
        f('fail', `Name looks like ${vendor.name} (${vendor.id}), but the GSTIN on the invoice (${inv.vendorGstin || 'none'}) is not the one on file (${vendor.gstin})`, { outcome: 'HOLD', internal: `Confirm with ${vendor.contact.name} on the registered number ${vendor.contact.phone} whether ${inv.vendorGstin} belongs to them before any payment.` });
      } else {
        f('fail', `"${inv.vendorName || 'Unknown vendor'}" is not in the approved vendor master`, {
          outcome: 'REJECTED', detail: inv.vendorGstin ? `GSTIN ${inv.vendorGstin} not registered with us.` : '',
          ask: `We could not find ${inv.vendorName || 'your company'} in our approved vendor list, and there is no purchase order for this invoice, so we are unable to process it. If this work was commissioned by our team, please ask your contact to raise a purchase order and complete vendor onboarding (company, GST and bank verification); then send the invoice quoting the PO number.`,
          internal: 'Route to Procurement: unapproved supplier, no PO (possible maverick spend). Identify the requester before anything is paid.',
        });
      }
    }
    if (vendor) {
      run.vendorId = vendor.id;
      if (vendor.status !== 'approved') f('fail', `Vendor status is "${vendor.status}"`, { outcome: 'REJECTED' });
      else f('ok', `Approved vendor · ${vendor.category} · Net ${vendor.paymentTermsDays} terms`);
      const b = inv.bank || {};
      if (b.account) {
        const sameAcc = b.account.replace(/\D/g, '') === vendor.bank.account, sameIfsc = !b.ifsc || b.ifsc === vendor.bank.ifsc;
        if (sameAcc && sameIfsc) f('ok', `Bank details match the vendor master (${vendor.bank.name} ••${vendor.bank.account.slice(-4)})`);
        else {
          const phone = (inv.notes || []).join(' ').match(/\+?\d[\d\s]{9,14}\d/);
          f('fail', `Bank account on invoice differs from vendor master`, {
            outcome: 'HOLD',
            detail: `Invoice: ${b.name || '?'} ${b.account} / ${b.ifsc || '?'} · Master: ${vendor.bank.name} ${vendor.bank.account} / ${vendor.bank.ifsc}. Changed bank details on an invoice are the classic payment-diversion (business email compromise) pattern.`,
            internal: `Do not pay or update the vendor master from this invoice. Call ${vendor.contact.name} on the number already on file (${vendor.contact.phone})${phone ? `, not the number printed on the invoice (${phone[0].trim()})` : ''}, and ask for a cancelled cheque or bank letter on letterhead. Update the master only through the vendor-change process with a second approver.`,
          });
        }
      } else f('info', `No bank details on invoice — payment will go to the account on file (${vendor.bank.name} ••${vendor.bank.account.slice(-4)})`);
      if ((inv.notes || []).some((n) => /bank|remit|account/i.test(n))) f('warn', 'Invoice text asks to pay a new/different account', { detail: inv.notes.join(' ') });
    }
    end(vendor ? `${vendor.id} · ${vendor.name}` : 'Not in vendor master');

    /* 6 ─ duplicates */
    await begin('duplicate');
    const prevRuns = state.runs.filter((r) => r.id !== run.id);
    const sameFile = prevRuns.find((r) => r.hash === run.hash && r.decision);
    const nNo = U.normInvoiceNo(inv.invoiceNo);
    const vid = vendor && vendor.id;
    const sameNoLedger = nNo && state.ledger.find((e) => e.vendorId === vid && U.normInvoiceNo(e.invoiceNo) === nNo);
    const sameNoRun = nNo && prevRuns.find((r) => r.vendorId === vid && r.invoice && U.normInvoiceNo(r.invoice.invoiceNo) === nNo && r.decision && ['REVIEW', 'HOLD'].includes(r.finalStatus || r.decision.status));
    if (sameFile) f('fail', `This exact file was already processed in ${sameFile.id} (${sameFile.finalStatus || sameFile.decision.status})`, { outcome: 'REJECTED', dupOf: sameFile.id, internal: 'No action needed — identical file received twice.' });
    if (sameNoLedger) {
      const exact = sameNoLedger.invoiceNo === inv.invoiceNo;
      f('fail', `Invoice ${inv.invoiceNo} ${exact ? 'is' : `is the same number as`} ${exact ? 'already in the ledger' : `${sameNoLedger.invoiceNo}`} — ${sameNoLedger.status.toLowerCase()} on ${U.fmtDate(sameNoLedger.postedOn)} (${sameNoLedger.id})`, {
        outcome: 'REJECTED', dupOf: sameNoLedger.id,
        detail: exact ? '' : `Numbers normalise to the same key "${nNo}" once separators and leading zeros are ignored. Amount ${U.close(sameNoLedger.total, inv.total, 1) ? 'also matches' : 'differs'} (${U.money(sameNoLedger.total)}).`,
        ask: `Invoice ${inv.invoiceNo} for ${U.money(inv.total)} matches invoice ${sameNoLedger.invoiceNo} which we ${sameNoLedger.status === 'Paid' ? 'paid' : 'booked'} on ${U.fmtDate(sameNoLedger.postedOn)} (our ref ${sameNoLedger.id}). No further payment is due. If you believe this is a separate charge, please send a new invoice number with supporting details.`,
      });
    }
    if (!sameNoLedger && sameNoRun) f('fail', `Invoice ${inv.invoiceNo} is already waiting in the queue (${sameNoRun.id}, ${sameNoRun.finalStatus || sameNoRun.decision.status})`, { outcome: 'REJECTED', dupOf: sameNoRun.id });
    if (!sameFile && !sameNoLedger && !sameNoRun) {
      f('ok', `No invoice "${inv.invoiceNo}" (key ${nNo}) from this vendor in the ledger or queue`);
      // softer pattern: same vendor + same amount within N days, different number (re-dated / re-numbered bill)
      const near = state.ledger.find((e) => e.vendorId === vid && U.close(e.total, inv.total, 1) && inv.invoiceDate && Math.abs(U.daysBetween(e.invoiceDate, inv.invoiceDate)) <= policy.possibleDuplicateWindowDays);
      if (near) f('warn', `Possible duplicate: ${near.invoiceNo} from the same vendor for the same amount ${U.money(near.total)}, ${Math.abs(U.daysBetween(near.invoiceDate, inv.invoiceDate))} days apart`, { outcome: 'REVIEW', dupOf: near.id });
      else f('ok', 'No same-amount bill from this vendor in the last ' + policy.possibleDuplicateWindowDays + ' days');
    }
    end();

    /* 7 ─ PO / receipts three-way match */
    const blocked = current.findings.some((x) => x.outcome === 'REJECTED');
    if (!vendor) skip('match', 'Skipped: vendor unknown, so there is no PO to match');
    else if (blocked) skip('match', 'Skipped: invoice already rejected as a duplicate');
    else {
      await begin('match');
      const tol = policy.linePriceTolerancePct;
      let po = null;
      if (inv.poNumber) {
        po = ref.pos.find((p) => p.po === inv.poNumber);
        if (!po) f('fail', `PO ${inv.poNumber} quoted on the invoice does not exist`, { outcome: 'REVIEW', ask: `The PO number ${inv.poNumber} on your invoice does not match any purchase order from ${company.name}. Please confirm the correct PO number.` });
        else if (po.vendorId !== vendor.id) { f('fail', `PO ${po.po} belongs to a different vendor (${po.vendorId})`, { outcome: 'HOLD' }); po = null; }
        else { f('ok', `PO ${po.po} quoted on invoice — found, ${po.status}`, { detail: po.title }); run.poSource = 'explicit'; }
      }
      if (!po) {
        const open = ref.pos.filter((p) => p.vendorId === vendor.id && p.status === 'open');
        const scored = open.map((p) => scorePO(state, inv, p, tol)).sort((a, b) => b.score - a.score);
        run.poCandidates = scored.map((s) => ({ po: s.po.po, title: s.po.title, score: s.score }));
        if (!inv.poNumber) f('warn', 'No PO number on the invoice — searching this vendor\'s open POs', { detail: `${open.length} open PO(s) for ${vendor.name}` });
        scored.forEach((s) => f('info', `Candidate PO ${s.po.po} · match score ${Math.round(s.score * 100)}%`, { detail: s.po.title }));
        const top = scored[0], second = scored[1];
        if (top && top.score >= policy.poInferenceMinScore && (!second || top.score - second.score >= 0.15)) {
          po = top.po; run.poSource = 'inferred';
          f('warn', `Matched to PO ${po.po} by line items and prices (${Math.round(top.score * 100)}% score) — inferred, not quoted`, {
            outcome: 'REVIEW', detail: 'Policy: an inferred PO is never auto-approved. A reviewer confirms the match with one click.',
            ask: `For future invoices, please quote our PO number (${po.po} in this case) so we can process them automatically.`,
          });
        } else f('fail', 'No purchase order could be matched with confidence', { outcome: 'REVIEW', ask: `Your invoice ${inv.invoiceNo} does not quote a purchase order and we could not match it to an open order. Please reply with the PO number.` });
      }
      if (po) {
        run.po = po.po;
        const lm = lineMatch(inv.lines, po, tol);
        const rows = []; let payableSub = 0, heldSub = 0; const credit = []; const awaiting = [];
        lm.forEach((m) => {
          const il = m.il;
          if (!m.pl) { f('fail', `"${il.desc}" is not on PO ${po.po}`, { outcome: 'REVIEW', ask: `Line "${il.desc}" is not part of PO ${po.po}. Please share the order reference for it or remove it.` }); heldSub += il.amount; rows.push({ desc: il.desc, poLine: null }); return; }
          const pl = m.pl;
          const billed = P.billedQty(state, po.po, pl.line), recv = P.receivedQty(state, po.po, pl.line);
          const eligible = Math.max(0, Math.min(pl.qty, recv) - billed);
          const payableQty = Math.min(il.qty, eligible);
          const overPO = Math.max(0, Math.min(il.qty - payableQty, billed + il.qty - pl.qty));
          const notRecv = Math.max(0, il.qty - payableQty - overPO);
          const var_ = ((il.rate - pl.price) / pl.price) * 100;
          rows.push({ desc: il.desc, poLine: pl.line, poDesc: pl.desc, qty: il.qty, rate: il.rate, poPrice: pl.price, poQty: pl.qty, billedBefore: billed, received: recv, payableQty, overPO, notRecv, variancePct: U.round2(var_), sim: U.round2(m.sim) });
          const label = `Line ${pl.line} · ${pl.desc}`;
          if (Math.abs(var_) <= 0.01) f('ok', `${label}: price ${U.money(il.rate)} matches PO`);
          else if (Math.abs(var_) <= tol) f('info', `${label}: price ${U.money(il.rate)} vs PO ${U.money(pl.price)} (${var_ > 0 ? '+' : ''}${var_.toFixed(1)}%, within ±${tol}% tolerance)`);
          else if (var_ > 0) f('fail', `${label}: billed at ${U.money(il.rate)} vs PO price ${U.money(pl.price)} (+${var_.toFixed(1)}%, tolerance ±${tol}%)`, {
            outcome: 'REVIEW', ask: `Line "${il.desc}" is billed at ${U.money(il.rate)} per ${pl.uom}, but PO ${po.po} line ${pl.line} is at ${U.money(pl.price)}. Please issue a credit note for the difference of ${U.money((il.rate - pl.price) * il.qty)} (plus GST) or a revised invoice.`,
          });
          else f('info', `${label}: billed below PO price (${var_.toFixed(1)}%) — in our favour`);
          const kind = state.ref.receipts.find((r) => r.po === po.po)?.kind === 'Service entry' ? 'service entries' : 'goods receipts';
          if (overPO > 0 || notRecv > 0) {
            f('fail', `${label}: billing ${U.num(il.qty)} ${pl.uom} but only ${U.num(Math.max(0, Math.min(pl.qty, recv) - billed))} are payable`, {
              outcome: 'HOLD',
              detail: `Ordered ${U.num(pl.qty)} · received ${U.num(recv)} (${kind}) · already invoiced ${U.num(billed)} · this invoice ${U.num(il.qty)} → payable now ${U.num(payableQty)}, awaiting receipt ${U.num(notRecv)}, beyond PO ${U.num(overPO)}.`,
              internal: notRecv > 0 ? `Release the ${U.num(notRecv)} ${pl.uom} awaiting receipt once the warehouse posts the goods receipt.` : undefined,
            });
            if (overPO > 0) credit.push({ desc: pl.desc, qty: overPO, uom: pl.uom, amount: overPO * il.rate });
            if (notRecv > 0) awaiting.push({ desc: pl.desc, qty: notRecv, uom: pl.uom, amount: notRecv * il.rate });
          } else f('ok', `${label}: ${U.num(il.qty)} ${pl.uom} billed ≤ ${U.num(recv - billed)} received and not yet invoiced`, { detail: `Ordered ${U.num(pl.qty)} · received ${U.num(recv)} · previously invoiced ${U.num(billed)}` });
          const rateSum = inv.taxes.reduce((s, t) => s + (t.rate || 0), 0);
          if (rateSum && pl.taxRate && Math.abs(rateSum - pl.taxRate) > 0.01) f('fail', `${label}: GST ${rateSum}% charged, PO specifies ${pl.taxRate}%`, { outcome: 'REVIEW' });
          payableSub += payableQty * Math.min(il.rate, pl.price * (1 + tol / 100));
          heldSub += il.amount - payableQty * Math.min(il.rate, pl.price * (1 + tol / 100));
        });
        const rateSum = inv.taxes.reduce((s, t) => s + (t.rate || 0), 0) || 0;
        run.match = { po: po.po, source: run.poSource, rows, payableSub: U.round2(payableSub), payableTotal: U.round2(payableSub * (1 + rateSum / 100)), heldSub: U.round2(heldSub), credit, awaiting, taxRate: rateSum };
        if (credit.length) {
          const amt = credit.reduce((s, c) => s + c.amount, 0);
          const hf = current.findings.find((x) => x.outcome === 'HOLD' && !x.ask);
          if (hf) hf.ask = `Invoice ${inv.invoiceNo} bills ${credit.map((c) => `${U.num(c.qty)} ${c.uom} of ${c.desc}`).join(', ')} beyond the quantity on PO ${po.po}. Please issue a credit note for ${U.money(amt)} plus GST (${U.money(amt * (1 + rateSum / 100))}).${awaiting.length ? ` A further ${awaiting.map((a) => `${U.num(a.qty)} ${a.uom}`).join(', ')} is billed ahead of delivery; we will release that portion automatically once the goods are received.` : ''} We can pay the received portion of ${U.money(run.match.payableTotal)} now.`;
        }
        if (heldSub < 1) f('ok', `Three-way match complete — full invoice value is payable`);
      }
      end(run.po ? `PO ${run.po}${run.poSource === 'inferred' ? ' (inferred)' : ''}` : 'No PO');
    }
    return finish();

    /* 8 ─ decide */
    async function finish() {
      await begin('decide');
      const all = run.stages.flatMap((s) => s.findings.map((x) => ({ ...x, stage: s.name })));
      const blocking = all.filter((x) => x.outcome);
      let status = blocking.reduce((w, x) => (OUT_RANK[x.outcome] > OUT_RANK[w] ? x.outcome : w), 'APPROVED');
      const inv = run.invoice;
      const vendor = ref.vendors.find((v) => v.id === run.vendorId);
      if (status === 'APPROVED' && inv && inv.total > policy.autoApproveLimit) {
        blocking.push(f('warn', `Above the auto-approval limit of ${U.money(policy.autoApproveLimit)}`, { outcome: 'REVIEW', internal: 'Needs Finance Controller sign-off.' }));
        status = 'REVIEW';
      }
      const top = blocking.filter((x) => x.outcome === status);
      const d = { status, reasons: top.map((x) => x.text), others: blocking.filter((x) => x.outcome !== status).map((x) => x.text) };
      const asks = [...new Set(blocking.filter((x) => x.ask).map((x) => x.ask))];
      const internal = [...new Set(blocking.filter((x) => x.internal).map((x) => x.internal))];
      if (status === 'APPROVED') {
        const due = U.addDays(inv.invoiceDate, vendor.paymentTermsDays), runDate = U.paymentRun(due);
        d.headline = `Approved for payment on the ${U.fmtDate(runDate)} payment run`;
        d.queue = 'Auto-posted'; d.posting = P.posting(run, state, vendor, due, runDate);
        f('ok', `Every check passed — posted ${d.posting.document}, due ${U.fmtDate(due)}`);
      } else if (status === 'REVIEW') {
        d.headline = top.length === 1 ? top[0].text : `${top.length} things need a person's judgement`;
        d.queue = internal.some((i) => /Controller/.test(i)) ? 'Finance Controller' : 'AP reviewer';
        f('warn', `Routed to ${d.queue} with ${top.length} question${top.length > 1 ? 's' : ''}`);
      } else if (status === 'HOLD') {
        d.headline = top.length === 1 ? top[0].text : `${top.length} blocking issues — payment held`;
        d.queue = top.some((x) => /bank/i.test(x.text)) ? 'AP lead + Treasury' : 'AP lead';
        f('fail', `Payment blocked until resolved`);
      } else {
        d.headline = top[0] ? top[0].text : 'Rejected';
        d.queue = 'Closed';
        f('fail', 'Rejected — nothing will be posted or paid');
      }
      if (run.match && run.match.payableTotal && status === 'HOLD' && run.match.heldSub > 1) d.partial = { payable: run.match.payableTotal, held: U.round2(inv.total - run.match.payableTotal) };
      if (asks.length && (vendor || status === 'REJECTED')) d.vendorEmail = P.email(run, vendor, asks, status, company);
      d.internal = internal;
      run.decision = d;
      end(status);
      run.finishedAt = new Date().toISOString();
      run.durationMs = Math.round(performance.now() - T0);
      emit('done');
      return run;
    }
  };

  // Write the outcome into the AP ledger (what an ERP posting would do). Used for auto-approval and reviewer approval.
  P.commit = function (run, state, opts = {}) {
    const d = run.decision, inv = run.invoice;
    const vendor = state.ref.vendors.find((v) => v.id === run.vendorId);
    let posting = d.posting;
    if (!posting) {
      const due = U.addDays(inv.invoiceDate || U.today(), vendor ? vendor.paymentTermsDays : 30);
      const override = opts.partial ? { lines: run.match.rows.filter((r) => r.poLine && r.payableQty > 0).map((r) => ({ poLine: r.poLine, qty: r.payableQty, amount: U.round2(r.payableQty * Math.min(r.rate, r.poPrice)), desc: r.poDesc })) } : null;
      posting = P.posting(run, state, vendor, due, U.paymentRun(due), override);
      d.posting = posting;
    }
    state.ledger.push({
      id: posting.document, vendorId: run.vendorId, invoiceNo: inv.invoiceNo, invoiceDate: inv.invoiceDate, po: run.po,
      subtotal: U.round2(posting.expense.reduce((s, l) => s + l.amount, 0)), tax: U.round2(posting.tax.reduce((s, t) => s + t.amount, 0)), total: posting.payable,
      status: 'Approved', postedOn: U.today(), runId: run.id, lines: posting.expense.map((l) => ({ poLine: l.poLine, qty: l.qty })), partial: !!opts.partial,
    });
    return posting;
  };

  P.posting = function (run, state, vendor, due, runDate, override) {
    const inv = run.invoice;
    const doc = `AP-26-${String(++state.counters.ap).padStart(5, '0')}`;
    const lines = override ? override.lines : (run.match ? run.match.rows.filter((r) => r.poLine).map((r) => ({ poLine: r.poLine, qty: r.qty, amount: U.round2(r.qty * r.rate), desc: r.poDesc })) : []);
    const sub = lines.reduce((s, l) => s + l.amount, 0);
    const ratio = inv.subtotal ? sub / inv.subtotal : 1;
    return {
      document: doc, vendor: vendor.id, vendorName: vendor.name, invoiceNo: inv.invoiceNo, invoiceDate: inv.invoiceDate, postingDate: U.today(), po: run.po,
      expense: lines.map((l) => ({ gl: GL[vendor.category] || '590000 Other expenses', poLine: l.poLine, desc: l.desc, qty: l.qty, amount: U.round2(l.amount) })),
      tax: inv.taxes.map((t) => ({ gl: TAX_GL[t.type], type: t.type, rate: t.rate, amount: U.round2(t.amount * ratio) })),
      payable: U.round2(sub + inv.taxes.reduce((s, t) => s + t.amount * ratio, 0)), dueDate: due, paymentRun: runDate,
      payTo: `${vendor.bank.name} ${vendor.bank.account} (${vendor.bank.ifsc}) — from vendor master, never from the invoice`,
    };
  };

  P.email = function (run, vendor, asks, status, company) {
    const inv = run.invoice || {};
    const to = vendor ? vendor.contact.email : 'Sender of the invoice';
    const subj = {
      REJECTED: `Invoice ${inv.invoiceNo || ''} — not processed`,
      HOLD: `Invoice ${inv.invoiceNo || ''} — action needed before payment`,
      REVIEW: `Invoice ${inv.invoiceNo || ''} — correction needed`,
      APPROVED: `Invoice ${inv.invoiceNo || ''} — received`,
    }[status];
    const greet = vendor ? `Dear ${vendor.contact.name},` : 'Hello,';
    const body = [greet, '', `Thank you for invoice ${inv.invoiceNo || '(no number)'} dated ${U.fmtDate(inv.invoiceDate)} for ${U.money(inv.total)}.`, '',
      ...(asks.length > 1 ? asks.map((a, i) => `${i + 1}. ${a}`) : asks), '',
      'Please reply to this email with the documents requested and quote our reference ' + run.id + '.', '', 'Regards,', 'Accounts Payable', company.name].join('\n');
    return { to, subject: subj, body };
  };

  g.P = P;
})(typeof window !== 'undefined' ? window : globalThis);
