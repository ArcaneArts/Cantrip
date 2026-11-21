use super::{drive, legacy_input, missing};
use crate::{
    cancellation::Cancellation,
    error::Result,
    target::{Bounds, MAX_SEQUENCE},
};
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use wayland_client::{
    Connection, Dispatch, EventQueue, Proxy, QueueHandle, WEnum, delegate_noop,
    protocol::{wl_callback, wl_output, wl_registry, wl_seat, wl_shm},
};
use wayland_protocols::{
    ext::{
        image_capture_source::v1::client::ext_output_image_capture_source_manager_v1 as ext_source,
        image_copy_capture::v1::client::ext_image_copy_capture_manager_v1 as ext_copy,
    },
    xdg::xdg_output::zv1::client::{
        zxdg_output_manager_v1 as xdg_manager, zxdg_output_v1 as xdg_output,
    },
};
use wayland_protocols_wlr::{
    data_control::v1::client::zwlr_data_control_manager_v1 as data_control,
    screencopy::v1::client::zwlr_screencopy_manager_v1 as wlr_copy,
    virtual_pointer::v1::client::zwlr_virtual_pointer_manager_v1 as virtual_pointer,
};

const MAX_OUTPUTS: usize = 64;
const INVENTORY_TIMEOUT: Duration = Duration::from_secs(2);

pub(super) struct Desktop {
    pub(super) connection: Connection,
    queue: EventQueue<Inventory>,
    state: Inventory,
}

#[derive(Clone)]
pub(super) enum Protocol {
    ImageCopy(
        ext_source::ExtOutputImageCaptureSourceManagerV1,
        ext_copy::ExtImageCopyCaptureManagerV1,
    ),
    Screencopy(wlr_copy::ZwlrScreencopyManagerV1),
}

#[derive(Clone)]
pub(super) struct Display {
    pub(super) id: u32,
    pub(super) generation: u64,
    pub(super) proxy: wl_output::WlOutput,
    pub(super) name: String,
    pub(super) bounds: Bounds,
    pub(super) pixels: (u32, u32),
    pub(super) scale: f64,
}

struct Inventory {
    outputs: BTreeMap<u32, Output>,
    xdg: Option<(u32, xdg_manager::ZxdgOutputManagerV1)>,
    shm: Option<(u32, wl_shm::WlShm)>,
    screencopy: Option<(u32, wlr_copy::ZwlrScreencopyManagerV1)>,
    copy: Option<(u32, ext_copy::ExtImageCopyCaptureManagerV1)>,
    source: Option<(u32, ext_source::ExtOutputImageCaptureSourceManagerV1)>,
    seats: BTreeMap<u32, (wl_seat::WlSeat, Option<String>)>,
    pointer: Option<(u32, virtual_pointer::ZwlrVirtualPointerManagerV1)>,
    clipboard: Option<(u32, data_control::ZwlrDataControlManagerV1)>,
    generation: u64,
}

struct Output {
    proxy: wl_output::WlOutput,
    xdg: Option<xdg_output::ZxdgOutputV1>,
    generation: u64,
    name: Option<String>,
    mode: Option<(u32, u32)>,
    position: (i32, i32),
    logical_position: Option<(i32, i32)>,
    logical_size: Option<(u32, u32)>,
    transform: wl_output::Transform,
    scale: u32,
}

impl Desktop {
    pub(super) fn open(cancel: &Cancellation) -> Result<Self> {
        let connection = Connection::connect_to_env().map_err(drive::failed)?;
        let queue = connection.new_event_queue();
        let generation = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        let state = Inventory {
            outputs: BTreeMap::new(),
            xdg: None,
            shm: None,
            screencopy: None,
            copy: None,
            source: None,
            seats: BTreeMap::new(),
            pointer: None,
            clipboard: None,
            generation: (generation.as_nanos() as u64 & (MAX_SEQUENCE >> 1)).max(1),
        };
        connection.display().get_registry(&queue.handle(), ());
        let mut desktop = Self {
            connection,
            queue,
            state,
        };
        desktop.sync(cancel)?;
        desktop.sync(cancel)?;
        Ok(desktop)
    }

    pub(super) fn sync(&mut self, cancel: &Cancellation) -> Result<()> {
        let replied = Arc::new(AtomicBool::new(false));
        self.connection
            .display()
            .sync(&self.queue.handle(), replied.clone());
        drive::until(
            &mut self.queue,
            &mut self.state,
            Instant::now() + INVENTORY_TIMEOUT,
            cancel,
            |_| replied.load(Ordering::Relaxed).then_some(()),
        )
    }

    pub(super) fn displays(&self) -> Vec<Display> {
        self.state
            .outputs
            .iter()
            .filter_map(|(&id, output)| output.display(id))
            .collect()
    }

    pub(super) fn display(&self, id: u32, generation: u64) -> Result<Display> {
        let output = self.state.outputs.get(&id).ok_or_else(missing)?;
        if output.generation != generation {
            return Err(super::stale());
        }
        output.display(id).ok_or_else(missing)
    }

    pub(super) fn capture_protocol(&self) -> Option<(wl_shm::WlShm, Protocol)> {
        let (_, shm) = self.state.shm.as_ref()?;
        let protocol = match (&self.state.source, &self.state.copy, &self.state.screencopy) {
            (Some((_, source)), Some((_, copy)), _) => {
                Protocol::ImageCopy(source.clone(), copy.clone())
            }
            (_, _, Some((_, manager))) => Protocol::Screencopy(manager.clone()),
            _ => return None,
        };
        Some((shm.clone(), protocol))
    }

    pub(super) fn legacy_setup(&self) -> Option<legacy_input::Setup> {
        let (_, pointer) = self.state.pointer.as_ref()?;
        let mut seats = self.state.seats.values();
        let (seat, name) = if self.state.seats.len() == 1 {
            seats.next()?
        } else {
            let expected = std::env::var("XDG_SEAT").unwrap_or_else(|_| "seat0".into());
            seats.find(|(_, name)| name.as_deref() == Some(expected.as_str()))?
        };
        Some(legacy_input::Setup::new(
            self.connection.clone(),
            pointer.clone(),
            seat.clone(),
            name.clone(),
            self.state
                .clipboard
                .as_ref()
                .map(|(_, clipboard)| clipboard.clone()),
        ))
    }
}

impl Output {
    fn display(&self, id: u32) -> Option<Display> {
        use wl_output::Transform;
        let (mut width, mut height) = self.mode?;
        if matches!(
            self.transform,
            Transform::_90 | Transform::_270 | Transform::Flipped90 | Transform::Flipped270
        ) {
            (width, height) = (height, width);
        }
        let scale = f64::from(self.scale);
        let (x, y) = self.logical_position.unwrap_or(self.position);
        let size = self.logical_size.map_or_else(
            || (f64::from(width) / scale, f64::from(height) / scale),
            |(w, h)| (f64::from(w), f64::from(h)),
        );
        Some(Display {
            id,
            generation: self.generation,
            proxy: self.proxy.clone(),
            name: self.name.clone().unwrap_or_else(|| format!("Display {id}")),
            bounds: Bounds {
                x: x.into(),
                y: y.into(),
                width: size.0,
                height: size.1,
            },
            pixels: (width, height),
            scale: f64::from(width) / size.0,
        })
    }

    fn attach_xdg(
        &mut self,
        manager: &xdg_manager::ZxdgOutputManagerV1,
        qh: &QueueHandle<Inventory>,
        id: u32,
    ) {
        self.xdg = Some(manager.get_xdg_output(&self.proxy, qh, id));
    }

    fn release(self) {
        if let Some(output) = self.xdg {
            output.destroy();
        }
        if self.proxy.version() >= 3 {
            self.proxy.release();
        }
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for Inventory {
    fn event(
        state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } => match interface.as_str() {
                "wl_output"
                    if state.outputs.len() < MAX_OUTPUTS && state.generation < MAX_SEQUENCE =>
                {
                    state.generation += 1;
                    let mut output = Output {
                        proxy: registry.bind(name, version.min(4), qh, name),
                        xdg: None,
                        generation: state.generation,
                        name: None,
                        mode: None,
                        position: (0, 0),
                        logical_position: None,
                        logical_size: None,
                        transform: wl_output::Transform::Normal,
                        scale: 1,
                    };
                    if let Some((_, manager)) = &state.xdg {
                        output.attach_xdg(manager, qh, name);
                    }
                    state.outputs.insert(name, output);
                }
                "zxdg_output_manager_v1" if state.xdg.is_none() => {
                    let manager = registry.bind(name, version.min(3), qh, ());
                    for (&id, output) in &mut state.outputs {
                        output.attach_xdg(&manager, qh, id);
                    }
                    state.xdg = Some((name, manager));
                }
                "wl_shm" if state.shm.is_none() => {
                    state.shm = Some((name, registry.bind(name, 1, qh, ())))
                }
                "zwlr_screencopy_manager_v1" if state.screencopy.is_none() => {
                    state.screencopy = Some((name, registry.bind(name, version.min(3), qh, ())));
                }
                "ext_image_copy_capture_manager_v1" if state.copy.is_none() => {
                    state.copy = Some((name, registry.bind(name, 1, qh, ())));
                }
                "ext_output_image_capture_source_manager_v1" if state.source.is_none() => {
                    state.source = Some((name, registry.bind(name, 1, qh, ())));
                }
                "wl_seat" if state.seats.len() < MAX_OUTPUTS => {
                    state
                        .seats
                        .insert(name, (registry.bind(name, version.min(5), qh, name), None));
                }
                "zwlr_virtual_pointer_manager_v1" if version >= 2 && state.pointer.is_none() => {
                    state.pointer = Some((name, registry.bind(name, 2, qh, ())));
                }
                "zwlr_data_control_manager_v1" if state.clipboard.is_none() => {
                    state.clipboard = Some((name, registry.bind(name, version.min(2), qh, ())));
                }
                _ => {}
            },
            wl_registry::Event::GlobalRemove { name } => {
                if let Some(output) = state.outputs.remove(&name) {
                    output.release();
                }
                remove_global(&mut state.shm, name, drop);
                remove_global(&mut state.xdg, name, |proxy| proxy.destroy());
                remove_global(&mut state.copy, name, |proxy| proxy.destroy());
                remove_global(&mut state.source, name, |proxy| proxy.destroy());
                remove_global(&mut state.screencopy, name, |proxy| proxy.destroy());
                remove_global(&mut state.pointer, name, |proxy| proxy.destroy());
                remove_global(&mut state.clipboard, name, |proxy| proxy.destroy());
                if let Some((seat, _)) = state.seats.remove(&name)
                    && seat.version() >= 5
                {
                    seat.release();
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_seat::WlSeat, u32> for Inventory {
    fn event(
        state: &mut Self,
        _: &wl_seat::WlSeat,
        event: wl_seat::Event,
        id: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_seat::Event::Name { name } = event
            && let Some((_, observed)) = state.seats.get_mut(id)
        {
            *observed = Some(name);
        }
    }
}

delegate_noop!(Inventory: ignore virtual_pointer::ZwlrVirtualPointerManagerV1);
delegate_noop!(Inventory: ignore data_control::ZwlrDataControlManagerV1);

fn remove_global<T>(value: &mut Option<(u32, T)>, id: u32, remove: impl FnOnce(T)) {
    if value.as_ref().is_some_and(|(current, _)| *current == id)
        && let Some((_, object)) = value.take()
    {
        remove(object);
    }
}

impl Dispatch<wl_output::WlOutput, u32> for Inventory {
    fn event(
        state: &mut Self,
        _: &wl_output::WlOutput,
        event: wl_output::Event,
        id: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(output) = state.outputs.get_mut(id) else {
            return;
        };
        match event {
            wl_output::Event::Geometry {
                x,
                y,
                transform: WEnum::Value(transform),
                ..
            } => {
                output.position = (x, y);
                output.transform = transform;
            }
            wl_output::Event::Mode {
                flags: WEnum::Value(flags),
                width,
                height,
                ..
            } if flags.contains(wl_output::Mode::Current) && width > 0 && height > 0 => {
                output.mode = Some((width as u32, height as u32));
            }
            wl_output::Event::Name { name } => output.name = Some(name),
            wl_output::Event::Scale { factor } => output.scale = factor.max(1) as u32,
            _ => {}
        }
    }
}

impl Dispatch<xdg_output::ZxdgOutputV1, u32> for Inventory {
    fn event(
        state: &mut Self,
        _: &xdg_output::ZxdgOutputV1,
        event: xdg_output::Event,
        id: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(output) = state.outputs.get_mut(id) else {
            return;
        };
        match event {
            xdg_output::Event::LogicalPosition { x, y } => output.logical_position = Some((x, y)),
            xdg_output::Event::LogicalSize { width, height } if width > 0 && height > 0 => {
                output.logical_size = Some((width as u32, height as u32));
            }
            xdg_output::Event::Name { name } => output.name = Some(name),
            _ => {}
        }
    }
}

impl Dispatch<wl_callback::WlCallback, Arc<AtomicBool>> for Inventory {
    fn event(
        _: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        replied: &Arc<AtomicBool>,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        replied.store(true, Ordering::Relaxed);
    }
}

delegate_noop!(Inventory: ignore wl_shm::WlShm);
delegate_noop!(Inventory: ignore xdg_manager::ZxdgOutputManagerV1);
delegate_noop!(Inventory: ignore wlr_copy::ZwlrScreencopyManagerV1);
delegate_noop!(Inventory: ignore ext_copy::ExtImageCopyCaptureManagerV1);
delegate_noop!(Inventory: ignore ext_source::ExtOutputImageCaptureSourceManagerV1);
