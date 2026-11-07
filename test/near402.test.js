import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PayGate, paidFetch } from '../src/near402.js';

process.env.NEAR_NETWORK = 'testnet';
process.env.REPLAYCHECK_CONTRACT_ID = 'market.test.testnet';

function fakeRes() { const r = { code: null, body: null }; return { r, send: (_res, code, obj) => { r.code = code; r.body = obj; } }; }

test('PayGate: unpaid request gets a 402 invoice with a fresh memo', async () => {
  const g = new PayGate({ payTo: 'worker.test.testnet' });
  const { r, send } = fakeRes();
  const ok = await g.gate({ headers: {} }, {}, 123n, send);
  assert.equal(ok, false);
  assert.equal(r.code, 402);
  assert.equal(r.body.near402, 1);
  assert.equal(r.body.pay_to, 'worker.test.testnet');
  assert.equal(r.body.amount, '123');
  assert.equal(r.body.contract, 'market.test.testnet');
  assert.match(r.body.memo, /^rc-[A-Za-z0-9_-]{12}$/);
  assert.ok(g.invoices.has(r.body.memo));
});

test('PayGate: zero price needs no payment', async () => {
  const g = new PayGate({ payTo: 'w' });
  assert.equal(await g.gate({ headers: {} }, {}, 0n, () => { throw new Error('should not send'); }), true);
});

test('PayGate: unknown memo and expired invoices are refused with a new invoice', async () => {
  const g = new PayGate({ payTo: 'w', ttlMs: 1 });
  const first = g.invoice(5n);
  await new Promise((r) => setTimeout(r, 5));
  const { r, send } = fakeRes();
  const ok = await g.gate({ headers: { 'x-near-payment': 'h', 'x-near-payer': 'p', 'x-near-memo': first.memo } }, {}, 5n, send);
  assert.equal(ok, false);
  assert.equal(r.code, 402);
  assert.equal(r.body.error, 'unknown or expired invoice memo');
  assert.notEqual(r.body.memo, first.memo);
});

test('PayGate: a redeemed memo cannot be used twice', async () => {
  const g = new PayGate({ payTo: 'w' });
  const inv = g.invoice(5n);
  g.spent.add(inv.memo);
  const res = await g.redeem({ txHash: 'h', payer: 'p', memo: inv.memo });
  assert.deepEqual(res, { ok: false, reason: 'invoice already redeemed' });
});

test('paidFetch passes a non-402 response straight through without paying', async () => {
  const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"free":true}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/x`;
  const account = { accountId: 'nobody.testnet' };
  const res = await paidFetch(account, url, { method: 'POST' });
  assert.deepEqual(await res.json(), { free: true });
  srv.close();
});

test('paidFetch refuses an invoice for another network or contract before paying', async () => {
  const srv = createServer((req, res) => { res.writeHead(402, { 'content-type': 'application/json' }); res.end(JSON.stringify({ near402: 1, network: 'mainnet', contract: 'market.test.testnet', pay_to: 'w', amount: '1', memo: 'rc-x' })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/x`;
  await assert.rejects(paidFetch({ accountId: 'a' }, url), /invoice is for mainnet/);
  srv.close();
});

test('paidFetch refuses an invoice above the per-call cap before paying', async () => {
  const srv = createServer((req, res) => { res.writeHead(402, { 'content-type': 'application/json' }); res.end(JSON.stringify({ near402: 1, network: 'testnet', contract: 'market.test.testnet', pay_to: 'w', amount: (10n ** 24n).toString(), memo: 'rc-x' })); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/x`;
  await assert.rejects(paidFetch({ accountId: 'a' }, url), /exceeds the per-call cap/);
  srv.close();
});
