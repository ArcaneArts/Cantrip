export function liveResourceRefreshInterval(
  resourcesLive: boolean,
  fallbackInterval: number | false,
): number | false {
  return resourcesLive ? false : fallbackInterval;
}
