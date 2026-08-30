import {
  DEFAULT_ELITE_REVEAL_CONFIG,
  EliteReveal,
  type EliteRevealConfig,
} from "@cantrip/glitch";
import {
  Activity,
  AppWindow,
  ArrowRight,
  Bot,
  Box,
  Braces,
  CalendarClock,
  Check,
  CirclePause,
  Cloud,
  Code2,
  Columns3,
  Command,
  ExternalLink,
  FolderTree,
  GitBranch,
  GitPullRequest,
  Globe2,
  Layers3,
  Laptop,
  Link2,
  ListTodo,
  MessageSquare,
  Monitor,
  Moon,
  Network,
  PanelLeft,
  Play,
  Route,
  Server,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Sun,
  TerminalSquare,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  SITE_REDUCED_MOTION_GLITCH_CONFIG,
  usePrefersReducedMotion,
} from "./site-glitch";

type ThemeMode = "system" | "light" | "dark";
type DemoTab = "editor" | "agents" | "terminal" | "git";

const GITHUB_URL = "https://github.com/ArcaneArts/Cantrip";
const APP_URL = "https://app.cantrip.art";

const surfaces: Array<{
  description: string;
  icon: LucideIcon;
  meta: string;
  title: string;
}> = [
  {
    icon: Code2,
    title: "Code editor",
    meta: "MONACO · PREVIEW · PERSISTENT",
    description:
      "Edit with Monaco, keep drafts, cursor, scroll, and undo state across tabs, and guard every save against stale revisions.",
  },
  {
    icon: FolderTree,
    title: "Project explorer",
    meta: "LAZY TREE · GRAPH · PREVIEW",
    description:
      "Browse a Git-aware lazy tree, inspect commit context, and preview source, Markdown, images, and media without leaving the IDE.",
  },
  {
    icon: TerminalSquare,
    title: "Real terminals",
    meta: "PTY · ENCRYPTED · MOBILE",
    description:
      "Worker-owned shells with real color, clickable links, a mobile command bar, durable reconnect, and encrypted remote relay.",
  },
  {
    icon: GitBranch,
    title: "Git workspace",
    meta: "GRAPH · REVIEW · RECOVERY",
    description:
      "See commits, branches, worktrees, and code structure; stage by line or hunk, recover mistakes, and manage GitHub work.",
  },
  {
    icon: MessageSquare,
    title: "Built-in agents",
    meta: "TASKS · STEER · APPROVE",
    description:
      "Structured Tasks, plans, reasoning, tools, subagents, approvals, attachments, GitHub references, and a linked live Codex console.",
  },
  {
    icon: AppWindow,
    title: "Full VS Code workbench",
    meta: "EXTENSIONS · TERMINALS · PERSISTENT",
    description:
      "Open a warm, worker-hosted VS Code environment with durable settings, extensions, terminals, theme, and project context.",
  },
  {
    icon: Globe2,
    title: "Browser & desktop",
    meta: "CHROMIUM · DISPLAY · INPUT",
    description:
      "Run full worker Chromium sessions, then see and control a worker display or application when the job needs a human hand.",
  },
  {
    icon: Network,
    title: "Project tunnels",
    meta: "LOCAL · RELAYED",
    description:
      "Expose explicit worker-local services through guarded, server-routed tunnels without opening inbound ports.",
  },
];

const ideHighlights: Array<{
  description: string;
  features: string[];
  icon: LucideIcon;
  label: string;
  title: string;
}> = [
  {
    icon: Code2,
    label: "COMPLETE EDITOR",
    title: "Write code in an IDE—not a chat window with a file pane.",
    description:
      "Cantrip pairs a fast built-in editor and rich previews with a complete, persistent VS Code workbench when you need the full environment.",
    features: [
      "Monaco editing with durable drafts, cursor, scroll, and undo state",
      "Git-aware Explorer with source, Markdown, image, and media previews",
      "Warm VS Code sessions with settings, extensions, and terminals",
    ],
  },
  {
    icon: TerminalSquare,
    label: "REAL TOOLCHAIN",
    title: "The shell, source tree, and Git history stay within reach.",
    description:
      "Use the same worker-owned files, PTYs, worktrees, Git graph, and GitHub workflow whether you are editing yourself or delegating a change.",
    features: [
      "Real reconnectable terminals with encrypted remote relay",
      "Line and hunk staging, conflicts, recovery, issues, and pull requests",
      "Isolated worktrees that keep parallel changes off Primary",
    ],
  },
  {
    icon: Bot,
    label: "AGENTS BUILT IN",
    title: "Delegate from inside the environment that understands the work.",
    description:
      "Agents get validated project, lane, worker, worktree, policy, and target context through managed MCP while you retain explicit control.",
    features: [
      "Default, Plan, and Goal modes with steer, queue, pause, and approval",
      "Structured Tasks, attachments, tools, subagents, and durable history",
      "CodeGraph plus authorized file, terminal, browser, and client controls",
    ],
  },
  {
    icon: Smartphone,
    label: "ONE IDE, EVERYWHERE",
    title: "Keep the same workspace across machines and devices.",
    description:
      "Start local on one desktop or connect a hosted control plane to every machine that owns code, then reach it from desktop, web, iOS, or Android.",
    features: [
      "Native desktop, browser, and mobile clients with QR handoff",
      "Persistent tabs and live state across connected clients",
      "Browser, remote desktop, Code, shares, and tunnels with relay fallback",
    ],
  },
];

const agentFeatures = [
  "Choose Default, Plan, Goal, and model per message",
  "Steer active work or sort, edit, freeze, and send queued prompts",
  "Pause at a safe boundary without losing buffered work",
  "Use slash commands, skills, hooks, approvals, and attachments",
  "Give agents managed MCP context for policies, worktrees, and targets",
  "Operate authorized Explorer, Terminal, Browser, and client surfaces",
  "Toggle into the exact linked Codex console whenever you want it",
  "Fork at any message, rename, duplicate, compact, and pop out chats",
];

const routes = [
  { label: "ChatGPT account A", state: "Preferred", tone: "cyan" },
  { label: "ChatGPT account B", state: "Fallback", tone: "violet" },
  { label: "OpenRouter / API", state: "Fallback", tone: "lime" },
];

const capabilityGroups: Array<{
  description: string;
  features: string[];
  icon: LucideIcon;
  label: string;
  title: string;
}> = [
  {
    icon: Layers3,
    label: "ORGANIZE",
    title: "A workspace that stays coherent",
    description:
      "Mix every project surface in one ordered sidebar, group related tabs, drag to reorganize, and pop complete groups into their own desktop windows.",
    features: [
      "Persistent cross-device tab groups",
      "Chats, terminals, Code, Git, browser, and Explorer together",
      "Per-window active tabs with server-owned ordering",
    ],
  },
  {
    icon: GitPullRequest,
    label: "SHIP",
    title: "A serious Git client around the agent",
    description:
      "Keep Primary calm while agent-managed chats acquire isolated worktrees and ship reviewable pull requests.",
    features: [
      "Branch graph, tags, worktree HEADs, and WIP rows",
      "Line and hunk staging, conflicts, stashes, bisect, and recovery",
      "GitHub issues, PR review, releases, signatures, LFS, and submodules",
    ],
  },
  {
    icon: Workflow,
    label: "AUTOMATE",
    title: "Durable workflows, not fragile macros",
    description:
      "Compose agent, verification, approval, condition, map, pipeline, and repeat-until nodes with explicit budgets and recovery.",
    features: [
      "Schedules, webhooks, Git events, APIs, and saved commands",
      "Pause, cancel, retry, approvals, and bounded concurrency",
      "Trusted unattended revisions with permission manifests",
    ],
  },
  {
    icon: Server,
    label: "DEPLOY",
    title: "Local by default. Distributed when needed.",
    description:
      "Run everything on one desktop or connect the same app to a hosted control plane and workers on every machine that owns code.",
    features: [
      "Embedded desktop server and worker",
      "Account-mode PostgreSQL server and enrolled workers",
      "Native desktop, web, iOS, and Android clients with QR handoff",
    ],
  },
];

const toolkitFeatures: Array<{
  description: string;
  features: string[];
  icon: LucideIcon;
  label: string;
  title: string;
}> = [
  {
    icon: FolderTree,
    label: "EXPLORE & EDIT",
    title: "A file tree that understands the checkout",
    description:
      "Explorer loads directories on demand, streams rich previews, and connects the tree to live Git and repository-graph context.",
    features: [
      "Source, rendered Markdown, image, and media preview",
      "Persistent Monaco editing with guarded saves",
      "CodeGraph and commit overlays stay aligned with worktrees",
    ],
  },
  {
    icon: Code2,
    label: "FULL IDE",
    title: "Cantrip Code stays warm",
    description:
      "Keep a complete worker-hosted workbench beside the chat instead of rebuilding editor context for every task.",
    features: [
      "Project and worktree-aware sessions",
      "Persistent settings, extensions, terminals, and theme",
      "Direct local desktop transport with relay fallback",
    ],
  },
  {
    icon: Command,
    label: "MCP + CANTRIP CLI",
    title: "Managed tools first. A narrow CLI alongside them.",
    description:
      "Cantrip injects a worker-owned MCP server into compatible Codex chats. The worker-authenticated CLI remains available to people, scripts, and fallback runtimes.",
    features: [
      "Validated project, policy, worktree, and target context",
      "Bounded Explorer, Terminal, Browser, and client controls",
      "CLI support for diagnostics, scripts, and manual operation",
    ],
  },
  {
    icon: Network,
    label: "LIVE TRANSPORT",
    title: "Live when connected. Recoverable when interrupted.",
    description:
      "AppLive pushes committed state while protected surface transports choose the shortest authorized path without weakening the control plane.",
    features: [
      "Git, provider, CodeGraph, chat, and worker-log live updates",
      "Direct PTY, project share, Code, and tunnel streams",
      "Authenticated relay fallback with bounded reconnect recovery",
    ],
  },
];

const gitDetails: Array<{
  description: string;
  icon: LucideIcon;
  title: string;
}> = [
  {
    icon: GitBranch,
    title: "Shape the change",
    description:
      "Stage whole files, individual hunks, or selected lines; compare arbitrary revisions and trace file history or blame.",
  },
  {
    icon: ShieldCheck,
    title: "Resolve without guessing",
    description:
      "Continue merges and rebases, resolve conflicts, recover lost work, and protect published history from unsafe rewrites.",
  },
  {
    icon: GitPullRequest,
    title: "Review through release",
    description:
      "Create and review pull requests, follow conversations and checks, merge deliberately, and manage tags and releases.",
  },
];

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem("cantrip-site-theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  });

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = resolveTheme(mode);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };

    apply();
    if (mode === "system") media.addEventListener("change", apply);
    localStorage.setItem("cantrip-site-theme", mode);

    return () => media.removeEventListener("change", apply);
  }, [mode]);

  return { mode, setMode };
}

function ThemeSettings({
  mode,
  setMode,
}: {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const choices: Array<{ icon: LucideIcon; label: string; value: ThemeMode }> =
    [
      { icon: Laptop, label: "System", value: "system" },
      { icon: Sun, label: "Light", value: "light" },
      { icon: Moon, label: "Dark", value: "dark" },
    ];

  return (
    <div className="theme-settings" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Open appearance settings"
        className="icon-button"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {open ? <X size={18} /> : <Settings2 size={18} />}
      </button>
      {open && (
        <div
          aria-label="Appearance settings"
          className="settings-popover"
          role="dialog"
        >
          <div className="settings-heading">
            <span>Appearance</span>
            <small>Default follows your system</small>
          </div>
          <div className="theme-options">
            {choices.map(({ icon: Icon, label, value }) => (
              <button
                aria-pressed={mode === value}
                className="theme-option"
                key={value}
                onClick={() => setMode(value)}
                type="button"
              >
                <Icon size={17} />
                <span>{label}</span>
                {mode === value && <Check className="option-check" size={15} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GlintMark() {
  return <span aria-hidden="true" className="glint-mark" />;
}

function Brand() {
  return (
    <a aria-label="Cantrip home" className="brand" href="#top">
      <span className="brand-mark" aria-hidden="true">
        <GlintMark />
      </span>
      <span>CANTRIP</span>
    </a>
  );
}

function EditorDemo() {
  const lines = [
    ["1", "export async function ship(change: Change) {"],
    ["2", "  const checks = await workspace.verify(change);"],
    ["3", ""],
    ["4", "  if (!checks.passed) return checks.explain();"],
    ["5", ""],
    ["6", "  return git.openPullRequest({"],
    ["7", "    change,"],
    ["8", '    review: "agent + human",'],
    ["9", "  });"],
    ["10", "}"],
  ];

  return (
    <div className="demo-pane editor-demo">
      <aside className="editor-explorer">
        <div className="editor-explorer-heading">
          <span>EXPLORER</span>
          <small>CANTRIP</small>
        </div>
        <div className="editor-tree-row folder open">
          <span>⌄</span> src
        </div>
        <div className="editor-tree-row active">
          <Braces size={11} /> workspace.ts
          <i>M</i>
        </div>
        <div className="editor-tree-row">
          <Braces size={11} /> agent.ts
        </div>
        <div className="editor-tree-row folder">
          <span>›</span> tests
        </div>
        <div className="editor-tree-row">
          <Box size={11} /> package.json
        </div>
        <div className="editor-outline">
          <span>OUTLINE</span>
          <small>ship(change)</small>
          <small>verify(change)</small>
        </div>
      </aside>
      <div className="editor-workbench">
        <div className="editor-tabbar">
          <span>
            <Braces size={11} /> workspace.ts <i />
          </span>
          <small>src / workspace.ts</small>
        </div>
        <div className="editor-code" aria-label="TypeScript editor preview">
          {lines.map(([number, code]) => (
            <div className={number === "4" ? "active-line" : ""} key={number}>
              <span>{number}</span>
              <code>{code || " "}</code>
            </div>
          ))}
        </div>
        <div className="editor-statusbar">
          <span>
            <GitBranch size={10} /> feat/agentic-ide*
          </span>
          <span>Ln 4, Col 3 · TypeScript · ✓</span>
        </div>
      </div>
    </div>
  );
}

function ChatDemo() {
  return (
    <div className="demo-pane chat-demo">
      <div className="message message-user">
        <span>YOU</span>
        <p>
          Trace the checkout with CodeGraph, then ship the fix in a worktree.
        </p>
      </div>
      <div className="message message-agent">
        <span>CANTRIP / CODEX</span>
        <p>
          I have the exact project, policy, worker, and target context through
          Cantrip MCP.
        </p>
        <div className="plan-row">
          <Check size={14} />
          <span>Context verified · worktree isolated</span>
        </div>
        <div className="plan-row active">
          <Play size={12} fill="currentColor" />
          <span>Query CodeGraph and inspect the change</span>
        </div>
        <div className="plan-row">
          <span className="step-dot" />
          <span>Run checks, open PR, focus review</span>
        </div>
      </div>
      <div className="composer-demo">
        <span className="mode-chip">
          <ListTodo size={13} /> Goal
        </span>
        <span className="composer-placeholder">Steer the task…</span>
        <Command size={15} />
      </div>
    </div>
  );
}

function TerminalDemo() {
  return (
    <div className="demo-pane terminal-demo">
      <div>
        <span className="prompt">❯</span> git worktree list
      </div>
      <div className="muted-line">
        /workspace/Cantrip&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;[main]
      </div>
      <div className="muted-line">
        /worktrees/unified-git&nbsp;&nbsp;[agent/manual/unified-git]
      </div>
      <br />
      <div>
        <span className="prompt">❯</span> cantrip status
      </div>
      <div className="muted-line">project Cantrip · worktree unified-git</div>
      <div className="muted-line">chat attached · worker local-mac</div>
      <br />
      <div>
        <span className="prompt">❯</span> pnpm check
      </div>
      <div className="terminal-pass">✓ checks passed</div>
      <div>
        <span className="prompt">❯</span> <span className="cursor-block" />
      </div>
    </div>
  );
}

function GitDemo() {
  return (
    <div className="demo-pane git-demo">
      <div className="git-toolbar">
        <div className="git-tabs">
          <strong>History</strong>
          <span>Issues</span>
          <span>PRs</span>
        </div>
        <button aria-label="Pull from remote" type="button">
          <GitPullRequest size={14} /> Pull
        </button>
      </div>
      {[
        ["c91e42a", "Make managed MCP primary", "2m"],
        ["83dd102", "Stream workspace state live", "18m"],
        ["f4a20b8", "Protect remote terminal relay", "1h"],
        ["a6001cd", "Add mobile terminal controls", "3h"],
      ].map(([hash, title, time], index) => (
        <div className="commit-row" key={hash}>
          <span className={`commit-node node-${index}`} />
          <div>
            <strong>{title}</strong>
            <small>{hash} · agent/manual</small>
          </div>
          <time>{time}</time>
        </div>
      ))}
    </div>
  );
}

function ProductDemo({ glitchConfig }: { glitchConfig: EliteRevealConfig }) {
  const [active, setActive] = useState<DemoTab>("editor");
  const [replayKey, setReplayKey] = useState(0);
  const tabs: Array<{ icon: LucideIcon; label: string; value: DemoTab }> = [
    { icon: Code2, label: "Editor", value: "editor" },
    { icon: Bot, label: "Agents", value: "agents" },
    { icon: TerminalSquare, label: "Terminal", value: "terminal" },
    { icon: GitBranch, label: "Git", value: "git" },
  ];

  return (
    <div
      className="product-stage"
      aria-label="Interactive Cantrip interface preview"
    >
      <div className="window-chrome">
        <div className="traffic-lights">
          <i />
          <i />
          <i />
        </div>
        <span>ArcaneArts / Cantrip</span>
        <span className="online">
          <i /> worker online
        </span>
      </div>
      <div className="product-body">
        <aside className="demo-sidebar">
          <div className="sidebar-logo">
            <GlintMark />
          </div>
          <button aria-label="Workspace" type="button">
            <PanelLeft size={16} />
          </button>
          <button aria-label="Code" type="button">
            <Code2 size={16} />
          </button>
          <button aria-label="Branches" type="button">
            <GitBranch size={16} />
          </button>
          <span />
          <button aria-label="Settings" type="button">
            <Settings2 size={16} />
          </button>
        </aside>
        <main className="demo-main">
          <div
            className="demo-tabs"
            role="tablist"
            aria-label="Preview surface"
          >
            {tabs.map(({ icon: Icon, label, value }) => (
              <button
                aria-selected={active === value}
                className={active === value ? "active" : ""}
                key={value}
                onClick={() => {
                  setActive(value);
                  setReplayKey((current) => current + 1);
                }}
                role="tab"
                type="button"
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
          <EliteReveal
            className="demo-reveal"
            config={glitchConfig}
            replayKey={replayKey}
          >
            {active === "editor" && <EditorDemo />}
            {active === "agents" && <ChatDemo />}
            {active === "terminal" && <TerminalDemo />}
            {active === "git" && <GitDemo />}
          </EliteReveal>
        </main>
      </div>
      <div className="stage-orbit orbit-a">
        <Bot size={17} />
      </div>
      <div className="stage-orbit orbit-b">
        <GitBranch size={16} />
      </div>
      <div className="stage-note">
        <Activity size={14} /> Live state follows every client
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="section-label">
      <span />
      {children}
    </div>
  );
}

function WorkflowBoard() {
  return (
    <div className="workflow-board" aria-label="Cantrip workflow example">
      <div className="workflow-topline">
        <span>
          <Activity size={14} /> Release readiness
        </span>
        <span className="workflow-state">
          <i /> RUNNING
        </span>
      </div>
      <div className="workflow-trigger">
        <CalendarClock size={17} />
        <div>
          <small>TRIGGER</small>
          <strong>Every weekday · 08:30</strong>
        </div>
      </div>
      <div className="workflow-flow">
        <div className="workflow-node active">
          <Bot size={17} />
          <span>Agent</span>
          <small>Inspect changes</small>
        </div>
        <ArrowRight size={15} />
        <div className="workflow-node complete">
          <Check size={17} />
          <span>Verify</span>
          <small>Tests + policy</small>
        </div>
        <ArrowRight size={15} />
        <div className="workflow-node waiting">
          <CirclePause size={17} />
          <span>Approval</span>
          <small>Wait for owner</small>
        </div>
      </div>
      <div className="workflow-footer">
        <span>Budget 38%</span>
        <span>2 / 4 nodes complete</span>
        <span>Worktree isolated</span>
      </div>
    </div>
  );
}

function App() {
  const { mode, setMode } = useTheme();
  const reducedMotion = usePrefersReducedMotion();
  const glitchConfig = reducedMotion
    ? SITE_REDUCED_MOTION_GLITCH_CONFIG
    : DEFAULT_ELITE_REVEAL_CONFIG;

  return (
    <div className="site-shell" id="top">
      <header className="site-header">
        <div className="header-inner">
          <Brand />
          <nav aria-label="Primary navigation">
            <a href="#workspace">IDE</a>
            <a href="#agents">Agents</a>
            <a href="#git">Git</a>
            <a href="#workflows">Automate</a>
            <a href="#architecture">Deploy</a>
          </nav>
          <div className="header-actions">
            <ThemeSettings mode={mode} setMode={setMode} />
            <a
              className="github-link"
              href={GITHUB_URL}
              rel="noreferrer"
              target="_blank"
            >
              <GitPullRequest size={17} /> <span>GitHub</span>
            </a>
            <a
              className="open-app-link"
              href={APP_URL}
              rel="noreferrer"
              target="_blank"
            >
              <AppWindow size={16} /> <span>Open app</span>
              <ArrowRight size={14} />
            </a>
          </div>
        </div>
      </header>

      <main>
        <section className="hero section-wrap">
          <div className="hero-copy">
            <EliteReveal
              config={glitchConfig}
              contentKind="text"
              index={0}
              replayKey={0}
            >
              <div className="status-line">
                <i /> EDITOR · TERMINALS · GIT · AGENTS · EVERY DEVICE
              </div>
            </EliteReveal>
            <EliteReveal
              className="hero-title-reveal"
              config={glitchConfig}
              contentKind="text"
              index={1}
              replayKey={0}
            >
              <h1>The last agentic IDE you’ll need.</h1>
            </EliteReveal>
            <EliteReveal
              config={glitchConfig}
              contentKind="text"
              index={2}
              replayKey={0}
            >
              <p className="hero-lede">
                Cantrip is a complete development environment where you and your
                agents edit, run, review, and ship together. Keep the editor,
                terminal, Git, browser, automation, and project context in one
                local-first IDE that follows you to every device.
              </p>
            </EliteReveal>
            <EliteReveal
              config={glitchConfig}
              contentKind="control"
              index={3}
              replayKey={0}
            >
              <div className="hero-actions">
                <a
                  className="button button-primary"
                  href={APP_URL}
                  rel="noreferrer"
                  target="_blank"
                >
                  <AppWindow size={18} /> Open the IDE <ArrowRight size={16} />
                </a>
                <a
                  className="button button-quiet"
                  href={GITHUB_URL}
                  rel="noreferrer"
                  target="_blank"
                >
                  <GitPullRequest size={17} /> View source
                </a>
              </div>
            </EliteReveal>
            <EliteReveal config={glitchConfig} index={4} replayKey={0}>
              <div className="hero-proof">
                <div>
                  <Code2 size={17} />
                  <span>
                    <strong>A complete editor at the center.</strong>
                    <small>
                      Monaco for speed. VS Code when you want it all.
                    </small>
                  </span>
                </div>
                <div>
                  <Bot size={17} />
                  <span>
                    <strong>Agents belong inside the IDE.</strong>
                    <small>
                      Delegate with context, then inspect every change.
                    </small>
                  </span>
                </div>
                <div>
                  <ShieldCheck size={17} />
                  <span>
                    <strong>Your source stays on your worker.</strong>
                    <small>Local-first, protected, and self-hostable.</small>
                  </span>
                </div>
              </div>
            </EliteReveal>
          </div>
          <EliteReveal config={glitchConfig} index={5} replayKey={0}>
            <ProductDemo glitchConfig={glitchConfig} />
          </EliteReveal>
        </section>

        <section
          className="deployment-rail"
          aria-label="Cantrip deployment modes"
        >
          <EliteReveal config={glitchConfig} index={6} replayKey={0}>
            <div className="section-wrap deployment-rail-inner">
              <span>
                <Code2 size={16} /> EDITOR + EXPLORER
              </span>
              <span>
                <TerminalSquare size={16} /> TERMINALS + GIT
              </span>
              <span>
                <Bot size={16} /> AGENTS + AUTOMATION
              </span>
              <span>
                <Smartphone size={16} /> DESKTOP + WEB + MOBILE
              </span>
            </div>
          </EliteReveal>
        </section>

        <section className="release-section section-wrap">
          <EliteReveal
            config={glitchConfig}
            contentKind="text"
            index={7}
            replayKey={0}
          >
            <div className="section-heading split-heading">
              <div>
                <SectionLabel>THE WHOLE DEVELOPMENT LOOP</SectionLabel>
                <h2>A real IDE first. Agentic all the way through.</h2>
              </div>
              <p>
                Cantrip starts with the tools developers already rely on, then
                makes agents, remote machines, and durable automation native to
                the same environment.
              </p>
            </div>
          </EliteReveal>
          <EliteReveal config={glitchConfig} index={8} replayKey={0}>
            <div className="release-grid">
              {ideHighlights.map(
                (
                  { description, features, icon: Icon, label, title },
                  index,
                ) => (
                  <article className="release-card" key={label}>
                    <div className="release-card-topline">
                      <span className="release-icon">
                        <Icon size={20} />
                      </span>
                      <small>{label}</small>
                      <span className="release-number">0{index + 1}</span>
                    </div>
                    <h3>{title}</h3>
                    <p>{description}</p>
                    <ul>
                      {features.map((feature) => (
                        <li key={feature}>
                          <Check size={13} /> {feature}
                        </li>
                      ))}
                    </ul>
                  </article>
                ),
              )}
            </div>
          </EliteReveal>
          <div className="release-footer">
            <span>
              <Activity size={14} /> BUILT IN THE OPEN
            </span>
            <p>
              This is the current product—not a mockup or a list of future
              promises.
            </p>
            <a href={`${GITHUB_URL}/releases`} rel="noreferrer" target="_blank">
              Browse releases <ExternalLink size={14} />
            </a>
          </div>
        </section>

        <section className="workspace-section section-wrap" id="workspace">
          <EliteReveal
            config={glitchConfig}
            contentKind="text"
            index={9}
            replayKey={0}
          >
            <div className="section-heading split-heading">
              <div>
                <SectionLabel>ONE COMPLETE IDE</SectionLabel>
                <h2>Everything serious software work touches.</h2>
              </div>
              <p>
                Edit directly, drop into a full workbench, run commands, inspect
                Git, and collaborate with agents without rebuilding context in a
                stack of disconnected tools.
              </p>
            </div>
          </EliteReveal>
          <EliteReveal config={glitchConfig} index={10} replayKey={0}>
            <div className="surface-grid">
              {surfaces.map(
                ({ description, icon: Icon, meta, title }, index) => (
                  <article
                    className={`surface-card surface-${index + 1}`}
                    key={title}
                  >
                    <div className="surface-icon">
                      <Icon size={21} />
                    </div>
                    <span className="surface-index">0{index + 1}</span>
                    <h3>{title}</h3>
                    <small className="surface-meta">{meta}</small>
                    <p>{description}</p>
                  </article>
                ),
              )}
            </div>
          </EliteReveal>
        </section>

        <section className="capabilities-section section-wrap">
          <EliteReveal
            config={glitchConfig}
            contentKind="text"
            index={11}
            replayKey={0}
          >
            <div className="section-heading split-heading">
              <div>
                <SectionLabel>THE IDE IS THE WORKFLOW</SectionLabel>
                <h2>From first edit to shipped change.</h2>
              </div>
              <p>
                Organization, source control, agents, automation, and deployment
                all share the same durable project context instead of becoming
                separate products you have to stitch together.
              </p>
            </div>
          </EliteReveal>
          <EliteReveal config={glitchConfig} index={12} replayKey={0}>
            <div className="capability-grid">
              {capabilityGroups.map(
                ({ description, features, icon: Icon, label, title }) => (
                  <article className="capability-card" key={label}>
                    <div className="capability-heading">
                      <span className="capability-icon">
                        <Icon size={19} />
                      </span>
                      <small>{label}</small>
                    </div>
                    <h3>{title}</h3>
                    <p>{description}</p>
                    <ul>
                      {features.map((feature) => (
                        <li key={feature}>
                          <Check size={13} /> {feature}
                        </li>
                      ))}
                    </ul>
                  </article>
                ),
              )}
            </div>
          </EliteReveal>
        </section>

        <section className="toolkit-section section-wrap" id="toolkit">
          <EliteReveal
            config={glitchConfig}
            contentKind="text"
            index={13}
            replayKey={0}
          >
            <div className="section-heading split-heading">
              <div>
                <SectionLabel>IDE-NATIVE TOOLKIT</SectionLabel>
                <h2>The editor, runtime, and agent share one workspace.</h2>
              </div>
              <p>
                Cantrip gives people and agents the same durable view of files,
                processes, editor state, and execution targets—without copying
                the repository into the control plane.
              </p>
            </div>
          </EliteReveal>
          <EliteReveal config={glitchConfig} index={14} replayKey={0}>
            <div className="toolkit-grid">
              {toolkitFeatures.map(
                (
                  { description, features, icon: Icon, label, title },
                  index,
                ) => (
                  <article
                    className={`toolkit-card toolkit-card-${index + 1}`}
                    key={label}
                  >
                    <div className="toolkit-card-heading">
                      <span>
                        <Icon size={20} />
                      </span>
                      <small>{label}</small>
                    </div>
                    <h3>{title}</h3>
                    <p>{description}</p>
                    <ul>
                      {features.map((feature) => (
                        <li key={feature}>
                          <Check size={13} /> {feature}
                        </li>
                      ))}
                    </ul>
                  </article>
                ),
              )}
            </div>
          </EliteReveal>
        </section>

        <section className="agent-section section-wrap" id="agents">
          <div className="agent-panel">
            <div className="agent-copy">
              <SectionLabel>AGENTS, BUILT IN</SectionLabel>
              <h2>
                Your agent belongs inside the IDE—not in a clone beside it.
              </h2>
              <p>
                Choose the right operating mode, give the agent exact Cantrip
                context, and stay in control while it works across the same
                files, terminals, Git state, and authorized targets you see.
              </p>
              <ul className="feature-checks">
                {agentFeatures.map((feature) => (
                  <li key={feature}>
                    <Check size={15} />
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
            <div className="mode-stack">
              <div className="mode-card mode-default">
                <div>
                  <Bot size={18} />
                  <span>Default</span>
                </div>
                <small>Move fast with the normal agent loop.</small>
                <span className="mode-key">⌘ ↵</span>
              </div>
              <div className="mode-card mode-plan">
                <div>
                  <ListTodo size={18} />
                  <span>Plan</span>
                </div>
                <small>Think together. Questions wait for you.</small>
                <span className="mode-key">ASK</span>
              </div>
              <div className="mode-card mode-goal">
                <div>
                  <Sparkles size={18} />
                  <span>Goal</span>
                </div>
                <small>Keep advancing toward a durable objective.</small>
                <span className="mode-key">RUN</span>
              </div>
              <div className="pause-line">
                <CirclePause size={16} /> Pause after the current safe boundary
              </div>
            </div>
          </div>
        </section>

        <section className="git-section section-wrap" id="git">
          <div className="git-visual" aria-hidden="true">
            <div className="branch-map">
              <div className="branch-row primary">
                <span />
                <strong>Primary</strong>
                <small>main · clean</small>
              </div>
              <div className="branch-connector" />
              <div className="branch-row agent">
                <span />
                <strong>Agent worktree</strong>
                <small>feat/git-view · 3 changes</small>
              </div>
              <div className="branch-connector short" />
              <div className="branch-row agent second">
                <span />
                <strong>Agent worktree</strong>
                <small>fix/queue-pause · checks passing</small>
              </div>
            </div>
            <div className="pr-card">
              <GitPullRequest size={20} />
              <div>
                <span>Pull request ready</span>
                <small>Isolated, reviewed, reversible.</small>
              </div>
              <Check size={16} />
            </div>
          </div>
          <div className="git-copy">
            <SectionLabel>GIT, BUILT IN</SectionLabel>
            <h2>Source control is part of the IDE, not an afterthought.</h2>
            <p>
              Cantrip understands branches, worktrees, staged and unstaged
              changes, history, issues, pull requests, submodules, LFS, and
              signatures. Work directly when you want, and keep Primary calm
              while every delegated task gets its own lane.
            </p>
            <div className="git-detail-list">
              {gitDetails.map(({ description, icon: Icon, title }) => (
                <article key={title}>
                  <Icon size={17} />
                  <div>
                    <h3>{title}</h3>
                    <p>{description}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="routing-section section-wrap">
          <div className="section-heading split-heading">
            <div>
              <SectionLabel>MODEL ROUTING</SectionLabel>
              <h2>Choose the model. Keep an escape route.</h2>
            </div>
            <p>
              Compose one logical model from ChatGPT accounts, OpenAI-compatible
              APIs, OpenRouter, and local Ollama endpoints. Cantrip moves down
              the route when quota or availability changes.
            </p>
          </div>
          <div className="routing-board">
            <div className="route-source">
              <div className="profile-icon">
                <Sparkles size={22} />
              </div>
              <span>Model profile</span>
              <strong>Best available</strong>
              <small>Reasoning: high</small>
            </div>
            <div className="route-lines" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div className="route-destinations">
              {routes.map((route) => (
                <div className="route-row" key={route.label}>
                  <span className={`route-dot ${route.tone}`} />
                  <strong>{route.label}</strong>
                  <small>{route.state}</small>
                </div>
              ))}
            </div>
            <div className="route-callout">
              <Route size={16} /> Cantrip records the route used for every turn.
            </div>
          </div>
        </section>

        <section className="workflow-section section-wrap" id="workflows">
          <div className="workflow-copy">
            <SectionLabel>WORKFLOWS &amp; AUTOMATIONS</SectionLabel>
            <h2>Turn repeatable work into durable systems.</h2>
            <p>
              Build automations from explicit steps instead of hiding the run in
              one giant prompt. Schedule them, trigger them from Git or an API,
              and keep a human approval exactly where it matters.
            </p>
            <div className="workflow-points">
              <span>
                <Zap size={16} /> Schedules, webhooks, Git events, and APIs
              </span>
              <span>
                <Workflow size={16} /> Agent, verify, condition, map, and repeat
              </span>
              <span>
                <ShieldCheck size={16} /> Budgets, permissions, and approvals
              </span>
            </div>
          </div>
          <WorkflowBoard />
        </section>

        <section
          className="architecture-section section-wrap"
          id="architecture"
        >
          <div className="architecture-copy">
            <SectionLabel>SELF-HOSTABLE BY DESIGN</SectionLabel>
            <h2>One control plane. Workers where the code lives.</h2>
            <p>
              The client talks to your Cantrip server, which keeps identity,
              encrypted workspace records, conversation history, configuration,
              live coordination, and routing. Workers keep source, processes,
              terminals, browsers, CodeGraph, and Code beside the machine that
              owns them.
            </p>
            <div className="architecture-points">
              <span>
                <Monitor size={15} /> Native macOS, Windows, and Linux desktop
                bundles
              </span>
              <span>
                <Smartphone size={15} /> Web, iOS, and Android clients with QR
                sign-in handoff
              </span>
              <span>
                <Link2 size={15} /> Embedded local mode or a PostgreSQL-backed
                hosted server
              </span>
              <span>
                <Network size={15} /> Reach every enrolled worker through one
                authenticated control plane
              </span>
              <span>
                <Activity size={15} /> Push Git, provider, CodeGraph, chat, and
                worker state over one recoverable live channel
              </span>
            </div>
            <a
              href={`${GITHUB_URL}#architecture`}
              rel="noreferrer"
              target="_blank"
            >
              Read the architecture <ExternalLink size={15} />
            </a>
          </div>
          <div className="architecture-map">
            <div className="arch-node clients">
              <Columns3 size={20} />
              <span>Clients</span>
              <small>Tauri · Web · iOS · Android</small>
            </div>
            <div className="arch-link">
              <i />
              <span>HTTP + WS</span>
            </div>
            <div className="arch-node server">
              <Cloud size={20} />
              <span>Server</span>
              <small>
                PGlite / PostgreSQL · Identity · History · Live routing
              </small>
            </div>
            <div className="arch-link">
              <i />
              <span>Worker channel</span>
            </div>
            <div className="arch-workers">
              <div className="arch-node worker">
                <Box size={18} />
                <span>Desktop worker</span>
                <small>Codex · MCP · CodeGraph · Git · PTY</small>
              </div>
              <div className="arch-node worker">
                <Box size={18} />
                <span>Remote worker</span>
                <small>Files · Browser · Desktop</small>
              </div>
            </div>
          </div>
        </section>

        <section className="closing-section section-wrap">
          <div className="closing-mark">
            <GlintMark />
          </div>
          <SectionLabel>ONE IDE FOR THE WHOLE BUILD</SectionLabel>
          <h2>
            Make this the last agentic IDE
            <br />
            you have to switch to.
          </h2>
          <p>
            Your editor, agents, terminals, Git, browsers, and automations are
            ready in the web app, native desktop workspace, or your own hosted
            control plane. Cantrip is open source and under active development.
          </p>
          <div className="closing-actions">
            <a
              className="button button-primary"
              href={APP_URL}
              rel="noreferrer"
              target="_blank"
            >
              <AppWindow size={18} /> Open the IDE <ArrowRight size={16} />
            </a>
            <a
              className="button button-quiet"
              href={GITHUB_URL}
              rel="noreferrer"
              target="_blank"
            >
              <GitPullRequest size={17} /> Explore the source
            </a>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="section-wrap footer-inner">
          <Brand />
          <p>The open-source, local-first agentic IDE.</p>
          <div>
            <a href={APP_URL} rel="noreferrer" target="_blank">
              App
            </a>
            <a href={GITHUB_URL} rel="noreferrer" target="_blank">
              GitHub
            </a>
            <a
              href={`${GITHUB_URL}/blob/main/README.md`}
              rel="noreferrer"
              target="_blank"
            >
              Docs
            </a>
          </div>
          <small>© {new Date().getFullYear()} Arcane Arts</small>
        </div>
      </footer>
    </div>
  );
}

export default App;
