use cantrip_wire::{Value, value::json};
use cantrip_worker::{
    encryption::{Identity, Service},
    http,
};
use std::{path::Path, sync::Arc};
use tokio::io::AsyncReadExt;
const SERVER: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NEXT: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
fn service(directory: &Path, url: &str) -> Arc<Service> {
    Service::new(
        Identity::open(directory, url, &"worker-grant".into(), false).unwrap(),
        url,
        http::client().unwrap(),
    )
    .unwrap()
}
fn payload(service: &Service, owner: &str, server: &str, state: &str, revision: u64) -> Value {
    let registration = service.registration();
    let at = "2026-11-16T00:00:00.000Z";
    let grant = cantrip_crypto::wrap_component_key(
        &[revision as u8; 32],
        &registration["publicKey"],
        &json!(owner),
        &json!({"workerId":"worker-grant","component":"task-content","keyRevision":revision}),
    )
    .unwrap();
    let grants = if state == "approved" {
        vec![
            json!({"id":"11111111-1111-4111-8111-111111111111","ownerId":owner,"principalId":registration["principalId"],"component":"task-content","keyRevision":revision,"wrappedKey":grant,"state":"active","revision":1,"revokedAt":Value::Null,"revokedReason":Value::Null,"createdAt":at,"updatedAt":at}),
        ]
    } else {
        vec![]
    };
    json!({"serverId":server,"ownerId":owner,"principal":json!({"id":registration["principalId"],"ownerId":owner,"kind":"worker","workerId":"worker-grant","label":"Grant fixture","publicKey":registration["publicKey"],"state":state,"revision":1,"approvedAt":if state=="approved"{json!(at)}else{Value::Null},"revokedAt":if state=="revoked"{json!(at)}else{Value::Null},"revokedReason":if state=="revoked"{json!("revoked")}else{Value::Null},"createdAt":at,"updatedAt":at}),"grants":grants})
}
#[tokio::test]
async fn rotation_retains_historical_keys_and_rejects_rollback_after_restart() {
    let temp = tempfile::tempdir().unwrap();
    let first = service(temp.path(), "https://server.test");
    let v1 = payload(&first, "owner", SERVER, "approved", 1);
    let v2 = payload(&first, "owner", SERVER, "approved", 2);
    first.accept_bootstrap(&v1).unwrap();
    let mut both = v2.clone();
    if let Value::Array(grants) = &mut both["grants"] {
        grants.insert(0, v1["grants"].as_array().unwrap()[0].clone());
    }
    first.accept_bootstrap(&both).unwrap();
    assert_eq!(
        first
            .component_key("task-content", None)
            .unwrap()
            .key_revision,
        2
    );
    assert_eq!(
        *first.component_key("task-content", Some(1)).unwrap().key,
        vec![1; 32]
    );
    first.close().await.unwrap();
    let second = service(temp.path(), "https://server.test");
    let error = second.accept_bootstrap(&v1).unwrap_err();
    assert!(error.to_string().contains("rolled back"));
    assert!(second.component_key("task-content", None).is_err());
    assert!(second.server_identity().is_err());
    second.accept_bootstrap(&v2).unwrap();
    assert_eq!(
        *second.component_key("task-content", None).unwrap().key,
        vec![2; 32]
    );
    second.close().await.unwrap();
}
#[tokio::test]
async fn replacement_server_binding_commits_only_after_valid_grants() {
    let temp = tempfile::tempdir().unwrap();
    let service = service(temp.path(), "https://server.test");
    service
        .accept_bootstrap(&payload(&service, "owner", SERVER, "approved", 3))
        .unwrap();
    let pathname = temp.path().join("worker-encryption-key.json");
    let original = std::fs::read(&pathname).unwrap();
    let mut bad = payload(&service, "replacement", NEXT, "approved", 1);
    if let Value::Array(grants) = &mut bad["grants"] {
        grants[0]["wrappedKey"]["envelope"]["ciphertext"] = json!(cantrip_crypto::encode(&[0; 48]));
    }
    assert!(service.accept_bootstrap(&bad).is_err());
    assert_eq!(std::fs::read(&pathname).unwrap(), original);
    assert!(service.component_key("task-content", None).is_err());
    service
        .accept_bootstrap(&payload(&service, "replacement", NEXT, "approved", 1))
        .unwrap();
    assert_eq!(service.owner_id().unwrap().as_str(), Some("replacement"));
    assert_eq!(service.server_identity().unwrap(), NEXT);
    assert_eq!(
        service
            .component_key("task-content", None)
            .unwrap()
            .key_revision,
        1
    );
    service
        .accept_bootstrap(&payload(&service, "replacement", NEXT, "revoked", 1))
        .unwrap();
    assert_eq!(service.status()["state"], "unavailable");
    assert!(service.component_key("task-content", None).is_err());
    service.close().await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_caller_does_not_cancel_refresh_and_close_joins_actual_network_work() {
    let temp = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let service = service(temp.path(), &url);
    let before = std::fs::read(temp.path().join("worker-encryption-key.json")).unwrap();
    let caller = service.refresh("synthetic-credential".into(), None);
    drop(caller);
    let (mut socket, _) =
        tokio::time::timeout(std::time::Duration::from_secs(3), listener.accept())
            .await
            .unwrap()
            .unwrap();
    let mut bytes = [0; 4096];
    let read = socket.read(&mut bytes).await.unwrap();
    assert!(
        String::from_utf8_lossy(&bytes[..read])
            .starts_with("POST /api/internal/workers/encryption/bootstrap")
    );
    tokio::time::timeout(std::time::Duration::from_secs(2), service.close())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        before,
        std::fs::read(temp.path().join("worker-encryption-key.json")).unwrap()
    );
    assert_eq!(service.status()["state"], "unavailable");
    assert!(
        service
            .refresh("synthetic-credential".into(), None)
            .await
            .is_err()
    );
}
