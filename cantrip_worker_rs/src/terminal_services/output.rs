//! Incremental decoding at the PTY byte boundary; UTF-16 limits remain identical
//! to the Node buffer even when a multibyte character crosses native reads.
#[derive(Default)]
pub(super) struct Utf8 {
    pending: Vec<u8>,
}
impl Utf8 {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        let mut start = 0;
        loop {
            match std::str::from_utf8(&self.pending[start..]) {
                Ok(text) => {
                    output.push_str(text);
                    start = self.pending.len();
                    break;
                }
                Err(error) => {
                    let end = start + error.valid_up_to();
                    output.push_str(std::str::from_utf8(&self.pending[start..end]).unwrap());
                    match error.error_len() {
                        Some(count) => {
                            output.push('\u{fffd}');
                            start = end + count;
                        }
                        None => {
                            start = end;
                            break;
                        }
                    }
                }
            }
        }
        self.pending.drain(..start);
        output
    }
    pub fn finish(&mut self) -> String {
        let output = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        output
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_characters_survive_read_boundaries_and_invalid_tail_finishes() {
        let mut decoder = Utf8::default();
        assert_eq!(decoder.push(&[0xf0, 0x9f]), "");
        assert_eq!(decoder.push(&[0x98, 0x80, 0xff, 0xe2]), "😀�");
        assert_eq!(decoder.finish(), "�");
    }
}
