//! Reference SQL diagnostics attached only after an actual query failure.
use crate::wire::{JsString, Value, coercion};
use anyhow::Result;

#[derive(Debug)]
pub(crate) struct QueryError {
    pub message: JsString,
    source: anyhow::Error,
}
impl std::fmt::Display for QueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message.lossy())
    }
}
impl std::error::Error for QueryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}
pub(crate) fn context<T>(result: Result<T>, query: &str, params: &[Value]) -> Result<T> {
    result.map_err(|source| {
        let mut units = format!("Failed query: {query}\nparams: ")
            .encode_utf16()
            .collect::<Vec<_>>();
        for (index, value) in params.iter().enumerate() {
            if index > 0 {
                units.push(u16::from(b','));
            }
            if !value.is_null() {
                units.extend_from_slice(
                    coercion::string(value)
                        .expect("scalar query parameter")
                        .units(),
                );
            }
        }
        QueryError {
            message: JsString::new(units),
            source,
        }
        .into()
    })
}
