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
  Database,
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

type ThemeMode = "system" | "light" | "dark";
type DemoTab = "chat" | "terminal" | "git";

const GITHUB_URL = "https://github.com/ArcaneArts/Cantrip";
const APP_URL = "https://app.cantrip.art";

const surfaces: Array<{
  description: string;
  icon: LucideIcon;
  meta: string;
  title: string;
}> = [
  {
    icon: MessageSquare,
    title: "Codex chats",
    meta: "TASKS · STEER · APPROVE",
    description:
      "Structured Tasks, plans, reasoning, tools, subagents, approvals, attachments, GitHub references, and a linked live Codex console.",
  },
  {
    icon: TerminalSquare,
    title: "Real terminals",
    meta: "PTY · ENCRYPTED · MOBILE",
    description:
      "Worker-owned shells with real color, clickable links, a mobile command bar, durable reconnect, and encrypted remote relay.",
  },
  {
    icon: Code2,
    title: "Cantrip Code",
    meta: "VSCODE · DIRECT · PERSISTENT",
    description:
      "A worker-hosted VS Code workbench with durable settings, extensions, terminals, theme, and project context.",
  },
  {
    icon: FolderTree,
    title: "Project explorer",
    meta: "LAZY TREE · GRAPH · EDIT",
    description:
      "Browse a Git-aware lazy tree and repository graph, stream previews, and edit supported files in a persistent editor.",
  },
  {
    icon: Globe2,
    title: "Browser tabs",
    meta: "CHROMIUM · STREAMED",
    description:
      "Full worker Chromium sessions—not iframes—with navigation, clipboard, and durable reconnect behavior.",
  },
  {
    icon: Monitor,
    title: "Remote desktop",
    meta: "DISPLAY · INPUT",
    description:
      "Pick a display or application window, then see and control the worker when a task needs a human hand.",
  },
  {
    icon: GitBranch,
    title: "Git workspace",
    meta: "GRAPH · REVIEW · RECOVERY",
    description:
      "See commits, branches, worktrees, and code structure; stage by line or hunk, recover mistakes, and manage GitHub work.",
  },
  {
    icon: Network,
    title: "Project tunnels",
    meta: "LOCAL · RELAYED",
    description:
      "Expose explicit worker-local services through guarded, server-routed tunnels without opening inbound ports.",
  },
];

const releaseHighlights: Array<{
  description: string;
  features: string[];
  icon: LucideIcon;
  label: string;
  title: string;
}> = [
  {
    icon: Braces,
    label: "AGENT-NATIVE MCP",
    title: "Cantrip is now part of the agent’s toolbelt.",
    description:
      "Every compatible Codex chat receives a worker-owned managed MCP connection with validated project, lane, worker, worktree, policy, and target context.",
    features: [
      "Inspect policies, worktrees, files, terminals, and browser targets",
      "Write through Explorer and control authorized live surfaces",
      "Focus the right project, surface, or pending interaction in the app",
    ],
  },
  {
    icon: ShieldCheck,
    label: "PRIVATE + LIVE",
    title: "Protected state moves without becoming server plaintext.",
    description:
      "The recent account-mode encryption work now covers workspace identity, Tasks, and private surface state while AppLive keeps clients synchronized as work changes.",
    features: [
      "End-to-end encrypted workspace labels and Task content",
      "Protected Terminal, Explorer, Browser, and Desktop state",
      "Live Git, CodeGraph, provider, chat, and worker-log updates",
    ],
  },
  {
    icon: Network,
    label: "CODE INTELLIGENCE",
    title: "Repository structure is visible—and queryable.",
    description:
      "Managed CodeGraph follows project worktrees and stays available to agents as a read-only MCP, paired with an interactive repository graph for people.",
    features: [
      "Live indexing and status across compatible workers",
      "Repository graph overlays for files, folders, and commits",
      "Semantic project context exposed without replacing normal tools",
    ],
  },
  {
    icon: Smartphone,
    label: "REMOTE DAILY DRIVER",
    title: "Mobile and Windows have real recovery paths.",
    description:
      "Remote work is smoother from the first connection through the last terminal command, with platform-specific affordances and actionable setup recovery.",
    features: [
      "Mobile terminal command bar, haptics, links, and touch recovery",
      "Encrypted remote terminal connections with local-direct fallback",
      "Windows CodeGraph setup, share reveal, and long-path guidance",
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

function Brand() {
  return (
    <a aria-label="Cantrip home" className="brand" href="#top">
      <span className="brand-mark" aria-hidden="true">
        <Sparkles size={19} />
      </span>
      <span>CANTRIP</span>
    </a>
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

function ProductDemo() {
  const [active, setActive] = useState<DemoTab>("chat");
  const tabs: Array<{ icon: LucideIcon; label: string; value: DemoTab }> = [
    { icon: Bot, label: "Chat", value: "chat" },
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
            <Sparkles size={16} />
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
                onClick={() => setActive(value)}
                role="tab"
                type="button"
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
          {active === "chat" && <ChatDemo />}
          {active === "terminal" && <TerminalDemo />}
          {active === "git" && <GitDemo />}
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

  return (
    <div className="site-shell" id="top">
      <header className="site-header">
        <div className="header-inner">
          <Brand />
          <nav aria-label="Primary navigation">
            <a href="#latest">Latest</a>
            <a href="#workspace">Surfaces</a>
            <a href="#toolkit">Tooling</a>
            <a href="#agents">Agents</a>
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
            <div className="status-line">
              <i /> MANAGED MCP · LIVE STATE · ENCRYPTED · CROSS-DEVICE
            </div>
            <h1>One workspace for the whole build.</h1>
            <p className="hero-lede">
              Give Codex a durable, agent-native workspace around the whole job:
              managed MCP, CodeGraph, editable files, real terminals, persistent
              VS Code, Git and GitHub, browsers, remote desktops, and
              automations—local-first and available from every device.
            </p>
            <div className="hero-actions">
              <a
                className="button button-primary"
                href={APP_URL}
                rel="noreferrer"
                target="_blank"
              >
                <AppWindow size={18} /> Open Cantrip <ArrowRight size={16} />
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
            <div className="hero-proof">
              <div>
                <ShieldCheck size={17} />
                <span>
                  <strong>Your source stays on your worker.</strong>
                  <small>Cantrip coordinates it.</small>
                </span>
              </div>
              <div>
                <Database size={17} />
                <span>
                  <strong>Private state stays protected.</strong>
                  <small>Keys stay with clients and authorized workers.</small>
                </span>
              </div>
              <div>
                <Braces size={17} />
                <span>
                  <strong>Managed MCP plus the Cantrip CLI.</strong>
                  <small>Agents get exact context and bounded controls.</small>
                </span>
              </div>
            </div>
          </div>
          <ProductDemo />
        </section>

        <section
          className="deployment-rail"
          aria-label="Cantrip deployment modes"
        >
          <div className="section-wrap deployment-rail-inner">
            <span>
              <Laptop size={16} /> LOCAL DESKTOP
            </span>
            <span>
              <Cloud size={16} /> HOSTED CONTROL PLANE
            </span>
            <span>
              <Server size={16} /> MULTIPLE WORKERS
            </span>
            <span>
              <Smartphone size={16} /> MOBILE HANDOFF
            </span>
          </div>
        </section>

        <section className="release-section section-wrap" id="latest">
          <div className="section-heading split-heading">
            <div>
              <SectionLabel>RECENT RELEASE TRAIN</SectionLabel>
              <h2>The foundations are turning into daily tools.</h2>
            </div>
            <p>
              Recent releases connected the agent, control plane, workers, and
              clients more tightly—while making remote and cross-platform work
              easier to trust and recover.
            </p>
          </div>
          <div className="release-grid">
            {releaseHighlights.map(
              ({ description, features, icon: Icon, label, title }, index) => (
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
          <div className="release-footer">
            <span>
              <Activity size={14} /> SHIPPING CONTINUOUSLY
            </span>
            <p>
              These capabilities are in the current release train—not future
              roadmap promises.
            </p>
            <a href={`${GITHUB_URL}/releases`} rel="noreferrer" target="_blank">
              Browse releases <ExternalLink size={14} />
            </a>
          </div>
        </section>

        <section className="workspace-section section-wrap" id="workspace">
          <div className="section-heading split-heading">
            <div>
              <SectionLabel>ONE WORKSPACE</SectionLabel>
              <h2>Every surface the work touches.</h2>
            </div>
            <p>
              Move between an agent and its environment without breaking context
              or reaching for another window.
            </p>
          </div>
          <div className="surface-grid">
            {surfaces.map(({ description, icon: Icon, meta, title }, index) => (
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
            ))}
          </div>
        </section>

        <section className="capabilities-section section-wrap">
          <div className="section-heading split-heading">
            <div>
              <SectionLabel>BUILT FOR THE WHOLE LOOP</SectionLabel>
              <h2>From first prompt to shipped change.</h2>
            </div>
            <p>
              Cantrip is the durable layer around the model: organization,
              source control, automation, and deployment all use the same
              project context.
            </p>
          </div>
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
        </section>

        <section className="toolkit-section section-wrap" id="toolkit">
          <div className="section-heading split-heading">
            <div>
              <SectionLabel>WORKER-NATIVE TOOLKIT</SectionLabel>
              <h2>The environment is part of the conversation.</h2>
            </div>
            <p>
              Cantrip gives people and agents the same durable view of files,
              processes, editor state, and execution targets—without copying the
              repository into the control plane.
            </p>
          </div>
          <div className="toolkit-grid">
            {toolkitFeatures.map(
              ({ description, features, icon: Icon, label, title }, index) => (
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
        </section>

        <section className="agent-section section-wrap" id="agents">
          <div className="agent-panel">
            <div className="agent-copy">
              <SectionLabel>AGENT CONTROL</SectionLabel>
              <h2>More than a prompt box—and more than a shell.</h2>
              <p>
                Give Codex the right operating mode and exact Cantrip context,
                then stay in control while it works across authorized targets.
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

        <section className="git-section section-wrap">
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
            <h2>Let agents work in parallel—not on top of each other.</h2>
            <p>
              Cantrip understands branches, worktrees, staged and unstaged
              changes, history, issues, pull requests, submodules, LFS, and
              signatures. Keep Primary calm while every task gets its own lane.
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
            <Sparkles size={29} />
          </div>
          <SectionLabel>THE WORKSPACE IS THE INTERFACE</SectionLabel>
          <h2>
            Give your agents somewhere
            <br />
            serious to work.
          </h2>
          <p>
            Open the web app, run the desktop workspace, or host the control
            plane yourself. Cantrip is open source and under active development.
          </p>
          <div className="closing-actions">
            <a
              className="button button-primary"
              href={APP_URL}
              rel="noreferrer"
              target="_blank"
            >
              <AppWindow size={18} /> Open Cantrip <ArrowRight size={16} />
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
          <p>Local-first tools for ambitious builds.</p>
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
