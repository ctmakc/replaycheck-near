# ReplayCheck on NEAR

A QA agent that sells browser-replay runs for NEAR and pays its own supplier, another agent, per browser minute. Every state change in a run is a transaction on one small contract.

- **Live:** https://replaycheck-near.mmix.biz (testnet; the button on the page runs a full paid job in front of you, no wallet needed)
- **Contract:** `market.rc-f44644.testnet` · agent `agent.rc-f44644.testnet` · worker `worker.rc-f44644.testnet`
- **Tracks:** `agents` (Agent Economy), `business` (Autonomous Business), `open`
- **Demo video:** `public/demo.mp4` (link in the X post)
- Built for NEAR Hackathon 2026 by INNOVA CONSULT LTD (Ottawa), solo. MIT.

> **Second project, disclosed (Q-015):** the same author submitted [RedactGate audit anchor](https://github.com/ctmakc/redactgate/tree/near-hackathon) (privacy + security tracks). The two share nothing: different repositories, contracts, accounts and code.

## The problem

Small teams ship AI features weekly. A prompt or model change that looks fine in review breaks sign-in or checkout, and they hear about it from users. A QA fleet on a monthly contract is too much for a two-person team; a per-run service is right, but then the usual questions appear: who holds the money until the report exists, how does the customer know the report is for the flows they ordered, and how does the QA service itself pay for the browsers it rents without a human issuing invoices.

## What NEAR enables here

1. **Escrow with the task hash inside.** The customer calls `post_job(agent, spec_hash)` with the fee attached. `spec_hash` is SHA-256 of the task list. The deposit is in the contract, not in either wallet, and the agent can only be paid for exactly those flows.
2. **Delivery is a hash, and it releases the money.** `deliver(job_id, report_hash, passed, total, report_url)` records SHA-256 of `report.json` and the pass count, and transfers the deposit to the agent in the same receipt. A CI pipeline can gate a release on `passed == total` from the chain, without trusting the agent's web page. The customer re-hashes the report they received and compares.
3. **Agents pay agents over HTTP 402 (near402).** The browser worker answers an unpaid request with 402 and an invoice `{pay_to, amount, memo}`. The agent calls `pay(to, memo)` on the same contract with the amount attached; the contract forwards the NEAR and logs a NEP-297 `pay` event. The worker reads that event from the transaction, checks receiver, amount and the single-use memo, and opens the session. The whole pattern is ~150 lines in [`src/near402.js`](src/near402.js), reusable by any service.
4. **Refund the customer can trigger alone.** `refund(job_id)` returns the deposit while a job is still open, or after an accepted job passed its deadline without delivery.
5. **The agent's books are on-chain.** Revenue is every `deliver`, cost is every `pay`; `get_stats` returns both. The live page prints the margin from the chain.

```
customer ──post_job(spec_hash) + 0.05 Ⓝ──▶ market.<owner>.testnet  (escrow)
         ──POST /v1/replay {job_id, tasks}──▶ agent
agent    ──accept_job──▶ market
agent    ──POST /v1/sessions──▶ worker ──402 {pay_to, amount, memo}──▶ agent
agent    ──pay(worker, memo) + 0.002 Ⓝ──▶ market ──transfer + EVENT_JSON pay──▶ worker
agent    ──POST /v1/sessions + x-near-payment/x-near-payer/x-near-memo──▶ worker  (verifies the event, opens Chromium)
agent    drives the browser: open · fill · click · wait · screenshot · get text   (same for /v1/judge: a plain-language check answered by a local LLM)
agent    ──deliver(job_id, sha256(report.json), passed, total, url)──▶ market ──transfer 0.05 Ⓝ──▶ agent
customer fetches report.json, hashes it, compares with get_job(job_id).report_hash
```

## Evidence on testnet (job #2, 2026-11-07)

| Step | Transaction |
| --- | --- |
| Customer `buyer.rc-f44644.testnet` funds job #2 with 0.05 Ⓝ (`post_job`) | [9FghFoNY…U4nj](https://testnet.nearblocks.io/txns/9FghFoNYbXy7rH1iX5FYdqo95ucs1XBuACbLkV4sU4nj) |
| Agent pays the worker for a 2-minute browser (near402, memo `rc-Dd-LIdNi9Nbn`) | [RAuPXNwm…DhX](https://testnet.nearblocks.io/txns/RAuPXNwmTLev8e9YtgaNnr1zSM8hGyAkJ25yhQwdDhX) |
| Second browser session for the regression task | [AJXsighR…W7JA](https://testnet.nearblocks.io/txns/AJXsighRHPsTNpNxbsnn4rDp9qNUEjJqtu2p6tLhW7JA) |
| Agent buys one judgement call (plain-language check) | [CSpTrm1C…TfAy](https://testnet.nearblocks.io/txns/CSpTrm1CDGUL5gqbYMotUF6kw3oy1ysvpBdiJTapTfAy) |
| Agent delivers: report hash `3e28e7aa…5108`, 2/2 passed, escrow released | see `near view market.rc-f44644.testnet get_job '{"job_id": 2}'` |
| Report the hash refers to | https://replaycheck-near.mmix.biz/reports/runs/job-2-2026-11-07T02-46-43/index.html · [report.json](https://replaycheck-near.mmix.biz/reports/runs/job-2-2026-11-07T02-46-43/report.json) |
| Job #1 (earlier run, 1/2 passed: the public test site timed out): accept / deliver | [7Bd2cdVV…SYfy](https://testnet.nearblocks.io/txns/7Bd2cdVVK6Z1eiXma6wznbYbE9RAsxAYueZL4EahSYfy) / [E4hEftit…yQWy](https://testnet.nearblocks.io/txns/E4hEftitVf5GmH4C2RDjSDYwr9cto5SxpEaefgmjyQWy) |
| Job #0 refunded by the customer while still open | [8Xbju87U…RBDx](https://testnet.nearblocks.io/txns/8Xbju87UFH7EQauWKLd7jtXprXmFJEPdxxjAUpN9RBDx) |

```sh
near view market.rc-f44644.testnet get_stats
near view market.rc-f44644.testnet get_recent_jobs '{"limit": 5}'
```

On testnet both agents are operated by us; the point is the mechanism. The worker verifies payments only from the transaction receipt and never sees the agent's key, so a third-party worker would plug in unchanged.

## Try it (judge path, free, ~10 minutes)

Prerequisites: Node 22+, internet access to `rpc.testnet.near.org`. Optional: a Rust toolchain (`rustup`, target `wasm32-unknown-unknown`) to rebuild the contract; the built wasm is committed. Optional: [Ollama](https://ollama.com) with `qwen2.5:7b-instruct` for plain-language checks; without it the `judge` check in `tasks/demo.json` fails and the run reports 1/2, every other step still works.

```sh
git clone https://github.com/ctmakc/replaycheck-near && cd replaycheck-near
npm install
npx playwright install chromium          # Chromium for the worker
npm test                                  # do: run the offline tests — see: 15 passing (hashing, near402 gate, runner against a fake worker)

npm run setup:testnet                     # do: create 5 testnet accounts through the faucet, deploy + init the contract, list the agent
                                          # see: "[near-setup] done. accounts: owner rc-xxxxxx.testnet · market … · agent … · worker … · buyer …"
set -a; . ./.env.near; set +a             # keys for the processes (file mode 0600, git-ignored)

npm run worker                            # terminal 1 — see: "[worker] worker.rc-….testnet selling browser minutes at 0.001 NEAR/min …"
npm run serve                             # terminal 2 — see: "[replaycheck] agent agent.rc-….testnet on NEAR testnet, market market.rc-….testnet …"

npm run demo                              # terminal 3 — the customer orders a run from the agent
# see, in order:
#   [order] agent agent.rc-….testnet charges 0.05 NEAR · spec <sha256>
#   [order] job #0 funded by buyer.rc-….testnet · https://testnet.nearblocks.io/txns/…
#   [order] agent accepted the job, polling http://127.0.0.1:8746/v1/runs/0
#   [order] run state: running … done
#   JSON with tx.post / tx.accept / tx.deliver, passed/total, reportHash {onchain, local, verified: true},
#   upstreamPaidCalls: the near402 payments to the worker with their transactions
# exit code 0 = every flow passed and the report hash matched the chain

node bin/replaycheck.js verify 0 reports/orders/0/report.json     # see: "verified": true
node bin/replaycheck.js refund 0                                   # see: "job is already settled" (delivered jobs cannot be refunded)
open http://127.0.0.1:8746/                                        # the live page against your own contract
```

`tasks/demo.json` replays sign-in on a demo storefront served by the agent itself (`/shop/login`, credentials in the task). `tasks/demo-public-site.json` targets the-internet.herokuapp.com instead.

Worker without a Chromium in Playwright's cache: set `REPLAYCHECK_CHROME=/path/to/chrome`.

## Order a run from the live agent with your own testnet account

```sh
export NEAR_NETWORK=testnet REPLAYCHECK_CONTRACT_ID=market.rc-f44644.testnet
export REPLAYCHECK_CUSTOMER_ID=you.testnet REPLAYCHECK_CUSTOMER_KEY=ed25519:…
node bin/replaycheck.js order tasks/demo.json --agent agent.rc-f44644.testnet --url https://replaycheck-near.mmix.biz/v1
```

The order costs 0.05 testnet NEAR. If the agent is down, `node bin/replaycheck.js refund <job_id>` returns it (immediately while open, after 15 minutes once accepted).

## Contract: `contracts/replay-market` (near-sdk 5, Rust)

| Method | Who | What |
| --- | --- | --- |
| `register_agent(service_url, price)` | any account | list yourself as a replay agent; `set_agent_active(bool)` pauses |
| `post_job(agent, spec_hash, timeout_s?)` payable | customer | escrow ≥ price for a listed, active agent; `spec_hash` = 64 hex |
| `accept_job(job_id)` | the listed agent | Open → Accepted, deadline = now + timeout (default 15 min, 1 min…24 h) |
| `deliver(job_id, report_hash, passed, total, report_url?)` | the listed agent | Accepted → Delivered, transfers the deposit to the agent, updates stats |
| `refund(job_id)` | customer | Open → Refunded any time; Accepted → Refunded after the deadline |
| `pay(to, memo)` payable | anyone | forwards the deposit to `to`, logs `EVENT_JSON {standard:"replaycheck_market", event:"pay", data:[{payer,to,amount,memo}]}` |
| views | — | `get_job`, `get_jobs(from, limit)`, `get_recent_jobs(limit)`, `get_agent`, `get_agents`, `get_stats`, `jobs_count` |

All state changes emit NEP-297 events (`register_agent`, `post_job`, `accept_job`, `deliver`, `refund`, `pay`). Nothing private goes on-chain: account ids, amounts, hashes, a memo and an optional URL.

```sh
npm run contract:test     # 10 unit tests: lifecycle, underpayment, stranger accept, refund timing, paused agent, pay receipt, memo validation
npm run contract:build    # → contracts/replay-market/res/replay_market.wasm (RUSTFLAGS -C target-cpu=mvp, ~230 KB)
```

## near402 in one screen

Service side (`PayGate` in `src/near402.js`): `invoice(amount)` → `{near402:1, network, contract, pay_to, amount, memo, expires_at}`; `gate(req, res, amount)` reads `x-near-payment`, `x-near-payer`, `x-near-memo`, loads the transaction with receipts, finds the `pay` event with that memo, checks `to` and `amount`, marks the memo spent. Memos are random, 10-minute, single-use.

Client side: `paidFetch(account, url, init)` sends the request, and on 402 checks the invoice is for its network and contract, applies the per-call and per-process caps (`REPLAYCHECK_MAX_CALL_YOCTO`, `REPLAYCHECK_MAX_RUN_YOCTO`), pays through `pay`, retries with the headers, and records a receipt. A 5xx after payment is never retried automatically.

## What was built in the hackathon window (Q-002, Q-003, Q-005)

- Baseline before 2026-11-01: the ReplayCheck replay engine from an earlier Celo hackathon entry (`runner.js`, `report.js` skeleton, the task format), tagged **`pre-hackathon`** in this repository. All Celo and x402 code was removed.
- Built from 2026-11-07 for NEAR Hackathon (diff: [`pre-hackathon...main`](https://github.com/ctmakc/replaycheck-near/compare/pre-hackathon...main)): the market contract with tests, near402 client and gate, the browser worker agent, the agent service (on-chain job verification, async runs, status endpoint), the CLI (`order`, `verify`, `refund`, `whoami`), the testnet setup script, the live page with the job board, the demo storefront, the Node test suite.
- Libraries: `near-api-js` 7, `playwright`, `near-sdk` 5. Fonts from Google Fonts. No templates.
- AI assistance: the code and this README were written with Claude Code by the author's direction; everything was run end to end on testnet before being committed.

## Layout

```
contracts/replay-market/   NEAR contract (Rust) + unit tests + res/replay_market.wasm
src/near.js                accounts, views, calls, event parsing, spec/report hashing, verifyPayment
src/near402.js             HTTP 402 on NEAR: paidFetch (client) and PayGate (service)
src/browser.js             a session rented from the worker over near402
src/judge.js               a plain-language check bought from the worker
src/runner.js              replays one task, collects screenshots and checks
src/report.js              report.json (hashed on-chain) + HTML with every payment
src/server.js              the agent as a paid service: /v1/replay (202 + /v1/runs/:id), /v1/agent, /v1/jobs, /demo/run, live page
worker/server.js           the browser worker agent: sessions and judgements for NEAR
bin/replaycheck.js         order · run · verify · refund · whoami
scripts/near-setup.mjs     faucet accounts, deploy, list the agent, write .env.near
public/                    live page, demo storefront (/shop), logo
tasks/                     demo.json (storefront), demo-public-site.json
test/                      offline tests (node --test)
```

## Limits and honesty

- Testnet only. The contract has no mainnet deployment yet; the design has no testnet-only dependency.
- Both agents in the demo are ours. The worker trusts only the on-chain `pay` event, so any account can run one.
- Prices are illustrative (0.05 Ⓝ per job, 0.001 Ⓝ per browser minute, 0.002 Ⓝ per judgement).
- The judgement model runs locally (Ollama); it is a supplier like the browser, paid the same way.
- The contract does not arbitrate disputes about report quality; it arbitrates delivery and time. Reputation (jobs delivered, refunds) is readable per agent and is the hook for that.

## License

MIT. Copyright (c) 2026 INNOVA CONSULT LTD.
