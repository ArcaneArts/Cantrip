//! Controlled worker boundary around the actual hydration helper and command bus.
use anyhow::{Context, Result};
use cantrip_server::{
    chats::hydration::{self, Input},
    relay::RelayQuotas,
    wire::Value,
    workers::{
        bridge::{BridgeStats, CommandError, EventHandler},
        command_bus::{CommandDelegate, CommandLimits, CommandOutcome, LimitedCommandBus},
    },
};
use futures::{FutureExt, future::BoxFuture};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
macro_rules! json {
    ({$($key:literal:$value:expr),*$(,)?}) => {Value::object([$(( $key,Value::from_serialize(&$value))),*])};
    ($value:expr) => {Value::from_serialize(&$value)};
}

struct Control {
    input: Value,
    trace: Mutex<Vec<Value>>,
}
impl CommandDelegate for Control {
    fn stats(&self) -> BridgeStats {
        BridgeStats {
            active_requests: 0,
            connected_workers: 1,
            failed_requests: 0,
            routed_requests: 0,
            succeeded_requests: 0,
        }
    }
    fn is_connected(&self, _: &str) -> bool {
        true
    }
    fn request(
        self: Arc<Self>,
        _: String,
        worker: String,
        command: Value,
        timeout: Option<Duration>,
        _: Option<EventHandler>,
    ) -> BoxFuture<'static, CommandOutcome> {
        async move {
            self.trace.lock().unwrap().push(json!({"worker":worker,"command":command,"options":json!({"timeoutMs":timeout.map(|d|d.as_millis() as u64)})}));
            let kind = command["type"].as_str().unwrap_or_default();
            if self.input["failCommand"] == kind && (kind != "chat.relocation.hydration.chunk" ||
                self.input.get("failChunkIndex").is_none_or(|index|index==&command["chunkIndex"])) {
                return Err(CommandError {message:"Controlled hydration worker failure".into(),code:None,unavailable:false,encoding_error:None,inference:None,request_id:None});
            }
            if self.input["omitResponse"] == kind { return Ok(None); }
            if let Some(reply) = self.input["responses"].get(kind) { return Ok(Some(reply.clone())); }
            Ok(Some(match kind {
                "chat.relocation.hydration.begin" => json!({"status":"upload"}),
                "chat.relocation.hydration.chunk" => Value::Null,
                "chat.relocation.hydration.complete" => {
                    let digest = self.trace.lock().unwrap().iter().find(|call|call["command"]["type"]=="chat.relocation.hydration.begin").map(|call|call["command"]["transcriptSha256"].clone()).unwrap_or(Value::Null);
                    json!({"snapshotId":command["snapshotId"],"transcriptSha256":digest,"threadId":"hydrated-thread","reused":false})
                },
                _ => unreachable!("Only actual hydration helper commands are handled"),
            }))
        }.boxed()
    }
}

pub async fn run(request: &Value) -> Result<Value> {
    let control = Arc::new(Control {
        input: request.clone(),
        trace: Mutex::new(Vec::new()),
    });
    let commands = LimitedCommandBus::with_parts(
        control.clone(),
        RelayQuotas::with_limits(64 << 20, 64 << 20, 64 << 20, 64 << 20, 100, 100),
        CommandLimits {
            account_concurrency: 100,
            account_rate_per_minute: 10000,
            worker_concurrency: 100,
            worker_rate_per_minute: 10000,
        },
        Arc::new(|_| async { Ok(Some("hydration-owner".to_owned())) }.boxed()),
        Arc::new(|| 0),
    );
    let input = &request["input"];
    let result = if request["op"] == "relocation-skills" {
        hydration::required_skills(&request["payload"]).map(Value::Array)
    } else {
        hydration::hydrate(
            &commands,
            Input {
                chat_id: &input["chatId"],
                cwd: &input["cwd"],
                expected_sha256: input.get("expectedSha256"),
                mcp_servers: &input["mcpServers"],
                payload: &input["payload"],
                permission_profile_id: &input["permissionProfileId"],
                plan_mode: &input["planMode"],
                runtime: &input["runtime"],
                snapshot_id: &input["snapshotId"],
                worker_id: input["workerId"]
                    .as_str()
                    .context("Hydration fixture worker")?,
            },
        )
        .await
    };
    commands.drained().await;
    let (value, error) = match result {
        Ok(value) => (value, Value::Null),
        Err(error) => {
            let code = error
                .downcast_ref::<hydration::Error>()
                .map(|e| json!(e.code()))
                .unwrap_or(Value::Null);
            (
                Value::Null,
                json!({"code":code,"message":error.to_string()}),
            )
        }
    };
    Ok(json!({"value":value,"error":error,"trace":control.trace.lock().unwrap().clone()}))
}
