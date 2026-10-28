//! JSON text diagnostics at Fetch response boundaries. Successful values use
//! the existing iterative parser; failures retain V8's UTF16 positions, line
//! accounting and bounded source context. Grammar validation is iterative too.
use super::{JsString, Value};

pub fn parse_json_text(raw: &str) -> Result<Value, JsString> {
    serde_json::from_str(raw).map_err(|_| {
        let source = JsString::from(raw);
        let mut parser = Syntax {
            source: source.units(),
            at: 0,
        };
        parser
            .check()
            .err()
            .unwrap_or_else(|| "Invalid JSON text".into())
    })
}
#[derive(Clone, Copy)]
enum State {
    Value,
    End,
    ObjectFirst,
    ObjectNext,
    Colon,
    ObjectAfter,
    ArrayFirst,
    ArrayNext,
    ArrayAfter,
}
struct Syntax<'a> {
    source: &'a [u16],
    at: usize,
}
impl Syntax<'_> {
    fn current(&self) -> Option<u16> {
        self.source.get(self.at).copied()
    }
    fn whitespace(&mut self) {
        while self
            .current()
            .is_some_and(|c| matches!(c, 9 | 10 | 13 | 32))
        {
            self.at += 1;
        }
    }
    fn positioned(&self, message: &str) -> JsString {
        let mut line = 1;
        let mut last = 0;
        let mut cursor = 0;
        while cursor < self.at {
            if self.source[cursor] == 13 && cursor + 1 < self.at && self.source[cursor + 1] == 10 {
                cursor += 1;
            }
            if matches!(self.source[cursor], 10 | 13) {
                line += 1;
                last = cursor + 1;
            }
            cursor += 1;
        }
        format!(
            "{message} at position {} (line {line} column {})",
            self.at,
            1 + self.at - last
        )
        .into()
    }
    fn unexpected(&self) -> JsString {
        let Some(current) = self.current() else {
            return "Unexpected end of JSON input".into();
        };
        if matches!(current, 45 | 48..=57) {
            return self.positioned("Unexpected number in JSON");
        }
        if current == 34 {
            return self.positioned("Unexpected string in JSON");
        }
        let special = ["[object Object]", "undefined", "Infinity", "NaN"]
            .iter()
            .any(|s| self.source.iter().copied().eq(s.encode_utf16()));
        let mut output = vec![];
        if special {
            output.push(34);
            output.extend(self.source);
            output.extend("\" is not valid JSON".encode_utf16());
            return JsString::new(output);
        }
        output.extend("Unexpected token '".encode_utf16());
        output.push(current);
        output.extend("', ".encode_utf16());
        let (start, end, leading, trailing) = if self.source.len() < 21 {
            (0, self.source.len(), false, false)
        } else if self.at < 10 {
            (0, self.at + 10, false, true)
        } else if self.at < self.source.len() - 10 {
            (self.at - 10, self.at + 10, true, true)
        } else {
            (self.at - 10, self.source.len(), true, false)
        };
        if leading {
            output.extend("...".encode_utf16());
        }
        output.push(34);
        output.extend(&self.source[start..end]);
        output.push(34);
        if trailing {
            output.extend("...".encode_utf16());
        }
        output.extend(" is not valid JSON".encode_utf16());
        JsString::new(output)
    }
    fn string(&mut self) -> Result<(), JsString> {
        self.at += 1;
        loop {
            match self.current() {
                None => return Err(self.positioned("Unterminated string in JSON")),
                Some(34) => {
                    self.at += 1;
                    return Ok(());
                }
                Some(0..=31) => {
                    return Err(self.positioned("Bad control character in string literal in JSON"));
                }
                Some(92) => {
                    self.at += 1;
                    match self.current() {
                        None | Some(256..=65535) => return Err(self.unexpected()),
                        Some(34 | 47 | 92 | 98 | 102 | 110 | 114 | 116) => self.at += 1,
                        Some(117) => {
                            for _ in 0..4 {
                                self.at += 1;
                                if !self
                                    .current()
                                    .is_some_and(|c| matches!(c,48..=57|65..=70|97..=102))
                                {
                                    return Err(self.positioned("Bad Unicode escape in JSON"));
                                }
                            }
                            self.at += 1;
                        }
                        _ => return Err(self.positioned("Bad escaped character in JSON")),
                    }
                }
                _ => self.at += 1,
            }
        }
    }
    fn number(&mut self) -> Result<(), JsString> {
        if self.current() == Some(45) {
            self.at += 1;
        }
        if self.current() == Some(48) {
            self.at += 1;
            if self.current().is_some_and(|c| matches!(c, 48..=57)) {
                return Err(self.positioned("Unexpected number in JSON"));
            }
        } else {
            let start = self.at;
            while self.current().is_some_and(|c| matches!(c, 48..=57)) {
                self.at += 1;
            }
            if start == self.at {
                return Err(self.positioned("No number after minus sign in JSON"));
            }
        }
        if self.current() == Some(46) {
            self.at += 1;
            let start = self.at;
            while self.current().is_some_and(|c| matches!(c, 48..=57)) {
                self.at += 1;
            }
            if start == self.at {
                return Err(self.positioned("Unterminated fractional number in JSON"));
            }
        }
        if matches!(self.current(), Some(69 | 101)) {
            self.at += 1;
            if matches!(self.current(), Some(43 | 45)) {
                self.at += 1;
            }
            let start = self.at;
            while self.current().is_some_and(|c| matches!(c, 48..=57)) {
                self.at += 1;
            }
            if start == self.at {
                return Err(self.positioned("Exponent part is missing a number in JSON"));
            }
        }
        Ok(())
    }
    fn value(&mut self, stack: &mut Vec<State>) -> Result<(), JsString> {
        match self.current() {
            Some(123) => {
                self.at += 1;
                stack.push(State::ObjectFirst);
            }
            Some(91) => {
                self.at += 1;
                stack.push(State::ArrayFirst);
            }
            Some(34) => self.string()?,
            Some(45 | 48..=57) => self.number()?,
            Some(116 | 102 | 110) => {
                let literal = match self.current() {
                    Some(116) => "true",
                    Some(102) => "false",
                    _ => "null",
                };
                for unit in literal.encode_utf16() {
                    if self.current() != Some(unit) {
                        return Err(self.unexpected());
                    }
                    self.at += 1;
                }
            }
            _ => return Err(self.unexpected()),
        }
        Ok(())
    }
    fn check(&mut self) -> Result<(), JsString> {
        let mut stack = vec![State::End, State::Value];
        while let Some(state) = stack.pop() {
            self.whitespace();
            match state {
                State::Value => self.value(&mut stack)?,
                State::End => {
                    if self.current().is_some() {
                        return Err(
                            self.positioned("Unexpected non-whitespace character after JSON")
                        );
                    }
                }
                State::ObjectFirst | State::ObjectNext => {
                    if matches!(state, State::ObjectFirst) && self.current() == Some(125) {
                        self.at += 1;
                        continue;
                    }
                    if self.current() != Some(34) {
                        return Err(self.positioned(if matches!(state, State::ObjectFirst) {
                            "Expected property name or '}' in JSON"
                        } else {
                            "Expected double-quoted property name in JSON"
                        }));
                    }
                    self.string()?;
                    stack.push(State::Colon);
                }
                State::Colon => {
                    if self.current() != Some(58) {
                        return Err(self.positioned("Expected ':' after property name in JSON"));
                    }
                    self.at += 1;
                    stack.push(State::ObjectAfter);
                    stack.push(State::Value);
                }
                State::ObjectAfter => match self.current() {
                    Some(125) => self.at += 1,
                    Some(44) => {
                        self.at += 1;
                        stack.push(State::ObjectNext);
                    }
                    _ => {
                        return Err(
                            self.positioned("Expected ',' or '}' after property value in JSON")
                        );
                    }
                },
                State::ArrayFirst | State::ArrayNext => {
                    if matches!(state, State::ArrayFirst) && self.current() == Some(93) {
                        self.at += 1;
                        continue;
                    }
                    stack.push(State::ArrayAfter);
                    self.value(&mut stack)?;
                }
                State::ArrayAfter => match self.current() {
                    Some(93) => self.at += 1,
                    Some(44) => {
                        self.at += 1;
                        stack.push(State::ArrayNext);
                    }
                    _ => {
                        return Err(
                            self.positioned("Expected ',' or ']' after array element in JSON")
                        );
                    }
                },
            }
        }
        Ok(())
    }
}
