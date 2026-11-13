use super::command::CommandConnection;
use super::core::{Core, Listener, MAX_MESSAGE_BYTES, now, presence, session_claim};
use crate::{
    operations::logging::{LogCall, Logger},
    wire::{JsString, Value, parse_json_text, value::json},
};
use ::redis::Client;
use anyhow::{Context, Result, anyhow, bail};
use futures::{FutureExt, StreamExt};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{sync::Mutex as AsyncMutex, task::JoinHandle};

const REPLACE: &str = "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]); return 1 else return 0 end";
const REMOVE: &str = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const COMPONENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

pub struct Options {
    pub url: String,
    pub instance_id: String,
    pub key_prefix: String,
    pub presence_ttl_ms: u64,
    pub maximum_instances: u64,
    pub logger: Logger,
}
impl Options {
    pub fn new(url: String, instance_id: String) -> Self {
        Self {
            url,
            instance_id,
            key_prefix: "cantrip:relay:v1".into(),
            presence_ttl_ms: 30_000,
            maximum_instances: 1,
            logger: Arc::new(|_| {}),
        }
    }
}

struct Tasks {
    subscriber: JoinHandle<()>,
    heartbeat: Option<JoinHandle<()>>,
}
impl Drop for Tasks {
    fn drop(&mut self) {
        self.subscriber.abort();
        if let Some(task) = &self.heartbeat {
            task.abort();
        }
    }
}

/// Redis is an ephemeral routing/authority directory. Durable command receipts
/// and worker execution state continue to belong to the SQL services.
pub struct RedisCoordinator {
    core: Arc<Core>,
    client: Client,
    prefix: String,
    channel: String,
    logger: Logger,
    connection: Mutex<Option<CommandConnection>>,
    subscribed: AtomicBool,
    tasks: AsyncMutex<Option<Tasks>>,
}
impl RedisCoordinator {
    pub fn new(options: Options) -> Result<Arc<Self>> {
        let client = Client::open(options.url)?;
        Ok(Arc::new(Self {
            core: Arc::new(Core::new(
                options.instance_id,
                options.presence_ttl_ms,
                options.maximum_instances,
            )),
            client,
            channel: format!("{}:messages", options.key_prefix),
            prefix: options.key_prefix,
            logger: options.logger,
            connection: Mutex::new(None),
            subscribed: AtomicBool::new(false),
            tasks: AsyncMutex::new(None),
        }))
    }
    pub fn instance_id(&self) -> &str {
        &self.core.instance
    }
    pub fn presence_ttl_ms(&self) -> u64 {
        self.core.ttl
    }
    pub fn stats(&self) -> Value {
        self.core.stats()
    }
    pub fn subscribe(&self, listener: Listener) -> u64 {
        self.core.subscribe(listener)
    }
    pub fn unsubscribe(&self, id: u64) {
        self.core.unsubscribe(id);
    }
    pub fn cached_worker(&self, worker: &JsString) -> Option<Value> {
        self.core.cached(worker)
    }
    fn command(&self) -> Result<CommandConnection> {
        self.connection
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| anyhow!("Redis coordination is unavailable."))
    }
    fn ready_command(&self) -> Result<CommandConnection> {
        let command = self.command()?;
        if !command.is_ready() {
            bail!("Redis coordination is unavailable.");
        }
        Ok(command)
    }
    fn key(&self, kind: &str, id: &JsString) -> Result<String> {
        let id = id.as_str().context("URI malformed")?;
        Ok(format!(
            "{}:{kind}:{}",
            self.prefix,
            percent_encoding::utf8_percent_encode(id, COMPONENT)
        ))
    }
    fn log(
        &self,
        level: &'static str,
        message: &'static str,
        event: &str,
        operation: &str,
        status: &str,
        extra: Value,
    ) {
        let mut context = json!({"event":event,"subsystem":"relay-coordination","operation":operation,"status":status});
        if let (Value::Object(fields), Value::Object(context)) = (&extra, &mut context) {
            for (key, value) in fields {
                context.insert(key.clone(), value.clone());
            }
        }
        (self.logger)(LogCall::event(level, message, context));
    }
    fn connection_error(&self, subscriber: bool) {
        // Never log connection strings, credentials, raw Redis errors or payloads.
        let (key, message, event, operation, reason) = if subscriber {
            (
                "coordination-redis-subscriber-error",
                "Redis relay coordination subscriber reported an error",
                "coordination.subscription.error",
                "redis-subscribe",
                "redis-subscriber-error",
            )
        } else {
            (
                "coordination-redis-client-error",
                "Redis relay coordination client reported an error",
                "coordination.connection.error",
                "redis-client",
                "redis-client-error",
            )
        };
        (self.logger)(LogCall::repeated(
            key.into(),
            "error",
            message,
            json!({"event":event,"subsystem":"relay-coordination","operation":operation,"reasonCode":reason,"status":"degraded"}),
            None,
        ));
    }
    pub async fn start(self: &Arc<Self>) -> Result<()> {
        let mut tasks = self.tasks.lock().await;
        if tasks.is_some() {
            return Ok(());
        }
        let at = now();
        self.log(
            "info",
            "Redis relay coordination startup began",
            "coordination.lifecycle.started",
            "start",
            "starting",
            Value::Null,
        );
        let command = CommandConnection::new(&self.client).await?;
        *self.connection.lock().unwrap() = Some(command);
        let result = async {
            let mut subscriber = self.client.get_async_pubsub().await?;
            subscriber.subscribe(&self.channel).await?;
            self.subscribed.store(true, Ordering::Release);
            let owner = Arc::downgrade(self);
            let task = tokio::spawn(Self::receive_loop(
                owner,
                self.core.clone(),
                self.client.clone(),
                self.channel.clone(),
                subscriber,
            ));
            *tasks = Some(Tasks {
                subscriber: task,
                heartbeat: None,
            });
            for key in self.scan("worker", 200).await? {
                if let Some(raw) = self.get(&key).await?
                    && let Some(p) = parse_json_text(&raw).ok().and_then(|p| presence(&p))
                    && p["expiresAt"].as_f64().is_some_and(|at| at > now())
                {
                    self.core.cache(p);
                }
            }
            self.refresh_instance().await?;
            self.refresh_instance_count().await?;
            let owner = Arc::downgrade(self);
            let interval = Duration::from_millis((self.core.ttl / 3).max(1000));
            tasks.as_mut().unwrap().heartbeat = Some(tokio::spawn(async move {
                let mut timer =
                    tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
                timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    timer.tick().await;
                    let Some(owner) = owner.upgrade() else {
                        break;
                    };
                    if owner.refresh_instance().await.is_err() {
                        owner.connection_error(false);
                    }
                }
            }));
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            tasks.take();
            self.subscribed.store(false, Ordering::Release);
            if let Some(command) = self.connection.lock().unwrap().take() {
                command.close();
            }
            self.log(
                "error",
                "Redis relay coordination failed to start",
                "coordination.lifecycle.failed",
                "start",
                "failed",
                json!({"reasonCode":"redis-startup-failed","durationMs":now()-at}),
            );
            return Err(error);
        }
        self.log("info","Redis relay coordination is ready","coordination.lifecycle.completed","start","ready",
            json!({"durationMs":now()-at,"counts":json!({"instances":self.stats()["instanceCount"],"workers":self.stats()["cachedWorkers"]})}));
        Ok(())
    }
    async fn receive_loop(
        owner: Weak<Self>,
        core: Arc<Core>,
        client: Client,
        channel: String,
        mut subscriber: ::redis::aio::PubSub,
    ) {
        loop {
            while let Some(message) = subscriber.on_message().next().await {
                let raw = String::from_utf8_lossy(message.get_payload_bytes());
                if raw.len() > MAX_MESSAGE_BYTES {
                    continue;
                }
                let Ok(value) = parse_json_text(&raw) else {
                    continue;
                };
                // Node starts receive() synchronously through its first await.
                // A callback may await a second message: do not serialize the
                // subscriber behind pending callbacks or drop their work.
                let core = core.clone();
                let mut delivery = Box::pin(async move {
                    core.receive(value).await;
                });
                if delivery.as_mut().now_or_never().is_none() {
                    tokio::spawn(delivery);
                }
            }
            let Some(coordinator) = owner.upgrade() else {
                return;
            };
            coordinator.subscribed.store(false, Ordering::Release);
            coordinator.connection_error(true);
            drop(coordinator);
            let mut delay = 50;
            loop {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                // Bound the actual connection and subscription handshake. A
                // half-open TCP connection must not stall the retry loop.
                if let Ok(Ok(connection)) = tokio::time::timeout(Duration::from_secs(3), async {
                    let mut connection = client.get_async_pubsub().await?;
                    connection.subscribe(&channel).await?;
                    Ok::<_, ::redis::RedisError>(connection)
                })
                .await
                {
                    let Some(owner) = owner.upgrade() else {
                        return;
                    };
                    subscriber = connection;
                    owner.subscribed.store(true, Ordering::Release);
                    break;
                }
                delay = (delay * 2).min(2000);
            }
        }
    }
    async fn get(&self, key: &str) -> Result<Option<String>> {
        let raw: Option<Vec<u8>> = ::redis::cmd("GET")
            .arg(key)
            .query_async(&mut self.command()?)
            .await?;
        Ok(raw.map(|raw| String::from_utf8_lossy(&raw).into_owned()))
    }
    async fn scan(&self, kind: &str, count: u64) -> Result<Vec<String>> {
        let mut cursor = 0_u64;
        let mut keys = Vec::new();
        loop {
            let (next, batch): (u64, Vec<String>) = ::redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(format!("{}:{kind}:*", self.prefix))
                .arg("COUNT")
                .arg(count)
                .query_async(&mut self.command()?)
                .await?;
            keys.extend(batch);
            cursor = next;
            if cursor == 0 {
                return Ok(keys);
            }
        }
    }
    async fn set(&self, key: &str, value: &str, ttl: u64, nx: bool) -> Result<Option<String>> {
        let mut cmd = ::redis::cmd("SET");
        cmd.arg(key).arg(value).arg("PX").arg(ttl);
        if nx {
            cmd.arg("NX");
        }
        Ok(cmd.query_async(&mut self.command()?).await?)
    }
    async fn compare_set(
        &self,
        key: &str,
        current: &str,
        next: Option<(&str, u64)>,
    ) -> Result<bool> {
        let mut cmd = ::redis::cmd("EVAL");
        cmd.arg(if next.is_some() { REPLACE } else { REMOVE })
            .arg(1)
            .arg(key)
            .arg(current);
        if let Some((value, ttl)) = next {
            cmd.arg(value).arg(ttl);
        }
        let result: i64 = cmd.query_async(&mut self.command()?).await?;
        Ok(result == 1)
    }
    async fn refresh_instance(&self) -> Result<()> {
        self.set(
            &self.key("instance", &self.core.instance.clone().into())?,
            &json!(now()).stringify(),
            self.core.ttl,
            false,
        )
        .await?;
        Ok(())
    }
    async fn refresh_instance_count(&self) -> Result<()> {
        self.core
            .instance_count(self.scan("instance", 100).await?.len() as u64);
        Ok(())
    }
    pub async fn publish(&self, payload: Value, ttl_ms: Option<f64>) -> Result<()> {
        // The command connection can recover before the dedicated subscriber.
        // Dispatching a request during that gap can lose its only reply.
        if payload["kind"] == "worker-command-request" && !self.subscribed.load(Ordering::Acquire) {
            bail!("Redis coordination is unavailable.");
        }
        let envelope = self.core.envelope(payload, ttl_ms.unwrap_or(60_000.0))?;
        let mut command = self.ready_command()?;
        let result: ::redis::RedisResult<i64> = ::redis::cmd("PUBLISH")
            .arg(&self.channel)
            .arg(envelope.stringify())
            .query_async(&mut command)
            .await;
        if let Err(error) = result {
            if error.is_io_error() || error.is_connection_dropped() {
                self.connection_error(false);
                bail!("Redis coordination is unavailable.");
            }
            return Err(error.into());
        }
        Ok(())
    }
    pub async fn find_worker(&self, worker: &JsString) -> Result<Option<Value>> {
        if let Some(cached) = self.core.cached(worker) {
            return Ok(Some(cached));
        }
        let Some(raw) = self.get(&self.key("worker", worker)?).await? else {
            return Ok(None);
        };
        let parsed = parse_json_text(&raw)
            .ok()
            .and_then(|p| presence(&p))
            .filter(|p| p["expiresAt"].as_f64().is_some_and(|at| at > now()));
        if let Some(p) = &parsed {
            self.core.cache(p.clone());
        }
        Ok(parsed)
    }
    pub async fn claim_worker(&self, mut input: Value) -> Result<Option<Value>> {
        let worker = input["workerId"]
            .as_js_string()
            .context("Worker ID must be a string.")?
            .clone();
        let previous = self.find_worker(&worker).await?;
        input["expiresAt"] = json!(now() + self.core.ttl as f64);
        input["instanceId"] = json!(self.core.instance);
        self.set(
            &self.key("worker", &worker)?,
            &input.stringify(),
            self.core.ttl,
            false,
        )
        .await?;
        self.core.cache(input.clone());
        self.publish(
            json!({"kind":"worker-presence","action":"online","presence":input}),
            None,
        )
        .await?;
        self.log(
            "info",
            "Worker relay ownership claimed",
            "coordination.worker.claimed",
            "claim-worker",
            "claimed",
            json!({"workerId":worker,"replacedInstance":previous.is_some()}),
        );
        Ok(previous)
    }
    pub async fn refresh_worker(&self, worker: &JsString, connection: &JsString) -> Result<bool> {
        let key = self.key("worker", worker)?;
        let Some(raw) = self.get(&key).await? else {
            return Ok(false);
        };
        let Some(mut p) = parse_json_text(&raw).ok().and_then(|p| presence(&p)) else {
            return Ok(false);
        };
        if p["connectionId"].as_js_string() != Some(connection)
            || p["instanceId"] != self.core.instance.as_str()
        {
            return Ok(false);
        }
        p["expiresAt"] = json!(now() + self.core.ttl as f64);
        if !self
            .compare_set(&key, &raw, Some((&p.stringify(), self.core.ttl)))
            .await?
        {
            return Ok(false);
        }
        self.core.cache(p.clone());
        self.publish(
            json!({"kind":"worker-presence","action":"online","presence":p}),
            None,
        )
        .await?;
        self.log(
            "info",
            "Worker relay ownership released",
            "coordination.worker.released",
            "release-worker",
            "released",
            json!({"workerId":worker}),
        );
        Ok(true)
    }
    pub async fn release_worker(&self, worker: &JsString, connection: &JsString) -> Result<bool> {
        let key = self.key("worker", worker)?;
        let Some(raw) = self.get(&key).await? else {
            return Ok(false);
        };
        let Some(p) = parse_json_text(&raw).ok().and_then(|p| presence(&p)) else {
            return Ok(false);
        };
        if p["connectionId"].as_js_string() != Some(connection)
            || p["instanceId"] != self.core.instance.as_str()
            || !self.compare_set(&key, &raw, None).await?
        {
            return Ok(false);
        }
        self.core.remove(worker, &p["connectionId"]);
        self.publish(
            json!({"kind":"worker-presence","action":"offline","presence":p}),
            None,
        )
        .await?;
        Ok(true)
    }
    pub async fn find_worker_link_session(&self, session: &JsString) -> Result<Option<Value>> {
        Ok(self
            .get(&self.key("worker-link", session)?)
            .await?
            .and_then(|raw| parse_json_text(&raw).ok())
            .and_then(|p| session_claim(&p)))
    }
    pub async fn claim_worker_link_session(&self, claim: Value) -> Result<Option<Value>> {
        let Some(parsed) = session_claim(&claim) else {
            bail!("WorkerLink session claim is invalid.");
        };
        let session = parsed["session"]["sessionId"].as_js_string().unwrap();
        if let Some(previous) = self.find_worker_link_session(session).await? {
            return Ok(Some(previous));
        }
        if self
            .set(
                &self.key("worker-link", session)?,
                &parsed.stringify(),
                (parsed["expiresAt"].as_f64().unwrap() - now()).max(1.0) as u64,
                true,
            )
            .await?
            .as_deref()
            == Some("OK")
        {
            Ok(None)
        } else {
            self.find_worker_link_session(session).await
        }
    }
    pub async fn refresh_worker_link_session(&self, claim: Value) -> Result<bool> {
        let Some(parsed) = session_claim(&claim) else {
            return Ok(false);
        };
        let key = self.key(
            "worker-link",
            parsed["session"]["sessionId"].as_js_string().unwrap(),
        )?;
        let Some(raw) = self.get(&key).await? else {
            return Ok(false);
        };
        let Some(current) = parse_json_text(&raw).ok().and_then(|p| session_claim(&p)) else {
            return Ok(false);
        };
        if current["authorityInstanceId"] != parsed["authorityInstanceId"] {
            return Ok(false);
        }
        self.compare_set(
            &key,
            &raw,
            Some((
                &parsed.stringify(),
                (parsed["expiresAt"].as_f64().unwrap() - now()).max(1.0) as u64,
            )),
        )
        .await
    }
    pub async fn release_worker_link_session(
        &self,
        session: &JsString,
        authority: &JsString,
    ) -> Result<bool> {
        let key = self.key("worker-link", session)?;
        let Some(raw) = self.get(&key).await? else {
            return Ok(false);
        };
        let Some(current) = parse_json_text(&raw).ok().and_then(|p| session_claim(&p)) else {
            return Ok(false);
        };
        if current["authorityInstanceId"].as_js_string() != Some(authority) {
            return Ok(false);
        }
        self.compare_set(&key, &raw, None).await
    }
    pub async fn health(&self) -> Result<bool> {
        if !self.subscribed.load(Ordering::Acquire) {
            return Ok(false);
        }
        let Ok(mut connection) = self.ready_command() else {
            return Ok(false);
        };
        let pong: ::redis::RedisResult<String> =
            ::redis::cmd("PING").query_async(&mut connection).await;
        let pong = match pong {
            Ok(pong) => pong,
            Err(error) if error.is_io_error() || error.is_connection_dropped() => {
                self.connection_error(false);
                return Ok(false);
            }
            Err(error) => return Err(error.into()),
        };
        if pong != "PONG" {
            return Ok(false);
        }
        self.refresh_instance_count().await?;
        let healthy = self.core.within_limit();
        if !healthy {
            (self.logger)(LogCall::repeated(
                "coordination-health-instance-limit".into(),
                "error",
                "Relay coordination instance limit exceeded",
                json!({"event":"coordination.health.failed","subsystem":"relay-coordination","operation":"health","reasonCode":"instance-limit-exceeded","status":"unhealthy",
                    "counts":json!({"instances":self.stats()["instanceCount"],"maximumInstances":self.stats()["maximumInstances"]})}),
                None,
            ));
        }
        Ok(healthy && self.subscribed.load(Ordering::Acquire))
    }
    pub fn begin_shutdown(&self) {
        if let Some(command) = self.connection.lock().unwrap().as_ref() {
            command.begin_shutdown();
        }
    }
    pub async fn close(&self) -> Result<()> {
        self.begin_shutdown();
        let mut tasks = self.tasks.lock().await;
        let at = now();
        self.log(
            "info",
            "Redis relay coordination shutdown began",
            "coordination.shutdown.started",
            "close",
            "stopping",
            Value::Null,
        );
        tasks.take();
        self.subscribed.store(false, Ordering::Release);
        let command = self.connection.lock().unwrap().take();
        if let Some(mut command) = command {
            let result: Result<()> = async {
                if !command.is_ready() {
                    return Ok(());
                }
                let _: i64 = ::redis::cmd("DEL")
                    .arg(self.key("instance", &self.core.instance.clone().into())?)
                    .query_async(&mut command)
                    .await?;
                let _: Result<String, ::redis::RedisError> =
                    ::redis::cmd("QUIT").query_async(&mut command).await;
                Ok(())
            }
            .await;
            command.close();
            result?;
        }
        self.log(
            "info",
            "Redis relay coordination stopped",
            "coordination.shutdown.completed",
            "close",
            "stopped",
            json!({"durationMs":now()-at}),
        );
        Ok(())
    }
}
