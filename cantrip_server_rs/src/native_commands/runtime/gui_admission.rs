//! GUI input uses the native journal and exact protected input digest. Legacy
//! execution retains its own lane path; it must not invent a native receipt.
use crate::{
    chats::{execution_lanes::LaneRepository, managed_console},
    database::Database,
    native_commands::{CommandError, Repository, admit::text},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Result, bail};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Clone)]
pub struct GuiAdmission {
    commands: Repository,
    lanes: LaneRepository,
}
fn nullish<'a>(value: Option<&'a Value>, fallback: &'a Value) -> &'a Value {
    value.filter(|v| !v.is_null()).unwrap_or(fallback)
}
impl GuiAdmission {
    pub fn new(database: Arc<Database>) -> Self {
        Self {
            commands: Repository::new(database.clone()),
            lanes: LaneRepository::new(database),
        }
    }
    pub async fn acquire(
        &self,
        owner: &str,
        context: &Value,
        options: &Value,
        protected_input: Option<&Value>,
    ) -> Result<Value> {
        self.acquire_observed(owner, context, options, protected_input, None)
            .await
    }
    pub async fn acquire_observed(
        &self,
        owner: &str,
        context: &Value,
        options: &Value,
        protected_input: Option<&Value>,
        observer: Option<&crate::chats::turn_runtime::stages::Observer>,
    ) -> Result<Value> {
        let managed = managed_console::session_context(context).is_some();
        if managed && !truthy(protected_input) {
            bail!("Chat turn content was not encrypted.");
        }
        let native = if managed {
            let protected = protected_input.unwrap();
            let mut identity = vec![
                json!(owner),
                context["chatId"].clone(),
                protected["idempotencyKey"].clone(),
            ];
            if truthy(options.get("managedQueueClaim")) {
                identity.push(options["managedQueueClaim"]["id"].clone());
            }
            let operation = format!(
                "gui:{:x}",
                Sha256::digest(Value::Array(identity).stringify().as_bytes())
            );
            let digest = format!("{:x}", Sha256::digest(protected.stringify().as_bytes()));
            let input = json!({
                "workerId":context["workerId"],"operationId":operation,"origin":"gui","method":"turn/start",
                "session":json!({"chatId":context["chatId"],"threadId":context["threadId"],"contextKind":context["contextKind"],"projectId":context["projectId"],"placementId":nullish(context.get("worktreeId"),&context["scratchRootId"]),"modelRouteId":context["modelRouteId"],"providerAccountId":context["providerAccountId"],"runtimeGeneration":Value::Null,"connectionId":Value::Null}),
                "payloadDigest":digest,"protectedPayload":protected["protectedContent"]["envelope"],"expectedActivationGeneration":Value::Null,
                "intent":json!({"scope":"thread","settingKeys":Vec::<Value>::new(),"expectedTurnId":Value::Null,"permissionProfileId":managed_console::permission_profile(context)["effectiveId"]})
            });
            let mut admission_options = json!({"clientMessageId":protected["id"],"expectedInputRevision":nullish(options.get("expectedInputRevision"),&context["managedInputRevision"])});
            for (source, target) in [
                ("acquiringActor", "acquiringActor"),
                ("purpose", "purpose"),
                ("managedQueueClaim", "queueClaim"),
            ] {
                if let Some(value) = options.get(source) {
                    admission_options[target] = value.clone();
                }
            }
            let commands = self.commands.clone();
            let owner = owner.to_owned();
            let operation = async move { commands.admit(&owner, &input, &admission_options).await };
            Some(match observer {
                Some(observer) => observer.run("acquire-execution-lane", operation).await?,
                None => operation.await?,
            })
        } else {
            None
        };
        if native
            .as_ref()
            .is_some_and(|value| truthy(value.get("replayed")))
        {
            bail!("This chat input already has a native operation receipt.");
        }
        let execution = if let Some(native) = &native {
            native["execution"].clone()
        } else {
            let lanes = self.lanes.clone();
            let (owner, chat, actor, purpose) = (
                owner.to_owned(),
                text(&context["chatId"])?,
                text(nullish(options.get("acquiringActor"), &json!("user")))?,
                text(nullish(options.get("purpose"), &json!("Chat turn")))?,
            );
            let operation = async move { lanes.start(&owner, &chat, &actor, &purpose).await };
            match observer {
                Some(observer) => observer.run("acquire-execution-lane", operation).await?,
                None => operation.await?,
            }
            .unwrap_or(Value::Null)
        };
        let receipt = native.as_ref().map(|v| v["receipt"].clone());
        if receipt.as_ref().is_some_and(|r| r["status"] != "accepted")
            || !truthy(execution.get("executionLaneId"))
        {
            let code = receipt
                .as_ref()
                .and_then(|r| r.get("rejectionCode"))
                .filter(|v| !v.is_null())
                .map(text)
                .transpose()?
                .unwrap_or_else(|| "Chat execution lane could not be acquired.".into());
            return Err(CommandError::new(code, None, 409).into());
        }
        let mut result = json!({"execution":execution});
        if let Some(receipt) = receipt {
            result["nativeCommandReceipt"] = receipt;
        }
        Ok(result)
    }
}
