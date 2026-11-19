use cantrip_wire::{JsString, Value, value::json};
use std::collections::{HashMap, VecDeque};
use zeroize::Zeroizing;

const SCROLLBACK: usize = 256 * 1024;

#[derive(Default)]
pub(super) struct Output {
    buffer: VecDeque<u16>,
    redactor: Redactor,
}

impl Output {
    pub fn replace_secrets<'a>(&mut self, values: impl IntoIterator<Item = &'a str>) {
        self.flush();
        let redactor = Redactor::new(values);
        let buffer = self.buffer.make_contiguous();
        self.buffer = redactor.transform(buffer, true).0.into();
        self.redactor = redactor;
    }

    pub fn append(&mut self, text: &str) {
        let mut units = std::mem::take(&mut self.redactor.pending);
        units.extend(text.encode_utf16());
        let (output, remaining) = self.redactor.transform(&units, false);
        self.redactor.pending.extend_from_slice(&units[remaining..]);
        self.retain(output);
    }

    pub fn flush(&mut self) {
        let pending = std::mem::take(&mut self.redactor.pending);
        let (output, _) = self.redactor.transform(&pending, true);
        self.retain(output);
    }

    fn retain(&mut self, output: Vec<u16>) {
        self.buffer.extend(output);
        let excess = self.buffer.len().saturating_sub(SCROLLBACK);
        self.buffer.drain(..excess);
    }

    pub fn tail(&self, tail: usize) -> Value {
        let skip = self.buffer.len().saturating_sub(tail);
        let data = JsString::new(self.buffer.iter().skip(skip).copied().collect());
        json!({"data":data,"truncated":skip != 0})
    }
}

#[derive(Default)]
struct Redactor {
    secrets: HashMap<u16, Vec<Zeroizing<Vec<u16>>>>,
    pending: Zeroizing<Vec<u16>>,
    marker: Vec<u16>,
}

impl Redactor {
    fn new<'a>(values: impl IntoIterator<Item = &'a str>) -> Self {
        let mut secrets: HashMap<u16, Vec<Zeroizing<Vec<u16>>>> = HashMap::new();
        let mut marker: Vec<u16> = "••••".encode_utf16().collect();
        for value in values.into_iter().filter(|value| !value.is_empty()) {
            if value.contains('•') {
                marker.clear();
            }
            let secret = Zeroizing::new(value.encode_utf16().collect::<Vec<_>>());
            let list = secrets.entry(secret[0]).or_default();
            if !list.contains(&secret) {
                list.push(secret);
            }
        }
        for list in secrets.values_mut() {
            list.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
        }
        Self {
            secrets,
            marker,
            pending: Default::default(),
        }
    }

    fn transform(&self, data: &[u16], final_chunk: bool) -> (Vec<u16>, usize) {
        let mut output = Vec::new();
        let mut index = 0;
        while let Some(&first) = data.get(index) {
            if let Some(candidates) = self.secrets.get(&first) {
                let remainder = &data[index..];
                if let Some(complete) = candidates
                    .iter()
                    .find(|secret| remainder.starts_with(secret))
                {
                    output.extend_from_slice(&self.marker);
                    index += complete.len();
                    continue;
                }
                if !final_chunk
                    && candidates
                        .iter()
                        .any(|secret| secret.starts_with(remainder))
                {
                    break;
                }
            }
            output.push(first);
            index += 1;
        }
        (output, index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_secrets_across_output_chunks_and_when_replacing_keys() {
        let mut output = Output::default();
        output.replace_secrets(["secrét", "existing"]);
        output.append("ready: se");
        assert_eq!(output.tail(100)["data"], "ready: ");
        output.append("crét then old");
        output.replace_secrets(["old"]);
        assert_eq!(output.tail(100)["data"], "ready: •••• then ••••");
    }
}
