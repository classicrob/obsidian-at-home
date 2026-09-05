export interface HoverAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function elementRect(element: Element): HoverAnchorRect {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  };
}
