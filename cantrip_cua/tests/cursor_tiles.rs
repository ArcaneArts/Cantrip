use cantrip_cua::{
    cursor::{CursorState, CursorStyle, MAX_TRAIL_POINTS},
    target::{Bounds, Point},
};

#[test]
fn tiled_composition_matches_full_image_across_styles_edges_labels_and_feedback() {
    let bounds = Bounds {
        x: -1920.0,
        y: -800.0,
        width: 800.0,
        height: 600.0,
    };
    for style in [
        CursorStyle::Arrow,
        CursorStyle::Dot,
        CursorStyle::Ring,
        CursorStyle::Crosshair,
    ] {
        for position in [
            Point { x: 255.5, y: 256.5 },
            Point { x: 799.0, y: 599.0 },
            Point { x: 0.0, y: 0.0 },
        ] {
            let mut cursor = CursorState::new();
            cursor.appearance.style = style;
            cursor.appearance.size = 96;
            cursor.appearance.color = "#20BFA980".into();
            cursor.appearance.label = Some("Agent λあ label spanning a tile boundary".into());
            cursor.appearance.trail = true;
            cursor.position = position;
            cursor.trail_points = vec![
                Point { x: 2.0, y: 580.0 },
                Point { x: 256.0, y: 256.0 },
                Point { x: 798.0, y: 2.0 },
            ];
            cursor.mark_action("accessibility", "dispatched", 1);
            let mut full = vec![0; 800 * 600 * 4];
            cursor.render(&mut full, 800, 600, &bounds).unwrap();
            let mut composed = vec![0; full.len()];
            let mut visited = vec![false; 800 * 600];
            for region in cursor.desktop_tiles(&bounds).unwrap() {
                let width = region.width as usize;
                let height = region.height as usize;
                let mut tile = vec![0; width * height * 4];
                cursor
                    .render_region(&mut tile, width as u32, height as u32, &bounds, &region)
                    .unwrap();
                for y in 0..height {
                    for x in 0..width {
                        let dst = (region.y as usize + y) * 800 + region.x as usize + x;
                        assert!(
                            !visited[dst],
                            "overlapping tiles double-blend translucent pixels"
                        );
                        visited[dst] = true;
                        composed[dst * 4..dst * 4 + 4]
                            .copy_from_slice(&tile[(y * width + x) * 4..(y * width + x) * 4 + 4]);
                    }
                }
            }
            assert_eq!(full, composed, "{style:?} at {position:?}");
        }
    }
}

#[test]
fn large_window_and_distant_trails_need_only_small_rasters() {
    let bounds = Bounds {
        x: -4000.0,
        y: -2000.0,
        width: 8000.0,
        height: 4000.0,
    };
    let mut cursor = CursorState::new();
    cursor.position = Point {
        x: 7900.0,
        y: 3900.0,
    };
    cursor.appearance.trail = true;
    cursor.appearance.size = 96;
    cursor.appearance.label = Some("A".repeat(64));
    cursor.mark_action("background-coordinate", "unknown", 1);
    cursor.trail_points = (0..MAX_TRAIL_POINTS)
        .map(|i| Point {
            x: i as f64 * 320.0,
            y: i as f64 * 150.0,
        })
        .collect();
    let regions = cursor.desktop_tiles(&bounds).unwrap();
    assert!(regions.len() < 128);
    let mut painted = 0;
    for region in &regions {
        assert!(region.width <= 256.0 && region.height <= 256.0);
        let mut tile = vec![0; region.width as usize * region.height as usize * 4];
        cursor
            .render_region(
                &mut tile,
                region.width as u32,
                region.height as u32,
                &bounds,
                region,
            )
            .unwrap();
        painted += tile.chunks_exact(4).filter(|p| p[3] != 0).count();
    }
    assert!(painted > 100);
    cursor.appearance.visible = false;
    assert!(cursor.desktop_tiles(&bounds).unwrap().is_empty());
}

#[test]
fn regions_are_clipped_to_fractional_window_edges_and_invalid_regions_are_rejected() {
    let bounds = Bounds {
        x: 0.0,
        y: 0.0,
        width: 800.5,
        height: 600.25,
    };
    let mut cursor = CursorState::new();
    cursor.position = Point { x: 800.0, y: 600.0 };
    for region in cursor.desktop_tiles(&bounds).unwrap() {
        assert!(
            region.x + region.width <= bounds.width && region.y + region.height <= bounds.height
        );
        let w = region.width.ceil() as u32;
        let h = region.height.ceil() as u32;
        cursor
            .render_region(
                &mut vec![0; w as usize * h as usize * 4],
                w,
                h,
                &bounds,
                &region,
            )
            .unwrap();
    }
    let outside = Bounds {
        x: -1.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
    };
    assert!(
        cursor
            .render_region(&mut [0; 400], 10, 10, &bounds, &outside)
            .is_err()
    );
}
