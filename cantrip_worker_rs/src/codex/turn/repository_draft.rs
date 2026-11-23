use super::{Turns, id, output};
use crate::{
    codex::{
        admission::{Acquire, Execution},
        managed::Runtime,
        observation::provider,
        preparation::{
            Identify, Intent, Selection,
            native::{self, Configuration, LoadedThread},
        },
        rpc_requests::Failure,
    },
    filesystem::{Scope, paths},
    git::draft,
    github::Client,
    http::checked,
    inference::admission::Source,
    metadata::Signal,
    protected_secrets::open_runtime_provider,
};
use anyhow::{Context, Result, bail};
use cantrip_wire::{JsString, Value, parse_json_text, payload_digest, value::json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(120);

struct Draft<'a> {
    turns: &'a Turns,
    command: &'a Value,
    bound: (JsString, Value),
    target: Value,
    signal: Signal,
}

impl Turns {
    pub(crate) async fn repository_draft(
        &self,
        command: &Value,
        arguments: &Value,
        github: &Client,
        scope: &Scope,
        signal: Signal,
    ) -> Result<(Value, Value)> {
        let draft = Draft {
            turns: self,
            command,
            bound: self.encryption.bound_identity()?,
            target: json!({"kind":"project","projectId":command["projectId"]}),
            signal,
        };
        draft.authorize().await?;
        let input = checked("gitAgentDraftCreateSchema", arguments)?;
        let runtimes = command["agentRuntimes"]
            .as_array()
            .context("Invalid repository agent routes.")?;
        if runtimes.is_empty() || command["modelId"].is_null() {
            bail!("No model route is available for Git assistance.");
        }
        if !input["modelId"].is_null() && input["modelId"] != command["modelId"] {
            bail!("Repository agent model selection does not match.");
        }
        let cwd = paths::native(&id(&command["cwd"], "repository working directory")?);
        let prompt = draft::prompt(command, &input, github, &cwd, scope).await?;
        let mcp = self.preparation.repository_draft_mcp(command).await?;
        let mut last_error = None;
        for route in runtimes {
            draft.assert_bound()?;
            match draft.generate(route, &prompt, &mcp).await {
                Ok((value, execution)) => {
                    draft.authorize().await?;
                    let result = checked(
                        "gitAgentDraftResultSchema",
                        &json!({
                            "generationId":command["operationId"],"task":input["task"],"text":value["text"],
                            "modelId":command["modelId"],"modelName":route["model"]["name"],
                            "providerName":route["provider"]["name"],"worktreeId":command["worktreeId"],
                            "generatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                        }),
                    )?;
                    return Ok((result, execution));
                }
                Err(error) => last_error = Some(error),
            }
        }
        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("No model route generated a draft.")))
    }
}

impl Draft<'_> {
    fn assert_bound(&self) -> Result<()> {
        self.signal.check()?;
        if self.command["serverId"] != self.bound.1
            || self.turns.encryption.bound_identity()? != self.bound
        {
            bail!("The worker binding changed during Git draft generation.");
        }
        Ok(())
    }

    async fn authorize(&self) -> Result<()> {
        self.assert_bound()?;
        self.turns
            .task_inputs
            .authorize_resource(&self.bound, &self.target, self.signal.clone())
            .await?;
        self.assert_bound()
    }

    async fn generate(
        &self,
        route: &Value,
        prompt: &JsString,
        mcp: &Value,
    ) -> Result<(Value, Value)> {
        let opened = open_runtime_provider(&self.turns.encryption, &route["provider"])?;
        let provider_name = provider::model_provider(&opened);
        let model = &route["model"];
        let runtime = self
            .turns
            .preparation
            .helper_runtime(model, opened, &self.bound)
            .await?;
        self.assert_bound()?;
        let operation = &self.command["operationId"];
        let source = Source::claimed(
            payload_digest(&json!([
                json!("repository-draft"),
                operation.clone(),
                route["routeId"].clone()
            ]))
            .into(),
            Some(self.signal.clone()),
        );
        let admission = runtime.admission();
        let result = async {
            let mut acquire = Acquire::new(
                admission.lifetime_for_source(&source)?,
                route["provider"].clone(),
            );
            acquire.project_id = Some(self.command["projectId"].clone());
            acquire.signal = Some(source.signal());
            acquire.recovery_key =
                Some(json!(format!("operation:{}", operation.as_str().unwrap())));
            let execution = admission.acquire(acquire).await?;
            let thread = self.open_thread(&runtime, model, provider_name, mcp).await;
            let (thread, result) = match thread {
                Ok(thread) => {
                    let result = self
                        .collect(&runtime, &execution, thread.id(), model, prompt)
                        .await;
                    (Some(thread), result)
                }
                Err(error) => (None, Err(error)),
            };
            execution.not_dispatched()?;
            execution.settled().await?;
            if let Some(thread) = thread {
                let _ = runtime
                    .request(
                        "thread/unsubscribe".into(),
                        Some(json!({"threadId":thread.id()})),
                        Some(Duration::from_secs(10)),
                        None,
                    )
                    .await;
            }
            result
        }
        .await;
        source.close();
        let completed = result?;
        let output = parse_json_text(
            completed["text"]
                .as_str()
                .context("Codex returned no Git draft text.")?,
        )
        .map_err(|_| anyhow::anyhow!("Codex returned invalid structured Git draft output."))?;
        let output = checked("gitAgentDraftModelOutputSchema", &output)?;
        Ok((
            output,
            json!({"routeId":route["routeId"],"turnId":completed["turnId"],"measuredUsage":completed["measuredUsage"]}),
        ))
    }

    async fn open_thread(
        &self,
        runtime: &Runtime,
        model: &Value,
        provider: &str,
        mcp: &Value,
    ) -> Result<LoadedThread> {
        let cwd = &self.command["cwd"];
        let mut start = json!({
            "cwd":cwd,"runtimeWorkspaceRoots":vec![cwd.clone()],"model":model["name"],"modelProvider":provider,
            "developerInstructions":draft::INSTRUCTIONS,"approvalPolicy":"never","sandbox":"read-only",
            "config":json!({"mcp_servers":mcp}),
        });
        if !model["reasoningEffort"].is_null() {
            start["effort"] = model["reasoningEffort"].clone();
        }
        let runner = format!("helper:{}", uuid::Uuid::new_v4());
        let configuration = Configuration {
            start,
            configure_existing: json!({}),
            managed_overlay: Some(json!({
                "mcpServers":mcp,"developerInstructions":draft::INSTRUCTIONS,
                "multiAgentEnabled":true,"subagentModel":Value::Null,"subagentReasoningEffort":Value::Null,
                "canonicalHistory":false,"executionGate":json!({"runnerGeneration":runner}),
            })),
            expected_suspension: None,
        };
        let identify: Identify = Arc::new(|_| Box::pin(async { Ok(()) }));
        native::load(
            runtime,
            &Selection {
                thread_id: None,
                intent: Intent::Preserve,
                replacement_settings: None,
            },
            &configuration,
            &identify,
        )
        .await
    }

    async fn collect(
        &self,
        runtime: &Runtime,
        execution: &Execution,
        thread: &JsString,
        model: &Value,
        prompt: &JsString,
    ) -> Result<Value> {
        let started = Instant::now();
        let (subscription, mut events, _) = output::subscribe(&runtime.history(), thread)?;
        let signal = Signal::any(vec![self.signal.clone(), subscription.signal()]);
        let result = async {
            let cwd = &self.command["cwd"];
            let mut params = json!({
                "threadId":thread,"cwd":cwd,"runtimeWorkspaceRoots":vec![cwd.clone()],"model":model["name"],
                "clientUserMessageId":format!("cantrip:operation:{}", self.command["operationId"].as_str().unwrap()),
                "approvalPolicy":"never","sandboxPolicy":json!({"type":"readOnly","networkAccess":false}),
                "input":vec![json!({"type":"text","text":prompt,"text_elements":Vec::<Value>::new()})],
                "outputSchema":json!({"type":"object","additionalProperties":false,
                    "properties":json!({"text":json!({"type":"string"})}),"required":vec!["text"]}),
            });
            if !model["reasoningEffort"].is_null() {
                params["effort"] = model["reasoningEffort"].clone();
            }
            execution.bind_thread(thread.clone())?;
            execution.seal_input_dispatch().await?;
            self.authorize().await?;
            execution.dispatched()?;
            let response = match runtime.request("turn/start".into(), Some(params), Some(TIMEOUT), None).await {
                Ok(Some(response)) => response,
                Err(error) if error.downcast_ref::<Failure>().is_some_and(|failure| failure.native_error.is_some()) => {
                    execution.rejected()?;
                    return Err(error);
                }
                // The transport lost its reply. Adopt only a start observed
                // on this newly allocated operation thread.
                _ => {
                    let turn = tokio::time::timeout(TIMEOUT, output::started(&mut events, &signal)).await
                        .context("Codex did not acknowledge the Git draft turn.")??;
                    json!({"turn":json!({"id":turn})})
                }
            };
            let turn = id(&response["turn"]["id"], "Git draft turn identity")?;
            execution.bind_turn(turn.clone())?;
            let emit: super::Emit = Arc::new(|_| Ok(()));
            let mut completed = tokio::time::timeout(TIMEOUT, output::collect(&mut events, &signal, thread, &turn, &emit)).await
                .context("Agent operation timed out after 120000ms.")??.result?;
            let mut measured = completed["measuredUsage"].clone();
            if measured.is_null() {
                measured = json!({});
            }
            measured["durationMs"] = json!(started.elapsed().as_millis() as u64);
            completed["measuredUsage"] = cantrip_protocol::parse_property(
                "agentTurnResultSchema", "measuredUsage", &measured,
            ).map_err(cantrip_protocol::response::response_error)?;
            Ok(completed)
        }.await;
        if result.is_err() {
            execution.revoke("The Git draft did not complete.")?;
        }
        subscription.close();
        result
    }
}
