//! Bounded, reconnectable lifecycle observations for account device sign-in.
use cantrip_history::projection::Work;
use cantrip_wire::{Value, value::json};
use indexmap::IndexMap;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{Notify, watch},
    task::JoinHandle,
    time::Instant,
};

const TTL: Duration = Duration::from_secs(15 * 60);
const POLL: Duration = Duration::from_secs(5);
const MAX_OBSERVATIONS: usize = 64;

pub type ReadStatus = Arc<dyn Fn(watch::Receiver<bool>) -> Work<Value> + Send + Sync>;
type Emit = Arc<dyn Fn(Value) + Send + Sync>;

struct Session {
    command: Value,
    sequence: u64,
    expires: String,
    last: Value,
    stop: watch::Sender<bool>,
}

#[derive(Default)]
struct State {
    closed: bool,
    sessions: IndexMap<PathBuf, Session>,
    tasks: Vec<JoinHandle<()>>,
}

#[derive(Clone)]
pub struct Observer {
    state: Arc<Mutex<State>>,
    emit: Emit,
}

impl Observer {
    pub fn new(emit: Emit) -> Self {
        Self {
            state: Arc::default(),
            emit,
        }
    }

    pub fn start(&self, home: PathBuf, command: Value, wake: Arc<Notify>, read: ReadStatus) {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return;
        }
        if let Some(previous) = state.sessions.shift_remove(&home) {
            previous.stop.send_replace(true);
        }
        if state.sessions.len() == MAX_OBSERVATIONS
            && let Some((_, oldest)) = state.sessions.shift_remove_index(0)
        {
            oldest.stop.send_replace(true);
        }
        let (stop, stopped) = watch::channel(false);
        let expires = chrono::Utc::now() + chrono::Duration::seconds(TTL.as_secs() as i64);
        let mut session = Session {
            command,
            sequence: 0,
            expires: timestamp(expires),
            last: inactive("pending", None),
            stop,
        };
        self.publish(&mut session);
        state.sessions.insert(home.clone(), session);
        state.tasks.retain(|task| !task.is_finished());
        let this = self.clone();
        state.tasks.push(tokio::spawn(async move {
            this.observe(home, stopped, wake, read).await;
        }));
    }

    async fn observe(
        &self,
        home: PathBuf,
        mut stopped: watch::Receiver<bool>,
        wake: Arc<Notify>,
        read: ReadStatus,
    ) {
        let deadline = Instant::now() + TTL;
        loop {
            if *stopped.borrow() {
                return;
            }
            let status = if Instant::now() >= deadline {
                Some(inactive("expired", Some("authorization-expired")))
            } else {
                read(stopped.clone()).await.ok().as_ref().and_then(project)
            };
            if let Some(status) = status {
                let mut state = self.state.lock().unwrap();
                if let Some(session) = state.sessions.get_mut(&home)
                    && session.stop.subscribe().same_channel(&stopped)
                    && !*stopped.borrow()
                {
                    session.stop.send_replace(true);
                    session.last = status;
                    self.publish(session);
                }
                return;
            }
            tokio::select! {
                _ = stopped.changed() => return,
                _ = wake.notified() => {},
                _ = tokio::time::sleep_until(deadline.min(Instant::now() + POLL)) => {},
            }
        }
    }

    pub fn cancel(&self, home: &Path) {
        let mut state = self.state.lock().unwrap();
        if let Some(session) = state.sessions.get_mut(home)
            && !session.stop.send_replace(true)
        {
            session.last = inactive("cancelled", Some("authorization-cancelled"));
            self.publish(session);
        }
    }

    pub fn reemit(&self) {
        for session in self.state.lock().unwrap().sessions.values_mut() {
            self.publish(session);
        }
    }

    pub fn stop(&self) -> Vec<JoinHandle<()>> {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        for (_, session) in state.sessions.drain(..) {
            session.stop.send_replace(true);
        }
        std::mem::take(&mut state.tasks)
    }

    fn publish(&self, session: &mut Session) {
        session.sequence += 1;
        (self.emit)(json!({
            "type":"provider.auth.status.observed",
            "observationId":session.command["observationId"],
            "providerId":session.command["providerId"],
            "providerAccountId":session.command["providerAccountId"],
            "providerKind":session.command["providerKind"],
            "sequence":session.sequence, "observedAt":timestamp(chrono::Utc::now()),
            "expiresAt":session.expires, "status":session.last
        }));
    }
}

fn timestamp(time: chrono::DateTime<chrono::Utc>) -> String {
    time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn inactive(state: &str, failure: Option<&str>) -> Value {
    json!({
        "state":state,"authMode":Value::Null,"email":Value::Null,"planType":Value::Null,
        "weeklyUsage":Value::Null,"failureCode":failure
    })
}

fn project(status: &Value) -> Option<Value> {
    if status["authenticated"] == true {
        return Some(json!({
            "state":"authenticated","authMode":status["authMode"],"email":status["email"],
            "planType":status["planType"],"weeklyUsage":status["weeklyUsage"],"failureCode":Value::Null
        }));
    }
    if status["loginPending"] == true {
        return None;
    }
    let error = status["loginError"].as_str()?.to_lowercase();
    let (state, failure) = if error.contains("expired") {
        ("expired", "authorization-expired")
    } else if error.contains("cancel") {
        ("cancelled", "authorization-cancelled")
    } else if error.contains("denied") {
        ("failed", "authorization-denied")
    } else {
        ("failed", "authorization-failed")
    };
    Some(inactive(state, Some(failure)))
}
