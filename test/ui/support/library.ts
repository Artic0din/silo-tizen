import type { Tv } from "./tv.ts";
import type { LibraryMode } from "../../../src/ui/libraryDiscovery.ts";

/** Library destinations share the navigation cascade. */
export async function selectLibraryMode(tv: Tv, mode: LibraryMode): Promise<void> {
    if (!["Recommended", "Collections", "Browse"].includes(mode) && await tv.page.locator('.browse .skyline-pills').count() === 0) await selectLibraryMode(tv, "Browse");
    const strip = tv.page.locator(`.browse .skyline-pills [data-focus="mode:${mode}"]`);
    if (await strip.count() > 0) {
        if (await tv.page.locator('.skyline-selector[data-menu-kind="library"]').count() > 0) await tv.remote(10009);
        // Browse keeps these actions hidden. A real click focuses the pill first, so the
        // library load enters the grid; Sort still owning focus would leave the tab selected.
        if (await strip.isVisible()) await strip.click();
        else await strip.evaluate(node => {
            if (document.activeElement instanceof HTMLElement && document.activeElement.dataset.focus === "sort") {
                document.querySelector<HTMLElement>('.skyline-roots [aria-current="page"]')?.focus({ preventScroll: true });
            }
            (node as HTMLElement).click();
        });
        return;
    }
    await tv.page.locator('.skyline-roots [aria-current="page"]').evaluate(node => {
        // Keep synthetic focus and remote input in one task so a load cannot enter content between them.
        (node as HTMLElement).focus({ preventScroll: true });
        node.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 40, bubbles: true, cancelable: true }));
        (document.activeElement ?? node).dispatchEvent(new KeyboardEvent("keyup", { keyCode: 40, bubbles: true, cancelable: true }));
    });
    await tv.page.locator(`.skyline-selector [data-focus="section:${mode === "Browse" ? "browse" : mode}"]`).click();
}
