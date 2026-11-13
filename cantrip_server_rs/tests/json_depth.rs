use cantrip_server::{native_history::payload_digest, wire::Value};
use sha2::{Digest, Sha256};

#[test]
fn deep_json_lifetimes_and_serialization_use_bounded_call_stacks() {
    std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(|| {
            // More nesting than an entire default Live frame can carry. Neither
            // dropping a rejected field nor cloning for validation may abort.
            for raw in [
                format!("{}0{}", "[".repeat(32768), "]".repeat(32768)),
                format!("{}null{}", "{\"x\":[".repeat(12000), "]}".repeat(12000)),
            ] {
                let value: Value = serde_json::from_str(&raw).unwrap();
                let cloned = value.clone();
                assert_eq!(value, cloned);
                assert_eq!(value.stringify(), raw);
                assert_eq!(serde_json::to_string(&cloned).unwrap(), raw);
                assert_eq!(format!("{value:?}"), raw);
                drop(value);
                drop(cloned);
                let truncated = &raw[..raw.len() - 1];
                assert!(serde_json::from_str::<Value>(truncated).is_err());
            }
        })
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn replacing_duplicate_deep_values_also_drops_iteratively() {
    let raw = format!(
        "{{\"x\":{}0{},\"x\":\"\\ud800\",\"2\":1e999,\"1\":-0}}",
        "[".repeat(16384),
        "]".repeat(16384),
    );
    let value: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value.stringify(), "{\"1\":0,\"2\":null,\"x\":\"\\ud800\"}");
    assert_eq!(value["x"].as_js_string().unwrap().units(), &[0xd800]);
    assert!(value["2"].as_f64().unwrap().is_infinite());
    assert!(value["1"].as_f64().unwrap().is_sign_negative());
}

#[test]
fn canonical_history_digest_preserves_reference_json_bytes() {
    // Recorded with the Node reference's nativeHistoryPayloadDigest.
    let cases = [
        (
            r#"{"z":-0,"a":{"10":"ten","2":"two","\ud800":"\udfff","😀":5e-324,"\ue000":1e+21},"array":[1e-7,null,{"b":true,"a":1e999}]}"#,
            "53e7a5bd47660298876379976a4daa97097ebe2fb603b5971729c2e1fb4c1f03",
        ),
        (
            r#"{"array":[1e-7,null,{"a":1e999,"b":true}],"a":{"\ue000":1e+21,"😀":5e-324,"\ud800":"\udfff","2":"two","10":"ten"},"z":-0}"#,
            "53e7a5bd47660298876379976a4daa97097ebe2fb603b5971729c2e1fb4c1f03",
        ),
        (
            r#"{"z":-0,"a":{"10":"ten","2":"two","\ud800":"\udfff","😀":5e-324,"\ue000":1e+21},"array":[null,1e-7,{"b":true,"a":1e999}]}"#,
            "adfceba04ed242ad0f0521018c84731cc08a14cf9fe637bc079d79d52467a2d0",
        ),
    ];
    for (raw, expected) in cases {
        let value: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(payload_digest(&value), expected);
    }
}

#[test]
fn canonical_history_digest_uses_bounded_call_stack() {
    std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(|| {
            let depth = 12_000;
            let raw = format!(
                "{}0{}",
                r#"{"2":1,"10":["#.repeat(depth),
                "]}".repeat(depth)
            );
            let canonical = format!(
                "{}0{}",
                r#"{"10":["#.repeat(depth),
                r#"],"2":1}"#.repeat(depth)
            );
            let value: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(
                payload_digest(&value),
                format!("{:x}", Sha256::digest(canonical.as_bytes()))
            );
        })
        .unwrap()
        .join()
        .unwrap();
}
