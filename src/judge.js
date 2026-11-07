// Judgement step: when a check is written in plain language ("the cart shows 1 item"),
// ReplayCheck buys one judgement call from the worker agent (a local LLM behind near402).
import { paidJson } from './near402.js';
import { WORKER_URL } from './config.js';

export async function judge(account, { expectation, pageText, url, title }) {
  const res = await paidJson(account, `${WORKER_URL()}/v1/judge`, { expectation, pageText: String(pageText || '').slice(0, 6000), url, title }, { label: 'judge' });
  return { pass: !!res.pass, reason: String(res.reason || '').slice(0, 300), model: res.model, paid: res.paid };
}
