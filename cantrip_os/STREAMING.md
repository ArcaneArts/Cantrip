# Desktop streaming measurements

The initial integrated Linux viewer uses the existing native capture → Worker
adaptive JPEG → authorized WorkerLink surface. It targets 15 fps by default.
The existing viewer quality controls remain available. VNC is the compatibility
path and uses the same exclusive human-control lease in the product.

The local measurements below retain JPEG as the initial integrated adapter:
its measured CPU/memory fit this workload and it already shares captured desktop
identity, viewer control, clipboard, resizing and the existing client decoder.
This choice does **not** make JPEG the most efficient codec. ZRLE's changed
rectangles were substantially cheaper for this editor-like workload. A native
VNC client is a useful option for a constrained connection. A future integrated
video/tile adapter must preserve those product semantics and be tested with a
real browser decoder and representative network conditions.

## Reproduce the local comparison

Build the current default image first (`node cantrip_os/scripts/os.mjs build`).
Create a disposable fixture, without exposing any network ports:

```sh
docker run --rm -d --name cantrip-os-stream-test \
  --memory 4g --memory-swap 4g --shm-size 1g cantrip-os:dev
docker exec cantrip-os-stream-test cantrip-workspaces create cua-a
docker exec cantrip-os-stream-test cantrip-workspaces create cua-b
docker exec cantrip-os-stream-test cantrip-executor attach \
  00000000-0000-4000-8000-000000000001 \
  00000000-0000-4000-8000-000000000002
CANTRIP_OS_STREAM_TEST_CONTAINER=cantrip-os-stream-test \
CANTRIP_OS_STREAM_OUTPUT=/tmp/cantrip-os-stream-results.json \
  pnpm --filter @cantrip/worker exec vitest run \
  test/os-stream-measurement.integration.test.ts --maxWorkers=1
docker stop cantrip-os-stream-test
```

The test starts the two assigned desktops and copies its X11 workload into the
fixture. Use a disposable container: it replaces the measured workspace's
clipboard and draws an application covering that desktop. It never captures or
controls the Host desktop. If startup has not finished, the real package CLI
reports that error; retry after the container starts.

Each candidate sees the same 1440×900 X11 window: 10 seconds of static editor-like
text and 10 seconds of text/rectangle motion. Native JPEG uses the production
`OsDesktopSession` at 15 fps, adaptive quality, with its real native capture and
Worker Sharp encoder. VNC negotiates **ZRLE encoding 16**, consumes real compressed
rectangles and requests incremental updates at a ceiling of 15 fps. Its lossless
changed-rectangle encoding and JPEG's lossy full-frame encoding have different
fidelity. Zero VNC updates on a static screen means unchanged content, not a
stalled stream. Motion must produce real updates.

The harness records encoded bytes/arrivals, first encoded frame, reconnect,
guest cgroup CPU/memory and Host probe-process CPU. The shared native CUA
lease and desktops are prepared before adapter timing; VNC timing includes its
service connection. These are not cold attach/admission comparisons. Five Escape key operations
must reach the actual application; each acknowledgment follows XSync. Both paths
must write the actual X11 clipboard while leaving the other desktop's selection
unchanged. This compatibility clipboard check is ASCII/Latin-1; separate native
CUA acceptance covers UTF-8.

These are **local backend observations**, not input-to-display latency, decoded
browser FPS, signed-grant admission timing, WAN performance, audio/video quality
scores or concurrent viewer capacity. No image buffers are retained. Guest CPU
and Host encoder/probe CPU are reported separately; the latter is outside the
4 GiB OS limit. Cgroup working set subtracts inactive file cache and is reported
alongside raw and anonymous memory. Other host work can affect elapsed timings.

## Active 4 GiB workload

```sh
CANTRIP_OS_RESOURCE_TEST_IMAGE=cantrip-os:dev \
CANTRIP_OS_RESOURCE_OUTPUT=/tmp/cantrip-os-active-resources.json \
  pnpm --filter @cantrip/worker exec vitest run \
  test/os-active-resources.integration.test.ts --maxWorkers=1
```

This test creates and stops its own fresh, disposable 4 GiB container. It samples
idle, one active workspace and two active workspaces, retaining the personal
console. Each active workspace has its own 1440×900 desktop, Chromium rendering
a local animated page, and a real native executor job hashing and writing a file
every 50 ms. Files and GUI launches go through the native executor. The actual
browser's loopback DevTools listing must show advancing page titles; executor
output/files must prove continued execution. No model credentials are supplied.
The browser debugging ports exist only inside the disposable fixture.

This workload has no viewers or model runtime inside the OS. It establishes the
reported configuration, not a universal capacity guarantee for arbitrary sites,
projects or builds. Container limits exclude the external Worker, model and
Docker VM overhead; htop's host-kernel memory total is not the container limit.

## Selkies candidate

The official Selkies 2.2.1 Debian trixie ARM64 package was downloaded with its
release SHA-256 verified (`f5b422b470a05360e1f908b14f945c31f65c43e53bee43e4b0aceb887a334a0d`).
It installed in a disposable copy of the same OS. Both ordinary startup and a
repeat with Python fault reporting exited **132 / illegal instruction**, while
importing its bundled `cryptography.x509.certificate_transparency` through the
WebRTC imports, before capture or the WebSocket listener started. Importing
pixelflux and pcmflux individually succeeded. This is an observed failure of
that package/environment, not a conclusion about Selkies on every platform.
No Selkies latency, FPS, clipboard or CPU results are claimed.

The tested invocation selected CPU H.264, disabled audio/microphone/gamepad/
webcam and HTTPS/basic auth, and requested 1440×900 at 15 fps on the selected
X11 display. Selkies was not added to the production image. Its Debian installed
size was 151389 KiB, excluding additional dependencies.

Primary references: [Selkies native installation](https://github.com/selkies-project/selkies/blob/main/docs/native.md),
[the tested release](https://github.com/selkies-project/selkies/releases/tag/2.2.1),
and [LinuxServer Webtop](https://docs.linuxserver.io/images/docker-webtop/).
See [acceptance](ACCEPTANCE.md) for the recorded local numbers and limitations.
