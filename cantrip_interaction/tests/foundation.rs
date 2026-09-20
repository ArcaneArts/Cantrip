use cantrip_interaction::{
    cursor::{CursorAppearance, CursorState},
    geometry::{Bounds, Coordinates, ImagePoint, LogicalPoint, Point, ViewportPoint},
    motion::Motion,
    presentation::{CursorPresentation, CursorRenderer, CursorTarget, PresentationDelivery},
    telemetry::{EventKind, InputEvent, Telemetry},
};
use std::time::Duration;

fn coordinates() -> Coordinates {
    Coordinates {
        logical_bounds: Bounds {
            x: -1000.,
            y: 250.,
            width: 800.,
            height: 600.,
        },
        image_width: 1200,
        image_height: 900,
    }
}
#[test]
fn image_viewport_and_global_coordinates_have_distinct_origins_and_scales() {
    let geometry = coordinates();
    let point = LogicalPoint(Point { x: 200., y: 300. });
    let image = geometry.logical_to_image(point).unwrap();
    assert_eq!(image, ImagePoint(Point { x: 300., y: 450. }));
    assert_eq!(geometry.image_to_logical(image).unwrap(), point);
    assert_eq!(
        geometry.logical_to_global(point).unwrap().0,
        Point { x: -800., y: 550. }
    );
    let content = Bounds {
        x: 20.,
        y: 80.,
        width: 400.,
        height: 300.,
    };
    assert_eq!(
        geometry
            .viewport_to_logical(ViewportPoint(Point { x: 120., y: 230. }), content)
            .unwrap(),
        point
    );
    assert!(
        geometry
            .viewport_to_logical(ViewportPoint(Point { x: 120., y: 79. }), content)
            .is_err()
    );
    assert!(
        geometry
            .image_to_logical(ImagePoint(Point { x: 1200., y: 0. }))
            .is_err()
    );
    assert!(
        geometry
            .logical_to_image(LogicalPoint(Point { x: f64::NAN, y: 0. }))
            .is_err()
    );
    assert!(
        Coordinates {
            image_width: 0,
            ..geometry
        }
        .image_to_logical(image)
        .is_err()
    );
    // Replacing frame geometry changes the transform instead of retaining a
    // cached scale from an earlier snapshot.
    let resized = Coordinates {
        image_width: 600,
        image_height: 450,
        ..geometry
    };
    assert_eq!(
        resized.logical_to_image(point).unwrap(),
        ImagePoint(Point { x: 150., y: 225. })
    );
}

#[test]
fn motion_modes_are_visual_only_and_arrive_at_the_requested_time() {
    let start = Point { x: 10., y: 20. };
    let end = Point { x: 300., y: 200. };
    assert_eq!(
        Motion::Immediate
            .path(start, end)
            .unwrap()
            .collect::<Vec<_>>(),
        vec![(Duration::ZERO, end)]
    );
    let eased = Motion::EaseOut
        .path(start, end)
        .unwrap()
        .collect::<Vec<_>>();
    assert_eq!(eased.last().unwrap().1, end);
    assert!(eased.last().unwrap().0 <= Duration::from_millis(90));
    let scheduled = Motion::Scheduled {
        previous: None,
        next: None,
        begins: Duration::from_secs(1),
        deadline: Duration::from_secs(151),
    };
    let path = scheduled.path(start, end).unwrap();
    assert!(std::mem::size_of_val(&path) < 256);
    assert_eq!(path.last().unwrap(), (Duration::from_secs(151), end));
    assert!(
        Motion::Immediate
            .path(
                start,
                Point {
                    x: f64::INFINITY,
                    y: 1.
                }
            )
            .is_err()
    );
    assert!(
        Motion::Scheduled {
            previous: None,
            next: None,
            begins: Duration::from_secs(1),
            deadline: Duration::ZERO
        }
        .path(start, end)
        .is_err()
    );
}

// A surface fixture needs no window handle, process ID, or agent metadata.
#[derive(Clone, Debug)]
struct Surface {
    generation: u64,
}
impl CursorTarget for Surface {
    fn id(&self) -> &str {
        "surface"
    }
    fn generation(&self) -> u64 {
        self.generation
    }
    fn bounds(&self) -> Bounds {
        coordinates().logical_bounds
    }
    fn scale_factor(&self) -> f64 {
        1.5
    }
}
fn participant(id: &str) -> CursorPresentation<Surface> {
    CursorPresentation {
        participant_id: id.into(),
        appearance_identity: id.into(),
        target: Some(Surface { generation: 1 }),
        cursor: CursorState {
            appearance: CursorAppearance::for_identity(id),
            ..Default::default()
        },
    }
}
#[derive(Default)]
struct RecordingRenderer(Vec<CursorPresentation<Surface>>);
impl CursorRenderer<Surface> for RecordingRenderer {
    fn present(&mut self, participants: Vec<CursorPresentation<Surface>>, _: PresentationDelivery) {
        self.0 = participants;
    }
}
#[test]
fn renderer_and_telemetry_accept_non_window_participants_and_isolate_replacement() {
    let a = participant("first");
    let b = participant("second");
    assert_eq!(a.cursor.appearance, participant("first").cursor.appearance);
    assert_ne!(a.cursor.appearance.color, b.cursor.appearance.color);
    let mut renderer = RecordingRenderer::default();
    renderer.present(vec![a.clone(), b.clone()], PresentationDelivery::Latest);
    assert_eq!(renderer.0.len(), 2);
    let mut telemetry = Telemetry::default();
    telemetry.synchronize(&renderer.0, 0);
    telemetry.input(
        "first",
        a.target.as_ref().unwrap(),
        InputEvent {
            kind: EventKind::Press,
            code: 0,
            modifiers: 8,
            position: None,
            delta: [0.; 2],
        },
        10,
    );
    let states = telemetry.window("surface", 1, 10);
    assert_eq!(states.iter().filter(|s| s.buttons() == 1).count(), 1);
    assert_eq!(
        states
            .iter()
            .filter(|s| s.last_press_ns == Some(10))
            .count(),
        1
    );
    let mut replaced = a.clone();
    replaced.target.as_mut().unwrap().generation = 2;
    telemetry.synchronize(&[replaced, b.clone()], 20);
    // A delayed event for the old target cannot affect its replacement.
    telemetry.input(
        "first",
        a.target.as_ref().unwrap(),
        InputEvent {
            kind: EventKind::Press,
            code: 0,
            modifiers: 0,
            position: None,
            delta: [0.; 2],
        },
        30,
    );
    assert_eq!(telemetry.window("surface", 2, 30)[0].buttons(), 0);
    telemetry.synchronize(&[b], 40);
    assert!(telemetry.window("surface", 2, 40).is_empty());
    assert_eq!(telemetry.window("surface", 1, 40).len(), 1);
}
