//! Tree operations must remain stack-safe even when a schema strips or rejects
//! a deeply nested unknown field. The transport already supplies byte limits.
use super::{JsString, Value};
use std::{fmt, mem};

impl Value {
    /// JSON.stringify(value, null, 2), retaining original UTF-16 escapes and
    /// ECMAScript key order. Formatting never reparses through UTF-8 strings.
    pub fn stringify_pretty(&self) -> String {
        let compact = self.stringify();
        let mut output = String::new();
        let (mut quoted, mut escaped, mut depth) = (false, false, 0_usize);
        let mut chars = compact.chars().peekable();
        let mut previous = ' ';
        while let Some(ch) = chars.next() {
            if quoted {
                output.push(ch);
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    quoted = false;
                }
            } else {
                match ch {
                    '"' => {
                        quoted = true;
                        output.push(ch);
                    }
                    '{' | '[' => {
                        output.push(ch);
                        depth += 1;
                        if chars.peek().is_some_and(|next| !matches!(next, '}' | ']')) {
                            output.push('\n');
                            output.push_str(&"  ".repeat(depth));
                        }
                    }
                    '}' | ']' => {
                        depth -= 1;
                        if !matches!(previous, '{' | '[') {
                            output.push('\n');
                            output.push_str(&"  ".repeat(depth));
                        }
                        output.push(ch);
                    }
                    ',' => {
                        output.push_str(",\n");
                        output.push_str(&"  ".repeat(depth));
                    }
                    ':' => output.push_str(": "),
                    _ => output.push(ch),
                }
            }
            previous = ch;
        }
        output
    }
    pub fn stringify(&self) -> String {
        enum Part<'a> {
            Value(&'a Value),
            Key(&'a JsString),
            Text(&'static str),
        }
        let mut output = String::new();
        let mut stack = vec![Part::Value(self)];
        while let Some(part) = stack.pop() {
            match part {
                Part::Text(text) => output.push_str(text),
                Part::Key(key) => key.write_json(&mut output),
                Part::Value(value) => match value {
                    Self::Null => output.push_str("null"),
                    Self::Bool(v) => output.push_str(if *v { "true" } else { "false" }),
                    Self::Number(v) => {
                        if v.is_finite() {
                            output.push_str(ryu_js::Buffer::new().format_finite(*v));
                        } else {
                            output.push_str("null");
                        }
                    }
                    Self::String(v) => v.write_json(&mut output),
                    Self::Array(values) => {
                        output.push('[');
                        stack.push(Part::Text("]"));
                        for (i, value) in values.iter().enumerate().rev() {
                            stack.push(Part::Value(value));
                            if i > 0 {
                                stack.push(Part::Text(","));
                            }
                        }
                    }
                    Self::Object(object) => {
                        output.push('{');
                        stack.push(Part::Text("}"));
                        for (i, key) in crate::wire::coercion::keys(object)
                            .into_iter()
                            .enumerate()
                            .rev()
                        {
                            stack.push(Part::Value(&object[key]));
                            stack.push(Part::Text(":"));
                            stack.push(Part::Key(key));
                            if i > 0 {
                                stack.push(Part::Text(","));
                            }
                        }
                    }
                },
            }
        }
        output
    }

    fn drain_children(&mut self, pending: &mut Vec<Value>) {
        match self {
            Self::Array(values) => pending.append(values),
            Self::Object(values) => pending.extend(mem::take(values).into_values()),
            _ => {}
        }
    }
}

impl Drop for Value {
    fn drop(&mut self) {
        let mut pending = Vec::new();
        self.drain_children(&mut pending);
        while let Some(mut value) = pending.pop() {
            value.drain_children(&mut pending);
            // Its children are now empty, so this value's Drop cannot recurse.
        }
    }
}

impl Clone for Value {
    fn clone(&self) -> Self {
        enum Step<'a> {
            Visit(&'a Value),
            Array(usize),
            Object(Vec<JsString>),
        }
        let mut pending = vec![Step::Visit(self)];
        let mut values = Vec::new();
        while let Some(step) = pending.pop() {
            match step {
                Step::Visit(value) => match value {
                    Self::Null => values.push(Self::Null),
                    Self::Bool(v) => values.push(Self::Bool(*v)),
                    Self::Number(v) => values.push(Self::Number(*v)),
                    Self::String(v) => values.push(Self::String(v.clone())),
                    Self::Array(array) => {
                        pending.push(Step::Array(array.len()));
                        pending.extend(array.iter().rev().map(Step::Visit));
                    }
                    Self::Object(object) => {
                        pending.push(Step::Object(object.keys().cloned().collect()));
                        pending.extend(object.values().rev().map(Step::Visit));
                    }
                },
                Step::Array(len) => {
                    let children = values.split_off(values.len() - len);
                    values.push(Self::Array(children));
                }
                Step::Object(keys) => {
                    let children = values.split_off(values.len() - keys.len());
                    values.push(Self::Object(keys.into_iter().zip(children).collect()));
                }
            }
        }
        values.pop().expect("cloned root")
    }
}

impl PartialEq for Value {
    fn eq(&self, other: &Self) -> bool {
        let mut pending = vec![(self, other)];
        while let Some((left, right)) = pending.pop() {
            match (left, right) {
                (Self::Null, Self::Null) => {}
                (Self::Bool(a), Self::Bool(b)) if a == b => {}
                (Self::Number(a), Self::Number(b)) if a == b => {}
                (Self::String(a), Self::String(b)) if a == b => {}
                (Self::Array(a), Self::Array(b)) if a.len() == b.len() => {
                    pending.extend(a.iter().zip(b));
                }
                (Self::Object(a), Self::Object(b)) if a.len() == b.len() => {
                    for (key, value) in a {
                        let Some(other) = b.get(key) else {
                            return false;
                        };
                        pending.push((value, other));
                    }
                }
                _ => return false,
            }
        }
        true
    }
}

impl fmt::Debug for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.stringify())
    }
}
