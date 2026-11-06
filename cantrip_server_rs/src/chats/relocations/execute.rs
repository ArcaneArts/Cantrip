use super::{service::Service, *};
use crate::{operations::logging::LogCall, wire::JsString, workers::command_bus::CommandFailure};
use std::time::Duration;
use tokio::sync::watch;

#[derive(Debug)]
pub(super) struct ExecutionError(pub Value);
impl std::fmt::Display for ExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            &self.0["message"]
                .as_js_string()
                .map(|s| s.lossy())
                .unwrap_or_default(),
        )
    }
}
impl std::error::Error for ExecutionError {}
pub(super) fn execution_error(
    code: &str,
    message: impl Into<JsString>,
    retryable: bool,
) -> anyhow::Error {
    let message = message.into();
    ExecutionError(json!({"code":code,"message":message,"retryable":retryable})).into()
}
pub(super) fn stale(error: &anyhow::Error) -> bool {
    matches!(error.downcast_ref::<Error>(), Some(Error::Stale))
}
pub(super) fn unavailable(error: &anyhow::Error) -> bool {
    matches!(error.downcast_ref::<CommandFailure>(),Some(CommandFailure::Bridge(error)) if error.unavailable)
}
pub(super) struct HydratedTarget {
    pub runtime: Value,
    pub thread_id: Value,
    pub worker_id: String,
}
#[derive(Default)]
struct Execution {
    hydrated: Option<HydratedTarget>,
    placement_committed: bool,
}
impl Service {
    pub(super) async fn execute(self: &Arc<Self>, claimed: &Value) -> Result<()> {
        let job = &claimed["job"];
        let (id, command) = (text(&job["id"])?, text(&claimed["commandId"])?);
        let attempt = job["attempt"].as_f64().context("Relocation attempt")?;
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
                let context = json!({"chatRelocationJobId":id,"attempt":attempt});
                match service.repository.renew(&id, &command, attempt).await {
                    Ok(true) => {}
                    Ok(false) => (service.dependencies.logger)(LogCall::event(
                        "warn",
                        "Chat relocation job no longer owns its durable lease",
                        context,
                    )),
                    Err(error) => service.report(
                        "warn",
                        "Could not renew chat relocation job lease",
                        &error,
                        context,
                    ),
                }
            }
        });
        let result = self.settle_execution(claimed).await;
        stop.send_replace(true);
        renewal.await.context("Relocation renewal task ended")?;
        result
    }
    async fn settle_execution(&self, claimed: &Value) -> Result<()> {
        let mut execution = Execution::default();
        let result = self.perform(claimed, &mut execution).await;
        let Err(error) = result else {
            return Ok(());
        };
        let (owner, id, command) = (
            text(&claimed["ownerId"])?,
            text(&claimed["job"]["id"])?,
            text(&claimed["commandId"])?,
        );
        let context = json!({"chatRelocationJobId":id});
        if let Some(target) = execution
            .hydrated
            .as_ref()
            .filter(|_| !execution.placement_committed)
        {
            let current = match self.repository.get(&owner, &id).await {
                Ok(current) => current,
                Err(verification) => {
                    self.report(
                        "warn",
                        "Could not verify relocation commit; retained target runtime",
                        &verification,
                        context.clone(),
                    );
                    // A failed reread cannot prove that a lost COMMIT response
                    // left the target uncommitted. Preserve its hydrated thread.
                    return Err(error);
                }
            };
            // A queued recovery or newer attempt can reuse the same hydrated
            // thread. Its expired owner no longer has authority to discard it.
            let can_release = current.as_ref().is_none_or(|job| {
                job["attempt"] == claimed["job"]["attempt"]
                    && !matches!(
                        job["state"].as_str(),
                        Some("succeeded" | "queued" | "waiting-for-idle")
                    )
            });
            if can_release && let Err(cleanup) = self.release_target(target).await {
                self.report(
                    "warn",
                    "Could not release an uncommitted target runtime",
                    &cleanup,
                    context.clone(),
                );
            }
        }
        if stale(&error) {
            self.report(
                "warn",
                "Ignored stale chat relocation completion",
                &error,
                context,
            );
            return Ok(());
        }
        let failure = if let Some(known) = error.downcast_ref::<ExecutionError>() {
            known.0.clone()
        } else if unavailable(&error) {
            json!({"code":"worker-offline","message":"A required worker disconnected during relocation. The job will resume after it reconnects.","retryable":true})
        } else {
            let message = crate::settings::operation_error_message(&error);
            let message = JsString::new(message.units()[..message.len().min(4000)].to_vec());
            json!({"code":"worker-error","message":message,"retryable":true})
        };
        match self
            .repository
            .fail(
                &id,
                &command,
                claimed["job"]["attempt"]
                    .as_f64()
                    .context("Relocation attempt")?,
                &failure,
            )
            .await
        {
            Ok(job) => {
                self.publish(&owner, &job, None);
                Ok(())
            }
            Err(error) if stale(&error) => Ok(()),
            Err(error) => Err(error),
        }
    }
    async fn stage(
        &self,
        claimed: &Value,
        from: &str,
        to: &str,
        percent: u8,
        options: &Value,
    ) -> Result<Value> {
        let job = self
            .repository
            .advance(
                &text(&claimed["job"]["id"])?,
                &text(&claimed["commandId"])?,
                claimed["job"]["attempt"]
                    .as_f64()
                    .context("Relocation attempt")?,
                Advance {
                    from,
                    to,
                    progress: &json!({"stage":to,"percent":percent}),
                    options,
                },
            )
            .await?;
        self.publish(&text(&claimed["ownerId"])?, &job, None);
        Ok(job)
    }
    async fn perform(&self, claimed: &Value, execution: &mut Execution) -> Result<()> {
        let (source, target) = self.validate(claimed).await?;
        let no_options = Value::object([] as [(&str, Value); 0]);
        self.stage(claimed, "validating", "preparing-replica", 20, &no_options)
            .await?;
        self.prepare_replica(claimed, &target).await?;
        self.stage(
            claimed,
            "preparing-replica",
            "transferring-attachments",
            35,
            &no_options,
        )
        .await?;
        self.relay_attachments(claimed).await?;
        self.stage(
            claimed,
            "transferring-attachments",
            "hydrating-runtime",
            65,
            &no_options,
        )
        .await?;
        let runtime = self
            .select_runtime(
                claimed,
                &text(&target["workerId"])?,
                &source["providerAccountId"],
            )
            .await?;
        let thread_id = self
            .hydrate_target(claimed, &source, &target, &runtime)
            .await?;
        execution.hydrated = Some(HydratedTarget {
            runtime: runtime.clone(),
            thread_id: thread_id.clone(),
            worker_id: text(&target["workerId"])?,
        });
        self.stage(claimed,"hydrating-runtime","ready-to-commit",90,&json!({"cancellationUnsafe":true,"targetModelRouteId":runtime["routeId"],"targetProviderAccountId":runtime["provider"]["accountId"],"targetRuntimeThreadId":thread_id})).await?;
        let committed = self
            .repository
            .commit(
                &text(&claimed["job"]["id"])?,
                &text(&claimed["commandId"])?,
                claimed["job"]["attempt"]
                    .as_f64()
                    .context("Relocation attempt")?,
            )
            .await?;
        self.publish(
            &text(&claimed["ownerId"])?,
            &committed["job"],
            Some(&committed["chat"]),
        );
        if committed["job"]["state"] != "succeeded" {
            self.release_target(
                execution
                    .hydrated
                    .as_ref()
                    .context("Hydrated relocation target")?,
            )
            .await?;
            return Ok(());
        }
        execution.placement_committed = true;
        if let Err(error) = self.release_source(claimed, &source).await {
            self.report(
                "warn",
                "Chat relocation committed but source runtime cleanup failed",
                &error,
                json!({"chatRelocationJobId":claimed["job"]["id"]}),
            );
        }
        Ok(())
    }
}
