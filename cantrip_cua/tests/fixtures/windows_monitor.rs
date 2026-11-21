use super::{Duration, Outcome, Process, Value, json};
use cantrip_cua::error::ErrorCode;
use std::{
    mem::size_of,
    ptr::{null, null_mut},
    sync::mpsc,
    thread::{self, JoinHandle},
    time::Instant,
};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    System::LibraryLoader::GetModuleHandleW,
    UI::{
        HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext},
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON, VK_SHIFT},
        WindowsAndMessaging::*,
    },
};

const LABEL: &str = "Cantrip Windows monitor fixture";
const SELECTION: &str = "selected λ🚋";

struct Fixture {
    window: usize,
    editor: usize,
    thread: Option<JoinHandle<()>>,
}

impl Fixture {
    fn start(x: i32, y: i32) -> Self {
        let (send, receive) = mpsc::channel();
        let thread = thread::spawn(move || unsafe {
            SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let instance = GetModuleHandleW(null());
            let name = wide("CantripMonitorFixture");
            let class = WNDCLASSW {
                hInstance: instance,
                lpszClassName: name.as_ptr(),
                lpfnWndProc: Some(window_proc),
                ..Default::default()
            };
            assert_ne!(RegisterClassW(&class), 0);
            let window = CreateWindowExW(
                0,
                name.as_ptr(),
                wide(LABEL).as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                x,
                y,
                350,
                240,
                null_mut(),
                null_mut(),
                instance,
                null(),
            );
            assert!(!window.is_null());
            let editor = CreateWindowExW(
                0,
                wide("EDIT").as_ptr(),
                wide(SELECTION).as_ptr(),
                WS_CHILD | WS_VISIBLE | WS_BORDER | ES_AUTOHSCROLL as u32,
                20,
                20,
                230,
                36,
                window,
                null_mut(),
                instance,
                null(),
            );
            assert!(!editor.is_null());
            send.send((window as usize, editor as usize)).unwrap();
            let mut message = MSG::default();
            while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        });
        let (window, editor) = receive.recv_timeout(Duration::from_secs(10)).unwrap();
        Self {
            window,
            editor,
            thread: Some(thread),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if unsafe { PostMessageW(self.window as HWND, WM_CLOSE, 0, 0) } != 0 {
            let _ = self.thread.take().unwrap().join();
        }
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    if message == WM_DESTROY {
        unsafe { PostQuitMessage(0) };
        return 0;
    }
    unsafe { DefWindowProcW(hwnd, message, w, l) }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain([0]).collect()
}

fn until(mut observe: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !observe() {
        assert!(Instant::now() < deadline, "Windows input was not observed.");
        thread::sleep(Duration::from_millis(10));
    }
}

fn held(key: u16) -> bool {
    unsafe { GetAsyncKeyState(i32::from(key)) < 0 }
}

#[test]
#[ignore = "requires a disposable interactive Windows desktop"]
fn full_display_routes_input_copies_text_and_releases_control() {
    unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let helper = std::env::var_os("CANTRIP_CUA_TEST_HELPER")
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_cantrip-cua").into());
    let mut command = std::process::Command::new(helper);
    command.env("PATH", "");
    let mut child = Process::spawn(command);
    let (capabilities, _) = child.call(json!({"operation":"capabilities.get"}));
    assert_eq!(capabilities["backend"], "windows-win32");
    assert_eq!(capabilities["hostMonitorInput"], true);
    let (inventory, _) = child.call(json!({"operation":"targets.list"}));
    let monitor = inventory["targets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|target| {
            target["id"]
                .as_str()
                .is_some_and(|id| id.starts_with("windows-display-primary-"))
        })
        .unwrap();
    let origin_x = monitor["bounds"]["x"].as_f64().unwrap() as i32;
    let origin_y = monitor["bounds"]["y"].as_f64().unwrap() as i32;
    let fixture = Fixture::start(origin_x + 50, origin_y + 50);
    let mut editor = RECT::default();
    assert_ne!(
        unsafe { GetWindowRect(fixture.editor as HWND, &mut editor) },
        0
    );
    let x = editor.left + 30;
    let y = editor.top + 12;
    let point = json!({"x":x - origin_x,"y":y - origin_y});

    let binding = |viewer| json!({"workerId":"w","surfaceId":"display","attachmentId":viewer,"participantId":viewer});
    let owner = binding("owner");
    let waiting = binding("waiting");
    let operation = |request| json!({"operation":"interaction.request","request":request});
    let open = |binding: &Value| {
        operation(
            json!({"type":"open","binding":binding,"targetId":monitor["id"],"targetGeneration":monitor["generation"]}),
        )
    };
    let active = child.call(open(&owner)).0["handle"].clone();
    let request = child.send(open(&waiting));
    assert!(
        matches!(child.response(request).0, Outcome::Error { error } if error.code == ErrorCode::OwnershipMismatch)
    );
    let input = |binding: &Value, handle: &Value, sequence, event| {
        operation(
            json!({"type":"input","binding":binding,"handle":handle,"sequence":sequence,"event":event}),
        )
    };
    let pointer = |kind| {
        json!({"type":kind,"data": if kind == "pointerDown" {
            json!({"point":point,"button":"left","modifiers":[]})
        } else {
            json!({"point":point,"button":"left"})
        }})
    };
    child.call(input(&owner, &active, 1, pointer("pointerDown")));
    child.call(input(&owner, &active, 2, pointer("pointerUp")));
    until(|| unsafe { GetForegroundWindow() == fixture.window as HWND });
    let mut cursor = POINT::default();
    assert_ne!(unsafe { GetCursorPos(&mut cursor) }, 0);
    assert_eq!((cursor.x, cursor.y), (x, y));
    const EM_SETSEL: u32 = 0x00b1;
    unsafe { SendMessageW(fixture.editor as HWND, EM_SETSEL, 0, -1) };
    let (copy, _) = child.call(operation(json!({
        "type":"clipboardCopy","binding":owner,"handle":active,"sequence":4
    })));
    assert_eq!(copy["text"], SELECTION);
    child.call(input(
        &owner,
        &active,
        5,
        json!({
            "type":"keyDown","data":{"key":"Shift","modifiers":[],"repeat":false}
        }),
    ));
    child.call(input(&owner, &active, 6, pointer("pointerDown")));
    let button = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } == 0 {
        VK_LBUTTON
    } else {
        VK_RBUTTON
    };
    until(|| held(VK_SHIFT) && held(button));
    child.call(operation(json!({"type":"closeBinding","binding":owner})));
    until(|| !held(VK_SHIFT) && !held(button));
    let second = child.call(open(&waiting)).0["handle"].clone();
    unsafe { SendMessageW(fixture.editor as HWND, EM_SETSEL, 0, -1) };
    child.call(input(
        &waiting,
        &second,
        1,
        json!({
            "type":"text","data":{"type":"commit","data":"typed 🌙"}
        }),
    ));
    until(|| {
        let mut text = [0u16; 64];
        let written = unsafe {
            GetWindowTextW(
                fixture.editor as HWND,
                text.as_mut_ptr(),
                (size_of::<[u16; 64]>() / 2) as i32,
            )
        };
        String::from_utf16_lossy(&text[..written as usize]) == "typed 🌙"
    });
    child.stop(true);
}
