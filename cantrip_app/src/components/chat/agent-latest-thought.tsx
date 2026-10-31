import { BrainCircuit } from "lucide-react";
import { useId } from "react";
import type { AgentInspectorThought } from "./inspect-model";

export const AGENT_INSPECT_THOUGHT_LINE_LIMIT = 3;

export function latestInspectorThoughtLines(value: string): string {
  return value
    .split(/\r\n|[\r\n]/u)
    .filter((line) => line.trim().length > 0)
    .slice(-AGENT_INSPECT_THOUGHT_LINE_LIMIT)
    .join("\n");
}

export function AgentLatestThought({
  thought,
  className,
}: {
  thought: AgentInspectorThought | null;
  className?: string;
}) {
  const headingId = useId();
  if (!thought) return null;
  return (
    <section aria-labelledby={headingId} className={className}>
      <div className="flex items-center gap-2">
        <BrainCircuit className="size-3.5 text-violet-500" />
        <h3
          className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          id={headingId}
        >
          Latest thought
        </h3>
      </div>
      <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-5 text-foreground/85 animate-in fade-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none">
        {latestInspectorThoughtLines(thought.text)}
      </p>
    </section>
  );
}
