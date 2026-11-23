//! Source-compatible remote URL display and failure redaction, retaining UTF-16.
use cantrip_wire::JsString;
use regress::Regex;
use std::sync::LazyLock;
static KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::with_flags("(?:token|key|auth|password|secret)", "iu").unwrap());
static USER: LazyLock<Regex> =
    LazyLock::new(|| Regex::with_flags(r"([a-z][a-z0-9+.-]*://)[^/@\s]+@", "iu").unwrap());
static QUERY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::with_flags(
        r"([?&](?:token|key|auth|password|secret)[^=]*=)[^&\s]+",
        "iu",
    )
    .unwrap()
});
fn replace(input: &JsString, expression: &Regex, suffix: &str) -> JsString {
    let units = input.units();
    let mut output = Vec::new();
    let mut start = 0;
    for found in expression.find_from_utf16(units, 0) {
        output.extend_from_slice(&units[start..found.start()]);
        if let Some(group) = found.group(1) {
            output.extend_from_slice(&units[group]);
        }
        output.extend(suffix.encode_utf16());
        start = found.end();
    }
    output.extend_from_slice(&units[start..]);
    JsString::new(output)
}
pub(super) fn sanitize(input: &JsString) -> (JsString, bool) {
    if let Ok(mut url) = url::Url::parse(&input.lossy()) {
        // Node's URL parser escapes the final opaque-path space before a
        // query/fragment. Keep its display bytes, which also bind review tokens.
        if url.cannot_be_a_base()
            && (url.query().is_some() || url.fragment().is_some())
            && let Some(path) = url.path().strip_suffix(' ')
        {
            url.set_path(&format!("{path}%20"));
        }
        let mut redacted = false;
        if !url.username().is_empty() || url.password().is_some_and(|s| !s.is_empty()) {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            redacted = true;
        }
        let mut pairs = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<Vec<_>>();
        let keys = pairs.iter().map(|(key, _)| key.clone()).collect::<Vec<_>>();
        let mut changed = false;
        for key in keys {
            if KEY
                .find_from_utf16(JsString::from(key.as_str()).units(), 0)
                .next()
                .is_some()
            {
                let mut first = true;
                pairs.retain_mut(|(known, value)| {
                    if *known != key {
                        return true;
                    }
                    if !first {
                        return false;
                    }
                    first = false;
                    *value = "REDACTED".into();
                    true
                });
                changed = true;
                redacted = true;
            }
        }
        if changed {
            let query = url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(pairs)
                .finish();
            url.set_query(Some(&query));
        }
        return (url.to_string().into(), redacted);
    }
    let without = replace(input, &USER, "");
    let value = replace(&without, &QUERY, "REDACTED");
    let redacted = &value != input;
    (value, redacted)
}
