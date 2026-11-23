use super::Process;
use cantrip_cua::{error::ErrorCode, protocol::Outcome};
use serde_json::{Value, json};
use std::{io::Cursor, process::Command};

#[test]
#[ignore = "requires two outputs on an explicitly disposable Sway compositor"]
fn selected_wayland_outputs_have_distinct_pixels_and_lifetimes() {
    let display = std::env::var("CANTRIP_CUA_TEST_WAYLAND_DISPLAY").unwrap();
    let runtime = std::env::var("CANTRIP_CUA_TEST_WAYLAND_RUNTIME").unwrap();
    let sway = std::env::var("CANTRIP_CUA_TEST_SWAY_SOCKET").unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_cantrip-cua"));
    command
        .env("XDG_RUNTIME_DIR", runtime)
        .env("XDG_SESSION_TYPE", "wayland")
        .env("WAYLAND_DISPLAY", display)
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_SOCKET")
        .env("PATH", "");
    let mut child = Process::spawn(command);
    let (caps, _) = child.call(json!({"operation":"capabilities.get"}));
    assert_eq!(caps["backend"], "linux-wayland");
    assert_eq!(caps["capture"], true);
    assert_eq!(caps["nativeInput"], false);

    let (inventory, _) = child.call(json!({"operation":"targets.list"}));
    let targets = inventory["targets"].as_array().unwrap();
    assert_eq!(targets.len(), 2);
    let find = |name: &str| {
        targets
            .iter()
            .find(|target| target["title"] == name)
            .unwrap()
    };
    let left = find("HEADLESS-1");
    let right = find("HEADLESS-2");
    assert_eq!(left["bounds"]["x"], 0.0);
    assert_eq!(right["bounds"]["x"], 640.0);
    assert_eq!(left["access"]["reason"], "display-may-include-cantrip");
    assert_eq!(right["access"]["reason"], "display-may-include-cantrip");

    let capture = |child: &mut Process, target: &Value, participant: &str, color: [u8; 4]| {
        let binding = json!({"workerId":"worker","surfaceId":"surface","attachmentId":participant,"participantId":participant});
        let open = |operation: &str| {
            json!({
                "operation":operation,
                "request":{"type":"open","binding":binding,"targetId":target["id"],"targetGeneration":target["generation"]}
            })
        };
        let id = child.send(open("interaction.request"));
        assert!(
            matches!(child.response(id).0, Outcome::Error { error } if error.code == ErrorCode::Unsupported)
        );

        let (lease, _) = child.call(open("capture.request"));
        let operation = json!({"operation":"capture.request","request":{"type":"frame","binding":binding,"handle":lease["handle"]}});
        let (info, image) = child.call(operation.clone());
        assert_eq!(info["image"]["cursorIncluded"], false);
        let mut png = png::Decoder::new(Cursor::new(image)).read_info().unwrap();
        let mut pixels = vec![0; png.output_buffer_size().unwrap()];
        let dimensions = png.next_frame(&mut pixels).unwrap();
        assert_eq!((dimensions.width, dimensions.height), (640, 480));
        let offset = ((240 * 640) + 320) * 4;
        assert_eq!(&pixels[offset..offset + 4], &color);
        operation
    };
    let old_left = capture(&mut child, left, "left", [0x17, 0x32, 0x61, 255]);
    capture(&mut child, right, "right", [0xa9, 0x21, 0x43, 255]);

    assert!(
        Command::new("swaymsg")
            .args(["-s", &sway, "output HEADLESS-1 disable"])
            .status()
            .unwrap()
            .success()
    );
    let (inventory, _) = child.call(json!({"operation":"targets.list"}));
    assert_eq!(inventory["targets"].as_array().unwrap().len(), 1);
    assert_eq!(inventory["targets"][0]["title"], "HEADLESS-2");

    let id = child.send(old_left);
    assert!(
        matches!(child.response(id).0, Outcome::Error { error } if error.code == ErrorCode::StaleTarget)
    );
    child.stop(true);
}
