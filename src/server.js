// ReplayCheck agent as a paid service on NEAR.
//
//   POST /v1/replay  { job_id, tasks }   the customer has already posted + funded the job on the
//                                        market contract. The agent checks the job is for it, is
//                                        open, and that sha256(canonical({tasks})) equals the
//                                        job's spec_hash; accepts it on-chain; rents browser
//                                        minutes (and judgement calls) from the worker agent over
//                                        near402; writes the report; delivers its hash on-chain,
//                                        which releases the escrow to the agent.
//   GET  /v1/agent                        listing: account, price, contract, worker, stats
//   GET  /v1/health
//   GET  /reports/…                       delivered reports (HTML, JSON, screenshots)
//   POST /demo/run { tasks }              free demo: the server itself plays the customer with a
//                                        separate funded testnet account, so a visitor sees the
//                                        full paid loop without a wallet. Rate-limited.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { runTask } from './runner.js';
import { writeReportJson, writeHtml } from './report.js';
import { receipts } from './near402.js';
import { agentAccount, accountFromEnv, getJob, getAgent, getStats, getRecentJobs, acceptJob, deliver, postJob, specHash, balance } from './near.js';
import { network, CONTRACT_ID, WORKER_URL, fmtNear, txUrl } from './config.js';

const PORT = Number(process.env.PORT || 8746);
const PUBLIC_BASE = process.env.REPLAYCHECK_PUBLIC_BASE || `http://127.0.0.1:${PORT}`;
const MAX_TASKS = 3, MAX_STEPS = 12;
const DEMO_PER_HOUR = Number(process.env.REPLAYCHECK_DEMO_PER_HOUR || 20);
const agent = agentAccount();
let demoBusy = false; const demoTimes = [];
const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/logo.png': ['public/logo.png', 'image/png'],
  '/mmix-logo.png': ['public/mmix-logo.png', 'image/png'],
  '/demo.mp4': ['public/demo.mp4', 'video/mp4'],
  '/tasks/demo.json': ['tasks/demo.json', 'application/json'],
  // Demo storefront the sample tasks replay against (public/shop).
  '/shop/login': ['public/shop/login.html', 'text/html; charset=utf-8'],
  '/shop/account': ['public/shop/account.html', 'text/html; charset=utf-8'],
  '/shop/style.css': ['public/shop/style.css', 'text/css; charset=utf-8'],
};
const events = []; // live feed for the demo page: last 200 events
// Runs in flight or finished in this process: jobId -> { state, startedAt, finishedAt, result | error }.
// Replays take minutes and proxies cut long responses, so POST answers 202 and clients poll GET /v1/runs/:id.
const runs = new Map();
function startRun(jobId, tasks, payer, extra = {}) {
  const run = { jobId, state: 'running', startedAt: new Date().toISOString(), ...extra };
  runs.set(jobId, run);
  serveJob(jobId, tasks, { payer })
    .then((result) => Object.assign(run, { state: 'done', finishedAt: new Date().toISOString(), result: { ...result, ...extra } }))
    .catch((e) => { emit('error', { jobId, message: e.message }); Object.assign(run, { state: 'error', finishedAt: new Date().toISOString(), error: e.message }); });
  return run;
}
async function precheck(jobId, tasks) {
  const job = await getJob(jobId);
  if (!job) throw Object.assign(new Error(`job ${jobId} does not exist on ${CONTRACT_ID()}`), { status: 404 });
  if (job.agent !== agent.accountId) throw Object.assign(new Error(`job ${jobId} is for ${job.agent}, this agent is ${agent.accountId}`), { status: 403 });
  if (job.status !== 'Open') throw Object.assign(new Error(`job ${jobId} is ${job.status}, expected Open`), { status: 409 });
  const hash = specHash(tasks);
  if (hash !== job.spec_hash) throw Object.assign(new Error(`task spec hash ${hash} does not match the job's ${job.spec_hash}`), { status: 400 });
  return job;
}
function emit(kind, data) { events.push({ t: Date.now(), kind, ...data }); if (events.length > 200) events.shift(); }

function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj)); }
async function readBody(req) { let raw = ''; for await (const c of req) { raw += c; if (raw.length > 128 * 1024) break; } return raw; }

function validate(body) {
  const tasks = body?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_TASKS) return `tasks must be an array of 1..${MAX_TASKS}`;
  for (const [i, t] of tasks.entries()) {
    if (typeof t.startUrl !== 'string' || !/^https:\/\//.test(t.startUrl)) return `tasks[${i}].startUrl must be https`;
    if (!Array.isArray(t.steps) || t.steps.length > MAX_STEPS) return `tasks[${i}].steps must be an array of at most ${MAX_STEPS}`;
    if (!Array.isArray(t.expect) || t.expect.length === 0 || t.expect.length > 4) return `tasks[${i}].expect must have 1..4 checks`;
    if (typeof t.id !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(t.id)) return `tasks[${i}].id must match [a-z0-9_-]{1,40}`;
    if (typeof t.name !== 'string' || t.name.length > 200) return `tasks[${i}].name must be a string of at most 200 chars`;
  }
  return null;
}

/** The paid loop for one funded job. */
async function serveJob(jobId, tasks, { payer }) {
  const job = await precheck(jobId, tasks);
  const hash = job.spec_hash;

  const runId = `job-${jobId}-` + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join('reports', 'runs', runId);
  mkdirSync(outDir, { recursive: true });
  emit('job', { jobId, stage: 'verified', hash });

  const accepted = await acceptJob(agent, jobId);
  emit('job', { jobId, stage: 'accepted', tx: accepted.hash, url: txUrl(accepted.hash) });

  const before = receipts.length;
  const results = [];
  for (const t of tasks) {
    emit('task', { jobId, id: t.id, stage: 'start' });
    const r = await runTask(agent, t, outDir);
    emit('task', { jobId, id: t.id, stage: r.status, paid: r.paid });
    results.push(r);
  }
  const runReceipts = receipts.slice(before);
  const passed = results.filter((r) => r.status === 'pass').length;
  const run = { runId, jobId, network: network().slug, contract: CONTRACT_ID(), agent: agent.accountId, customer: job.customer, specHash: hash, payer, results, receipts: runReceipts, finishedAt: new Date().toISOString() };
  const reportHash = writeReportJson(outDir, run);
  const reportUrl = `${PUBLIC_BASE}/${outDir}/index.html`;
  const delivered = await deliver(agent, jobId, reportHash, passed, results.length, reportUrl);
  emit('job', { jobId, stage: 'delivered', tx: delivered.hash, url: txUrl(delivered.hash), passed, total: results.length, reportHash, reportUrl });
  const onchain = { jobId, customer: job.customer, deposit: job.deposit, specHash: hash, reportHash, acceptTx: accepted.hash, deliverTx: delivered.hash };
  writeHtml(outDir, run, onchain);
  const spent = runReceipts.reduce((a, r) => a + BigInt(r.amount), 0n);
  return {
    jobId, runId, network: network().slug, contract: CONTRACT_ID(),
    report: reportUrl, reportJson: `${PUBLIC_BASE}/${outDir}/report.json`, reportHash,
    passed, total: results.length,
    earned: job.deposit, earnedNear: fmtNear(job.deposit, 6), spent: spent.toString(), spentNear: fmtNear(spent, 6),
    tx: { accept: accepted.hash, deliver: delivered.hash, acceptUrl: txUrl(accepted.hash), deliverUrl: txUrl(delivered.hash) },
    results: results.map((r) => ({ id: r.id, name: r.name, status: r.status, error: r.error || null, checks: r.checks, screenshots: r.screenshots.map((s) => `${PUBLIC_BASE}/${outDir}/${r.id}/${s}`), final: r.final, paid: r.paid })),
    upstreamPaidCalls: runReceipts.map((r) => ({ label: r.label, payTo: r.payTo, near: r.near, memo: r.memo, txHash: r.txHash, explorer: r.explorer })),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { ok: true, agent: agent.accountId, network: network().slug, contract: CONTRACT_ID() });
    if (req.method === 'GET' && url.pathname === '/v1/agent') {
      const [listing, stats, bal] = await Promise.all([getAgent(agent.accountId), getStats(), balance(agent.accountId).catch(() => null)]);
      const worker = await fetch(`${WORKER_URL()}/v1/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null);
      return send(res, 200, { agent: agent.accountId, network: network().slug, contract: CONTRACT_ID(), listing, stats, balance: bal?.toString() ?? null, balanceNear: bal != null ? fmtNear(bal, 4) : null, worker, explorer: network().explorer });
    }
    if (req.method === 'GET' && url.pathname === '/v1/jobs') return send(res, 200, await getRecentJobs(Number(url.searchParams.get('limit') || 20)));
    if (req.method === 'GET' && url.pathname.startsWith('/v1/runs/')) {
      const id = Number(url.pathname.split('/')[3]);
      const run = runs.get(id);
      if (run) return send(res, 200, run);
      const job = await getJob(id).catch(() => null);
      return send(res, job ? 200 : 404, job ? { jobId: id, state: 'unknown-to-this-process', onchain: job } : { error: 'no such job' });
    }
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const since = Number(url.searchParams.get('since') || 0);
      return send(res, 200, events.filter((e) => e.t > since));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/reports/')) {
      const p = normalize(url.pathname).replace(/^\/+/, '');
      if (!p.startsWith('reports/') || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      const type = p.endsWith('.png') ? 'image/png' : p.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*' }); return res.end(readFileSync(p));
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [f, type] = STATIC[url.pathname];
      if (!existsSync(f)) { res.writeHead(404); return res.end(); }
      const h = { 'content-type': type, 'cache-control': 'no-cache' };
      if (type.startsWith('text/html')) h['permissions-policy'] = 'microphone=(self), camera=(self)';
      res.writeHead(200, h); return res.end(readFileSync(f));
    }
    // MMIX Review Kit (studio bug button on every page we ship): static files + binary-safe proxy to review.mmix.biz
    if (req.method === 'GET' && url.pathname.startsWith('/mmix-kit/')) {
      const p = normalize(url.pathname).replace(/^\/+/, '');
      const f = join('public', p);
      if (!p.startsWith('mmix-kit/') || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': p.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(readFileSync(f));
    }
    if (url.pathname.startsWith('/api/review')) {
      const chunks = []; for await (const c of req) { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 30 * 1024 * 1024) break; }
      const body = Buffer.concat(chunks);
      const headers = {}; for (const k of ['content-type', 'accept', 'x-forwarded-for', 'user-agent', 'referer']) if (req.headers[k]) headers[k] = req.headers[k];
      try {
        const up = await fetch('https://review.mmix.biz' + url.pathname + url.search, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual', signal: AbortSignal.timeout(60e3) });
        const out = Buffer.from(await up.arrayBuffer());
        const h = {}; for (const k of ['content-type', 'content-disposition', 'cache-control', 'content-security-policy', 'location']) { const v = up.headers.get(k); if (v) h[k] = v; }
        res.writeHead(up.status, h); return res.end(out);
      } catch (e) { return send(res, 502, { error: 'review proxy: ' + e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/v1/replay') {
      let body; try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid json' }); }
      const err = validate(body); if (err) return send(res, 400, { error: err });
      if (!Number.isInteger(body.job_id) || body.job_id < 0) return send(res, 400, { error: 'job_id (integer) is required: post the job on the market contract first' });
      if (runs.get(body.job_id)?.state === 'running') return send(res, 409, { error: `job ${body.job_id} is already running` });
      try { await precheck(body.job_id, body.tasks); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
      startRun(body.job_id, body.tasks, null);
      return send(res, 202, { jobId: body.job_id, state: 'running', status: `${PUBLIC_BASE}/v1/runs/${body.job_id}`, note: 'poll the status URL every few seconds; the report appears there when deliver() has been sent' });
    }
    if (req.method === 'POST' && url.pathname === '/demo/run') {
      if (network().slug !== 'testnet') return send(res, 403, { error: 'free demo runs only on testnet; use POST /v1/replay with a funded job' });
      let customer; try { customer = accountFromEnv('REPLAYCHECK_DEMO_CUSTOMER_ID', 'REPLAYCHECK_DEMO_CUSTOMER_KEY'); } catch { return send(res, 503, { error: 'demo customer account is not configured on this instance' }); }
      const now = Date.now(); while (demoTimes.length && now - demoTimes[0] > 3600e3) demoTimes.shift();
      if (demoTimes.length >= DEMO_PER_HOUR) return send(res, 429, { error: 'demo limit reached for this hour; post your own job from a testnet account instead' });
      if (demoBusy) return send(res, 429, { error: 'another demo run is in progress, try again in a minute' });
      let body; try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid json' }); }
      const err = validate(body); if (err) return send(res, 400, { error: err });
      if (body.tasks.length > 2) return send(res, 400, { error: 'demo runs take up to two tasks' });
      demoBusy = true; demoTimes.push(Date.now());
      try {
        const listing = await getAgent(agent.accountId);
        if (!listing) return send(res, 503, { error: 'agent is not registered on the market contract' });
        const hash = specHash(body.tasks);
        emit('demo', { stage: 'posting', customer: customer.accountId, hash });
        const posted = await postJob(customer, agent.accountId, hash, BigInt(listing.price));
        emit('job', { jobId: posted.jobId, stage: 'posted', tx: posted.hash, url: txUrl(posted.hash), customer: customer.accountId, deposit: listing.price });
        const run = startRun(posted.jobId, body.tasks, customer.accountId, { customer: customer.accountId, postTx: posted.hash, postTxUrl: txUrl(posted.hash) });
        const release = () => { demoBusy = false; };
        const tick = setInterval(() => { if (run.state !== 'running') { clearInterval(tick); release(); } }, 1000);
        return send(res, 202, { jobId: posted.jobId, state: 'running', customer: customer.accountId, tx: { post: posted.hash, postUrl: txUrl(posted.hash) }, status: `${PUBLIC_BASE}/v1/runs/${posted.jobId}` });
      } catch (e) { demoBusy = false; emit('error', { message: e.message }); return send(res, e.status || 500, { error: e.message }); }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[replaycheck]', e);
    send(res, 500, { error: String(e.message).slice(0, 300) });
  }
});
server.listen(PORT, process.env.BIND || '127.0.0.1', () => console.error(`[replaycheck] agent ${agent.accountId} on NEAR ${network().slug}, market ${CONTRACT_ID()}, worker ${WORKER_URL()} — 127.0.0.1:${PORT}`));
