#!/usr/bin/env node
// One-command NEAR testnet setup. Free: accounts come from the public testnet faucet helper,
// no wallet app needed. Idempotent per .env.near: re-running reuses what is already there.
//
//   node scripts/near-setup.mjs                 # everything: owner, market contract, agent, worker, demo customer
//   node scripts/near-setup.mjs --redeploy      # rebuild-and-redeploy the contract code only (state kept)
//
// What it creates (all *.testnet, keys written to .env.near with mode 0600):
//   <owner>            rc-<hex>.testnet            pays for the sub-accounts
//   market.<owner>     the ReplayMarket contract (contracts/replay-market/res/replay_market.wasm)
//   agent.<owner>      the ReplayCheck agent — sells runs, buys browser minutes
//   worker.<owner>     the browser worker — sells browser minutes and judgement calls
//   buyer.<owner>      demo customer used by the live page and `replaycheck order`
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPair } from 'near-api-js';

const RPC = process.env.NEAR_RPC || 'https://rpc.testnet.near.org';
const FAUCET = 'https://helper.testnet.near.org/account';
const ENV = process.env.REPLAYCHECK_ENV_FILE || '.env.near';
const WASM = 'contracts/replay-market/res/replay_market.wasm';
const NEAR = 10n ** 24n;
const AGENT_PRICE = process.env.AGENT_PRICE_YOCTO || (NEAR / 20n).toString(); // 0.05 NEAR per job
const SERVICE_URL = process.env.REPLAYCHECK_SERVICE_URL || 'http://127.0.0.1:8746/v1';
const redeploy = process.argv.includes('--redeploy');

const provider = new JsonRpcProvider({ url: RPC });
const env = existsSync(ENV) ? Object.fromEntries(readFileSync(ENV, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(/=(.*)/s).slice(0, 2))) : {};
const save = () => { writeFileSync(ENV, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'); chmodSync(ENV, 0o600); };
const log = (...a) => console.error('[near-setup]', ...a);

async function exists(id) { try { await provider.viewAccount({ accountId: id }); return true; } catch { return false; } }
async function waitFor(id, tries = 40) { for (let i = 0; i < tries; i++) { if (await exists(id)) return; await new Promise((r) => setTimeout(r, 2000)); } throw new Error(`${id} did not appear on testnet`); }

async function faucetAccount(id, key) {
  const r = await fetch(FAUCET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.getPublicKey().toString() }) });
  if (!r.ok) throw new Error(`faucet ${r.status}: ${(await r.text()).slice(0, 200)}`);
  await waitFor(id);
}

async function main() {
  env.NEAR_NETWORK = 'testnet';
  // 1. owner via faucet
  if (!env.NEAR_OWNER_ID) {
    const id = `rc-${randomBytes(3).toString('hex')}.testnet`;
    const key = KeyPair.fromRandom('ed25519');
    log(`creating ${id} through the testnet faucet…`);
    await faucetAccount(id, key);
    env.NEAR_OWNER_ID = id; env.NEAR_OWNER_KEY = key.toString(); save();
  }
  const owner = new Account(env.NEAR_OWNER_ID, provider, env.NEAR_OWNER_KEY);
  const bal = (await owner.getState()).balance.available;
  log(`owner ${owner.accountId} · ${Number(bal / (NEAR / 1000n)) / 1000} NEAR available`);

  // 2. sub-accounts: market (contract), agent, worker, buyer
  const subs = { market: 3n, agent: 2n, worker: 1n, buyer: 2n }; // NEAR funded to each
  for (const [prefix, amount] of Object.entries(subs)) {
    const K = `NEAR_${prefix.toUpperCase()}_ID`, KK = `NEAR_${prefix.toUpperCase()}_KEY`;
    if (env[K] && await exists(env[K])) continue;
    const id = `${prefix}.${owner.accountId}`;
    const key = KeyPair.fromRandom('ed25519');
    log(`creating ${id} with ${amount} NEAR…`);
    await owner.createSubAccount({ accountOrPrefix: prefix, publicKey: key.getPublicKey(), nearToTransfer: amount * NEAR });
    env[K] = id; env[KK] = key.toString(); save();
  }

  // 3. deploy + init the market contract
  const market = new Account(env.NEAR_MARKET_ID, provider, env.NEAR_MARKET_KEY);
  const code = readFileSync(WASM);
  const deployed = (await market.getContractCode().then((c) => c.code_base64?.length > 0).catch(() => false));
  if (!deployed || redeploy) {
    log(`deploying ${WASM} (${code.length} bytes) to ${market.accountId}…`);
    const r = await market.deployContract(code);
    log(`deployed · tx ${r.transaction.hash}`);
    if (!deployed) {
      const i = await market.callFunctionRaw({ contractId: market.accountId, methodName: 'new', args: { owner: owner.accountId }, gas: 30n * 10n ** 12n, waitUntil: 'EXECUTED_OPTIMISTIC' });
      log(`initialised · tx ${i.transaction.hash}`);
    }
  } else log(`contract already deployed at ${market.accountId}`);
  env.REPLAYCHECK_CONTRACT_ID = market.accountId;

  // 4. register the agent
  const agent = new Account(env.NEAR_AGENT_ID, provider, env.NEAR_AGENT_KEY);
  const listing = await provider.callFunction({ contractId: market.accountId, method: 'get_agent', args: { account_id: agent.accountId } });
  if (!listing || listing.service_url !== SERVICE_URL || listing.price !== AGENT_PRICE) {
    const r = await agent.callFunctionRaw({ contractId: market.accountId, methodName: 'register_agent', args: { service_url: SERVICE_URL, price: AGENT_PRICE }, gas: 30n * 10n ** 12n, waitUntil: 'EXECUTED_OPTIMISTIC' });
    log(`agent ${agent.accountId} listed at ${SERVICE_URL} for ${Number(BigInt(AGENT_PRICE) / (NEAR / 1000n)) / 1000} NEAR per job · tx ${r.transaction.hash}`);
  } else log(`agent ${agent.accountId} already listed`);

  // 5. env for the processes
  env.REPLAYCHECK_AGENT_ID = env.NEAR_AGENT_ID; env.REPLAYCHECK_AGENT_KEY = env.NEAR_AGENT_KEY;
  env.REPLAYCHECK_WORKER_ID = env.NEAR_WORKER_ID;
  env.REPLAYCHECK_DEMO_CUSTOMER_ID = env.NEAR_BUYER_ID; env.REPLAYCHECK_DEMO_CUSTOMER_KEY = env.NEAR_BUYER_KEY;
  env.REPLAYCHECK_WORKER_URL = env.REPLAYCHECK_WORKER_URL || 'http://127.0.0.1:8745';
  save();
  log(`done. accounts: owner ${env.NEAR_OWNER_ID} · market ${env.NEAR_MARKET_ID} · agent ${env.NEAR_AGENT_ID} · worker ${env.NEAR_WORKER_ID} · buyer ${env.NEAR_BUYER_ID}`);
  log(`keys are in ${ENV} (0600). Next: set -a; . ./${ENV}; set +a; npm run worker & npm run serve & npm run demo`);
}

main().catch((e) => { console.error('[near-setup] failed:', e.message); process.exit(1); });
