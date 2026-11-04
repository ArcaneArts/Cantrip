use anyhow::Result;
use cantrip_server::{
    cantrip_os::Repository, database::Database, managed_postgres::ManagedPostgres,
    migrations::migrate,
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn scope(owner: &str, instance: &Value, workspace: &Value, binding: &Value) -> Value {
    json!({"ownerId":owner,"workerId":"worker","serverId":"server","instanceId":instance["id"],"guestInstanceId":instance["guestInstanceId"],"attachmentGeneration":instance["attachmentGeneration"],"runtimeGeneration":instance["runtimeGeneration"],"bindingId":binding["id"],"bindingGeneration":binding["bindingGeneration"],"projectId":"project","projectSourceId":binding["projectSourceId"],"worktreeId":binding["worktreeId"],"sourceKind":"git","workspaceId":workspace["id"],"guestWorkspaceId":workspace["guestWorkspaceId"],"uid":workspace["uid"],"gid":workspace["gid"],"homeGuestPath":workspace["homeGuestPath"],"guestPath":binding["guestPath"],"mode":binding["mode"],"linkedWorkerPath":binding["linkedWorkerPath"],"dependencyOverlays":binding["dependencyOverlays"]})
}
async fn exercise(database: Arc<Database>) -> Result<()> {
    migrate(&database).await?;
    database.execute("INSERT INTO users(id,kind,display_name) VALUES('owner','anonymous','Owner'),('other','anonymous','Other');
      INSERT INTO workers(id,owner_id,name,platform,architecture,started_at,last_seen_at) VALUES('worker','owner','Worker','darwin','arm64',now(),now());
      INSERT INTO projects(id,owner_id,protected_label,origin_kind,folder_management,worktree_policy,git_capability,github_capability) VALUES('project','owner','{}','managed-folder','external','direct',true,false);").await?;
    let repository = Repository::new(database.clone());
    let instance=repository.attach("owner",&json!({"workerId":"worker","guestInstanceId":id(),"name":"Test","transport":{"kind":"docker","container":"test"},"expectedAttachmentGeneration":null})).await?;
    let instance_id = instance["id"].as_str().unwrap();
    let generation = instance["attachmentGeneration"].as_str().unwrap();
    let instance = repository
        .observe(
            "owner",
            instance_id,
            generation,
            "connected",
            Some(&id()),
            None,
        )
        .await?;
    let instance_id = instance["id"].as_str().unwrap();
    let generation = instance["attachmentGeneration"].as_str().unwrap();
    assert!(repository.attachment("other", instance_id).await.is_err());
    let workspace=repository.record_workspace("owner",instance_id,generation,&json!({"guestWorkspaceId":"alpha","uid":20000,"gid":20000,"homeGuestPath":"/home/alpha"})).await?;
    repository.record_workspace("owner",instance_id,generation,&json!({"guestWorkspaceId":"beta","uid":20001,"gid":20001,"homeGuestPath":"/home/beta"})).await?;
    assert!(repository.record_workspace("owner",instance_id,generation,&json!({"guestWorkspaceId":"alpha","uid":20002,"gid":20002,"homeGuestPath":"/home/alpha"})).await.is_err());
    assert_eq!(repository.workspaces("owner", instance_id).await?.len(), 2);
    assert!(
        repository
            .create_binding(
                "owner",
                "project",
                &json!({"mode":"linux-owned","workspaceId":workspace["id"],"sourceKind":"folder"})
            )
            .await
            .is_err()
    );
    let binding = repository
        .create_binding(
            "owner",
            "project",
            &json!({"mode":"linux-owned","workspaceId":workspace["id"],"sourceKind":"git"}),
        )
        .await?;
    let binding_id = binding["id"].as_str().unwrap();
    assert!(
        repository
            .context("other", "project", binding_id)
            .await
            .is_err()
    );
    let scope = scope("owner", &instance, &workspace, &binding);
    let input = json!({"operationId":id(),"bindingGeneration":binding["bindingGeneration"],"protectedRequest":{"formatVersion":1,"keyRevision":1,"envelope":{"version":1,"algorithm":"AES-256-GCM","keyRevision":1,"nonce":"AAAAAAAAAAAAAAAA","ciphertext":"AAAAAAAAAAAAAAAAAAAAAA"}}});
    let (first, created) = repository.admit("owner", &scope, &input).await?;
    assert!(created);
    let (second, created) = repository.admit("owner", &scope, &input).await?;
    assert!(!created);
    assert_eq!(first, second);
    let mut different = input.clone();
    different["operationId"] = json!(id());
    assert!(repository.admit("owner", &scope, &different).await.is_err());
    assert!(
        database
            .query(
                "UPDATE cantrip_os_provision_admissions SET scope='{}' WHERE binding_id=$1",
                &[&binding_id]
            )
            .await
            .is_err()
    );
    let mut receipt = json!({"bindingId":binding["id"],"workspaceId":workspace["id"],"guestWorkspaceId":"alpha","mode":"linux-owned","guestPath":binding["guestPath"],"runtimeGeneration":instance["runtimeGeneration"],"uid":20000,"homeGuestPath":"/home/alpha","head":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","branch":"ctrr:protected-branch","detached":false,"repositoryFingerprint":"fingerprint","gitCommonGuestPath":format!("{}/.git",binding["guestPath"].as_str().unwrap()),"recreated":false,"interruptedGuestWorkspaces":[],"dependencyOverlays":[],"cleanupWarnings":[]});
    let mut wrong = receipt.clone();
    wrong["uid"] = json!(20001);
    assert!(
        repository
            .outcome("owner", &scope, "ready", None, Some(&wrong))
            .await
            .is_err()
    );
    assert_eq!(
        repository
            .outcome("owner", &scope, "ready", None, Some(&receipt))
            .await?["state"],
        "ready"
    );
    let mut replaced = receipt.clone();
    replaced["repositoryFingerprint"] = json!("different-common-directory");
    assert!(
        repository
            .outcome("owner", &scope, "ready", None, Some(&replaced))
            .await
            .is_err()
    );
    let stored = database
        .query(
            "SELECT head,branch FROM project_worktrees WHERE id=$1",
            &[&binding["worktreeId"].as_str().unwrap()],
        )
        .await?;
    assert_eq!(stored[0].get::<String>(0)?, "a".repeat(40));
    assert_eq!(stored[0].get::<String>(1)?, "ctrr:protected-branch");
    let next = id();
    repository
        .observe(
            "owner",
            instance_id,
            generation,
            "connected",
            Some(&next),
            None,
        )
        .await?;
    assert!(
        repository
            .outcome("owner", &scope, "ready", None, Some(&receipt))
            .await
            .is_err()
    );
    assert!(
        repository
            .observe_current(
                "owner",
                instance_id,
                generation,
                "connected",
                scope["runtimeGeneration"].as_str(),
                None,
                scope["runtimeGeneration"].as_str()
            )
            .await
            .is_err()
    );
    let mut current = scope.clone();
    current["runtimeGeneration"] = json!(next);
    receipt["runtimeGeneration"] = current["runtimeGeneration"].clone();
    repository
        .outcome("owner", &current, "ready", None, Some(&receipt))
        .await?;
    let admission = repository
        .admission("owner", "project", binding_id)
        .await?
        .unwrap();
    assert_eq!(admission["scope"], scope);
    Ok(())
}
#[tokio::test]
async fn native_pglite_source_admission_and_generations() -> Result<()> {
    if let Ok(path) = std::env::var("CANTRIP_OS_DATABASE_CHILD") {
        let database = Arc::new(Database::pglite(std::path::Path::new(&path)).await?);
        exercise(database.clone()).await?;
        database.close().await?;
        return Ok(());
    }
    let root = tempfile::tempdir()?;
    let status = tokio::process::Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "native_pglite_source_admission_and_generations",
            "--nocapture",
        ])
        .env("CANTRIP_OS_DATABASE_CHILD", root.path().join("db"))
        .kill_on_drop(true)
        .status()
        .await?;
    assert!(status.success());
    Ok(())
}
#[tokio::test]
async fn postgres_source_admission_and_generations() -> Result<()> {
    let root = tempfile::tempdir()?;
    let bin = PathBuf::from(std::env::var("CANTRIP_TEST_POSTGRES_BIN_DIR")?);
    let runtime = ManagedPostgres::start_with_owner(
        root.path(),
        &bin,
        std::path::Path::new(env!("CARGO_BIN_EXE_cantrip-server")),
    )
    .await?;
    let database = Arc::new(Database::postgres(runtime.configuration()).await?);
    exercise(database.clone()).await?;
    database.close().await?;
    runtime.close().await?;
    Ok(())
}
