use super::*;
pub(super) struct Retention(Option<tokio::sync::oneshot::Sender<()>>);
impl Drop for Retention {
    fn drop(&mut self) {
        self.0.take();
    }
}
struct Active(Arc<AtomicBool>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
impl Service {
    pub(super) fn retain_preflight(self: &Arc<Self>, claim: &Value) -> Retention {
        let (this, claim) = (self.clone(), claim.clone());
        let (stop, mut stopped) = tokio::sync::oneshot::channel();
        let active = Arc::new(AtomicBool::new(false));
        drop(self.operations.spawn(async move {
            let period=super::stage::delay(this.dependencies.limits.heartbeat_interval_ms);
            let mut ticks=tokio::time::interval_at(tokio::time::Instant::now()+period,period);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select!{biased; _=&mut stopped=>break,_=ticks.tick()=>{}}
                if active.swap(true,Ordering::SeqCst){continue;}
                let (service,claim,active)=(this.clone(),claim.clone(),Active(active.clone()));
                drop(this.operations.spawn(async move {
                    let _active=active;
                    if let Err(error)=service.dispatch.heartbeat(&claim["lease"],&Value::Null).await && downcast_ref::<task_dispatch::Conflict>(&error).is_none() {
                        service.log("warn","Could not retain the Task dispatch lease during launch preflight",json!({"event":"task.dispatch.preflight-heartbeat-failed","subsystem":"task-scheduler","operation":"launch-preflight","status":"degraded","chatId":claim["cycle"]["chatId"],"cycleId":claim["cycle"]["id"],"serverVersion":crate::settings::quota::server_version(),"err":super::stage::error_details(&error)}));
                    }
                    Ok(())
                }));
            }
            Ok(())
        }));
        Retention(Some(stop))
    }
}
