import type { Tv } from "./tv.ts";
import { FakeSettings } from "../../native/support/fakeSettings.ts";
import { FakeWatchParty } from "../../native/support/fakeWatchParty.ts";

export async function start(tv: Tv, fake = new FakeWatchParty(), enabled = true, beforeMount: () => void = () => undefined): Promise<FakeWatchParty> {
    tv.fake.catalog = fake;
    new FakeSettings(tv.fake);
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? ""); await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    beforeMount();
    await tv.page.evaluate(on => { window.browseHarness.setExperimental("watchParty", on); window.browseHarness.mount(true); }, enabled);
    await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
    return fake;
}
export const button = (tv: Tv, key: string) => tv.page.locator(`[data-focus="${key}"]`).last();
// A synchronous DOM click: Playwright's forced click can land on a button the page has just rebuilt and report it not visible.
export const pressDisabled = (tv: Tv, key: string) => tv.page.evaluate(focus => { [...document.querySelectorAll<HTMLElement>(`[data-focus="${focus}"]`)].at(-1)?.click(); }, key);
export const menuTitles = async (tv: Tv): Promise<string[]> => {
    if (!(await button(tv, "settings").isVisible())) await button(tv, "profiles").click();
    return await tv.page.locator('.skyline-selector [role="menuitem"]').allTextContents();
};
export async function openHub(tv: Tv): Promise<void> {
    if (!(await button(tv, "watch-party").isVisible())) await button(tv, "profiles").click();
    await button(tv, "watch-party").click();
    await tv.page.locator('.browse[data-view="watchParty:hub"]').waitFor();
}
