use cantrip_wire::{JsString, Value, value::json};
use codex_utils_pty::TerminalSize;

const CHAR_LIMIT: usize = 2_000_000;
const SCROLLBACK_ROWS: usize = 10_000;

pub(super) struct Replay {
    raw: Vec<u16>,
    truncated: bool,
    resized: bool,
    generation: u64,
    parser: vt100::Parser,
}

impl Replay {
    pub fn raw(&self) -> (JsString, bool) {
        (JsString::new(self.raw.clone()), self.truncated)
    }

    pub fn new(size: TerminalSize) -> Self {
        Self {
            raw: Vec::new(),
            truncated: false,
            resized: false,
            generation: 0,
            parser: vt100::Parser::new(size.rows, size.cols, SCROLLBACK_ROWS),
        }
    }

    pub fn write(&mut self, text: &str) {
        self.generation += 1;
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
            self.generation += 1;
            self.parser.screen_mut().set_size(size.rows, size.cols);
        }
    }

    pub fn tail(&self, max: usize) -> (JsString, bool) {
        let offset = self.raw.len().saturating_sub(max);
        (JsString::new(self.raw[offset..].to_vec()), offset != 0)
    }

    pub fn hydration(&self, snapshot: &JsString, chunks: usize) -> Value {
        let (rows, cols) = self.parser.screen().size();
        json!({
            "format":"legacy-raw", "version":1, "generation":self.generation,
            "rows":rows,"cols":cols,"truncated":self.truncated,
            "snapshotCharacters":snapshot.len(),"snapshotChunks":chunks,
        })
    }

    pub fn attachment(&self) -> JsString {
        let screen = self.parser.screen();
        // With the original dimensions and the complete stream the client can
        // reconstruct both buffers, including private modes the grid does not expose.
        if !self.resized && !self.truncated {
            return JsString::new(self.raw.clone());
        }
        // A retained viewer can still have modes from the previous attachment.
        // Draw with absolute positions and ordinary overwrite and wrap first.
        let mut bytes =
            b"\x1b[?1049l\x1b[4l\x1b[?6l\x1b[?7h\x1b[?45;1004;9;1000;1002;1003;1005;1006l\x1b[r"
                .to_vec();
        let tail = if screen.alternate_screen() {
            let mut alternate = b"\x1b[?1049h".to_vec();
            alternate.extend(screen.state_formatted());
            alternate
        } else {
            screen.input_mode_formatted()
        };
        let Some(limit) = CHAR_LIMIT.checked_sub(bytes.len() + tail.len()) else {
            return JsString::new(self.raw.clone());
        };
        if let Some(contents) = screen.normal_contents_formatted_with_scrollback(limit) {
            bytes.extend(contents);
        } else if !screen.alternate_screen() {
            return JsString::new(self.raw.clone());
        }
        // Keep the active alternate viewport if both screens cannot fit.
        bytes.extend(tail);
        JsString::from(String::from_utf8_lossy(&bytes).as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_replays_screen_state_at_new_dimensions_and_retains_plain_tail() {
        let initial = TerminalSize { rows: 4, cols: 10 };
        let mut replay = Replay::new(initial);
        replay.write("first\r\n\x1b[31mproof\x1b[0m\x1b[?2004h");
        let resized = TerminalSize { rows: 5, cols: 12 };
        replay.resize(resized);
        let mut client = vt100::Parser::new(resized.rows, resized.cols, 0);
        client.process(replay.attachment().as_str().unwrap().as_bytes());
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
        let mut replay = Replay::new(size);
        replay.write(
            "past-1\r\npast-2\r\nnormal-1\r\nnormal-2\r\nnormal-3\r\nnormal-4\x1b[2;5H\x1b[?1049h\x1b[Halternate\x1b[?2004h",
        );
        replay.truncated = true;
        let mut client = vt100::Parser::new(size.rows, size.cols, SCROLLBACK_ROWS);
        let snapshot = replay.attachment();
        client.process(snapshot.as_str().unwrap().as_bytes());
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
