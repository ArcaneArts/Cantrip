use cantrip_wire::JsString;
use codex_utils_pty::TerminalSize;

const CHAR_LIMIT: usize = 2_000_000;
const SCROLLBACK_ROWS: usize = 10_000;

pub(super) struct Replay {
    raw: Vec<u16>,
    truncated: bool,
    resized: bool,
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
            parser: vt100::Parser::new(size.rows, size.cols, SCROLLBACK_ROWS),
        }
    }

    pub fn write(&mut self, text: &str) {
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

    pub fn attachment(&self) -> JsString {
        let screen = self.parser.screen();
        // With the original dimensions and the complete stream the client can
        // reconstruct both buffers, including private modes the grid does not expose.
        if !self.resized && !self.truncated {
            return JsString::new(self.raw.clone());
        }
        let mut bytes = Vec::new();
        if screen.alternate_screen() {
            bytes.extend_from_slice(b"\x1b[?1049h");
        } else {
            let mut history = screen.clone();
            history.set_scrollback(SCROLLBACK_ROWS);
            let (_, cols) = screen.size();
            let mut lines = Vec::new();
            let mut length = 0;
            for offset in 1..=history.scrollback() {
                history.set_scrollback(offset);
                let Some(row) = history.rows_formatted(0, cols).next() else {
                    break;
                };
                length += row.len() + 6;
                // Leave at least half the budget for the current grid and modes.
                if length > CHAR_LIMIT / 2 {
                    break;
                }
                lines.push(row);
            }
            for row in lines.into_iter().rev() {
                bytes.extend_from_slice(b"\x1b[0m");
                bytes.extend(row);
                bytes.extend_from_slice(b"\r\n");
            }
        }
        let viewport = screen.state_formatted();
        if bytes.len() + viewport.len() > CHAR_LIMIT {
            bytes.clear();
            if screen.alternate_screen() {
                bytes.extend_from_slice(b"\x1b[?1049h");
            }
        }
        if viewport.len() > CHAR_LIMIT {
            return JsString::new(self.raw.clone());
        }
        bytes.extend(viewport);
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
}
