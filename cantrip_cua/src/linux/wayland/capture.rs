use super::{
    drive,
    inventory::{Display, Protocol},
};
use crate::{
    backend::{Capture, Raster},
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    target::{MAX_IMAGE_PIXELS, Target},
};
use rustix::fs::{MemfdFlags, memfd_create};
use std::{
    fs::File,
    os::{fd::AsFd, unix::fs::FileExt},
    time::{Duration, Instant},
};
use wayland_client::{
    Connection, Dispatch, Proxy, QueueHandle, WEnum, delegate_noop,
    protocol::{wl_buffer, wl_output::Transform, wl_shm, wl_shm_pool},
};
use wayland_protocols::ext::{
    image_capture_source::v1::client::ext_image_capture_source_v1 as source,
    image_copy_capture::v1::client::{
        ext_image_copy_capture_frame_v1 as ext_frame,
        ext_image_copy_capture_manager_v1 as ext_manager,
        ext_image_copy_capture_session_v1 as ext_session,
    },
};
use wayland_protocols_wlr::screencopy::v1::client::zwlr_screencopy_frame_v1 as wlr_frame;

const FRAME_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_BUFFER_BYTES: usize = 128 * 1024 * 1024;

pub(super) fn capture(
    connection: &Connection,
    shm: &wl_shm::WlShm,
    protocol: &Protocol,
    display: &Display,
    mut target: Target,
    cancel: &Cancellation,
) -> Result<Capture> {
    cancel.check()?;
    let deadline = Instant::now() + FRAME_TIMEOUT;
    let mut queue = connection.new_event_queue();
    let qh = queue.handle();
    let mut state = FrameState::new();
    let buffer = match protocol {
        Protocol::Screencopy(manager) => {
            let frame = manager.capture_output(0, &display.proxy, &qh, ());
            let result = (|| {
                let layout =
                    drive::until(&mut queue, &mut state, deadline, cancel, FrameState::layout)??;
                let buffer = Buffer::new(shm, layout, &qh)?;
                frame.copy(&buffer.proxy);
                drive::until(&mut queue, &mut state, deadline, cancel, FrameState::frame)??;
                Ok::<_, CuaError>(buffer)
            })();
            frame.destroy();
            result
        }
        Protocol::ImageCopy(source_manager, manager) => {
            let source = source_manager.create_source(&display.proxy, &qh, ());
            let session = manager.create_session(&source, ext_manager::Options::empty(), &qh, ());
            let result = (|| {
                let layout =
                    drive::until(&mut queue, &mut state, deadline, cancel, FrameState::layout)??;
                let buffer = Buffer::new(shm, layout, &qh)?;
                let frame = session.create_frame(&qh, ());
                frame.attach_buffer(&buffer.proxy);
                frame.damage_buffer(0, 0, layout.width as i32, layout.height as i32);
                frame.capture();
                let captured =
                    drive::until(&mut queue, &mut state, deadline, cancel, FrameState::frame);
                frame.destroy();
                captured??;
                Ok::<_, CuaError>(buffer)
            })();
            session.destroy();
            source.destroy();
            result
        }
    };
    let raster = buffer.and_then(|buffer| buffer.raster(&state, cancel));
    let _ = connection.flush();
    let raster = raster?;
    target.pixel_width = raster.width;
    target.pixel_height = raster.height;
    Ok(Capture { target, raster })
}

#[derive(Clone, Copy)]
struct Layout {
    width: u32,
    height: u32,
    stride: u32,
    format: wl_shm::Format,
}

impl Layout {
    fn length(self) -> Result<usize> {
        if self.width == 0 || self.height == 0 || self.stride < self.width.saturating_mul(4) {
            return Err(failed(
                "The Wayland compositor supplied invalid frame dimensions.",
            ));
        }
        (self.stride as usize)
            .checked_mul(self.height as usize)
            .filter(|&len| len <= MAX_BUFFER_BYTES)
            .ok_or_else(|| failed("The Wayland capture buffer exceeds the size limit."))
    }
}

struct Buffer {
    proxy: wl_buffer::WlBuffer,
    file: File,
    layout: Layout,
    length: usize,
}

impl Buffer {
    fn new(shm: &wl_shm::WlShm, layout: Layout, qh: &QueueHandle<FrameState>) -> Result<Self> {
        let length = layout.length()?;
        let fd =
            memfd_create(c"cantrip-wayland-frame", MemfdFlags::CLOEXEC).map_err(drive::failed)?;
        let file = File::from(fd);
        file.set_len(length as u64).map_err(drive::failed)?;
        let pool = shm.create_pool(file.as_fd(), length as i32, qh, ());
        let proxy = pool.create_buffer(
            0,
            layout.width as i32,
            layout.height as i32,
            layout.stride as i32,
            layout.format,
            qh,
            (),
        );
        pool.destroy();
        Ok(Self {
            proxy,
            file,
            layout,
            length,
        })
    }

    fn raster(&self, state: &FrameState, cancel: &Cancellation) -> Result<Raster> {
        let mut buffer = vec![0; self.length];
        self.file
            .read_exact_at(&mut buffer, 0)
            .map_err(drive::failed)?;
        let Layout {
            width,
            height,
            stride,
            format,
        } = self.layout;
        let transform = state.transform;
        let (width_out, height_out) = if matches!(
            transform,
            Transform::_90 | Transform::_270 | Transform::Flipped90 | Transform::Flipped270
        ) {
            (height, width)
        } else {
            (width, height)
        };
        let (scaled_width, scaled_height) = scaled_dimensions(width_out, height_out)?;
        let len = scaled_width as usize * scaled_height as usize;
        let mut rgba = Vec::with_capacity(len * 4);
        for y in 0..scaled_height {
            cancel.check()?;
            for x in 0..scaled_width {
                let x = (u64::from(x) * u64::from(width_out) / u64::from(scaled_width)) as u32;
                let y = (u64::from(y) * u64::from(height_out) / u64::from(scaled_height)) as u32;
                let (x, y) = buffer_coordinates(transform, width, height, x, y)?;
                let y = if state.y_invert { height - 1 - y } else { y };
                let offset = y as usize * stride as usize + x as usize * 4;
                let pixel = u32::from_ne_bytes(buffer[offset..offset + 4].try_into().unwrap());
                let (red, green, blue) = ((pixel >> 16) as u8, (pixel >> 8) as u8, pixel as u8);
                let (red, blue) =
                    if matches!(format, wl_shm::Format::Xbgr8888 | wl_shm::Format::Abgr8888) {
                        (blue, red)
                    } else {
                        (red, blue)
                    };
                rgba.extend_from_slice(&[red, green, blue, 255]);
            }
        }
        Ok(Raster {
            width: scaled_width,
            height: scaled_height,
            rgba,
        })
    }
}

pub(super) fn scaled_dimensions(width: u32, height: u32) -> Result<(u32, u32)> {
    let pixel_count = f64::from(width) * f64::from(height);
    let ratio = ((MAX_IMAGE_PIXELS as f64 / pixel_count).sqrt()).min(1.);
    let width = ((f64::from(width) * ratio).floor() as u32).max(1);
    let height = ((f64::from(height) * ratio).floor() as u32).max(1);
    if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS as u64 {
        return Err(failed("The Wayland image exceeds the pixel limit."));
    }
    Ok((width, height))
}

fn buffer_coordinates(transform: Transform, w: u32, h: u32, x: u32, y: u32) -> Result<(u32, u32)> {
    Ok(match transform {
        Transform::Normal => (x, y),
        Transform::_90 => (w - 1 - y, x),
        Transform::_180 => (w - 1 - x, h - 1 - y),
        Transform::_270 => (y, h - 1 - x),
        Transform::Flipped => (w - 1 - x, y),
        Transform::Flipped90 => (y, x),
        Transform::Flipped180 => (x, h - 1 - y),
        Transform::Flipped270 => (w - 1 - y, h - 1 - x),
        _ => {
            return Err(failed(
                "The Wayland compositor supplied an unknown transform.",
            ));
        }
    })
}

impl Drop for Buffer {
    fn drop(&mut self) {
        self.proxy.destroy();
    }
}

struct FrameState {
    layout: Option<Layout>,
    size: Option<(u32, u32)>,
    format: Option<wl_shm::Format>,
    offers_ready: bool,
    ready: bool,
    failed: bool,
    transform: Transform,
    y_invert: bool,
}

impl FrameState {
    fn new() -> Self {
        Self {
            layout: None,
            size: None,
            format: None,
            offers_ready: false,
            ready: false,
            failed: false,
            transform: Transform::Normal,
            y_invert: false,
        }
    }

    fn layout(&self) -> Option<Result<Layout>> {
        if self.failed {
            return Some(Err(failed("The Wayland compositor declined capture.")));
        }
        self.offers_ready.then(|| {
            self.layout.ok_or_else(|| {
                failed("The Wayland compositor did not offer a supported shared-memory format.")
            })
        })
    }

    fn frame(&self) -> Option<Result<()>> {
        if self.failed {
            Some(Err(failed(
                "The Wayland compositor could not capture this output.",
            )))
        } else {
            self.ready.then_some(Ok(()))
        }
    }
}

fn supports(format: wl_shm::Format) -> bool {
    matches!(
        format,
        wl_shm::Format::Xrgb8888
            | wl_shm::Format::Argb8888
            | wl_shm::Format::Xbgr8888
            | wl_shm::Format::Abgr8888
    )
}

impl Dispatch<wlr_frame::ZwlrScreencopyFrameV1, ()> for FrameState {
    fn event(
        state: &mut Self,
        frame: &wlr_frame::ZwlrScreencopyFrameV1,
        event: wlr_frame::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wlr_frame::Event::Buffer {
                format,
                width,
                height,
                stride,
            } => {
                if let WEnum::Value(format) = format
                    && supports(format)
                {
                    state.layout = Some(Layout {
                        format,
                        width,
                        height,
                        stride,
                    });
                }
                state.offers_ready = frame.version() < 3;
            }
            wlr_frame::Event::BufferDone => state.offers_ready = true,
            wlr_frame::Event::Flags {
                flags: WEnum::Value(flags),
            } => {
                state.y_invert = flags.contains(wlr_frame::Flags::YInvert);
            }
            wlr_frame::Event::Ready { .. } => state.ready = true,
            wlr_frame::Event::Failed => state.failed = true,
            _ => {}
        }
    }
}

impl Dispatch<ext_session::ExtImageCopyCaptureSessionV1, ()> for FrameState {
    fn event(
        state: &mut Self,
        _: &ext_session::ExtImageCopyCaptureSessionV1,
        event: ext_session::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            ext_session::Event::BufferSize { width, height } => state.size = Some((width, height)),
            ext_session::Event::ShmFormat {
                format: WEnum::Value(format),
            } if supports(format) => {
                state.format.get_or_insert(format);
            }
            ext_session::Event::Done => {
                state.layout = state
                    .size
                    .zip(state.format)
                    .map(|((width, height), format)| Layout {
                        width,
                        height,
                        stride: width.saturating_mul(4),
                        format,
                    });
                state.offers_ready = true;
            }
            ext_session::Event::Stopped => state.failed = true,
            _ => {}
        }
    }
}

impl Dispatch<ext_frame::ExtImageCopyCaptureFrameV1, ()> for FrameState {
    fn event(
        state: &mut Self,
        _: &ext_frame::ExtImageCopyCaptureFrameV1,
        event: ext_frame::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            ext_frame::Event::Transform {
                transform: WEnum::Value(transform),
            } => state.transform = transform,
            ext_frame::Event::Transform { .. } | ext_frame::Event::Failed { .. } => {
                state.failed = true
            }
            ext_frame::Event::Ready => state.ready = true,
            _ => {}
        }
    }
}

delegate_noop!(FrameState: ignore wl_buffer::WlBuffer);
delegate_noop!(FrameState: ignore wl_shm_pool::WlShmPool);
delegate_noop!(FrameState: ignore source::ExtImageCaptureSourceV1);

fn failed(message: &'static str) -> CuaError {
    CuaError::new(ErrorCode::CaptureFailed, message)
}
