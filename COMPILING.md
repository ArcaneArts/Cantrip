# Compiling Cantrip

This guide covers clean-machine development and distributable builds for the
native Windows, macOS, and Linux desktop application and the Capacitor Android
and iOS clients. Run commands from the repository root unless a section says
otherwise.

Cantrip's desktop bundle is a host-native build. It includes the React client,
Tauri shell, server, worker, a platform-matched Node runtime, the Rust Cantrip
CLI, the patched Codex runtime, and the patched Cantrip Code/OpenVSCode
distribution. Native dependencies mean that a complete Windows bundle is built
on Windows, a complete macOS bundle on macOS, and a complete Linux bundle on
Linux.

The Capacitor applications are clients only. They do not contain the Cantrip
server, worker, Codex, or Cantrip Code and must connect to a reachable Cantrip
server after installation.

## Shared requirements

All builds need:

- Git.
- Node.js 24. The root package accepts Node 22 or newer, but Node 24 is the
  version used by release automation and avoids older Node/pnpm compatibility
  gaps.
- pnpm 11.15.1, matching the `packageManager` field in `package.json`.
- Internet access for pnpm packages and, for desktop builds, Rust crates,
  pinned Node archives, native dependency archives, and Tauri bundling tools.

Install the repository's pnpm version after installing Node:

```shell
npm install --global pnpm@11.15.1
node --version
pnpm --version
```

Expected major versions are Node 24 and pnpm 11. Install dependencies once per
checkout:

```shell
pnpm install --frozen-lockfile
```

The first native build is large. Keep at least 30 GB free and expect Codex and
Cantrip Code to take most of the build time. Cargo, npm, and Cantrip Code build
outputs are cached, so later builds on the same machine are substantially
faster. Cloning near the root of a drive also reduces path-length pressure.

The normal verification command is:

```shell
pnpm check
```

The complete current-host release build is:

```shell
pnpm bundle
```

Do not pass a different operating-system target to `pnpm bundle`. The worker,
Codex, Cantrip Code, and embedded Node runtime must match the machine executing
the build.

Successful bundles are collected under:

```text
artifacts/bundles/<platform>-<architecture>/
```

Lower-level `package:server`, `package:worker`, `package:services`, and
`package:app` commands are useful when iterating on one artifact. `pnpm bundle`
is the end-to-end compilation check.

## Windows

The supported release target is 64-bit Windows, identified by the build scripts
as `win32-x64`. Use Windows 10 or 11 on x64 hardware.

### One-command clean-machine build

[`scripts/yeet-windows.ps1`](scripts/yeet-windows.ps1) bootstraps a Windows
machine, clones or refreshes a clean Cantrip checkout at `C:\src\Cantrip`, and
runs the complete build. It installs WinGet when needed, then Git, x64 Node.js
24, pnpm 11.15.1, Python, CMake, NASM, Rustup, the pinned Rust MSVC toolchain,
Visual Studio 2022 C++ Build Tools, and WebView2. Run a downloaded copy from a
normal PowerShell window; it requests Administrator access itself:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\yeet-windows.ps1
```

The default build creates the NSIS `.exe` installer and skips MSI to avoid the
additional WiX/VBSCRIPT dependency. It leaves complete archives, the installer,
and a transcript under `C:\src\Cantrip\artifacts\bundles\win32-x64`. The script
caps Cargo at four parallel jobs and lowers that automatically on machines with
less memory. It is safe to rerun, but deliberately stops rather than overwrite
an existing checkout with uncommitted changes.

Useful overrides include:

```powershell
# Build a branch, tag, or commit from origin.
.\yeet-windows.ps1 -Ref codex/codex-0.147.0

# Put the checkout on another drive and use two Cargo compiler jobs.
.\yeet-windows.ps1 -CheckoutPath D:\src\Cantrip -CargoJobs 2

# Request both NSIS and MSI, or omit the repository checks on a retry.
.\yeet-windows.ps1 -Installer all
.\yeet-windows.ps1 -SkipChecks
```

### Prerequisites

Install:

1. [Git for Windows](https://git-scm.com/download/win).
2. [Node.js 24](https://nodejs.org/en/download).
3. [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
   Select **Desktop development with C++**, including MSVC v143, a Windows
   10/11 SDK, and the C++ CMake tools.
4. [NASM](https://www.nasm.us/). Ensure `nasm.exe` is on `PATH`; the
   `aws-lc-sys` Rust dependency needs it when compiling its native x64 code.
5. [Python 3](https://www.python.org/downloads/windows/). Enable **Add Python to
   PATH**. Node-gyp and native dependency download/build scripts use it.
6. [Rustup](https://rustup.rs/) with the x64 MSVC host toolchain. Do not select
   the GNU toolchain.
7. Microsoft Edge [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).
   It is normally already present on supported Windows versions.

Tauri's maintained Windows prerequisite list is available in the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/#windows).

Long paths are strongly recommended for this repository. Enable **Win32 long
paths** in Windows group policy or system policy, then allow them in Git from an
Administrator terminal:

```powershell
git config --global core.longpaths true
```

Use the **Developer PowerShell for VS 2022** for the first build. Confirm the
toolchain:

```powershell
node --version
python --version
pnpm --version
rustup show
rustc --version
cargo --version
cmake --version
nasm -v
```

Install the Rust version used by Cantrip and select the MSVC build:

```powershell
rustup toolchain install 1.95.0 --profile default --component clippy --component rustfmt --component rust-src
rustup default 1.95.0-x86_64-pc-windows-msvc
```

If `rustup default` reports that the named toolchain is unavailable, verify
that Rustup's default host is `x86_64-pc-windows-msvc` with `rustup show` and
reinstall Rustup using the MSVC option.

### Compile and package

From a short path such as `C:\src\Cantrip`:

```powershell
pnpm install --frozen-lockfile
pnpm codex:verify
pnpm code:source:verify
pnpm check
pnpm bundle
```

`pnpm bundle` builds the standalone server and worker, all patched Codex
executables, the Cantrip CLI, Cantrip Code and its native Node modules, the
Tauri application, and the Windows installers. The Tauri configuration
currently requests all Windows bundle formats, so a complete build creates both
an NSIS setup executable and an MSI where the local Windows configuration
supports it. Set `CANTRIP_WINDOWS_BUNDLE=nsis` or
`CANTRIP_WINDOWS_BUNDLE=msi` to request only one installer format; the bootstrap
script uses `nsis` by default.

MSI creation uses WiX and may require the Windows **VBSCRIPT** optional feature.
VBSCRIPT is not needed for the NSIS `.exe`; see the
[Tauri Windows installer guide](https://v2.tauri.app/distribute/windows-installer/).

Unsigned local installers are suitable for testing. Public distribution should
sign the application executables and installer with the project's Windows code
signing certificate.

### Develop

```powershell
pnpm devtop
```

This starts the local server and worker and opens the Tauri development window.
Use `pnpm dev` instead for the browser client.

### Windows troubleshooting

- `link.exe`, `cl.exe`, or Windows SDK errors: reopen a Developer PowerShell
  after installing the Visual Studio C++ workload and confirm the MSVC Rust
  toolchain is selected.
- Python or node-gyp errors: make `python --version` work in the same terminal
  used for pnpm. The Microsoft Store Python alias is not a substitute for a
  complete Python installation.
- `failed to run light.exe`: enable the VBSCRIPT optional feature or build only
  an NSIS installer while diagnosing MSI tooling.
- Path-too-long or missing-file errors inside `node_modules`, `cantrip_codex`,
  or `cantrip_code`: enable Windows long paths and move the checkout closer to
  the drive root.
- Patch verification errors immediately after upgrading an older checkout:
  ensure the patch files have no local edits. A fresh clone honors the
  repository's byte-preserving Git attributes.
- Downloads from crates.io, nodejs.org, npm, GitHub Releases, or Tauri's tool
  mirrors must be allowed through any proxy or endpoint filter. A failed native
  archive download is not repaired by installing another compiler.

Release automation uses a clean Blacksmith Windows Server 2025 x64 runner and
requests only the NSIS installer. It is triggered exclusively by advancing the
`release` branch through `pnpm release`; it does not run as a pull-request or
manually dispatched compile check.

## macOS

The automated release target is Apple Silicon (`darwin-arm64`). Host-native
Intel builds are also understood by the scripts, but release automation does
not currently publish them.

### Prerequisites

Install:

1. Git and Node.js 24.
2. Xcode Command Line Tools for desktop-only builds:

   ```shell
   xcode-select --install
   ```

3. Full Xcode 26 or newer when also building the Capacitor iOS client. Launch
   Xcode once after installation and accept its license/setup prompts.
4. Rustup and the Cantrip toolchain:

   ```shell
   rustup toolchain install 1.95.0 --profile default --component clippy --component rustfmt --component rust-src
   rustup default 1.95.0
   ```

5. Python 3, CMake, and pkg-config. With Homebrew:

   ```shell
   brew install python cmake pkg-config
   ```

Confirm that Xcode's active developer directory is correct:

```shell
xcode-select -p
xcrun clang --version
```

### Compile and package

```shell
pnpm install --frozen-lockfile
pnpm check
pnpm bundle
```

The local build assigns `CFBundleVersion` from the Git commit count. Override it
with a positive numeric value when necessary:

```shell
CANTRIP_APP_BUILD_VERSION=100 pnpm bundle
```

Local unsigned application bundles are suitable for development. A public DMG
requires a Developer ID Application certificate and Apple notarization. Release
automation supplies its signing identity separately; credentials are not stored
in the repository.

### Develop

```shell
pnpm devtop
```

If Xcode was upgraded and native builds begin failing, run Xcode once, confirm
`xcode-select -p`, and retry from a new terminal.

## Linux

Linux builds are host-native. `linux-x64`, `linux-arm64`, and `linux-armhf` are
recognized by the Cantrip Code build layer, but x64 on Debian/Ubuntu is the
recommended starting point. Linux artifacts are not currently part of the
automated release matrix, so validate them on the oldest distribution version
you intend to support.

Tauri recommends building against an older compatible glibc baseline rather
than compiling on the newest workstation and expecting the result to run on
older systems. Ubuntu 22.04 and Debian 12 provide WebKitGTK 4.1 and are suitable
baseline examples.

### Prerequisites on Debian/Ubuntu

```shell
sudo apt update
sudo apt install -y \
  build-essential \
  clang \
  cmake \
  curl \
  file \
  git \
  libayatana-appindicator3-dev \
  libclang-dev \
  libkrb5-dev \
  librsvg2-dev \
  libssl-dev \
  libwebkit2gtk-4.1-dev \
  libxdo-dev \
  pkg-config \
  python3 \
  rpm \
  wget
```

The WebKitGTK and desktop library names for other distributions are listed in
the [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

Install Node.js 24, pnpm 11.15.1, and Rustup, then:

```shell
rustup toolchain install 1.95.0 --profile default --component clippy --component rustfmt --component rust-src
rustup default 1.95.0
pnpm install --frozen-lockfile
```

### Compile and package

```shell
pnpm check
pnpm bundle
```

The Tauri `all` bundle target attempts the Linux formats supported by the host,
including AppImage, Debian, and RPM packaging. If only one format is required,
stage the desktop runtime first and invoke the app's Tauri build with an
explicit bundle format.

### Develop

```shell
pnpm devtop
```

On a headless machine, use `pnpm build`, the standalone service package
commands, or a virtual display. Running the Tauri window requires a graphical
session and working WebKitGTK installation.

## Android with Capacitor

Android builds can run on Windows, macOS, or Linux. They build only the mobile
client and do not require Rust, Tauri system libraries, Codex, or the Cantrip
Code toolchain.

Cantrip uses Capacitor 8.5, Android Gradle Plugin 8.13, Gradle 8.14.3, and Android
SDK 36. The checked-in application supports Android API 24 and newer.

### Prerequisites

Install:

1. Node.js 24 and pnpm 11.15.1.
2. [Android Studio](https://developer.android.com/studio) 2025.2.1 or newer.
3. From Android Studio's SDK Manager: Android SDK Platform 36, matching build
   tools, platform tools, and command-line tools.

Android Studio supplies a compatible JDK; a separate system JDK is unnecessary
when Gradle uses Android Studio's bundled runtime. Capacitor's maintained
requirements are in its
[environment setup guide](https://capacitorjs.com/docs/getting-started/environment-setup#android-requirements).

The native Android project is already checked in. Do not run `cap add android`.
Synchronize the built web client and Capacitor configuration:

```shell
pnpm install --frozen-lockfile
pnpm --filter @cantrip/app cap:sync
```

Open Android Studio:

```shell
pnpm --filter @cantrip/app cap:open:android
```

Or compile a debug APK directly.

On macOS/Linux:

```shell
cd cantrip_app/android
./gradlew assembleDebug
```

On Windows PowerShell:

```powershell
cd cantrip_app\android
.\gradlew.bat assembleDebug
```

The debug APK is written below
`cantrip_app/android/app/build/outputs/apk/debug/`. For a Play Store bundle:

```shell
cd cantrip_app/android
./gradlew bundleRelease
```

Release distribution additionally requires a private Android signing key and
release signing configuration. Those credentials must remain outside Git.

Use an API 24+ emulator or physical device for testing. The mobile client must
be configured through its server switcher to reach a separately running
Cantrip server; `localhost` on a phone or emulator is not the desktop builder.

## iOS with Capacitor

iOS compilation requires macOS. Cantrip uses Capacitor 8.5 with Swift Package
Manager, targets iOS 15 and newer, and requires Xcode 26 or newer. CocoaPods is
not required for the checked-in project.

The current Capacitor requirements are documented in the
[Capacitor iOS environment guide](https://capacitorjs.com/docs/getting-started/environment-setup#ios-requirements).

### Prerequisites

Install and launch Xcode, then select it for command-line builds:

```shell
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
xcodebuild -version
```

The native iOS project is already checked in. Do not run `cap add ios`.
Synchronize web assets and Swift package configuration:

```shell
pnpm install --frozen-lockfile
pnpm --filter @cantrip/app cap:sync
```

Open the project:

```shell
pnpm --filter @cantrip/app cap:open:ios
```

Select the `App` scheme and an iOS simulator, then build or run from Xcode. A
simulator build does not require an Apple Developer signing identity. Device,
archive, TestFlight, and App Store builds require an Apple Developer team,
bundle identifier provisioning, and distribution signing managed through
Xcode.

As on Android, the iOS application is only a client. Test it against a Cantrip
server reachable from the simulator or device rather than assuming the device's
`localhost` is the development Mac.

## Clean rebuilds

Use the focused clean commands before deleting broad dependency trees:

```shell
pnpm codex:clean
pnpm code:clean
```

Rust outputs can be cleaned independently when necessary:

```shell
cargo clean --manifest-path cantrip_cli/Cargo.toml
cargo clean --manifest-path cantrip_app/src-tauri/Cargo.toml
```

Reinstall JavaScript dependencies only when lockfile or installation state is
suspect:

```shell
pnpm install --frozen-lockfile --force
```

Avoid deleting `.cantrip/` while diagnosing compilation. It contains local
runtime data rather than compiler output.
