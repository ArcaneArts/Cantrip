#![cfg(target_os = "linux")]
//! Real X server + real xterm acceptance. Never runs against an inherited display.
use cantrip_cua::{
    backend::CaptureBackend,
    cancellation::Cancellation,
    cursor::CursorState,
    gesture::{InputCommand, MouseButton},
    input_job::InputProgress,
    linux::X11Backend,
    target::Point,
};
use cantrip_interaction::input::InputEvent;
use std::{
    process::{Command, Stdio},
    time::{Duration, Instant},
};
use x11rb::{
    connection::Connection,
    protocol::xproto::{ConnectionExt, KeyButMask},
};

#[track_caller]
fn wait(mut ready: impl FnMut() -> bool) {
    let start = Instant::now();
    while !ready() {
        assert!(
            start.elapsed()
                < Duration::from_millis(
                    std::env::var("CANTRIP_CUA_X11_TEST_TIMEOUT_MS")
                        .ok()
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(15000)
                ),
            "Actual X11 operation did not reach its expected state"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[test]
#[ignore = "requires two explicitly selected disposable workspace desktops and xterm"]
fn real_x11_capture_text_hold_cancellation_and_display_identity() {
    let display = std::env::var("CANTRIP_CUA_X11_TEST_DISPLAY").unwrap();
    let other = std::env::var("CANTRIP_CUA_X11_TEST_OTHER_DISPLAY").unwrap();
    assert_ne!(display, other);
    let cancel = Cancellation::default();
    let mut backend = X11Backend::connect(&display, "acceptance-generation").unwrap();
    let mut second = X11Backend::connect(&other, "other-generation").unwrap();
    let target = backend.targets(&cancel).unwrap().remove(0);
    let other_target = second.targets(&cancel).unwrap().remove(0);
    assert_ne!(target.id, other_target.id);
    assert!(second.capture(&target, &cancel).is_err());
    let (observer, screen) = x11rb::connect(Some(&display)).unwrap();
    let root = observer.setup().roots[screen].root;
    let directory = std::env::temp_dir().join(format!("cantrip-x11-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let output = directory.join("typed.txt");
    let terminal = Command::new("xterm")
        .env("DISPLAY", &display)
        .args([
            "-geometry",
            "90x24+10+10",
            "-title",
            "Cantrip native X11 acceptance",
            "-e",
            "sh",
            "-c",
            r#"printf ready > "$1.ready"; read -r answer; printf '%s\n' "$answer" > "$1"; exec sleep 600"#,
            "sh",
        ])
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    struct Stop(std::process::Child);
    impl Drop for Stop {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let _terminal = Stop(terminal);
    // Observe both the X window and its real PTY child before sending input.
    wait(|| {
        Command::new("xwininfo")
            .args(["-display", &display, "-root", "-tree"])
            .output()
            .unwrap()
            .stdout
            .windows(b"Cantrip native X11 acceptance".len())
            .any(|v| v == b"Cantrip native X11 acceptance")
    });
    wait(|| output.with_extension("txt.ready").exists());
    let mut perform = |command| {
        backend
            .perform(
                "agent",
                &target,
                &command,
                Point { x: 100., y: 100. },
                &cancel,
                &mut |_| {},
            )
            .unwrap()
    };
    perform(InputCommand::PreparedPress {
        point: Some(Point { x: 100., y: 100. }),
        hold_ms: 0,
        button: MouseButton::Left,
    });
    perform(InputCommand::Text {
        text: "Cantrip Linux 日本語 café 🌙".into(),
    });
    perform(InputCommand::Key {
        key: "Enter".into(),
        modifiers: vec![],
    });
    wait(|| output.exists());
    assert_eq!(
        std::fs::read_to_string(&output).unwrap(),
        "Cantrip Linux 日本語 café 🌙\n"
    );
    let shot = backend.capture(&target, &cancel).unwrap();
    shot.raster.validate().unwrap();
    assert!(
        shot.raster
            .rgba
            .chunks_exact(4)
            .any(|p| p[0] > 100 && p[1] > 100 && p[2] > 100)
    );
    // A separate real X client receives button, wheel and drag events.
    use x11rb::protocol::{
        Event,
        xproto::{CreateWindowAux, EventMask, WindowClass},
    };
    let window = observer.generate_id().unwrap();
    observer
        .create_window(
            x11rb::COPY_DEPTH_FROM_PARENT,
            window,
            root,
            900,
            100,
            250,
            200,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new()
                .override_redirect(1)
                .background_pixel(0xffffff)
                .event_mask(
                    EventMask::BUTTON_PRESS | EventMask::BUTTON_RELEASE | EventMask::POINTER_MOTION,
                ),
        )
        .unwrap()
        .check()
        .unwrap();
    observer.map_window(window).unwrap().check().unwrap();
    wait(|| {
        backend.capture(&target, &cancel).unwrap().raster.rgba
            [((150 * target.pixel_width + 1000) * 4) as usize]
            == 255
    });
    backend
        .perform(
            "agent",
            &target,
            &InputCommand::Drag {
                start: Point { x: 950., y: 150. },
                end: Point { x: 1000., y: 200. },
                duration_ms: 40,
            },
            Point::default(),
            &cancel,
            &mut |_| {},
        )
        .unwrap();
    backend
        .perform(
            "agent",
            &target,
            &InputCommand::Scroll {
                point: Some(Point { x: 950., y: 150. }),
                delta_x: 0,
                delta_y: 80,
            },
            Point::default(),
            &cancel,
            &mut |_| {},
        )
        .unwrap();
    for _ in 0..2 {
        backend
            .perform(
                "agent",
                &target,
                &InputCommand::PreparedPress {
                    point: Some(Point { x: 950., y: 150. }),
                    hold_ms: 5,
                    button: MouseButton::Left,
                },
                Point::default(),
                &cancel,
                &mut |_| {},
            )
            .unwrap();
    }
    let (mut downs, mut ups, mut wheels, mut moves) = (0, 0, 0, 0);
    wait(|| {
        while let Some(event) = observer.poll_for_event().unwrap() {
            match event {
                Event::ButtonPress(e) if e.detail == 1 => downs += 1,
                Event::ButtonRelease(e) if e.detail == 1 => ups += 1,
                Event::ButtonPress(e) if e.detail == 5 => wheels += 1,
                Event::MotionNotify(_) => moves += 1,
                _ => {}
            }
        }
        downs >= 3 && ups >= 3 && wheels >= 2 && moves >= 2
    });
    observer.destroy_window(window).unwrap().check().unwrap();
    let current = backend.targets(&cancel).unwrap().remove(0);
    assert_eq!(target.generation, current.generation);
    backend
        .interaction_input(
            "human",
            &target,
            Point::default(),
            1,
            InputEvent::KeyDown {
                key: "Shift".into(),
                modifiers: vec![],
                repeat: false,
            },
            &cancel,
        )
        .unwrap();
    assert!(
        backend
            .interaction_input(
                "human",
                &target,
                Point::default(),
                1,
                InputEvent::KeyUp {
                    key: "Shift".into()
                },
                &cancel
            )
            .is_err()
    );
    // A duplicate sequence closes only that participant and releases its hold.
    let map = observer
        .get_keyboard_mapping(
            observer.setup().min_keycode,
            observer.setup().max_keycode - observer.setup().min_keycode + 1,
        )
        .unwrap()
        .reply()
        .unwrap();
    let shift = map
        .keysyms
        .chunks(map.keysyms_per_keycode as usize)
        .position(|keys| keys.contains(&0xffe1))
        .unwrap()
        + observer.setup().min_keycode as usize;
    wait(|| {
        observer.query_keymap().unwrap().reply().unwrap().keys[shift / 8] & (1 << (shift % 8)) == 0
    });
    let stopped = Cancellation::default();
    let work = backend
        .input_work(
            "agent",
            &target,
            &InputCommand::PreparedPress {
                point: Some(Point { x: 110., y: 100. }),
                hold_ms: 60000,
                button: MouseButton::Left,
            },
            Point { x: 110., y: 100. },
            &stopped,
            InputProgress::new(CursorState::default(), target.bounds, 1),
        )
        .unwrap()
        .unwrap();
    let job = std::thread::spawn(move || work(&mut |_| {}));
    wait(|| {
        observer
            .query_pointer(root)
            .unwrap()
            .reply()
            .unwrap()
            .mask
            .contains(KeyButMask::BUTTON1)
    });
    // Capture on the second display remains independent while the first holds input.
    second.capture(&other_target, &cancel).unwrap();
    stopped.cancel();
    assert!(job.join().unwrap().is_err());
    backend.input_finished("agent", false);
    wait(|| {
        !observer
            .query_pointer(root)
            .unwrap()
            .reply()
            .unwrap()
            .mask
            .contains(KeyButMask::BUTTON1)
    });
    backend.close_input("human").unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}
