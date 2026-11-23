use cantrip_wire::{JsString, Value, value::json};
use cantrip_worker::encryption::{Identity, IdentityError};
use std::{fs, path::Path};
fn open(path: &Path) -> anyhow::Result<Identity> {
    Identity::open(
        path,
        "https://server.test",
        &JsString::from("worker-a"),
        false,
    )
}
fn read(path: &Path) -> Value {
    cantrip_wire::parse_json_text(
        &fs::read_to_string(path.join("worker-encryption-key.json")).unwrap(),
    )
    .unwrap()
}
#[test]
fn identity_reopens_without_rewriting_and_binding_publication_is_transactional() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("profile");
    let mut identity = open(&dir).unwrap();
    let registration = identity.registration();
    let original = fs::read(dir.join("worker-encryption-key.json")).unwrap();
    assert_eq!(open(&dir).unwrap().registration(), registration);
    assert_eq!(
        original,
        fs::read(dir.join("worker-encryption-key.json")).unwrap()
    );
    let owner = json!("owner-a");
    let server = json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let revisions = json!({"chat-content":3});
    identity
        .persist_binding(&owner, &server, &revisions)
        .unwrap();
    let restored = open(&dir).unwrap();
    assert_eq!(restored.bound_owner(), &owner);
    assert_eq!(restored.bound_server(), &server);
    assert_eq!(restored.accepted_revisions(), &revisions);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(dir.join("worker-encryption-key.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    fs::rename(&dir, temp.path().join("retained")).unwrap();
    fs::write(&dir, b"blocks the actual directory creation").unwrap();
    assert!(
        identity
            .persist_binding(&json!("other"), &server, &json!({"chat-content":9}))
            .is_err()
    );
    assert_eq!(identity.bound_owner(), &owner);
    assert_eq!(identity.accepted_revisions(), &revisions);
}
#[test]
fn corrupt_and_foreign_records_never_regenerate_keys() {
    let temp = tempfile::tempdir().unwrap();
    let _identity = open(temp.path()).unwrap();
    let original = fs::read(temp.path().join("worker-encryption-key.json")).unwrap();
    let error = match Identity::open(
        temp.path(),
        "https://other.test",
        &JsString::from("worker-a"),
        false,
    ) {
        Err(e) => e,
        Ok(_) => panic!("accepted foreign record"),
    };
    assert_eq!(
        error.downcast_ref::<IdentityError>().unwrap().code,
        "identity-mismatch"
    );
    assert_eq!(
        original,
        fs::read(temp.path().join("worker-encryption-key.json")).unwrap()
    );
    fs::write(temp.path().join("worker-encryption-key.json"), b"broken").unwrap();
    assert!(open(temp.path()).is_err());
    assert_eq!(
        fs::read(temp.path().join("worker-encryption-key.json")).unwrap(),
        b"broken"
    );
}
#[test]
fn legacy_binding_and_port_policy_preserve_identity_until_authorized_write() {
    let temp = tempfile::tempdir().unwrap();
    let worker = JsString::from("worker-a");
    let identity = Identity::open(temp.path(), "http://127.0.0.1:4100", &worker, true).unwrap();
    let registration = identity.registration();
    let mut record = read(temp.path());
    record["version"] = json!(1);
    record["serverId"] = record["serverUrl"].clone();
    if let Value::Object(fields) = &mut record {
        fields.shift_remove("serverUrl");
    }
    let original = format!("{}\n", record.stringify_pretty());
    fs::write(temp.path().join("worker-encryption-key.json"), &original).unwrap();
    let mut exact = Identity::open(temp.path(), "http://127.0.0.1:4200", &worker, false).unwrap();
    assert_eq!(exact.registration(), registration);
    assert_eq!(
        fs::read_to_string(temp.path().join("worker-encryption-key.json")).unwrap(),
        original
    );
    exact
        .persist_binding(
            &json!("owner"),
            &json!("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            &json!({"chat-content":4}),
        )
        .unwrap();
    let record = read(temp.path());
    assert_eq!(record["version"], 2);
    assert_eq!(record["serverUrl"], "http://127.0.0.1:4200");
    assert!(Identity::open(temp.path(), "http://127.0.0.1:4300", &worker, false).is_err());
}
