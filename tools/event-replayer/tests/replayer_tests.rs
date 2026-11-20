use chrono::Utc;
use event_replayer::{load_dataset_from_file, replay_events, ReplayDataset, ReplayEvent};
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
