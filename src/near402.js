// near402 — HTTP 402 payments on NEAR, both sides.
//
// A service answers an unpaid request with 402 and a JSON invoice:
//   { "near402": 1, "network": "testnet", "contract": "<market contract>", "pay_to": "<service account>",
//     "amount": "<yoctoNEAR>", "memo": "<unique, 1-128 printable chars>", "expires_at": <unix ms> }
// The client pays by calling `pay(to, memo)` on the market contract with the amount attached,
// then repeats the request with headers `x-near-payment: <tx hash>` and `x-near-payer: <account>`.
// The service verifies the payment from the transaction's receipts (the `pay` event), marks the
// memo as spent and serves the request. Memos are single use, so a receipt cannot be replayed.
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pay, verifyPayment } from './near.js';
import { network, CONTRACT_ID, MAX_CALL_YOCTO, MAX_RUN_YOCTO, txUrl, fmtNear } from './config.js';

// ── client ─────────────────────────────────────────────────────────────────

let spent = 0n;
export const receipts = [];
const RECEIPTS_FILE = process.env.REPLAYCHECK_RECEIPTS || 'reports/receipts.jsonl';
export function spentYocto() { return spent; }

/**
 * fetch() that pays a 402 invoice with `account` and retries once. Every payment is capped per
 * call and per process, and recorded in `receipts` (what, to whom, how much, which transaction).
 */
export async function paidFetch(account, url, init = {}, { label = '', maxYocto = MAX_CALL_YOCTO } = {}) {
  let res = await fetch(url, init);
  if (res.status !== 402) return res;
  const inv = await res.json().catch(() => null);
  if (!inv || inv.near402 !== 1) throw new Error(`402 without a near402 invoice from ${url}`);
  if (inv.network !== network().slug) throw new Error(`invoice is for ${inv.network}, this agent runs on ${network().slug}`);
  if (inv.contract !== CONTRACT_ID()) throw new Error(`invoice wants contract ${inv.contract}, this agent trusts ${CONTRACT_ID()}`);
  const amount = BigInt(inv.amount);
  if (amount > maxYocto) throw new Error(`invoice ${fmtNear(amount)} NEAR exceeds the per-call cap ${fmtNear(maxYocto)} NEAR (${label || url})`);
  if (spent + amount > MAX_RUN_YOCTO) throw new Error(`run budget exceeded: ${fmtNear(spent + amount)} > ${fmtNear(MAX_RUN_YOCTO)} NEAR`);

  const paid = await pay(account, inv.pay_to, amount, inv.memo);
  spent += amount;
  const rec = {
    label, url, network: inv.network, payer: account.accountId, payTo: inv.pay_to,
    amount: amount.toString(), near: fmtNear(amount, 6), memo: inv.memo,
    txHash: paid.hash, explorer: txUrl(paid.hash), at: new Date().toISOString(),
  };
  receipts.push(rec);
  try { mkdirSync(dirname(RECEIPTS_FILE), { recursive: true }); appendFileSync(RECEIPTS_FILE, JSON.stringify(rec) + '\n'); } catch {}

  const headers = { ...(init.headers || {}), 'x-near-payment': paid.hash, 'x-near-payer': account.accountId, 'x-near-memo': inv.memo };
  res = await fetch(url, { ...init, headers });
  if (res.status === 402) throw new Error(`service did not accept payment ${paid.hash}: ${await res.text()}`);
  return res;
}

export async function paidJson(account, url, body, opts) {
  const res = await paidFetch(account, url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
  }, opts);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`paid call ${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status; err.body = json; err.paidMaybe = res.status >= 500;
    throw err;
  }
  return json;
}

// ── service ────────────────────────────────────────────────────────────────

/**
 * Invoice book for one service account. `price(req)` returns yoctoNEAR for a request (or 0n for
 * free). Call `gate(req, res, amount)`: it returns true when the request is paid and may proceed,
 * or writes the 402 / 403 itself and returns false.
 */
export class PayGate {
  constructor({ payTo, ttlMs = 10 * 60e3 }) {
    this.payTo = payTo;
    this.ttlMs = ttlMs;
    this.invoices = new Map(); // memo -> { amount, expiresAt }
    this.spent = new Set();    // memos already redeemed
    this.redeemed = [];        // receipts of accepted payments (for the worker's own ledger)
  }

  invoice(amount) {
    this.sweep();
    const memo = 'rc-' + randomBytes(9).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.invoices.set(memo, { amount: BigInt(amount), expiresAt });
    return { near402: 1, network: network().slug, contract: CONTRACT_ID(), pay_to: this.payTo, amount: BigInt(amount).toString(), memo, expires_at: expiresAt };
  }

  sweep() {
    const now = Date.now();
    for (const [m, inv] of this.invoices) if (inv.expiresAt < now) this.invoices.delete(m);
  }

  /**
   * Returns true when the request carries a verified payment for `amount`. Otherwise writes a
   * 402 with a fresh invoice (or the reason a payment was refused) and returns false.
   * The client sends `x-near-payment` (tx hash), `x-near-payer` (account) and `x-near-memo`.
   */
  async gate(req, res, amount, send) {
    if (BigInt(amount) === 0n) return true;
    const txHash = req.headers['x-near-payment'], payer = req.headers['x-near-payer'], memo = req.headers['x-near-memo'];
    if (!txHash || !payer || !memo) { send(res, 402, this.invoice(amount)); return false; }
    const result = await this.redeem({ txHash, payer, memo });
    if (!result.ok) { send(res, 402, { error: result.reason, ...this.invoice(amount) }); return false; }
    req.payment = result;
    return true;
  }

  async redeem({ txHash, payer, memo }) {
    this.sweep();
    if (this.spent.has(memo)) return { ok: false, reason: 'invoice already redeemed' };
    const inv = this.invoices.get(memo);
    if (!inv) return { ok: false, reason: 'unknown or expired invoice memo' };
    let v;
    try { v = await verifyPayment({ txHash, payer, payTo: this.payTo, amount: inv.amount, memo }); }
    catch (e) { return { ok: false, reason: 'cannot read transaction: ' + e.message }; }
    if (!v.ok) return v;
    this.spent.add(memo);
    this.invoices.delete(memo);
    const rec = { ...v, at: new Date().toISOString() };
    this.redeemed.push(rec);
    return rec;
  }
}
