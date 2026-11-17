/* Shared helpers: money, dates, identifiers, fuzzy matching. No DOM access — also runs in Node for tests. */
(function (g) {
  const U = {};

  // ---------- money
  U.parseAmount = function (s) {
    if (s == null) return null;
    if (typeof s === 'number') return s;
    const t = String(s).replace(/(Rs\.?|INR|₹)/gi, '').replace(/[(),\s]/g, '').replace(/[^0-9.\-]/g, '');
    if (!t || !/\d/.test(t)) return null;
    const v = parseFloat(t);
    return isFinite(v) ? v : null;
  };
  const inrFmt = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  U.money = (n) => (n == null || isNaN(n) ? '—' : '₹' + inrFmt.format(n));
  U.num = (n) => (n == null || isNaN(n) ? '—' : new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(n));
  U.round2 = (n) => Math.round(n * 100) / 100;
  U.close = (a, b, tol = 1) => a != null && b != null && Math.abs(a - b) <= tol;

  // ---------- dates
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  const iso = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
    return dt.toISOString().slice(0, 10);
  };
  const yr = (y) => { y = +y; return y < 100 ? 2000 + y : y; };
  U.DATE_RE = /(\d{4}-\d{1,2}-\d{1,2})|(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})|(\d{1,2}[\s\-\/]*[A-Za-z]{3,9}[\s\-\/,]*\d{2,4})|([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/;
  U.parseDate = function (s) {
    if (!s) return null;
    s = String(s).trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(+m[1], m[2] - 1, +m[3]);
    // Indian convention: DD/MM/YYYY
    if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/))) return iso(yr(m[3]), m[2] - 1, +m[1]);
    if ((m = s.match(/^(\d{1,2})[\s\-\/]*([A-Za-z]{3,9})[\s\-\/,]*(\d{2,4})/))) {
      const mo = MON[m[2].toLowerCase().slice(0, m[2].toLowerCase().startsWith('sept') ? 4 : 3)];
      if (mo != null) return iso(yr(m[3]), mo, +m[1]);
    }
    if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/))) {
      const mo = MON[m[1].toLowerCase().slice(0, 3)];
      if (mo != null) return iso(+m[3], mo, +m[2]);
    }
    return null;
  };
  U.addDays = (isoDate, n) => { const d = new Date(isoDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  U.daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
  U.today = () => { const d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10); };
  U.fmtDate = (isoDate) => {
    if (!isoDate) return '—';
    const d = new Date(isoDate + 'T00:00:00Z');
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  };
  // Payment runs happen on Fridays: pick the last Friday on or before the due date (never before today).
  U.paymentRun = (due) => {
    const d = new Date(due + 'T00:00:00Z');
    while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
    let r = d.toISOString().slice(0, 10);
    const t = U.today();
    if (r < t) { const n = new Date(t + 'T00:00:00Z'); while (n.getUTCDay() !== 5) n.setUTCDate(n.getUTCDate() + 1); r = n.toISOString().slice(0, 10); }
    return r;
  };

  // ---------- identifiers
  // Invoice numbers are re-typed by vendors all the time: CN/2026/0412 vs CN-2026-412. Compare a canonical form.
  U.normInvoiceNo = (s) => (s || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
    .map((p) => (/^\d+$/.test(p) ? String(parseInt(p, 10)) : p)).join('');

  const GST_CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  U.GSTIN_RE = /\b[0-9OIlS]{2}[A-Z0-9]{5}[0-9OIlSB]{4}[A-Z0-9][A-Z0-9][Z2][A-Z0-9]\b/g;
  U.gstinChecksum = (g14) => {
    let s = 0;
    for (let i = 0; i < 14; i++) {
      const v = GST_CH.indexOf(g14[i]); if (v < 0) return null;
      const p = v * (i % 2 === 0 ? 1 : 2); s += Math.floor(p / 36) + (p % 36);
    }
    return GST_CH[(36 - (s % 36)) % 36];
  };
  U.gstinValid = (g) => !!g && /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) && U.gstinChecksum(g.slice(0, 14)) === g[14];
  // OCR repair: fix letter/digit confusions using the fixed GSTIN pattern, keep only if checksum then passes.
  U.repairGstin = (raw) => {
    if (!raw) return { value: raw, repaired: false };
    let g = raw.toUpperCase().replace(/\s/g, '');
    if (U.gstinValid(g)) return { value: g, repaired: false };
    const toD = { O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' }, toA = { 0: 'O', 1: 'I', 5: 'S', 8: 'B', 2: 'Z', 6: 'G' };
    const c = g.split('');
    [0, 1, 7, 8, 9, 10].forEach((i) => { if (toD[c[i]]) c[i] = toD[c[i]]; });
    [2, 3, 4, 5, 6, 11].forEach((i) => { if (toA[c[i]]) c[i] = toA[c[i]]; });
    if (c[13] === '2') c[13] = 'Z';
    const f = c.join('');
    return U.gstinValid(f) ? { value: f, repaired: f !== g } : { value: g, repaired: false };
  };
  U.repairIfsc = (raw) => {
    if (!raw) return { value: raw, repaired: false };
    let s = raw.toUpperCase();
    const fixed = s.slice(0, 4).replace(/0/g, 'O').replace(/1/g, 'I') + '0' + s.slice(5);
    return { value: fixed, repaired: fixed !== s };
  };
  U.stateOf = (gstin) => (gstin && /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : null);

  // ---------- fuzzy text
  U.normText = (s) => (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const STOP = new Set(['pvt', 'ltd', 'private', 'limited', 'llp', 'the', 'and', 'of', 'inc', 'co', 'for', 'to', 'a', 'in']);
  U.tokens = (s) => U.normText(s).split(' ').filter((t) => t && !STOP.has(t));
  const bigrams = (s) => { const t = U.normText(s).replace(/ /g, ''); const out = []; for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2)); return out; };
  U.similarity = (a, b) => {
    const ta = new Set(U.tokens(a)), tb = new Set(U.tokens(b));
    if (!ta.size || !tb.size) return 0;
    let inter = 0; ta.forEach((t) => { if (tb.has(t)) inter++; });
    const jac = inter / (ta.size + tb.size - inter);
    const ba = bigrams(a), bb = bigrams(b); const m = new Map();
    bb.forEach((x) => m.set(x, (m.get(x) || 0) + 1));
    let hit = 0; ba.forEach((x) => { if (m.get(x)) { hit++; m.set(x, m.get(x) - 1); } });
    const dice = (2 * hit) / (ba.length + bb.length || 1);
    return Math.max(jac, 0.4 * jac + 0.6 * dice);
  };

  // ---------- hashing
  U.sha256 = async (buf) => {
    const h = await g.crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  U.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  U.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  g.U = U;
})(typeof window !== 'undefined' ? window : globalThis);
