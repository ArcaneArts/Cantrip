//! Production execution graph. Every turn, recovery, receipt and scheduler uses
//! the same worker command bus, durable writers and owner-scoped Live service.
mod notifications;
mod scheduling;
mod turns;
mod usage;

use super::{
    account_failover,
    automatic_title::MessageTitles,
    automation_pause, goals,
    live_mutations::Service as Live,
    managed_console::ManagedConsole,
    recovery,
    routing::ModelRouting,
    runtime_quota,
    runtime_telemetry::RuntimeTelemetry,
    task_recovery,
    turn_runtime::{bootstrap::Bootstrap, engine::Runtime, events, stages::Clock},
};
use crate::{
    database::Database,
    live::LiveService,
    native_commands::runtime::{
        delivery::QueueDelivery, receipt_service::ReceiptService, receipts::ReceiptNotifications,
    },
    operations::logging::Logger,
    task_scheduling::{operation_queue, project_pause, scheduler},
    wire::{Value, value::json},
    workers::{
        bridge::{NotificationSubscription, WorkerBridge},
        command_bus::LimitedCommandBus,
    },
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub struct Dependencies {
    pub database: Arc<Database>,
    pub commands: Arc<LimitedCommandBus>,
    pub bridge: Arc<WorkerBridge>,
    pub routing: Arc<ModelRouting>,
    pub console: Arc<ManagedConsole>,
    pub live: Arc<Live>,
    pub application_live: Arc<LiveService>,
    pub account_failover: Arc<account_failover::Service>,
    pub server_id: String,
    pub instance_id: String,
    pub logger: Logger,
}

pub struct Service {
    pub runtime: Arc<Runtime>,
    pub recovery: Arc<recovery::Service>,
    pub goals: Arc<goals::Service>,
    pub task_recovery: Arc<task_recovery::Service>,
    pub pause: Arc<automation_pause::Service>,
    pub queue: Arc<operation_queue::Service>,
    pub project_pause: Arc<project_pause::Service>,
    pub scheduler: Arc<scheduler::Service>,
    pub outcomes: Arc<recovery::outcomes::Service>,
    pub receipts: Arc<ReceiptService>,
    pub receipt_notifications: ReceiptNotifications,
    queue_delivery: Arc<QueueDelivery>,
    outcome_timers: Arc<recovery::scheduler::Scheduler>,
    quota: Arc<runtime_quota::Service>,
    titles: Arc<MessageTitles>,
    usage: Arc<usage::Invalidations>,
    bridge: Arc<WorkerBridge>,
    logger: Logger,
    subscriptions: Mutex<HashMap<String, NotificationSubscription>>,
}

impl Service {
    pub fn new(dependencies: Dependencies) -> Arc<Self> {
        let d = &dependencies;
        let clock: Clock = Arc::new(|| crate::auth::now().timestamp_millis());
        let usage = usage::Invalidations::new(d.application_live.clone());
        let telemetry = Arc::new(RuntimeTelemetry::new(
            d.database.clone(),
            {
                let usage = usage.clone();
                Arc::new(move |event| usage.schedule(event))
            },
            d.logger.clone(),
        ));
        let quota = runtime_quota::Service::new(
            d.database.clone(),
            d.commands.clone(),
            {
                let live = d.application_live.clone();
                Arc::new(move |event| {
                    if let Some(owner) = event["ownerId"].as_str() {
                        live.invalidate_resource(owner, "settings");
                    }
                })
            },
            d.logger.clone(),
        );
        let events = events::Dependencies {
            database: d.database.clone(),
            live: d.live.clone(),
            commands: d.commands.clone(),
            telemetry,
            quota: quota.clone(),
            clock: clock.clone(),
        };
        let bootstrap = Bootstrap::with_observation(
            d.database.clone(),
            d.routing.clone(),
            d.console.clone(),
            d.commands.clone(),
            d.live.clone(),
            d.logger.clone(),
            clock.clone(),
        );
        let titles = MessageTitles::new(
            d.database.clone(),
            d.routing.clone(),
            d.commands.clone(),
            d.live.clone(),
            d.logger.clone(),
        );
        let outcome_timers = recovery::scheduler::Scheduler::new();
        let mut composed = None;
        let scheduler = scheduler::Service::new_cyclic(|tick| {
            let turns = turns::build(
                d,
                events,
                bootstrap,
                titles.clone(),
                outcome_timers.clone(),
                tick.clone(),
            );
            let scheduled = scheduling::build(d, &turns, titles.clone(), clock, tick.clone());
            let outcomes = recovery::outcomes::Service::new(recovery::outcomes::Dependencies {
                database: d.database.clone(),
                live: d.live.clone(),
                commands: d.commands.clone(),
                goals: turns.goals.clone(),
                continuation: turns.recovery.clone(),
                queue_tick: tick,
                logger: d.logger.clone(),
            });
            composed = Some((turns, scheduled.queue, scheduled.project_pause, outcomes));
            scheduled.dependencies
        });
        let (turns, queue, project_pause, outcomes) = composed.expect("Production execution graph");
        let receipt_notifications = ReceiptNotifications::default();
        let receipts = ReceiptService::new(
            d.database.clone(),
            receipt_notifications.clone(),
            {
                let live = d.live.clone();
                Arc::new(move |event| {
                    let (Some(owner), Some(chat)) =
                        (event["ownerId"].as_str(), event["chatId"].as_str())
                    else {
                        return;
                    };
                    if event["type"] == "boundary" {
                        live.publish_boundary(
                            owner,
                            chat,
                            &event["projectId"],
                            Some(&event["context"]),
                        );
                    } else {
                        live.publish_invalidation(owner, chat, "chat", None);
                    }
                })
            },
            {
                let recovery = turns.recovery.clone();
                Arc::new(move |owner, chat| recovery.dispatch(&owner, &chat))
            },
            d.logger.clone(),
        );
        let queue_delivery = QueueDelivery::new(
            d.database.clone(),
            d.commands.clone(),
            {
                let live = d.live.clone();
                Arc::new(move |owner, chat| {
                    live.publish_invalidation(&owner, &chat, "chat-queue", None);
                    Ok(())
                })
            },
            Some({
                let recovery = turns.recovery.clone();
                Arc::new(move |owner, chat| recovery.dispatch(&owner, &chat))
            }),
            {
                let logger = d.logger.clone();
                Arc::new(move |error| {
                    logger(crate::operations::logging::LogCall::event(
                        "warn",
                        "Managed queue notification will retry",
                        json!({"err":crate::operations::logging::error_details(&error)}),
                    ))
                })
            },
        );
        Arc::new(Self {
            runtime: turns.runtime,
            recovery: turns.recovery,
            goals: turns.goals,
            task_recovery: turns.task_recovery,
            pause: turns.pause,
            queue,
            project_pause,
            scheduler,
            outcomes,
            receipts,
            receipt_notifications,
            queue_delivery,
            outcome_timers,
            quota,
            titles,
            usage,
            bridge: d.bridge.clone(),
            logger: d.logger.clone(),
            subscriptions: Mutex::default(),
        })
    }

    pub fn start(&self) {
        self.scheduler.start();
        self.queue_delivery.start();
    }

    /// Stop sources of new background work before closing the worker bridge.
    pub fn stop(&self) {
        self.queue_delivery.stop();
        self.scheduler.stop_timer();
        self.scheduler.stop_automatic_retries();
        self.outcome_timers.clear();
        self.goals.close();
        self.subscriptions.lock().unwrap().clear();
        self.usage.close();
    }

    /// The bridge must settle pending requests before this drains their writers.
    pub async fn drained(&self) {
        self.queue_delivery.drained().await;
        self.scheduler.drained().await;
        self.outcome_timers.drained().await;
        self.outcomes.drained().await;
        self.receipts.drained().await;
        self.project_pause.drained().await;
        self.queue.drained().await;
        self.runtime.drained().await;
        self.recovery.drained().await;
        self.task_recovery.drained().await;
        self.pause.drained().await;
        self.goals.drained().await;
        self.titles.drained().await;
        self.quota.close().await;
    }
}
