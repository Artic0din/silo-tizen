import type { Tv } from "./tv.ts";
import type { LibraryMode } from "../../../src/ui/libraryDiscovery.ts";

/** Recommended uses the cascade; other destinations retain their mode controls. */
export async function selectLibraryMode(tv: Tv, mode: LibraryMode): Promise<void> {
    if (!["Recommended", "Collections", "Browse"].includes(mode) && await tv.page.locator('.browse .skyline-pills').count() === 0) await selectLibraryMode(tv, "Browse");
    const strip = tv.page.locator(`.browse .skyline-pills [data-focus="mode:${mode}"]`);
    if (await strip.count() > 0) { await strip.click(); return; }
    await tv.page.locator('.skyline-roots [aria-current="page"]').focus();
    await tv.remote(40);
    await tv.page.locator(`.skyline-selector [data-focus="section:${mode === "Browse" ? "browse" : mode}"]`).click();
}
