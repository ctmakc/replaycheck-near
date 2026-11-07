// ReplayCheck on NEAR — network and spending configuration.
// Everything comes from the environment; see .env.example. Testnet is the default.

export const NETWORKS = {
  testnet: {
    slug: 'testnet',
    rpc: process.env.NEAR_RPC || 'https://rpc.testnet.near.org',
    explorer: 'https://testnet.nearblocks.io',
    faucet: 'https://helper.testnet.near.org/account',
  },
  mainnet: {
    slug: 'mainnet',
    rpc: process.env.NEAR_RPC || 'https://rpc.mainnet.near.org',
    explorer: 'https://nearblocks.io',
  },
};

export function network() {
  const slug = process.env.NEAR_NETWORK || 'testnet';
  const n = NETWORKS[slug];
  if (!n) throw new Error(`unknown NEAR_NETWORK ${slug} (testnet|mainnet)`);
  return n;
}

export const YOCTO = 10n ** 24n;

/** Market contract (escrow jobs + pay-with-memo). */
export const CONTRACT_ID = () => process.env.REPLAYCHECK_CONTRACT_ID || '';

/** Where the agent buys browser minutes and judgement calls. */
export const WORKER_URL = () => process.env.REPLAYCHECK_WORKER_URL || 'http://127.0.0.1:8745';

// Spending guards, in yoctoNEAR. The most one paid call may cost, and the most one process
// may spend in total. Defaults: 0.01 NEAR per call, 0.5 NEAR per process.
export const MAX_CALL_YOCTO = BigInt(process.env.REPLAYCHECK_MAX_CALL_YOCTO || (YOCTO / 100n).toString());
export const MAX_RUN_YOCTO = BigInt(process.env.REPLAYCHECK_MAX_RUN_YOCTO || (YOCTO / 2n).toString());

export function txUrl(hash, n = network()) { return `${n.explorer}/txns/${hash}`; }
export function accountUrl(id, n = network()) { return `${n.explorer}/address/${id}`; }

/** yoctoNEAR → "0.0123" NEAR (trimmed), for logs and reports. */
export function fmtNear(yocto, digits = 4) {
  const y = BigInt(yocto);
  const whole = y / YOCTO;
  const frac = (y % YOCTO).toString().padStart(24, '0').slice(0, digits).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** "0.05" NEAR → yoctoNEAR bigint. */
export function parseNear(s) {
  const [w, f = ''] = String(s).trim().split('.');
  return BigInt(w || '0') * YOCTO + BigInt((f + '0'.repeat(24)).slice(0, 24));
}
