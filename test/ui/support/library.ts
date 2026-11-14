import type { Tv } from "./tv.ts";
import type { LibraryMode } from "../../../src/ui/libraryDiscovery.ts";

/** Library destinations are reached only from the top-bar cascade (TVLibraryPillRow.swift:7-10). */
export async function selectLibraryMode(tv: Tv, mode: LibraryMode): Promise<void> {
    await tv.page.locator('.skyline-roots [aria-current="page"]').evaluate(node => {
        // Keep synthetic focus and remote input in one task so a load cannot enter content between them.
        (node as HTMLElement).focus({ preventScroll: true });
        node.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 40, bubbles: true, cancelable: true }));
        (document.activeElement ?? node).dispatchEvent(new KeyboardEvent("keyup", { keyCode: 40, bubbles: true, cancelable: true }));
    });
    await tv.page.locator(`.skyline-selector [data-focus="section:${mode === "Browse" ? "browse" : mode}"]`).click();
}
