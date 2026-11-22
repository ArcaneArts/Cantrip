use super::*;
use std::{os::unix::net::UnixStream, sync::Mutex};
use zbus::{Connection, message::Header};

#[derive(Clone, PartialEq, Eq, Debug)]
enum Call {
    Start(OwnedObjectPath),
    Emulate(OwnedObjectPath),
    Close(OwnedObjectPath),
    Key(OwnedObjectPath),
}

#[derive(Default)]
struct Trace {
    calls: Mutex<Vec<Call>>,
    peer: Mutex<Option<UnixStream>>,
}

struct Remote {
    trace: Arc<Trace>,
    reject_close: bool,
}

struct Session {
    trace: Arc<Trace>,
    path: OwnedObjectPath,
    reject_close: bool,
}

fn portal_path(kind: &str, token: &str, options: &Results, header: &Header<'_>) -> OwnedObjectPath {
    let sender = header
        .sender()
        .unwrap()
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let token = <&str>::try_from(&options[token]).unwrap();
    OwnedObjectPath::try_from(format!("{PORTAL_PATH}/{kind}/{sender}/{token}")).unwrap()
}

async fn reply(
    bus: &Connection,
    header: &Header<'_>,
    options: &Results,
    results: Results,
) -> OwnedObjectPath {
    let path = portal_path("request", "handle_token", options, header);
    bus.emit_signal(
        None::<&str>,
        path.as_str(),
        "org.freedesktop.portal.Request",
        "Response",
        &(0_u32, results),
    )
    .await
    .unwrap();
    path
}

#[zbus::interface(name = "org.freedesktop.portal.RemoteDesktop")]
impl Remote {
    async fn create_session(
        &self,
        options: Results,
        #[zbus(connection)] bus: &Connection,
        #[zbus(header)] header: Header<'_>,
    ) -> OwnedObjectPath {
        let path = portal_path("session", "session_handle_token", &options, &header);
        bus.object_server()
            .at(
                path.clone(),
                Session {
                    trace: self.trace.clone(),
                    path: path.clone(),
                    reject_close: self.reject_close,
                },
            )
            .await
            .unwrap();
        let handle = OwnedValue::try_from(Value::from(path.as_str())).unwrap();
        reply(
            bus,
            &header,
            &options,
            [("session_handle".into(), handle)].into(),
        )
        .await
    }

    async fn select_devices(
        &self,
        _session: OwnedObjectPath,
        options: Results,
        #[zbus(connection)] bus: &Connection,
        #[zbus(header)] header: Header<'_>,
    ) -> OwnedObjectPath {
        reply(bus, &header, &options, Results::new()).await
    }

    async fn start(
        &self,
        session: OwnedObjectPath,
        _parent: String,
        options: Results,
        #[zbus(connection)] bus: &Connection,
        #[zbus(header)] header: Header<'_>,
    ) -> OwnedObjectPath {
        self.trace.calls.lock().unwrap().push(Call::Start(session));
        let streams = vec![(1_u32, Results::new())];
        let streams = OwnedValue::try_from(Value::from(streams)).unwrap();
        reply(
            bus,
            &header,
            &options,
            [
                ("devices".into(), DEVICES.into()),
                ("streams".into(), streams),
            ]
            .into(),
        )
        .await
    }

    #[zbus(name = "ConnectToEIS")]
    fn connect_to_eis(&self, session: OwnedObjectPath, _options: Results) -> OwnedFd {
        self.trace
            .calls
            .lock()
            .unwrap()
            .push(Call::Emulate(session));
        let (client, peer) = UnixStream::pair().unwrap();
        // The portal accepts the socket without making any usable devices available.
        *self.trace.peer.lock().unwrap() = Some(peer);
        std::os::fd::OwnedFd::from(client).into()
    }

    fn notify_keyboard_keysym(
        &self,
        session: OwnedObjectPath,
        _options: Results,
        _key: i32,
        _state: u32,
    ) {
        self.trace.calls.lock().unwrap().push(Call::Key(session));
    }
}

struct ScreenCast;

#[zbus::interface(name = "org.freedesktop.portal.ScreenCast")]
impl ScreenCast {
    async fn select_sources(
        &self,
        _session: OwnedObjectPath,
        options: Results,
        #[zbus(connection)] bus: &Connection,
        #[zbus(header)] header: Header<'_>,
    ) -> OwnedObjectPath {
        reply(bus, &header, &options, Results::new()).await
    }
}

#[zbus::interface(name = "org.freedesktop.portal.Session")]
impl Session {
    fn close(&self) -> zbus::fdo::Result<()> {
        self.trace
            .calls
            .lock()
            .unwrap()
            .push(Call::Close(self.path.clone()));
        if self.reject_close {
            return Err(zbus::fdo::Error::AccessDenied(
                "Fixture close denied".into(),
            ));
        }
        self.trace.peer.lock().unwrap().take();
        Ok(())
    }
}

#[test]
#[ignore = "requires an isolated D-Bus session"]
fn fallback_requires_the_older_session_to_close() {
    let bounds = Bounds {
        x: 0.0,
        y: 0.0,
        width: 1280.0,
        height: 800.0,
    };
    for reject_close in [false, true] {
        let trace = Arc::new(Trace::default());
        let server = async_io::block_on(
            zbus::connection::Builder::session()
                .unwrap()
                .serve_at(
                    PORTAL_PATH,
                    Remote {
                        trace: trace.clone(),
                        reject_close,
                    },
                )
                .unwrap()
                .serve_at(PORTAL_PATH, ScreenCast)
                .unwrap()
                .name(PORTAL_NAME)
                .unwrap()
                .build(),
        )
        .unwrap();

        let prefer = AtomicBool::new(true);
        let cancel = Cancellation::default();
        let session = DesktopSession::start(
            Portal::connect().unwrap(),
            bounds,
            &[bounds],
            &prefer,
            &cancel,
        );
        if reject_close {
            assert!(matches!(session, Err(error) if error.code == ErrorCode::InputFailed));
            assert!(prefer.load(Ordering::Relaxed));
            let calls = trace.calls.lock().unwrap();
            assert!(
                matches!(calls.as_slice(), [Call::Start(first), Call::Emulate(emulated), Call::Close(closed)]
                if first == emulated && first == closed),
                "{calls:?}"
            );
        } else {
            let session = session.unwrap();
            session.notify(&Event::Key(0x41, true), &cancel).unwrap();
            drop(session);
            assert!(!prefer.load(Ordering::Relaxed));
            let calls = trace.calls.lock().unwrap();
            assert!(
                matches!(calls.as_slice(), [
                Call::Start(first), Call::Emulate(emulated), Call::Close(retired), Call::Start(second), Call::Key(delivered), Call::Close(closed),
            ] if first == emulated && first == retired && first != second && second == delivered && second == closed),
                "{calls:?}"
            );
        }
        async_io::block_on(server.close()).unwrap();
    }
}
