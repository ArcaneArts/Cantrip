use crate::{
    error::{CuaError, ErrorCode, Result},
    target::{MAX_SEQUENCE, Target, validate_id},
};

pub const MAX_TARGETS: usize = 256;
pub const MAX_INVENTORY_BYTES: usize = 60 * 1024;
// Target-array budget: leave 1 KiB for the page cursor and JavaScript envelope.
pub const MAX_PAGE_BYTES: usize = 31 * 1024;

pub fn deserialize_cursor<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    use serde::Deserialize;
    let cursor = String::deserialize(deserializer)?;
    validate_id(&cursor).map_err(serde::de::Error::custom)?;
    Ok(Some(cursor))
}

pub struct TargetPage {
    pub targets: Vec<Target>,
    pub truncated: bool,
    pub next_cursor: Option<String>,
}

/// Budget a contiguous sorted prefix using actual escaped JSON and the largest
/// possible assigned generation. Never skip a middle item that does not fit.
pub fn prefix_len<'a>(targets: impl IntoIterator<Item = &'a Target>) -> Result<usize> {
    let mut used = 2usize;
    let mut count = 0;
    for target in targets {
        let mut budget = target.clone();
        budget.generation = MAX_SEQUENCE;
        let bytes = serde_json::to_vec(&budget)
            .map_err(|_| CuaError::invalid("Invalid target metadata."))?
            .len()
            + 1;
        if count == MAX_TARGETS || used + bytes > MAX_PAGE_BYTES {
            if count == 0 {
                return Err(CuaError::new(
                    ErrorCode::Capacity,
                    "A native target exceeds the inventory page bound.",
                ));
            }
            break;
        }
        used += bytes;
        count += 1;
    }
    Ok(count)
}

pub fn page(mut targets: Vec<Target>, after: Option<&str>, truncated: bool) -> Result<TargetPage> {
    if let Some(after) = after {
        validate_id(after)?;
    }
    targets.sort_by(|a, b| a.id.cmp(&b.id));
    for (index, target) in targets.iter().enumerate() {
        target.validate()?;
        if index > 0 && targets[index - 1].id == target.id {
            return Err(CuaError::invalid("Duplicate native target identity."));
        }
    }
    targets.retain(|target| after.is_none_or(|cursor| target.id.as_str() > cursor));
    let count = prefix_len(&targets)?;
    let more = count < targets.len();
    targets.truncate(count);
    let next_cursor = more.then(|| targets.last().unwrap().id.clone());
    Ok(TargetPage {
        targets,
        truncated: truncated || more,
        next_cursor,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        backend::{CaptureBackend, FakeBackend},
        cancellation::Cancellation,
    };
    fn target(id: &str) -> Target {
        let mut target = FakeBackend
            .targets(&Cancellation::default())
            .unwrap()
            .remove(0);
        target.id = id.into();
        target
    }
    #[test]
    fn lexical_pages_cover_more_than_one_count_bound_without_duplicates() {
        let source: Vec<_> = (0..600)
            .rev()
            .map(|index| target(&format!("window-{index}")))
            .collect();
        let mut expected: Vec<_> = source.iter().map(|target| target.id.clone()).collect();
        expected.sort();
        let mut after = None;
        let mut found = vec![];
        loop {
            let result = page(source.clone(), after.as_deref(), false).unwrap();
            assert!(result.targets.len() <= MAX_TARGETS);
            assert!(serde_json::to_vec(&result.targets).unwrap().len() <= MAX_PAGE_BYTES);
            if let Some(next) = &result.next_cursor {
                assert_eq!(next, &result.targets.last().unwrap().id);
                assert!(result.truncated);
            }
            found.extend(result.targets.into_iter().map(|target| target.id));
            after = result.next_cursor;
            if after.is_none() {
                break;
            }
        }
        assert_eq!(found, expected);
    }
    #[test]
    fn escaped_middle_target_waits_for_the_next_page_instead_of_being_skipped() {
        let mut source = vec![target("a"), target("b"), target("c"), target("d")];
        for target in &mut source[..3] {
            target.title = Some("\u{0001}".repeat(1800));
        }
        let first = page(source.clone(), None, false).unwrap();
        assert_eq!(
            first
                .targets
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert_eq!(first.next_cursor.as_deref(), Some("b"));
        let second = page(source, first.next_cursor.as_deref(), false).unwrap();
        assert_eq!(
            second
                .targets
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            ["c", "d"]
        );
        assert!(second.next_cursor.is_none());
        assert!(!second.truncated);
        assert!(
            page(vec![], Some("last"), true)
                .unwrap()
                .next_cursor
                .is_none()
        );
    }
    #[test]
    fn maximal_escaped_native_metadata_fits_a_page_and_the_javascript_envelope() {
        let mut huge = target("a");
        huge.title = Some("\u{0001}".repeat(4096));
        huge.application = Some("\u{0001}".repeat(1024));
        huge.id = "macos-window-4294967295".into();
        let result = page(
            vec![huge.clone(), {
                let mut last = huge;
                last.id = "z".into();
                last
            }],
            None,
            false,
        )
        .unwrap();
        assert_eq!(result.targets.len(), 1);
        let wrapped = serde_json::json!({"value":{"targets":result.targets,"truncated":result.truncated,"nextCursor":result.next_cursor}});
        assert!(serde_json::to_vec(&wrapped).unwrap().len() <= 32 * 1024);
    }
}
