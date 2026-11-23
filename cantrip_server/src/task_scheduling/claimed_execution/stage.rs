use super::*;
use std::{future::Future, sync::Mutex, time::Duration};
pub(super) fn delay(ms: f64) -> Duration {
    Duration::from_millis(if (1.0..=2_147_483_647.0).contains(&ms) {
        ms.trunc() as u64
    } else {
        1
    })
}
pub(super) fn error_details(error: &anyhow::Error) -> Value {
    let mut details = logging::error_details(error);
    if downcast_ref::<TaskLaunchStageTimeout>(error).is_some() {
        details["name"] = json!("TaskLaunchStageTimeoutError");
    } else if let Some(lane) = downcast_ref::<LaneError>(error) {
        details["name"] = json!(lane.class_name());
    } else if let Some(conflict) = downcast_ref::<task_dispatch::Conflict>(error) {
        details["name"] = json!("TaskDispatchConflictError");
        details["code"] = json!(conflict.code);
    } else if let Some(conflict) = downcast_ref::<tasks::Conflict>(error) {
        details["name"] = json!("TaskConflictError");
        details["code"] = json!(conflict.code);
    }
    details
}
struct Slow {
    active: Arc<Mutex<bool>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Slow {
    fn drop(&mut self) {
        *self.active.lock().unwrap() = false;
        self.task.abort();
    }
}
impl Service {
    pub(super) fn stage<T: Send + 'static, F: Future<Output = Result<T>> + Send + 'static>(
        self: &Arc<Self>,
        claim: &Value,
        stage: &'static str,
        operation: F,
    ) -> BoxFuture<'static, Result<T>> {
        let (this, claim) = (self.clone(), claim.clone());
        self.operations.run(async move {
            let began=(this.dependencies.clock)();
            let fields=json!({"event":"task.operation.launch-stage","subsystem":"task-scheduler","operation":"launch-operation","chatId":claim["cycle"]["chatId"],"cycleId":claim["cycle"]["id"],"serverVersion":crate::settings::quota::server_version(),"stage":stage,"phase":stage});
            let mut started=fields.clone();started["status"]=json!("started");
            this.log("info","Scheduled Task launch stage started",started);
            let slow=this.dependencies.limits.slow_warning_ms.map(|ms| {
                let active=Arc::new(Mutex::new(true));
                let (service,fields,enabled)=(this.clone(),fields.clone(),active.clone());
                let task=tokio::spawn(async move {
                    tokio::time::sleep(delay(ms)).await;
                    let enabled=enabled.lock().unwrap();
                    if *enabled {
                        let mut fields=fields;
                        fields["status"]=json!("waiting");fields["reasonCode"]=json!("slow-stage");fields["durationMs"]=json!((service.dependencies.clock)()-began);
                        service.log("warn","Scheduled Task launch stage is still waiting",fields);
                    }
                });
                Slow{active,task}
            });
            let result=this.operations.with_timeout(stage,this.dependencies.limits.preflight_timeout_ms,operation).await;
            drop(slow);
            let mut fields=fields;fields["durationMs"]=json!((this.dependencies.clock)()-began);
            match &result {
                Ok(_)=>{fields["status"]=json!("completed");this.log("info","Scheduled Task launch stage completed",fields);}
                Err(error)=>{
                    let details=error_details(error);
                    fields["status"]=json!("failed");fields["reasonCode"]=json!(if downcast_ref::<TaskLaunchStageTimeout>(error).is_some(){"stage-timeout"}else{"stage-failed"});fields["errorClass"]=details["name"].clone();fields["err"]=details;
                    this.log("warn","Scheduled Task launch stage failed",fields);
                }
            }
            result
        })
    }
}
