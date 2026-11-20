//! Plan Mode reads observe loaded settings; writes wait for native application.
use super::*;
use crate::codex::{managed::Profile, rpc_requests::Failure};

pub(crate) const PLAN_GET: &str = "chat.plan.get";
pub(crate) const PLAN_SET: &str = "chat.plan.set";

impl Ensurer {
    pub(crate) async fn plan_mode(&self, command: &Value) -> Result<Value> {
        if command["type"] == PLAN_GET {
            return self.read_plan_mode(command).await;
        }
        let mode = &command["mode"];
        if command["session"].is_object() {
            if command["session"]["contextKind"] == "standalone" && mode != "default" {
                bail!("Standalone Chat supports only default conversation mode.");
            }
            let mut target = command.clone();
            target["planMode"] = mode.clone();
            if target["mcpServers"].is_null() {
                target["mcpServers"] = json!(Vec::<Value>::new());
            }
            let prepared = self.prepare(&target, Intent::Preserve).await?;
            self.assert_bound(&prepared.bound)?;
            return Ok(json!({"mode":mode,"threadId":prepared.thread.id()}));
        }

        let bound = self.identity()?;
        let (runtime, thread) = match self.plan_thread(command, &bound) {
            Some(target) => target,
            None => self.prepare_legacy_plan(command, &bound).await?,
        };
        self.assert_bound(&bound)?;
        profile::apply_plan_mode(&runtime, &thread, mode, &command["model"]).await?;
        self.assert_bound(&bound)?;
        Ok(json!({"mode":mode,"threadId":thread.id()}))
    }

    async fn read_plan_mode(&self, command: &Value) -> Result<Value> {
        let fallback = || json!({"mode":command["fallbackMode"],"threadId":command["threadId"]});
        let Some(id) = command["threadId"].as_js_string() else {
            return Ok(fallback());
        };
        let bound = self.identity()?;
        let (runtime, thread) = if let Some(target) = self.plan_thread(command, &bound) {
            target
        } else {
            let (profile, _) = self.legacy_plan_profile(command, &bound).await?;
            let Some(runtime) = self.0.codex.live_runtime(&profile.id)? else {
                return Ok(fallback());
            };
            let thread = LoadedThread::observe(&runtime, id);
            (runtime, thread)
        };
        let result = profile::read_plan_mode(&runtime, &thread).await;
        self.assert_bound(&bound)?;
        match result {
            Ok(mode) => Ok(json!({"mode":mode,"threadId":id})),
            Err(error)
                if error
                    .downcast_ref::<Failure>()
                    .and_then(|failure| failure.native_error.as_ref())
                    .is_some_and(|native| {
                        native["code"].as_i64() == Some(-32600)
                            && native["message"] == format!("thread not found: {id}")
                    }) =>
            {
                Ok(fallback())
            }
            Err(error) => Err(error),
        }
    }

    fn plan_thread(
        &self,
        command: &Value,
        bound: &(JsString, Value),
    ) -> Option<(Runtime, LoadedThread)> {
        let id = command["threadId"].as_js_string()?;
        let owners = self.0.live_threads.lock().unwrap();
        let mut matches = owners.values().filter(|owner| {
            &owner.bound == bound
                && owner.thread.id() == id
                && owner.model_route == command["model"]["routeId"]
                && owner.provider_id == command["provider"]["id"]
                && owner.provider_account == command["provider"]["accountId"]
        });
        let owner = matches.next().filter(|_| matches.next().is_none())?;
        let runtime = owner.runtime.upgrade()?;
        owner.thread.assert_current(&runtime).ok()?;
        Some((runtime, owner.thread.clone()))
    }

    // Older servers send only the native thread, route and workspace.
    // They select an account-scoped runtime without creating a managed attachment.
    async fn legacy_plan_profile(
        &self,
        command: &Value,
        bound: &(JsString, Value),
    ) -> Result<(Profile, Value)> {
        let provider = open_runtime_provider(&self.0.encryption, &command["provider"])?;
        let scope = json!({"serverId":bound.1,"ownerId":bound.0,"workerId":self.0.worker});
        let profile = home::profile(
            &self.0.data,
            &scope,
            home::Source::Current(command["threadId"].as_js_string()),
            None,
            &provider,
            "ide",
            self.0.skills.clone(),
            None,
        )
        .await?;
        self.assert_bound(bound)?;
        Ok((profile, provider))
    }

    async fn prepare_legacy_plan(
        &self,
        command: &Value,
        bound: &(JsString, Value),
    ) -> Result<(Runtime, LoadedThread)> {
        let command = self.resolve_routing(command).await?;
        let (profile, provider) = self.legacy_plan_profile(&command, bound).await?;
        let model_provider = provider::model_provider(&provider);
        let server = bound
            .1
            .as_js_string()
            .context("Unverified worker server identity")?;
        let runtime = self
            .0
            .codex
            .launch_in_scope(
                provider::launch(profile, provider, self.0.access.clone())?,
                Some((server.clone(), bound.0.clone())),
            )
            .await?;
        let configuration = profile::configuration(
            &command,
            &field(&command, "cwd")?,
            json!({}),
            None,
            model_provider,
            false,
            self.0.permission_profiles,
            None,
        )
        .await?;
        let identify: Identify = Arc::new(|_| Box::pin(async { Ok(()) }));
        let selection = Selection {
            thread_id: command["threadId"].as_js_string().cloned(),
            intent: Intent::Preserve,
            replacement_settings: None,
        };
        self.assert_bound(bound)?;
        let thread = native::load(&runtime, &selection, &configuration, &identify).await?;
        Ok((runtime, thread))
    }
}
