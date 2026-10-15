import { Children, isValidElement, type ComponentProps, type CSSProperties } from "react";
import type { ExtraProps } from "react-markdown";

const styles: Record<string, [string, string]> = {
  note: ["8, 109, 221", "M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z"],
  abstract: ["0, 191, 188", "M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01"],
  info: ["8, 109, 221", "M12 11v6 M12 7h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0"],
  todo: ["8, 109, 221", "m9 12 2 2 4-4 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0"],
  tip: ["0, 191, 188", "M9 18h6 M10 22h4 M9 18v-3a6 6 0 1 1 6 0v3"],
  success: ["8, 185, 78", "m20 6-11 11-5-5"],
  question: ["236, 117, 0", "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3 M12 17h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0"],
  warning: ["236, 117, 0", "m10.3 3.9-8.2 14.2A2 2 0 0 0 3.8 21h16.4a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0 M12 9v4 M12 17h.01"],
  failure: ["233, 49, 71", "m18 6-12 12 M6 6l12 12"],
  danger: ["233, 49, 71", "m13 2-3 8h7l-6 12 1-9H5Z"],
  bug: ["233, 49, 71", "M8 8h8v8a4 4 0 0 1-8 0Z M9 8V5h6v3 M3 9l5 2 M21 9l-5 2 M3 15h5 M16 15h5 M5 21l4-3 M19 21l-4-3 M12 8v12"],
  example: ["120, 82, 238", "M9 3h6 M10 3v7L4 20h16l-6-10V3 M8 14h8"],
  quote: ["158, 158, 158", "M3 5h7v7H6c0 4-3 6-3 6Z M14 5h7v7h-4c0 4-3 6-3 6Z"],
};
const aliases: Record<string, string> = { summary: "abstract", tldr: "abstract", hint: "tip", important: "tip", check: "success", done: "success", help: "question", faq: "question", caution: "warning", attention: "warning", fail: "failure", missing: "failure", error: "danger", cite: "quote" };
export function calloutStyle(type: string) {
  const key = type.toLowerCase();
  const canonical = Object.hasOwn(aliases, key) ? aliases[key]! : key;
  return Object.hasOwn(styles, canonical) ? styles[canonical]! : styles.note!;
}
export function parseCallout(text: string) {
  const match = /^\[!([\w-]+)(?:\|([^\]\n]*))?\]([+-]?)[ \t]*/.exec(text);
  if (!match) return null;
  const type = match[1]!;
  return { type, metadata: match[2] ?? "", fold: match[3]!, marker: match[0], title: type.charAt(0).toUpperCase() + type.slice(1).toLowerCase() };
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

export function remarkCallouts() {
  return (tree: MarkdownNode) => {
    function visit(node: MarkdownNode) {
      const paragraph = node.children?.[0];
      const first = paragraph?.children?.[0];
      const callout = node.type === "blockquote" && paragraph?.type === "paragraph" && first?.type === "text" ? parseCallout(first.value ?? "") : null;
      if (callout && first && paragraph?.children) {
        first.value = first.value!.slice(callout.marker.length);
        const title: MarkdownNode[] = [];
        const body: MarkdownNode[] = [];
        let inBody = false;
        for (const child of paragraph.children) {
          if (inBody) { body.push(child); continue; }
          const newline = child.type === "text" ? child.value!.indexOf("\n") : -1;
          if (child.type === "break") { inBody = true; continue; }
          if (newline !== -1) {
            title.push({ ...child, value: child.value!.slice(0, newline) });
            body.push({ ...child, value: child.value!.slice(newline + 1) });
            inBody = true;
          } else title.push(child);
        }
        if (!title.some(child => child.type !== "text" || child.value?.trim())) title.splice(0, title.length, { type: "text", value: callout.title });
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, "data-callout": callout.type.toLowerCase(), "data-callout-fold": callout.fold } };
        node.children = [
          { type: "paragraph", data: { hName: "div", hProperties: { className: "callout-title-inner" } }, children: title },
          ...(body.some(child => child.type !== "text" || child.value) ? [{ ...paragraph, children: body }] : []),
          ...node.children!.slice(1),
        ];
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}

export const CalloutBlockquote = ({ node, children, ...props }: ComponentProps<"blockquote"> & ExtraProps) => {
  const type = node?.properties["data-callout"] as string | undefined;
  if (!type) return <blockquote {...props}>{children}</blockquote>;
  const fold = node?.properties["data-callout-fold"];
  const [color, path] = calloutStyle(type);
  const parts = Children.toArray(children);
  const titleIndex = parts.findIndex(isValidElement);
  const title = parts[titleIndex];
  const body = parts.slice(titleIndex + 1);
  const style = { "--callout-color": color } as CSSProperties;
  const heading = <><svg className="callout-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>{title}{fold ? <span className="callout-fold" aria-hidden="true">›</span> : null}</>;
  if (fold) return <details id={props.id} data-block-id={node?.properties["data-block-id"]} className="callout wikilinks-callout" data-callout={type} style={style} open={fold === "+"}>
    <summary className="callout-title" onClick={event => event.stopPropagation()}>{heading}</summary>
    <div className="callout-content">{body}</div>
  </details>;
  return <div id={props.id} data-block-id={node?.properties["data-block-id"]} className="callout wikilinks-callout" data-callout={type} style={style}><div className="callout-title">{heading}</div><div className="callout-content">{body}</div></div>;
};
