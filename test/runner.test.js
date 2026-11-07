// The runner against a fake worker that gives sessions away for free (no 402), so this test
// needs neither a browser nor a chain. It checks step execution, literal checks, screenshots
// and failure reporting.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.NEAR_NETWORK = 'testnet';
process.env.REPLAYCHECK_CONTRACT_ID = 'market.test.testnet';

let srv, base;
const pages = {
  'https://shop.test/login': { text: 'Username Password Sign in', title: 'Login' },
  'https://shop.test/secure': { text: 'You logged into a secure area Logout', title: 'Secure' },
};
const sessions = new Map();

before(async () => {
  srv = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const [, , id, cmd] = req.url.split('/').filter(Boolean).length === 4 ? req.url.split('/').filter(Boolean) : [null, null, req.url.split('/')[3], null];
    if (req.method === 'POST' && req.url === '/v1/sessions') {
      const sid = 's' + sessions.size; sessions.set(sid, { url: '', commands: [] });
      return send(201, { sessionId: sid, accessToken: 't', commandUrl: `${base}/v1/sessions/${sid}/cmd`, statusUrl: `${base}/v1/sessions/${sid}` });
    }
    const s = sessions.get(id);
    if (!s) return send(404, { error: 'no session' });
    if (req.method === 'DELETE') { s.closed = true; return send(200, { ok: true }); }
    if (cmd === 'cmd') {
      s.commands.push(body);
      switch (body.action) {
        case 'open': s.url = body.url; return send(200, { output: { url: s.url } });
        case 'fill': return send(200, { output: {} });
        case 'click': s.url = 'https://shop.test/secure'; return send(200, { output: {} });
        case 'wait': if (body.target === '#missing') return send(422, { error: { code: 'command_failed', message: 'timeout waiting for #missing' } }); return send(200, { output: {} });
        case 'screenshot': return send(200, { output: { base64: Buffer.from('png').toString('base64') } });
        case 'get': { const p = pages[s.url] || { text: '', title: '' }; return send(200, { output: body.kind === 'url' ? { url: s.url } : body.kind === 'title' ? { title: p.title } : { text: p.text } }); }
        default: return send(400, { error: { code: 'bad_request', message: 'unknown action' } });
      }
    }
    send(404, { error: 'nf' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  process.env.REPLAYCHECK_WORKER_URL = base;
});
after(() => srv.close());

const account = { accountId: 'agent.test.testnet' };

test('a passing task: steps run in order, literal checks pass, final screenshot saved, session closed', async () => {
  const { runTask } = await import('../src/runner.js');
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  const r = await runTask(account, {
    id: 'login-ok', name: 'login', startUrl: 'https://shop.test/login',
    steps: [{ action: 'fill', target: '#u', text: 'a' }, { action: 'click', target: 'button' }, { action: 'wait', target: '#flash' }],
    expect: [{ urlContains: '/secure' }, { textContains: 'secure area' }, { titleContains: 'secure' }],
  }, dir);
  assert.equal(r.status, 'pass');
  assert.equal(r.checks.length, 3);
  assert.ok(r.checks.every((c) => c.pass));
  assert.deepEqual(r.screenshots, ['final.png']);
  assert.ok(existsSync(join(dir, 'login-ok', 'final.png')));
  const s = [...sessions.values()].at(-1);
  assert.deepEqual(s.commands.map((c) => c.action).slice(0, 4), ['open', 'fill', 'click', 'wait']);
  assert.equal(s.closed, true);
});

test('a failing step stops the task, is reported with a screenshot, and the task is a fail', async () => {
  const { runTask } = await import('../src/runner.js');
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  const r = await runTask(account, {
    id: 'broken', name: 'broken', startUrl: 'https://shop.test/login',
    steps: [{ action: 'wait', target: '#missing' }, { action: 'click', target: 'never' }],
    expect: [{ urlContains: '/secure' }],
  }, dir);
  assert.equal(r.status, 'fail');
  assert.match(r.error, /step 1 \(wait #missing\) failed: wait: HTTP 422 command_failed timeout/);
  assert.equal(r.steps.length, 2); // open + the failed wait; click never ran
  assert.deepEqual(r.screenshots, ['step-1-failed.png']);
  assert.equal(r.checks.length, 0);
});

test('an unsupported action is skipped and reported, optional steps may fail', async () => {
  const { runTask } = await import('../src/runner.js');
  const dir = mkdtempSync(join(tmpdir(), 'rc-'));
  const r = await runTask(account, {
    id: 'odd', name: 'odd', startUrl: 'https://shop.test/login',
    steps: [{ action: 'teleport' }, { action: 'wait', target: '#missing', optional: true }, { action: 'click', target: 'b' }],
    expect: [{ urlContains: '/secure' }],
  }, dir);
  assert.equal(r.status, 'pass');
  assert.equal(r.steps[1].error, 'unsupported action');
  assert.equal(r.steps[2].ok, false);
  assert.equal(r.steps[3].ok, true);
});
