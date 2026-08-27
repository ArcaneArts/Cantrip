const MARKDOWN_COLOR_LINK_PREFIX = "#cantrip-color=";
const EXACT_HEX_COLOR = /^#[\da-f]{6}$/iu;
const HEX_COLOR_IN_TEXT = /#[\da-f]{6}(?![\da-f])/giu;
const COLOR_TRANSFORM_SKIP_TYPES = new Set([
  "code",
  "definition",
  "html",
  "inlineCode",
  "link",
  "linkReference",
]);

interface MarkdownAstNode {
  children?: MarkdownAstNode[];
  title?: string | null;
  type: string;
  url?: string;
  value?: string;
}

export interface MarkdownColorDetails {
  hex: string;
  hsv: { h: number; s: number; v: number };
  hsvText: string;
  rgb: { b: number; g: number; r: number };
  rgbText: string;
}

export function normalizeHexColor(value: string): string | null {
  const candidate = value.trim();
  return EXACT_HEX_COLOR.test(candidate) ? candidate.toUpperCase() : null;
}

export function markdownColorFromHref(href: string | undefined): string | null {
  if (!href?.startsWith(MARKDOWN_COLOR_LINK_PREFIX)) return null;
  return normalizeHexColor(`#${href.slice(MARKDOWN_COLOR_LINK_PREFIX.length)}`);
}

export function markdownColorDetails(
  value: string,
): MarkdownColorDetails | null {
  const hex = normalizeHexColor(value);
  if (!hex) return null;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;
  const h = Math.round(hue);
  const s = Math.round((max === 0 ? 0 : delta / max) * 100);
  const v = Math.round(max * 100);
  return {
    hex,
    hsv: { h, s, v },
    hsvText: `hsv(${h}°, ${s}%, ${v}%)`,
    rgb: { b, g, r },
    rgbText: `rgb(${r}, ${g}, ${b})`,
  };
}

function colorLinkNode(value: string): MarkdownAstNode {
  const normalized = normalizeHexColor(value)!;
  return {
    type: "link",
    url: `${MARKDOWN_COLOR_LINK_PREFIX}${normalized.slice(1)}`,
    title: null,
    children: [{ type: "text", value }],
  };
}

function splitColorText(value: string): MarkdownAstNode[] {
  const nodes: MarkdownAstNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(HEX_COLOR_IN_TEXT)) {
    const index = match.index;
    if (index > offset) {
      nodes.push({ type: "text", value: value.slice(offset, index) });
    }
    nodes.push(colorLinkNode(match[0]));
    offset = index + match[0].length;
  }
  if (offset < value.length) {
    nodes.push({ type: "text", value: value.slice(offset) });
  }
  return nodes.length > 0 ? nodes : [{ type: "text", value }];
}

function transformColorText(node: MarkdownAstNode): void {
  if (!node.children || COLOR_TRANSFORM_SKIP_TYPES.has(node.type)) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value) {
      return splitColorText(child.value);
    }
    transformColorText(child);
    return [child];
  });
}

export function remarkMarkdownColors() {
  return (tree: MarkdownAstNode) => transformColorText(tree);
}
