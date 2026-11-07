// Thin NEAR layer: accounts from env keys, views, calls, and the two things the market
// contract is for — escrow jobs and `pay(to, memo)` receipts.
import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, FailoverRpcProvider, KeyPair } from 'near-api-js';
import { network, rpcUrls, CONTRACT_ID } from './config.js';

const TGAS = 10n ** 12n;

let _provider;
export function provider() {
  if (!_provider) {
    const urls = rpcUrls();
    _provider = urls.length > 1 ? new FailoverRpcProvider(urls.map((url) => new JsonRpcProvider({ url }))) : new JsonRpcProvider({ url: urls[0] });
  }
  return _provider;
}

/** Account that signs with the key in `envKey`; its id comes from `envId`. */
export function accountFromEnv(envId = 'REPLAYCHECK_AGENT_ID', envKey = 'REPLAYCHECK_AGENT_KEY') {
  const id = process.env[envId], key = process.env[envKey];
  if (!id || !key) throw new Error(`${envId} / ${envKey} are not set (run npm run setup:testnet or see .env.example)`);
  return new Account(id, provider(), key);
}

export function agentAccount() { return accountFromEnv(); }

export async function balance(accountId) {
  const a = new Account(accountId, provider());
  const st = await a.getState();
  return st.balance.available;
}

export async function view(method, args = {}, contractId = CONTRACT_ID()) {
  return provider().callFunction({ contractId, method, args });
}

/** Function call that returns the raw outcome (hash, logs, status). */
export async function call(account, method, args = {}, { deposit = 0n, gas = 30n * TGAS, contractId = CONTRACT_ID() } = {}) {
  const out = await account.callFunctionRaw({ contractId, methodName: method, args, deposit, gas, waitUntil: 'EXECUTED_OPTIMISTIC' });
  const failure = failureOf(out);
  if (failure) throw new Error(`${method} failed: ${failure}`);
  return { hash: out.transaction.hash, logs: logsOf(out), outcome: out };
}

export function logsOf(outcome) {
  const logs = [];
  for (const r of outcome.receipts_outcome || []) logs.push(...(r.outcome?.logs || []));
  return logs;
}

export function failureOf(outcome) {
  const st = outcome.status || outcome.final_execution_status;
  if (st && typeof st === 'object' && st.Failure) return JSON.stringify(st.Failure);
  for (const r of outcome.receipts_outcome || []) {
    const s = r.outcome?.status;
    if (s && typeof s === 'object' && s.Failure) return JSON.stringify(s.Failure);
  }
  return null;
}

/** Parse NEP-297 events from outcome logs: EVENT_JSON:{standard,version,event,data:[...]}. */
export function eventsOf(logs, standard = 'replaycheck_market') {
  const out = [];
  for (const l of logs) {
    if (!l.startsWith('EVENT_JSON:')) continue;
    try {
      const e = JSON.parse(l.slice('EVENT_JSON:'.length));
      if (e.standard === standard) for (const d of e.data || []) out.push({ event: e.event, ...d });
    } catch {}
  }
  return out;
}

/** Return value of a call, decoded from the transaction outcome. */
export function returnValueOf(outcome) {
  const s = outcome.status;
  if (s && typeof s === 'object' && typeof s.SuccessValue === 'string') {
    const txt = Buffer.from(s.SuccessValue, 'base64').toString('utf8');
    try { return JSON.parse(txt); } catch { return txt; }
  }
  return undefined;
}

// ── hashes ─────────────────────────────────────────────────────────────────

/** Stable JSON: keys sorted at every level, no whitespace. The same tasks always hash the same. */
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function sha256hex(data) { return createHash('sha256').update(data).digest('hex'); }

/** Hash the customer's task list the way the contract expects it: sha256(canonical({tasks})). */
export function specHash(tasks) { return sha256hex(canonical({ tasks })); }

// ── market: escrow jobs ────────────────────────────────────────────────────

export async function getAgent(accountId) { return view('get_agent', { account_id: accountId }); }
export async function getJob(jobId) { return view('get_job', { job_id: Number(jobId) }); }
export async function getStats() { return view('get_stats', {}); }
export async function getRecentJobs(limit = 20) { return view('get_recent_jobs', { limit }); }

export async function registerAgent(account, serviceUrl, priceYocto) {
  return call(account, 'register_agent', { service_url: serviceUrl, price: priceYocto.toString() });
}

/** Customer: fund a job for `agentId`. Returns { jobId, hash }. */
export async function postJob(account, agentId, hash, depositYocto, timeoutS) {
  const args = { agent: agentId, spec_hash: hash };
  if (timeoutS) args.timeout_s = String(timeoutS);
  const r = await call(account, 'post_job', args, { deposit: depositYocto });
  const ev = eventsOf(r.logs).find((e) => e.event === 'post_job');
  const job = returnValueOf(r.outcome);
  return { jobId: Number(ev?.job_id ?? job?.id), hash: r.hash, job };
}

export async function acceptJob(account, jobId) { return call(account, 'accept_job', { job_id: Number(jobId) }); }

export async function deliver(account, jobId, reportHash, passed, total, reportUrl) {
  const args = { job_id: Number(jobId), report_hash: reportHash, passed, total };
  if (reportUrl) args.report_url = reportUrl;
  return call(account, 'deliver', args, { gas: 50n * TGAS });
}

export async function refund(account, jobId) { return call(account, 'refund', { job_id: Number(jobId) }, { gas: 50n * TGAS }); }

// ── market: pay with memo ──────────────────────────────────────────────────

/** Pay `amountYocto` to `to` through the contract so the transfer carries `memo`. */
export async function pay(account, to, amountYocto, memo) {
  return call(account, 'pay', { to, memo }, { deposit: amountYocto });
}

/**
 * Service side: confirm that transaction `txHash`, signed by `payer`, paid at least `amount`
 * to `payTo` with exactly `memo` through the market contract. Reads the receipts' logs.
 */
export async function verifyPayment({ txHash, payer, payTo, amount, memo, contractId = CONTRACT_ID() }) {
  const out = await provider().viewTransactionStatusWithReceipts({ txHash, accountId: payer, waitUntil: 'EXECUTED_OPTIMISTIC' });
  if (failureOf(out)) return { ok: false, reason: 'transaction failed' };
  if (out.transaction?.receiver_id !== contractId) return { ok: false, reason: `transaction went to ${out.transaction?.receiver_id}, expected ${contractId}` };
  if (out.transaction?.signer_id !== payer) return { ok: false, reason: 'signer mismatch' };
  const ev = eventsOf(logsOf(out)).find((e) => e.event === 'pay' && e.memo === memo);
  if (!ev) return { ok: false, reason: 'no pay event with this memo' };
  if (ev.to !== payTo) return { ok: false, reason: `paid to ${ev.to}, expected ${payTo}` };
  if (BigInt(ev.amount) < BigInt(amount)) return { ok: false, reason: `paid ${ev.amount}, expected ${amount}` };
  return { ok: true, payer: ev.payer, amount: ev.amount, memo: ev.memo, txHash };
}

export { KeyPair, Account, TGAS };
