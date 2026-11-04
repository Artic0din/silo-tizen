// Chromium 108 has no text-wrap: pretty. Native titles fill the first line, but never leave one word alone on the second.
export function balanceTwoLineText(heading: HTMLElement): void {
    const text = heading.textContent?.trim() ?? "", context = document.createElement("canvas").getContext("2d");
    if (context === null) return;
    context.font = getComputedStyle(heading).font;
    const available = heading.clientWidth;
    if (context.measureText(text).width <= available) return;
    const words = text.split(/\s+/), width = (from: number, to: number): number => context.measureText(words.slice(from, to).join(" ")).width;
    let split = 1;
    while (split < words.length - 1 && width(0, split + 1) <= available) split += 1;
    if (split === words.length - 1 && split > 1) split -= 1;
    heading.style.maxWidth = `${Math.ceil(Math.min(available, Math.max(width(0, split), width(split, words.length))))}px`;
}
