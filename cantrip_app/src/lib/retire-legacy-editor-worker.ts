/** Retire the removed editor's worker without touching application/PWA workers. */
export async function retireLegacyEditorWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    registrations
      .filter((registration) =>
        [
          registration.active,
          registration.installing,
          registration.waiting,
        ].some(
          (worker) =>
            worker &&
            new URL(worker.scriptURL).pathname.endsWith(
              "/cantrip-code-service-worker.js",
            ),
        ),
      )
      .map((registration) => registration.unregister()),
  );
}
