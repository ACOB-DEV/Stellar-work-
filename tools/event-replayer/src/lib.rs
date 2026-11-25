use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReplayEvent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ledger: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tx_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_index: Option<u32>,
    pub timestamp: DateTime<Utc>,
    pub event_type: String,
    pub contract_id: String,
    pub topic: Vec<String>,
    pub data: serde_json::Value,
}

impl ReplayEvent {
    /// Generates a stable identity key to detect and reject/deduplicate repeated events.
    pub fn identity_key(&self) -> String {
        if let Some(ref id) = self.id {
            if !id.trim().is_empty() {
                return id.clone();
            }
        }
        if self.ledger.is_some() || self.tx_hash.is_some() || self.event_index.is_some() {
            return format!(
                "{}:{}:{}:{}",
                self.contract_id,
                self.ledger.unwrap_or(0),
                self.tx_hash.as_deref().unwrap_or(""),
                self.event_index.unwrap_or(0)
            );
        }
        format!(
            "{}:{}:{}:{:?}:{}",
            self.contract_id,
            self.timestamp.timestamp_millis(),
            self.event_type,
            self.topic,
            self.data
        )
    }

    /// Extracts token identifier from event data (e.g. "USDC", "XLM", or "native").
    pub fn token_asset(&self) -> String {
        self.data
            .get("token")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("native")
            .to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReplayDataset {
    pub contract_id: String,
    pub network: String,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    pub events: Vec<ReplayEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReplayReport {
    pub dataset: ReplayDataset,
    pub events_processed: usize,
    pub state_transitions: Vec<String>,
    pub final_balances: HashMap<String, String>,
    pub summary: String,
}

#[derive(Debug, Clone, Default)]
struct TokenAccount {
    contract_balance: i128,
    escrow_liabilities: i128,
    platform_fees: i128,
}

pub fn load_dataset_from_file<P: AsRef<Path>>(path: P) -> Result<ReplayDataset> {
    let data = fs::read_to_string(path).context("Failed to read dataset file")?;
    let dataset: ReplayDataset = serde_json::from_str(&data).context("Failed to parse dataset JSON")?;
    Ok(dataset)
}

/// Parses a nonnegative i128 amount from integer or decimal string without fallback defaults.
fn parse_amount(val: Option<&serde_json::Value>, field_name: &str, event_index: usize) -> Result<i128> {
    let v = val.ok_or_else(|| {
        anyhow::anyhow!(
            "Missing required financial field '{}' at event index {}",
            field_name,
            event_index
        )
    })?;

    let amount = match v {
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i as i128
            } else if let Some(u) = n.as_u64() {
                i128::from(u)
            } else {
                n.to_string().parse::<i128>().map_err(|e| {
                    anyhow::anyhow!(
                        "Field '{}' at index {} is not a valid i128 integer: {}",
                        field_name,
                        event_index,
                        e
                    )
                })?
            }
        }
        serde_json::Value::String(s) => {
            s.trim().parse::<i128>().map_err(|e| {
                anyhow::anyhow!(
                    "Failed to parse i128 decimal string for '{}' at index {}: {}",
                    field_name,
                    event_index,
                    e
                )
            })?
        }
        _ => {
            bail!(
                "Field '{}' at index {} must be an integer or decimal string, found {:?}",
                field_name,
                event_index,
                v
            );
        }
    };

    if amount < 0 {
        bail!(
            "Field '{}' cannot be negative at index {}: {}",
            field_name,
            event_index,
            amount
        );
    }

    Ok(amount)
}

pub fn replay_events(dataset: &ReplayDataset) -> Result<ReplayReport> {
    let mut state_transitions = Vec::new();

    // Balances maintained independently per payment token asset (BUG-85)
    let mut accounts_by_token: HashMap<String, TokenAccount> = HashMap::new();
    // Balance accounts:
    // contract_balance: actual token cash held in the contract.
    // escrow_liabilities: funds locked in pending/active jobs.
    // platform_fees: retained platform fees awaiting withdrawal.
    let mut contract_balance: i128 = 0;
    let mut escrow_liabilities: i128 = 0;
    let mut platform_fees: i128 = 0;

    // Stable event identity tracking for deduplication & conflict detection.
    let mut seen_events: HashMap<String, (String, serde_json::Value)> = HashMap::new();
    let mut processed_count = 0;

    for (index, event) in dataset.events.iter().enumerate() {
        if event.event_type.trim().is_empty() {
            bail!("Event at index {} has an empty event_type", index);
        }

        let key = event.identity_key();
        if let Some((prev_type, prev_data)) = seen_events.get(&key) {
            if prev_type != &event.event_type || prev_data != &event.data {
                bail!(
                    "Duplicate event identity '{}' with conflicting payload at index {}",
                    key,
                    index
                );
            }
            // Skip repeated identical event from overlapping fetch windows
            // Exact duplicate event (e.g. from overlapping RPC windows or concatenated logs):
            // Skip repeated accounting to prevent duplicate ledger replay.
            continue;
        }
        seen_events.insert(key, (event.event_type.clone(), event.data.clone()));
        processed_count += 1;

        state_transitions.push(format!(
            "{}: {}",
            event.timestamp.format("%Y-%m-%d %H:%M:%S"),
            event.event_type
        ));

        let token = event.token_asset();
        let account = accounts_by_token.entry(token.clone()).or_default();

        match event.event_type.as_str() {
            "job_posted" | "job_created" => {
                let amount = parse_amount(event.data.get("amount"), "amount", index)?;
                account.contract_balance = account
                    .contract_balance
                    .checked_add(amount)
                    .context("Arithmetic overflow in contract_balance during job posting")?;
                account.escrow_liabilities = account
                    .escrow_liabilities
                contract_balance = contract_balance
                    .checked_add(amount)
                    .context("Arithmetic overflow in contract_balance during job posting")?;
                escrow_liabilities = escrow_liabilities
                    .checked_add(amount)
                    .context("Arithmetic overflow in escrow_liabilities during job posting")?;
            }
            "job_approved" => {
                let payout = parse_amount(event.data.get("payout"), "payout", index)?;
                let fee = parse_amount(event.data.get("fee"), "fee", index)?;
                let total = payout
                    .checked_add(fee)
                    .context("Arithmetic overflow in payout + fee during job approval")?;

                if account.escrow_liabilities < total {
                    bail!(
                        "Insufficient escrow liabilities ({}) for token '{}' approval payout + fee ({}) at index {}",
                        account.escrow_liabilities,
                        token,
                if escrow_liabilities < total {
                    bail!(
                        "Insufficient escrow liabilities ({}) for approval payout + fee ({}) at index {}",
                        escrow_liabilities,
                        total,
                        index
                    );
                }
                if account.contract_balance < payout {
                    bail!(
                        "Insufficient contract cash ({}) for token '{}' payout ({}) at index {}",
                        account.contract_balance,
                        token,
                if contract_balance < payout {
                    bail!(
                        "Insufficient contract cash ({}) for payout ({}) at index {}",
                        contract_balance,
                        payout,
                        index
                    );
                }

                account.escrow_liabilities = account
                    .escrow_liabilities
                    .checked_sub(total)
                    .context("Underflow in escrow_liabilities")?;
                // Cash movement: actual token payout leaves contract; fee remains retained until withdrawn.
                account.contract_balance = account
                    .contract_balance
                    .checked_sub(payout)
                    .context("Underflow in contract_balance")?;
                account.platform_fees = account
                    .platform_fees
                escrow_liabilities = escrow_liabilities
                    .checked_sub(total)
                    .context("Underflow in escrow_liabilities")?;
                // Cash movement: actual token payout leaves contract; fee remains retained until withdrawn.
                contract_balance = contract_balance
                    .checked_sub(payout)
                    .context("Underflow in contract_balance")?;
                platform_fees = platform_fees
                    .checked_add(fee)
                    .context("Overflow in platform_fees")?;
            }
            "fees_withdrawn" => {
                let withdrawn = parse_amount(event.data.get("amount"), "amount", index)?;
                if account.platform_fees < withdrawn {
                    bail!(
                        "Insufficient platform fees ({}) for token '{}' to withdraw ({}) at index {}",
                        account.platform_fees,
                        token,
                if platform_fees < withdrawn {
                    bail!(
                        "Insufficient platform fees ({}) to withdraw ({}) at index {}",
                        platform_fees,
                        withdrawn,
                        index
                    );
                }
                if account.contract_balance < withdrawn {
                    bail!(
                        "Insufficient contract cash ({}) for token '{}' to withdraw fees ({}) at index {}",
                        account.contract_balance,
                        token,
                if contract_balance < withdrawn {
                    bail!(
                        "Insufficient contract cash ({}) to withdraw fees ({}) at index {}",
                        contract_balance,
                        withdrawn,
                        index
                    );
                }

                account.platform_fees = account
                    .platform_fees
                    .checked_sub(withdrawn)
                    .context("Underflow in platform_fees")?;
                account.contract_balance = account
                    .contract_balance
                platform_fees = platform_fees
                    .checked_sub(withdrawn)
                    .context("Underflow in platform_fees")?;
                contract_balance = contract_balance
                    .checked_sub(withdrawn)
                    .context("Underflow in contract_balance")?;
            }
            "job_cancelled" => {
                let refund = parse_amount(event.data.get("refund"), "refund", index)?;
                if account.escrow_liabilities < refund {
                    bail!(
                        "Insufficient escrow liabilities ({}) for token '{}' refund ({}) at index {}",
                        account.escrow_liabilities,
                        token,
                if escrow_liabilities < refund {
                    bail!(
                        "Insufficient escrow liabilities ({}) for refund ({}) at index {}",
                        escrow_liabilities,
                        refund,
                        index
                    );
                }
                if account.contract_balance < refund {
                    bail!(
                        "Insufficient contract cash ({}) for token '{}' refund ({}) at index {}",
                        account.contract_balance,
                        token,
                if contract_balance < refund {
                    bail!(
                        "Insufficient contract cash ({}) for refund ({}) at index {}",
                        contract_balance,
                        refund,
                        index
                    );
                }

                account.escrow_liabilities = account
                    .escrow_liabilities
                    .checked_sub(refund)
                    .context("Underflow in escrow_liabilities")?;
                account.contract_balance = account
                    .contract_balance
                escrow_liabilities = escrow_liabilities
                    .checked_sub(refund)
                    .context("Underflow in escrow_liabilities")?;
                contract_balance = contract_balance
                    .checked_sub(refund)
                    .context("Underflow in contract_balance")?;
            }
            "dispute_resolved" => {
                let client_share = parse_amount(event.data.get("client_amount"), "client_amount", index)?;
                let freelancer_share =
                    parse_amount(event.data.get("freelancer_amount"), "freelancer_amount", index)?;
                let total = client_share
                    .checked_add(freelancer_share)
                    .context("Arithmetic overflow in dispute amounts")?;

                if account.escrow_liabilities < total {
                    bail!(
                        "Insufficient escrow liabilities ({}) for token '{}' dispute resolution ({}) at index {}",
                        account.escrow_liabilities,
                        token,
                if escrow_liabilities < total {
                    bail!(
                        "Insufficient escrow liabilities ({}) for dispute resolution ({}) at index {}",
                        escrow_liabilities,
                        total,
                        index
                    );
                }
                if account.contract_balance < total {
                    bail!(
                        "Insufficient contract cash ({}) for token '{}' dispute resolution ({}) at index {}",
                        account.contract_balance,
                        token,
                if contract_balance < total {
                    bail!(
                        "Insufficient contract cash ({}) for dispute resolution ({}) at index {}",
                        contract_balance,
                        total,
                        index
                    );
                }

                account.escrow_liabilities = account
                    .escrow_liabilities
                    .checked_sub(total)
                    .context("Underflow in escrow_liabilities")?;
                account.contract_balance = account
                    .contract_balance
                escrow_liabilities = escrow_liabilities
                    .checked_sub(total)
                    .context("Underflow in escrow_liabilities")?;
                contract_balance = contract_balance
                    .checked_sub(total)
                    .context("Underflow in contract_balance")?;
            }
            "job_accepted"
            | "work_submitted"
            | "job_submitted"
            | "job_rejected"
            | "deadline_enforced"
            | "job_disputed"
            | "admin_transferred"
            | "fee_updated"
            | "max_active_jobs_updated" => {
                // Known lifecycle events with non-balance state transitions
            }
            unknown => {
                bail!(
                    "Unknown or malformed event type: '{}' at index {}",
                    unknown,
                    index
                );
            }
        }

        // Invariant assertion per token
        let total_accounted = account
            .escrow_liabilities
            .checked_add(account.platform_fees)
            .context("Overflow checking balance conservation")?;
        if account.contract_balance != total_accounted {
            bail!(
                "Conservation invariant violated for token '{}' at event index {}: contract_balance ({}) != escrow ({}) + fees ({})",
                token,
                index,
                account.contract_balance,
                account.escrow_liabilities,
                account.platform_fees
            );
        }

        if account.contract_balance < 0 || account.escrow_liabilities < 0 || account.platform_fees < 0 {
            bail!(
                "Negative balance detected for token '{}' at event index {}: contract={}, escrow={}, fees={}",
                token,
                index,
                account.contract_balance,
                account.escrow_liabilities,
                account.platform_fees
        // Invariant assertion: actual contract token cash must always equal escrow liabilities plus retained fees.
        let total_accounted = escrow_liabilities
            .checked_add(platform_fees)
            .context("Overflow checking balance conservation")?;
        if contract_balance != total_accounted {
            bail!(
                "Conservation invariant violated at event index {}: contract_balance ({}) != escrow ({}) + fees ({})",
                index,
                contract_balance,
                escrow_liabilities,
                platform_fees
            );
        }

        if contract_balance < 0 || escrow_liabilities < 0 || platform_fees < 0 {
            bail!(
                "Negative balance detected at event index {}: contract={}, escrow={}, fees={}",
                index,
                contract_balance,
                escrow_liabilities,
                platform_fees
            );
        }
    }

    let mut final_balances = HashMap::new();
    for (token, acct) in &accounts_by_token {
        final_balances.insert(format!("{}:contract_balance", token), acct.contract_balance.to_string());
        final_balances.insert(format!("{}:escrow_liabilities", token), acct.escrow_liabilities.to_string());
        final_balances.insert(format!("{}:platform_fees", token), acct.platform_fees.to_string());

        // For single-token or "native" datasets, also expose unprefixed balance keys
        if token == "native" || accounts_by_token.len() == 1 {
            final_balances.insert("contract_balance".to_string(), acct.contract_balance.to_string());
            final_balances.insert("escrow_liabilities".to_string(), acct.escrow_liabilities.to_string());
            final_balances.insert("platform_fees".to_string(), acct.platform_fees.to_string());
        }
    }
    final_balances.insert("contract_balance".to_string(), contract_balance.to_string());
    final_balances.insert("escrow_liabilities".to_string(), escrow_liabilities.to_string());
    final_balances.insert("platform_fees".to_string(), platform_fees.to_string());

    let report = ReplayReport {
        dataset: dataset.clone(),
        events_processed: processed_count,
        state_transitions,
        final_balances,
        summary: format!(
            "Processed {} events from {} to {}",
            processed_count,
            dataset.start_time.format("%Y-%m-%d"),
            dataset.end_time.format("%Y-%m-%d")
        ),
    };

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_two_distinct_tokens_reported_separately() {
        let now = Utc::now();
        let dataset = ReplayDataset {
            contract_id: "test".to_string(),
            network: "testnet".to_string(),
            start_time: now,
            end_time: now,
            events: vec![
                ReplayEvent {
                    id: Some("tx-xlm-1".to_string()),
                    ledger: Some(1),
                    tx_hash: Some("0x1".to_string()),
                    event_index: Some(1),
                    timestamp: now,
                    event_type: "job_posted".to_string(),
                    contract_id: "test".to_string(),
                    topic: vec!["job_posted".to_string()],
                    data: serde_json::json!({ "job_id": 1, "amount": 10000000, "token": "XLM" }),
                },
                ReplayEvent {
                    id: Some("tx-usdc-1".to_string()),
                    ledger: Some(2),
                    tx_hash: Some("0x2".to_string()),
                    event_index: Some(1),
                    timestamp: now,
                    event_type: "job_posted".to_string(),
                    contract_id: "test".to_string(),
                    topic: vec!["job_posted".to_string()],
                    data: serde_json::json!({ "job_id": 2, "amount": 500000, "token": "USDC" }),
                },
            ],
        };

        let report = replay_events(&dataset).expect("Two token replay should succeed");
        assert_eq!(report.final_balances.get("XLM:contract_balance").map(|s| s.as_str()), Some("10000000"));
        assert_eq!(report.final_balances.get("USDC:contract_balance").map(|s| s.as_str()), Some("500000"));
    }
use chrono::Utc;
use super::*;
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

#[test]
fn test_offline_replay_valid_job_lifecycle() {
    let fixture_path = fixtures_dir().join("valid-job-lifecycle.json");
    let dataset = load_dataset_from_file(&fixture_path).expect("Fixture should load");

    assert_eq!(dataset.events.len(), 4);
    assert_eq!(dataset.events[0].event_type, "job_created");
    assert_eq!(dataset.events[1].event_type, "job_accepted");
    assert_eq!(dataset.events[2].event_type, "job_submitted");
    assert_eq!(dataset.events[3].event_type, "job_approved");

    let report = replay_events(&dataset).expect("Replay should succeed");
    assert_eq!(report.events_processed, 4);
    assert_eq!(report.state_transitions.len(), 4);

    // Initial deposit: 2,500,000,000
    // Approved payout: 2,425,000,000 (leaves contract), fee: 75,000,000 (retained in contract)
    // Resulting contract cash balance: 75,000,000, retained platform fees: 75,000,000, escrow liabilities: 0
    assert_eq!(
        report.final_balances.get("contract_balance").map(|s| s.as_str()),
        Some("75000000")
    );
    assert_eq!(
        report.final_balances.get("platform_fees").map(|s| s.as_str()),
        Some("75000000")
    );
    assert_eq!(
        report.final_balances.get("escrow_liabilities").map(|s| s.as_str()),
        Some("0")
    );
}

#[test]
fn test_offline_replay_fee_withdrawal_conserves_cash() {
    let fixture_path = fixtures_dir().join("valid-job-lifecycle.json");
    let mut dataset = load_dataset_from_file(&fixture_path).expect("Fixture should load");

    dataset.events.push(ReplayEvent {
        id: Some("tx-fee-withdrawal-1".to_string()),
        ledger: Some(105),
        tx_hash: Some("0xabc123".to_string()),
        event_index: Some(1),
        timestamp: Utc::now(),
        event_type: "fees_withdrawn".to_string(),
        contract_id: dataset.contract_id.clone(),
        topic: vec!["fees_withdrawn".to_string()],
        data: serde_json::json!({ "amount": 75000000 }),
    });

    let report = replay_events(&dataset).expect("Replay with fee withdrawal should succeed");
    assert_eq!(report.events_processed, 5);

    // After withdrawing retained fees, contract cash and platform fees are both 0.
    assert_eq!(
        report.final_balances.get("contract_balance").map(|s| s.as_str()),
        Some("0")
    );
    assert_eq!(
        report.final_balances.get("platform_fees").map(|s| s.as_str()),
        Some("0")
    );
    assert_eq!(
        report.final_balances.get("escrow_liabilities").map(|s| s.as_str()),
        Some("0")
    );
}

#[test]
fn test_offline_replay_dispute_resolution() {
    let fixture_path = fixtures_dir().join("disputed-job.json");
    let dataset = load_dataset_from_file(&fixture_path).expect("Fixture should load");

    assert_eq!(dataset.events.len(), 4);
    let report = replay_events(&dataset).expect("Replay should succeed");
    assert_eq!(report.events_processed, 4);

    // Initial deposit: 1,000,000,000
    // Split resolution: client 500,000,000 + freelancer 500,000,000 = 1,000,000,000 returned
    // Final contract balance: 0
    assert_eq!(
        report.final_balances.get("contract_balance").map(|s| s.as_str()),
        Some("0")
    );
    assert_eq!(
        report.final_balances.get("escrow_liabilities").map(|s| s.as_str()),
        Some("0")
    );
}

#[test]
fn test_offline_replay_malformed_event_fails_loudly() {
    let fixture_path = fixtures_dir().join("malformed-event.json");
    let dataset = load_dataset_from_file(&fixture_path).expect("Fixture should load");

    let result = replay_events(&dataset);
    assert!(result.is_err(), "Unknown event type must fail loudly instead of being skipped");
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("Unknown or malformed event type"),
        "Error message should mention unknown or malformed event type, got: {}",
        err_msg
    );
    assert!(err_msg.contains("completely_unknown_event_type"));
}

#[test]
fn test_deduplication_of_repeated_ledger_events() {
    let fixture_path = fixtures_dir().join("valid-job-lifecycle.json");
    let mut dataset = load_dataset_from_file(&fixture_path).expect("Fixture should load");

    // Duplicate the initial job_created event
    let duplicated_event = dataset.events[0].clone();
    dataset.events.insert(1, duplicated_event);

    assert_eq!(dataset.events.len(), 5);
    let report = replay_events(&dataset).expect("Duplicate identical event should be deduplicated");
    // Only 4 distinct events should have been processed
    assert_eq!(report.events_processed, 4);
    assert_eq!(
        report.final_balances.get("contract_balance").map(|s| s.as_str()),
        Some("75000000")
    );
}

#[test]
fn test_duplicate_event_with_conflicting_payload_fails() {
    let fixture_path = fixtures_dir().join("valid-job-lifecycle.json");
    let mut dataset = load_dataset_from_file(&fixture_path).expect("Fixture should load");

    // Add an event with same identity ID but different payload
    let mut conflict_event = dataset.events[0].clone();
    conflict_event.id = Some("event-id-1".to_string());
    dataset.events[0].id = Some("event-id-1".to_string());
    conflict_event.data = serde_json::json!({ "amount": 999999 });
    dataset.events.insert(1, conflict_event);

    let result = replay_events(&dataset);
    assert!(result.is_err(), "Conflicting duplicate payload must fail");
    let err_msg = result.unwrap_err().to_string();
    assert!(err_msg.contains("conflicting payload"));
}

#[test]
fn test_missing_amount_field_fails() {
    let dataset = ReplayDataset {
        contract_id: "test".to_string(),
        network: "testnet".to_string(),
        start_time: Utc::now(),
        end_time: Utc::now(),
        events: vec![ReplayEvent {
            id: None,
            ledger: None,
            tx_hash: None,
            event_index: None,
            timestamp: Utc::now(),
            event_type: "job_posted".to_string(),
            contract_id: "test".to_string(),
            topic: vec!["job_posted".to_string()],
            data: serde_json::json!({}), // Missing "amount"
        }],
    };

    let result = replay_events(&dataset);
    assert!(result.is_err(), "Missing amount field must fail without using invented defaults");
    let err = result.unwrap_err().to_string();
    assert!(err.contains("Missing required financial field 'amount'"));
}

#[test]
fn test_i128_decimal_string_support() {
    let large_i128 = "170141183460469231731687303715884105727"; // 2^127 - 1
    let dataset = ReplayDataset {
        contract_id: "test".to_string(),
        network: "testnet".to_string(),
        start_time: Utc::now(),
        end_time: Utc::now(),
        events: vec![ReplayEvent {
            id: None,
            ledger: None,
            tx_hash: None,
            event_index: None,
            timestamp: Utc::now(),
            event_type: "job_posted".to_string(),
            contract_id: "test".to_string(),
            topic: vec!["job_posted".to_string()],
            data: serde_json::json!({ "amount": large_i128 }),
        }],
    };

    let report = replay_events(&dataset).expect("Full i128 decimal string amount should parse correctly");
    assert_eq!(
        report.final_balances.get("contract_balance").map(|s| s.as_str()),
        Some(large_i128)
    );
}

#[test]
fn test_negative_amount_fails() {
    let dataset = ReplayDataset {
        contract_id: "test".to_string(),
        network: "testnet".to_string(),
        start_time: Utc::now(),
        end_time: Utc::now(),
        events: vec![ReplayEvent {
            id: None,
            ledger: None,
            tx_hash: None,
            event_index: None,
            timestamp: Utc::now(),
            event_type: "job_posted".to_string(),
            contract_id: "test".to_string(),
            topic: vec!["job_posted".to_string()],
            data: serde_json::json!({ "amount": -500 }),
        }],
    };

    let result = replay_events(&dataset);
    assert!(result.is_err(), "Negative amount must fail");
    let err = result.unwrap_err().to_string();
    assert!(err.contains("cannot be negative"));
}

#[test]
fn test_excess_fee_withdrawal_fails_negative_balance() {
    let fixture_path = fixtures_dir().join("valid-job-lifecycle.json");
    let mut dataset = load_dataset_from_file(&fixture_path).expect("Fixture should load");

    // Try to withdraw more fees than retained (retained is 75,000,000)
    dataset.events.push(ReplayEvent {
        id: Some("tx-overdraw".to_string()),
        ledger: Some(105),
        tx_hash: Some("0xoverdraw".to_string()),
        event_index: Some(1),
        timestamp: Utc::now(),
        event_type: "fees_withdrawn".to_string(),
        contract_id: dataset.contract_id.clone(),
        topic: vec!["fees_withdrawn".to_string()],
        data: serde_json::json!({ "amount": 80000000 }),
    });

    let result = replay_events(&dataset);
    assert!(result.is_err(), "Withdrawing excess fees must fail");
    let err = result.unwrap_err().to_string();
    assert!(err.contains("Insufficient platform fees"));
}

}
