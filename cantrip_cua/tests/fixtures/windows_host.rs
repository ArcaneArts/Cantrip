use super::{Process, binding};
use cantrip_cua::{error::ErrorCode, protocol::Outcome};
use serde_json::{Value, json};
use std::{process::Command, ptr::null_mut, sync::mpsc, time::Duration};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::Gdi::{
        BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, HDC, PAINTSTRUCT,
        UpdateWindow,
    },
    System::LibraryLoader::GetModuleHandleW,
    UI::{
        HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext},
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_PACKET},
        WindowsAndMessaging::*,
    },
};

type Event = (usize, u32, WPARAM, LPARAM);

thread_local! {
    static EVENTS: std::cell::OnceCell<mpsc::Sender<Event>> = const { std::cell::OnceCell::new() };
}

#[test]
#[ignore = "requires a disposable interactive Windows desktop"]
fn selected_window_pixels_and_foreground_input_are_isolated() {
    let (events, received) = mpsc::channel();
    let (windows, handles) = mpsc::sync_channel(1);
    let desktop = std::thread::spawn(move || unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        EVENTS.with(|cell| cell.set(events).unwrap());
        let name = wide("CantripRustWin32QaFixture");
        let module = GetModuleHandleW(std::ptr::null());
        let class = WNDCLASSW {
            lpfnWndProc: Some(fixture_window),
            hInstance: module,
            lpszClassName: name.as_ptr(),
            ..Default::default()
        };
        assert_ne!(RegisterClassW(&class), 0);
        let create = |title: &str, x, y| {
            let handle = CreateWindowExW(
                0,
                name.as_ptr(),
                wide(title).as_ptr(),
                WS_POPUP,
                x,
                y,
                160,
                120,
                null_mut(),
                null_mut(),
                module,
                std::ptr::null(),
            );
            assert!(!handle.is_null());
            ShowWindow(handle, SW_SHOWNOACTIVATE);
            UpdateWindow(handle);
            handle
        };
        let first = create("cantrip-qa-blue", 20, 30);
        let second = create("cantrip-qa-red", 80, 55);
        assert_ne!(SetWindowLongPtrW(second, GWLP_USERDATA, 1), 1);
        assert_ne!(
            SetWindowPos(second, HWND_TOP, 80, 55, 160, 120, SWP_NOACTIVATE),
            0
        );
        assert_ne!(SetForegroundWindow(second), 0);
        windows.send((first as usize, second as usize)).unwrap();
        let mut message = MSG::default();
        while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    });
    let (first, second) = handles.recv_timeout(Duration::from_secs(8)).unwrap();
    assert_eq!(unsafe { GetForegroundWindow() }, second as HWND);
    let cursor = cursor_position();
    let binary = std::env::var_os("CANTRIP_CUA_WINDOWS_TEST_BINARY")
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_cantrip-cua").into());
    let mut command = Command::new(binary);
    command.env("PATH", "");
    let mut child = Process::spawn(command);
    let (caps, _) = child.call(json!({"operation":"capabilities.get"}));
    assert_eq!(caps["backend"], "windows-win32");
    assert_eq!(caps["capture"], true);
    assert_eq!(caps["nativeInput"], true);
    let (inventory, _) = child.call(json!({"operation":"targets.list"}));
    let targets = inventory["targets"].as_array().unwrap();
    assert!(targets.iter().any(|target| target["kind"] == "monitor"));
    let find = |handle: usize| {
        let id = format!("windows-window-{}", handle as u32);
        targets.iter().find(|target| target["id"] == id).unwrap()
    };
    let selected = find(first);
    assert_eq!(selected["title"], "cantrip-qa-blue");
    assert_eq!(find(second)["title"], "cantrip-qa-red");

    let scope = json!({"workerId":"worker","surfaceId":"desktop","attachmentId":"view","participantId":"viewer"});
    let open = |operation: &str, target: &Value| json!({"operation":operation,"request":{"type":"open","binding":scope,"targetId":target["id"],"targetGeneration":target["generation"]}});
    let (lease, _) = child.call(open("capture.request", selected));
    let frame = json!({"operation":"capture.request","request":{"type":"frame","binding":scope,"handle":lease["handle"]}});
    let (_, pixels) = child.call(frame.clone());
    let mut decoder = png::Decoder::new(std::io::Cursor::new(pixels))
        .read_info()
        .unwrap();
    let mut raster = vec![0; decoder.output_buffer_size().unwrap()];
    let dimensions = decoder.next_frame(&mut raster).unwrap();
    assert_eq!((dimensions.width, dimensions.height), (160, 120));
    let overlap = (70 * 160 + 90) * 4;
    assert_eq!(&raster[overlap..overlap + 4], &[0, 0, 255, 255]);

    let agent = binding();
    child.call(json!({"operation":"target.attach","binding":agent,"targetId":selected["id"],"targetGeneration":selected["generation"]}));
    child.call(json!({"operation":"input.click","binding":agent,"targetId":selected["id"],"targetGeneration":selected["generation"],"position":{"x":90,"y":70}}));
    for message in [WM_LBUTTONDOWN, WM_LBUTTONUP] {
        assert_eq!(
            received.recv_timeout(Duration::from_secs(4)).unwrap(),
            (
                first,
                message,
                if message == WM_LBUTTONDOWN { 1 } else { 0 },
                90 | (70 << 16)
            )
        );
    }
    child.call(json!({"operation":"session.close","binding":agent}));
    assert_eq!(unsafe { GetForegroundWindow() }, second as HWND);
    assert_eq!(cursor_position(), cursor);

    assert_ne!(unsafe { AllowSetForegroundWindow(child.child.id()) }, 0);
    let (participant, _) = child.call(open("interaction.request", selected));
    assert_eq!(unsafe { GetForegroundWindow() }, second as HWND);
    let send = |child: &mut Process, sequence, event| {
        child.call(json!({"operation":"interaction.request","request":{"type":"input","binding":scope,"handle":participant["handle"],"sequence":sequence,"event":event}}));
    };
    send(
        &mut child,
        1,
        json!({"type":"pointerMove","data":{"point":{"x":90,"y":70},"modifiers":[]}}),
    );
    assert_eq!(unsafe { GetForegroundWindow() }, second as HWND);
    assert_eq!(cursor_position(), cursor);
    send(
        &mut child,
        2,
        json!({"type":"pointerDown","data":{"point":{"x":90,"y":70},"button":"left","modifiers":[]}}),
    );
    send(
        &mut child,
        3,
        json!({"type":"keyDown","data":{"key":"a","modifiers":[],"repeat":false}}),
    );
    send(
        &mut child,
        4,
        json!({"type":"text","data":{"type":"commit","data":"λ"}}),
    );
    child.call(json!({"operation":"interaction.request","request":{"type":"close","binding":scope,"handle":participant["handle"]}}));

    let mut delivered = Vec::new();
    for _ in 0..7 {
        let (hwnd, kind, word, long) = received.recv_timeout(Duration::from_secs(4)).unwrap();
        assert_eq!(hwnd, first);
        match kind {
            WM_LBUTTONDOWN | WM_LBUTTONUP => assert_eq!(long, 90 | (70 << 16)),
            WM_KEYDOWN | WM_KEYUP => {
                assert!(word == usize::from(b'A') || word == usize::from(VK_PACKET));
            }
            WM_CHAR => assert_eq!(word, 'λ' as usize),
            _ => unreachable!(),
        }
        if word != usize::from(VK_PACKET) {
            delivered.push(kind);
            if delivered.len() == 5 {
                break;
            }
        }
    }
    delivered.sort_unstable();
    assert_eq!(
        delivered,
        [WM_KEYDOWN, WM_KEYUP, WM_CHAR, WM_LBUTTONDOWN, WM_LBUTTONUP]
    );
    assert_eq!(unsafe { GetForegroundWindow() }, first as HWND);
    assert_eq!(cursor_position(), (110, 100));

    assert_ne!(
        unsafe {
            SetWindowPos(
                second as HWND,
                HWND_TOPMOST,
                80,
                55,
                160,
                120,
                SWP_NOACTIVATE,
            )
        },
        0
    );
    let (participant, _) = child.call(open("interaction.request", selected));
    let denied = child.send(json!({"operation":"interaction.request","request":{
        "type":"input","binding":scope,"handle":participant["handle"],"sequence":1,
        "event":{"type":"pointerDown","data":{"point":{"x":100,"y":80},"button":"left","modifiers":[]}}
    }}));
    assert!(
        matches!(child.response(denied).0, Outcome::Error { error } if error.code == ErrorCode::PermissionDenied)
    );
    assert_eq!(cursor_position(), (110, 100));
    assert!(unsafe { GetAsyncKeyState(i32::from(VK_LBUTTON)) } >= 0);

    unsafe { SendMessageW(first as HWND, WM_CLOSE, 0, 0) };
    let id = child.send(frame);
    assert!(
        matches!(child.response(id).0, Outcome::Error { error } if matches!(error.code, ErrorCode::StaleTarget | ErrorCode::TargetNotFound))
    );
    child.stop(true);
    unsafe { PostMessageW(second as HWND, WM_APP, 0, 0) };
    desktop.join().unwrap();
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

fn cursor_position() -> (i32, i32) {
    let mut cursor = POINT::default();
    assert_ne!(unsafe { GetCursorPos(&mut cursor) }, 0);
    (cursor.x, cursor.y)
}

unsafe extern "system" fn fixture_window(
    hwnd: HWND,
    kind: u32,
    word: WPARAM,
    long: LPARAM,
) -> LRESULT {
    unsafe {
        let fill = |dc: HDC| {
            let mut bounds = RECT::default();
            GetClientRect(hwnd, &mut bounds);
            let color = if GetWindowLongPtrW(hwnd, GWLP_USERDATA) == 0 {
                0xff_00_00
            } else {
                0x00_00_ff
            };
            let brush = CreateSolidBrush(color);
            FillRect(dc, &bounds, brush);
            DeleteObject(brush);
        };
        match kind {
            WM_PRINT | WM_PRINTCLIENT => fill(word as HDC),
            WM_PAINT => {
                let mut paint = PAINTSTRUCT::default();
                let dc = BeginPaint(hwnd, &mut paint);
                fill(dc);
                EndPaint(hwnd, &paint);
            }
            WM_LBUTTONDOWN | WM_LBUTTONUP | WM_KEYDOWN | WM_KEYUP | WM_CHAR
                if kind != WM_CHAR || word == 'λ' as usize =>
            {
                EVENTS.with(|events| {
                    if let Some(events) = events.get() {
                        let _ = events.send((hwnd as usize, kind, word, long));
                    }
                });
            }
            WM_APP => {
                DestroyWindow(hwnd);
                PostQuitMessage(0);
            }
            _ => return DefWindowProcW(hwnd, kind, word, long),
        }
        0
    }
}
