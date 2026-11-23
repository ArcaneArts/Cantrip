use cantrip_wire::{parse_json_text, value::json};
use cantrip_worker::credentials::{self, Credential};
use std::fs;

#[test]
fn identities_are_stable_and_corrupt_existing_files_are_never_replaced() {
    let root = tempfile::tempdir().unwrap();
    let id = credentials::identity(root.path()).unwrap();
    assert_eq!(credentials::identity(root.path()).unwrap(), id);
    let path = root.path().join("worker-identity.json");
    let content = fs::read_to_string(&path).unwrap();
    assert_eq!(parse_json_text(&content).unwrap()["workerId"], json!(id));
    for raw in [
        "{",
        "null",
        "false",
        "{}",
        r#"{"version":2,"workerId":"old"}"#,
    ] {
        fs::write(&path, raw).unwrap();
        assert!(credentials::identity(root.path()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    }
}

#[test]
fn credentials_rotate_without_changing_identity_and_reject_foreign_or_corrupt_records() {
    let root = tempfile::tempdir().unwrap();
    assert!(
        credentials::load(root.path(), "https://server.example")
            .unwrap()
            .is_none()
    );
    let worker_id = credentials::identity(root.path()).unwrap();
    for byte in ['a', 'b'] {
        let credential = Credential {
            worker_id: worker_id.clone(),
            server_url: "https://server.example".into(),
            credential: format!("ctwk_{}", byte.to_string().repeat(43)),
        };
        credentials::save(root.path(), &credential).unwrap();
        let loaded = credentials::load(root.path(), &credential.server_url)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.credential, credential.credential);
        assert_eq!(loaded.worker_id, worker_id);
        assert_eq!(credentials::identity(root.path()).unwrap(), worker_id);
        assert!(credentials::load(root.path(), "https://other.example").is_err());
    }
    assert_eq!(
        fs::read_dir(root.path()).unwrap().count(),
        2,
        "no temporary credential remains after publication"
    );
    let path = root.path().join("worker-credential.json");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    fs::write(&path, "{").unwrap();
    assert!(credentials::load(root.path(), "https://server.example").is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "{");
}
