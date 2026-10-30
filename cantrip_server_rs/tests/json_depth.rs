use cantrip_server::wire::Value;

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
