# Croner compatibility

The native automation parser and civil traversal adapt behavior from Croner
10.0.1, used by the existing protocol implementation. Its MIT license is retained
in [LICENSE](LICENSE). This adaptation runs entirely in Rust.

The implementation preserves the five-part grammar, validation diagnostics,
question-mark wildcard handling, one-shot date strings, civil search order,
year-3000 search boundary and timezone roundtrips. Development comparisons execute
the unchanged Source schemas and scheduling helpers.

Legacy `SystemV/*` timezone data is extracted from the actual Source `Intl`
implementation by `scripts/server-rust/project-automation-legacy-zones.mjs`.
The generated TZif files retain historical transitions from year 1 through 2100,
including historical exceptions, and a recurring last-Sunday April/October rule
for later dates, checked against Source for a complete future Gregorian cycle.
Ordinary IANA zones use Jiff's bundled database, avoiding host zoneinfo drift.
These assets are compiled into the
server; extraction is a development task and requires no server runtime helper.
