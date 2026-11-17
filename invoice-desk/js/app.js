/* Invoice Desk — UI. Live run view, decision + reviewer actions, runs dashboard, reference data. */
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = U.esc, money = U.money;
  const STATE_KEY = 'invoice-desk-state-v1', SET_KEY = 'invoice-desk-settings-v1';
  const LABEL = { APPROVED: 'Approved', REVIEW: 'Needs review', HOLD: 'On hold', REJECTED: 'Rejected' };
  const STAMP = { APPROVED: ['Approved', 'for payment'], REVIEW: ['Review', 'needs a person'], HOLD: ['On hold', 'do not pay'], REJECTED: ['Rejected', 'not payable'] };

  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  /* ---------------------------------------------------------------- persistence */
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } },
  };
  const fresh = () => ({ version: 1, ref: structuredClone(SEED), ledger: structuredClone(SEED.invoiceHistory), runs: [], counters: { run: 0, ap: 1000 } });
  let state = store.get(STATE_KEY) || fresh();
  function save() {
    // keep the store small: previews only for the latest 15 runs
    state.runs.forEach((r, i) => { if (i >= 15) r.preview = null; });
    if (!store.set(STATE_KEY, state)) { state.runs.forEach((r) => (r.preview = null)); store.set(STATE_KEY, state); }
  }
  let settings = Object.assign({ engine: 'rules', apiKey: '', model: 'claude-sonnet-5-5', pace: true }, store.get(SET_KEY) || {});
  let inPage = null, inPageImages = false;

  /* ---------------------------------------------------------------- AI engine selection */
  function currentAI() {
    if (settings.engine === 'anthropic' && settings.apiKey) return AI.anthropic(settings.apiKey, settings.model);
    if (settings.engine === 'inpage' && inPage) return AI.inPage(inPage, inPageImages);
    return null;
  }
  function paintEngine() {
    const ai = currentAI(), b = $('#engineBtn');
    b.classList.toggle('rules', !ai);
    $('#engineLabel').textContent = ai ? `Reading with ${ai.label}` : 'Reading with rules only';
  }
  (async () => {
    try {
      if (window.claude && window.claude.use) {
        const s = await window.claude.use('sample');
        if (s) {
          inPage = s; $('#optInpage').hidden = false;
          try { inPageImages = !!(await s.limits()).images; } catch (_) {}
          if (!store.get(SET_KEY)) settings.engine = 'inpage';
          paintEngine();
        }
      }
    } catch (_) {}
  })();

  /* ---------------------------------------------------------------- document reading (browser) */
  async function readDocument(file, kind) {
    const out = { pages: 0, lines: [], text: '', images: [], preview: null };
    const toBlob = (c, q) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));
    if (kind === 'pdf') {
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(file.bytes.slice(0)) }).promise;
      out.pages = pdf.numPages;
      for (let p = 1; p <= Math.min(pdf.numPages, 6); p++) {
        const tc = await (await pdf.getPage(p)).getTextContent();
        out.lines = out.lines.concat(X.linesFromItems(tc.items, p));
      }
      out.text = out.lines.map((l) => l.text).join('\n');
      const scan = out.text.replace(/\s/g, '').length <= 60;
      const render = async (p, scale) => { const pg = await pdf.getPage(p); const vp = pg.getViewport({ scale }); const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; return c; };
      const pv = await render(1, 1.1); out.preview = pv.toDataURL('image/jpeg', 0.72);
      if (scan) for (let p = 1; p <= Math.min(pdf.numPages, 2); p++) { const c = await render(p, 2.2); out.images.push({ canvas: c, blob: await toBlob(c, 0.9) }); }
    } else {
      const blob = new Blob([file.bytes], { type: file.type || 'image/png' });
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
      const s = Math.min(1, 700 / bmp.width); const pc = document.createElement('canvas'); pc.width = bmp.width * s; pc.height = bmp.height * s;
      pc.getContext('2d').drawImage(bmp, 0, 0, pc.width, pc.height); out.preview = pc.toDataURL('image/jpeg', 0.72);
      out.pages = 1; out.images.push({ canvas: c, blob: await toBlob(c, 0.9) });
    }
    return out;
  }
  // OCR engine is self-hosted under vendor/tesseract (no CDN needed on demo day); CDN is only a fallback.
  let tessLoading = null, tessWorker = null;
  const abs = (p) => new URL(p, location.href).href;
  function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); }); }
  function loadTesseract() {
    if (!tessLoading) tessLoading = (async () => {
      if (!window.Tesseract) await loadScript('vendor/tesseract/tesseract.min.js').catch(() => loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'));
      try {
        tessWorker = await Tesseract.createWorker('eng', 1, { workerPath: abs('vendor/tesseract/worker.min.js'), corePath: abs('vendor/tesseract/'), langPath: abs('vendor/tesseract/lang'), logger: (m) => tessLogger(m) });
      } catch (e) {
        tessWorker = await Tesseract.createWorker('eng', 1, { logger: (m) => tessLogger(m) }); // CDN defaults
      }
    })().catch((e) => { tessLoading = null; throw e; });
    return tessLoading;
  }
  let tessLogger = () => {};
  async function ocr(images, onProgress) {
    tessLogger = (m) => { if (m.status === 'loading language traineddata' || m.status === 'initializing api') onProgress(0.05); };
    await loadTesseract();
    let text = '', conf = 0;
    for (let i = 0; i < images.length; i++) {
      tessLogger = (m) => { if (m.status === 'recognizing text') onProgress((i + m.progress) / images.length); };
      const r = await tessWorker.recognize(images[i].canvas);
      text += r.data.text + '\n'; conf += r.data.confidence;
    }
    return { text, confidence: conf / images.length };
  }

  /* ---------------------------------------------------------------- running */
  let live = null, viewing = null, busy = false, clockTimer = null, progress = null;
  const expanded = new Set();

  async function runFile(file) {
    if (busy) return;
    busy = true; setBusy(true); go('process');
    if (window.innerWidth < 820) setTimeout(() => $('#runcol').scrollIntoView({ behavior: 'smooth' }), 50);
    progress = null; expanded.clear();
    const env = {
      state, pace: settings.pace ? 450 : 0, ai: currentAI(), readDocument, ocr,
      newRunId: () => 'RUN-' + String(++state.counters.run).padStart(4, '0'),
      emit: (e) => {
        live = e.run; viewing = e.run.id;
        if (e.type === 'progress') { progress = e.progress; const bar = $('#ocrbar'); if (bar) { bar.style.width = Math.round(progress * 100) + '%'; return; } }
        if (e.type === 'stage-start') progress = null;
        renderRun(e.run, true);
        if (e.type === 'stage-end' && e.stage.id === 'read') renderDoc(e.run);
      },
    };
    const t0 = performance.now();
    clockTimer = setInterval(() => { const c = $('#clock'); if (c) c.textContent = ((performance.now() - t0) / 1000).toFixed(1) + ' s'; }, 100);
    try {
      const run = await P.run(file, env);
      if (run.decision.status === 'APPROVED') P.commit(run, state);
      state.runs.unshift(run); save();
      live = null; viewing = run.id;
      renderRun(run, false, true); renderDoc(run);
    } catch (e) {
      console.error(e); toast('The run stopped: ' + e.message);
    } finally {
      clearInterval(clockTimer); busy = false; setBusy(false);
    }
  }
  function setBusy(b) { document.querySelectorAll('.scen button').forEach((x) => (x.disabled = b)); $('#drop').style.pointerEvents = b ? 'none' : ''; }

  function b64ToBuf(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }

  /* ---------------------------------------------------------------- render: intake */
  function renderIntake() {
    const groups = [['happy', 'Happy path'], ['edge', 'Edge cases'], ['more', 'More checks']];
    $('#scenarios').innerHTML = groups.map(([k, t]) => `<li class="grp">${t}</li>` + SAMPLES.filter((s) => s.kind === k).map((s) =>
      `<li><button type="button" data-sample="${esc(s.file)}"><b>${esc(s.title)}</b><small>${esc(s.desc)}</small></button></li>`).join('')).join('');
    $('#scenarios').onclick = (e) => {
      const b = e.target.closest('button[data-sample]'); if (!b) return;
      const s = SAMPLES.find((x) => x.file === b.dataset.sample);
      runFile({ name: s.file, type: 'application/pdf', bytes: b64ToBuf(s.b64) });
    };
    const drop = $('#drop'), inp = $('#fileIn');
    const take = async (f) => {
      if (!f) return;
      if (f.size > 15 * 1024 * 1024) return toast('That file is over 15 MB. Send a smaller PDF.');
      runFile({ name: f.name, type: f.type, bytes: await f.arrayBuffer() });
    };
    inp.onchange = () => { take(inp.files[0]); inp.value = ''; };
    drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } };
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => take(e.dataTransfer.files[0]));
  }

  /* ---------------------------------------------------------------- render: run */
  const ICON = { ok: '✓', info: 'i', warn: '!', fail: '✕' };
  function stageHTML(def, s, i, isLive) {
    const st = s ? s.status : 'pending';
    const open = s && (st === 'running' || st === 'warn' || st === 'fail' || expanded.has(def.id) || (isLive && st !== 'pending'));
    const finds = s && open ? `<ul class="finds">${s.findings.map((f) => `<li class="${f.sev}"><span class="ic" aria-hidden="true">${ICON[f.sev]}</span><span>${esc(f.text)}${f.outcome ? `<span class="tag ${f.outcome}">${LABEL[f.outcome]}</span>` : ''}${f.detail ? `<span class="d">${esc(f.detail)}</span>` : ''}</span></li>`).join('')}</ul>` : '';
    const prog = st === 'running' && def.id === 'read' && progress != null ? `<div class="progress"><i id="ocrbar" style="width:${Math.round(progress * 100)}%"></i></div>` : '';
    const sub = s ? (st === 'running' ? def.blurb : s.summary || def.blurb) : def.blurb;
    const count = s && !open && s.findings.length ? ` · ${s.findings.length} check${s.findings.length > 1 ? 's' : ''}` : '';
    return `<li class="stage ${st}">
      <span class="dot" aria-hidden="true">${st === 'ok' || st === 'info' ? '✓' : st === 'fail' ? '✕' : st === 'warn' ? '!' : i + 1}</span>
      <button class="tog" type="button" data-stage="${def.id}" aria-expanded="${!!open}" ${s ? '' : 'disabled'}><span class="t">${esc(def.name)}</span><span class="s">${esc(sub)}${count}</span></button>
      <span class="ms">${s ? (st === 'running' ? 'running…' : st === 'skipped' ? 'skipped' : s.ms + ' ms') : ''}</span>${finds}${prog}</li>`;
  }

  function renderRun(run, isLive, land) {
    const col = $('#runcol');
    if (!run) {
      col.innerHTML = `<div class="panel empty"><h2>Run an invoice through the process</h2>
        <p>Drop a PDF on the left, or pick a prepared scenario. Each stage below lights up as it runs, and the run ends with a decision: approve, send to a reviewer, hold, or reject. Every decision comes with its reasons.</p></div>
        <div class="panel" style="margin-top:16px"><ol class="stages">${P.STAGES.map((d, i) => stageHTML(d, null, i)).join('')}</ol></div>`;
      return;
    }
    const byId = Object.fromEntries(run.stages.map((s) => [s.id, s]));
    const secs = run.durationMs != null ? (run.durationMs / 1000).toFixed(1) + ' s' : '';
    col.innerHTML = `<div class="runhead"><h2>${esc(run.id)}</h2><span class="file" title="${esc(run.fileName)}">${esc(run.fileName)}</span><span class="clock" id="clock">${secs}</span></div>
      ${run.decision ? decisionHTML(run, land) : ''}
      <div class="panel"><ol class="stages">${P.STAGES.map((d, i) => stageHTML(d, byId[d.id], i, isLive)).join('')}</ol></div>`;
    col.querySelectorAll('.tog[data-stage]').forEach((b) => (b.onclick = () => { const id = b.dataset.stage; expanded.has(id) ? expanded.delete(id) : expanded.add(id); renderRun(run, false); }));
    if (run.decision) wireDecision(run);
  }

  function finalStatus(r) { return r.finalStatus || (r.decision && r.decision.status); }

  function decisionHTML(run, land) {
    const d = run.decision, st = d.status;
    const tabs = [];
    if (d.vendorEmail) tabs.push(['email', 'Email to vendor']);
    if (d.internal && d.internal.length) tabs.push(['internal', 'Internal action']);
    if (d.posting) tabs.push(['posting', 'ERP posting']);
    if (run.match) tabs.push(['match', 'Three-way match']);
    tabs.push(['data', 'Extracted data']);
    const cur = run._tab && tabs.find((t) => t[0] === run._tab) ? run._tab : tabs[0][0];
    const reasons = (d.reasons.length === 1 && d.reasons[0] === d.headline ? [] : d.reasons).map((r) => `<li>${esc(r)}</li>`).join('') + (d.others || []).map((r) => `<li class="minor">${esc(r)}</li>`).join('');
    const canReview = !run.finalStatus && (st === 'REVIEW' || st === 'HOLD');
    const reviewed = run.review ? `<div class="reviewed"><b>${run.review.action}</b> by AP reviewer on ${new Date(run.review.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}${run.review.note ? ` — “${esc(run.review.note)}”` : ''}${run.decision.posting ? ` · posted ${esc(run.decision.posting.document)} for ${money(run.decision.posting.payable)}` : ''}</div>` : '';
    return `<section class="panel decision" aria-live="polite">
      <div class="row">
        <div class="stamp ${st}${land ? ' land' : ''}" role="img" aria-label="${LABEL[st]}">${STAMP[st][0]}<small>${STAMP[st][1]}</small></div>
        <div><h3>${esc(d.headline)}</h3>
          <div class="meta">${st === 'APPROVED' ? 'Posted automatically' : st === 'REJECTED' ? 'Closed, nothing posted' : `Routed to <b>${esc(d.queue)}</b>`} · ${run.invoice && run.invoice.total != null ? money(run.invoice.total) + ' · ' : ''}${(run.durationMs / 1000).toFixed(1)} s · read by ${esc(run.engine || '—')}</div>
          ${d.partial ? `<div class="meta">Payable now <b>${money(d.partial.payable)}</b> · held back <b>${money(d.partial.held)}</b></div>` : ''}
        </div>
      </div>
      ${reasons ? `<ul class="reasons">${reasons}</ul>` : ''}
      <div class="tabs" role="tablist">${tabs.map(([k, t]) => `<button role="tab" type="button" data-tab="${k}" aria-selected="${k === cur}">${t}</button>`).join('')}</div>
      <div class="tabpane">${tabPane(run, cur)}</div>
      ${reviewed}
      ${canReview ? `<div class="review">
        <input id="revNote" placeholder="${st === 'HOLD' ? 'Note (required to override a hold)' : 'Reviewer note (optional)'}" aria-label="Reviewer note">
        ${d.partial ? `<button class="btn ok" type="button" data-act="partial">Approve payable portion · ${money(d.partial.payable)}</button>` : ''}
        <button class="btn ${d.partial ? 'ghost' : 'ok'}" type="button" data-act="approve">${st === 'HOLD' ? 'Override hold and post' : run.poSource === 'inferred' ? `Confirm PO ${esc(run.po)} and post` : 'Approve and post'}</button>
        <button class="btn bad" type="button" data-act="reject">Reject</button></div>` : ''}
    </section>`;
  }

  function tabPane(run, k) {
    const d = run.decision, inv = run.invoice || {};
    if (k === 'email') { const m = d.vendorEmail; return `<div class="letter"><span class="subj">To: ${esc(m.to)}<br>Subject: ${esc(m.subject)}</span>${esc(m.body)}</div><div style="margin-top:8px"><button class="btn ghost small" type="button" data-copy="email">Copy email</button> <span class="faint" style="font-size:12.5px">Drafted from the findings, never sent automatically.</span></div>`; }
    if (k === 'internal') return `<ul class="reasons" style="margin-top:0">${d.internal.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    if (k === 'posting') { const p = d.posting; return `<dl class="kv"><dt>Document</dt><dd>${esc(p.document)}</dd><dt>Vendor</dt><dd>${esc(p.vendor)} · ${esc(p.vendorName)}</dd><dt>PO</dt><dd>${esc(p.po)}</dd><dt>Payable</dt><dd><b>${money(p.payable)}</b></dd><dt>Due date</dt><dd>${U.fmtDate(p.dueDate)}</dd><dt>Payment run</dt><dd>${U.fmtDate(p.paymentRun)}</dd><dt>Pay to</dt><dd>${esc(p.payTo)}</dd></dl>
      <table class="tbl" style="margin-top:10px"><thead><tr><th>GL account</th><th>Description</th><th class="num">Amount</th></tr></thead><tbody>${p.expense.map((l) => `<tr><td>${esc(l.gl)}</td><td>PO line ${l.poLine} · ${esc(l.desc)} × ${U.num(l.qty)}</td><td class="num">${money(l.amount)}</td></tr>`).join('')}${p.tax.map((t) => `<tr><td>${esc(t.gl)}</td><td>${t.type} @ ${t.rate}%</td><td class="num">${money(t.amount)}</td></tr>`).join('')}</tbody></table>`; }
    if (k === 'match') return matchTable(run);
    return `<pre class="json">${esc(JSON.stringify(inv, null, 2))}</pre>`;
  }

  function matchTable(run) {
    const m = run.match; if (!m) return '<p class="muted">No PO matched.</p>';
    return `<p class="muted" style="margin:0 0 8px;font-size:13px">PO ${esc(m.po)} · ${m.source === 'inferred' ? 'inferred from line items (not quoted on invoice)' : 'quoted on invoice'}</p>
      <div style="overflow-x:auto"><table class="tbl"><thead><tr><th>PO line</th><th class="num">Billed now</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Billed before</th><th class="num">Payable</th><th class="num">Price vs PO</th></tr></thead><tbody>
      ${m.rows.map((r) => r.poLine ? `<tr><td>${r.poLine} · ${esc(r.poDesc)}</td><td class="num">${U.num(r.qty)}</td><td class="num">${U.num(r.poQty)}</td><td class="num">${U.num(r.received)}</td><td class="num">${U.num(r.billedBefore)}</td><td class="num ${r.payableQty < r.qty ? 'bad' : 'good'}">${U.num(r.payableQty)}</td><td class="num ${Math.abs(r.variancePct) > state.ref.policy.linePriceTolerancePct ? 'bad' : ''}">${r.variancePct > 0 ? '+' : ''}${r.variancePct.toFixed(1)}%</td></tr>` : `<tr><td colspan="7" class="bad">Not on PO: ${esc(r.desc)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function wireDecision(run) {
    const col = $('#runcol');
    col.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { run._tab = b.dataset.tab; renderRun(run, false); }));
    const cp = col.querySelector('[data-copy="email"]');
    if (cp) cp.onclick = async () => { const m = run.decision.vendorEmail; try { await navigator.clipboard.writeText(`Subject: ${m.subject}\n\n${m.body}`); toast('Email copied'); } catch (_) { toast('Copy was blocked — select the text instead'); } };
    col.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => {
      const note = ($('#revNote') || {}).value || '';
      const act = b.dataset.act;
      if (act !== 'reject' && run.decision.status === 'HOLD' && act === 'approve' && !note.trim()) { $('#revNote').focus(); return toast('Add a note to override a hold'); }
      if (act === 'reject') { run.finalStatus = 'REJECTED'; run.review = { action: 'Rejected', note, at: new Date().toISOString() }; }
      else {
        P.commit(run, state, { partial: act === 'partial' });
        run.finalStatus = 'APPROVED';
        run.review = { action: act === 'partial' ? 'Approved payable portion' : run.decision.status === 'HOLD' ? 'Hold overridden and posted' : 'Approved and posted', note, at: new Date().toISOString() };
        run._tab = 'posting';
      }
      save(); renderRun(run, false); toast(run.review.action);
    }));
  }

  /* ---------------------------------------------------------------- render: document column */
  function renderDoc(run) {
    const col = $('#doccol');
    if (!run) { col.innerHTML = `<div class="panel pad"><p class="sect-h">Document</p><p class="muted" style="margin:0;font-size:14px">The invoice page and the fields read from it will appear here.</p></div>`; return; }
    const inv = run.invoice;
    const v = state.ref.vendors.find((x) => x.id === run.vendorId);
    const rows = inv ? [
      ['Vendor', `${esc(inv.vendorName || '—')}${v ? ` <span class="faint">(${v.id})</span>` : ''}`], ['Vendor GSTIN', esc(inv.vendorGstin || '—')],
      ['Invoice no.', esc(inv.invoiceNo || '—')], ['Invoice date', U.fmtDate(inv.invoiceDate)], ['PO quoted', esc(inv.poNumber || 'none')],
      ['Subtotal', money(inv.subtotal)], ...inv.taxes.map((t) => [`${t.type}${t.rate ? ' @ ' + t.rate + '%' : ''}`, money(t.amount)]), ['Total', `<b>${money(inv.total)}</b>`],
      ['Bank on invoice', inv.bank && inv.bank.account ? `${esc(inv.bank.name || '')} ${esc(inv.bank.account)}<br><span class="faint">${esc(inv.bank.ifsc || '')}</span>` : '—'],
    ] : [];
    col.innerHTML = `${run.preview ? `<div class="panel pad"><p class="sect-h">Document · ${run.readMode === 'scan' ? 'scanned image' : 'text PDF'}${run.pages > 1 ? ` · ${run.pages} pages` : ''}</p><a class="page" href="${run.preview}" target="_blank" rel="noopener"><img src="${run.preview}" alt="First page of ${esc(run.fileName)}"></a></div>` : ''}
      ${inv ? `<div class="panel pad"><p class="sect-h">Fields read · ${esc(run.engine || '')}</p><table class="fields">${rows.map(([k, val]) => `<tr><th>${k}</th><td>${val}</td></tr>`).join('')}</table>
        ${inv.lines.length ? `<table class="tbl" style="margin-top:12px"><thead><tr><th>Line item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>${inv.lines.map((l) => `<tr><td>${esc(l.desc)}</td><td class="num">${U.num(l.qty)}</td><td class="num">${U.num(l.rate)}</td><td class="num">${U.num(l.amount)}</td></tr>`).join('')}</tbody></table>` : ''}</div>` : ''}`;
  }

  /* ---------------------------------------------------------------- dashboard */
  let filter = 'all';
  function renderRuns() {
    const runs = state.runs, el = $('#view-runs');
    const n = runs.length;
    const fs = runs.map(finalStatus);
    const count = (s) => fs.filter((x) => x === s).length;
    const auto = runs.filter((r) => r.decision.status === 'APPROVED').length;
    const approvedVal = runs.filter((r) => finalStatus(r) === 'APPROVED' && r.decision.posting).reduce((s, r) => s + r.decision.posting.payable, 0);
    const stopped = runs.filter((r) => ['HOLD', 'REJECTED'].includes(finalStatus(r))).reduce((s, r) => s + ((r.invoice && r.invoice.total) || 0), 0);
    const waiting = runs.filter((r) => !r.finalStatus && ['REVIEW', 'HOLD'].includes(r.decision.status)).length;
    const times = runs.map((r) => r.durationMs).sort((a, b) => a - b); const med = n ? times[Math.floor(n / 2)] : 0;
    const mix = ['APPROVED', 'REVIEW', 'HOLD', 'REJECTED'].map((s) => [s, count(s)]);
    const color = { APPROVED: 'var(--ok)', REVIEW: 'var(--review)', HOLD: 'var(--hold)', REJECTED: 'var(--reject)' };
    const shown = runs.filter((r) => filter === 'all' || (filter === 'waiting' ? !r.finalStatus && ['REVIEW', 'HOLD'].includes(r.decision.status) : finalStatus(r) === filter));
    el.innerHTML = `
      <div class="kpis">
        <div class="panel kpi"><div class="v">${n}</div><div class="l">Invoices processed</div></div>
        <div class="panel kpi"><div class="v">${n ? Math.round((auto / n) * 100) : 0}%</div><div class="l">Approved with no human touch</div></div>
        <div class="panel kpi"><div class="v">${waiting}</div><div class="l">Waiting for a person</div></div>
        <div class="panel kpi"><div class="v">${money(approvedVal).replace(/\.00$/, '')}</div><div class="l">Posted for payment</div></div>
        <div class="panel kpi"><div class="v">${money(stopped).replace(/\.00$/, '')}</div><div class="l">Held or rejected</div></div>
        <div class="panel kpi"><div class="v">${n ? (med / 1000).toFixed(1) + ' s' : '—'}</div><div class="l">Median time per invoice</div></div>
      </div>
      <div class="panel pad" style="margin-bottom:16px">
        <p class="sect-h">Outcomes across all runs</p>
        <div class="mix" role="img" aria-label="${mix.map(([s, c]) => `${LABEL[s]} ${c}`).join(', ')}">${n ? mix.filter(([, c]) => c).map(([s, c]) => `<i style="flex:${c};background:${color[s]}" title="${LABEL[s]}: ${c}"></i>`).join('') : ''}</div>
        <div class="legend">${mix.map(([s, c]) => `<span style="--c:${color[s]}">${LABEL[s]} · ${c}</span>`).join('')}</div>
      </div>
      <div class="panel pad">
        <div class="toolbar"><h2>Run history</h2>
          <div class="chips" role="group" aria-label="Filter runs">${[['all', 'All'], ['waiting', 'Waiting for a person'], ['APPROVED', 'Approved'], ['REVIEW', 'Needs review'], ['HOLD', 'On hold'], ['REJECTED', 'Rejected']].map(([k, t]) => `<button type="button" data-f="${k}" aria-pressed="${filter === k}">${t}</button>`).join('')}</div>
          <button class="btn ghost small" type="button" id="dl">Download runs (JSON)</button>
        </div>
        ${n ? `<div style="overflow-x:auto"><table class="tbl runs"><thead><tr><th>Run</th><th>Received</th><th>Vendor</th><th>Invoice</th><th class="num">Amount</th><th>Read by</th><th>Process decision</th><th>Now</th><th class="num">Time</th></tr></thead><tbody>
        ${shown.map((r) => { const v = state.ref.vendors.find((x) => x.id === r.vendorId); const inv = r.invoice || {}; return `<tr data-run="${r.id}" tabindex="0"><td><b>${r.id}</b></td><td>${new Date(r.startedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(v ? v.name : inv.vendorName || '—')}</td><td>${esc(inv.invoiceNo || '—')}</td><td class="num">${money(inv.total)}</td><td>${esc(r.engine || '—')}</td><td><span class="pill ${r.decision.status}">${LABEL[r.decision.status]}</span></td><td>${r.finalStatus ? `<span class="pill ${r.finalStatus}">${LABEL[r.finalStatus]}</span> <span class="faint" style="font-size:12px">by reviewer</span>` : ['REVIEW', 'HOLD'].includes(r.decision.status) ? '<span class="faint">waiting</span>' : '<span class="faint">final</span>'}</td><td class="num">${(r.durationMs / 1000).toFixed(1)} s</td></tr>`; }).join('') || `<tr><td colspan="9" class="muted">No runs match this filter.</td></tr>`}
        </tbody></table></div>` : `<p class="muted" style="margin:0">No runs yet. Go to <a href="#process">Process an invoice</a> and run a scenario — every run is recorded here.</p>`}
      </div>`;
    el.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { filter = b.dataset.f; renderRuns(); }));
    el.querySelectorAll('tr[data-run]').forEach((tr) => { const open = () => openRun(tr.dataset.run); tr.onclick = open; tr.onkeydown = (e) => { if (e.key === 'Enter') open(); }; });
    $('#dl').onclick = () => { const blob = new Blob([JSON.stringify(state.runs.map((r) => ({ ...r, preview: undefined })), null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'invoice-desk-runs.json'; a.click(); };
  }
  function openRun(id) { const r = state.runs.find((x) => x.id === id); if (!r) return; viewing = id; expanded.clear(); go('process'); renderRun(r, false); renderDoc(r); }

  /* ---------------------------------------------------------------- reference data */
  let resetArmed = false;
  function renderReference() {
    const ref = state.ref, el = $('#view-reference');
    const pol = ref.policy;
    const vendorRows = ref.vendors.map((v) => `<tr><td><b>${v.id}</b></td><td>${esc(v.name)}<br><span class="faint">${esc(v.category)} · ${esc(v.stateName)}</span></td><td class="mono">${v.gstin}</td><td>${esc(v.bank.name)}<br><span class="mono faint">${v.bank.account} · ${v.bank.ifsc}</span></td><td>Net ${v.paymentTermsDays}</td><td>${esc(v.contact.name)}<br><span class="faint">${esc(v.contact.phone)}</span></td></tr>`).join('');
    const poRows = ref.pos.map((p) => { const v = ref.vendors.find((x) => x.id === p.vendorId); return p.lines.map((l, i) => { const rec = P.receivedQty(state, p.po, l.line), bil = P.billedQty(state, p.po, l.line); return `<tr>${i === 0 ? `<td rowspan="${p.lines.length}"><b>${p.po}</b><br><span class="faint">${esc(v.name)}</span><br><span class="faint">${esc(p.title)}</span></td>` : ''}<td>${l.line} · ${esc(l.desc)}</td><td class="num">${U.num(l.qty)} ${esc(l.uom)}</td><td class="num">${money(l.price)}</td><td class="num">${U.num(rec)}</td><td class="num ${bil > rec ? 'bad' : ''}">${U.num(bil)}</td><td class="num">${U.num(Math.max(0, Math.min(l.qty, rec) - bil))}</td></tr>`; }).join(''); }).join('');
    const led = state.ledger.slice().reverse().map((e) => { const v = ref.vendors.find((x) => x.id === e.vendorId); return `<tr><td><b>${e.id}</b>${e.runId ? `<br><span class="faint">${e.runId}</span>` : ''}</td><td>${esc(v ? v.name : e.vendorId)}</td><td>${esc(e.invoiceNo)}</td><td>${U.fmtDate(e.invoiceDate)}</td><td>${esc(e.po || '—')}</td><td class="num">${money(e.total)}</td><td>${esc(e.status)}${e.partial ? ' (partial)' : ''}</td></tr>`; }).join('');
    el.innerHTML = `<div class="stack">
      <div class="two">
        <div class="panel pad"><p class="sect-h">Policy the rules apply</p>
          <form class="polform" id="polForm">
            <label for="p1">Unit-price tolerance vs PO (±%)</label><input id="p1" name="linePriceTolerancePct" type="number" step="0.5" min="0" value="${pol.linePriceTolerancePct}">
            <label for="p2">Auto-approval limit (₹)</label><input id="p2" name="autoApproveLimit" type="number" step="10000" min="0" value="${pol.autoApproveLimit}">
            <label for="p3">Max invoice age (days)</label><input id="p3" name="maxInvoiceAgeDays" type="number" min="1" value="${pol.maxInvoiceAgeDays}">
            <label for="p4">Possible-duplicate window (days)</label><input id="p4" name="possibleDuplicateWindowDays" type="number" min="0" value="${pol.possibleDuplicateWindowDays}">
            <label for="p5">Min. score to infer a PO (0–1)</label><input id="p5" name="poInferenceMinScore" type="number" step="0.05" min="0" max="1" value="${pol.poInferenceMinScore}">
            <span></span><button class="btn small" type="submit">Save policy</button>
          </form>
          <p class="faint" style="font-size:12.5px;margin:10px 0 0">Change a threshold and re-run a scenario to see the decision move.</p>
        </div>
        <div class="panel pad"><p class="sect-h">Demo data</p>
          <p style="margin:0 0 6px;font-size:14px">Buyer: <b>${esc(ref.company.name)}</b> · GSTIN <span class="mono">${ref.company.gstin}</span> · ${esc(ref.company.stateName)} (${ref.company.state})</p>
          <p class="muted" style="margin:0 0 12px;font-size:14px">Approved invoices are written into the AP ledger below, so later invoices on the same PO see them. Reset to start a demo from a clean slate.</p>
          <button class="btn ${resetArmed ? 'bad' : 'ghost'}" type="button" id="reset">${resetArmed ? 'Click again to erase all runs and ledger postings' : 'Reset demo data'}</button>
        </div>
      </div>
      <div class="panel pad"><p class="sect-h">Vendor master</p><div style="overflow-x:auto"><table class="tbl"><thead><tr><th>ID</th><th>Vendor</th><th>GSTIN</th><th>Bank on file</th><th>Terms</th><th>Registered contact</th></tr></thead><tbody>${vendorRows}</tbody></table></div></div>
      <div class="panel pad"><p class="sect-h">Purchase orders, receipts and billing (live)</p><div style="overflow-x:auto"><table class="tbl"><thead><tr><th>PO</th><th>Line</th><th class="num">Ordered</th><th class="num">PO price</th><th class="num">Received</th><th class="num">Invoiced</th><th class="num">Billable now</th></tr></thead><tbody>${poRows}</tbody></table></div></div>
      <div class="panel pad"><p class="sect-h">AP ledger</p><div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Document</th><th>Vendor</th><th>Invoice</th><th>Date</th><th>PO</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>${led}</tbody></table></div></div>
    </div>`;
    $('#polForm').onsubmit = (e) => { e.preventDefault(); new FormData(e.target).forEach((v, k) => (state.ref.policy[k] = +v)); save(); toast('Policy saved'); };
    $('#reset').onclick = () => {
      if (!resetArmed) { resetArmed = true; renderReference(); setTimeout(() => { if (resetArmed) { resetArmed = false; if (route() === 'reference') renderReference(); } }, 4000); return; }
      resetArmed = false; state = fresh(); save(); viewing = null; renderReference(); renderRun(null); renderDoc(null); toast('Demo data reset');
    };
  }

  /* ---------------------------------------------------------------- how it works */
  function renderHow() {
    $('#view-how').innerHTML = `<div class="panel pad prose" style="max-width:none">
      <h2>From PDF to payment decision, with the reasoning visible</h2>
      <p>An AP clerk opens each invoice, finds the purchase order, checks the numbers and decides what to do. This process does the same job in eight stages. AI is used for one thing only: <b>reading</b> a messy document into fields. Every check and every decision is a fixed rule you can read, test and audit, so a model can never approve a payment.</p>
      <div class="flow">${P.STAGES.map((s, i) => `<div class="${s.id === 'extract' || s.id === 'read' ? 'ai' : s.id === 'decide' ? 'dec' : ''}"><span>${i + 1} · ${s.id === 'extract' || s.id === 'read' ? 'AI or OCR + parser' : s.id === 'decide' ? 'policy' : 'rules'}</span><b>${s.name}</b>${s.blurb}</div>`).join('')}</div>
      <div class="two" style="margin-top:8px">
      <div>
      <h3>Four outcomes, each with a next action</h3>
      <ul><li><b>Approved</b> — every check passed: posted to the ledger with GL and input-tax lines, due date from vendor terms, scheduled into the Friday payment run. Pay-to account always comes from the vendor master.</li>
      <li><b>Needs review</b> — a judgement call (inferred PO, price over tolerance, wrong GST head, missing field). The reviewer sees the exact question and approves or rejects in one click.</li>
      <li><b>On hold</b> — paying now could lose money (billing beyond receipts or PO, changed bank details, invalid GSTIN). Overriding needs a written note.</li>
      <li><b>Rejected</b> — must not be paid (duplicate, unknown vendor). A vendor email explaining why is drafted.</li></ul>
      <h3>Why the AI is boxed in</h3>
      <ul><li><b>Grounding:</b> every identifier and amount the model returns must appear in the document text, or the run goes to review.</li>
      <li><b>Two independent reads:</b> the rule-based parser reads every text PDF too; if the totals disagree, the read whose numbers reconcile wins, and a split goes to a person.</li>
      <li><b>Arithmetic as a lie detector:</b> qty × rate → lines → subtotal → tax → total must reconcile. On scans this repairs OCR misreads: if ₹1,94,000 comes out as 14,94,000, qty × rate matching the subtotal corrects it, and the correction is shown.</li>
      <li><b>Graceful degradation:</b> no API key, network error or rate limit → the rule-based parser runs and the stage says so. The process never stops because a model is unavailable.</li></ul>
      </div>
      <div>
      <h3>The edge cases, and why they are the right ones</h3>
      <div class="case"><b>Split PO, second invoice over-bills.</b> Matching one invoice to one PO is easy. The money is lost on the second and third invoices against the same PO. The ledger tracks what was already billed per PO line, so the process can say exactly: 2,500 payable now, 1,500 not yet received, 1,000 beyond the PO → credit note.</div>
      <div class="case"><b>Scanned invoice with no PO.</b> OCR, OCR repair, then PO inference by line-item similarity and price across the vendor's open POs. A confident match is still never auto-approved: inferring is not the same as the vendor quoting it.</div>
      <div class="case"><b>Duplicate with a re-typed number.</b> “CN-2026-412” vs “CN/2026/0412” — exact-match duplicate checks miss this, and it is how most duplicate payments happen. Numbers are compared on a canonical key; same amount within 15 days under a different number is flagged too.</div>
      <div class="case"><b>Bank details changed on the invoice.</b> Everything matches, so a naive process would pay — to a fraudster. The process holds it, never emails the (possibly compromised) sender, and tells AP to call the contact on file, not the number on the invoice.</div>
      <h3>Assumptions</h3>
      <ul><li>Indian GST invoices in INR, for one buyer entity (Northwind Retail, Karnataka). PO, receipt and vendor data are mock ERP extracts; the AP ledger is updated by this process.</li>
      <li>Payment runs are weekly on Fridays; due date = invoice date + vendor terms.</li>
      <li>Invoices arrive as files (in production: an email inbox or SFTP drop feeds the same entry point).</li>
      <li>Runs and ledger are stored in this browser so the demo needs no server; “Reset demo data” restores the starting position.</li></ul>
      <h3>What I would build next</h3>
      <ul><li>Mailbox ingestion and ERP connectors (SAP/Tally) instead of mock data; a reviewer queue with assignment and SLAs.</li>
      <li>Release held quantities automatically when the goods receipt posts; per-vendor tolerance overrides.</li>
      <li>Learning from reviewer decisions: track which findings reviewers routinely override, and tune those thresholds.</li></ul>
      </div></div>
    </div>`;
  }

  /* ---------------------------------------------------------------- settings dialog */
  function openSettings() {
    const d = $('#settings');
    d.querySelectorAll('input[name=engine]').forEach((r) => (r.checked = r.value === settings.engine));
    $('#apiKey').value = settings.apiKey; $('#model').value = settings.model; $('#pace').checked = settings.pace;
    d.showModal();
  }
  $('#engineBtn').onclick = openSettings;
  $('#setForm').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'save') {
      const eng = ($('#settings input[name=engine]:checked') || {}).value || 'rules';
      if (eng === 'anthropic' && !$('#apiKey').value.trim()) { e.preventDefault(); $('#apiKey').focus(); return toast('Paste an API key, or pick the rule-based parser'); }
      settings = { engine: eng, apiKey: $('#apiKey').value.trim(), model: $('#model').value, pace: $('#pace').checked };
      store.set(SET_KEY, settings); paintEngine(); toast('Saved');
    }
  });
  $('#apiKey').addEventListener('focus', () => { const r = $('#settings input[value=anthropic]'); r.checked = true; });

  /* ---------------------------------------------------------------- routing */
  const VIEWS = ['process', 'runs', 'reference', 'how'];
  const route = () => { const h = location.hash.replace('#', ''); return VIEWS.includes(h) ? h : 'process'; };
  function go(v) { if (route() !== v) location.hash = v; else show(); }
  function show() {
    const v = route();
    VIEWS.forEach((x) => $('#view-' + x).classList.toggle('on', x === v));
    document.querySelectorAll('.nav a').forEach((a) => a.setAttribute('aria-current', a.dataset.view === v ? 'page' : 'false'));
    if (v === 'runs') renderRuns();
    if (v === 'reference') renderReference();
    if (v === 'how') renderHow();
  }
  window.addEventListener('hashchange', show);

  let toastT;
  function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }

  /* ---------------------------------------------------------------- boot */
  try {
    renderIntake(); paintEngine();
    const last = state.runs[0];
    if (last) { viewing = last.id; renderRun(last, false); renderDoc(last); } else { renderRun(null); renderDoc(null); }
  } catch (e) {
    // a corrupted saved state should never brick the demo: start clean
    console.error(e); state = fresh(); save(); renderIntake(); renderRun(null); renderDoc(null);
  }
  show();
  window.__invoiceDesk = { get state() { return state; }, runFile };
})();
