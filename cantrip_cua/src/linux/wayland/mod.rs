//! Capture compositor outputs and keep XWayland windows scoped to X11.
mod capture;
mod drive;
mod inventory;
mod portal;
mod screenshot;

use super::{host, lock};
use crate::{
    backend::{Capture, CaptureBackend, CaptureWork, UnavailableBackend},
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    gesture::InputCommand,
    input::InputReceipt,
    input_job::{InputProgress, InputWork},
    target::{Point, Target, TargetKind},
};
use cantrip_interaction::input::InputEvent;
use inventory::{Desktop, Display};
use std::sync::{Arc, Mutex};

struct Host {
    wayland: Arc<Mutex<Desktop>>,
    xwayland: Option<host::Host>,
    portal: Option<portal::Portal>,
}

impl Host {
    fn open() -> Result<Self> {
        let wayland = Desktop::open(&Cancellation::default())?;
        let xwayland = host::Host::connect().ok();
        let portal = if wayland.capture_protocol().is_none() {
            portal::Portal::connect().ok()
        } else {
            None
        };
        if wayland.capture_protocol().is_none() && xwayland.is_none() && portal.is_none() {
            return Err(unavailable());
        }
        Ok(Self {
            wayland: Arc::new(Mutex::new(wayland)),
            xwayland,
            portal,
        })
    }

    fn windows(&mut self) -> Result<&mut host::Host> {
        self.xwayland.as_mut().ok_or_else(unavailable)
    }

    fn monitors(&self, cancel: &Cancellation) -> Result<Vec<(Display, Target)>> {
        cancel.check()?;
        let mut wayland = lock(&self.wayland);
        wayland.sync(cancel)?;
        if wayland.capture_protocol().is_none() && self.portal.is_none() {
            return Ok(Vec::new());
        }
        let displays = wayland.displays();
        drop(wayland);
        let legacy = self
            .xwayland
            .as_ref()
            .and_then(|server| server.monitors(cancel).ok())
            .unwrap_or_default();
        let aliases: Vec<_> = displays
            .iter()
            .map(|display| {
                // Legacy saved IDs come from RandR under XWayland. Only reuse the
                // numeric ID when both observations identify one physical output.
                let mut matches = legacy
                    .iter()
                    .enumerate()
                    .filter(|(_, old)| old.bounds == display.bounds);
                let first = matches.next();
                if matches.next().is_none()
                    && displays
                        .iter()
                        .filter(|other| other.bounds == display.bounds)
                        .count()
                        == 1
                {
                    first
                } else {
                    None
                }
            })
            .collect();
        let primary = aliases
            .iter()
            .position(|entry| entry.is_some_and(|(index, _)| index == 0))
            .unwrap_or(0);
        let mut monitors = Vec::with_capacity(displays.len());
        for (index, (display, alias)) in displays.into_iter().zip(aliases).enumerate() {
            let label = alias
                .and_then(|(_, old)| old.title.clone())
                .unwrap_or_else(|| display.name.clone());
            let alias = alias.and_then(|(_, old)| old.id.strip_prefix("x11-display-"));
            let identity = alias
                .map(str::to_owned)
                .unwrap_or_else(|| format!("wl-{}", display.name));
            let order = if index == primary {
                "primary"
            } else {
                "secondary"
            };
            let target = Target {
                id: format!("wayland-display-{order}-{identity}"),
                generation: display.generation,
                kind: TargetKind::Monitor,
                title: Some(label),
                application: None,
                process_id: None,
                focused: None,
                minimized: None,
                access: None,
                bounds: display.bounds,
                pixel_width: display.pixels.0,
                pixel_height: display.pixels.1,
                scale_factor: display.scale,
            };
            target.validate()?;
            monitors.push((display, target));
        }
        Ok(monitors)
    }

    fn monitor(
        &self,
        id: &str,
        generation: u64,
        cancel: &Cancellation,
    ) -> Result<(Display, Target)> {
        let selected = self
            .monitors(cancel)?
            .into_iter()
            .find(|(_, target)| target.id == id)
            .ok_or_else(stale)?;
        if selected.1.generation != generation {
            return Err(stale());
        }
        Ok(selected)
    }
}

impl CaptureBackend for Host {
    fn name(&self) -> &'static str {
        if self.portal.is_some() {
            "linux-wayland-portal"
        } else {
            "linux-wayland"
        }
    }

    fn available(&self) -> bool {
        true
    }

    fn inventory_truncated(&self) -> bool {
        self.xwayland
            .as_ref()
            .is_some_and(CaptureBackend::inventory_truncated)
    }

    fn targets(&mut self, cancel: &Cancellation) -> Result<Vec<Target>> {
        let mut targets: Vec<_> = self
            .monitors(cancel)?
            .into_iter()
            .map(|(_, target)| target)
            .collect();
        if let Some(xwayland) = &mut self.xwayland
            && let Ok(windows) = xwayland.window_targets(cancel)
        {
            targets.extend(windows);
        }
        cancel.check()?;
        Ok(targets)
    }

    fn resolve_target(
        &mut self,
        id: &str,
        generation: u64,
        cancel: &Cancellation,
    ) -> Result<Target> {
        if id.starts_with("x11-window-") {
            return self.windows()?.resolve_target(id, generation, cancel);
        }
        Ok(self.monitor(id, generation, cancel)?.1)
    }

    fn capture(&mut self, target: &Target, cancel: &Cancellation) -> Result<Capture> {
        self.capture_work(target, cancel)?
            .expect("native Linux capture work")()
    }

    fn capture_work(
        &mut self,
        target: &Target,
        cancel: &Cancellation,
    ) -> Result<Option<CaptureWork>> {
        if target.kind == TargetKind::Window {
            return self.windows()?.capture_work(target, cancel);
        }
        let (display, target) = self.monitor(&target.id, target.generation, cancel)?;
        let desktop = self.wayland.clone();
        let (work, layout): (CaptureWork, _) = {
            let wayland = lock(&desktop);
            let cancel = cancel.clone();
            if let Some((shm, protocol)) = wayland.capture_protocol() {
                let connection = wayland.connection.clone();
                let display = display.clone();
                (
                    Box::new(move || {
                        capture::capture(&connection, &shm, &protocol, &display, target, &cancel)
                    }),
                    None,
                )
            } else if let Some(portal) = self.portal.clone() {
                let layout = Arc::new(wayland.displays());
                let geometry = layout.clone();
                (
                    Box::new(move || portal.capture(&geometry, target, &cancel)),
                    Some(layout),
                )
            } else {
                return Err(unavailable());
            }
        };
        let cancel = cancel.clone();
        Ok(Some(Box::new(move || {
            let capture = work()?;
            // A completed copy cannot outlive a removed output or be published
            // under the old geometry after a mode/layout change.
            let mut desktop = lock(&desktop);
            desktop.sync(&cancel)?;
            let current = desktop.display(display.id, display.generation)?;
            if current.bounds != display.bounds
                || current.pixels != display.pixels
                || layout.is_some_and(|layout| !same_layout(&layout, &desktop.displays()))
            {
                return Err(stale());
            }
            Ok(capture)
        })))
    }

    fn native_input(&self) -> bool {
        self.xwayland.is_some()
    }

    fn copy_selection_text(
        &mut self,
        participant: &str,
        target: &Target,
        position: Point,
        sequence: u64,
        cancel: &Cancellation,
    ) -> Result<Option<String>> {
        self.windows()?
            .copy_selection_text(participant, target, position, sequence, cancel)
    }

    fn interaction_input(
        &mut self,
        participant: &str,
        target: &Target,
        position: Point,
        sequence: u64,
        event: InputEvent,
        cancel: &Cancellation,
    ) -> Result<()> {
        self.windows()?
            .interaction_input(participant, target, position, sequence, event, cancel)
    }

    fn close_input(&mut self, participant: &str) -> Result<()> {
        match &mut self.xwayland {
            Some(server) => server.close_input(participant),
            None => Ok(()),
        }
    }

    fn click(
        &mut self,
        session: &str,
        target: &Target,
        position: Point,
        cancel: &Cancellation,
    ) -> Result<(Target, InputReceipt)> {
        self.windows()?.click(session, target, position, cancel)
    }

    fn perform(
        &mut self,
        session: &str,
        target: &Target,
        command: &InputCommand,
        position: Point,
        cancel: &Cancellation,
        progress: &mut dyn FnMut(Point),
    ) -> Result<(Target, InputReceipt)> {
        self.windows()?
            .perform(session, target, command, position, cancel, progress)
    }

    fn input_work(
        &mut self,
        session: &str,
        target: &Target,
        command: &InputCommand,
        position: Point,
        cancel: &Cancellation,
        progress: InputProgress,
    ) -> Result<Option<InputWork>> {
        self.windows()?
            .input_work(session, target, command, position, cancel, progress)
    }

    fn input_finished(&mut self, session: &str, succeeded: bool) {
        if let Some(xwayland) = &mut self.xwayland {
            xwayland.input_finished(session, succeeded);
        }
    }
}

fn same_layout(before: &[Display], after: &[Display]) -> bool {
    before.len() == after.len()
        && before.iter().zip(after).all(|(old, new)| {
            old.id == new.id
                && old.generation == new.generation
                && old.bounds == new.bounds
                && old.pixels == new.pixels
        })
}

pub(super) fn selected() -> bool {
    std::env::var("XDG_SESSION_TYPE").is_ok_and(|value| value.eq_ignore_ascii_case("wayland"))
        || std::env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty())
        || std::env::var_os("WAYLAND_SOCKET").is_some_and(|value| !value.is_empty())
}

pub(super) fn run() -> std::io::Result<()> {
    match Host::open() {
        Ok(backend) => crate::runtime::run(backend, std::io::stdin(), std::io::stdout()),
        Err(_) => crate::runtime::run(UnavailableBackend, std::io::stdin(), std::io::stdout()),
    }
}

fn missing() -> CuaError {
    CuaError::new(
        ErrorCode::TargetNotFound,
        "The Wayland output no longer exists.",
    )
}

fn stale() -> CuaError {
    CuaError::new(ErrorCode::StaleTarget, "The Wayland output changed.")
}

fn unavailable() -> CuaError {
    CuaError::new(
        ErrorCode::Unsupported,
        "Authorized Wayland desktop capture is unavailable.",
    )
}
