//! Settings provider checks run a real native turn under the provider's admission.
use super::{Emit, id, output};
use crate::{
    codex::{
        admission::{Acquire, Execution},
        managed::Runtime,
        observation::provider,
        preparation::{Identify, Intent, Selection, command::Ensurer, native},
        rpc_requests::Failure,
    },
    encryption::Service,
    filesystem::paths,
    http::checked,
    inference::admission::Source,
    metadata::Signal,
    protected_secrets::open_runtime_provider,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub(crate) const COMMAND: &str = "model.provider.test";
const TIMEOUT: Duration = Duration::from_secs(90);
const TIMEOUT_MESSAGE: &str = "Agent operation timed out after 90000ms.";
const INSTRUCTIONS: &str = "This is a provider connection check. Do not call tools or inspect files. Reply with exactly OK.";

pub(crate) async fn execute(
    command: &Value,
    preparation: &Ensurer,
    encryption: &Service,
    signal: Signal,
) -> Result<Value> {
    let began = Instant::now();
    let workspace = tempfile::Builder::new()
        .prefix("cantrip-provider-test-")
        .tempdir()?;
    let cwd = paths::text(workspace.path());
    let operation = Uuid::new_v4();
    let model = &command["model"];
    let bound = encryption.bound_identity()?;
    let opened = open_runtime_provider(encryption, &command["provider"])?;
    let model_provider = provider::model_provider(&opened);
    let runtime = preparation.helper_runtime(model, opened, &bound).await?;
    let source = Source::claimed(format!("operation:{operation}").into(), Some(signal));
    let result = async {
        let admission = runtime.admission();
        let mut request = Acquire::new(
            admission.lifetime_for_source(&source)?,
            command["provider"].clone(),
        );
        request.recovery_key = Some(json!(format!("operation:{operation}")));
        request.signal = Some(source.signal());
        let execution = admission.acquire(request).await?;
        let thread = async {
            source.signal().check()?;
            assert_bound(encryption, &bound)?;
            open_thread(&runtime, &cwd, model, model_provider, operation).await
        }
        .await;
        let (thread, result) = match thread {
            Ok(thread) => {
                let result = run(
                    &runtime,
                    &execution,
                    thread.id(),
                    &cwd,
                    model,
                    operation,
                    &source.signal(),
                    || assert_bound(encryption, &bound),
                )
                .await;
                (Some(thread), result)
            }
            Err(error) => (None, Err(error)),
        };
        // Release the inference ticket only on native settlement. A failed
        // read or command deadline may still have accepted an input.
        if result.is_err() {
            execution.revoke("The provider connection test did not complete.")?;
        }
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
    let text = result?;
    assert_bound(encryption, &bound)?;
    ensure!(
        !text.trim().is_empty(),
        "Provider inference completed without response text."
    );
    checked(
        "workerProviderConnectionTestResultSchema",
        &json!({
            "accepted":true, "durationMs":began.elapsed().as_millis() as u64,
        }),
    )
}

fn assert_bound(encryption: &Service, expected: &(JsString, Value)) -> Result<()> {
    ensure!(
        &encryption.bound_identity()? == expected,
        "The worker binding changed during the provider connection test."
    );
    Ok(())
}

async fn open_thread(
    runtime: &Runtime,
    cwd: &JsString,
    model: &Value,
    provider: &str,
    operation: Uuid,
) -> Result<native::LoadedThread> {
    let mut start = json!({
        "cwd":cwd,"runtimeWorkspaceRoots":vec![cwd],"model":model["name"],"modelProvider":provider,
        "ephemeral":true,"approvalPolicy":"never","sandbox":"read-only",
        "developerInstructions":INSTRUCTIONS,
        "config":json!({"features":json!({"shell_tool":false,"multi_agent":false}),"mcp_servers":json!({})}),
    });
    if !model["reasoningEffort"].is_null() {
        start["effort"] = model["reasoningEffort"].clone();
    }
    let configuration = native::Configuration {
        start,
        configure_existing: json!({}),
        managed_overlay: Some(json!({
            "mcpServers":json!({}),"developerInstructions":INSTRUCTIONS,
            "multiAgentEnabled":false,"subagentModel":Value::Null,"subagentReasoningEffort":Value::Null,
            "canonicalHistory":false,
            "executionGate":json!({"runnerGeneration":format!("helper:{operation}")}),
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

async fn run(
    runtime: &Runtime,
    execution: &Execution,
    thread: &JsString,
    cwd: &JsString,
    model: &Value,
    operation: Uuid,
    signal: &Signal,
    authorize: impl FnOnce() -> Result<()>,
) -> Result<JsString> {
    let (subscription, mut events, _) = output::subscribe(&runtime.history(), thread)?;
    let signal = Signal::any(vec![signal.clone(), subscription.signal()]);
    let result = tokio::time::timeout(TIMEOUT, async {
        let mut params = json!({
            "threadId":thread,"cwd":cwd,"runtimeWorkspaceRoots":vec![cwd],"model":model["name"],
            "clientUserMessageId":format!("cantrip:operation:{operation}"),"approvalPolicy":"never",
            "sandboxPolicy":json!({"type":"readOnly","networkAccess":false}),
            "input":vec![json!({"type":"text","text":"Reply with exactly OK.","text_elements":Vec::<Value>::new()})],
        });
        if !model["reasoningEffort"].is_null() {
            params["effort"] = model["reasoningEffort"].clone();
        }
        execution.bind_thread(thread.clone())?;
        execution.seal_input_dispatch().await?;
        signal.check()?;
        authorize()?;
        execution.dispatched()?;
        let reply = runtime.request("turn/start".into(), Some(params), Some(TIMEOUT), None).await;
        let turn = match reply {
            Ok(Some(reply)) => id(&reply["turn"]["id"], "provider test turn identity")?,
            Err(error) if error.downcast_ref::<Failure>().is_some_and(|error| error.native_error.is_some()) => {
                execution.rejected()?;
                return Err(error);
            }
            // If the reply was lost, only the observed start of this fresh
            // ephemeral thread can identify the accepted turn.
            _ => output::started(&mut events, &signal).await?,
        };
        execution.bind_turn(turn.clone())?;
        let emit: Emit = Arc::new(|_| Ok(()));
        let terminal = output::collect(&mut events, &signal, thread, &turn, &emit).await?;
        if let Some(diagnostic) = terminal.provider_failure {
            return Err(crate::error::WireError(diagnostic).into());
        }
        terminal.result?["text"].as_js_string().cloned().context("Missing provider response text.")
    }).await.context(TIMEOUT_MESSAGE);
    subscription.close();
    result?
}
