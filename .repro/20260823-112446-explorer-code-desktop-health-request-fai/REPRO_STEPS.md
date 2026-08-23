# Reproduction Steps

1. On macOS, start the local Cantrip development stack with `pnpm devtop` and
   wait for the local server, client, worker, desktop application, Cantrip Code
   workbench bridge, and direct capability broker to report ready.
2. Open a project whose Explorer is attached to the local worker. Allow the
   automatic desktop Explorer Code prewarm to run.
3. Observe that the worker launches OpenVSCode Server and that the server
   creates the protected Code tunnel plus desktop tunnel attachment.
4. Observe that the desktop direct capability authenticates and reports
   `routeState=local-direct`, but the first Code health request never reaches a
   successful protected Code endpoint. The client reports `TypeError: Load
failed` and tears down the tunnel and Code session.
5. Click a source file in the Explorer sidebar.
6. Observe the same failed readiness sequence. The cached OpenVSCode process is
   reused, but the editor iframe is never mounted and the selected file is never
   sent to the workbench bridge.

## Pinned captured environment

- Cantrip: `1.1.971`
- Cantrip Code/OpenVSCode Server: `1.109.5`
- Cantrip Code build: `531efd29c6a7`
- Codex: `0.148.0`
- Selected worker: `local-MaxBook-Pro.local`
- Server: `http://127.0.0.1:4310/`
- Platform: macOS arm64

The two supplied logs are preserved as run artifacts. They predate the Cycle 1
correlated telemetry and therefore prove the stable visible failure, but cannot
select among the missing native-delivery and worker protected-target stages.
