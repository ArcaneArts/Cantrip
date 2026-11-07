//! Canonical opaque attachment stream refinements from the protocol authority.
use super::{Parsed, ValidationError, Value, value::json};

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !matches!(
        tag,
        "attachment-upload-stream" | "attachment-download-stream"
    ) {
        return Ok(false);
    }
    let value = result.value.as_ref().ok_or(ValidationError::Operation)?;
    let chunks = value["chunks"]
        .as_array()
        .ok_or(ValidationError::Operation)?;
    let upload = tag == "attachment-upload-stream";
    let mut issues = Vec::new();
    let mut issue = |suffix: Vec<Value>, message: &str| {
        let mut at = path.to_vec();
        at.extend(suffix);
        issues.push(json!({"code":"custom","message":message,"path":at}));
    };
    let mut bytes = 0.0;
    for (index, chunk) in chunks.iter().enumerate() {
        let sequence = chunk["sequence"]
            .as_f64()
            .ok_or(ValidationError::Operation)?
            == index as f64;
        let end = chunk["eof"] == (index == chunks.len() - 1);
        if upload {
            if !sequence {
                issue(
                    vec![json!("chunks"), json!(index), json!("sequence")],
                    "Attachment upload chunks must be contiguous.",
                );
            }
            if !end {
                issue(
                    vec![json!("chunks"), json!(index), json!("eof")],
                    "Only the final attachment upload chunk may end the stream.",
                );
            }
        } else if !sequence || !end {
            issue(
                vec![json!("chunks"), json!(index)],
                "Attachment download chunks are not a canonical stream.",
            );
        }
        bytes += chunk["plaintextBytes"]
            .as_f64()
            .ok_or(ValidationError::Operation)?;
    }
    if value["sizeBytes"].as_f64() != Some(bytes) {
        issue(
            vec![json!("chunks")],
            if upload {
                "Attachment upload chunk sizes must match the declared size."
            } else {
                "Attachment download chunk sizes must match the declared size."
            },
        );
    }
    result.issues.extend(issues);
    Ok(true)
}
