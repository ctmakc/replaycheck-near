//! ReplayCheck market.
//!
//! Two things live here, both small and both about agents paying agents on NEAR:
//!
//! 1. **Escrow jobs.** A customer posts a replay job with the hash of the task spec and a
//!    deposit (the agent's price). The replay agent accepts, runs the flows in a real
//!    browser, and delivers the hash of the report plus the pass count. Delivery releases
//!    the deposit to the agent. A job that nobody accepts, or that is accepted and then
//!    not delivered before its deadline, is refundable by the customer. Both the task hash
//!    and the report hash are on-chain, so anyone holding the files can verify what was
//!    ordered and what was delivered.
//!
//! 2. **Pay with memo.** Native NEAR transfers carry no memo. `pay(to, memo)` forwards the
//!    attached deposit to `to` and logs a NEP-297 event with payer, receiver, amount and
//!    memo. A service that answers HTTP 402 with `{pay_to, amount, memo}` can verify the
//!    client's payment by reading that event from the transaction outcome. ReplayCheck
//!    buys browser minutes and judgement calls from other agents this way.
//!
//! What goes on chain: account ids, amounts, 64-hex hashes, short memos and an optional
//! report URL. No task contents, no page text, no screenshots.

use near_sdk::json_types::U64;
use near_sdk::store::{IterableMap, Vector};
use near_sdk::{env, log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

const MAX_URL_LEN: usize = 512;
const MAX_MEMO_LEN: usize = 128;
const DEFAULT_TIMEOUT_NS: u64 = 15 * 60 * 1_000_000_000; // 15 minutes
const MAX_TIMEOUT_NS: u64 = 24 * 60 * 60 * 1_000_000_000; // 24 hours
const EVENT_STANDARD: &str = "replaycheck_market";
const EVENT_VERSION: &str = "1.0.0";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Agents,
    Jobs,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobStatus {
    /// Posted and funded, waiting for the agent.
    Open,
    /// The agent is working on it; `deadline_ns` applies.
    Accepted,
    /// Report hash recorded, deposit paid to the agent.
    Delivered,
    /// Deposit returned to the customer.
    Refunded,
}

/// A replay agent that sells runs through this market.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    pub account_id: AccountId,
    /// Where customers POST the task spec after posting the job (https URL).
    pub service_url: String,
    /// Price of one job in yoctoNEAR. `post_job` must attach at least this much.
    pub price: NearToken,
    pub active: bool,
    pub jobs_delivered: u64,
    pub earned: NearToken,
    pub registered_at_ns: u64,
}

/// One paid replay job.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    pub id: u64,
    pub customer: AccountId,
    pub agent: AccountId,
    /// Escrowed amount, paid to the agent on delivery or back to the customer on refund.
    pub deposit: NearToken,
    /// Lowercase hex SHA-256 of the canonical task spec the customer will send the agent.
    pub spec_hash: String,
    pub status: JobStatus,
    pub created_at_ns: u64,
    /// Set on accept: `accepted_at_ns + timeout`. After it, an undelivered job is refundable.
    pub timeout_ns: u64,
    pub accepted_at_ns: Option<u64>,
    pub deadline_ns: Option<u64>,
    pub delivered_at_ns: Option<u64>,
    /// Lowercase hex SHA-256 of the delivered report.json.
    pub report_hash: Option<String>,
    pub report_url: Option<String>,
    pub passed: Option<u32>,
    pub total: Option<u32>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Stats {
    pub agents: u64,
    pub jobs: u64,
    pub delivered: u64,
    pub refunded: u64,
    /// Sum of deposits released to agents.
    pub paid_to_agents: NearToken,
    /// Number of `pay` calls and their total volume.
    pub payments: u64,
    pub payment_volume: NearToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct ReplayMarket {
    owner: AccountId,
    agents: IterableMap<AccountId, Agent>,
    jobs: Vector<Job>,
    delivered: u64,
    refunded: u64,
    paid_to_agents: NearToken,
    payments: u64,
    payment_volume: NearToken,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_url(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_URL_LEN && (s.starts_with("https://") || s.starts_with("http://"))
}

fn event(name: &str, data: String) {
    log!(
        "EVENT_JSON:{{\"standard\":\"{}\",\"version\":\"{}\",\"event\":\"{}\",\"data\":[{}]}}",
        EVENT_STANDARD,
        EVENT_VERSION,
        name,
        data
    );
}

#[near]
impl ReplayMarket {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            agents: IterableMap::new(StorageKey::Agents),
            jobs: Vector::new(StorageKey::Jobs),
            delivered: 0,
            refunded: 0,
            paid_to_agents: NearToken::from_yoctonear(0),
            payments: 0,
            payment_volume: NearToken::from_yoctonear(0),
        }
    }

    // ── agents ─────────────────────────────────────────────────────────────

    /// Register the caller as a replay agent, or update its listing. Open to anyone:
    /// the market does not pick agents, customers do.
    pub fn register_agent(&mut self, service_url: String, price: NearToken) -> Agent {
        require!(valid_url(&service_url), "service_url must be an http(s) URL of at most 512 chars");
        require!(price.as_yoctonear() > 0, "price must be > 0");
        let account_id = env::predecessor_account_id();
        let agent = match self.agents.get(&account_id) {
            Some(prev) => Agent { service_url, price, active: true, ..prev.clone() },
            None => Agent {
                account_id: account_id.clone(),
                service_url,
                price,
                active: true,
                jobs_delivered: 0,
                earned: NearToken::from_yoctonear(0),
                registered_at_ns: env::block_timestamp(),
            },
        };
        self.agents.insert(account_id.clone(), agent.clone());
        event(
            "register_agent",
            format!(
                "{{\"agent\":\"{}\",\"price\":\"{}\",\"service_url\":\"{}\"}}",
                account_id,
                agent.price.as_yoctonear(),
                agent.service_url
            ),
        );
        agent
    }

    /// Pause or resume the caller's listing. Paused agents cannot receive new jobs.
    pub fn set_agent_active(&mut self, active: bool) {
        let account_id = env::predecessor_account_id();
        let mut agent = self.agents.get(&account_id).expect("not a registered agent").clone();
        agent.active = active;
        self.agents.insert(account_id, agent);
    }

    // ── jobs ───────────────────────────────────────────────────────────────

    /// Post a job for `agent`. Attach at least the agent's price; the whole deposit is
    /// escrowed. `timeout_s` bounds how long the agent has after accepting (default 15 min).
    #[payable]
    pub fn post_job(&mut self, agent: AccountId, spec_hash: String, timeout_s: Option<U64>) -> Job {
        let listing = self.agents.get(&agent).expect("unknown agent");
        require!(listing.active, "agent is paused");
        let deposit = env::attached_deposit();
        require!(
            deposit.as_yoctonear() >= listing.price.as_yoctonear(),
            "attached deposit is below the agent's price"
        );
        require!(is_hex64(&spec_hash), "spec_hash must be 64 lowercase hex chars");
        let timeout_ns = match timeout_s {
            Some(s) => s.0.saturating_mul(1_000_000_000),
            None => DEFAULT_TIMEOUT_NS,
        };
        require!(timeout_ns >= 60 * 1_000_000_000 && timeout_ns <= MAX_TIMEOUT_NS, "timeout_s must be 60..86400");

        let job = Job {
            id: self.jobs.len() as u64,
            customer: env::predecessor_account_id(),
            agent: agent.clone(),
            deposit,
            spec_hash,
            status: JobStatus::Open,
            created_at_ns: env::block_timestamp(),
            timeout_ns,
            accepted_at_ns: None,
            deadline_ns: None,
            delivered_at_ns: None,
            report_hash: None,
            report_url: None,
            passed: None,
            total: None,
        };
        self.jobs.push(job.clone());
        event(
            "post_job",
            format!(
                "{{\"job_id\":{},\"customer\":\"{}\",\"agent\":\"{}\",\"deposit\":\"{}\",\"spec_hash\":\"{}\"}}",
                job.id,
                job.customer,
                job.agent,
                job.deposit.as_yoctonear(),
                job.spec_hash
            ),
        );
        job
    }

    /// The listed agent takes the job. Starts the delivery clock.
    pub fn accept_job(&mut self, job_id: u64) -> Job {
        let mut job = self.job(job_id);
        require!(env::predecessor_account_id() == job.agent, "only the listed agent can accept");
        require!(job.status == JobStatus::Open, "job is not open");
        let now = env::block_timestamp();
        job.status = JobStatus::Accepted;
        job.accepted_at_ns = Some(now);
        job.deadline_ns = Some(now.saturating_add(job.timeout_ns));
        self.jobs.replace(job_id as u32, job.clone());
        event(
            "accept_job",
            format!("{{\"job_id\":{},\"agent\":\"{}\",\"deadline_ns\":{}}}", job.id, job.agent, job.deadline_ns.unwrap()),
        );
        job
    }

    /// The agent records the result and gets paid. `report_hash` is SHA-256 of report.json;
    /// `passed`/`total` are the task counts so a customer's pipeline can gate on them without
    /// fetching the report.
    pub fn deliver(
        &mut self,
        job_id: u64,
        report_hash: String,
        passed: u32,
        total: u32,
        report_url: Option<String>,
    ) -> Promise {
        let mut job = self.job(job_id);
        require!(env::predecessor_account_id() == job.agent, "only the listed agent can deliver");
        require!(job.status == JobStatus::Accepted, "job is not accepted");
        require!(is_hex64(&report_hash), "report_hash must be 64 lowercase hex chars");
        require!(total > 0 && passed <= total, "passed must be <= total and total > 0");
        if let Some(u) = &report_url {
            require!(valid_url(u), "report_url must be an http(s) URL of at most 512 chars");
        }
        let now = env::block_timestamp();
        job.status = JobStatus::Delivered;
        job.delivered_at_ns = Some(now);
        job.report_hash = Some(report_hash.clone());
        job.report_url = report_url;
        job.passed = Some(passed);
        job.total = Some(total);
        self.jobs.replace(job_id as u32, job.clone());

        let mut agent = self.agents.get(&job.agent).expect("agent listing vanished").clone();
        agent.jobs_delivered += 1;
        agent.earned = agent.earned.saturating_add(job.deposit);
        self.agents.insert(job.agent.clone(), agent);
        self.delivered += 1;
        self.paid_to_agents = self.paid_to_agents.saturating_add(job.deposit);

        event(
            "deliver",
            format!(
                "{{\"job_id\":{},\"agent\":\"{}\",\"report_hash\":\"{}\",\"passed\":{},\"total\":{},\"paid\":\"{}\"}}",
                job.id,
                job.agent,
                report_hash,
                passed,
                total,
                job.deposit.as_yoctonear()
            ),
        );
        Promise::new(job.agent).transfer(job.deposit)
    }

    /// The customer takes the deposit back: any time while the job is still open, or once
    /// an accepted job has passed its deadline without delivery.
    pub fn refund(&mut self, job_id: u64) -> Promise {
        let mut job = self.job(job_id);
        require!(env::predecessor_account_id() == job.customer, "only the customer can refund");
        match job.status {
            JobStatus::Open => {}
            JobStatus::Accepted => {
                require!(
                    env::block_timestamp() > job.deadline_ns.unwrap_or(u64::MAX),
                    "job is in progress; refund after the deadline"
                );
            }
            _ => env::panic_str("job is already settled"),
        }
        job.status = JobStatus::Refunded;
        self.jobs.replace(job_id as u32, job.clone());
        self.refunded += 1;
        event(
            "refund",
            format!("{{\"job_id\":{},\"customer\":\"{}\",\"amount\":\"{}\"}}", job.id, job.customer, job.deposit.as_yoctonear()),
        );
        Promise::new(job.customer).transfer(job.deposit)
    }

    // ── pay with memo ──────────────────────────────────────────────────────

    /// Forward the attached deposit to `to` and log it with `memo`. This is the receipt a
    /// 402-answering service checks: payer, receiver, amount and memo in one event.
    #[payable]
    pub fn pay(&mut self, to: AccountId, memo: String) -> Promise {
        let amount = env::attached_deposit();
        require!(amount.as_yoctonear() > 0, "attach the amount to pay");
        require!(!memo.is_empty() && memo.len() <= MAX_MEMO_LEN, "memo must be 1-128 chars");
        require!(memo.bytes().all(|b| b.is_ascii_graphic()), "memo must be printable ASCII without spaces");
        let payer = env::predecessor_account_id();
        self.payments += 1;
        self.payment_volume = self.payment_volume.saturating_add(amount);
        event(
            "pay",
            format!(
                "{{\"payer\":\"{}\",\"to\":\"{}\",\"amount\":\"{}\",\"memo\":\"{}\"}}",
                payer,
                to,
                amount.as_yoctonear(),
                memo
            ),
        );
        Promise::new(to).transfer(amount)
    }

    // ── views ──────────────────────────────────────────────────────────────

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn get_agent(&self, account_id: AccountId) -> Option<Agent> {
        self.agents.get(&account_id).cloned()
    }

    pub fn get_agents(&self) -> Vec<Agent> {
        self.agents.values().cloned().collect()
    }

    pub fn get_job(&self, job_id: u64) -> Option<Job> {
        self.jobs.get(job_id as u32).cloned()
    }

    /// Jobs in id order, paginated.
    pub fn get_jobs(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Job> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50).min(200) as usize;
        self.jobs.iter().skip(from).take(limit).cloned().collect()
    }

    /// Newest jobs first.
    pub fn get_recent_jobs(&self, limit: Option<u64>) -> Vec<Job> {
        let limit = limit.unwrap_or(20).min(200) as usize;
        let n = self.jobs.len() as usize;
        (0..n).rev().take(limit).filter_map(|i| self.jobs.get(i as u32).cloned()).collect()
    }

    pub fn jobs_count(&self) -> u64 {
        self.jobs.len() as u64
    }

    pub fn get_stats(&self) -> Stats {
        Stats {
            agents: self.agents.len() as u64,
            jobs: self.jobs.len() as u64,
            delivered: self.delivered,
            refunded: self.refunded,
            paid_to_agents: self.paid_to_agents,
            payments: self.payments,
            payment_volume: self.payment_volume,
        }
    }

    fn job(&self, job_id: u64) -> Job {
        self.jobs.get(job_id as u32).expect("unknown job").clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const H1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const H2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn near(n: u128) -> NearToken {
        NearToken::from_near(n)
    }

    fn ctx(pred: &str, ts_ns: u64, deposit: NearToken) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(acc(pred)).block_timestamp(ts_ns).attached_deposit(deposit);
        testing_env!(b.build());
    }

    fn market_with_agent() -> ReplayMarket {
        ctx("owner.testnet", 1, near(0));
        let mut m = ReplayMarket::new(acc("owner.testnet"));
        ctx("agent.testnet", 2, near(0));
        m.register_agent("https://replay.example/v1".into(), NearToken::from_millinear(500));
        m
    }

    #[test]
    fn full_job_lifecycle_pays_agent() {
        let mut m = market_with_agent();
        ctx("customer.testnet", 10, NearToken::from_millinear(500));
        let job = m.post_job(acc("agent.testnet"), H1.into(), None);
        assert_eq!(job.id, 0);
        assert_eq!(job.status, JobStatus::Open);

        ctx("agent.testnet", 20, near(0));
        let job = m.accept_job(0);
        assert_eq!(job.status, JobStatus::Accepted);
        assert_eq!(job.deadline_ns, Some(20 + DEFAULT_TIMEOUT_NS));

        ctx("agent.testnet", 30, near(0));
        m.deliver(0, H2.into(), 2, 2, Some("https://replay.example/r/0".into()));
        let job = m.get_job(0).unwrap();
        assert_eq!(job.status, JobStatus::Delivered);
        assert_eq!(job.report_hash.as_deref(), Some(H2));
        assert_eq!((job.passed, job.total), (Some(2), Some(2)));

        let agent = m.get_agent(acc("agent.testnet")).unwrap();
        assert_eq!(agent.jobs_delivered, 1);
        assert_eq!(agent.earned, NearToken::from_millinear(500));
        let stats = m.get_stats();
        assert_eq!((stats.jobs, stats.delivered, stats.refunded), (1, 1, 0));
        assert_eq!(stats.paid_to_agents, NearToken::from_millinear(500));
        assert!(get_logs().iter().any(|l| l.contains("\"event\":\"deliver\"")));
    }

    #[test]
    #[should_panic(expected = "below the agent's price")]
    fn rejects_underpaid_job() {
        let mut m = market_with_agent();
        ctx("customer.testnet", 10, NearToken::from_millinear(499));
        m.post_job(acc("agent.testnet"), H1.into(), None);
    }

    #[test]
    #[should_panic(expected = "only the listed agent can accept")]
    fn stranger_cannot_accept() {
        let mut m = market_with_agent();
        ctx("customer.testnet", 10, NearToken::from_millinear(500));
        m.post_job(acc("agent.testnet"), H1.into(), None);
        ctx("mallory.testnet", 11, near(0));
        m.accept_job(0);
    }

    #[test]
    fn customer_refunds_open_job() {
        let mut m = market_with_agent();
        ctx("customer.testnet", 10, NearToken::from_millinear(500));
        m.post_job(acc("agent.testnet"), H1.into(), None);
        ctx("customer.testnet", 11, near(0));
        m.refund(0);
        assert_eq!(m.get_job(0).unwrap().status, JobStatus::Refunded);
        assert_eq!(m.get_stats().refunded, 1);
    }

    #[test]
    #[should_panic(expected = "refund after the deadline")]
    fn refund_blocked_while_in_progress() {
        let mut m = market_with_agent();
        ctx("customer.testnet", 10, NearToken::from_millinear(500));
        m.post_job(acc("agent.testnet"), H1.into(), Some(U64(60)));
        ctx("agent.testnet", 20, near(0));
        m.accept_job(0);
        ctx("customer.testnet", 20 + 30 * 1_000_000_000, near(0));
        m.refund(0);
    }

    #[test]
    fn refund_allowed_after_deadline() {
        let mut m = market_with_agent();
        ctx("customer.testnet", 10, NearToken::from_millinear(500));
        m.post_job(acc("agent.testnet"), H1.into(), Some(U64(60)));
        ctx("agent.testnet", 20, near(0));
        m.accept_job(0);
        ctx("customer.testnet", 20 + 61 * 1_000_000_000, near(0));
        m.refund(0);
        assert_eq!(m.get_job(0).unwrap().status, JobStatus::Refunded);
        ctx("agent.testnet", 20 + 62 * 1_000_000_000, near(0));
        let late = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| m.deliver(0, H2.into(), 1, 1, None)));
        assert!(late.is_err(), "delivery after refund must fail");
    }

    #[test]
    #[should_panic(expected = "agent is paused")]
    fn paused_agent_gets_no_jobs() {
        let mut m = market_with_agent();
        ctx("agent.testnet", 3, near(0));
        m.set_agent_active(false);
        ctx("customer.testnet", 10, NearToken::from_millinear(500));
        m.post_job(acc("agent.testnet"), H1.into(), None);
    }

    #[test]
    fn pay_logs_receipt() {
        let mut m = market_with_agent();
        ctx("buyer.testnet", 10, NearToken::from_millinear(7));
        m.pay(acc("worker.testnet"), "sess-abc123".into());
        let logs = get_logs();
        let l = logs.iter().find(|l| l.contains("\"event\":\"pay\"")).expect("pay event");
        assert!(l.contains("\"payer\":\"buyer.testnet\""));
        assert!(l.contains("\"to\":\"worker.testnet\""));
        assert!(l.contains("\"memo\":\"sess-abc123\""));
        assert!(l.contains(&format!("\"amount\":\"{}\"", NearToken::from_millinear(7).as_yoctonear())));
        let s = m.get_stats();
        assert_eq!(s.payments, 1);
        assert_eq!(s.payment_volume, NearToken::from_millinear(7));
    }

    #[test]
    #[should_panic(expected = "memo must be printable ASCII")]
    fn pay_rejects_memo_with_spaces() {
        let mut m = market_with_agent();
        ctx("buyer.testnet", 10, NearToken::from_millinear(1));
        m.pay(acc("worker.testnet"), "has space".into());
    }

    #[test]
    fn recent_jobs_newest_first() {
        let mut m = market_with_agent();
        for i in 0..3u64 {
            ctx("customer.testnet", 10 + i, NearToken::from_millinear(500));
            m.post_job(acc("agent.testnet"), H1.into(), None);
        }
        let r = m.get_recent_jobs(Some(2));
        assert_eq!(r.iter().map(|j| j.id).collect::<Vec<_>>(), vec![2, 1]);
        assert_eq!(m.get_jobs(Some(1), Some(10)).len(), 2);
        assert_eq!(m.jobs_count(), 3);
    }
}
