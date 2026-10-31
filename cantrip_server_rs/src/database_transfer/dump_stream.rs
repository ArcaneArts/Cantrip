use anyhow::{Context, Result};
use std::io::Read;

// PostgreSQL deliberately leaves uncompressed plain stdout in Windows text
// mode. Compressed plain output switches stdout to binary mode, preserving LF,
// CRLF and bare CR *inside* SQL literals. Decode bytes, never rewrite newlines.
pub(super) const OPTIONS: [&str; 2] = ["--format=plain", "--compress=gzip:1"];

pub(super) fn decode(bytes: &[u8]) -> Result<String> {
    let mut sql = String::new();
    flate2::read::MultiGzDecoder::new(bytes)
        .read_to_string(&mut sql)
        .context("decode native compressed SQL dump")?;
    Ok(sql)
}
