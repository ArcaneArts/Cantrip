# Expected Behavior

- The first bounded health request traverses the loopback listener, selected
  direct or relay route, worker protected-target router, and Code endpoint.
- A connected but unusable direct data path degrades and retries through the
  managed relay rather than trapping every request on the broken route.
- Once transport and upstream OpenVSCode are actually healthy, the embedded
  workbench mounts and opens the exact Explorer-selected file inside the
  server-authorized workspace.
- Readiness distinguishes listener, route, protected endpoint, upstream HTTP,
  iframe load, and workbench control readiness.
- Every failure reports a safe correlated stage and reason before cleanup,
  without tokens, protected records, credentials, or sensitive paths.
