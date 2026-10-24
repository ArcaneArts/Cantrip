/** WebKit emits browser page errors for caught fetches cancelled by pagehide.
 * This is deliberately restricted to our explicit reload and known cleanup
 * endpoints on the fixture origin. Runtime-error listeners remain independent.
 */
export function isEditorReloadTeardownError({
  browser,
  reloadingRenderer,
  origin,
  message,
}) {
  if (browser !== "webkit" || !reloadingRenderer) return false;
  const prefix = `/${new URL(origin).host}/api/worker-links/`;
  if (!message.startsWith(prefix)) return false;
  return /^[\w-]+(?:\/peers(?:\/[\w-]+(?:\/signals)?)?|\/grants\/[\w-]+|\/telemetry)? due to access control checks\.$/u.test(
    message.slice(prefix.length),
  );
}
