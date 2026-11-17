// Geometry written in start and end terms. A right-to-left layout reads its inline axis from the right, so a calculation that
// asks "which item is at or past this one" in physical left and right gives the wrong answer there; this is the one place
// that knows, and the focus code calls it instead of comparing `rect.left` itself.

/** Whether the layout around `element` reads right to left. */
export function readsInlineRightToLeft(element: Element): boolean {
    return getComputedStyle(element).direction === "rtl";
}

/** True when `rect` starts at or after `position` along the inline axis: at or to the right of it left to right, at or to the left of it right to left. */
export function startsAtOrPast(rect: { readonly left: number; readonly right: number }, position: number, rightToLeft: boolean): boolean {
    return rightToLeft ? rect.right <= position + 0.5 : rect.left >= position - 0.5;
}

/** How far `target`'s start edge lies past `origin`'s along the inline axis, never below 0: to the right left to right, to the left right to left. */
export function startOffset(origin: { readonly left: number; readonly right: number }, target: { readonly left: number; readonly right: number }, rightToLeft: boolean): number {
    return Math.max(0, rightToLeft ? origin.right - target.right : target.left - origin.left);
}
