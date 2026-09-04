# Cantrip Code patch series

Prefer product configuration and the bundled `cantrip-workbench` extension when
they can express the behavior cleanly. Permanent fork behavior may be committed
to the recorded vendored source. Use a build-time patch when the source change
should remain isolated against its originating upstream revision.

Patch files use an ordered identifier such as `0001-surface-bootstrap.patch`
and must have a sibling JSON metadata file:

```json
{
  "id": "0001-surface-bootstrap",
  "title": "Describe the behavior",
  "reason": "Explain why an extension cannot implement it",
  "upstreamCommit": "40-character OpenVSCode commit",
  "files": ["src/example.ts"],
  "validation": ["Exact validation command or behavior"],
  "removal": "Condition under which the patch can be removed"
}
```

`pnpm code:patch -- --source <prepared-source>` validates the complete series
before applying it. `--check` validates applicability without modifying the
prepared tree. Patches must never be applied directly to the committed
`cantrip_code/upstream/` snapshot.
