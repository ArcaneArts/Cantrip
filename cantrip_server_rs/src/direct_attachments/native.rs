use super::*;
use crate::workers::command_bus::LimitedCommandBus;
use anyhow::Context;
use std::time::Duration;
impl Coordinator {
    pub fn native(
        commands: Arc<LimitedCommandBus>,
        bridge: Arc<WorkerBridge>,
        mut options: Options,
    ) -> Arc<Self> {
        let connected = Arc::downgrade(&bridge);
        options.connected = Arc::new(move |worker| {
            connected
                .upgrade()
                .is_some_and(|bridge| worker.as_str().is_some_and(|id| bridge.is_connected(id)))
        });
        let workers: WorkerRequest = Arc::new(move |worker, command, _owner| {
            let commands = commands.clone();
            async move {
                // LimitedWorkerCommandBus resolves the owner itself in both
                // runtimes; caller-provided ownership never bypasses that lookup.
                Ok(commands
                    .request(
                        worker
                            .as_str()
                            .context("Enrolled direct attachment worker")?,
                        command,
                        Some(Duration::from_secs(5)),
                        None,
                    )
                    .await?
                    .unwrap_or(Value::Null))
            }
            .boxed()
        });
        Self::construct(workers, options, Some(bridge))
    }
}
