use crate::{config::Config, connection::Outbound, http::checked, logging::Logs};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, date, parse_json_text, value::json};
use futures::{StreamExt, stream};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    sync::{Notify, watch},
    time::MissedTickBehavior,
};

const POLL_INTERVAL: Duration = Duration::from_secs(10);
const PATH: &str = "/api/internal/workers/automations";
const MAX_DISPATCHES: usize = 8;

#[derive(Clone)]
pub(crate) struct Scheduler {
    settings: Arc<Mutex<Config>>,
    client: reqwest::Client,
    outgoing: Arc<Outbound>,
    logs: Arc<Logs>,
    wake: Arc<Notify>,
}

impl Scheduler {
    pub(crate) fn new(
        settings: Arc<Mutex<Config>>,
        client: reqwest::Client,
        outgoing: Arc<Outbound>,
        logs: Arc<Logs>,
    ) -> Self {
        Self {
            settings,
            client,
            outgoing,
            logs,
            wake: Arc::default(),
        }
    }

    pub(crate) fn wake(&self) {
        self.wake.notify_one();
    }

    pub(crate) async fn run(self, mut stop: watch::Receiver<bool>) {
        let worker = self.settings.lock().unwrap().worker_id.clone();
        self.logs.event("info","Automation schedule synchronization started",json!({
            "event":"automation.schedule-sync.started","subsystem":"automation","operation":"sync-schedules",
            "status":"started","workerId":worker,"pollIntervalMs":POLL_INTERVAL.as_millis() as u64,
        }));
        let mut ticker = tokio::time::interval(POLL_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut fingerprint = None;
        let mut last_error = None;
        while !*stop.borrow() {
            tokio::select! {
                biased;
                _=stop.changed()=>break,
                _=ticker.tick()=>{},
                _=self.wake.clone().notified_owned()=>{},
            }
            if !self.outgoing.command_ready() {
                continue;
            }
            let began = Instant::now();
            let result = tokio::select! {
                biased;
                _=stop.changed()=>break,
                result=self.tick(&mut fingerprint, last_error.is_some())=>result,
            };
            match result {
                Ok(()) => last_error = None,
                Err(error) => {
                    let message = error.to_string();
                    if last_error.as_ref() != Some(&message) {
                        self.logs.repeated(
                            format!("automation-sync-unavailable:{}",worker.lossy()),"warn",
                            "Automation schedule synchronization unavailable",
                            json!({"event":"automation.schedule-sync.failed","subsystem":"automation",
                                "operation":"sync-schedules","status":"retrying","reasonCode":"request-failed",
                                "workerId":worker,"durationMs":began.elapsed().as_millis() as u64,"error":message}),
                        );
                    }
                    last_error = Some(message);
                }
            }
        }
        self.logs.event(
            "info",
            "Automation schedule synchronization stopped",
            json!({
                "event":"automation.schedule-sync.stopped","subsystem":"automation",
                "operation":"sync-schedules","status":"completed","workerId":worker,
            }),
        );
    }

    async fn tick(&self, previous: &mut Option<Vec<String>>, recovered: bool) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let began = Instant::now();
        let (url, token) = self.endpoint(None)?;
        let schedules = read(
            self.client
                .get(url)
                .bearer_auth(token)
                .timeout(Duration::from_secs(5)),
            "workerAutomationWireListSchema",
            "schedule refresh",
        )
        .await?;
        let schedules = schedules
            .as_array()
            .context("Missing automation schedules.")?;
        let mut fingerprint: Vec<_> = schedules
            .iter()
            .map(|row| {
                json!([
                    &row["id"],
                    &row["revision"],
                    &row["enabled"],
                    &row["nextRunAt"]
                ])
                .stringify()
            })
            .collect();
        fingerprint.sort_unstable();
        if recovered || previous.as_ref() != Some(&fingerprint) {
            let worker = self.settings.lock().unwrap().worker_id.clone();
            let enabled = schedules
                .iter()
                .filter(|row| row["enabled"] == true)
                .count();
            self.logs.event(
                if recovered {"info"} else {"debug"},
                if recovered {"Automation schedule synchronization recovered"} else {"Automation schedules synchronized"},
                json!({
                    "event":if recovered {"automation.schedule-sync.recovered"} else {"automation.schedule-sync.completed"},
                    "subsystem":"automation","operation":"sync-schedules","status":"completed",
                    "workerId":worker,"durationMs":began.elapsed().as_millis() as u64,
                    "counts":json!({"schedules":schedules.len(),"enabled":enabled,"paused":schedules.len()-enabled}),
                }),
            );
        }
        *previous = Some(fingerprint);
        let mut seen = HashSet::new();
        let mut due = Vec::new();
        for row in schedules {
            if row["enabled"] == true
                && row["nextRunAt"]
                    .as_js_string()
                    .and_then(date::parse)
                    .is_some_and(|time| time <= now)
                && seen.insert(row["id"].as_js_string())
            {
                due.push(json!({
                    "id":row["id"], "workerId":row["workerId"], "projectId":row["projectId"],
                    "chatId":row["chatId"], "revision":row["revision"], "nextRunAt":row["nextRunAt"],
                }));
            }
        }
        let mut dispatches = stream::iter(due)
            .map(|row| {
                let scheduler = self.clone();
                async move { scheduler.dispatch(&row).await }
            })
            .buffer_unordered(MAX_DISPATCHES);
        let mut failed = None;
        while let Some(result) = dispatches.next().await {
            if let Err(error) = result {
                failed.get_or_insert(error);
            }
        }
        failed.map_or(Ok(()), Err)
    }

    async fn dispatch(&self, row: &Value) -> Result<()> {
        if !self.outgoing.command_ready() {
            return Ok(());
        }
        let began = Instant::now();
        let context = json!({
            "subsystem":"automation","operation":"dispatch","workerId":row["workerId"],
            "projectId":row["projectId"],"chatId":row["chatId"],"automationId":row["id"],"revision":row["revision"],
        });
        let mut started = context.clone();
        started["event"] = json!("automation.dispatch.started");
        started["status"] = json!("started");
        self.logs
            .event("info", "Due automation dispatch began", started);
        let result = async {
            let id = row["id"].as_str().context("Missing automation identity.")?;
            let (url, token) = self.endpoint(Some(id))?;
            let request = json!({"revision":row["revision"],"scheduledFor":row["nextRunAt"]});
            read(
                self.client
                    .post(url)
                    .bearer_auth(token)
                    .header("content-type", "application/json")
                    .body(request.stringify())
                    .timeout(Duration::from_secs(15)),
                "projectAutomationDispatchResultSchema",
                "automation dispatch",
            )
            .await
        }
        .await;
        let mut finished = context;
        finished["durationMs"] = json!(began.elapsed().as_millis() as u64);
        match result {
            Ok(receipt) => {
                finished["event"] = json!("automation.dispatch.completed");
                finished["status"] = json!("completed");
                finished["resultStatus"] = receipt["status"].clone();
                self.logs
                    .event("info", "Due automation dispatched", finished);
                Ok(())
            }
            Err(error) => {
                finished["event"] = json!("automation.dispatch.failed");
                finished["status"] = json!("failed");
                finished["reasonCode"] = json!("dispatch-failed");
                finished["error"] = json!(error.to_string());
                self.logs
                    .event("warn", "Due automation dispatch failed", finished);
                Err(error)
            }
        }
    }

    fn endpoint(&self, id: Option<&str>) -> Result<(url::Url, String)> {
        let settings = self.settings.lock().unwrap();
        let mut url = url::Url::parse(&settings.server_url)?.join(PATH)?;
        if let Some(id) = id {
            url.path_segments_mut()
                .map_err(|()| anyhow::anyhow!("Invalid automation server URL."))?
                .extend([id, "dispatch"]);
        }
        url.query_pairs_mut()
            .append_pair("workerId", &settings.worker_id.lossy());
        Ok((url, settings.token.clone()))
    }
}

async fn read(request: reqwest::RequestBuilder, schema: &str, operation: &str) -> Result<Value> {
    let response = request
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("{operation} request failed"))?;
    ensure!(
        response.status().is_success(),
        "{operation} failed with HTTP {}",
        response.status().as_u16()
    );
    let body = response
        .text()
        .await
        .map_err(|_| anyhow::anyhow!("Could not read {operation} response"))?;
    let value =
        parse_json_text(&body).map_err(|_| anyhow::anyhow!("Invalid {operation} response"))?;
    checked(schema, &value).map_err(|_| anyhow::anyhow!("Invalid {operation} response"))
}
