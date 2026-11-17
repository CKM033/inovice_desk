import fs from 'fs'; import { execSync } from 'child_process';
const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.js')).default;
for (const f of ['util','extract','pipeline']) await import(new URL(`../js/${f}.js`, import.meta.url));
const seed = JSON.parse(fs.readFileSync(new URL('../data/seed.json', import.meta.url)));
const state = { ref: structuredClone(seed), ledger: structuredClone(seed.invoiceHistory), runs: [], counters: { run: 0, ap: 1000 } };
const dir = new URL('../samples/', import.meta.url).pathname;
const env = { state, newRunId: () => 'RUN-' + String(++state.counters.run).padStart(4,'0'), pace: 0,
  readDocument: async (file) => { const doc = await pdfjs.getDocument({ data: new Uint8Array(file.bytes.slice(0)) }).promise; let lines=[];
    for (let p=1;p<=doc.numPages;p++){ lines = lines.concat(X.linesFromItems((await (await doc.getPage(p)).getTextContent()).items,p)); }
    return { pages: doc.numPages, lines, text: lines.map(l=>l.text).join('\n'), images: [file.path] }; },
  ocr: async (imgs) => { execSync(`pdftoppm -r 170 -png -singlefile ${imgs[0]} /tmp/ocr`); return { text: execSync('tesseract /tmp/ocr.png - 2>/dev/null').toString(), confidence: 88 }; } };
const order = process.argv[2] ? process.argv[2].split(',') : fs.readdirSync(dir).sort();
for (const name of order) {
  const buf = fs.readFileSync(dir + name);
  const run = await P.run({ name, path: dir+name, bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, env);
  state.runs.unshift(run);
  if (run.decision.status === 'APPROVED') P.commit(run, state);
  console.log(`\n### ${name} → ${run.decision.status} | ${run.decision.headline}  [${run.durationMs}ms, ${run.engine}]`);
  for (const s of run.stages) { console.log(`  [${s.status}] ${s.name}: ${s.summary}`); for (const x of s.findings) if (x.sev!=='ok') console.log(`      ${x.sev}${x.outcome?'→'+x.outcome:''}: ${x.text}${x.detail?' | '+x.detail:''}`); }
  if (run.decision.vendorEmail) console.log('  EMAIL:', run.decision.vendorEmail.subject, '\n   ', run.decision.vendorEmail.body.split('\n').slice(2,-6).join('\n    '));
  if (run.decision.internal.length) console.log('  INTERNAL:', run.decision.internal);
  if (run.decision.posting) console.log('  POSTING:', run.decision.posting.document, run.decision.posting.payable, run.decision.posting.paymentRun);
  if (run.decision.partial) console.log('  PARTIAL:', run.decision.partial);
}
