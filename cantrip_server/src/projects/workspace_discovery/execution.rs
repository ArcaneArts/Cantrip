use super::{service::DiscoveryService, *};
use crate::{
    projects::targets::TargetRepository,
    workers::{
        bridge::EventHandler,
        command_bus::{CommandFailure, RequestTimeout},
    },
};
use std::time::Duration;
use tokio::sync::watch;
impl DiscoveryService {
    pub(super) async fn execute(self: &Arc<Self>, claimed: &Value, import: bool) -> Result<()> {
        let owner = text(&claimed["ownerId"])?;
        if import {
            if let Some(snapshot) = self
                .repository
                .snapshot(&owner, &text(&claimed["workspaceId"])?)
                .await?
            {
                self.publish(&owner, &snapshot["job"], None);
            }
        } else {
            self.publish(&owner, &claimed["job"], None);
        }
        let (stop, mut ending) = watch::channel(false);
        let repository = self.repository.clone();
        let renewing = claimed.clone();
        let renewal = tokio::spawn(async move {
            let mut timer = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(30),
                Duration::from_secs(30),
            );
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {biased;_=ending.changed()=>break,_=timer.tick()=>{}}
                let result = if import {
                    repository.renew_import(&renewing).await
                } else {
                    repository
                        .renew_scan(
                            renewing["job"]["id"].as_str().unwrap(),
                            renewing["commandId"].as_str().unwrap(),
                            renewing["job"]["attempt"].as_f64().unwrap(),
                        )
                        .await
                };
                match result {
                    Ok(true) => {}
                    Ok(false) => Self::diagnostic("workspace.repository-discovery.lease-lost"),
                    Err(_) => {
                        Self::diagnostic("workspace.repository-discovery.lease-renewal-failed")
                    }
                }
            }
        });
        let outcome = if import {
            self.perform_import(claimed).await
        } else {
            self.perform_scan(claimed).await
        };
        let settled = match outcome {
            Ok(()) => Ok(()),
            Err(error) if stale(&error, import) => {
                Self::diagnostic("workspace.repository-discovery.stale-completion");
                Ok(())
            }
            Err(error) => {
                let bridge = error.downcast_ref::<CommandFailure>().and_then(|e| {
                    if let CommandFailure::Bridge(e) = e {
                        Some(e)
                    } else {
                        None
                    }
                });
                let offline = bridge.is_some_and(|e| e.unavailable);
                let code = if offline {
                    "worker-offline"
                } else if import {
                    match bridge.and_then(|e| e.code.as_deref()) {
                        Some("repository-unavailable") => "repository-unavailable",
                        Some("repository-changed") => "repository-changed",
                        _ if error
                            .downcast_ref::<DiscoveryError>()
                            .is_some_and(|e| matches!(e, DiscoveryError::Invariant(_))) =>
                        {
                            "project-conflict"
                        }
                        _ => "import-failed",
                    }
                } else if bridge.is_some_and(|e| e.code.as_deref() == Some("root-unavailable")) {
                    "root-unavailable"
                } else {
                    "discovery-failed"
                };
                self.settle(
                    claimed,
                    import,
                    offline,
                    &json!({"code":code,"retryable":offline}),
                )
                .await
            }
        };
        stop.send_replace(true);
        let _ = renewal.await;
        match settled {
            Err(e) if stale(&e, import) => Ok(()),
            result => result,
        }
    }
    async fn settle(
        &self,
        claimed: &Value,
        import: bool,
        block: bool,
        error: &Value,
    ) -> Result<()> {
        let job = if import {
            if block {
                self.repository.block_import(claimed, error).await?
            } else {
                self.repository.fail_import(claimed, error).await?
            }
        } else {
            let id = text(&claimed["job"]["id"])?;
            let command = text(&claimed["commandId"])?;
            if block {
                self.repository.block_scan(&id, &command, error).await?
            } else {
                self.repository.fail_scan(&id, &command, error).await?
            }
        };
        self.publish(&text(&claimed["ownerId"])?, &job, None);
        Ok(())
    }
    async fn worker_ready(&self, claimed: &Value, import: bool) -> Result<bool> {
        let owner = text(&claimed["ownerId"])?;
        let worker = if import {
            &claimed["workerId"]
        } else {
            &claimed["job"]["workerId"]
        };
        let enrolled = TargetRepository::new(self.repository.database.clone())
            .worker(&owner, worker)
            .await?;
        if enrolled.is_none() || !self.bridge.is_connected(&text(worker)?) {
            self.settle(
                claimed,
                import,
                true,
                &json!({"code":"worker-offline","retryable":true}),
            )
            .await?;
            return Ok(false);
        }
        if !crate::wire::coercion::truthy(
            enrolled.as_ref().unwrap()["managedFolders"].get("discoverWorkspaceRepositories"),
        ) {
            self.settle(
                claimed,
                import,
                false,
                &json!({"code":"capability-missing","retryable":false}),
            )
            .await?;
            return Ok(false);
        }
        Ok(true)
    }
    async fn request(
        &self,
        worker: &str,
        command: Value,
        timeout: RequestTimeout,
        events: Option<EventHandler>,
    ) -> Result<Option<Value>> {
        for retry in 0..=2 {
            match self
                .commands
                .request_with_timeout(worker, command.clone(), timeout, events.clone())
                .await
            {
                Err(CommandFailure::Limit(limit)) if retry < 2 => {
                    let seconds = limit.retry_after_seconds.clamp(1, 60);
                    eprintln!(
                        "{}",
                        serde_json::json!({"level":"warn","event":"workspace.repository-discovery.quota-retry","subsystem":"workspace-repository-discovery","workerId":worker,"operation":command["type"],"retry":retry+1,"retryDelayMs":seconds*1000})
                    );
                    tokio::time::sleep(Duration::from_secs(seconds)).await;
                }
                result => return Ok(result?),
            }
        }
        unreachable!()
    }
    async fn perform_scan(self: &Arc<Self>, claimed: &Value) -> Result<()> {
        if !self.worker_ready(claimed, false).await? {
            return Ok(());
        };
        let job = claimed["job"].clone();
        let id = text(&job["id"])?;
        let owner = text(&claimed["ownerId"])?;
        let publishing = self.clone();
        let event_job = job.clone();
        let event_owner = owner.clone();
        let events: EventHandler = Arc::new(move |event| {
            let (service, job, owner) =
                (publishing.clone(), event_job.clone(), event_owner.clone());
            Box::pin(async move {
                if event["type"] == "workspace.repositories.discovery-progress"
                    && event["jobId"] == job["id"]
                    && event["attempt"] == job["attempt"]
                {
                    service.publish(&owner, &job, Some(&event["progress"]));
                }
                Ok(())
            })
        });
        let response=self.request(&text(&job["workerId"])?,json!({"type":"workspace.repositories.discover","jobId":job["id"],"attempt":job["attempt"],"rootPath":claimed["rootPathHandle"],"depth":job["depth"]}),RequestTimeout::Disabled,Some(events)).await?;
        let result = crate::settings::parse_response(
            "workspaceRepositoryDiscoveryWorkerResultSchema",
            response.as_ref(),
        )?;
        anyhow::ensure!(
            result["jobId"] == job["id"] && result["attempt"] == job["attempt"],
            DiscoveryError::Stale("The worker returned another repository discovery attempt.")
        );
        let candidates=result["candidates"].as_array().context("Discovery worker candidates")?.iter().map(|c|json!({"pathHandle":c["path"],"displayHandle":c["displayPath"],"originUrlHandle":c["originUrl"],"github":c["github"],"repositoryFingerprint":c["repositoryFingerprint"],"classification":c["classification"],"diagnosticCode":c["diagnosticCode"]})).collect::<Vec<_>>();
        let completed=self.repository.complete_scan(&id,&text(&claimed["commandId"])?,&json!({"attempt":result["attempt"],"candidates":candidates,"counts":result["counts"],"truncated":result["truncated"]})).await?;
        self.publish(&owner, &completed["job"], None);
        Ok(())
    }
    async fn perform_import(&self, claimed: &Value) -> Result<()> {
        if !self.worker_ready(claimed, true).await? {
            return Ok(());
        };
        let response=self.request(&text(&claimed["workerId"])?,json!({"type":"workspace.repository-import.validate","candidateId":claimed["candidateId"],"attempt":claimed["attempt"],"rootPath":claimed["rootPathHandle"],"path":claimed["pathHandle"],"expectedRepositoryFingerprint":claimed["expectedRepositoryFingerprint"]}),RequestTimeout::After(Duration::from_secs(60)),None).await?;
        let result = crate::settings::parse_response(
            "workspaceRepositoryImportValidationResultSchema",
            response.as_ref(),
        )?;
        let job = self.repository.complete_import(claimed, &result).await?;
        self.publish(&text(&claimed["ownerId"])?, &job, None);
        Ok(())
    }
}
fn stale(error: &anyhow::Error, import: bool) -> bool {
    error.downcast_ref::<DiscoveryError>().is_some_and(|e| {
        matches!(
            (e, import),
            (DiscoveryError::ImportStale(_), true) | (DiscoveryError::Stale(_), false)
        )
    })
}
