import { Node as TiptapNode } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { MarkdownSerializerState } from "@tiptap/pm/markdown";
import { calloutStyle, parseCallout } from "./callouts.js";

function parseCalloutDOM(root: HTMLElement) {
  for (const quote of Array.from(root.querySelectorAll("blockquote"))) {
    const paragraph = quote.firstElementChild;
    const first = paragraph?.firstChild;
    if (paragraph?.tagName !== "P" || first?.nodeType !== 3) continue;
    const callout = parseCallout(first.textContent ?? "");
    if (!callout) continue;
    first.textContent = first.textContent!.slice(callout.marker.length);
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let current: Node | null;
    while ((current = walker.nextNode())) {
      const newline = current.nodeType === 3 ? current.textContent!.indexOf("\n") : -1;
      if (newline < 0 && !(current instanceof HTMLBRElement)) continue;
      const range = document.createRange();
      if (newline >= 0) range.setStart(current, newline + 1);
      else range.setStartAfter(current);
      range.setEnd(paragraph, paragraph.childNodes.length);
      const body = document.createElement("p");
      body.append(range.extractContents());
      if (newline >= 0) current.textContent = current.textContent!.slice(0, newline);
      else current.parentNode?.removeChild(current);
      if (body.hasChildNodes()) paragraph.after(body);
      break;
    }
    const container = document.createElement("div");
    container.dataset.callout = callout.type;
    container.dataset.calloutFold = callout.fold;
    container.dataset.calloutMetadata = callout.metadata;
    container.append(...Array.from(quote.childNodes));
    quote.replaceWith(container);
  }
}

export const CalloutEditor = TiptapNode.create({
  name: "callout",
  group: "block",
  content: "paragraph block*",
  defining: true,
  addAttributes() {
    return {
      calloutType: { default: "note", parseHTML: element => element.getAttribute("data-callout") },
      fold: { default: "", parseHTML: element => element.getAttribute("data-callout-fold") ?? "" },
      metadata: { default: "", parseHTML: element => element.getAttribute("data-callout-metadata") ?? "" },
    };
  },
  parseHTML() { return [{ tag: "div[data-callout]" }]; },
  renderHTML({ node }) {
    return ["div", { "data-callout": node.attrs.calloutType, "data-callout-fold": node.attrs.fold, "data-callout-metadata": node.attrs.metadata }, 0];
  },
  addStorage() {
    return { markdown: {
      parse: { updateDOM: parseCalloutDOM },
      serialize(state: MarkdownSerializerState, node: ProseMirrorNode) {
        state.wrapBlock("> ", null, node, () => {
          const metadata = node.attrs.metadata ? `|${node.attrs.metadata}` : "";
          state.write(`[!${node.attrs.calloutType}${metadata}]${node.attrs.fold}`);
          if (node.firstChild?.content.size) {
            state.write(" ");
            state.renderInline(node.firstChild);
          }
          state.closeBlock(node.firstChild!);
          node.forEach((child, _offset, index) => { if (index > 0) state.render(child, node, index); });
        });
      },
    } };
  },
  addNodeView() {
    return ({ node: initial }) => {
      const dom = document.createElement("div");
      dom.className = "callout wikilinks-callout wikilinks-callout-editor";
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.classList.add("callout-icon");
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "2");
      icon.setAttribute("stroke-linecap", "round");
      icon.setAttribute("stroke-linejoin", "round");
      icon.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      icon.append(path);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "callout-fold";
      toggle.contentEditable = "false";
      toggle.textContent = "›";
      const contentDOM = document.createElement("div");
      contentDOM.className = "callout-editor-content";
      dom.append(icon, toggle, contentDOM);
      let fold: string | undefined;
      let collapsed = false;
      function paint(node: ProseMirrorNode) {
        const type = String(node.attrs.calloutType);
        const [color, svgPath] = calloutStyle(type);
        dom.dataset.callout = type.toLowerCase();
        dom.style.setProperty("--callout-color", color);
        path.setAttribute("d", svgPath);
        contentDOM.style.setProperty("--callout-default-title", JSON.stringify(node.firstChild?.content.size ? "" : (parseCallout(`[!${type}]`)?.title ?? "Note")));
        if (fold !== node.attrs.fold) {
          fold = node.attrs.fold;
          collapsed = fold === "-";
        }
        toggle.hidden = !fold;
        dom.classList.toggle("is-collapsed", collapsed);
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${node.firstChild?.textContent || type} callout`);
      }
      let node = initial;
      paint(node);
      toggle.addEventListener("mousedown", event => event.preventDefault());
      toggle.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        collapsed = !collapsed;
        paint(node);
      });
      return {
        dom, contentDOM,
        update(next) { if (next.type !== initial.type) return false; node = next; paint(node); return true; },
        stopEvent: event => toggle.contains(event.target as Node),
        ignoreMutation: mutation => mutation.type !== "selection" && !contentDOM.contains(mutation.target),
      };
    };
  },
});
