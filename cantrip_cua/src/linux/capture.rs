use super::failure;
use crate::{
    backend::{Capture, Raster},
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    target::Target,
};
use x11rb::{
    connection::Connection,
    image::{Image, PixelLayout},
    protocol::xproto::{ConnectionExt, ImageFormat},
    rust_connection::RustConnection,
};

pub(super) fn capture(
    connection: &RustConnection,
    screen: usize,
    target: Target,
    cancel: &Cancellation,
) -> Result<Capture> {
    cancel.check()?;
    let root = &connection.setup().roots[screen];
    let reply = connection
        .get_image(
            ImageFormat::Z_PIXMAP,
            root.root,
            0,
            0,
            target.pixel_width as u16,
            target.pixel_height as u16,
            u32::MAX,
        )
        .map_err(failure)?
        .reply()
        .map_err(failure)?;
    let visual_id = reply.visual;
    let image = Image::get_from_reply(
        connection.setup(),
        target.pixel_width as u16,
        target.pixel_height as u16,
        reply,
    )
    .map_err(failure)?;
    let visual = root
        .allowed_depths
        .iter()
        .flat_map(|d| &d.visuals)
        .find(|v| v.visual_id == visual_id)
        .ok_or_else(|| {
            CuaError::new(
                ErrorCode::CaptureFailed,
                "X11 capture visual is unavailable.",
            )
        })?;
    let layout = PixelLayout::from_visual_type(*visual).map_err(failure)?;
    let mut rgba =
        Vec::with_capacity(target.pixel_width as usize * target.pixel_height as usize * 4);
    for y in 0..target.pixel_height {
        cancel.check()?;
        for x in 0..target.pixel_width {
            let pixel = image.get_pixel(x as u16, y as u16);
            let (r, g, b) = layout.decode(pixel);
            rgba.extend_from_slice(&[(r >> 8) as u8, (g >> 8) as u8, (b >> 8) as u8, 255]);
        }
    }
    let raster = Raster {
        width: target.pixel_width,
        height: target.pixel_height,
        rgba,
    };
    raster.validate()?;
    Ok(Capture { target, raster })
}
