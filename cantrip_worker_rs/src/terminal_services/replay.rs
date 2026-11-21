use cantrip_wire::{JsString, Value, value::json};
use codex_utils_pty::TerminalSize;

const CHAR_LIMIT: usize = 2_000_000;
const SCROLLBACK_ROWS: usize = 10_000;

pub(super) struct Replay {
    raw: Vec<u16>,
    truncated: bool,
    resized: bool,
    process_generation: u64,
    output_boundary: u64,
    parser: vt100::Parser,
}

pub(super) struct Snapshot {
    pub(super) data: JsString,
    pub(super) metadata: Option<Value>,
    pub(super) needs_redraw: bool,
}

impl Replay {
    pub fn size(&self) -> TerminalSize {
        let (rows, cols) = self.parser.screen().size();
        TerminalSize { rows, cols }
    }

    pub fn raw(&self) -> (JsString, bool) {
        (JsString::new(self.raw.clone()), self.truncated)
    }

    pub fn output_boundary(&self) -> u64 {
        self.output_boundary
    }

    pub fn new(size: TerminalSize, process_generation: u64) -> Self {
        Self {
            raw: Vec::new(),
            truncated: false,
            resized: false,
            process_generation,
            output_boundary: 0,
            parser: vt100::Parser::new(size.rows, size.cols, SCROLLBACK_ROWS),
        }
    }

    pub fn write(&mut self, text: &str) {
        self.output_boundary += 1;
        self.parser.process(text.as_bytes());
        self.raw.extend(text.encode_utf16());
        if self.raw.len() > CHAR_LIMIT {
            self.truncated = true;
            self.raw.drain(..self.raw.len() - CHAR_LIMIT);
        }
    }

    pub fn resize(&mut self, size: TerminalSize) {
        let current = self.parser.screen().size();
        if current != (size.rows, size.cols) {
            self.resized = true;
            self.parser.screen_mut().set_size(size.rows, size.cols);
        }
    }

    pub fn tail(&self, max: usize) -> (JsString, bool) {
        let offset = self.raw.len().saturating_sub(max);
        (JsString::new(self.raw[offset..].to_vec()), offset != 0)
    }

    fn hydration(&self, scrollback_rows: Option<usize>) -> Value {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let mut metadata = json!({
            "version": 1,
            "generation": self.process_generation,
            "rows": rows,
            "cols": cols,
            "outputBoundary": self.output_boundary,
        });
        if self.process_generation > 0 {
            metadata["processGeneration"] = json!(self.process_generation);
        }
        if let Some(history_rows) = scrollback_rows {
            use vt100::MouseProtocolMode::{AnyMotion, ButtonMotion, None, Press, PressRelease};
            let (y, x) = screen.cursor_position();
            metadata["format"] = json!("canonical-xterm");
            metadata["activeBuffer"] = json!(if screen.alternate_screen() {
                "alternate"
            } else {
                "normal"
            });
            metadata["cursor"] = json!({"x": x, "y": y});
            metadata["scrollbackRows"] = json!(history_rows);
            metadata["modes"] = json!({
                "applicationCursorKeysMode": screen.application_cursor(),
                "applicationKeypadMode": screen.application_keypad(),
                "bracketedPasteMode": screen.bracketed_paste(),
                "insertMode": screen.insert_mode(),
                "mouseTrackingMode": match screen.mouse_protocol_mode() {
                    None => "none",
                    Press => "x10",
                    PressRelease => "vt200",
                    ButtonMotion => "drag",
                    AnyMotion => "any",
                },
                "originMode": screen.origin_mode(),
                "reverseWraparoundMode": screen.reverse_wraparound(),
                "sendFocusMode": screen.focus_reporting(),
                "synchronizedOutputMode": screen.synchronized_output(),
                "wraparoundMode": screen.wraparound(),
            });
        } else {
            metadata["format"] = json!("legacy-raw");
            metadata["truncated"] = json!(self.truncated);
        }
        metadata
    }

    pub fn attachment(&self, with_metadata: bool) -> Snapshot {
        if with_metadata || self.resized || self.truncated {
            if let Some((snapshot, history_rows)) = self.formatted(!with_metadata) {
                let metadata = with_metadata.then(|| self.hydration(Some(history_rows)));
                return Snapshot {
                    data: snapshot,
                    metadata,
                    needs_redraw: false,
                };
            }
        }
        Snapshot {
            data: JsString::new(self.raw.clone()),
            metadata: with_metadata.then(|| self.hydration(None)),
            needs_redraw: self.truncated,
        }
    }

    fn formatted(&self, allow_partial: bool) -> Option<(JsString, usize)> {
        let screen = self.parser.screen();
        // A retained viewer can still have modes from the previous attachment.
        // Draw with absolute positions and ordinary overwrite and wrap first.
        let mut bytes =
            b"\x1b[?1049l\x0f\x1b(B\x1b)B\x1b*B\x1b+B\x1b[4l\x1b[?6l\x1b[?7h\x1b[?45;1004;9;1000;1002;1003;1005;1006l\x1b[r"
                .to_vec();
        let mut tail = if screen.alternate_screen() {
            screen.alternate_attachment_formatted()
        } else {
            screen.input_mode_formatted()
        };
        tail.extend(screen.character_sets_formatted());
        let limit = CHAR_LIMIT.checked_sub(bytes.len() + tail.len())?;
        let history_rows = if let Some((contents, rows)) =
            screen.normal_contents_formatted_with_scrollback(limit)
        {
            bytes.extend(contents);
            rows
        } else if allow_partial && screen.alternate_screen() {
            // The legacy relay can still replay the active viewport alone.
            0
        } else {
            return None;
        };
        bytes.extend(tail);
        Some((
            JsString::from(String::from_utf8_lossy(&bytes).as_ref()),
            history_rows,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_replays_screen_state_at_new_dimensions_and_retains_plain_tail() {
        let initial = TerminalSize { rows: 4, cols: 10 };
        let mut replay = Replay::new(initial, 1);
        replay.write("first\r\n\x1b[31mproof\x1b[0m\x1b[?2004h");
        let resized = TerminalSize { rows: 5, cols: 12 };
        replay.resize(resized);
        let mut client = vt100::Parser::new(resized.rows, resized.cols, 0);
        client.process(replay.attachment(true).data.as_str().unwrap().as_bytes());
        assert_eq!(client.screen().contents(), "first\nproof");
        assert!(client.screen().bracketed_paste());
        assert_eq!(client.screen().cursor_position(), (1, 5));
        assert_eq!(
            client.screen().cell(1, 0).unwrap().fgcolor(),
            vt100::Color::Idx(1)
        );
        assert_eq!(
            replay.tail(40).0.as_str(),
            Some("first\r\n\x1b[31mproof\x1b[0m\x1b[?2004h")
        );
    }

    #[test]
    fn truncated_alternate_replay_preserves_the_normal_screen_and_scrollback() {
        let size = TerminalSize { rows: 4, cols: 12 };
        let mut replay = Replay::new(size, 1);
        replay.write(
            "past-1\r\npast-2\r\nnormal-1\r\nnormal-2\r\nnormal-3\r\nnormal-4\x1b[2;5H\x1b[?1049h\x1b[Halternate\x1b[?2004h",
        );
        replay.truncated = true;
        let mut client = vt100::Parser::new(size.rows, size.cols, SCROLLBACK_ROWS);
        let snapshot = replay.attachment(true);
        client.process(snapshot.data.as_str().unwrap().as_bytes());
        let metadata = snapshot.metadata.unwrap();
        assert_eq!(metadata["format"], "canonical-xterm");
        assert_eq!(metadata["activeBuffer"], "alternate");
        assert_eq!(metadata["scrollbackRows"], json!(2));
        assert!(client.screen().alternate_screen());
        assert_eq!(client.screen().contents(), "alternate");
        assert!(client.screen().bracketed_paste());

        client.process(b"\x1b[?1049l");
        assert!(!client.screen().alternate_screen());
        assert_eq!(client.screen().cursor_position(), (1, 4));
        assert_eq!(
            client.screen().contents(),
            "normal-1\nnormal-2\nnormal-3\nnormal-4"
        );
        client.screen_mut().set_scrollback(SCROLLBACK_ROWS);
        assert_eq!(client.screen().scrollback(), 2);
        assert!(client.screen().contents().starts_with("past-1\npast-2\n"));
    }
}
