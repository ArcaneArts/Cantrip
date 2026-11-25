use super::{checked, directory, joined, paths};
use crate::filesystem::Scope;
use anyhow::{Result, anyhow, bail};
use cantrip_wire::{JsString, Value, value::json};
use icu_collator::{
    Collator, CollatorBorrowed,
    options::{CollatorOptions, Strength},
};
use std::{cmp::Ordering, collections::VecDeque, ffi::OsStr, path::Path};

pub(in crate::filesystem) struct Sorting {
    locale: icu_locale_core::Locale,
    ordinary: CollatorBorrowed<'static>,
    primary: CollatorBorrowed<'static>,
}
impl Sorting {
    pub fn new() -> Result<Self> {
        Self::with_locale(cantrip_wire::environment::locale().unwrap_or("en-US"))
    }
    pub fn with_locale(name: &str) -> Result<Self> {
        let locale: icu_locale_core::Locale =
            name.parse().unwrap_or_else(|_| "en-US".parse().unwrap());
        let mut options = CollatorOptions::default();
        options.strength = Some(Strength::Primary);
        Ok(Self {
            ordinary: Collator::try_new(locale.clone().into(), CollatorOptions::default())
                .map_err(|e| anyhow!("Explorer sorting locale: {e}"))?,
            primary: Collator::try_new(locale.clone().into(), options)
                .map_err(|e| anyhow!("Explorer sorting locale: {e}"))?,
            locale,
        })
    }
    pub fn compare(&self, a: &JsString, b: &JsString) -> Ordering {
        self.ordinary.compare_utf16_icu4c(a.units(), b.units())
    }
    pub fn base(&self, a: &JsString, b: &JsString) -> Ordering {
        self.primary.compare_utf16_icu4c(a.units(), b.units())
    }
    pub fn lower(&self, value: &JsString, sliced: bool) -> JsString {
        // Node 24/V8 13.6 uses root casing for flat Latin-1 strings and the
        // locale-aware path for sliced strings. Retain trim/Git split shapes;
        // basename extraction flattens the scanned paths before scoring them.
        // Reference: nodejs/node v24.22.2, builtins-intl-gen.cc:104-218.
        if !sliced && value.units().iter().all(|u| *u <= 255) {
            return value.lowercase();
        }
        let mapper = icu_casemap::CaseMapper::new();
        let mut output = Vec::new();
        let mut scalars = String::new();
        for decoded in char::decode_utf16(value.units().iter().copied()) {
            match decoded {
                Ok(ch) => scalars.push(ch),
                Err(e) => {
                    output.extend(
                        mapper
                            .lowercase_to_string(&scalars, &self.locale.id)
                            .encode_utf16(),
                    );
                    scalars.clear();
                    output.push(e.unpaired_surrogate());
                }
            }
        }
        output.extend(
            mapper
                .lowercase_to_string(&scalars, &self.locale.id)
                .encode_utf16(),
        );
        JsString::new(output)
    }
}
fn basename(path: &JsString) -> JsString {
    let end = path
        .units()
        .iter()
        .rposition(|u| *u != 47)
        .map_or(0, |i| i + 1);
    JsString::new(
        path.units()[..end]
            .rsplit(|u| *u == 47)
            .next()
            .unwrap_or_default()
            .to_vec(),
    )
}
fn contains(haystack: &[u16], needle: &[u16]) -> bool {
    needle.is_empty() || haystack.windows(needle.len()).any(|s| s == needle)
}
pub(super) fn score(
    path: &JsString,
    sliced: bool,
    query: &JsString,
    sorting: &Sorting,
) -> Option<u8> {
    let path = sorting.lower(path, sliced);
    let name = basename(&path);
    let (p, n, q) = (path.units(), name.units(), query.units());
    if n == q {
        Some(0)
    } else if n.starts_with(q) {
        Some(1)
    } else if contains(n, q) {
        Some(2)
    } else if p.starts_with(q) {
        Some(3)
    } else if contains(p, q) {
        Some(4)
    } else {
        None
    }
}
async fn scanned(
    root: &Path,
    sorting: &Sorting,
    scope: &Scope,
) -> Result<(Vec<(JsString, bool)>, bool)> {
    let mut pending = VecDeque::from([(paths::canonical(root).await?, JsString::from(""))]);
    let mut scanned = 0;
    let mut paths = Vec::new();
    while !pending.is_empty() && scanned < 100_000 {
        scope.check()?;
        let (directory, relative) = pending.pop_front().unwrap();
        let mut entries = directory::entries(&directory).await?;
        entries.sort_by(|a, b| sorting.compare(&a.0, &b.0));
        for (name, kind) in entries {
            if scanned >= 100_000 {
                break;
            }
            scanned += 1;
            if name.as_str() == Some(".git") {
                continue;
            }
            let relative = joined(&relative, &name);
            if kind.is_dir() {
                pending.push_back((
                    directory.join(crate::filesystem::paths::native(&name)),
                    relative,
                ));
            } else if kind.is_file() || kind.is_symlink() {
                paths.push((relative, false));
            }
        }
    }
    Ok((paths, !pending.is_empty()))
}
pub async fn search_files(
    root: &Path,
    query: &JsString,
    limit: f64,
    scope: &Scope,
) -> Result<Value> {
    search_files_from_input(root, query, limit, None, scope).await
}
pub(super) async fn search_files_from_input(
    root: &Path,
    query: &JsString,
    limit: f64,
    input: Option<&JsString>,
    scope: &Scope,
) -> Result<Value> {
    let raw_query = input.unwrap_or(query);
    let query = query.trim();
    if query.is_empty() {
        bail!("Enter a file name to search for.");
    }
    let sorting = Sorting::new()?;
    let normalized = sorting.lower(&query, &query != raw_query && query.len() >= 13);
    let normalized = JsString::new(
        normalized
            .units()
            .iter()
            .map(|u| if *u == 92 { 47 } else { *u })
            .collect(),
    );
    let args = [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
    ];
    let mut arguments = vec!["-C".into(), root.as_os_str().to_owned()];
    arguments.extend(args.map(Into::into));
    let candidates = scope
        .run_with_timeout(OsStr::new("git"), &arguments, 32 * 1024 * 1024, None)
        .await;
    let (paths, truncated) = match candidates {
        Ok(output) => (
            output
                .split('\0')
                .filter(|s| !s.is_empty())
                .map(|path| {
                    let path = JsString::from(path);
                    let sliced = path.len() >= 13;
                    (path, sliced)
                })
                .collect(),
            false,
        ),
        Err(_) => scanned(root, &sorting, scope).await?,
    };
    let mut matches: Vec<_> = paths
        .into_iter()
        .filter_map(|(path, sliced)| {
            score(&path, sliced, &normalized, &sorting).map(|score| (score, basename(&path), path))
        })
        .collect();
    matches.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| sorting.compare(&a.1, &b.1))
            .then_with(|| sorting.compare(&a.2, &b.2))
    });
    let limit = limit.floor().clamp(1., 100.) as usize;
    let truncated = truncated || matches.len() > limit;
    let results: Vec<_> = matches
        .into_iter()
        .take(limit)
        .map(|(_, name, path)| json!({"name":name,"path":path}))
        .collect();
    checked(
        "explorerFileSearchSchema",
        &json!({"query":query,"results":results,"truncated":truncated}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn locale_casing_and_unpaired_utf16() {
        let tr = Sorting::with_locale("tr").unwrap();
        assert_eq!(tr.lower(&"Iİ".into(), false), JsString::from("ıi"));
        assert_eq!(tr.lower(&"I".into(), false), JsString::from("i"));
        assert_eq!(
            tr.lower(&"LONG_ASCII_I_NAME".into(), true),
            JsString::from("long_ascıı_ı_name")
        );
        let lt = Sorting::with_locale("lt").unwrap();
        assert_eq!(
            lt.lower(&"I\u{301}".into(), false),
            JsString::from("i\u{307}\u{301}")
        );
        assert_eq!(
            tr.lower(&JsString::new(vec![73, 0xd800, 304]), false),
            JsString::new(vec![305, 0xd800, 105])
        );
    }
}
