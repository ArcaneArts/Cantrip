# ICU4X collation compatibility

These runtime sources come from the published `icu_collator` 2.1.1 crate
(ICU4X commit `38a49da495248dd1ded84cf306e4ca42e64d5bb3`). Original source and
manifest SHA-256 receipts are in `upstream-sha256.json`; the upstream license
is retained in `LICENSE`. The upstream examples, benchmarks, test data and
development lockfile are omitted. `Cargo.toml.orig` is retained for comparison.

Cantrip changes only the following behavior and integration:

- `compare_utf16_icu4c` feeds the original decoded UTF-16 stream into the existing
  comparison algorithm without scalar-based prefix skipping. It compares through
  quaternary strength; Cantrip's metadata comparator uses default tertiary strength.
- A separate optional code unit follows an unpaired surrogate through lookahead
  and normalization. U+FFFF is only a scalar placeholder for a non-decomposing
  starter. Its collation weight is never substituted for the surrogate's weight.
  The original unit reaches the existing ICU4C implicit-primary calculation.
  No invalid Rust `char` is constructed, and valid U+FFFF input remains distinct.
  Starter reconstruction during contraction lookahead retains the original unit;
  the placeholder is never allowed to match a contraction suffix.
- Existing scalar/UTF-8/repairing UTF-16 APIs keep their original behavior.
- The compiled data dependency uses the adjacent generated crate with full
  Unihan root ordering. ICU4X's smaller implicit-Han default differs from Node's
  ICU4C ordering even with the same CLDR version.

The behavioral authority is Node 24's ICU 78.2 / Unicode 17 / CLDR 48.0.
`tests/settings_semantics.rs` compares the actual production metadata hash and
raw key comparisons against Node, including every BMP unit, unpaired units,
normalization/contractions, multiple locales, and randomized metadata.
Do not update collation data without running those comparisons: hashes are
persistent identifiers, and newer Unicode data can change them.

References:

- https://github.com/unicode-org/icu4x/tree/38a49da495248dd1ded84cf306e4ca42e64d5bb3/components/collator
- https://github.com/unicode-org/icu/blob/release-78.2/icu4c/source/i18n/collation.h
- https://github.com/unicode-org/icu/blob/release-78.2/docs/userguide/icu_data/buildtool.md

Both adjacent `LICENSE` files must accompany distributed artifacts.
