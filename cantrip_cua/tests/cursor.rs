use cantrip_cua::cursor::{CursorAppearance, CursorState, CursorStyle, MAX_TRAIL_POINTS};
use cantrip_cua::target::{Bounds, Point};

fn bounds() -> Bounds {
    Bounds {
        x: -1920.0,
        y: 80.0,
        width: 200.0,
        height: 100.0,
    }
}

fn appearance(style: CursorStyle) -> CursorAppearance {
    CursorAppearance {
        style,
        color: "#FF0000".into(),
        size: 20,
        ..CursorAppearance::default()
    }
}

fn rendered(state: &CursorState, width: u32, height: u32) -> Vec<u8> {
    let mut rgba = vec![0; width as usize * height as usize * 4];
    state.render(&mut rgba, width, height, &bounds()).unwrap();
    rgba
}

fn pixel(image: &[u8], width: usize, x: usize, y: usize) -> &[u8] {
    let index = (y * width + x) * 4;
    &image[index..index + 4]
}

#[test]
fn all_styles_render_distinct_images_at_the_logical_hotspot() {
    let mut images = Vec::new();
    for style in [
        CursorStyle::Arrow,
        CursorStyle::Dot,
        CursorStyle::Ring,
        CursorStyle::Crosshair,
    ] {
        let mut state = CursorState::new();
        state.configure(appearance(style), 1).unwrap();
        state
            .move_to(Point { x: 40.0, y: 30.0 }, &bounds(), 2)
            .unwrap();
        let image = rendered(&state, 200, 100);
        assert!(image.iter().any(|byte| *byte != 0));
        assert_eq!(pixel(&image, 200, 20, 10), &[0, 0, 0, 0]);
        if style == CursorStyle::Ring {
            assert_eq!(pixel(&image, 200, 40, 30), &[0, 0, 0, 0]);
            assert_eq!(pixel(&image, 200, 49, 30), &[255, 0, 0, 255]);
        } else {
            assert_eq!(pixel(&image, 200, 40, 30), &[255, 0, 0, 255]);
        }
        assert!(!images.contains(&image));
        images.push(image);
    }
}

#[test]
fn color_size_version_and_label_boundaries_are_validated() {
    for color in ["#000000", "#AbCdEf", "#12345678", "#00000000"] {
        CursorAppearance {
            color: color.into(),
            ..Default::default()
        }
        .validate()
        .unwrap();
    }
    for color in [
        "",
        "red",
        "#fff",
        "123456",
        "#1234567",
        "#123456789",
        "#GG0000",
        "#💥000",
    ] {
        assert!(
            CursorAppearance {
                color: color.into(),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
    for size in [8, 96] {
        CursorAppearance {
            size,
            ..Default::default()
        }
        .validate()
        .unwrap();
    }
    for size in [0, 7, 97, u16::MAX] {
        assert!(
            CursorAppearance {
                size,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
    assert!(
        CursorAppearance {
            version: 2,
            ..Default::default()
        }
        .validate()
        .is_err()
    );
    for label in [
        "".into(),
        "a".repeat(64),
        "🖱".repeat(64),
        "Éλληνικά あ".into(),
    ] {
        CursorAppearance {
            label: Some(label),
            ..Default::default()
        }
        .validate()
        .unwrap();
    }
    for label in [
        "a".repeat(65),
        "🖱".repeat(65),
        "line\nfeed".into(),
        "\0".into(),
        "\u{7f}".into(),
    ] {
        assert!(
            CursorAppearance {
                label: Some(label),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
}

#[test]
fn serde_uses_versioned_camel_case_contract_and_rejects_unknown_fields() {
    let default: CursorAppearance = serde_json::from_str("{}").unwrap();
    assert_eq!(default, CursorAppearance::default());
    let mut state = CursorState::new();
    state
        .configure(appearance(CursorStyle::Crosshair), 5)
        .unwrap();
    let json = serde_json::to_value(&state).unwrap();
    assert_eq!(json["appearance"]["version"], 1);
    assert_eq!(json["appearance"]["style"], "crosshair");
    assert_eq!(json["updatedAtMs"], 5);
    assert!(json.get("trailPoints").is_some());
    assert!(
        serde_json::from_str::<CursorAppearance>("{\"imageUrl\":\"https://example.com\"}").is_err()
    );
    assert!(serde_json::from_str::<CursorAppearance>("{\"style\":\"custom\"}").is_err());
}

#[test]
fn invalid_coordinates_leave_state_unchanged() {
    let mut state = CursorState::new();
    for point in [
        Point {
            x: f64::NAN,
            y: 0.0,
        },
        Point {
            x: 0.0,
            y: f64::INFINITY,
        },
        Point { x: -1.0, y: 0.0 },
        Point { x: 200.0, y: 0.0 },
        Point { x: 0.0, y: 100.0 },
        Point {
            x: f64::NEG_INFINITY,
            y: 0.0,
        },
    ] {
        let before = state.clone();
        assert!(state.move_to(point, &bounds(), 5).is_err());
        assert_eq!(state, before);
    }
    state
        .move_to(
            Point {
                x: 199.99,
                y: 99.99,
            },
            &bounds(),
            10,
        )
        .unwrap();
    state
        .move_to(Point { x: 0.0, y: 0.0 }, &bounds(), 9)
        .unwrap();
    assert_eq!(state.updated_at_ms, 10);
}

#[test]
fn mixed_axis_scaling_and_negative_monitor_origin_preserve_local_position() {
    let mut state = CursorState::new();
    state.configure(appearance(CursorStyle::Dot), 1).unwrap();
    state
        .move_to(Point { x: 50.0, y: 40.0 }, &bounds(), 2)
        .unwrap();
    let image = rendered(&state, 400, 300);
    assert_eq!(pixel(&image, 400, 100, 120), &[255, 0, 0, 255]);
    assert_eq!(pixel(&image, 400, 119, 120), &[255, 0, 0, 255]);
    assert_eq!(pixel(&image, 400, 120, 120), &[0, 0, 0, 0]);
    assert_eq!(pixel(&image, 400, 100, 149), &[255, 0, 0, 255]);
    assert_eq!(pixel(&image, 400, 100, 150), &[0, 0, 0, 0]);
    assert_eq!(pixel(&image, 400, 50, 40), &[0, 0, 0, 0]);
}

#[test]
fn trail_is_bounded_and_disabling_it_clears_history() {
    let mut state = CursorState::new();
    state
        .configure(
            CursorAppearance {
                trail: true,
                ..appearance(CursorStyle::Dot)
            },
            1,
        )
        .unwrap();
    for x in 1..80 {
        state
            .move_to(
                Point {
                    x: f64::from(x),
                    y: 30.0,
                },
                &bounds(),
                x as u64 + 1,
            )
            .unwrap();
    }
    assert_eq!(state.trail_points.len(), MAX_TRAIL_POINTS);
    assert_eq!(state.trail_points.first().unwrap().x, 55.0);
    assert_eq!(state.trail_points.last().unwrap().x, 78.0);
    let image = rendered(&state, 200, 100);
    assert!(pixel(&image, 200, 56, 30)[3] > 0);
    state.configure(appearance(CursorStyle::Dot), 100).unwrap();
    assert!(state.trail_points.is_empty());
    assert_eq!(
        pixel(&rendered(&state, 200, 100), 200, 56, 30),
        &[0, 0, 0, 0]
    );
}

#[test]
fn configuration_applies_to_the_next_render_and_invalid_configuration_is_atomic() {
    let mut state = CursorState::new();
    state
        .move_to(Point { x: 40.0, y: 30.0 }, &bounds(), 1)
        .unwrap();
    let first = rendered(&state, 200, 100);
    state
        .configure(
            CursorAppearance {
                color: "#00FF00".into(),
                ..appearance(CursorStyle::Dot)
            },
            2,
        )
        .unwrap();
    let next = rendered(&state, 200, 100);
    assert_ne!(first, next);
    assert_eq!(pixel(&next, 200, 40, 30), &[0, 255, 0, 255]);
    let before = state.clone();
    assert!(
        state
            .configure(
                CursorAppearance {
                    size: 0,
                    ..Default::default()
                },
                3
            )
            .is_err()
    );
    assert_eq!(state, before);
    state
        .configure(
            CursorAppearance {
                visible: false,
                ..Default::default()
            },
            4,
        )
        .unwrap();
    assert!(rendered(&state, 200, 100).iter().all(|byte| *byte == 0));
}

#[test]
fn alpha_is_composited_over_transparent_and_translucent_pixels() {
    let mut state = CursorState::new();
    state
        .configure(
            CursorAppearance {
                color: "#FF000080".into(),
                ..appearance(CursorStyle::Dot)
            },
            1,
        )
        .unwrap();
    state
        .move_to(Point { x: 40.0, y: 30.0 }, &bounds(), 2)
        .unwrap();
    assert_eq!(
        pixel(&rendered(&state, 200, 100), 200, 40, 30),
        &[255, 0, 0, 128]
    );
    let mut translucent: Vec<u8> = [0, 0, 255, 128].repeat(200 * 100);
    state.render(&mut translucent, 200, 100, &bounds()).unwrap();
    assert_eq!(pixel(&translucent, 200, 40, 30), &[170, 0, 85, 192]);
    let mut opaque: Vec<u8> = [0, 0, 255, 255].repeat(200 * 100);
    state.render(&mut opaque, 200, 100, &bounds()).unwrap();
    assert_eq!(pixel(&opaque, 200, 40, 30), &[128, 0, 127, 255]);
}

#[test]
fn labels_render_supported_unicode_and_a_visible_unsupported_replacement() {
    let mut state = CursorState::new();
    state
        .move_to(Point { x: 20.0, y: 20.0 }, &bounds(), 1)
        .unwrap();
    let mut images = Vec::new();
    for label in ["A", "é", "λ", "あ", "🖱"] {
        state
            .configure(
                CursorAppearance {
                    label: Some(label.into()),
                    ..appearance(CursorStyle::Dot)
                },
                2,
            )
            .unwrap();
        let image = rendered(&state, 200, 100);
        assert!((20..28).any(|y| (44..52).any(|x| pixel(&image, 200, x, y) == [255, 0, 0, 255])));
        assert!(!images.contains(&image));
        images.push(image);
    }
}

#[test]
fn image_size_validation_and_edge_clipping_do_not_panic_or_write_outside_buffer() {
    let mut state = CursorState::new();
    for (width, height, length) in [
        (0, 1, 0),
        (1, 0, 0),
        (1, 1, 3),
        (1, 1, 5),
        (u32::MAX, u32::MAX, 4),
    ] {
        assert!(
            state
                .render(&mut vec![0; length], width, height, &bounds())
                .is_err()
        );
    }
    for style in [
        CursorStyle::Arrow,
        CursorStyle::Dot,
        CursorStyle::Ring,
        CursorStyle::Crosshair,
    ] {
        state
            .configure(
                CursorAppearance {
                    label: Some("a".repeat(64)),
                    ..appearance(style)
                },
                1,
            )
            .unwrap();
        for point in [Point { x: 0.0, y: 0.0 }, Point { x: 199.9, y: 99.9 }] {
            state.move_to(point, &bounds(), 2).unwrap();
            let image = rendered(&state, 1, 1);
            assert_eq!(image.len(), 4);
        }
    }
    let invalid_bounds = Bounds {
        width: f64::NAN,
        ..bounds()
    };
    assert!(state.render(&mut [0; 4], 1, 1, &invalid_bounds).is_err());
}
