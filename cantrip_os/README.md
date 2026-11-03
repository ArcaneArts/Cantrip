# CantripOS foundation

Debian 13 (trixie), IceWM, Chromium, PCManFM, Mousepad, and xterm. This is a
standalone OS testing environment; Cantrip integration comes later.

From the repository root, with Node 22+ and a running Docker engine:

```sh
node cantrip_os/scripts/os.mjs build
node cantrip_os/scripts/os.mjs up
```

Open <http://127.0.0.1:6080>. IceWM logs in as `cantrip` automatically. Use the
bottom-left menu to open applications. `sudo` requires no password. The noVNC
viewer retries after disconnect and supports resize, fullscreen, and a text
clipboard dialog. Only the browser service is published, on host loopback.

```sh
node cantrip_os/scripts/os.mjs restart  # Same container; retains system changes
node cantrip_os/scripts/os.mjs rebuild  # Build succeeds first, then replace it
node cantrip_os/scripts/os.mjs logs
node cantrip_os/scripts/os.mjs stop
node cantrip_os/scripts/os.mjs reset    # Explicitly DELETE this desktop's home
```

`CANTRIP_OS_NAME` (default `cantrip-os`) selects container/image/volume names;
`CANTRIP_OS_PORT` (default `6080`) selects the localhost port when creating it.
The default named volume is `cantrip-os-home`. Rebuild retains this home,
including Documents, Downloads, and Chromium profiles. Reset deletes it.

For automatic source changes → image build → desktop replacement → browser
reconnect, run:

```sh
node cantrip_os/scripts/dev.mjs
```

It builds once, then polls the content of manifests, overlays, image recipes,
scripts, viewer assets, and `.dockerignore`. Changes are debounced and builds
are serialized; edits arriving during a build queue another build. Manual
lifecycle commands share the instance lock even across Git worktrees. Actual
build failures leave the running container untouched; fix the source and the
next edit retries. Generated artifacts, logs, caches, Git internals, and user
data are excluded. Ctrl+C stops watching and leaves the desktop running.

Change packages in `manifests/desktop.packages`; change menu, toolbar, background
color, and desktop defaults under `overlays/etc/X11/icewm/`. Executables belong under
`overlays/usr/local/bin/`. Source-managed defaults remain in `/etc/X11/icewm` and
are refreshed with the image. Personal `~/.icewm` overrides take precedence;
remove the relevant personal override to see a changed system default. We do
not copy defaults into persistent home files on every startup.

Interactive `apt install` and system changes survive restart, but disappear
when the container is replaced. Promote experiments into manifests/overlays
to preserve them. Ordinary rebuild never deletes home data. Chromium runs as
the desktop user; its launcher disables Chromium's inner sandbox in Docker
because this edition uses Docker as its outer boundary.

The Docker image pins its Debian base digest; apt installs current packages
for the pinned trixie release. It runs the OS userspace on Docker's kernel.
Bootable-media recipes follow in the next foundation cycle.
See [the product plan](../docs/CANTRIP_OS.md).
