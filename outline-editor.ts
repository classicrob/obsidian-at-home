import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

interface OutlineBranch {
  position: number;
  togglePosition: number;
  label: string;
  kind: "heading" | "list";
  children: { from: number; to: number }[];
}

export function outlineBranches(doc: ProseMirrorNode): OutlineBranch[] {
  const branches: OutlineBranch[] = [];
  function visit(parent: ProseMirrorNode, start: number) {
    const siblings: { node: ProseMirrorNode; position: number }[] = [];
    parent.forEach((node, offset) => siblings.push({ node, position: start + offset }));
    siblings.forEach(({ node, position }, index) => {
      if (node.type.name === "heading") {
        const children: OutlineBranch["children"] = [];
        for (let next = index + 1; next < siblings.length; next++) {
          const sibling = siblings[next]!;
          if (sibling.node.type.name === "heading" && sibling.node.attrs.level <= node.attrs.level) break;
          children.push({ from: sibling.position, to: sibling.position + sibling.node.nodeSize });
        }
        if (children.length) branches.push({ position, togglePosition: position + 1, label: node.textContent, kind: "heading", children });
      }
      if ((node.type.name === "listItem" || node.type.name === "taskItem") && node.firstChild?.isTextblock) {
        const children: OutlineBranch["children"] = [];
        node.forEach((child, offset) => {
          if (["bulletList", "orderedList", "taskList"].includes(child.type.name)) {
            children.push({ from: position + 1 + offset, to: position + 1 + offset + child.nodeSize });
          }
        });
        if (children.length) branches.push({ position, togglePosition: position + 2, label: node.firstChild.textContent, kind: "list", children });
      }
      if (!node.isLeaf) visit(node, position + 1);
    });
  }
  visit(doc, 0);
  return branches;
}

export const outlineFoldingKey = new PluginKey<Set<number>>("wikilinks-outline-folding");

export const OutlineEditor = Extension.create({
  name: "outlineFolding",
  addKeyboardShortcuts() {
    const itemType = () => this.editor.isActive("taskItem") ? "taskItem" : "listItem";
    return {
      Tab: () => this.editor.commands.sinkListItem(itemType()),
      "Shift-Tab": () => this.editor.commands.liftListItem(itemType()),
    };
  },
  addProseMirrorPlugins() {
    return [new Plugin<Set<number>>({
      key: outlineFoldingKey,
      state: {
        init: () => new Set(),
        apply(transaction, previous) {
          const collapsed = new Set<number>();
          for (const position of previous) {
            const mapped = transaction.mapping.mapResult(position, 1);
            if (!mapped.deleted) collapsed.add(mapped.pos);
          }
          const toggle: number | undefined = transaction.getMeta(outlineFoldingKey);
          if (toggle !== undefined) {
            if (collapsed.has(toggle)) collapsed.delete(toggle);
            else collapsed.add(toggle);
          }
          const branches = outlineBranches(transaction.doc);
          const valid = new Set(branches.map(branch => branch.position));
          for (const position of collapsed) if (!valid.has(position)) collapsed.delete(position);
          if (toggle === undefined && transaction.selectionSet) {
            for (const branch of branches) {
              if (branch.children.some(({ from, to }) => transaction.selection.from < to && transaction.selection.to > from)) {
                collapsed.delete(branch.position);
              }
            }
          }
          return collapsed;
        },
      },
      props: {
        decorations(state) {
          const collapsed = outlineFoldingKey.getState(state) ?? new Set<number>();
          const decorations: Decoration[] = [];
          for (const branch of outlineBranches(state.doc)) {
            const folded = collapsed.has(branch.position);
            if (branch.kind === "heading") {
              const heading = state.doc.nodeAt(branch.position)!;
              decorations.push(Decoration.node(branch.position, branch.position + heading.nodeSize, { "aria-label": branch.label }));
            }
            if (folded) {
              for (const child of branch.children) decorations.push(Decoration.node(child.from, child.to, { class: "wikilinks-outline-hidden" }));
            }
            decorations.push(Decoration.widget(branch.togglePosition, (view, getPos) => {
              const button = document.createElement("button");
              button.type = "button";
              button.className = `wikilinks-outline-toggle wikilinks-outline-toggle-${branch.kind}`;
              button.contentEditable = "false";
              button.setAttribute("aria-expanded", String(!folded));
              button.setAttribute("aria-label", `${folded ? "Expand" : "Collapse"} ${branch.label || branch.kind}`);
              button.addEventListener("mousedown", event => event.preventDefault());
              button.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                const current = outlineBranches(view.state.doc).find(candidate => candidate.togglePosition === getPos());
                if (!current) return;
                const tr = view.state.tr.setMeta(outlineFoldingKey, current.position).setMeta("addToHistory", false);
                const isCollapsed = outlineFoldingKey.getState(view.state)?.has(current.position);
                if (!isCollapsed && current.children.some(({ from, to }) => view.state.selection.from < to && view.state.selection.to > from)) {
                  tr.setSelection(TextSelection.create(view.state.doc, current.togglePosition));
                }
                view.dispatch(tr);
              });
              return button;
            }, { side: -1, key: `${branch.position}:${folded}:${branch.label}`, stopEvent: () => true }));
          }
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});
