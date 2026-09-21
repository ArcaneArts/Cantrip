//! Client cursor assets use the exact shared rasterizer, never window pixels.
use crate::{
    cursor::CursorState,
    target::{Bounds, Point},
};
use serde::Serialize;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sprite {
    width: u32,
    height: u32,
    hotspot: Point,
    normal: Vec<u8>,
    click: Vec<u8>,
}
pub(crate) fn sprite(cursor: &CursorState) -> Option<Sprite> {
    let mut state = cursor.clone();
    state.position = Point { x: 128., y: 128. };
    state.trail_points.clear();
    state.action = None;
    let normal = png(&state)?;
    state.mark_action("remote-pointer", "dispatched", 0);
    state.updated_at_ms = 0;
    Some(Sprite {
        width: 256,
        height: 256,
        hotspot: state.position,
        normal,
        click: png(&state)?,
    })
}
fn png(state: &CursorState) -> Option<Vec<u8>> {
    let bounds = Bounds {
        x: 0.,
        y: 0.,
        width: 256.,
        height: 256.,
    };
    let mut rgba = vec![0; 512 * 512 * 4];
    state.render(&mut rgba, 512, 512, &bounds).ok()?;
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 512, 512);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
    }
    (bytes.len() <= 262144).then_some(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn assets_have_transparent_pixels_and_shared_identity_glow() {
        let cursor = CursorState::default();
        let asset = sprite(&cursor).unwrap();
        assert_ne!(asset.normal, asset.click);
        let mut reader = png::Decoder::new(std::io::Cursor::new(asset.normal))
            .read_info()
            .unwrap();
        let mut rgba = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut rgba).unwrap();
        assert_eq!((info.width, info.height), (512, 512));
        assert_eq!(rgba[3], 0);
        assert!(rgba.chunks_exact(4).any(|p| p[3] > 0));
        let mut other = cursor;
        other.appearance = crate::cursor::CursorAppearance::for_identity("another participant");
        assert_ne!(sprite(&other).unwrap().click, asset.click);
    }
}
