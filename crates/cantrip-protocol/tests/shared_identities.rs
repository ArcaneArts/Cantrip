use anyhow::Result;
use cantrip_protocol::{Value, history};
use std::{path::Path, process::Command};

#[test]
fn history_keys_and_event_ids_match_existing_node_implementations() -> Result<()> {
    let output = Command::new("node")
        .args([
            "--import",
            "tsx",
            "scripts/server-rust/shared-history-identities.mjs",
        ])
        .current_dir(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(2)
                .unwrap(),
        )
        .output()?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Value = serde_json::from_slice(&output.stdout)?;
    for case in cases.as_array().unwrap() {
        assert_eq!(
            history::event_id(
                case["chat"].as_str().unwrap(),
                case["key"].as_str().unwrap()
            ),
            case["eventId"].as_str().unwrap()
        );
        assert_eq!(
            history::item_key(&case["chat"], &case["identity"]),
            case["itemKey"].as_str().unwrap()
        );
    }
    Ok(())
}

#[test]
fn shared_response_errors_retain_their_downcastable_classification() {
    use cantrip_protocol::{ValidationError, response, worker_link};
    let error =
        response::parse_response("remoteSurfaceFrameHeaderSchema", Some(&Value::Null)).unwrap_err();
    assert!(error.is::<response::ResponseValidationError>());
    let wrapped: worker_link::Error = error.into();
    let worker_link::Error::Failure(inner) = &wrapped else {
        panic!("expected response failure")
    };
    assert!(inner.is::<response::ResponseValidationError>());
    assert_eq!(wrapped.to_string(), inner.to_string());
    let operation = response::response_error(ValidationError::Operation);
    assert!(!operation.is::<response::ResponseValidationError>());
    assert_eq!(
        operation.to_string(),
        "Settings response validation failed."
    );
}
