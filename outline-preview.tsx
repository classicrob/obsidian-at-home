import { Children, cloneElement, isValidElement, useState, type ComponentProps, type ReactNode } from "react";
import type { ExtraProps } from "react-markdown";

interface HtmlNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HtmlNode[];
}

function textOf(node: HtmlNode): string {
  return node.value ?? node.children?.map(textOf).join("") ?? "";
}

export function rehypeOutline() {
  return (tree: HtmlNode) => {
    function visit(parent: HtmlNode) {
      if (!parent.children) return;
      parent.children.forEach(visit);
      const output: HtmlNode[] = [];
      const stack: { level: number; body: HtmlNode }[] = [];
      for (const child of parent.children) {
        const level = /^h[1-6]$/.test(child.tagName ?? "") ? Number(child.tagName![1]) : 0;
        if (level) {
          while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
          const body: HtmlNode = { type: "element", tagName: "div", properties: { className: ["wikilinks-outline-body"] }, children: [] };
          const section: HtmlNode = { type: "element", tagName: "div", properties: { "data-outline-heading": textOf(child) }, children: [child, body] };
          (stack.at(-1)?.body.children ?? output).push(section);
          stack.push({ level, body });
        } else {
          (stack.at(-1)?.body.children ?? output).push(child);
        }
      }
      parent.children = output;
    }
    visit(tree);
  };
}

function Toggle({ folded, label, kind, onToggle }: { folded: boolean; label: string; kind: string; onToggle(): void }) {
  return <button type="button" className={`wikilinks-outline-toggle wikilinks-outline-toggle-${kind}`} aria-expanded={!folded} aria-label={`${folded ? "Expand" : "Collapse"} ${label}`} onClick={event => { event.stopPropagation(); onToggle(); }} />;
}

export function OutlineSection({ node, children, ...props }: ComponentProps<"div"> & ExtraProps) {
  const [folded, setFolded] = useState(false);
  const label = node?.properties["data-outline-heading"];
  if (label === undefined) return <div {...props}>{children}</div>;
  const parts = Children.toArray(children);
  const heading = parts[0];
  const body = node?.children[1];
  const hasBody = body?.type === "element" && body.children.some(child => child.type !== "text" || child.value.trim());
  if (!hasBody || !isValidElement<{ children?: ReactNode; "aria-label"?: string }>(heading)) return <>{heading}</>;
  return <div {...props} className="wikilinks-outline-section">
    {cloneElement(heading, { "aria-label": String(label), children: <><Toggle folded={folded} label={String(label)} kind="heading" onToggle={() => setFolded(!folded)} />{heading.props.children}</> })}
    <div hidden={folded}>{parts.slice(1)}</div>
  </div>;
}

export function OutlineListItem({ node, children, ...props }: ComponentProps<"li"> & ExtraProps) {
  const [folded, setFolded] = useState(false);
  const hasChildren = node?.children.some(child => child.type === "element" && (child.tagName === "ul" || child.tagName === "ol"));
  if (!hasChildren) return <li {...props}>{children}</li>;
  const label = node?.children.filter(child => child.type !== "element" || (child.tagName !== "ul" && child.tagName !== "ol")).map(child => textOf(child as HtmlNode)).join("").trim() || "list item";
  return <li {...props} className={`${props.className ?? ""} wikilinks-outline-item${folded ? " is-collapsed" : ""}`}>
    <Toggle folded={folded} label={label} kind="list" onToggle={() => setFolded(!folded)} />
    {children}
  </li>;
}
