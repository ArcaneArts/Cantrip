use super::{
    failure, stale,
    targets::{self, Monitor, PixelCoordinates, Window},
};
use crate::{
    backend::{Capture, Raster},
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    target::{MAX_IMAGE_PIXELS, Target},
};
use std::{mem::size_of, ptr::null_mut, slice};
use windows_sys::Win32::{
    Foundation::HWND,
    Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CreateCompatibleDC, CreateDIBSection,
        DIB_RGB_COLORS, DeleteDC, DeleteObject, GdiFlush, GetDC, HBITMAP, HDC, HGDIOBJ, ReleaseDC,
        SRCCOPY, SelectObject,
    },
    Storage::Xps::PrintWindow,
};

// PrintWindow requests the selected application's DWM backing content.
const PW_RENDERFULLCONTENT: u32 = 2;

pub(super) fn window(window: &Window, cancel: &Cancellation) -> Result<Capture> {
    cancel.check()?;
    let _coordinates = PixelCoordinates::enter();
    if window.target.minimized == Some(true) {
        return Err(failure("The selected Windows application is minimized."));
    }
    let width = window.frame.right - window.frame.left;
    let height = window.frame.bottom - window.frame.top;
    let x = window.client.left - window.frame.left;
    let y = window.client.top - window.frame.top;
    let client_width = window.client.right - window.client.left;
    let client_height = window.client.bottom - window.client.top;
    if x < 0
        || y < 0
        || client_width <= 0
        || client_height <= 0
        || x + client_width > width
        || y + client_height > height
    {
        return Err(failure("Invalid Windows window capture geometry."));
    }
    let screen = Screen::open()?;
    let image = Image::new(&screen, width, height)?;
    let captured = unsafe {
        PrintWindow(window.identity.hwnd as HWND, image.dc, PW_RENDERFULLCONTENT) != 0
            || PrintWindow(window.identity.hwnd as HWND, image.dc, 0) != 0
    };
    if !captured {
        return Err(failure(
            "Windows could not capture the selected application.",
        ));
    }
    cancel.check()?;
    render(window.target.clone(), &image, x, y)
}

pub(super) fn monitor(monitor: Monitor, cancel: &Cancellation) -> Result<Capture> {
    cancel.check()?;
    let _coordinates = PixelCoordinates::enter();
    let screen = Screen::open()?;
    let width = monitor.target.pixel_width as i32;
    let height = monitor.target.pixel_height as i32;
    let image = Image::new(&screen, width, height)?;
    if unsafe {
        BitBlt(
            image.dc,
            0,
            0,
            width,
            height,
            screen.0,
            monitor.target.bounds.x as i32,
            monitor.target.bounds.y as i32,
            SRCCOPY,
        )
    } == 0
    {
        return Err(failure("Windows could not capture the selected display."));
    }
    cancel.check()?;
    let unchanged = targets::monitors()?.into_iter().any(|current| {
        current.handle == monitor.handle
            && current.device == monitor.device
            && current.target.bounds == monitor.target.bounds
    });
    if !unchanged {
        return Err(stale());
    }
    render(monitor.target, &image, 0, 0)
}

struct Screen(HDC);

impl Screen {
    fn open() -> Result<Self> {
        let dc = unsafe { GetDC(null_mut()) };
        if dc.is_null() {
            return Err(failure("Windows could not open the desktop raster."));
        }
        Ok(Self(dc))
    }
}

impl Drop for Screen {
    fn drop(&mut self) {
        unsafe { ReleaseDC(null_mut(), self.0) };
    }
}

struct Image {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    pixels: *mut u8,
    stride: usize,
}

impl Image {
    fn new(screen: &Screen, width: i32, height: i32) -> Result<Self> {
        if width <= 0
            || height <= 0
            || (width as usize).saturating_mul(height as usize) > MAX_IMAGE_PIXELS
        {
            return Err(CuaError::new(
                ErrorCode::Capacity,
                "Windows capture exceeds the pixel limit.",
            ));
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..Default::default()
            },
            ..Default::default()
        };
        let dc = unsafe { CreateCompatibleDC(screen.0) };
        if dc.is_null() {
            return Err(failure("Windows could not allocate a capture context."));
        }
        let mut image = Self {
            dc,
            bitmap: null_mut(),
            previous: null_mut(),
            pixels: null_mut(),
            stride: width as usize * 4,
        };
        let mut pixels = null_mut();
        image.bitmap =
            unsafe { CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut pixels, null_mut(), 0) };
        if image.bitmap.is_null() || pixels.is_null() {
            return Err(failure("Windows could not allocate a capture raster."));
        }
        image.pixels = pixels.cast();
        image.previous = unsafe { SelectObject(dc, image.bitmap) };
        if image.previous.is_null() || image.previous as isize == -1 {
            return Err(failure("Windows could not attach the capture raster."));
        }
        // PrintWindow can leave padding untouched. Initialize it before any draw.
        unsafe { image.pixels.write_bytes(0, image.stride * height as usize) };
        Ok(image)
    }
}

impl Drop for Image {
    fn drop(&mut self) {
        unsafe {
            if !self.previous.is_null() && self.previous as isize != -1 {
                SelectObject(self.dc, self.previous);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            DeleteDC(self.dc);
        }
    }
}

fn render(target: Target, image: &Image, x: i32, y: i32) -> Result<Capture> {
    if unsafe { GdiFlush() } == 0 {
        return Err(failure("Windows did not complete the selected capture."));
    }
    let row_bytes = target.pixel_width as usize * 4;
    let mut rgba = Vec::with_capacity(row_bytes * target.pixel_height as usize);
    for y in y as usize..y as usize + target.pixel_height as usize {
        let offset = y * image.stride + x as usize * 4;
        let row = unsafe { slice::from_raw_parts(image.pixels.add(offset), row_bytes) };
        for bgra in row.chunks_exact(4) {
            rgba.extend_from_slice(&[bgra[2], bgra[1], bgra[0], 255]);
        }
    }
    Ok(Capture {
        raster: Raster {
            width: target.pixel_width,
            height: target.pixel_height,
            rgba,
        },
        target,
    })
}
