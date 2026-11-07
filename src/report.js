// HTML + JSON report. report.json is what gets hashed on-chain at delivery, so it is written
// first and the HTML is derived from it.
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256hex } from './near.js';
import { fmtNear, txUrl, accountUrl } from './config.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Writes report.json and returns its sha256. Call before delivery; add `onchain` later with writeHtml. */
export function writeReportJson(outDir, run) {
  const path = join(outDir, 'report.json');
  writeFileSync(path, JSON.stringify(run, null, 2));
  return sha256hex(readFileSync(path));
}

export function writeHtml(outDir, run, onchain = {}) {
  const total = run.receipts.reduce((a, r) => a + BigInt(r.amount), 0n);
  const rows = run.results.map((r) => `
  <section class="task ${r.status}">
    <h2><span class="badge">${r.status.toUpperCase()}</span> ${esc(r.name)}</h2>
    <p class="meta">${esc(r.startUrl)} → ${esc(r.final?.url || '')}</p>
    ${r.error ? `<p class="err">${esc(r.error)}</p>` : ''}
    <ul>${r.checks.map((c) => `<li class="${c.pass ? 'ok' : 'bad'}">${c.pass ? '✓' : '✗'} ${esc(c.type)}: ${esc(c.value)}${c.reason ? ` <em>— ${esc(c.reason)}</em>` : ''}</li>`).join('')}</ul>
    <div class="shots">${r.screenshots.map((s) => `<img src="${esc(r.id)}/${esc(s)}" alt="${esc(s)}">`).join('')}</div>
  </section>`).join('');
  const rec = run.receipts.map((r) => `<tr><td>${esc(r.label)}</td><td><a href="${esc(accountUrl(r.payTo))}">${esc(r.payTo)}</a></td><td>${esc(r.near)} Ⓝ</td><td><code>${esc(r.memo)}</code></td><td><a href="${esc(r.explorer)}">${esc(r.txHash.slice(0, 10))}…</a></td></tr>`).join('');
  const chain = onchain.jobId != null ? `
<h2 style="margin-top:28px;font-size:17px">On-chain job #${esc(onchain.jobId)}</h2>
<table>
<tr><th>Customer</th><td><a href="${esc(accountUrl(onchain.customer))}">${esc(onchain.customer)}</a></td></tr>
<tr><th>Escrow deposit</th><td>${esc(fmtNear(onchain.deposit || 0, 6))} Ⓝ</td></tr>
<tr><th>Task spec hash</th><td><code>${esc(onchain.specHash)}</code></td></tr>
<tr><th>Report hash (sha256 of report.json)</th><td><code>${esc(onchain.reportHash)}</code></td></tr>
${onchain.acceptTx ? `<tr><th>accept_job</th><td><a href="${esc(txUrl(onchain.acceptTx))}">${esc(onchain.acceptTx)}</a></td></tr>` : ''}
${onchain.deliverTx ? `<tr><th>deliver (pays the agent)</th><td><a href="${esc(txUrl(onchain.deliverTx))}">${esc(onchain.deliverTx)}</a></td></tr>` : ''}
</table>` : '';
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ReplayCheck report</title>
<style>
:root{--bg:#121410;--fg:#ECE7D9;--mut:#9a9a8c;--ok:#6FD08C;--bad:#FF6B57;--line:#2a2d26;--acc:#FFC93C}
body{background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;padding:24px 16px;max-width:1080px;margin:auto}
h1{font-size:22px;margin:0 0 4px}.meta{color:var(--mut);font-size:13px;word-break:break-all}
.task{border-top:1px solid var(--line);padding:16px 0}.task h2{font-size:17px;margin:0}
.badge{font-size:12px;padding:2px 8px;border-radius:4px;background:var(--line);margin-right:6px}
.pass .badge{background:var(--ok);color:#06210f}.fail .badge,.error .badge{background:var(--bad);color:#2a0905}
li.ok{color:var(--ok)}li.bad{color:var(--bad)}.err{color:var(--bad)}
.shots{display:flex;gap:8px;flex-wrap:wrap}.shots img{max-width:320px;width:100%;border:1px solid var(--line)}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px;text-align:left;vertical-align:top}a{color:var(--acc)}code{font-size:12px;word-break:break-all}
</style>
<h1>ReplayCheck · ${run.results.filter((r) => r.status === 'pass').length}/${run.results.length} tasks passed</h1>
<p class="meta">Run ${esc(run.runId)} · NEAR ${esc(run.network)} · agent <a href="${esc(accountUrl(run.agent))}">${esc(run.agent)}</a> · market <a href="${esc(accountUrl(run.contract))}">${esc(run.contract)}</a></p>
${rows}
<h2 style="margin-top:28px;font-size:17px">What the agent bought for this run (near402) · total ${esc(fmtNear(total, 6))} Ⓝ</h2>
<table><tr><th>What</th><th>From</th><th>Price</th><th>Memo</th><th>Payment tx</th></tr>${rec}</table>
${chain}`;
  writeFileSync(join(outDir, 'index.html'), html);
  return join(outDir, 'index.html');
}
