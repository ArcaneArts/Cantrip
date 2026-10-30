use crate::wire::{JsString, Value};
use anyhow::{Result, anyhow};
use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use icu_locale_core::Locale;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

pub(super) fn collator() -> Result<&'static CollatorBorrowed<'static>> {
    static VALUE: OnceLock<Result<CollatorBorrowed<'static>, String>> = OnceLock::new();
    VALUE
        .get_or_init(|| {
            let locale = crate::environment::locale()
                .and_then(|value| value.parse::<Locale>().ok())
                .unwrap_or_else(|| "en-US".parse().unwrap());
            Collator::try_new(locale.into(), CollatorOptions::default())
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| anyhow!("Catalog sorting locale: {error}"))
}
pub(super) fn snapshot(model: &Value) -> Result<String> {
    static SENSITIVE: OnceLock<regress::Regex> = OnceLock::new();
    let sensitive=SENSITIVE.get_or_init(||regress::Regex::with_flags(r"^(?:api[-_]?key|authorization|cookie|set-cookie|password|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|credential|headers?)$","iu").expect("catalog metadata secret key pattern"));
    let collator = collator()?;
    enum Work<'a> {
        Visit(&'a Value),
        Array(usize),
        Object(Vec<JsString>),
    }
    let mut pending = vec![Work::Visit(model)];
    let mut values = vec![];
    while let Some(work) = pending.pop() {
        match work {
            Work::Visit(value) => match value {
                Value::Array(rows) => {
                    pending.push(Work::Array(rows.len()));
                    pending.extend(rows.iter().rev().map(Work::Visit));
                }
                Value::Object(object) => {
                    let mut keys = crate::wire::coercion::keys(object)
                        .into_iter()
                        .filter(|key| sensitive.find_from_utf16(key.units(), 0).next().is_none())
                        .collect::<Vec<_>>();
                    keys.sort_by(|left, right| {
                        collator.compare_utf16_icu4c(left.units(), right.units())
                    });
                    pending.push(Work::Object(
                        keys.iter().map(|key| (*key).clone()).collect(),
                    ));
                    pending.extend(keys.into_iter().rev().map(|key| Work::Visit(&object[key])));
                }
                _ => values.push(value.clone()),
            },
            Work::Array(length) => {
                let children = values.split_off(values.len() - length);
                values.push(Value::Array(children));
            }
            Work::Object(keys) => {
                let children = values.split_off(values.len() - keys.len());
                values.push(Value::object(keys.into_iter().zip(children)));
            }
        }
    }
    let canonical = values.pop().expect("catalog metadata root").stringify();
    Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
}
