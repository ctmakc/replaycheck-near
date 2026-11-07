// Browser worker — a second agent that sells two things for NEAR over near402:
//   POST /v1/sessions           rent an isolated Chromium tab for N minutes   (price per minute)
//   POST /v1/sessions/:id/cmd   drive it: open, fill, click, press, wait, screenshot, get …
//   GET  /v1/sessions/:id       status · DELETE /v1/sessions/:id  close early
//   POST /v1/judge              plain-language check of a page, answered by a local LLM (Ollama)
//   GET  /v1/health · GET /v1/ledger   what it sold and the receipts it verified
// It holds its own NEAR account and never sees the buyer's keys. Payment proof is the `pay`
// event on the market contract (see src/near402.js).
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { PayGate } from '../src/near402.js';
import { network, parseNear, fmtNear } from '../src/config.js';

const PORT = Number(process.env.WORKER_PORT || 8745);
const WORKER_ID = process.env.REPLAYCHECK_WORKER_ID;
if (!WORKER_ID) { console.error('REPLAYCHECK_WORKER_ID is not set (the worker needs a NEAR account to be paid into)'); process.exit(2); }
const PRICE_PER_MINUTE = parseNear(process.env.WORKER_PRICE_PER_MINUTE || '0.001');
const PRICE_JUDGE = parseNear(process.env.WORKER_PRICE_JUDGE || '0.002');
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';
const DURATIONS = [1, 2, 3, 5, 10];
const MAX_SESSIONS = Number(process.env.WORKER_MAX_SESSIONS || 4);
const CHROME = process.env.REPLAYCHECK_CHROME || undefined; // optional path to a Chromium binary

const gate = new PayGate({ payTo: WORKER_ID });
const sessions = new Map();
let browser;
let sold = { sessions: 0, minutes: 0, judges: 0, earned: 0n };

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  return browser;
}

function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
async function readBody(req) { let raw = ''; for await (const c of req) { raw += c; if (raw.length > 512 * 1024) break; } try { return JSON.parse(raw || '{}'); } catch { return null; } }

async function openSession(minutes, payment) {
  const b = await getBrowser();
  const context = await b.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const id = 's-' + randomBytes(6).toString('hex');
  const token = randomBytes(18).toString('base64url');
  const expiresAt = Date.now() + minutes * 60e3;
  const s = { id, token, page, context, minutes, expiresAt, status: 'ready', commands: 0, payment };
  s.timer = setTimeout(() => closeSession(id, 'expired'), minutes * 60e3);
  sessions.set(id, s);
  sold.sessions++; sold.minutes += minutes; sold.earned += BigInt(payment.amount);
  return s;
}

async function closeSession(id, status = 'closed') {
  const s = sessions.get(id); if (!s) return;
  clearTimeout(s.timer); s.status = status;
  try { await s.context.close(); } catch {}
  sessions.delete(id);
}

const loc = (page, target) => page.locator(target).first();

async function runCommand(s, c) {
  const { page } = s;
  s.commands++;
  switch (c.action) {
    case 'open': await page.goto(c.url, { waitUntil: 'domcontentloaded' }); return { url: page.url() };
    case 'click': await loc(page, c.target).click(); return {};
    case 'fill': await loc(page, c.target).fill(String(c.text ?? '')); return {};
    case 'type': await loc(page, c.target).pressSequentially(String(c.text ?? ''), { delay: 20 }); return {};
    case 'press': if (c.target) await loc(page, c.target).press(c.key || 'Enter'); else await page.keyboard.press(c.key || 'Enter'); return {};
    case 'check': await loc(page, c.target).check(); return {};
    case 'uncheck': await loc(page, c.target).uncheck(); return {};
    case 'hover': await loc(page, c.target).hover(); return {};
    case 'focus': await loc(page, c.target).focus(); return {};
    case 'scroll': if (c.target) await loc(page, c.target).scrollIntoViewIfNeeded(); else await page.mouse.wheel(0, Number(c.y ?? 600)); return {};
    case 'wait':
      if (c.target) await loc(page, c.target).waitFor({ state: 'visible', timeout: Math.min(Number(c.timeoutMs || 15000), 30000) });
      else await page.waitForTimeout(Math.min(Number(c.ms || 1000), 10000));
      return {};
    case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }); return {};
    case 'forward': await page.goForward({ waitUntil: 'domcontentloaded' }); return {};
    case 'reload': await page.reload({ waitUntil: 'domcontentloaded' }); return {};
    case 'screenshot': return { base64: (await page.screenshot({ type: 'png', fullPage: false })).toString('base64') };
    case 'get': {
      const kind = c.kind || 'text';
      if (kind === 'url') return { url: page.url() };
      if (kind === 'title') return { title: await page.title() };
      if (kind === 'text') return { text: (await (c.target ? loc(page, c.target) : page.locator('body')).innerText().catch(() => '')).slice(0, 200000) };
      if (kind === 'html') return { html: (await page.content()).slice(0, 500000) };
      throw Object.assign(new Error('unknown get kind ' + kind), { code: 'bad_request' });
    }
    default: throw Object.assign(new Error('unknown action ' + c.action), { code: 'bad_request' });
  }
}

async function judge({ expectation, pageText, url, title }) {
  const prompt = [
    'You check whether a web page satisfies an expectation after an automated user flow.',
    'Answer with JSON only: {"pass": true|false, "reason": "<one sentence>"}.',
    `Expectation: ${expectation}`, `URL: ${url}`, `Title: ${title}`,
    'Visible page text (truncated):', String(pageText || '').slice(0, 6000),
  ].join('\n');
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, format: 'json', options: { temperature: 0, num_predict: 200 }, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(90e3),
  });
  if (!r.ok) throw new Error(`ollama HTTP ${r.status}`);
  const j = await r.json();
  const text = j.message?.content || '';
  try { const o = JSON.parse(text); return { pass: !!o.pass, reason: String(o.reason || '').slice(0, 300), model: OLLAMA_MODEL }; }
  catch { return { pass: /"?pass"?\s*:\s*true/i.test(text), reason: text.slice(0, 300), model: OLLAMA_MODEL }; }
}

function auth(req, s) { return s && req.headers.authorization === `Bearer ${s.token}`; }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean); // ['v1','sessions',':id','cmd']
  try {
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return send(res, 200, { ok: true, worker: WORKER_ID, network: network().slug, prices: { per_minute: PRICE_PER_MINUTE.toString(), judge: PRICE_JUDGE.toString(), per_minute_near: fmtNear(PRICE_PER_MINUTE, 6), judge_near: fmtNear(PRICE_JUDGE, 6) }, durations: DURATIONS, active_sessions: sessions.size, judge_model: OLLAMA_MODEL });
    }
    if (req.method === 'GET' && url.pathname === '/v1/ledger') {
      return send(res, 200, { worker: WORKER_ID, sold: { ...sold, earned: sold.earned.toString(), earned_near: fmtNear(sold.earned, 6) }, receipts: gate.redeemed.slice(-100) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/sessions') {
      const body = await readBody(req); if (!body) return send(res, 400, { error: 'invalid json' });
      const minutes = DURATIONS.includes(Number(body.durationMinutes)) ? Number(body.durationMinutes) : null;
      if (!minutes) return send(res, 400, { error: `durationMinutes must be one of ${DURATIONS.join(', ')}` });
      if (sessions.size >= MAX_SESSIONS) return send(res, 503, { error: 'worker is full, try again in a minute' });
      const price = PRICE_PER_MINUTE * BigInt(minutes);
      if (!(await gate.gate(req, res, price, send))) return;
      const s = await openSession(minutes, req.payment);
      const base = `${process.env.WORKER_PUBLIC_BASE || `http://127.0.0.1:${PORT}`}/v1/sessions/${s.id}`;
      return send(res, 201, { sessionId: s.id, accessToken: s.token, status: 'ready', durationMinutes: minutes, expiresAt: s.expiresAt, commandUrl: `${base}/cmd`, statusUrl: base, paid: { amount: req.payment.amount, txHash: req.payment.txHash } });
    }
    if (parts[0] === 'v1' && parts[1] === 'sessions' && parts[2]) {
      const s = sessions.get(parts[2]);
      if (!s) return send(res, 404, { error: 'no such session (expired or closed)' });
      if (!auth(req, s)) return send(res, 401, { error: 'bad session token' });
      if (req.method === 'GET' && !parts[3]) return send(res, 200, { sessionId: s.id, status: s.status, expiresAt: s.expiresAt, commands: s.commands });
      if (req.method === 'DELETE' && !parts[3]) { await closeSession(s.id); return send(res, 200, { ok: true }); }
      if (req.method === 'POST' && parts[3] === 'cmd') {
        const c = await readBody(req); if (!c || !c.action) return send(res, 400, { error: 'command needs an action' });
        try { return send(res, 200, { output: await runCommand(s, c) }); }
        catch (e) { return send(res, e.code === 'bad_request' ? 400 : 422, { error: { code: e.code || 'command_failed', message: String(e.message).split('\n')[0].slice(0, 300) } }); }
      }
    }
    if (req.method === 'POST' && url.pathname === '/v1/judge') {
      const body = await readBody(req); if (!body?.expectation) return send(res, 400, { error: 'expectation is required' });
      if (!(await gate.gate(req, res, PRICE_JUDGE, send))) return;
      sold.judges++; sold.earned += BigInt(req.payment.amount);
      return send(res, 200, { ...(await judge(body)), paid: { amount: req.payment.amount, txHash: req.payment.txHash } });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[worker]', e);
    send(res, 500, { error: String(e.message).slice(0, 300) });
  }
});

server.listen(PORT, process.env.WORKER_BIND || '127.0.0.1', () =>
  console.error(`[worker] ${WORKER_ID} selling browser minutes at ${fmtNear(PRICE_PER_MINUTE, 6)} NEAR/min and judgements at ${fmtNear(PRICE_JUDGE, 6)} NEAR on ${network().slug}, 127.0.0.1:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { for (const id of [...sessions.keys()]) await closeSession(id); try { await browser?.close(); } catch {} process.exit(0); });
