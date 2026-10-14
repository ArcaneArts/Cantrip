# Editor loading measurements

Measured on darwin-arm64 with Node 24.14.0 and the actual bundled Cantrip Code
build `ba05010e28f214852ff3f4359d20f66a32927ff3f55a759b34d8a5e03e380eae`.
The production app, browser storage, database, worker, Git directory, and browser
origin are fresh for every run. Existing provider/user profiles are untouched.

## Change and demonstrated benefit

`parseHttpResponse` copied the owned output of `dechunk` a second time. Chunked
bodies now return that exactly sized buffer. Fixed-length bodies still copy their
view out of transport storage. The response type and downstream transferable
ArrayBuffer ownership remain unchanged.

The runnable parser benchmark extracts and executes the actual production
functions, checks binary output and ownership after input-buffer reuse, and
measures the same 1 MiB chunked, 8 MiB chunked, and 8 MiB fixed-length workloads.
Five warmups and 25 process samples per variant were repeated twice. Each process
also records 20 parser batches after five internal warmups.

| A/B process run | Baseline median / p95 | Candidate median / p95 | Median improvement |
| --------------- | --------------------- | ---------------------- | ------------------ |
| First           | 361.27 / 383.31 ms    | 331.39 / 352.88 ms     | 8.27%              |
| Repeat          | 396.00 / 477.24 ms    | 339.04 / 360.87 ms     | 14.38%             |

Output hashes match and are stable in both runs. Parser allocation instrumentation
measures 16 MiB versus 8 MiB of owned byte buffers for an 8 MiB chunked body;
fixed-length allocation remains 8 MiB. This proves removal of one body-sized
allocation/copy. It does not establish an overall editor startup or page-heap gain.
The A/B process time includes parsing the source and VM setup as well as workload.

Raw A/B samples: [first](qa/editor-buffer-ab.json),
[repeat](qa/editor-buffer-ab-repeat.json).

## Actual browser measurements

The repeated browser workload opens a real file, types, saves, verifies the
worker-owned file, reopens the retained frame, injects one renewal 503, observes
success on the same authority, and saves its dirty buffer. One warmup and three
measured fresh fixtures per variant are used. All scenarios must run; failures
remain in the dataset and are not replaced by successful retries of a whole run.

The cold-case total includes onboarding and folder-project setup. Worker endpoint
startup, transport authority creation, physical WebSocket handshake, document
completion, verified visible workbench readiness, authenticated extension-bridge
connection, presentation completion, worker file opening, and client rendered
file timing are separately recorded. Bridge timing begins at registration;
presentation/file timings include queueing and their existing authorization and
bridge waits. These overlapping phases must not be summed into a critical path.

| Phase                                        | Baseline median / p95 (ms) | Candidate median / p95 (ms) |
| -------------------------------------------- | -------------------------- | --------------------------- |
| Cold workflow (includes onboarding)          | 22308.00 / 22441.00        | 17583.00 / 22763.00         |
| Retained reopening                           | 83.00 / 85.00              | 81.00 / 87.00               |
| Transient-renewal recovery workflow          | 5246.00 / 5442.00          | 4849.00 / 4942.00           |
| Worker endpoint ready                        | 208.00 / 209.00            | 216.00 / 221.00             |
| Transport authorization session              | 43.15 / 47.02              | 45.97 / 48.66               |
| Physical relay WebSocket handshake           | 13.52 / 16.02              | 23.46 / 24.61               |
| Document complete                            | 19.43 / 27.79              | 20.64 / 47.63               |
| Visible workbench bootstrap → restored       | 584.00 / 774.80            | 586.20 / 591.50             |
| Visible workbench bootstrap → verified ready | 584.20 / 775.00            | 586.40 / 591.60             |
| Registered extension bridge → connected      | 4109.00 / 4207.00          | 4048.50 / 4525.00           |
| Presentation operation complete              | 60.00 / 88.00              | 75.00 / 91.00               |
| First worker file-open operation             | 1882.00 / 1931.00          | 1890.00 / 1996.00           |
| Client file click → rendered content         | 4255.00 / 4286.00          | 4340.00 / 4759.00           |

All 24 scenario executions passed across the eight final fixtures (including two
warmup fixtures). The measured series has three fixtures per variant; bridge
connection samples include both prewarmed and visible registered sessions.
Onboarding retries are retained in each observation; existing #2096/#2102 races
can affect the cold workflow total. Physical handshake time excludes
route-selection/fallback waiting. Worker file
opening can include waiting for its bridge. No end-to-end latency improvement is
claimed from these small, overlapping browser samples.

Raw measurements: [baseline](qa/editor-loading-baseline.json),
[candidate](qa/editor-loading-candidate.json),
[comparison](qa/editor-loading-summary.json).

Renderer heap median was 176.74 MiB before and 216.15 MiB after,
with ranges 176.61–210.66 and 210.93–226.08 MiB respectively.
Renderer heap measurements are page-target snapshots after the workload, not
whole-system memory or peak usage. The candidate snapshots are higher; their timing is not controlled within the
garbage-collection cycle. They do not establish a retained-memory improvement. Three-sample p95 is
effectively the maximum and is descriptive, not a tail-latency guarantee.
Chromium reports unavailable byte sizes for service-worker responses; those are
counted explicitly and never converted into negative or assumed zero transfers.

A follow-up used the same actual-browser workload once per variant, collected
both snapshots, and then explicitly invoked Chromium garbage collection. Retained
page heap was 174.14 MiB before and 174.08 MiB after (182,593,924 versus 182,532,700
bytes). Nodes were 2,690 versus 2,696. This diagnostic did not reproduce a retained
heap increase, but one sample per variant is insufficient to claim a whole-page
memory improvement. All six additional behavior scenarios passed. The collector
now records both metrics and the actual garbage-collection result.

Raw memory diagnostic: [baseline](qa/editor-heap-baseline.json),
[candidate](qa/editor-heap-candidate.json).

## Streaming and caching evaluation

The current page adapter waits for a complete bounded HTTP response. Its message
port transfers an ArrayBuffer to the service worker, whose response validation
checks that complete buffer and whose HTML path inserts the current frame nonce
and lineage metadata before constructing Response. Changing only the parser to a
ReadableStream would not stream through this protocol. It would require a
coordinated producer/consumer contract, per-logical-stream credits, incremental
HTTP framing and limits, cancellation propagation, retirement/generation fences,
and HTML lineage handling. Browser congestion coverage for that logical stream is
still blocked by the fixture gap tracked in
[#2104](https://github.com/ArcaneArts/Cantrip/issues/2104).

Streaming is deferred because its required correctness acceptance is currently
unavailable and it would change a security-sensitive ownership/cancellation
boundary. The local copy change preserves all existing limits, deadlines,
cancellation, authentication, encryption, and lineage checks. No streaming gain
is claimed.

Cross-adapter caching is also deferred. An upstream OSS commit in an asset URL is
not a full Cantrip patch/build identity; a safe shared cache would need the actual
build fingerprint plus explicit authorization partitioning and invalidation.
HTML is mount-specific because it carries frame lineage. The measured workload
does not justify introducing this cache boundary now. Retained reopening already
reuses the same authorized frame.

## Reproduction

```sh
# Save the pre-change source from the parent of the milestone commit.
git show 1ea43b4a3:cantrip_app/src/lib/browser-code-tunnel.ts > /tmp/editor-buffer-baseline.ts
node --expose-gc scripts/qa/editor-http-buffer-benchmark.mjs --source /tmp/editor-buffer-baseline.ts
node --expose-gc scripts/qa/editor-http-buffer-benchmark.mjs
node scripts/qa/editor-loading-benchmark.mjs --label current --warmups 1 --iterations 3 --output /tmp/editor-loading-current.json
```

Use the runtime preparation and optional explicit native executable overrides in
[EDITOR_RECOVERY_QA.md](EDITOR_RECOVERY_QA.md). Browser observations, screenshots,
metrics, and correlated service logs remain in the owned ignored `.qa` directory;
only sanitized measurements are committed. Detailed evidence is preserved outside
the worktree before archival.
