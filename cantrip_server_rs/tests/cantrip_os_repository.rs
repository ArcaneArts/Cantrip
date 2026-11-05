use anyhow::Result;
use cantrip_server::{
    cantrip_os::{InstanceObservation, Repository},
    database::Database,
    managed_postgres::ManagedPostgres,
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
async fn exercise_run_captures(
    database: Arc<Database>,
    primary: Value,
    worktree: Value,
) -> Result<()> {
    let desktop_repository = cantrip_server::remote_surfaces::Repository::new(database.clone());
    let source = &primary["scope"];
    let desktop_context = cantrip_server::wire::Value::from_serialize(
        &json!({"workerId":"worker","surface":{"kind":"desktop","projectId":"project","configuration":{"kind":"desktop","osSource":{"bindingId":source["bindingId"],"worktreeId":source["worktreeId"],"bindingGeneration":source["bindingGeneration"],"attachmentGeneration":source["attachmentGeneration"],"runtimeGeneration":source["runtimeGeneration"],"desktopGeneration":"a".repeat(64)}}}}),
    );
    let desktop_execution = desktop_repository
        .desktop_execution("owner", &desktop_context)
        .await?
        .unwrap();
    assert_eq!(
        desktop_execution["scope"]["bindingId"].as_str(),
        source["bindingId"].as_str()
    );
    assert!(
        desktop_repository
            .desktop_execution("other", &desktop_context)
            .await
            .is_err()
    );
    let mut stale_desktop = desktop_context.clone();
    stale_desktop["surface"]["configuration"]["osSource"]["runtimeGeneration"] =
        cantrip_server::wire::Value::String(id().into());
    assert!(
        desktop_repository
            .desktop_execution("owner", &stale_desktop)
            .await
            .is_err()
    );
    // Run admission uses the same canonical Linux source, without requiring a
    // Worker-local project_sources row for this Linux-owned checkout.
    let runs = cantrip_server::run_configurations::Repository::new(database.clone());
    let mut target = primary.clone();
    for (key, binding_key) in [
        ("bindingId", "id"),
        ("bindingGeneration", "bindingGeneration"),
        ("worktreeId", "worktreeId"),
        ("guestPath", "guestPath"),
    ] {
        target["scope"][key] = worktree[binding_key].clone();
    }
    let roots = cantrip_server::wire::Value::from_serialize(
        &json!({"definitions":primary,"target":target}),
    );
    let execution_key = cantrip_server::run_configurations::execution::key(&roots)?;
    let configuration = id();
    let request = cantrip_server::wire::Value::from_serialize(
        &json!({"operation":"start","operationId":id(),"projectId":"project","configurationId":configuration,"worktreeId":worktree["worktreeId"],"workerId":"worker","definitionRevision":"a".repeat(64),"codexEnvironmentRevision":null,"osExecution":serde_json::from_str::<Value>(&roots.stringify())?}),
    );
    let admitted = runs.request_operation("owner", &request).await?;
    let runtime = &admitted["runtime"];
    assert_eq!(runtime["generation"].as_f64(), Some(1.0));
    let terminal_id = runtime["terminalId"].as_str().unwrap();
    let terminal_repo = cantrip_server::terminals::Repository::new(database.clone());
    let terminal = terminal_repo
        .list("owner", "project")
        .await?
        .into_iter()
        .find(|row| row["id"] == terminal_id)
        .unwrap();
    assert_eq!(
        terminal["cantripOsBindingId"].as_str(),
        worktree["id"].as_str()
    );
    assert_eq!(
        terminal["cantripOsRuntimeGeneration"].as_str(),
        target["scope"]["runtimeGeneration"].as_str()
    );
    // Emulate a pre-upgrade Run terminal, then execute the actual atomic backfill.
    database.execute(&format!("DO $$ BEGIN ALTER TABLE terminals DISABLE TRIGGER terminal_os_capture_immutable; UPDATE terminals SET cantrip_os_binding_id=NULL,os_binding_generation=NULL,os_attachment_generation=NULL,os_runtime_generation=NULL WHERE id='{terminal_id}'; ALTER TABLE terminals ENABLE TRIGGER terminal_os_capture_immutable; END $$;")).await?;
    database
        .execute(include_str!(
            "../../cantrip_server/drizzle/0249_cantrip_os_run_terminal_files.sql"
        ))
        .await?;
    let backfilled = terminal_repo
        .list("owner", "project")
        .await?
        .into_iter()
        .find(|row| row["id"] == terminal_id)
        .unwrap();
    assert_eq!(
        backfilled["cantripOsBindingId"].as_str(),
        worktree["id"].as_str()
    );
    assert!(
        database
            .execute(&format!(
                "UPDATE terminals SET os_runtime_generation='different' WHERE id='{terminal_id}'"
            ))
            .await
            .is_err()
    );

    assert_eq!(
        runtime["worktreeId"].as_str(),
        worktree["worktreeId"].as_str()
    );
    assert!(
        runs.get(
            "owner",
            "project",
            &configuration,
            worktree["worktreeId"].as_str().unwrap()
        )
        .await?
        .is_none()
    );
    assert_eq!(
        runs.get_in_execution(
            "owner",
            "project",
            &configuration,
            worktree["worktreeId"].as_str().unwrap(),
            &execution_key
        )
        .await?
        .unwrap()["id"],
        runtime["id"]
    );
    assert!(
        runs.operation_result("owner", request["operationId"].as_str().unwrap())
            .await?
            .is_none()
    );
    assert!(
        runs.operation_result_in_execution(
            "owner",
            request["operationId"].as_str().unwrap(),
            &execution_key
        )
        .await?
        .is_some()
    );
    assert!(runs.active_identities("owner", "worker").await?.is_empty());
    assert_eq!(runs.active_os_captures("owner", "worker").await?.len(), 1);
    assert!(
        runs.list("owner", "project", Some(&configuration), None, 256)
            .await?
            .is_empty()
    );
    assert_eq!(
        runs.list_in_execution("owner", "project", Some(&configuration), None, 256, None)
            .await?
            .len(),
        1
    );
    assert_eq!(
        runs.list_for_retirement(
            "owner",
            "project",
            Some(&configuration),
            None,
            roots["definitions"]["scope"]["projectSourceId"].as_str()
        )
        .await?
        .len(),
        1
    );
    assert!(
        runs.list_for_retirement("owner", "project", Some(&configuration), None, Some(&id()))
            .await?
            .is_empty()
    );
    let captured = runs
        .captured("owner", runtime["id"].as_str().unwrap())
        .await?
        .unwrap();
    assert_eq!(captured["osExecution"], roots);
    assert_eq!(
        captured["executionKey"].as_str(),
        Some(execution_key.as_str())
    );
    assert!(
        runs.captured("other", runtime["id"].as_str().unwrap())
            .await?
            .is_none()
    );
    assert_eq!(
        runs.request_operation("owner", &request).await?["replayed"],
        cantrip_server::wire::Value::Bool(true)
    );
    let mut wrong = request.clone();
    wrong["osExecution"]["target"]["scope"]["guestPath"] =
        cantrip_server::wire::Value::from_serialize(&"/different-root");
    assert!(runs.request_operation("owner", &wrong).await.is_err());
    wrong = request.clone();
    wrong["osExecution"] = cantrip_server::wire::Value::Null;
    wrong["operationId"] = cantrip_server::wire::Value::from_serialize(&id());
    assert!(runs.request_operation("owner", &wrong).await.is_err());
    let runtime_id = runtime["id"].as_str().unwrap();
    assert!(
        database
            .query(
                "UPDATE run_configuration_runtimes SET os_execution='{}'::jsonb WHERE id=$1",
                &[&runtime_id]
            )
            .await
            .is_err()
    );
    assert!(
        database
            .query(
                "UPDATE run_configuration_runtimes SET execution_key='worker' WHERE id=$1",
                &[&runtime_id]
            )
            .await
            .is_err()
    );
    let lost = cantrip_server::wire::Value::from_serialize(
        &json!({"runtimeId":runtime["id"].as_str(),"projectId":"project","configurationId":configuration,"worktreeId":worktree["worktreeId"],"workerId":"worker","definitionRevision":"a".repeat(64),"codexEnvironmentRevision":null,"generation":1,"operationId":request["operationId"].as_str(),"terminalId":runtime["terminalId"].as_str(),"state":"lost","startedAt":null,"endedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"exitCode":null,"signal":null,"failure":{"phase":"reconcile","code":"linux-outcome-unknown","message":"Unknown native outcome","retryable":true}}),
    );
    assert!(runs.observe("owner", "worker", &lost).await?.is_some());
    assert_eq!(
        runs.delete("owner", "project", &[runtime_id.to_owned()])
            .await?,
        0
    );

    let mut next = request.clone();
    next["operationId"] = cantrip_server::wire::Value::from_serialize(&id());
    assert!(runs.request_operation("owner", &next).await.is_err());
    assert_eq!(
        runs.captured("owner", runtime_id).await?.unwrap()["runtime"]["generation"].as_f64(),
        Some(1.0)
    );
    let mut stop = request.clone();
    stop["operation"] = cantrip_server::wire::Value::from_serialize(&"stop");
    stop["operationId"] = cantrip_server::wire::Value::from_serialize(&id());
    stop["definitionRevision"] = cantrip_server::wire::Value::Null;
    stop["codexEnvironmentRevision"] = cantrip_server::wire::Value::Null;
    let stopped = runs.request_operation("owner", &stop).await?;
    assert_eq!(stopped["runtime"]["id"], runtime["id"]);
    assert_eq!(stopped["runtime"]["state"].as_str(), Some("stopping"));
    assert_eq!(stopped["runtime"]["generation"].as_f64(), Some(1.0));
    stop["operationId"] = cantrip_server::wire::Value::from_serialize(&id());
    assert_eq!(
        runs.request_operation("owner", &stop).await?["operation"]["outcome"].as_str(),
        Some("accepted")
    );
    // Compare against the actual Node implementation, not a copied hash formula.
    let mut oracle = std::process::Command::new("node");
    oracle
        .args(["--import", "tsx", "scripts/server-rust/os-run-epoch.mjs"])
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped());
    let mut child = oracle.spawn()?;
    use std::io::Write;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(roots.stringify().as_bytes())?;
    let output = child.wait_with_output()?;
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout)?.trim(), execution_key);
    Ok(())
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
    let worktree_admission = json!({"mode":"linux-worktree","sourceBindingId":binding["id"],"expectedRuntimeGeneration":instance["runtimeGeneration"],"operationId":id()});
    let (worktree_a, worktree_b) = tokio::join!(
        repository.create_binding("owner", "project", &worktree_admission),
        repository.create_binding("owner", "project", &worktree_admission)
    );
    let mut worktree = worktree_a?;
    assert_eq!(worktree, worktree_b?);
    assert_eq!(worktree["projectSourceId"], binding["projectSourceId"]);
    assert_ne!(worktree["worktreeId"], binding["worktreeId"]);
    assert_eq!(worktree["mode"], "linux-owned");
    assert!(
        repository
            .create_binding("other", "project", &worktree_admission)
            .await
            .is_err()
    );
    let source_count = database
        .query(
            "SELECT count(*)::bigint FROM project_source_identities WHERE project_id='project'",
            &[],
        )
        .await?;
    assert_eq!(source_count[0].get::<i64>(0)?, 1);
    let tree_count = database
        .query(
            "SELECT count(*)::bigint FROM project_worktrees WHERE project_source_id=$1",
            &[&binding["projectSourceId"].as_str().unwrap()],
        )
        .await?;
    assert_eq!(tree_count[0].get::<i64>(0)?, 2);
    let mut worktree_scope = scope.clone();
    for (key, value) in [
        ("bindingId", worktree["id"].clone()),
        ("bindingGeneration", worktree["bindingGeneration"].clone()),
        ("worktreeId", worktree["worktreeId"].clone()),
        ("guestPath", worktree["guestPath"].clone()),
    ] {
        worktree_scope[key] = value;
    }
    let mut worktree_receipt = receipt.clone();
    worktree_receipt["bindingId"] = worktree["id"].clone();
    worktree_receipt["guestPath"] = worktree["guestPath"].clone();
    worktree_receipt["branch"] = json!("ctrr:worktree-branch");
    worktree = repository
        .outcome(
            "owner",
            &worktree_scope,
            "ready",
            None,
            Some(&worktree_receipt),
        )
        .await?;
    let branches = database
        .query(
            "SELECT branch FROM project_worktrees WHERE id=$1",
            &[&binding["worktreeId"].as_str().unwrap()],
        )
        .await?;
    assert_eq!(branches[0].get::<String>(0)?, "ctrr:protected-branch");
    let primary = repository
        .run_primary(
            "owner",
            "project",
            worktree["id"].as_str().unwrap(),
            instance["runtimeGeneration"].as_str().unwrap(),
        )
        .await?;
    assert_eq!(primary["scope"]["bindingId"], binding["id"]);
    assert_eq!(primary["scope"]["worktreeId"], binding["worktreeId"]);
    assert_eq!(primary["scope"]["guestPath"], binding["guestPath"]);
    assert!(
        repository
            .run_primary(
                "other",
                "project",
                worktree["id"].as_str().unwrap(),
                instance["runtimeGeneration"].as_str().unwrap()
            )
            .await
            .is_err()
    );
    assert!(
        repository
            .run_primary("owner", "project", worktree["id"].as_str().unwrap(), &id())
            .await
            .is_err()
    );
    // Poll this phase after the large integration driver has yielded, matching
    // an independently scheduled request without increasing the test stack.
    tokio::spawn(exercise_run_captures(
        database.clone(),
        primary.clone(),
        worktree.clone(),
    ))
    .await??;
    database
        .execute("INSERT INTO user_settings(user_id,computer_use_enabled) VALUES('owner',true)")
        .await?;
    let chat_id = id();
    let chats = cantrip_server::chats::Repository::new(database.clone());
    let chat_input = cantrip_server::wire::Value::from_serialize(
        &json!({"id":chat_id,"titleProtection":{"classification":{"recordKind":"chat"},"protectedLabel":input["protectedRequest"]},"attachToTabLayout":false,"worktreeMode":"pinned","cantripOsBindingId":binding["id"]}),
    );
    let chat = chats
        .create_project_chat("owner", "project", &chat_input, None)
        .await?
        .unwrap();
    assert_eq!(
        chat["activeWorktreeId"].as_str(),
        binding["worktreeId"].as_str()
    );
    let context = chats.execution_context("owner", &chat_id).await?.unwrap();
    assert_eq!(context["cwd"].as_str(), binding["guestPath"].as_str());
    assert_eq!(
        context["osExecution"]["scope"]["bindingId"].as_str(),
        binding["id"].as_str()
    );
    assert_eq!(
        context["computerUseEnabled"],
        cantrip_server::wire::Value::Bool(true)
    );
    let lanes = cantrip_server::chats::execution_lanes::LaneRepository::new(database.clone());
    let lane = lanes
        .start("owner", &chat_id, "user", "OS acceptance")
        .await?
        .unwrap();
    assert_eq!(lane["worktreeId"].as_str(), binding["worktreeId"].as_str());
    assert_eq!(lane["osExecution"], context["osExecution"]);
    assert!(
        database
            .query(
                "UPDATE cantrip_os_chat_placements SET runtime_generation=$1 WHERE chat_id=$2",
                &[&id(), &chat_id]
            )
            .await
            .is_err()
    );
    assert_eq!(chat["cantripOsBindingId"].as_str(), binding["id"].as_str());
    let explorers = cantrip_server::project_surfaces::Repository::new(database.clone());
    let explorer_id = id();
    let explorer_input = cantrip_server::wire::Value::from_serialize(&json!({
        "id":explorer_id,"worktreeId":binding["worktreeId"],"cantripOsBindingId":binding["id"],"cantripOsRuntimeGeneration":instance["runtimeGeneration"],"attachToTabLayout":false,
        "titleProtection":{"classification":{"recordKind":"explorer"},"protectedLabel":input["protectedRequest"]},
        "stateProtection":{"classification":{"recordKind":"explorer-state"},"protectedState":input["protectedRequest"]}
    }));
    let explorer = explorers
        .create(
            cantrip_server::project_surfaces::Kind::Explorer,
            "owner",
            "project",
            &explorer_input,
            None,
        )
        .await?
        .unwrap();
    assert_eq!(
        explorer["cantripOsBindingId"].as_str(),
        binding["id"].as_str()
    );
    let explorer_context = explorers
        .context(
            cantrip_server::project_surfaces::Kind::Explorer,
            "owner",
            &explorer_id,
        )
        .await?
        .unwrap();
    assert_eq!(explorer_context["root"], context["osExecution"]);
    let documents = cantrip_server::file_documents::Repository::new(database.clone());
    let document_id = id();
    let document_input = cantrip_server::wire::Value::from_serialize(
        &json!({"id":document_id,"worktreeId":binding["worktreeId"],"cantripOsBindingId":binding["id"],"cantripOsRuntimeGeneration":instance["runtimeGeneration"],"stateProtection":{"classification":{"recordKind":"file-document-state"},"protectedState":input["protectedRequest"]}}),
    );
    let document = documents
        .create("owner", "project", &document_input)
        .await?
        .unwrap();
    assert_eq!(
        documents
            .create("owner", "project", &document_input)
            .await?
            .unwrap(),
        document
    );
    assert_eq!(
        documents
            .execution_context("owner", &document_id)
            .await?
            .unwrap()["root"],
        context["osExecution"]
    );
    assert!(documents.get("other", &document_id).await?.is_none());
    assert!(
        documents
            .create("other", "project", &document_input)
            .await
            .is_err()
    );
    assert!(
        database
            .query(
                "UPDATE file_documents SET os_runtime_generation=$1 WHERE id=$2",
                &[&id(), &document_id]
            )
            .await
            .is_err()
    );
    let terminals = cantrip_server::terminals::Repository::new(database.clone());
    let terminal_id = id();
    let terminal_input = cantrip_server::wire::Value::from_serialize(
        &json!({"id":terminal_id,"worktreeId":binding["worktreeId"],"cantripOsBindingId":binding["id"],"cantripOsRuntimeGeneration":instance["runtimeGeneration"],"titleProtection":{"classification":{"recordKind":"terminal"},"protectedLabel":input["protectedRequest"]},"stateProtection":{"classification":{"recordKind":"terminal-state"},"protectedState":input["protectedRequest"]}}),
    );
    let terminal = terminals
        .create("owner", "project", &terminal_input, None)
        .await?
        .unwrap();
    assert_eq!(
        terminal["cantripOsBindingId"].as_str(),
        binding["id"].as_str()
    );
    assert_eq!(
        terminals.context("owner", &terminal_id).await?.unwrap()["worktreePath"],
        context["osExecution"]
    );
    assert!(terminals.context("other", &terminal_id).await?.is_none());
    let console_id = id();
    let mut console_input = terminal_input.clone();
    console_input["id"] = cantrip_server::wire::Value::from_serialize(&console_id);
    let console = terminals
        .get_or_create_chat_console("owner", &chat_id, &console_input)
        .await?
        .unwrap();
    assert_eq!(
        console["cantripOsBindingId"],
        terminal["cantripOsBindingId"]
    );
    assert_eq!(
        terminals.context("owner", &console_id).await?.unwrap()["worktreePath"],
        context["osExecution"]
    );
    assert!(
        database
            .query(
                "UPDATE terminals SET os_runtime_generation=$1 WHERE id=$2",
                &[&id(), &terminal_id]
            )
            .await
            .is_err()
    );
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
                InstanceObservation {
                    status: "connected",
                    runtime: scope["runtimeGeneration"].as_str(),
                    error: None,
                },
                scope["runtimeGeneration"].as_str()
            )
            .await
            .is_err()
    );
    assert!(chats.execution_context("owner", &chat_id).await.is_err());
    assert_eq!(
        repository
            .create_binding("owner", "project", &worktree_admission)
            .await?,
        worktree
    );
    let mut stale_admission = worktree_admission.clone();
    stale_admission["operationId"] = json!(id());
    assert!(
        repository
            .create_binding("owner", "project", &stale_admission)
            .await
            .is_err()
    );
    assert!(terminals.context("owner", &terminal_id).await.is_err());
    assert!(terminals.context("owner", &console_id).await.is_err());
    assert!(
        explorers
            .context(
                cantrip_server::project_surfaces::Kind::Explorer,
                "owner",
                &explorer_id
            )
            .await
            .is_err()
    );
    assert!(
        documents
            .execution_context("owner", &document_id)
            .await
            .is_err()
    );
    assert_eq!(
        terminals.delete("owner", &terminal_id).await?.unwrap()["terminalId"].as_str(),
        Some(terminal_id.as_str())
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
    // A missing durable OS chat capture must not create a Host console.
    terminals.delete("owner", &console_id).await?;
    database
        .query(
            "DELETE FROM cantrip_os_chat_placements WHERE chat_id=$1",
            &[&chat_id],
        )
        .await?;
    console_input["id"] = cantrip_server::wire::Value::from_serialize(&id());
    assert!(
        terminals
            .get_or_create_chat_console("owner", &chat_id, &console_input)
            .await
            .is_err()
    );
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
