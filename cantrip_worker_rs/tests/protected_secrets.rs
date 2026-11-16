use cantrip_crypto::{content::*, *};
use cantrip_wire::{Value, value::json};
use cantrip_worker::{
    encryption::{Identity, Service},
    protected_secrets::*,
};
use std::{path::Path, sync::Arc};
fn service(path: &Path) -> Arc<Service> {
    Service::new(
        Identity::open(
            path,
            "https://content.test",
            &"worker-content".into(),
            false,
        )
        .unwrap(),
        "https://content.test",
        cantrip_worker::http::client().unwrap(),
    )
    .unwrap()
}
fn authorize(service: &Service, owner: &str, server: &str, scope: &str, key: u8) {
    let registration = service.registration();
    let at = "2026-11-16T00:00:00.000Z";
    let grant = wrap_component_key(
        &[key; 32],
        &registration["publicKey"],
        &json!(owner),
        &json!({"workerId":"worker-content","component":scope,"keyRevision":1}),
    )
    .unwrap();
    let payload = json!({"serverId":server,"ownerId":owner,"principal":json!({"id":registration["principalId"],"ownerId":owner,"kind":"worker","workerId":"worker-content","label":"Content fixture","publicKey":registration["publicKey"],"state":"approved","revision":1,"approvedAt":at,"revokedAt":Value::Null,"revokedReason":Value::Null,"createdAt":at,"updatedAt":at}),"grants":vec![json!({"id":"11111111-1111-4111-8111-111111111111","ownerId":owner,"principalId":registration["principalId"],"component":scope,"keyRevision":1,"wrappedKey":grant,"state":"active","revision":1,"revokedAt":Value::Null,"revokedReason":Value::Null,"createdAt":at,"updatedAt":at})]});
    service.accept_bootstrap(&payload).unwrap();
}
#[tokio::test]
async fn provider_credentials_bind_subject_account_and_key_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let service = service(temp.path());
    authorize(
        &service,
        "owner-a",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "provider-credential",
        7,
    );
    let credential = json!({"version":1,"kind":"grok","accessToken":"synthetic-token","refreshToken":Value::Null,"email":Value::Null,"expiresAt":1700000000000_i64,"planType":Value::Null,"userId":"user-1"});
    let protected =
        protect_provider_credential(&service, &json!("account-1"), &credential).unwrap();
    assert_eq!(
        open_provider_credential(&service, &json!("account-1"), &protected["credential"]).unwrap(),
        credential
    );
    assert_eq!(
        protected["metadata"]["expiresAt"],
        "2023-11-14T22:13:20.000Z"
    );
    let mut wrong_subject = protected["credential"].clone();
    wrong_subject["subjectBlindIndex"] = json!(encode(&[0; 32]));
    assert!(
        open_provider_credential(&service, &json!("account-1"), &wrong_subject)
            .unwrap_err()
            .to_string()
            .contains("identity binding")
    );
    assert!(
        open_provider_credential(&service, &json!("account-other"), &protected["credential"])
            .unwrap_err()
            .is::<DecryptionError>()
    );
    let snapshot = service
        .bound_component("provider-credential", None)
        .unwrap();
    authorize(
        &service,
        "owner-b",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "provider-credential",
        8,
    );
    assert!(
        open_provider_credential(&service, &json!("account-1"), &protected["credential"])
            .unwrap_err()
            .is::<DecryptionError>()
    );
    let context = json!({"ownerId":snapshot.owner_id,"component":"provider-credential","table":"model_provider_accounts","rowId":"account-1","field":"protected_credential","keyRevision":1});
    assert_eq!(
        decrypt_secret(
            &snapshot.component.key,
            &context,
            &protected["credential"]["protectedCredential"],
            "providerCredentialProtectedContentSchema",
            None
        )
        .unwrap(),
        credential
    );
    service.close().await.unwrap();
}
#[tokio::test]
async fn mcp_discovery_blocks_reserved_names_and_opens_real_protected_configuration() {
    let temp = tempfile::tempdir().unwrap();
    let service = service(temp.path());
    let worker = json!("worker-content");
    let configuration = json!({"name":" cantrip ","transport":"stdio","command":"tool"});
    assert!(
        protect_discovered_mcp(&service, &worker, &configuration)
            .unwrap_err()
            .to_string()
            .contains("Managed MCP")
    );
    assert!(
        open_mcp_servers(
            &service,
            &[json!({"enabled":false,"protectedConfiguration":Value::Null})]
        )
        .unwrap()
        .is_empty()
    );
    authorize(
        &service,
        "owner",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "mcp-secret",
        7,
    );
    let encrypted = protect_discovered_mcp(
        &service,
        &worker,
        &json!({"name":"Example","transport":"stdio","command":"tool","enabled":false}),
    )
    .unwrap();
    let opened = open_mcp_servers(&service, &[encrypted]).unwrap();
    assert_eq!(opened[0]["name"], "Example");
    assert_eq!(opened[0]["enabled"], true);
    assert_eq!(opened[0]["args"], json!(Vec::<Value>::new()));
    service.close().await.unwrap();
}
