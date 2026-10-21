import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  subscribeFileChangeActivity,
  visibleFileChanges,
  type FileChange,
} from "@/lib/file-change-activity";
import { useFileChangeShimmer } from "@/lib/file-change-preference";
import "./file-change-activity.css";

export function useFileChangeActivity({
  projectId,
  worktreeId,
  workerId,
}: {
  projectId: string | undefined;
  worktreeId: string | undefined;
  workerId: string | undefined;
}) {
  const root = useRef<HTMLElement>(null);
  const client = useQueryClient();
  const enabled = useFileChangeShimmer();
  useEffect(() => {
    if (!enabled || !projectId || !worktreeId || !workerId) return;
    const animations = new Map<HTMLElement, Animation>();
    let pending: FileChange[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = (element: HTMLElement, animation: Animation) => {
      if (animations.get(element) !== animation) return;
      animations.delete(element);
      element.removeAttribute("data-file-change-kind");
      element.style.removeProperty("--file-change-base");
    };
    const flush = () => {
      timer = undefined;
      const changes = pending;
      pending = [];
      if (
        !root.current ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      )
        return;
      const bounds = {
        top: 0,
        left: 0,
        bottom: window.innerHeight,
        right: window.innerWidth,
      };
      for (
        let parent: HTMLElement | null = root.current;
        parent;
        parent = parent.parentElement
      ) {
        const style = getComputedStyle(parent);
        const rect = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          bounds.top = Math.max(bounds.top, rect.top);
          bounds.bottom = Math.min(bounds.bottom, rect.bottom);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          bounds.left = Math.max(bounds.left, rect.left);
          bounds.right = Math.min(bounds.right, rect.right);
        }
      }
      const labels = new Map<string, HTMLElement>();
      for (const label of root.current.querySelectorAll<HTMLElement>(
        "[data-file-change-path]",
      )) {
        const rect = label.getBoundingClientRect();
        if (
          rect.width &&
          rect.height &&
          rect.bottom > bounds.top &&
          rect.top < bounds.bottom &&
          rect.right > bounds.left &&
          rect.left < bounds.right
        ) {
          labels.set(label.dataset.fileChangePath!, label);
        }
      }
      for (const [path, kind] of visibleFileChanges(
        changes,
        new Set(labels.keys()),
      )) {
        const label = labels.get(path)!;
        if (typeof label.animate !== "function") continue;
        const previous = animations.get(label);
        if (previous) {
          clear(label, previous);
          previous.cancel();
        }
        label.style.setProperty(
          "--file-change-base",
          getComputedStyle(label).color,
        );
        label.dataset.fileChangeKind = kind;
        const animation = label.animate(
          [
            { backgroundPosition: "150% 50%" },
            { backgroundPosition: "-50% 50%" },
          ],
          { duration: 1_200, easing: "ease-in-out", iterations: 1 },
        );
        animations.set(label, animation);
        animation.onfinish = () => clear(label, animation);
        animation.oncancel = () => clear(label, animation);
      }
    };
    const unsubscribe = subscribeFileChangeActivity(client, (activity) => {
      const notification = activity.notification;
      if (
        activity.workerId !== workerId ||
        notification.projectId !== projectId ||
        notification.worktreeId !== worktreeId ||
        !notification.changes?.length
      )
        return;
      pending = [...pending, ...notification.changes].slice(-2_000);
      // Coalesce notification bursts, including a commit touching many files.
      timer ??= setTimeout(flush, 80);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
      for (const [label, animation] of animations) {
        clear(label, animation);
        animation.cancel();
      }
    };
  }, [client, enabled, projectId, worktreeId, workerId]);
  return root;
}
