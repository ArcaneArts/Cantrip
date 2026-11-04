use super::{Repository, checked, text};
use crate::auth::service::AuthService;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

pub struct Coordinator {
    pub repository: Repository,
    service: Arc<AuthService>,
}
fn core_scope(scope: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for key in [
        "ownerId",
        "workerId",
        "serverId",
        "instanceId",
        "guestInstanceId",
        "attachmentGeneration",
        "runtimeGeneration",
    ] {
        result.insert(key.into(), scope[key].clone());
    }
    Value::Object(result)
}
impl Coordinator {
    pub fn new(service: Arc<AuthService>) -> Self {
        Self {
            repository: Repository::new(service.repository.database.clone()),
            service,
        }
    }
    async fn request(&self, worker: &str, command: Value, schema: &str) -> Result<Value> {
        let response = self
            .service
            .workers
            .commands
            .request(
                worker,
                crate::wire::Value::from_serialize(&command),
                Some(Duration::from_secs(600)),
                None,
            )
            .await?;
        let response = crate::settings::parse_response(schema, response.as_ref())?;
        Ok(serde_json::from_str(&response.stringify())?)
    }
    fn scope(&self, owner: &str, instance: &Value) -> Result<Value> {
        checked(
            "cantripOsDispatchScopeSchema",
            json!({"ownerId":owner,"serverId":self.service.server_id,"workerId":instance["workerId"],"instanceId":instance["id"],"guestInstanceId":instance["guestInstanceId"],"attachmentGeneration":instance["attachmentGeneration"],"runtimeGeneration":instance["runtimeGeneration"]}),
        )
    }
    async fn source(&self, owner: &str, project: &str, id: &str) -> Result<Value> {
        let mut context = self.repository.context(owner, project, id).await?;
        let mut scope = self.scope(owner, &context["instance"])?;
        let b = &context["binding"];
        let w = &context["workspace"];
        for (key, value) in [
            ("bindingId", b["id"].clone()),
            ("bindingGeneration", b["bindingGeneration"].clone()),
            ("projectId", b["projectId"].clone()),
            ("projectSourceId", b["projectSourceId"].clone()),
            ("worktreeId", b["worktreeId"].clone()),
            ("sourceKind", context["sourceKind"].clone()),
            (
                "repositoryFingerprint",
                context["repositoryFingerprint"].clone(),
            ),
            ("workspaceId", w["id"].clone()),
            ("guestWorkspaceId", w["guestWorkspaceId"].clone()),
            ("uid", w["uid"].clone()),
            ("gid", w["gid"].clone()),
            ("homeGuestPath", w["homeGuestPath"].clone()),
            ("guestPath", b["guestPath"].clone()),
            ("mode", b["mode"].clone()),
            ("linkedWorkerPath", b["linkedWorkerPath"].clone()),
            ("dependencyOverlays", b["dependencyOverlays"].clone()),
        ] {
            scope[key] = value;
        }
        context["scope"] = checked("cantripOsSourceDispatchScopeSchema", scope)?;
        Ok(context)
    }
    pub async fn inspect(&self, owner: &str, input: &Value) -> Result<Value> {
        self.repository
            .owned_worker(owner, text(input, "workerId")?)
            .await?;
        self.request(text(input,"workerId")?,json!({"type":"cantrip-os.inspect","ownerId":owner,"workerId":input["workerId"],"transport":input["transport"]}),"cantripOsObservedInstanceSchema").await
    }
    pub async fn attach(&self, owner: &str, input: &Value) -> Result<Value> {
        let actual = self.inspect(owner, input).await?;
        ensure!(
            actual["guestInstanceId"] == input["guestInstanceId"],
            "The selected transport points to a different OS instance."
        );
        ensure!(
            actual["attachment"].is_null()
                || (actual["attachment"]["ownerId"] == owner
                    && actual["attachment"]["workerId"] == input["workerId"]),
            "The OS is attached elsewhere; explicitly detach it on that OS first."
        );
        let admitted = self.repository.attach(owner, input).await?;
        let mut observed = admitted.clone();
        observed["runtimeGeneration"] = actual["runtimeGeneration"].clone();
        let result:Result<Value>=async {
            self.request(text(input,"workerId")?,json!({"type":"cantrip-os.attach","scope":self.scope(owner,&observed)?,"transport":input["transport"]}),"cantripOsObservedInstanceSchema").await?;
            self.refresh(owner,text(&admitted,"id")?).await
        }.await;
        if result.is_err() {
            self.repository
                .observe_current(
                    owner,
                    text(&admitted, "id")?,
                    text(&admitted, "attachmentGeneration")?,
                    "unknown",
                    None,
                    Some("Attachment delivery is uncertain; refresh the OS before continuing."),
                    None,
                )
                .await?;
        }
        result
    }
    pub async fn refresh(&self, owner: &str, id: &str) -> Result<Value> {
        let attachment = self.repository.attachment(owner, id).await?;
        let i = &attachment["instance"];
        let result:Result<Value>=async {
            let actual=self.inspect(owner,&json!({"workerId":i["workerId"],"transport":attachment["transport"]})).await?;
            ensure!(actual["guestInstanceId"]==i["guestInstanceId"] && actual["attachment"]["ownerId"]==owner && actual["attachment"]["workerId"]==i["workerId"],"The OS identity or attachment changed.");
            for workspace in actual["workspaces"].as_array().context("OS workspace observation")? {
                self.repository.record_workspace(owner,id,text(i,"attachmentGeneration")?,workspace).await?;
            }
            let instance=self.repository.observe_current(owner,id,text(i,"attachmentGeneration")?,"connected",Some(text(&actual,"runtimeGeneration")?),None,i["runtimeGeneration"].as_str()).await?;
            Ok(json!({"instance":instance,"workspaces":self.repository.workspaces(owner,id).await?}))
        }.await;
        if result.is_err() {
            self.repository
                .observe_current(
                    owner,
                    id,
                    text(i, "attachmentGeneration")?,
                    "unknown",
                    None,
                    Some("The executor could not be observed. No host fallback was attempted."),
                    i["runtimeGeneration"].as_str(),
                )
                .await?;
        }
        result
    }
    pub async fn create_workspace(&self, owner: &str, id: &str, input: &Value) -> Result<Value> {
        let attachment = self.repository.attachment(owner, id).await?;
        let i = &attachment["instance"];
        let result=self.request(text(i,"workerId")?,json!({"type":"cantrip-os.workspaces.create","scope":self.scope(owner,i)?,"transport":attachment["transport"],"guestWorkspaceId":input["guestWorkspaceId"],"operationId":input["operationId"]}),"cantripOsOperationResultSchema").await?;
        if result["state"] == "ready" && result["receipt"]["kind"] == "workspace" {
            self.repository
                .record_workspace(
                    owner,
                    id,
                    text(i, "attachmentGeneration")?,
                    &result["receipt"]["workspace"],
                )
                .await?;
        }
        Ok(result)
    }
    pub async fn provision(
        &self,
        owner: &str,
        project: &str,
        id: &str,
        input: &Value,
    ) -> Result<Value> {
        let context = self.source(owner, project, id).await?;
        let (admission, created) = self
            .repository
            .admit(owner, &context["scope"], input)
            .await?;
        let command = if created {
            json!({"type":"cantrip-os.source.provision","scope":admission["scope"],"transport":context["transport"],"operationId":admission["operation_id"],"protectedRequest":admission["protected_request"]})
        } else {
            json!({"type":"cantrip-os.operation.inspect","scope":core_scope(&admission["scope"]),"operationId":admission["operation_id"]})
        };
        let result = self
            .request(
                text(&context["instance"], "workerId")?,
                command,
                "cantripOsOperationResultSchema",
            )
            .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                self.repository.outcome(owner,&context["scope"],"unknown",Some("Provisioning delivery is uncertain; recover this operation without replaying it."),None).await?;
                return Err(error);
            }
        };
        self.apply(owner, project, id, result).await
    }
    pub async fn recover(&self, owner: &str, project: &str, id: &str) -> Result<Value> {
        let context = self.repository.context(owner, project, id).await?;
        let admission = self
            .repository
            .admission(owner, project, id)
            .await?
            .context("This source has no provisioning admission.")?;
        let result=self.request(text(&context["instance"],"workerId")?,json!({"type":"cantrip-os.operation.inspect","scope":core_scope(&admission["scope"]),"operationId":admission["operation_id"]}),"cantripOsOperationResultSchema").await?;
        self.apply(owner, project, id, result).await
    }
    async fn apply(&self, owner: &str, project: &str, id: &str, result: Value) -> Result<Value> {
        if result["state"] == "running" {
            return Ok(result);
        }
        let old = self.repository.context(owner, project, id).await?;
        let refreshed = match self.refresh(owner, text(&old["instance"], "id")?).await {
            Ok(observed) => observed,
            Err(_) => return Ok(result),
        };
        let current = self.source(owner, project, id).await?;
        let receipt = if result["receipt"]["kind"] == "source" {
            Some(&result["receipt"]["source"])
        } else {
            None
        };
        let ready = result["state"] == "ready"
            && receipt.is_some_and(|r| {
                r["runtimeGeneration"] == refreshed["instance"]["runtimeGeneration"]
            });
        self.repository
            .outcome(
                owner,
                &current["scope"],
                if ready {
                    "ready"
                } else if result["state"] == "failed" {
                    "failed"
                } else {
                    "unknown"
                },
                if ready {
                    None
                } else {
                    Some(result["error"].as_str().unwrap_or(
                        "The source needs read-only verification in the current runtime.",
                    ))
                },
                if ready { receipt } else { None },
            )
            .await?;
        Ok(result)
    }
    pub async fn verify(&self, owner: &str, project: &str, id: &str) -> Result<Value> {
        let context = self.source(owner, project, id).await?;
        let receipt=self.request(text(&context["instance"],"workerId")?,json!({"type":"cantrip-os.source.inspect","scope":context["scope"],"transport":context["transport"],"sourceKind":context["sourceKind"]}),"cantripOsSourceReceiptSchema").await?;
        self.repository
            .outcome(owner, &context["scope"], "ready", None, Some(&receipt))
            .await
    }
}
