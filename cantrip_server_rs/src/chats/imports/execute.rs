use super::{failures, service::Service, *};
use crate::{
    operations::logging::LogCall, projects::targets::TargetRepository, settings::parse_response,
    wire::coercion::truthy,
};
use futures::FutureExt;
use std::time::Duration;
use tokio::sync::watch;
pub(super) const READ_TIMEOUT: Duration = Duration::from_secs(30 * 60);
impl Service {
    pub(super) async fn execute(self: &Arc<Self>, claimed: &Value) -> Result<()> {
        let id = text(&claimed["job"]["id"])?;
        let command = text(&claimed["commandId"])?;
        let attempt = claimed["job"]["attempt"]
            .as_f64()
            .context("Import attempt")?;
        let (stop, mut ending) = watch::channel(false);
        let service = self.clone();
        let renewal = tokio::spawn(async move {
            let mut timer = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(30),
                Duration::from_secs(30),
            );
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {biased;_=ending.changed()=>break,_=timer.tick()=>{}}
                match service.repository.renew(&id, &command, attempt).await {
                    Ok(true) => {}
                    Ok(false) => (service.dependencies.logger)(LogCall::event(
                        "warn",
                        "Chat import no longer owns its durable lease",
                        json!({"chatImportJobId":id,"attempt":attempt}),
                    )),
                    Err(error) => service.report(
                        "warn",
                        "Could not renew chat import lease",
                        &error,
                        json!({"chatImportJobId":id}),
                    ),
                }
            }
        });
        let result = self.settle_execution(claimed).await;
        stop.send_replace(true);
        renewal.await.context("Import renewal task ended")?;
        result
    }
    async fn settle_execution(&self, claimed: &Value) -> Result<()> {
        let result = if truthy(claimed["job"].get("chatId")) {
            self.hydrate_import(claimed).await
        } else {
            self.read_and_import(claimed).await
        };
        let Err(error) = result else {
            return Ok(());
        };
        if matches!(error.downcast_ref::<Error>(), Some(Error::Stale)) {
            (self.dependencies.logger)(LogCall::event(
                "warn",
                "Ignored stale chat import result",
                json!({"chatImportJobId":claimed["job"]["id"],"attempt":claimed["job"]["attempt"]}),
            ));
            return Ok(());
        }
        let failure = failures::mapped(&error);
        if truthy(claimed["job"].get("chatId"))
            && failure["code"] == "runtime-incompatible"
            && failure["retryable"] == false
        {
            return self
                .without_hydration(claimed, "runtime-incompatible")
                .await;
        }
        let state = if failure["retryable"] == true
            && !matches!(error.downcast_ref::<Error>(), Some(Error::Conflict(_)))
        {
            "blocked"
        } else {
            "failed"
        };
        let job = self
            .repository
            .settle(
                &text(&claimed["job"]["id"])?,
                &text(&claimed["commandId"])?,
                state,
                &failure,
            )
            .await?;
        self.publish_failure(claimed, &job)?;
        Ok(())
    }
    pub(super) fn publish_failure(&self, claimed: &Value, job: &Value) -> Result<()> {
        (self.dependencies.logger)(LogCall::event(
            "warn",
            if job["state"] == "blocked" {
                "Chat import needs attention"
            } else {
                "Chat import failed"
            },
            json!({"attempt":job["attempt"],"chatImportJobId":job["id"],"errorCode":job["error"].get("code").cloned().unwrap_or(json!("unknown")),"projectId":job["projectId"],"sourceWorkerId":job["sourceWorkerId"],"state":job["state"],"targetWorkerId":job["targetPlacement"]["workerId"]}),
        ));
        self.publish(&text(&claimed["ownerId"])?, job);
        Ok(())
    }
    async fn read_and_import(&self, claimed: &Value) -> Result<()> {
        let job = &claimed["job"];
        let owner = text(&claimed["ownerId"])?;
        let source = text(&job["sourceWorkerId"])?;
        let id = text(&job["id"])?;
        let command = text(&claimed["commandId"])?;
        let worker = TargetRepository::new(self.repository.database.clone())
            .worker(&owner, &job["sourceWorkerId"])
            .await?;
        let failure = match worker.as_ref() {
            Some(worker) if self.dependencies.commands.is_connected(&source) => {
                (!truthy(worker.get("externalCodexHistory"))).then(||
                    json!({"code":"capability-missing","message":"The source worker no longer supports Codex history import.","retryable":false})
                )
            }
            _ => Some(failures::mapped(&failures::Offline.into())),
        };
        if let Some(failure) = failure {
            let blocked = self
                .repository
                .settle(&id, &command, "blocked", &failure)
                .await?;
            self.publish_failure(claimed, &blocked)?;
            return Ok(());
        }
        let Some(context) = self.repository.read_context(&id, &command).await? else {
            let failed=self.repository.settle(&id,&command,"failed",&json!({"code":"target-not-found","message":"The source project replica is no longer available.","retryable":false})).await?;
            self.publish_failure(claimed, &failed)?;
            return Ok(());
        };
        let response=self.dependencies.commands.request(&source,json!({"type":"external.chat-history.read","ownerId":claimed["ownerId"],"chatId":job["id"],"sourceKind":job["sourceKind"],"sourceId":job["sourceId"],"sourceThreadId":job["sourceThreadId"],"targets":context["targets"]}),Some(READ_TIMEOUT),None).await?;
        let response = parse_response("externalChatReadWorkerResultSchema", response.as_ref())?;
        let attempt = job["attempt"].as_f64().context("Import attempt")?;
        let importing = self
            .repository
            .mark_importing(&id, &command, attempt)
            .await?;
        self.publish(&owner, &importing);
        let attachments = self
            .transfer_attachments(claimed, &response["transcript"]["attachments"])
            .await?;
        let commands = self.dependencies.commands.clone();
        let target = text(&job["targetPlacement"]["workerId"])?;
        let completed=self.repository.complete_canonical(&id,&command,attempt,&response["transcript"],&attachments,Arc::new(move |messages,attachments| {
            let (commands,target)=(commands.clone(),target.clone());
            async move {
                let mut protected=Vec::new();
                for chunk in messages.chunks(100) {
                    let response=commands.request(&target,json!({"type":"chat.messages.protect","messages":chunk,"attachments":attachments}),Some(READ_TIMEOUT),None).await?;
                    let batch=parse_response("chatMessageOpaqueContentListSchema",response.as_ref())?;
                    protected.extend(batch.as_array().context("Protected import batch")?.iter().cloned());
                }
                parse_response("chatMessageOpaqueContentListSchema",Some(&Value::Array(protected)))
            }.boxed()
        })).await?;
        self.publish(&owner, &completed);
        if !response["transcript"]["attachments"].as_array().context("Import attachments")?.is_empty()
            && let Err(error)=self.dependencies.commands.request(&source,json!({"type":"external.chat-history.attachments.release","sourceKind":job["sourceKind"],"sourceId":job["sourceId"],"sourceThreadId":job["sourceThreadId"]}),None,None).await {
                self.report("warn","Could not release staged external chat attachments",&error.into(),json!({"chatImportJobId":id}));
            }
        Ok(())
    }
}
