use super::{
    emulated_input::{EmulatedInput, SelectedOutput},
    monitor_control::Event,
    portal::{PORTAL_NAME, PORTAL_PATH, Portal, Results, bounded, token},
};
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    interaction::MAX_HOST_CLIPBOARD_BYTES,
    target::Bounds,
};
use async_io::Timer;
use futures_lite::{StreamExt, future};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    io::Read,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use zbus::{
    MatchRule, MessageStream, Task,
    fdo::DBusProxy,
    message::Type,
    zvariant::{DynamicType, OwnedFd, OwnedObjectPath, OwnedValue, Value},
};

const REMOTE: &str = "org.freedesktop.portal.RemoteDesktop";
const CAST: &str = "org.freedesktop.portal.ScreenCast";
const CLIPBOARD: &str = "org.freedesktop.portal.Clipboard";
const SESSION: &str = "org.freedesktop.portal.Session";
const DEVICES: u32 = 3; // Keyboard and pointer.
const MONITOR: u32 = 1;
type Options = HashMap<&'static str, Value<'static>>;

pub(super) fn available(portal: &Portal) -> bool {
    let cancel = Cancellation::default();
    async_io::block_on(bounded(
        async {
            let reply = portal
                .bus
                .call_method(
                    Some(PORTAL_NAME),
                    PORTAL_PATH,
                    Some("org.freedesktop.DBus.Properties"),
                    "Get",
                    &(REMOTE, "AvailableDeviceTypes"),
                )
                .await
                .map_err(|_| unavailable())?;
            let value: OwnedValue = reply.body().deserialize().map_err(|_| unavailable())?;
            let devices = u32::try_from(value).map_err(|_| unavailable())?;
            Ok(devices & DEVICES == DEVICES)
        },
        Duration::from_millis(500),
        &cancel,
    ))
    .unwrap_or(false)
}

struct Handle {
    portal: Portal,
    owner: String,
    path: OwnedObjectPath,
    closure: Option<SessionClosure>,
}

struct SessionClosure {
    closed: Arc<AtomicBool>,
    _watch: Task<()>,
}

impl Handle {
    async fn watch_closed(&mut self, cancel: &Cancellation) -> Result<()> {
        let rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .sender(self.owner.as_str())
            .map_err(|_| unavailable())?
            .path(self.path.as_str())
            .map_err(|_| unavailable())?
            .interface(SESSION)
            .map_err(|_| unavailable())?
            .member("Closed")
            .map_err(|_| unavailable())?
            .build();
        let bus = &self.portal.bus;
        let (mut signals, mut owner_changes) = bounded(
            async {
                let signals = MessageStream::for_match_rule(rule, bus, Some(1))
                    .await
                    .map_err(|_| unavailable())?;
                let owner_changes = DBusProxy::new(bus)
                    .await
                    .map_err(|_| unavailable())?
                    .receive_name_owner_changed_with_args(&[(0, self.owner.as_str())])
                    .await
                    .map_err(|_| unavailable())?;
                Ok((signals, owner_changes))
            },
            Duration::from_secs(2),
            cancel,
        )
        .await?;
        let closed = Arc::new(AtomicBool::new(false));
        let ended = closed.clone();
        let watch = bus.executor().spawn(
            async move {
                // A unique bus name cannot be reassigned. Its disappearance
                // also ends the session when the portal cannot emit Closed.
                future::race(
                    async {
                        let _ = signals.next().await;
                    },
                    async {
                        let _ = owner_changes.next().await;
                    },
                )
                .await;
                ended.store(true, Ordering::Release);
            },
            "cantrip-portal-session-closed",
        );
        self.closure = Some(SessionClosure {
            closed,
            _watch: watch,
        });
        Ok(())
    }

    fn is_closed(&self) -> bool {
        self.closure
            .as_ref()
            .is_some_and(|closure| closure.closed.load(Ordering::Acquire))
    }

    fn check_open(&self) -> Result<()> {
        if self.is_closed() {
            Err(CuaError::new(
                ErrorCode::PermissionDenied,
                "The Wayland portal closed desktop control.",
            ))
        } else {
            Ok(())
        }
    }

    async fn call<B: Serialize + DynamicType>(
        &self,
        interface: &str,
        method: &str,
        body: &B,
        cancel: &Cancellation,
    ) -> Result<zbus::Message> {
        self.check_open()?;
        bounded(
            async {
                self.portal
                    .bus
                    .call_method(
                        Some(self.owner.as_str()),
                        PORTAL_PATH,
                        Some(interface),
                        method,
                        body,
                    )
                    .await
                    .map_err(|_| {
                        CuaError::new(
                            ErrorCode::InputFailed,
                            "The Wayland portal did not accept the operation.",
                        )
                    })
            },
            Duration::from_secs(2),
            cancel,
        )
        .await
    }

    async fn connect_to_eis(&self, cancel: &Cancellation) -> Result<Option<OwnedFd>> {
        self.check_open()?;
        bounded(
            async {
                let reply = self
                    .portal
                    .bus
                    .call_method(
                        Some(self.owner.as_str()),
                        PORTAL_PATH,
                        Some(REMOTE),
                        "ConnectToEIS",
                        &(&self.path, Options::new()),
                    )
                    .await;
                match reply {
                    Ok(reply) => reply
                        .body()
                        .deserialize()
                        .map(Some)
                        .map_err(|_| unavailable()),
                    Err(zbus::Error::MethodError(name, _, _))
                        if matches!(
                            name.as_str(),
                            "org.freedesktop.DBus.Error.UnknownMethod"
                                | "org.freedesktop.DBus.Error.UnknownInterface"
                                | "org.freedesktop.portal.Error.NotSupported"
                                | "org.freedesktop.portal.Error.Failed"
                        ) =>
                    {
                        Ok(None)
                    }
                    Err(zbus::Error::MethodError(name, _, _))
                        if matches!(
                            name.as_str(),
                            "org.freedesktop.portal.Error.NotAllowed"
                                | "org.freedesktop.DBus.Error.AccessDenied"
                        ) =>
                    {
                        Err(CuaError::new(
                            ErrorCode::PermissionDenied,
                            "The Wayland portal denied emulated input.",
                        ))
                    }
                    Err(_) => Err(CuaError::new(
                        ErrorCode::InputFailed,
                        "The Wayland portal did not establish emulated input.",
                    )),
                }
            },
            Duration::from_secs(2),
            cancel,
        )
        .await
    }

    async fn close(&self) -> Result<()> {
        if self.is_closed() {
            return Ok(());
        }
        let result = future::race(
            self.portal.bus.call_method(
                Some(self.owner.as_str()),
                self.path.as_str(),
                Some(SESSION),
                "Close",
                &(),
            ),
            async {
                Timer::after(Duration::from_millis(350)).await;
                Err(zbus::Error::Failure("Portal close timed out".into()))
            },
        )
        .await;
        match result {
            Ok(_) => Ok(()),
            Err(_) if self.is_closed() => Ok(()),
            Err(zbus::Error::MethodError(name, _, _))
                if name.as_str() == "org.freedesktop.DBus.Error.UnknownObject" =>
            {
                Ok(())
            }
            Err(_) => Err(CuaError::new(
                ErrorCode::InputFailed,
                "The Wayland portal did not close the previous desktop control session.",
            )),
        }
    }
}

pub(super) struct DesktopSession {
    handle: Handle,
    stream: u32,
    clipboard: bool,
    emulated: Option<EmulatedInput>,
}

impl DesktopSession {
    pub(super) fn start(
        portal: Portal,
        target: Bounds,
        layout: &[Bounds],
        prefer_emulated: &AtomicBool,
        cancel: &Cancellation,
    ) -> Result<Self> {
        async_io::block_on(async {
            let (mut handle, mut stream, mut clipboard) =
                Self::approve(portal.clone(), target, layout, cancel).await?;
            let mut emulated = None;
            if prefer_emulated.load(Ordering::Relaxed) {
                match handle.connect_to_eis(cancel).await {
                    Ok(Some(fd)) => {
                        let output = SelectedOutput {
                            bounds: target,
                            mapping_id: stream.mapping_id.take(),
                        };
                        match EmulatedInput::start(fd, output, cancel).await {
                            Ok(input) => emulated = Some(input),
                            Err(error) => {
                                let retired = handle.close().await;
                                cancel.check()?;
                                if !matches!(
                                    error.code,
                                    ErrorCode::Unsupported | ErrorCode::CaptureImageTimeout
                                ) {
                                    return Err(error);
                                }
                                // A connected EIS session exclusively owns input.
                                // Reopen the legacy path with fresh consent.
                                retired?;
                                prefer_emulated.store(false, Ordering::Relaxed);
                                (handle, stream, clipboard) =
                                    Self::approve(portal, target, layout, cancel).await?;
                            }
                        }
                    }
                    Ok(None) => prefer_emulated.store(false, Ordering::Relaxed),
                    Err(error) => {
                        let _ = handle.close().await;
                        return Err(error);
                    }
                }
            }
            if let Err(error) = handle.check_open() {
                let _ = handle.close().await;
                return Err(error);
            }
            Ok(Self {
                handle,
                stream: stream.id,
                clipboard,
                emulated,
            })
        })
    }

    async fn approve(
        portal: Portal,
        target: Bounds,
        layout: &[Bounds],
        cancel: &Cancellation,
    ) -> Result<(Handle, SelectedStream, bool)> {
        let session_token = token();
        let expected = format!("{PORTAL_PATH}/session/{}/{session_token}", portal.sender()?);
        let mut handle = Handle {
            portal,
            owner: PORTAL_NAME.to_owned(),
            path: OwnedObjectPath::try_from(expected).map_err(|_| unavailable())?,
            closure: None,
        };
        let create = handle
            .portal
            .request(
                PORTAL_NAME,
                REMOTE,
                "CreateSession",
                |request| {
                    (HashMap::from([
                        ("handle_token", Value::from(request)),
                        ("session_handle_token", Value::from(session_token)),
                    ]),)
                },
                cancel,
            )
            .await;
        let create = match create {
            Ok(create) => create,
            Err(error) => {
                let _ = handle.close().await;
                return Err(error);
            }
        };
        handle.owner = create.owner;
        let path = create.results.get("session_handle").and_then(|value| {
            <&str>::try_from(value).ok().or_else(|| {
                <&zbus::zvariant::ObjectPath<'_>>::try_from(value)
                    .ok()
                    .map(|path| path.as_str())
            })
        });
        if path != Some(handle.path.as_str()) {
            let _ = handle.close().await;
            return Err(CuaError::new(
                ErrorCode::InputFailed,
                "The Wayland portal returned an invalid session.",
            ));
        }
        let activation = async {
            handle.watch_closed(cancel).await?;
            let active = activate(&handle, target, layout, cancel).await?;
            handle.check_open()?;
            Ok(active)
        }
        .await;
        match activation {
            Ok((stream, clipboard)) => Ok((handle, stream, clipboard)),
            Err(error) => {
                let _ = handle.close().await;
                Err(error)
            }
        }
    }

    pub(super) fn is_closed(&self) -> bool {
        self.handle.is_closed() || self.emulated.as_ref().is_some_and(EmulatedInput::is_closed)
    }

    pub(super) fn notify(&self, event: &Event, cancel: &Cancellation) -> Result<()> {
        if let Some(input) = &self.emulated {
            self.handle.check_open()?;
            return input.send(event, cancel);
        }
        let path = &self.handle.path;
        let options = Options::new;
        let call = &self.handle;
        async_io::block_on(async {
            match *event {
                Event::Move(point) => {
                    call.call(
                        REMOTE,
                        "NotifyPointerMotionAbsolute",
                        &(path, options(), self.stream, point.x, point.y),
                        cancel,
                    )
                    .await?
                }
                Event::Button(code, state) => {
                    call.call(
                        REMOTE,
                        "NotifyPointerButton",
                        &(path, options(), code, u32::from(state)),
                        cancel,
                    )
                    .await?
                }
                Event::Scroll(x, y) => {
                    call.call(
                        REMOTE,
                        "NotifyPointerAxis",
                        &(path, HashMap::from([("finish", Value::from(true))]), x, y),
                        cancel,
                    )
                    .await?
                }
                Event::Key(code, state) => {
                    call.call(
                        REMOTE,
                        "NotifyKeyboardKeysym",
                        &(path, options(), code, u32::from(state)),
                        cancel,
                    )
                    .await?
                }
                Event::Text(ref text) => {
                    for character in text.replace("\r\n", "\n").chars() {
                        let code = match character {
                            '\n' | '\r' => 0xff0d,
                            '\t' => 0xff09,
                            short if short as u32 <= 0xff => short as i32,
                            unicode => xkeysym::Keysym::from_char(unicode).raw() as i32,
                        };
                        for state in [1_u32, 0] {
                            call.call(
                                REMOTE,
                                "NotifyKeyboardKeysym",
                                &(path, options(), code, state),
                                cancel,
                            )
                            .await?;
                        }
                    }
                    return Ok(());
                }
            };
            Ok(())
        })
    }

    pub(super) fn watch_clipboard(&self, cancel: &Cancellation) -> Result<Option<MessageStream>> {
        self.handle.check_open()?;
        if !self.clipboard {
            return Ok(None);
        }
        async_io::block_on(bounded(
            async {
                let rule = MatchRule::builder()
                    .msg_type(Type::Signal)
                    .sender(self.handle.owner.as_str())
                    .map_err(|_| unavailable())?
                    .path(PORTAL_PATH)
                    .map_err(|_| unavailable())?
                    .interface(CLIPBOARD)
                    .map_err(|_| unavailable())?
                    .member("SelectionOwnerChanged")
                    .map_err(|_| unavailable())?
                    .build();
                MessageStream::for_match_rule(rule, &self.handle.portal.bus, Some(8))
                    .await
                    .map(Some)
                    .map_err(|_| unavailable())
            },
            Duration::from_secs(1),
            cancel,
        ))
    }

    pub(super) fn copied_text(
        &self,
        mut signals: MessageStream,
        cancel: &Cancellation,
    ) -> Result<Option<String>> {
        let result = async_io::block_on(bounded(
            async {
                while let Some(message) = signals.next().await {
                    let message = message.map_err(|_| unavailable())?;
                    let (path, options): (OwnedObjectPath, Results) =
                        message.body().deserialize().map_err(|_| unavailable())?;
                    if path != self.handle.path
                        || options
                            .get("session_is_owner")
                            .and_then(|value| bool::try_from(value).ok())
                            == Some(true)
                    {
                        continue;
                    }
                    let mime = clipboard_mime(options);
                    let Some(mime) = mime else {
                        return Ok(None);
                    };
                    let response = self
                        .handle
                        .call(CLIPBOARD, "SelectionRead", &(&path, mime), cancel)
                        .await?;
                    let fd: OwnedFd = response.body().deserialize().map_err(|_| unavailable())?;
                    let text = read_text(fd).await?;
                    while let Some(Some(change)) = future::poll_once(signals.next()).await {
                        let change = change.map_err(|_| unavailable())?;
                        let (changed, _): (OwnedObjectPath, Results) =
                            change.body().deserialize().map_err(|_| unavailable())?;
                        if changed == path {
                            return Ok(None);
                        }
                    }
                    return Ok(text);
                }
                Ok(None)
            },
            Duration::from_millis(900),
            cancel,
        ));
        self.handle.check_open()?;
        match result {
            Err(error) if error.code == ErrorCode::CaptureImageTimeout => Ok(None),
            other => other,
        }
    }
}

impl Drop for DesktopSession {
    fn drop(&mut self) {
        self.emulated.take();
        let _ = async_io::block_on(self.handle.close());
    }
}

async fn activate(
    handle: &Handle,
    target: Bounds,
    layout: &[Bounds],
    cancel: &Cancellation,
) -> Result<(SelectedStream, bool)> {
    let path = &handle.path;
    let portal = &handle.portal;
    let owner = &handle.owner;
    portal
        .request(
            owner,
            REMOTE,
            "SelectDevices",
            |request| {
                (
                    path,
                    HashMap::from([
                        ("handle_token", Value::from(request)),
                        ("types", Value::from(DEVICES)),
                    ]),
                )
            },
            cancel,
        )
        .await?;
    portal
        .request(
            owner,
            CAST,
            "SelectSources",
            |request| {
                (
                    path,
                    HashMap::from([
                        ("handle_token", Value::from(request)),
                        ("types", Value::from(MONITOR)),
                        ("multiple", Value::from(false)),
                    ]),
                )
            },
            cancel,
        )
        .await?;
    let clipboard = handle
        .call(
            CLIPBOARD,
            "RequestClipboard",
            &(path, Options::new()),
            cancel,
        )
        .await
        .is_ok();
    let mut started = portal
        .request(
            owner,
            REMOTE,
            "Start",
            |request| {
                (
                    path,
                    "",
                    HashMap::from([("handle_token", Value::from(request))]),
                )
            },
            cancel,
        )
        .await?
        .results;
    if started
        .get("devices")
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0)
        & DEVICES
        != DEVICES
    {
        return Err(CuaError::new(
            ErrorCode::PermissionDenied,
            "The Wayland portal did not grant keyboard and pointer control.",
        ));
    }
    let streams = started
        .remove("streams")
        .and_then(|value| Vec::<(u32, Results)>::try_from(value).ok())
        .ok_or_else(unmatched)?;
    let stream = select_stream(streams, target, layout)?;
    let clipboard = clipboard
        && started
            .get("clipboard_enabled")
            .and_then(|value| bool::try_from(value).ok())
            == Some(true);
    Ok((stream, clipboard))
}

struct SelectedStream {
    id: u32,
    mapping_id: Option<String>,
}

fn select_stream(
    streams: Vec<(u32, Results)>,
    target: Bounds,
    layout: &[Bounds],
) -> Result<SelectedStream> {
    let [(id, properties)] = streams.as_slice() else {
        return Err(unmatched());
    };
    if *id == 0
        || properties
            .get("source_type")
            .is_some_and(|value| u32::try_from(value).ok() != Some(MONITOR))
    {
        return Err(unmatched());
    }
    let pair = |key: &str| -> Result<Option<(i32, i32)>> {
        properties
            .get(key)
            .map(|value| {
                value
                    .try_clone()
                    .ok()
                    .and_then(|value| <(i32, i32)>::try_from(value).ok())
                    .ok_or_else(unmatched)
            })
            .transpose()
    };
    let position = pair("position")?;
    let size = pair("size")?;
    let matches = |bounds: Bounds| {
        position.is_none_or(|(x, y)| (f64::from(x), f64::from(y)) == (bounds.x, bounds.y))
            && size.is_none_or(|(width, height)| {
                (f64::from(width), f64::from(height)) == (bounds.width, bounds.height)
            })
    };
    if !matches(target) || layout.iter().filter(|&&bounds| matches(bounds)).count() != 1 {
        return Err(unmatched());
    }
    Ok(SelectedStream {
        id: *id,
        mapping_id: properties
            .get("mapping_id")
            .and_then(|value| <&str>::try_from(value).ok())
            .map(str::to_owned),
    })
}

fn clipboard_mime(mut options: Results) -> Option<&'static str> {
    let types = Vec::<String>::try_from(options.remove("mime_types")?).ok()?;
    ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING"]
        .into_iter()
        .find(|format| types.iter().any(|value| value == format))
}

async fn read_text(fd: OwnedFd) -> Result<Option<String>> {
    let mut file = File::from(std::os::fd::OwnedFd::from(fd));
    let flags = rustix::fs::fcntl_getfl(&file).map_err(|_| unavailable())?;
    rustix::fs::fcntl_setfl(&file, flags | rustix::fs::OFlags::NONBLOCK)
        .map_err(|_| unavailable())?;
    let mut text = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        match file.read(&mut chunk) {
            Ok(0) => return Ok(String::from_utf8(text).ok()),
            Ok(count) if text.len() + count <= MAX_HOST_CLIPBOARD_BYTES => {
                text.extend_from_slice(&chunk[..count])
            }
            Ok(_) => {
                return Err(CuaError::new(
                    ErrorCode::Capacity,
                    "Clipboard text exceeds the supported limit.",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                Timer::after(Duration::from_millis(5)).await;
            }
            Err(_) => return Err(unavailable()),
        }
    }
}

fn unavailable() -> CuaError {
    CuaError::new(
        ErrorCode::Unsupported,
        "The Wayland Remote Desktop portal is unavailable.",
    )
}

fn unmatched() -> CuaError {
    CuaError::new(
        ErrorCode::PermissionDenied,
        "The Wayland portal did not share the selected monitor.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use zbus::Connection;

    #[derive(Debug, zbus::DBusError)]
    #[zbus(prefix = "org.freedesktop.portal.Error")]
    enum PortalFailure {
        NotSupported,
        NotAllowed,
    }

    struct LegacyPortal;

    #[zbus::interface(name = "org.freedesktop.portal.RemoteDesktop")]
    impl LegacyPortal {
        #[zbus(name = "ConnectToEIS")]
        fn connect_to_eis(
            &self,
            path: OwnedObjectPath,
            _options: Results,
        ) -> std::result::Result<OwnedFd, PortalFailure> {
            if path.as_str().ends_with("/denied") {
                Err(PortalFailure::NotAllowed)
            } else {
                Err(PortalFailure::NotSupported)
            }
        }
    }

    #[test]
    #[ignore = "requires an isolated D-Bus session"]
    fn emulated_input_fallback_distinguishes_unavailable_from_denied() {
        async_io::block_on(async {
            let server = zbus::connection::Builder::session()
                .unwrap()
                .serve_at(PORTAL_PATH, LegacyPortal)
                .unwrap()
                .build()
                .await
                .unwrap();
            let mut session = Handle {
                portal: Portal {
                    bus: Connection::session().await.unwrap(),
                },
                owner: server.unique_name().unwrap().to_string(),
                path: OwnedObjectPath::try_from("/org/freedesktop/portal/desktop/session/test")
                    .unwrap(),
                closure: None,
            };
            let cancel = Cancellation::default();
            assert!(session.connect_to_eis(&cancel).await.unwrap().is_none());
            session.path =
                OwnedObjectPath::try_from("/org/freedesktop/portal/desktop/session/denied")
                    .unwrap();
            assert_eq!(
                session.connect_to_eis(&cancel).await.unwrap_err().code,
                ErrorCode::PermissionDenied
            );
        });
    }

    #[test]
    #[ignore = "requires an isolated D-Bus session"]
    fn portal_disconnect_closes_only_its_session() {
        async_io::block_on(async {
            let portal = Connection::session().await.unwrap();
            let unrelated = Connection::session().await.unwrap();
            let cancel = Cancellation::default();
            let mut handle = Handle {
                portal: Portal {
                    bus: Connection::session().await.unwrap(),
                },
                owner: portal.unique_name().unwrap().to_string(),
                path: OwnedObjectPath::try_from("/org/freedesktop/portal/desktop/session/test")
                    .unwrap(),
                closure: None,
            };
            handle.watch_closed(&cancel).await.unwrap();

            unrelated.close().await.unwrap();
            Timer::after(Duration::from_millis(50)).await;
            assert!(!handle.is_closed());

            portal.close().await.unwrap();
            bounded(
                async {
                    while !handle.is_closed() {
                        Timer::after(Duration::from_millis(5)).await;
                    }
                    Ok(())
                },
                Duration::from_secs(2),
                &cancel,
            )
            .await
            .expect("the portal disconnected without closing its session");
            assert_eq!(
                handle.check_open().unwrap_err().code,
                ErrorCode::PermissionDenied
            );
        });
    }
}

#[cfg(test)]
#[path = "portal_desktop_fallback_tests.rs"]
mod fallback_tests;
