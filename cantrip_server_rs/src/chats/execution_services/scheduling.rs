use super::*;
use crate::task_scheduling::{automatic_retry, claimed_execution, eligibility, resumed_execution};

pub(super) struct Scheduled {
    pub dependencies: scheduler::Dependencies,
    pub queue: Arc<operation_queue::Service>,
    pub project_pause: Arc<project_pause::Service>,
}
pub(super) fn build(
    d: &Dependencies,
    turns: &turns::Turns,
    titles: Arc<MessageTitles>,
    clock: Clock,
    tick: scheduler::Wakeup,
) -> Scheduled {
    let claimed = claimed_execution::Service::new(claimed_execution::Dependencies {
        database: d.database.clone(),
        runtime: turns.runtime.clone(),
        goals: turns.goals.clone(),
        routing: d.routing.clone(),
        commands: d.commands.clone(),
        live: d.live.clone(),
        logger: d.logger.clone(),
        clock,
        queue_tick: tick.clone(),
        limits: Default::default(),
    });
    let resumed = resumed_execution::Service::new(resumed_execution::Dependencies {
        database: d.database.clone(),
        pause: turns.pause.clone(),
        goals: turns.goals.clone(),
        claimed: claimed.clone(),
        commands: d.commands.clone(),
        live: d.live.clone(),
    });
    let queue = operation_queue::Service::new(d.database.clone(), d.live.clone(), titles, tick);
    let retries = automatic_retry::Service::new(automatic_retry::Dependencies {
        database: d.database.clone(),
        recovery: turns.task_recovery.clone(),
        goals: turns.goals.clone(),
        queue: queue.clone(),
        live: d.live.clone(),
        logger: d.logger.clone(),
        clock: Arc::new(|| crate::auth::now().timestamp_millis() as f64),
    });
    Scheduled {
        dependencies: scheduler::Dependencies {
            database: d.database.clone(),
            retries,
            recovery: turns.task_recovery.clone(),
            eligibility: eligibility::Service::new(
                d.database.clone(),
                d.routing.clone(),
                d.bridge.clone(),
            ),
            claimed,
            resumed,
            live: d.live.clone(),
            logger: d.logger.clone(),
            server_id: d.server_id.clone(),
            instance_id: d.instance_id.clone(),
        },
        queue,
        project_pause: project_pause::Service::new(
            d.database.clone(),
            turns.pause.clone(),
            turns.goals.clone(),
            d.live.clone(),
        ),
    }
}
