use super::*;
use crate::chats::{
    recovery::task_services::TaskServices,
    turn_runtime::engine::{self, Hooks},
};
use anyhow::Context;
use futures::FutureExt;

pub(super) struct Turns {
    pub runtime: Arc<Runtime>,
    pub recovery: Arc<recovery::Service>,
    pub goals: Arc<goals::Service>,
    pub task_recovery: Arc<task_recovery::Service>,
    pub pause: Arc<automation_pause::Service>,
}
pub(super) fn build(
    d: &Dependencies,
    events: events::Dependencies,
    bootstrap: Arc<Bootstrap>,
    titles: Arc<MessageTitles>,
    timers: Arc<recovery::scheduler::Scheduler>,
    tick: scheduler::Wakeup,
) -> Turns {
    let clock = events.clock.clone();
    let mut composed = None;
    let runtime = Runtime::new_cyclic(|runtime| {
        let mut task_services = None;
        let recovery = recovery::Service::new_cyclic(|recovery| {
            let goals = goals::Service::new(goals::Dependencies {
                database: d.database.clone(),
                commands: d.commands.clone(),
                routing: d.routing.clone(),
                console: d.console.clone(),
                live: d.live.clone(),
                logger: d.logger.clone(),
                clock: clock.clone(),
                queue_tick: tick,
                begin: Arc::new({
                    let runtime = runtime.clone();
                    move |owner, context, input, options, hooks| {
                        let runtime = runtime.clone();
                        async move {
                            runtime
                                .upgrade()
                                .context("Turn runtime unavailable")?
                                .begin(&owner, &context, &input, &options, hooks)
                                .await
                        }
                        .boxed()
                    }
                }),
                pending: Arc::new({
                    let recovery = recovery.clone();
                    move |owner, chat| {
                        let recovery = recovery.clone();
                        async move {
                            recovery
                                .upgrade()
                                .context("Turn recovery unavailable")?
                                .continue_worktree_transition(&owner, &chat)
                                .await
                        }
                        .boxed()
                    }
                }),
                queue: Arc::new({
                    let recovery = recovery.clone();
                    move |owner, chat| {
                        let recovery = recovery.clone();
                        async move {
                            recovery
                                .upgrade()
                                .context("Turn recovery unavailable")?
                                .dispatch(&owner, &chat)
                                .await
                        }
                        .boxed()
                    }
                }),
            });
            let pause = automation_pause::Service::new(
                d.database.clone(),
                d.commands.clone(),
                goals.clone(),
                d.live.clone(),
                d.logger.clone(),
            );
            let task_recovery = task_recovery::Service::new(task_recovery::Dependencies {
                database: d.database.clone(),
                commands: d.commands.clone(),
                goals: goals.clone(),
                lease_owner: format!("{}:{}", d.server_id, d.instance_id),
                clock,
                publish: Arc::new({
                    let live = d.live.clone();
                    move |owner, chat, project| {
                        live.publish_summary(owner, &json!(chat), &json!(project));
                        live.publish_invalidation(
                            owner,
                            chat,
                            "task",
                            Some(&json!({"experience":"task","projectId":project})),
                        );
                    }
                }),
                unpause: Arc::new({
                    let pause = pause.clone();
                    move |owner, chat| {
                        pause
                            .set(&owner, &chat, false, false)
                            .map(|r| r.map(|_| ()))
                            .boxed()
                    }
                }),
                report: Arc::new({
                    let logger = d.logger.clone();
                    move |_owner, chat, error| {
                        logger(crate::operations::logging::LogCall::event(
                            "warn",
                            "Could not observe a retained Task session for recovery",
                            json!({"chatId":chat,"err":crate::operations::logging::error_details(&error)}),
                        ))
                    }
                }),
            });
            let tasks = TaskServices::new(goals.clone(), task_recovery.clone());
            task_services = Some((goals, task_recovery, pause));
            recovery::Dependencies {
                database: d.database.clone(),
                live: d.live.clone(),
                commands: d.commands.clone(),
                routing: d.routing.clone(),
                console: d.console.clone(),
                tasks,
                outcomes: timers,
                logger: d.logger.clone(),
                prepare_account: d.account_failover.queued_preparation(),
                begin: Arc::new({
                    let runtime = runtime.clone();
                    move |owner, context, input, options| {
                        let runtime = runtime.clone();
                        async move {
                            runtime
                                .upgrade()
                                .context("Turn runtime unavailable")?
                                .begin(&owner, &context, &input, &options, Hooks::default())
                                .await
                        }
                        .boxed()
                    }
                }),
            }
        });
        let (goals, task_recovery, pause) = task_services.expect("Production Task services");
        composed = Some((recovery.clone(), goals, task_recovery, pause));
        engine::Dependencies {
            events,
            bootstrap,
            titles,
            routing: d.routing.clone(),
            continuation: recovery,
            logger: d.logger.clone(),
            server_id: d.server_id.clone(),
        }
    });
    let (recovery, goals, task_recovery, pause) = composed.expect("Production turn services");
    Turns {
        runtime,
        recovery,
        goals,
        task_recovery,
        pause,
    }
}
