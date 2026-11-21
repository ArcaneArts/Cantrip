use super::{inventory::Display, screenshot};
use crate::{
    backend::{Capture, Raster},
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    target::{Bounds, Target},
};
use async_io::Timer;
use futures_lite::{StreamExt, future};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime},
};
use zbus::{
    Connection, MatchRule, MessageStream,
    connection::Builder,
    message::Type,
    zvariant::{DynamicType, OwnedObjectPath, OwnedValue, Value},
};

pub(super) const PORTAL_NAME: &str = "org.freedesktop.portal.Desktop";
pub(super) const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const SCREENSHOT: &str = "org.freedesktop.portal.Screenshot";
const REQUEST: &str = "org.freedesktop.portal.Request";
const SHELL: &str = "org.gnome.Shell.Screenshot";
const SHELL_PATH: &str = "/org/gnome/Shell/Screenshot";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

pub(super) type Results = HashMap<String, OwnedValue>;

pub(super) struct Reply {
    pub(super) owner: String,
    pub(super) results: Results,
}

pub(super) fn token() -> String {
    format!("cantrip_{}", NEXT_REQUEST.fetch_add(1, Ordering::Relaxed))
}

#[derive(Clone)]
pub(super) struct Portal {
    pub(super) bus: Connection,
}

impl Portal {
    pub(super) fn connect() -> Result<Self> {
        let cancel = Cancellation::default();
        async_io::block_on(bounded(
            async {
                let bus = Builder::session()
                    .map_err(unavailable)?
                    .method_timeout(Duration::from_secs(5))
                    .build()
                    .await
                    .map_err(unavailable)?;
                Ok(Self { bus })
            },
            Duration::from_secs(2),
            &cancel,
        ))
    }

    pub(super) fn capture(
        &self,
        displays: &[Display],
        mut target: Target,
        cancel: &Cancellation,
    ) -> Result<Capture> {
        let raster = async_io::block_on(async {
            match self.gnome(target.bounds, cancel).await {
                Ok(raster) => return Ok(raster),
                Err(error) if error.code == ErrorCode::Cancelled => return Err(error),
                Err(_) => {}
            }
            cancel.check()?;
            let bounds = desktop_bounds(displays)?;
            let requested = SystemTime::now();
            let uri = self.screenshot(cancel).await?;
            let file = screenshot::portal_file(&uri, requested)?;
            screenshot::decode(file, bounds, target.bounds, cancel)
        })?;
        target.pixel_width = raster.width;
        target.pixel_height = raster.height;
        Ok(Capture { target, raster })
    }

    async fn gnome(&self, area: Bounds, cancel: &Cancellation) -> Result<Raster> {
        // ScreenshotArea takes compositor coordinates and writes exactly the
        // supplied file when the shell permits this caller.
        let private = tempfile::Builder::new()
            .prefix("cantrip-wayland-")
            .tempdir()
            .map_err(|_| failed("Cannot prepare the private Wayland screenshot."))?;
        let path = private.path().join("display.png");
        let filename = path
            .to_str()
            .ok_or_else(|| failed("Invalid Wayland screenshot directory."))?;
        let coordinate = |value: f64| -> Result<i32> {
            if value.fract() != 0. || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
                return Err(failed("The Wayland output has unrepresentable geometry."));
            }
            Ok(value as i32)
        };
        let parameters = (
            coordinate(area.x)?,
            coordinate(area.y)?,
            coordinate(area.width)?,
            coordinate(area.height)?,
            false,
            filename,
        );
        let reply = bounded(
            async {
                self.bus
                    .call_method(
                        Some(SHELL),
                        SHELL_PATH,
                        Some(SHELL),
                        "ScreenshotArea",
                        &parameters,
                    )
                    .await
                    .map_err(unavailable)
            },
            Duration::from_secs(3),
            cancel,
        )
        .await?;
        let body = reply.body();
        let (captured, reported): (bool, &str) = body
            .deserialize()
            .map_err(|_| failed("Invalid GNOME screenshot response."))?;
        if !captured || reported != filename {
            return Err(failed("GNOME did not return the selected output."));
        }
        let file = screenshot::read_file(&path)?;
        screenshot::decode(file, area, area, cancel)
    }

    async fn screenshot(&self, cancel: &Cancellation) -> Result<String> {
        let reply = self
            .request(
                PORTAL_NAME,
                SCREENSHOT,
                "Screenshot",
                |token| {
                    (
                        "",
                        HashMap::from([
                            ("handle_token", Value::from(token)),
                            ("modal", Value::from(true)),
                            ("interactive", Value::from(false)),
                        ]),
                    )
                },
                cancel,
            )
            .await?;
        reply
            .results
            .get("uri")
            .and_then(|value| <&str>::try_from(value).ok())
            .map(str::to_owned)
            .ok_or_else(|| failed("The desktop portal returned no screenshot."))
    }

    pub(super) fn sender(&self) -> Result<String> {
        let sender = self
            .bus
            .unique_name()
            .ok_or_else(|| failed("The desktop portal requires a session bus."))?;
        Ok(sender.as_str().trim_start_matches(':').replace('.', "_"))
    }

    pub(super) async fn request<B: Serialize + DynamicType>(
        &self,
        destination: &str,
        interface: &str,
        method: &str,
        body: impl FnOnce(String) -> B,
        cancel: &Cancellation,
    ) -> Result<Reply> {
        let token = token();
        let expected = format!("{PORTAL_PATH}/request/{}/{token}", self.sender()?);
        let screen = interface == SCREENSHOT;
        let rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .sender(PORTAL_NAME)
            .map_err(unavailable)?
            .interface(REQUEST)
            .map_err(unavailable)?
            .member("Response")
            .map_err(unavailable)?
            .path_namespace(format!("{PORTAL_PATH}/request"))
            .map_err(unavailable)?
            .build();
        let mut request_path = None;
        let mut owner = None;
        let result = bounded(
            async {
                // Subscribe before calling the portal. A cached permission can
                // allow a response to arrive before the method reply.
                let mut signals = MessageStream::for_match_rule(rule, &self.bus, Some(8))
                    .await
                    .map_err(unavailable)?;
                let message = self
                    .bus
                    .call_method(
                        Some(destination),
                        PORTAL_PATH,
                        Some(interface),
                        method,
                        &body(token),
                    )
                    .await
                    .map_err(|error| request_error(error, screen))?;
                owner = message
                    .header()
                    .sender()
                    .map(|sender| sender.as_str().to_owned());
                let path: OwnedObjectPath = message
                    .body()
                    .deserialize()
                    .map_err(|_| failed("The desktop portal returned an invalid request."))?;
                if owner.is_none()
                    || !path
                        .as_str()
                        .starts_with("/org/freedesktop/portal/desktop/request/")
                {
                    return Err(failed("The desktop portal returned an invalid request."));
                }
                request_path = Some(path.as_str().to_owned());
                while let Some(received) = signals.next().await {
                    let received = received.map_err(unavailable)?;
                    let header = received.header();
                    if header.sender().map(|sender| sender.as_str()) != owner.as_deref()
                        || header.path().map(|path| path.as_str()) != request_path.as_deref()
                    {
                        continue;
                    }
                    let (status, results): (u32, Results) = received
                        .body()
                        .deserialize()
                        .map_err(|_| failed("The desktop portal returned an invalid response."))?;
                    if status == 1 {
                        return Err(CuaError::new(
                            ErrorCode::PermissionDenied,
                            if screen {
                                "The desktop screenshot was declined."
                            } else {
                                "Desktop control was declined in the Wayland portal."
                            },
                        ));
                    }
                    if status != 0 {
                        return Err(failed("The desktop portal did not complete the request."));
                    }
                    return Ok(Reply {
                        owner: owner.take().unwrap(),
                        results,
                    });
                }
                Err(failed("The desktop portal stopped before replying."))
            },
            if screen || method == "Start" {
                REQUEST_TIMEOUT
            } else {
                Duration::from_secs(5)
            },
            cancel,
        )
        .await;
        if result
            .as_ref()
            .is_err_and(|error| error.code != ErrorCode::PermissionDenied)
        {
            let destination = owner.as_deref().unwrap_or(destination);
            let request = request_path.as_deref().unwrap_or(&expected);
            let _ = future::race(
                self.bus
                    .call_method(Some(destination), request, Some(REQUEST), "Close", &()),
                async {
                    Timer::after(Duration::from_millis(350)).await;
                    Err(zbus::Error::Failure("Portal close timed out".into()))
                },
            )
            .await;
        }
        result
    }
}

fn desktop_bounds(displays: &[Display]) -> Result<Bounds> {
    let first = displays
        .first()
        .ok_or_else(|| failed("No Wayland outputs are available."))?;
    let mut left = first.bounds.x;
    let mut top = first.bounds.y;
    let mut right = left + first.bounds.width;
    let mut bottom = top + first.bounds.height;
    for display in &displays[1..] {
        let bounds = display.bounds;
        left = left.min(bounds.x);
        top = top.min(bounds.y);
        right = right.max(bounds.x + bounds.width);
        bottom = bottom.max(bounds.y + bounds.height);
    }
    let bounds = Bounds {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    };
    bounds.validate()?;
    Ok(bounds)
}

pub(super) async fn bounded<T>(
    operation: impl Future<Output = Result<T>>,
    timeout: Duration,
    cancel: &Cancellation,
) -> Result<T> {
    cancel.check()?;
    let deadline = Instant::now() + timeout;
    future::race(operation, async {
        loop {
            cancel.check()?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(CuaError::new(
                    ErrorCode::CaptureImageTimeout,
                    "The Wayland portal request timed out.",
                ));
            }
            Timer::after(remaining.min(Duration::from_millis(40))).await;
        }
    })
    .await
}

fn request_error(error: zbus::Error, screen: bool) -> CuaError {
    if matches!(&error, zbus::Error::MethodError(name, _, _) if matches!(
        name.as_str(), "org.freedesktop.portal.Error.NotAllowed"
            | "org.freedesktop.DBus.Error.AccessDenied"
    )) {
        return CuaError::new(
            ErrorCode::PermissionDenied,
            if screen {
                "The desktop portal denied the screenshot."
            } else {
                "The Wayland portal denied desktop control."
            },
        );
    }
    if screen {
        unavailable(error)
    } else {
        CuaError::new(
            ErrorCode::Unsupported,
            "The Wayland Remote Desktop portal is unavailable.",
        )
    }
}

fn unavailable(_: impl std::fmt::Display) -> CuaError {
    CuaError::new(
        ErrorCode::Unsupported,
        "The Wayland screenshot service is unavailable.",
    )
}

fn failed(message: &'static str) -> CuaError {
    CuaError::new(ErrorCode::CaptureFailed, message)
}
