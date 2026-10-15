import { Node as TiptapNode } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { MarkdownSerializerState } from "@tiptap/pm/markdown";
import { containsIframe, renderIframeEmbedsDOM } from "./iframe-embed.js";

/*
 * Raw HTML containing an `<iframe>` is kept verbatim in an atom node's
 * `html` attribute and written back unchanged on save, so the editor never
 * rewrites or drops an embed. The node view shows the sanitized embed.
 */

interface MarkdownItToken {
  content: string;
}
type RenderRule = (tokens: MarkdownItToken[], index: number, ...rest: unknown[]) => string;
interface MarkdownIt {
  renderer: { rules: Record<string, RenderRule | undefined> };
}

const patched = new WeakSet<object>();

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function setupMarkdownIt(md: MarkdownIt): void {
  // tiptap-markdown calls every extension's setup before each parse.
  if (patched.has(md)) return;
  patched.add(md);
  const rules = md.renderer.rules;
  const htmlBlock = rules.html_block;
  const htmlInline = rules.html_inline;
  rules.html_block = (tokens, index, ...rest) => {
    const content = tokens[index]!.content;
    if (containsIframe(content)) {
      return `<div data-raw-iframe="${escapeAttribute(content.replace(/\n+$/, ""))}"></div>`;
    }
    return htmlBlock ? htmlBlock(tokens, index, ...rest) : content;
  };
  rules.html_inline = (tokens, index, ...rest) => {
    const token = tokens[index]!;
    if (/^<iframe\b/i.test(token.content)) {
      let html = token.content;
      const next = tokens[index + 1];
      if (next && /^<\/iframe\s*>$/i.test(next.content)) {
        html += next.content;
        next.content = "";
      }
      return `<span data-raw-iframe="${escapeAttribute(html)}"></span>`;
    }
    return htmlInline ? htmlInline(tokens, index, ...rest) : token.content;
  };
}

function createRawIframeNode(inline: boolean) {
  const tag = inline ? "span" : "div";
  return TiptapNode.create({
    name: inline ? "rawIframeInline" : "rawIframe",
    group: inline ? "inline" : "block",
    inline,
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() {
      return {
        html: {
          default: "",
          parseHTML: element => element.getAttribute("data-raw-iframe") ?? "",
          renderHTML: attributes => ({ "data-raw-iframe": attributes.html }),
        },
      };
    },
    parseHTML() {
      return [{ tag: `${tag}[data-raw-iframe]`, priority: 1000 }];
    },
    renderHTML({ HTMLAttributes }) {
      return [tag, HTMLAttributes];
    },
    addStorage() {
      return {
        markdown: {
          parse: { setup: setupMarkdownIt },
          serialize(state: MarkdownSerializerState, node: ProseMirrorNode) {
            state.text(String(node.attrs.html), false);
            if (!inline) state.closeBlock(node);
          },
        },
      };
    },
    addNodeView() {
      return ({ node: initial }) => {
        let html = String(initial.attrs.html);
        const dom = renderIframeEmbedsDOM(html, inline);
        dom.contentEditable = "false";
        dom.dataset.rawIframe = "";
        return {
          dom,
          update(next) {
            if (next.type !== initial.type) return false;
            if (String(next.attrs.html) === html) return true;
            html = String(next.attrs.html);
            dom.replaceChildren(...Array.from(renderIframeEmbedsDOM(html, inline).childNodes));
            return true;
          },
          ignoreMutation: () => true,
        };
      };
    },
  });
}

export const RawIframeBlock = createRawIframeNode(false);
export const RawIframeInline = createRawIframeNode(true);
