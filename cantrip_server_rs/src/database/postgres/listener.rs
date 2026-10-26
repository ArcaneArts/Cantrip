use std::{collections::BTreeSet, time::Duration};

use anyhow::{Context, Result};
use tokio::{
    sync::{Mutex, mpsc, oneshot, watch},
    task::JoinHandle,
};

use super::{Factory, Notifications, Session};

struct Registration {
    channel: String,
    reply: oneshot::Sender<Result<()>>,
}

pub(super) struct Listener {
    commands: mpsc::UnboundedSender<Registration>,
    stop: watch::Sender<bool>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Listener {
    pub(super) fn new(factory: Factory, notifications: Notifications) -> Self {
        let (commands, receiver) = mpsc::unbounded_channel();
        let (stop, stopping) = watch::channel(false);
        let task = tokio::spawn(run(factory, notifications, receiver, stopping));
        Self {
            commands,
            stop,
            task: Mutex::new(Some(task)),
        }
    }

    pub(super) async fn listen(&self, channel: &str) -> Result<()> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Registration {
                channel: channel.to_owned(),
                reply,
            })
            .map_err(|_| anyhow::anyhow!("database listener is closed"))?;
        result.await.context("database listener is closed")?
    }

    pub(super) async fn close(&self) -> Result<()> {
        self.stop.send_replace(true);
        let mut task = self.task.lock().await;
        if let Some(running) = task.as_mut() {
            running.await.context("join PostgreSQL listener")?;
            *task = None;
        }
        Ok(())
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        if let Some(task) = self.task.get_mut().take() {
            task.abort();
        }
    }
}

async fn stopped(stop: &mut watch::Receiver<bool>) {
    if !*stop.borrow() {
        let _ = stop.changed().await;
    }
}

fn statement(channel: &str) -> String {
    format!("LISTEN \"{}\"", channel.replace('"', "\"\""))
}

async fn retry(stop: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        _ = stopped(stop) => false,
        _ = tokio::time::sleep(Duration::from_secs(1)) => true,
    }
}

async fn run(
    factory: Factory,
    notifications: Notifications,
    mut commands: mpsc::UnboundedReceiver<Registration>,
    mut stop: watch::Receiver<bool>,
) {
    let mut session: Option<Session> = None;
    let mut channels = BTreeSet::<String>::new();
    loop {
        if *stop.borrow() {
            break;
        }
        if session.is_none() && !channels.is_empty() {
            let connection = tokio::select! {
                _ = stopped(&mut stop) => break,
                result = factory.connect(Some(notifications.clone())) => result,
            };
            match connection {
                Ok(connected) => session = Some(connected),
                Err(_) => {
                    // Reconnect only after an actual connection failure, and
                    // restore every established subscription on the new one.
                    if !retry(&mut stop).await {
                        break;
                    }
                    continue;
                }
            }
            let sql = channels
                .iter()
                .map(|channel| statement(channel))
                .collect::<Vec<_>>()
                .join(";");
            // Keep ownership in the actor while restoring subscriptions. If
            // shutdown interrupts this await, final cleanup cancels the actual
            // statement before dropping its driver.
            let restored = tokio::select! {
                _ = stopped(&mut stop) => break,
                result = session.as_ref().unwrap().client.batch_execute(&sql) => result,
            };
            if restored.is_err() {
                if let Some(connected) = session.take() {
                    factory.cancel(&connected).await;
                }
                if !retry(&mut stop).await {
                    break;
                }
                continue;
            }
        }
        let command = if let Some(connected) = session.as_mut() {
            tokio::select! {
                _ = stopped(&mut stop) => break,
                _ = &mut connected.driver => { session.take(); continue; }
                command = commands.recv() => command,
            }
        } else {
            tokio::select! {
                _ = stopped(&mut stop) => break,
                command = commands.recv() => command,
            }
        };
        let Some(command) = command else {
            break;
        };
        if session.is_none() {
            let connection = tokio::select! {
                _ = stopped(&mut stop) => break,
                result = factory.connect(Some(notifications.clone())) => result.map_err(Into::into),
            };
            match connection {
                Ok(connected) => session = Some(connected),
                Err(error) => {
                    let _ = command.reply.send(Err(error));
                    continue;
                }
            }
        }
        let sql = statement(&command.channel);
        let result = tokio::select! {
            _ = stopped(&mut stop) => break,
            result = session.as_ref().unwrap().client.batch_execute(&sql) => result,
        };
        if result.is_ok() {
            channels.insert(command.channel);
        }
        let _ = command.reply.send(result.map_err(Into::into));
    }
    if let Some(connected) = session.take() {
        factory.cancel(&connected).await;
    }
}
