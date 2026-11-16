use cantrip_protocol::{
    Value, parse,
    value::{Object, json},
};

#[test]
fn mcp_record_constraints_apply_to_normalized_keys() {
    let mut environment = Object::new();
    for index in 0..100 {
        environment.insert(format!("K{index}").into(), json!("first"));
    }
    environment.insert(" K0 ".into(), json!("last"));
    environment.insert(" __proto__ ".into(), json!("ignored"));
    let content = json!({"name":"Example","transport":"stdio","command":"tool","environment":Value::Object(environment)});
    let parsed = parse("mcpServerConfigurationSchema", Some(&content)).unwrap();
    assert_eq!(parsed["environment"].as_object().unwrap().len(), 100);
    assert_eq!(parsed["environment"]["K0"], "last");
    assert!(parsed["environment"].get(" K0 ").is_none());
    assert!(parsed["environment"].get("__proto__").is_none());

    let mut invalid = content;
    invalid["environment"]["K100"] = json!("extra");
    assert!(parse("mcpServerConfigurationSchema", Some(&invalid)).is_err());
}
