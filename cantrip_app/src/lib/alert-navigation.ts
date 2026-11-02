import { projectAlertTargetSchema, type ProjectAlert } from "@cantrip/protocol";
import { useEffect, type RefObject } from "react";
import { z } from "zod";
import { getClientSession } from "./client-session";
const eventName = "cantrip:alert-navigation";
const fallback = new Map<string, string>();
const schema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string(),
    target: projectAlertTargetSchema,
    task: z.boolean(),
    createdAt: z.number(),
  })
  .strict();
export type AlertNavigation = z.infer<typeof schema>;
function key(projectId: string) {
  const session = getClientSession();
  return session
    ? `cantrip.alert-navigation.${encodeURIComponent(session.serverId)}.${encodeURIComponent(session.user.id)}.${encodeURIComponent(projectId)}`
    : null;
}
export function readAlertNavigation(projectId: string): AlertNavigation | null {
  const storageKey = key(projectId);
  if (!storageKey) return null;
  try {
    const raw = fallback.get(storageKey) ?? localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success &&
      parsed.data.projectId === projectId &&
      Date.now() - parsed.data.createdAt < 60000
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}
export function requestAlertNavigation(
  alert: ProjectAlert,
  task: boolean,
): void {
  const storageKey = key(alert.projectId);
  if (!storageKey) return;
  const serialized = JSON.stringify({
    id: crypto.randomUUID(),
    projectId: alert.projectId,
    target: alert.target,
    task,
    createdAt: Date.now(),
  });
  try {
    localStorage.setItem(storageKey, serialized);
    fallback.delete(storageKey);
  } catch {
    fallback.set(storageKey, serialized);
  }
  window.dispatchEvent(new Event(eventName));
}
export function subscribeAlertNavigation(callback: () => void) {
  window.addEventListener(eventName, callback);
  window.addEventListener("storage", callback);
  window.addEventListener("focus", callback);
  return () => {
    window.removeEventListener(eventName, callback);
    window.removeEventListener("storage", callback);
    window.removeEventListener("focus", callback);
  };
}
export function revealAlertDestination(
  root: HTMLElement,
  navigation: AlertNavigation,
): boolean {
  const target = navigation.target;
  let element: HTMLElement | undefined | null;
  if (target.kind === "interaction")
    element = Array.from(
      root.querySelectorAll<HTMLElement>("[data-interaction-request-id]"),
    ).find((e) => e.dataset.interactionRequestId === target.requestId);
  else if (target.kind === "goal")
    element = root.querySelector<HTMLElement>('[data-slot="goal-panel"]');
  else if (target.kind === "task")
    element =
      target.section === "questions"
        ? root.querySelector<HTMLElement>("#task-questions-heading")
        : root.querySelector<HTMLElement>('[aria-label="Overview"]');
  else if (target.turnId)
    element = Array.from(
      root.querySelectorAll<HTMLElement>("[data-turn-id]"),
    ).find((e) => e.dataset.turnId === target.turnId);
  else element = root.querySelector<HTMLElement>("textarea");
  if (
    !element ||
    element.closest('[aria-hidden="true"],[inert]') ||
    !element.getClientRects().length
  )
    return false;
  element.scrollIntoView({ block: "center" });
  element.tabIndex = -1;
  element.focus({ preventScroll: true });
  return true;
}
export function useAlertDestinationReveal(
  projectId: string | null,
  chatId: string,
  root: RefObject<HTMLElement | null>,
  onRequest?: () => void,
) {
  useEffect(() => {
    let observer: MutationObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      observer?.disconnect();
      if (timer) clearTimeout(timer);
    };
    const receive = () => {
      if (!projectId) return;
      const navigation = readAlertNavigation(projectId);
      if (!navigation || navigation.target.chatId !== chatId || !root.current)
        return;
      stop();
      onRequest?.();
      const attempt = () => {
        if (!root.current || !revealAlertDestination(root.current, navigation))
          return;
        const storageKey = key(projectId);
        if (
          storageKey &&
          readAlertNavigation(projectId)?.id === navigation.id
        ) {
          fallback.delete(storageKey);
          try {
            localStorage.removeItem(storageKey);
          } catch {}
        }
        stop();
      };
      observer = new MutationObserver(attempt);
      observer.observe(root.current, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      timer = setTimeout(
        stop,
        Math.max(1, 60000 - (Date.now() - navigation.createdAt)),
      );
      attempt();
    };
    const unsubscribe = subscribeAlertNavigation(receive);
    receive();
    return () => {
      stop();
      unsubscribe();
    };
  }, [projectId, chatId, root, onRequest]);
}
