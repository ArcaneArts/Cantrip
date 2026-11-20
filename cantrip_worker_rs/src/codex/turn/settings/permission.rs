//! Applied security is confirmed by native evidence on the selected Core binding.
use super::{
    super::receipt::MetadataHttpError, Delivery, Registration, Turns, id, marker_name, remove,
    snapshot::Source,
};
use crate::{
    codex::rpc_requests::Failure,
    http::checked,
    metadata::{Guard, Signal},
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_history::{content::Encryption, files::read_json};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::HashSet,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{Arc, Weak},
    time::Duration,
};

pub(crate) const COMMAND: &str = "chat.permissions.update";
const READ: &str = "thread/settings/operation/read";
const OVERRIDES: &[&str] = &[
    "sandbox",
    "sandboxPolicy",
    "permissionProfile",
    "permissionProfileId",
];
const SELECTORS: &[&str] = &["permissions", "approvalPolicy", "approvalsReviewer"];
const SCOPE: &[&str] = &[
    "chatId",
    "workerId",
    "threadId",
    "contextKind",
    "projectId",
    "placementId",
    "modelRouteId",
    "providerAccountId",
];

pub(in crate::codex::turn) struct Change {
    pub transition: Value,
    pub epoch: Value,
    pub source: Arc<Source>,
    pub binding: Value,
}

impl Turns {
    pub(crate) async fn update_permissions(
        &self,
        command: &Value,
        signal: Signal,
    ) -> Result<Value> {
        let command = checked("nativePermissionUpdateCommandSchema", command)?;
        let source = self
            .preparation
            .settings_source(&command["binding"], true)?;
        let scope = source.encryption_scope()?;
        let transition = command["permissionTransition"].clone();
        let mut params = json!({});
        apply(&mut params, &transition);
        self.apply_settings_update(source, scope, &command, params, Some(transition), signal)
            .await
            .map_err(|_| anyhow!("The permission change did not return a confirmed receipt. Read the current permission state before retrying."))
    }

    pub(in crate::codex::turn) async fn resolve_console_permission(
        &self,
        session: &Value,
        params: &Value,
        open: &Signal,
    ) -> Result<Change> {
        let source = self.preparation.console_settings_source(session)?;
        let selected = selected_profile(params, &source.permission())?;
        let current = source.read_native(open.clone()).await?;
        let epoch = id(
            &current["settingsVersion"]["epoch"],
            "native permission epoch",
        )?;
        let guard = Guard::metadata(Some(open.clone()), None);
        let mut resolution = self
            .receipts
            .resolve_permission(session, &selected, &guard)
            .await;
        source.assert_current()?;
        if matches!(&resolution, Err(error) if error.downcast_ref::<MetadataHttpError>().is_some_and(|error| error.code == "permission-binding-required"))
        {
            let chat = id(&session["chatId"], "permission chat")?;
            let refreshed = self.receipts.refresh_settings(&chat, &guard).await?;
            source.assert_current()?;
            ensure!(
                source.binding_matches(&refreshed["binding"])
                    && refreshed["binding"]["nativeEpoch"].as_js_string() == Some(&epoch),
                "Core refreshed another native permission source."
            );
            resolution = self
                .receipts
                .resolve_permission(session, &selected, &guard)
                .await;
        }
        let resolution = resolution?;
        source.assert_current()?;
        ensure!(
            resolution["permissionTransition"]["selectedId"].as_js_string() == Some(&selected),
            "Core resolved another permission selection."
        );
        id(&resolution["bindingId"], "native permission binding")?;
        Ok(Change {
            source,
            epoch: json!(epoch),
            binding: resolution["bindingId"].clone(),
            transition: resolution["permissionTransition"].clone(),
        })
    }
}

fn patch(effective: &Value) -> Value {
    let yolo = effective == ":yolo";
    json!({
        "approvalPolicy":if yolo {"never"} else {"on-request"},
        "approvalsReviewer":"user",
        "permissions":if yolo {json!(":danger-full-access")} else {effective.clone()},
    })
}

pub(in crate::codex::turn) fn has_update(params: &Value) -> bool {
    OVERRIDES
        .iter()
        .chain(SELECTORS)
        .any(|key| !params[*key].is_null())
}

fn selected_profile(params: &Value, current: &Value) -> Result<JsString> {
    ensure!(
        OVERRIDES.iter().all(|key| params[*key].is_null()),
        "Custom native security overrides require a named managed permission profile."
    );
    let current = patch(current);
    let value = |key| {
        params
            .get(key)
            .filter(|value| !value.is_null())
            .unwrap_or(&current[key])
    };
    ensure!(
        value("approvalsReviewer") == "user",
        "This reviewer cannot be represented by a managed permission profile."
    );
    let profile = id(value("permissions"), "native permission profile")?;
    let approval = value("approvalPolicy");
    if profile.as_str() == Some(":danger-full-access") && approval == "never" {
        return Ok(":yolo".into());
    }
    ensure!(
        approval == "on-request",
        "The approval policy does not match the managed permission transition."
    );
    Ok(profile)
}

pub(in crate::codex::turn) fn apply(params: &mut Value, transition: &Value) {
    if let Value::Object(fields) = params {
        fields.retain(|key, _| {
            !OVERRIDES
                .iter()
                .chain(SELECTORS)
                .any(|security| key.as_str() == Some(security))
        });
    }
    let security = patch(&transition["effectiveId"]);
    for key in SELECTORS {
        params[*key] = security[*key].clone();
    }
    params["applyAt"] = json!("quiescent");
}

pub(super) fn claim(transition: &Value, settings: &Value, resolved: &Value) -> Result<Value> {
    let settings = checked("nativeThreadSettingsSchema", settings)?;
    let security = patch(&transition["effectiveId"]);
    ensure!(
        [
            "approvalPolicy",
            "approvalsReviewer",
            "sandboxPolicy",
            "permissionProfile",
            "activePermissionProfile"
        ]
        .iter()
        .all(|key| resolved.get(*key).is_some() && settings.get(*key) == resolved.get(*key))
            && settings["approvalPolicy"] == security["approvalPolicy"]
            && settings["approvalsReviewer"] == security["approvalsReviewer"]
            && settings["activePermissionProfile"]["id"] == security["permissions"]
            && !settings["settingsVersion"].is_null(),
        "Native application does not match the admitted permission profile."
    );
    Ok(
        json!({"effectiveId":transition["effectiveId"],"settingsVersion":settings["settingsVersion"]}),
    )
}

impl Delivery {
    pub(super) fn register_source(&self, source: &Arc<Source>) -> Result<()> {
        let bound = source.encryption_scope()?;
        let chat = id(&source.permission_source()["chatId"], "permission chat")?;
        let mut sources = self.sources.lock().unwrap();
        sources.retain(|_, source| source.strong_count() != 0);
        sources.insert((self.directory(&bound), chat), Arc::downgrade(source));
        Ok(())
    }

    pub(super) fn permission_published(
        &self,
        event_path: &Path,
        event: &Value,
        result: &Value,
    ) -> Result<()> {
        let applied = event["kind"] == "applied" && !event["permissionPolicy"].is_null();
        let rejected = event["kind"] == "rejected" && result["application"]["status"] == "rejected";
        if !applied && !rejected {
            return Ok(());
        }
        let directory = event_path
            .parent()
            .context("Missing settings evidence directory.")?;
        let marker = directory.join(marker_name(event));
        let Some(record) = read_registration(&marker, &self.worker)? else {
            return Ok(());
        };
        ensure!(
            [
                "operationId",
                "operationGeneration",
                "threadId",
                "runtimeGeneration",
                "nativeOperationId"
            ]
            .iter()
            .all(|key| record["scope"][*key] == event[*key]),
            "Published permission evidence differs from its registration."
        );
        if rejected {
            return remove(&marker);
        }
        let chat = id(&record["scope"]["chatId"], "permission chat")?;
        let current = self
            .sources
            .lock()
            .unwrap()
            .get(&(directory.to_path_buf(), chat))
            .and_then(Weak::upgrade);
        let Some(current) = current else {
            return Ok(());
        };
        if current.assert_current().is_err() {
            return Ok(());
        }
        let original = &record["permission"]["source"];
        let current_source = current.permission_source();
        if !same_source(original, &current_source) {
            return Ok(());
        }
        let recovery = !event["recoveryBindingId"].is_null();
        if recovery {
            let binding = current.binding.lock().unwrap();
            if !binding.as_ref().is_some_and(|binding| {
                binding["bindingId"] == event["recoveryBindingId"]
                    && binding["nativeEpoch"]
                        == event["permissionPolicy"]["settingsVersion"]["epoch"]
            }) {
                return Ok(());
            }
        } else if original["runtimeGeneration"] != current_source["runtimeGeneration"] {
            return Ok(());
        }
        if result["permissionPolicyPublished"] == true
            && result["application"]["status"] == "applied"
        {
            current.confirm_permission(&event["permissionPolicy"]["effectiveId"]);
        } else if !recovery && result["application"]["status"] == "applied" {
            current.wake();
        }
        Ok(())
    }

    pub(super) async fn recover_permissions(
        self: &Arc<Self>,
        source: &Arc<Source>,
        binding: &Value,
        recovered: &mut HashSet<(JsString, PathBuf)>,
    ) -> Result<bool> {
        let bound = source.encryption_scope()?;
        let directory = self.directory(&bound);
        let mut entries = match tokio::fs::read_dir(&directory).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        let binding_id = id(&binding["bindingId"], "permission recovery binding")?;
        recovered.retain(|(id, _)| id == &binding_id);
        let mut pending = false;
        while let Some(entry) = entries.next_entry().await? {
            let marker = entry.path();
            if !marker
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".pending.json"))
            {
                continue;
            }
            if self.live.lock().unwrap().contains(&marker) {
                continue;
            }
            let identity = (binding_id.clone(), marker.clone());
            if recovered.contains(&identity) {
                continue;
            }
            let Some(record) = read_registration(&marker, &self.worker)? else {
                continue;
            };
            let original = &record["permission"]["source"];
            if !same_source(original, binding) {
                continue;
            }
            let operation_owner = source.encryption_scope()?;
            if !self.live.lock().unwrap().insert(marker.clone()) {
                continue;
            }
            let registration = Registration {
                delivery: self.clone(),
                bound: operation_owner,
                identity: record["scope"].clone(),
                marker,
                directory: directory.clone(),
                permission: Some(Change {
                    transition: record["permission"]["transition"].clone(),
                    epoch: binding["nativeEpoch"].clone(),
                    source: source.clone(),
                    binding: binding["bindingId"].clone(),
                }),
                reconcile: false,
            };
            if registration.reconcile_permission(binding).await? {
                recovered.insert(identity);
            } else {
                pending = true;
            }
            bound.identity()?;
        }
        Ok(pending)
    }
}

impl Registration {
    async fn reconcile_permission(&self, binding: &Value) -> Result<bool> {
        let change = self
            .permission
            .as_ref()
            .context("Missing permission registration.")?;
        let source = &change.source;
        let runtime = source.runtime()?;
        let params = json!({"threadId":self.identity["threadId"],"operationId":self.identity["nativeOperationId"]});
        let old_runtime = self.identity["runtimeGeneration"] != binding["runtimeGeneration"];
        let result = runtime
            .request(
                READ.into(),
                Some(params.clone()),
                Some(Duration::from_secs(30)),
                None,
            )
            .await;
        source.assert_current()?;
        let journal = match result {
            Ok(result) => result.context("Missing native permission journal.")?,
            Err(error) if proves_absence(&error, &params) => {
                if old_runtime {
                    self.record("rejected", &Value::Null, &json!({"reason":"native-journal-proved-operation-absent","nativeError":error.downcast_ref::<Failure>().unwrap().native_error}))?;
                }
                return Ok(old_runtime);
            }
            Err(error) => return Err(error),
        };
        ensure!(
            journal["threadId"] == params["threadId"]
                && journal["operationId"] == params["operationId"],
            "Native permission journal returned another operation."
        );
        id(&journal["submissionId"], "permission journal submission")?;
        let submission = &journal["submissionId"];
        match journal["phase"].as_str() {
            Some("pending") => return Ok(false),
            Some("rejected") => {
                self.record("rejected", submission, &journal)?;
                return Ok(true);
            }
            Some("applied") => {}
            _ => bail!("Native permission journal returned an unknown phase."),
        }
        let security = &journal["resolvedSecurity"];
        let original = claim(&change.transition, &journal["threadSettings"], security)?;
        if old_runtime {
            // Historical application has no authority over the current native epoch.
            self.record_evidence("applied", submission, &journal, Some(&original), None)?;
        }
        let current = source.read_current().await?;
        let Ok(confirmed) = claim(&change.transition, &current, security) else {
            return Ok(true);
        };
        ensure!(
            confirmed["settingsVersion"]["epoch"] == binding["nativeEpoch"],
            "Permission recovery returned another native epoch."
        );
        self.record_evidence(
            "applied",
            submission,
            &json!({"journal":journal,"currentSettings":current}),
            Some(&confirmed),
            Some(&binding["bindingId"]),
        )?;
        Ok(true)
    }
}

fn same_source(left: &Value, right: &Value) -> bool {
    SCOPE.iter().all(|key| left.get(*key) == right.get(*key))
}

fn proves_absence(error: &anyhow::Error, expected: &Value) -> bool {
    error.downcast_ref::<Failure>().is_some_and(|error| {
        error.request_method.as_ref().and_then(JsString::as_str) == Some(READ)
            && error.native_error.as_ref().is_some_and(|native| {
                native["code"].as_f64() == Some(-32004.0)
                    && native["data"] == json!({"reason":"settingsOperationNotFound","threadId":expected["threadId"],"operationId":expected["operationId"]})
            })
    })
}

fn read_registration(path: &Path, worker: &JsString) -> Result<Option<Value>> {
    let record = match read_json(path) {
        Ok(value) => value,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == ErrorKind::NotFound) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let Some(permission) = record.get("permission") else {
        return Ok(None);
    };
    let scope = &record["scope"];
    let recovery = checked("nativeSettingsEvidenceSchema", &record["recovery"])?;
    checked("permissionTransitionSchema", &permission["transition"])?;
    let source = &permission["source"];
    let mut binding = source.clone();
    binding["bindingId"] = json!("registration");
    binding["nativeEpoch"] = json!("registration");
    checked("nativeSettingsBindingSchema", &binding)?;
    ensure!(
        path.file_name().and_then(|name| name.to_str()) == Some(&marker_name(scope))
            && source["workerId"].as_js_string() == Some(worker)
            && recovery["workerId"].as_js_string() == Some(worker)
            && recovery["kind"] == "transport-lost"
            && ["chatId", "threadId", "runtimeGeneration"]
                .iter()
                .all(|key| source[*key] == scope[*key])
            && [
                "operationId",
                "operationGeneration",
                "threadId",
                "runtimeGeneration",
                "nativeOperationId"
            ]
            .iter()
            .all(|key| recovery[*key] == scope[*key]),
        "Native permission registration scope mismatch."
    );
    Ok(Some(record))
}
