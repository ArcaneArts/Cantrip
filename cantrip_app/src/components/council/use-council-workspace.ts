import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import {
  createCouncilAgent,
  getCouncilChat,
  listCouncilAgents,
  updateCouncilAgent,
  type CouncilAgent,
} from "@/lib/api/council";
import { useAppLiveScope, useAppLiveStatus } from "@/lib/app-live-react";

const rosterKey = ["council", "agents"] as const;

export function useCouncilWorkspace(active: boolean) {
  const cache = useQueryClient();
  const liveStatus = useAppLiveStatus();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<{
    agentId: string;
    messageId: string | null;
  } | null>(null);
  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    setHistory(null);
  }, []);
  const openHistory = useCallback(
    (agentId: string, messageId: string | null = null) => {
      setSelectedId(agentId);
      setHistory({ agentId, messageId });
    },
    [],
  );
  const closeHistory = useCallback(() => setHistory(null), []);
  const [editor, setEditor] = useState<"new" | CouncilAgent | null>(null);
  const roster = useQuery({
    enabled: active,
    queryFn: listCouncilAgents,
    queryKey: rosterKey,
    refetchInterval: (query) =>
      active &&
      (liveStatus !== "live" ||
        query.state.data?.some(
          (agent) => agent.scratchStatus === "provisioning",
        ))
        ? 3_000
        : false,
  });
  const agent = roster.data?.find((item) => item.id === selectedId);
  const chat = useQuery({
    enabled: active && Boolean(agent),
    queryFn: () => getCouncilChat(selectedId!),
    queryKey: ["council", "chat", selectedId],
    refetchInterval: active && liveStatus !== "live" ? 3_000 : false,
  });
  useAppLiveScope(active && agent ? { kind: "chat", chatId: agent.id } : null);

  const save = useMutation({
    mutationFn: (input: { title: string; role: string; primary: boolean }) => {
      if (!editor) throw new Error("Open Council agent details first.");
      return editor === "new"
        ? createCouncilAgent(input.title, input.role)
        : updateCouncilAgent(editor, input);
    },
    onSuccess: (saved) => {
      cache.setQueryData<CouncilAgent[]>(rosterKey, (current = []) =>
        current.some((value) => value.id === saved.id)
          ? current.map((value) => (value.id === saved.id ? saved : value))
          : [...current, saved],
      );
      void cache.invalidateQueries({ queryKey: rosterKey });
      void cache.invalidateQueries({ queryKey: ["council", "chat", saved.id] });
      select(saved.id);
      setEditor(null);
    },
  });
  function showEditor(value: "new" | CouncilAgent | null) {
    save.reset();
    setEditor(value);
  }

  return {
    agent,
    chat,
    editor,
    roster,
    save,
    select,
    showEditor,
    history,
    openHistory,
    closeHistory,
  };
}

export type CouncilWorkspaceController = ReturnType<typeof useCouncilWorkspace>;
