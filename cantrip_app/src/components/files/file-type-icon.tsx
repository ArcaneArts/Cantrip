import type { ComponentType } from "react";
import SiRust from "@icons-pack/react-simple-icons/icons/SiRust";
import SiJavascript from "@icons-pack/react-simple-icons/icons/SiJavascript";
import SiTypescript from "@icons-pack/react-simple-icons/icons/SiTypescript";
import SiReact from "@icons-pack/react-simple-icons/icons/SiReact";
import SiPython from "@icons-pack/react-simple-icons/icons/SiPython";
import SiGo from "@icons-pack/react-simple-icons/icons/SiGo";
import SiC from "@icons-pack/react-simple-icons/icons/SiC";
import SiCplusplus from "@icons-pack/react-simple-icons/icons/SiCplusplus";
import SiDotnet from "@icons-pack/react-simple-icons/icons/SiDotnet";
import SiOpenjdk from "@icons-pack/react-simple-icons/icons/SiOpenjdk";
import SiKotlin from "@icons-pack/react-simple-icons/icons/SiKotlin";
import SiSwift from "@icons-pack/react-simple-icons/icons/SiSwift";
import SiDart from "@icons-pack/react-simple-icons/icons/SiDart";
import SiRuby from "@icons-pack/react-simple-icons/icons/SiRuby";
import SiPhp from "@icons-pack/react-simple-icons/icons/SiPhp";
import SiLua from "@icons-pack/react-simple-icons/icons/SiLua";
import SiR from "@icons-pack/react-simple-icons/icons/SiR";
import SiHaskell from "@icons-pack/react-simple-icons/icons/SiHaskell";
import SiElixir from "@icons-pack/react-simple-icons/icons/SiElixir";
import SiScala from "@icons-pack/react-simple-icons/icons/SiScala";
import SiJulia from "@icons-pack/react-simple-icons/icons/SiJulia";
import SiPerl from "@icons-pack/react-simple-icons/icons/SiPerl";
import SiZig from "@icons-pack/react-simple-icons/icons/SiZig";
import SiNixos from "@icons-pack/react-simple-icons/icons/SiNixos";
import SiVuedotjs from "@icons-pack/react-simple-icons/icons/SiVuedotjs";
import SiSvelte from "@icons-pack/react-simple-icons/icons/SiSvelte";
import SiHtml5 from "@icons-pack/react-simple-icons/icons/SiHtml5";
import SiCss from "@icons-pack/react-simple-icons/icons/SiCss";
import SiJson from "@icons-pack/react-simple-icons/icons/SiJson";
import SiToml from "@icons-pack/react-simple-icons/icons/SiToml";
import SiYaml from "@icons-pack/react-simple-icons/icons/SiYaml";
import SiMarkdown from "@icons-pack/react-simple-icons/icons/SiMarkdown";
import SiMdx from "@icons-pack/react-simple-icons/icons/SiMdx";
import SiGit from "@icons-pack/react-simple-icons/icons/SiGit";
import SiDocker from "@icons-pack/react-simple-icons/icons/SiDocker";
import SiNpm from "@icons-pack/react-simple-icons/icons/SiNpm";
import SiPnpm from "@icons-pack/react-simple-icons/icons/SiPnpm";
import SiYarn from "@icons-pack/react-simple-icons/icons/SiYarn";
import SiGnubash from "@icons-pack/react-simple-icons/icons/SiGnubash";
import SiGraphql from "@icons-pack/react-simple-icons/icons/SiGraphql";
import {
  Database,
  File,
  FileArchive,
  FileBadge,
  FileCog,
  FileImage,
  FileKey,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo,
  Folder,
  FolderOpen,
  SquareTerminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fileIconKindForPath, type FileIconKind } from "./file-type";

// Direct per-icon imports keep the catalog local and avoid bundling the whole
// brand library. Attribution is shipped in public/third-party/file-icons.txt.
type IconComponent = ComponentType<{
  className?: string;
  size?: number;
  title?: string;
  "aria-hidden"?: true;
  focusable?: "false";
}>;
const icons: Record<FileIconKind, IconComponent> = {
  rust: SiRust,
  javascript: SiJavascript,
  typescript: SiTypescript,
  react: SiReact,
  python: SiPython,
  go: SiGo,
  c: SiC,
  cpp: SiCplusplus,
  dotnet: SiDotnet,
  java: SiOpenjdk,
  kotlin: SiKotlin,
  swift: SiSwift,
  dart: SiDart,
  ruby: SiRuby,
  php: SiPhp,
  lua: SiLua,
  r: SiR,
  haskell: SiHaskell,
  elixir: SiElixir,
  scala: SiScala,
  julia: SiJulia,
  perl: SiPerl,
  zig: SiZig,
  nix: SiNixos,
  vue: SiVuedotjs,
  svelte: SiSvelte,
  html: SiHtml5,
  css: SiCss,
  json: SiJson,
  toml: SiToml,
  yaml: SiYaml,
  markdown: SiMarkdown,
  mdx: SiMdx,
  git: SiGit,
  docker: SiDocker,
  npm: SiNpm,
  pnpm: SiPnpm,
  yarn: SiYarn,
  bash: SiGnubash,
  shell: SquareTerminal,
  graphql: SiGraphql,
  database: Database,
  text: FileText,
  config: FileCog,
  table: FileSpreadsheet,
  image: FileImage,
  audio: FileMusic,
  video: FileVideo,
  archive: FileArchive,
  pdf: FileType2,
  lock: FileKey,
  license: FileBadge,
  file: File,
};

export function FileTypeIcon({
  path,
  kind = "file",
  expanded = false,
  className,
}: {
  path: string;
  kind?: "file" | "directory" | "other";
  expanded?: boolean;
  className?: string;
}) {
  const type =
    kind === "directory"
      ? expanded
        ? "folder-open"
        : "folder"
      : kind === "other"
        ? "file"
        : fileIconKindForPath(path);
  const Icon =
    type === "folder-open"
      ? FolderOpen
      : type === "folder"
        ? Folder
        : icons[type];
  return (
    <Icon
      aria-hidden={true}
      focusable="false"
      size={16}
      title=""
      data-file-icon={type}
      className={cn("size-4 shrink-0", className)}
    />
  );
}
