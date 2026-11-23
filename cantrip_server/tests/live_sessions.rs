use anyhow::Result;
use cantrip_server::live::{SessionRegistry, Socket};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

struct Probe {
    open: AtomicBool,
    closed: Mutex<Vec<(u16, String)>>,
}
impl Probe {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            open: AtomicBool::new(true),
            closed: Mutex::new(Vec::new()),
        })
    }
}
impl Socket for Probe {
    fn is_open(&self) -> bool {
        self.open.load(Ordering::Acquire)
    }
    fn buffered_amount(&self) -> usize {
        0
    }
    fn send(&self, _text: Arc<str>) -> Result<()> {
        Ok(())
    }
    fn close(&self, code: u16, reason: &str) {
        if self.open.swap(false, Ordering::AcqRel) {
            self.closed.lock().unwrap().push((code, reason.into()));
        }
    }
}
#[test]
fn account_capacity_is_released_by_transport_lifetime_not_revocation() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let changed = events.clone();
    let registry = SessionRegistry::new(
        2,
        Arc::new(move |owner, session| {
            changed
                .lock()
                .unwrap()
                .push((owner.to_owned(), session.to_owned()))
        }),
    );
    let one = Probe::new();
    let two = Probe::new();
    let excess = Probe::new();
    let other = Probe::new();
    let first = registry
        .register(one.clone(), "owner-one", Some("session-one"))
        .unwrap();
    let second = registry
        .register(two.clone(), "owner-one", Some("session-one"))
        .unwrap();
    let unrelated = registry
        .register(other.clone(), "owner-two", Some("session-two"))
        .unwrap();
    assert_eq!(
        *events.lock().unwrap(),
        vec![
            ("owner-one".into(), "session-one".into()),
            ("owner-two".into(), "session-two".into())
        ]
    );
    assert!(
        registry
            .register(excess.clone(), "owner-one", Some("rejected"))
            .is_none()
    );
    assert_eq!(
        *excess.closed.lock().unwrap(),
        vec![(1013, "Account WebSocket connection limit reached".into())]
    );
    assert!(!registry.connected("rejected"));
    assert_eq!(
        registry.close_session("session-one", "Session was revoked"),
        2
    );
    assert!(!registry.connected("session-one"));
    assert!(registry.connected("session-two"));
    assert_eq!(registry.account_count("owner-one"), 2);
    assert!(other.is_open());
    assert_eq!(
        *one.closed.lock().unwrap(),
        vec![(1008, "Session was revoked".into())]
    );
    assert_eq!(
        *two.closed.lock().unwrap(),
        vec![(1008, "Session was revoked".into())]
    );
    drop(first);
    assert_eq!(registry.account_count("owner-one"), 1);
    assert_eq!(events.lock().unwrap().len(), 2);
    drop(second);
    assert_eq!(registry.account_count("owner-one"), 0);
    assert_eq!(
        events.lock().unwrap().last(),
        Some(&("owner-one".into(), "session-one".into()))
    );
    let replacement = registry.register(Probe::new(), "owner-one", None).unwrap();
    assert_eq!(registry.account_count("owner-one"), 1);
    assert_eq!(events.lock().unwrap().len(), 3);
    drop(replacement);
    drop(unrelated);
    assert_eq!(registry.account_count("owner-one"), 0);
    assert_eq!(registry.account_count("owner-two"), 0);
    assert!(registry.active_sessions().is_empty());
}
#[test]
fn owner_closure_preserves_other_owners_and_tracks_anonymous_capacity() {
    let registry = SessionRegistry::new(8, Arc::new(|_, _| {}));
    let first = Probe::new();
    let second = Probe::new();
    let anonymous = Probe::new();
    let unrelated = Probe::new();
    let registrations = [
        registry
            .register(first.clone(), "owner-one", Some("first"))
            .unwrap(),
        registry
            .register(second.clone(), "owner-one", Some("second"))
            .unwrap(),
        registry
            .register(anonymous.clone(), "owner-one", None)
            .unwrap(),
        registry
            .register(unrelated.clone(), "owner-two", Some("other"))
            .unwrap(),
    ];
    assert_eq!(
        registry.active_sessions(),
        vec![
            ("first".into(), "owner-one".into()),
            ("second".into(), "owner-one".into()),
            ("other".into(), "owner-two".into())
        ]
    );
    assert_eq!(
        registry.close_owner("owner-one", "Account sessions were revoked"),
        2
    );
    assert!(!first.is_open());
    assert!(!second.is_open());
    assert!(anonymous.is_open());
    assert!(unrelated.is_open());
    assert_eq!(registry.account_count("owner-one"), 3);
    assert_eq!(
        registry.active_sessions(),
        vec![("other".into(), "owner-two".into())]
    );
    assert_eq!(registry.close_all("Server is shutting down"), 1);
    assert!(!unrelated.is_open());
    assert!(anonymous.is_open());
    drop(registrations);
    assert_eq!(registry.account_count("owner-one"), 0);
    assert_eq!(registry.account_count("owner-two"), 0);
}
#[test]
fn an_empty_session_identity_has_anonymous_presence_but_consumes_capacity() {
    let registry = SessionRegistry::new(
        1,
        Arc::new(|_, _| panic!("An empty session must not publish presence")),
    );
    let socket = Probe::new();
    let registration = registry
        .register(socket.clone(), "owner", Some(""))
        .unwrap();
    assert!(registry.active_sessions().is_empty());
    assert_eq!(registry.account_count("owner"), 1);
    assert_eq!(registry.close_all("Server is shutting down"), 0);
    assert!(socket.is_open());
    drop(registration);
    assert_eq!(registry.account_count("owner"), 0);
}
