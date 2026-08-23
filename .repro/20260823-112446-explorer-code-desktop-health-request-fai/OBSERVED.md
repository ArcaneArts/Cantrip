# Observed Behavior

- OpenVSCode Server starts and its process identity is reused on the next
  attempt.
- The server creates a Code session, one managed protected tunnel, and a
  separate desktop attachment to that tunnel.
- The direct capability WebSocket authenticates and native setup reports
  `routeState=local-direct`.
- No successful `code.direct.prepared`, `tunnel.destination.opening`, or
  `tunnel.destination.connected` event follows the first health request.
- The desktop health request fails with WebKit `TypeError: Load failed` after a
  sequence of quickly rejected attempts.
- Cleanup aborts the native forward; the worker subsequently observes WebSocket
  close code `1006`. This is a teardown consequence, not the initiating error.
- The prewarm path never mounts its iframe. The manual click likewise fails
  before the requested file can be opened in the workbench.
- Existing logs do not distinguish whether the request failed before native
  accept, before worker DirectBroker receipt, or during protected-target
  validation/endpoint preparation.
