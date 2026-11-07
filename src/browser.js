// A browser session rented from a worker agent and paid for in NEAR over near402.
import { paidJson } from './near402.js';
import { WORKER_URL } from './config.js';

const DURATIONS = [1, 2, 3, 5, 10];

export function pickDuration(steps) {
  // ~10 s per step plus page loads, rounded up to the next sold duration.
  const minutes = Math.max(1, Math.ceil((steps * 10 + 20) / 60));
  return DURATIONS.find((d) => d >= minutes) || 10;
}

export class RentedBrowser {
  static async rent(account, durationMinutes, label) {
    const b = await paidJson(account, `${WORKER_URL()}/v1/sessions`, { durationMinutes }, { label: label || `browser ${durationMinutes}m` });
    if (!b.commandUrl || !b.accessToken) throw new Error('worker answered without a browser session: ' + JSON.stringify(b).slice(0, 300));
    return new RentedBrowser(b);
  }

  constructor(b) { this.info = b; this.sessionId = b.sessionId; this.paid = b.paid; }

  async cmd(command) {
    const r = await fetch(this.info.commandUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.info.accessToken}` },
      body: JSON.stringify(command),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(`${command.action}: HTTP ${r.status} ${j.error?.code || j.error || ''} ${j.error?.message || j.message || ''}`.trim());
      e.code = j.error?.code || j.error; throw e;
    }
    return j.output;
  }

  async close() {
    try { await fetch(this.info.statusUrl, { method: 'DELETE', headers: { authorization: `Bearer ${this.info.accessToken}` } }); } catch {}
  }
}
