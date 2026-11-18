//! Goal metadata uses its native thread and the existing GUI admission route.
use super::{read::target_thread, *};
use crate::{
    chat_content::Scope,
    codex::{
        preparation::command::{LiveThread, native_session},
        turn::{Turns, runtime_text},
    },
    native_items::array,
};
use cantrip_history::{canonical::open_message, content::Encryption};

impl Goals {
    pub(crate) async fn update(&self, command: &Value, turns: &Turns) -> Result<Value> {
        if command["osExecution"].is_object() || command["session"]["osExecution"].is_object() {
            bail!("Native control of an OS-hosted Goal is unavailable.");
        }
        let bound = self.encryption.bound_identity()?;
        let thread = target_thread(command)?;
        let mut params = json!({"threadId":thread});
        if let Some(status) = command.get("status") {
            params["status"] = status.clone();
        }
        if let Some(objective) = command.get("protectedObjective") {
            params["objective"] = json!(self.open_edit(&bound, objective)?);
        }
        let value = self
            .mutate(command, turns, &bound, "thread/goal/set", params)
            .await?;
        let goal = verify_goal(thread, &value)?;
        self.render(command, &bound, goal, None)
    }

    pub(crate) async fn clear(&self, command: &Value, turns: &Turns) -> Result<Value> {
        if command["session"]["osExecution"].is_object() {
            bail!("Native control of an OS-hosted Goal is unavailable.");
        }
        let bound = self.encryption.bound_identity()?;
        let thread = target_thread(command)?;
        let value = self
            .mutate(
                command,
                turns,
                &bound,
                "thread/goal/clear",
                json!({"threadId":thread}),
            )
            .await?;
        checked("chatGoalClearSchema", &value)
    }

    async fn mutate(
        &self,
        command: &Value,
        turns: &Turns,
        bound: &(JsString, Value),
        method: &'static str,
        params: Value,
    ) -> Result<Value> {
        let thread = target_thread(command)?;
        let managed = command["session"].is_object();
        if managed && command["session"]["chatId"] != command["chatId"] {
            bail!("The Goal mutation belongs to another managed conversation.");
        }
        let LiveThread { runtime, session } = if command["status"] == "active"
            && command["taskContext"].is_object()
            && command["taskRuntime"].is_object()
        {
            let prepared = self.prepare_task_resume(command).await?;
            LiveThread {
                session: managed.then(|| native_session(command, &prepared.runtime, thread)),
                runtime: prepared.runtime,
            }
        } else {
            self.metadata_thread(command, bound, thread).await?
        };
        self.watch_project(command, bound, thread, &runtime);
        let session =
            session.or_else(|| managed.then(|| native_session(command, &runtime, thread)));
        self.apply_mutation(
            command,
            turns,
            bound,
            LiveThread { runtime, session },
            method,
            params,
        )
        .await
    }

    pub(super) async fn apply_mutation(
        &self,
        command: &Value,
        turns: &Turns,
        bound: &(JsString, Value),
        owner: LiveThread,
        method: &'static str,
        params: Value,
    ) -> Result<Value> {
        if &self.encryption.bound_identity()? != bound {
            bail!("The worker binding changed before Goal mutation.");
        }
        let result = if let Some(session) = owner.session {
            turns
                .goal_mutation(&owner.runtime, bound, command, session, method, params)
                .await?
        } else {
            rpc(&owner.runtime, method, params).await?
        };
        if &self.encryption.bound_identity()? != bound {
            bail!("The worker binding changed during Goal mutation.");
        }
        Ok(result)
    }

    async fn prepare_task_resume(&self, command: &Value) -> Result<Prepared> {
        let target = &command["taskRuntime"];
        let mut prepare = command.clone();
        if !prepare["session"].is_object() {
            prepare["session"] = json!({
                "contextKind":"project","chatId":command["chatId"],"projectId":target["projectId"],
                "worktreeId":target["worktreeId"],"rootKind":target["rootKind"],"scratchRootId":Value::Null,
                "computerUseEnabled":target["computerUseEnabled"],
            });
        }
        prepare["taskOwned"] = json!(true);
        prepare["taskGoalPermissions"] = json!(true);
        prepare["taskGoalFirstInput"] = command["taskContext"]["message"]["id"].clone();
        if prepare["planMode"].is_null() {
            prepare["planMode"] = json!("default");
        }
        if prepare["mcpServers"].is_null() {
            prepare["mcpServers"] = json!(Vec::<Value>::new());
        }
        self.preparation.prepare(&prepare, Intent::Configure).await
    }

    fn open_edit(&self, bound: &(JsString, Value), objective: &Value) -> Result<JsString> {
        let scope = Scope::new(self.encryption.clone())?;
        if scope.owner != bound.0 || bound.1.as_js_string() != Some(&scope.server) {
            bail!("The worker binding changed while opening the Goal edit.");
        }
        let grant = scope.material(None)?;
        let content = open_message(&grant.key, &json!(grant.owner_id), objective)?;
        let text = join(
            array(&content)?
                .iter()
                .filter(|item| item["type"] == "text")
                .map(runtime_text)
                .collect::<Result<Vec<_>>>()?,
            "\n\n",
        )
        .trim();
        if text.is_empty() {
            Ok("Review the attached files and respond to the user.".into())
        } else {
            Ok(text)
        }
    }
}
