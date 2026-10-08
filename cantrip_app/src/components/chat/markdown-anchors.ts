interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
}
function nodeText(node: MarkdownNode): string {
  return node.value ?? node.children?.map(nodeText).join("") ?? "";
}
export function remarkMarkdownAnchors() {
  return (tree: MarkdownNode) => {
    const used = new Set<string>();
    const visit = (node: MarkdownNode) => {
      if (node.type === "heading") {
        const base = nodeText(node)
          .toLowerCase()
          .replace(/[^\p{L}\p{N}_\s-]/gu, "")
          .replace(/\s/g, "-");
        let id = base;
        for (let suffix = 1; used.has(id); suffix += 1)
          id = `${base}-${suffix}`;
        used.add(id);
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, id },
        };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
