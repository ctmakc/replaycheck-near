#!/usr/bin/env node
// replaycheck order <tasks.json> [--agent <account>]   customer: fund a job on the market, send the
//                                                      tasks to the agent, get the report, verify the
//                                                      report hash against the chain
// replaycheck run <tasks.json> [--out dir]             agent-side local run: rents browser minutes
//                                                      from the worker, no escrow job
// replaycheck refund <job_id>                          customer: take the deposit back (open job, or accepted and past its deadline)
// replaycheck verify <job_id> <report.json>            anyone: sha256(report.json) == on-chain hash?
// replaycheck whoami                                   agent account, balance, contract, listing
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTask } from '../src/runner.js';
import { writeReportJson, writeHtml } from '../src/report.js';
import { receipts, spentYocto } from '../src/near402.js';
import { agentAccount, accountFromEnv, balance, getAgent, getJob, postJob, refund, specHash, sha256hex } from '../src/near.js';
import { network, CONTRACT_ID, fmtNear, txUrl } from '../src/config.js';

const [cmd, a1, a2, ...rest] = process.argv.slice(2);
const argv = [a2, ...rest].filter(Boolean);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const out = (o) => console.log(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

if (cmd === 'whoami') {
  const a = agentAccount();
  out({ network: network().slug, contract: CONTRACT_ID(), agent: a.accountId, balanceNear: fmtNear(await balance(a.accountId)), listing: await getAgent(a.accountId) });
} else if (cmd === 'run' && a1) {
  const a = agentAccount();
  const spec = JSON.parse(readFileSync(a1, 'utf8'));
  const tasks = spec.tasks || spec;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = arg('--out') || join('reports', runId);
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const t of tasks) {
    console.error(`[replaycheck] ${t.id}: ${t.name}`);
    const r = await runTask(a, t, outDir);
    console.error(`[replaycheck] ${t.id}: ${r.status}${r.error ? ' — ' + r.error : ''}`);
    results.push(r);
  }
  const run = { runId, network: network().slug, contract: CONTRACT_ID(), agent: a.accountId, specHash: specHash(tasks), results, receipts };
  const reportHash = writeReportJson(outDir, run);
  const html = writeHtml(outDir, run, { reportHash });
  out({ report: html, reportHash, passed: results.filter((r) => r.status === 'pass').length, total: results.length, spentNear: fmtNear(spentYocto(), 6), payments: receipts.map((r) => r.txHash) });
  process.exit(results.every((r) => r.status === 'pass') ? 0 : 1);
} else if (cmd === 'order' && a1) {
  // The customer signs with REPLAYCHECK_CUSTOMER_ID / _KEY (falls back to the demo customer).
  let customer;
  try { customer = accountFromEnv('REPLAYCHECK_CUSTOMER_ID', 'REPLAYCHECK_CUSTOMER_KEY'); }
  catch { customer = accountFromEnv('REPLAYCHECK_DEMO_CUSTOMER_ID', 'REPLAYCHECK_DEMO_CUSTOMER_KEY'); }
  const agentId = arg('--agent') || process.env.REPLAYCHECK_AGENT_ID;
  const spec = JSON.parse(readFileSync(a1, 'utf8'));
  const tasks = spec.tasks || spec;
  const listing = await getAgent(agentId);
  if (!listing) { console.error(`agent ${agentId} is not registered on ${CONTRACT_ID()}`); process.exit(2); }
  const hash = specHash(tasks);
  console.error(`[order] agent ${agentId} charges ${fmtNear(listing.price, 6)} NEAR · spec ${hash}`);
  const posted = await postJob(customer, agentId, hash, BigInt(listing.price));
  console.error(`[order] job #${posted.jobId} funded by ${customer.accountId} · ${txUrl(posted.hash)}`);
  const serviceUrl = arg('--url') || listing.service_url;
  console.error(`[order] sending tasks to ${serviceUrl}/replay`);
  const r = await fetch(`${serviceUrl.replace(/\/$/, '')}/replay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job_id: posted.jobId, tasks }) });
  let j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`[order] agent answered HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}. You can refund the job after its deadline: refund(${posted.jobId}).`); process.exit(1); }
  if (r.status === 202) {
    // The run takes minutes; the agent answered 202 with a status URL. Poll it.
    console.error(`[order] agent accepted the job, polling ${j.status}`);
    const deadline = Date.now() + 20 * 60e3;
    let last = '';
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 3000));
      const st = await fetch(j.status).then((x) => x.json()).catch(() => null);
      if (!st) continue;
      if (st.state !== last) { last = st.state; console.error(`[order] run state: ${st.state}`); }
      if (st.state === 'done') { j = st.result; break; }
      if (st.state === 'error') { console.error(`[order] agent failed: ${st.error}. Refund after the deadline: refund(${posted.jobId}).`); process.exit(1); }
    }
    if (!j.reportJson) { console.error('[order] timed out waiting for the run'); process.exit(1); }
  }
  // Verify: the report the agent served hashes to what it recorded on-chain.
  const job = await getJob(posted.jobId);
  const reportBytes = Buffer.from(await (await fetch(j.reportJson)).arrayBuffer());
  const local = sha256hex(reportBytes);
  const verified = job.status === 'Delivered' && job.report_hash === local;
  const dir = arg('--out') || join('reports', 'orders', String(posted.jobId));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), reportBytes);
  out({ jobId: posted.jobId, customer: customer.accountId, agent: agentId, paidNear: fmtNear(listing.price, 6), tx: { post: posted.hash, ...j.tx }, passed: j.passed, total: j.total, report: j.report, reportHash: { onchain: job.report_hash, local, verified }, agentSpentNear: j.spentNear, upstreamPaidCalls: j.upstreamPaidCalls });
  process.exit(verified && j.passed === j.total ? 0 : 1);
} else if (cmd === 'refund' && a1) {
  let customer;
  try { customer = accountFromEnv('REPLAYCHECK_CUSTOMER_ID', 'REPLAYCHECK_CUSTOMER_KEY'); }
  catch { customer = accountFromEnv('REPLAYCHECK_DEMO_CUSTOMER_ID', 'REPLAYCHECK_DEMO_CUSTOMER_KEY'); }
  const before = await getJob(Number(a1));
  const r = await refund(customer, Number(a1));
  out({ jobId: Number(a1), was: before?.status, now: (await getJob(Number(a1)))?.status, refundedNear: fmtNear(before?.deposit || 0, 6), tx: r.hash, explorer: txUrl(r.hash) });
} else if (cmd === 'verify' && a1 && a2) {
  const job = await getJob(Number(a1));
  const local = sha256hex(readFileSync(a2));
  out({ jobId: Number(a1), status: job?.status, onchain: job?.report_hash, local, verified: job?.report_hash === local, passed: job?.passed, total: job?.total, report_url: job?.report_url });
  process.exit(job?.report_hash === local ? 0 : 1);
} else {
  console.error('usage: replaycheck order <tasks.json> [--agent acc] | run <tasks.json> [--out dir] | refund <job_id> | verify <job_id> <report.json> | whoami');
  process.exit(2);
}
