//! Account capacity follows transport lifetime; session presence follows the
//! reference registry, including immediate removal when sessions are revoked.
use super::Socket;
use indexmap::{IndexMap, IndexSet};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

pub type SessionChange = Arc<dyn Fn(&str, &str) + Send + Sync>;
struct Session {
    owner: String,
    sockets: Mutex<IndexMap<Uuid, Arc<dyn Socket>>>,
}
#[derive(Default)]
struct State {
    accounts: HashMap<String, IndexSet<Uuid>>,
    sessions: IndexMap<String, Arc<Session>>,
}
pub struct SessionRegistry {
    limit: usize,
    changed: SessionChange,
    state: Mutex<State>,
}
pub struct Registration {
    registry: Arc<SessionRegistry>,
    owner: String,
    socket: Uuid,
    session: Option<(String, Arc<Session>)>,
}
impl SessionRegistry {
    pub fn new(limit: usize, changed: SessionChange) -> Arc<Self> {
        Arc::new(Self {
            limit,
            changed,
            state: Mutex::new(State::default()),
        })
    }
    pub fn register(
        self: &Arc<Self>,
        socket: Arc<dyn Socket>,
        owner: &str,
        session: Option<&str>,
    ) -> Option<Registration> {
        // registerSessionSocket skips an empty session identity, just as it
        // skips an absent one; the independent account permit is still held.
        let session = session.filter(|id| !id.is_empty());
        let mut state = self.state.lock().unwrap();
        if state.accounts.get(owner).map_or(0, IndexSet::len) >= self.limit {
            drop(state);
            socket.close(1013, "Account WebSocket connection limit reached");
            return None;
        }
        let socket_id = Uuid::new_v4();
        state
            .accounts
            .entry(owner.into())
            .or_default()
            .insert(socket_id);
        let mut connected = false;
        let session = session.map(|id| {
            let entry = state
                .sessions
                .entry(id.into())
                .or_insert_with(|| {
                    Arc::new(Session {
                        owner: owner.into(),
                        sockets: Mutex::new(IndexMap::new()),
                    })
                })
                .clone();
            {
                let mut sockets = entry.sockets.lock().unwrap();
                connected = sockets.is_empty();
                sockets.insert(socket_id, socket.clone());
            }
            (id.to_owned(), entry)
        });
        drop(state);
        if connected {
            (self.changed)(owner, &session.as_ref().unwrap().0);
        }
        Some(Registration {
            registry: self.clone(),
            owner: owner.into(),
            socket: socket_id,
            session,
        })
    }
    pub fn connected(&self, session: &str) -> bool {
        self.state.lock().unwrap().sessions.contains_key(session)
    }
    pub fn account_count(&self, owner: &str) -> usize {
        self.state
            .lock()
            .unwrap()
            .accounts
            .get(owner)
            .map_or(0, IndexSet::len)
    }
    pub fn active_sessions(&self) -> Vec<(String, String)> {
        self.state
            .lock()
            .unwrap()
            .sessions
            .iter()
            .map(|(id, entry)| (id.clone(), entry.owner.clone()))
            .collect()
    }
    pub fn close_session(&self, session: &str, reason: &str) -> usize {
        self.close_matching(|id, _| id == session, reason)
    }
    pub fn close_owner(&self, owner: &str, reason: &str) -> usize {
        self.close_matching(|_, id| id == owner, reason)
    }
    pub fn close_all(&self, reason: &str) -> usize {
        self.close_matching(|_, _| true, reason)
    }
    fn close_matching(&self, matches: impl Fn(&str, &str) -> bool, reason: &str) -> usize {
        let mut state = self.state.lock().unwrap();
        let ids = state
            .sessions
            .iter()
            .filter(|(id, entry)| matches(id, &entry.owner))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let groups = ids
            .into_iter()
            .filter_map(|id| state.sessions.shift_remove(&id))
            .collect::<Vec<_>>();
        drop(state);
        let sockets = groups
            .iter()
            .flat_map(|group| {
                group
                    .sockets
                    .lock()
                    .unwrap()
                    .values()
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>();
        for socket in &sockets {
            socket.close(1008, reason);
        }
        sockets.len()
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        let mut state = self.registry.state.lock().unwrap();
        if let Some(account) = state.accounts.get_mut(&self.owner) {
            account.shift_remove(&self.socket);
            if account.is_empty() {
                state.accounts.remove(&self.owner);
            }
        }
        let disconnected = self.session.as_ref().is_some_and(|(id, session)| {
            let mut sockets = session.sockets.lock().unwrap();
            sockets.shift_remove(&self.socket);
            if sockets.is_empty() {
                state.sessions.shift_remove(id);
                true
            } else {
                false
            }
        });
        drop(state);
        if disconnected {
            (self.registry.changed)(&self.owner, &self.session.as_ref().unwrap().0);
        }
    }
}
