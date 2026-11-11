// Accounts focus chrome and the Change Account backdrop, against the fake server.
// Apple TV source: silo-apple e28300c61f044a9322f588203c8819d6f06e6197
// (TVChangeAccountView, TVChangeAccountRailRowStyle, siloChromeSelectedFill, TVSettingsPaneRowStyle,
// TVSettingsConfirmationOverlay, MarqueeScrim.leading, MarqueeScene.stage).
// Who's watching row stillness is abf4ac45aa0ded295dd1443b91457cdf42dffbf2.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { assertSignOutDialog } from "./support/signOutDialog.ts";
import { homeDetailsRead, launchBrowser, openTv, readLive, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

/** MarqueeScrim .leading, the same stops as the sign-in screen. */
const LEADING_SCRIM = [
    "rgba(0, 0, 0, 0.5) 0%",
    "rgba(0, 0, 0, 0) 35%",
    "rgba(0, 0, 0, 0.8) 0%",
    "rgba(0, 0, 0, 0.55) 30%",
    "rgba(0, 0, 0, 0.2) 58%",
    "rgba(0, 0, 0, 0.1) 80%",
    "rgba(0, 0, 0, 0.3) 100%",
];

interface FocusPaint {
    background: string;
    color: string;
    border: string;
    shadow: string;
    outline: string;
    transform: string;
}

async function focusedPaint(tv: Tv, selector: string, what: string): Promise<FocusPaint> {
    return readLive(tv, (key) => {
        const node = document.querySelector(key);
        if (!(node instanceof HTMLElement) || !node.isConnected || document.activeElement !== node) return null;
        const style = getComputedStyle(node);
        return {
            background: style.backgroundColor,
            color: style.color,
            border: style.borderTopColor,
            shadow: style.boxShadow,
            outline: style.outlineStyle,
            transform: style.transform,
        };
    }, selector, (value) => value.background !== "", what);
}

function noWhiteOutline(paint: FocusPaint, what: string): void {
    assert.equal(paint.outline, "none", what);
    assert.notEqual(paint.border, "rgb(255, 255, 255)", what);
    assert.equal(paint.shadow.includes("255, 255, 255"), false, `${what} ${paint.shadow}`);
    assert.equal(paint.background, "rgb(237, 237, 237)", what);
    assert.equal(paint.color, "rgb(0, 0, 0)", what);
}

test("Change Account after Who's watching keeps the warm light, and focused rows and Cancel have no extra outline", async () => {
    const tv = await openTv(browser, { app: "application" });
    const catalog = new FakeCatalog();
    catalog.fileIds.set("movie:m0001", "42");
    tv.fake.catalog = catalog;
    try {
        await signIn(tv);
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
        await tv.page.locator('[data-view="change-account"]').waitFor();

        const card = await focusedPaint(tv, ".account-card:focus", "focused account card");
        noWhiteOutline(card, "account card");
        assert.equal(card.shadow, "rgba(0, 0, 0, 0.45) 0px 12px 48px 0px");
        assert.equal(card.transform.startsWith("matrix(1.03"), true, card.transform);

        const backdrop = await readLive(tv, () => {
            const stage = document.querySelector(".accounts-screen .marquee-backdrop")?.getAttribute("data-stage");
            const scrim = document.querySelector<HTMLElement>(".accounts-scrim");
            if (stage === null || stage === undefined || scrim === null) return null;
            return { stage, image: getComputedStyle(scrim).backgroundImage };
        }, undefined, (value) => value.image.includes("gradient"), "Change Account backdrop");
        assert.equal(backdrop.stage, "2", "Who's watching leaves MarqueeScene on the profile stage, and Change Account does not reset it");
        for (const stop of LEADING_SCRIM) assert.equal(backdrop.image.includes(stop), true, backdrop.image);
        const selectedServer = await readLive(tv, () => {
            const node = document.querySelector('.accounts-rail button[aria-selected="true"]');
            if (!(node instanceof HTMLElement) || document.activeElement === node) return null;
            return getComputedStyle(node).backgroundColor;
        }, undefined, (value) => value !== "", "unfocused selected server");
        assert.equal(selectedServer, "rgba(255, 255, 255, 0.14)", "TVChangeAccountRailRowStyle uses siloChromeSelectedFill");

        const light = await settledPool(tv);
        assert.ok(light[0] > light[2] + 40, `the right-hand pool is the warm profile light, not the account blue ${JSON.stringify(light)}`);

        await tv.remote(37);
        const rail = await focusedPaint(tv, ".accounts-rail button:focus", "focused server row");
        noWhiteOutline(rail, "server row");
        assert.equal(rail.shadow, "none");
        assert.equal(rail.border, "rgba(0, 0, 0, 0)");
        assert.equal(rail.transform, "none");

        await tv.remote(10009);
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.locator('[data-focus="server"]').click();
        await tv.page.getByRole("button", { name: "Accounts", exact: true }).click();
        await tv.page.locator('[data-view="accounts-settings"]').waitFor();
        const row = await focusedPaint(tv, ".accounts-settings button:focus", "focused accounts row");
        noWhiteOutline(row, "accounts row");
        assert.equal(row.shadow, "rgba(0, 0, 0, 0.5) 0px 8px 18px 0px");
        assert.equal(row.border, "rgba(0, 0, 0, 0)");
        assert.equal(row.transform.startsWith("matrix(1.012"), true, row.transform);

        await tv.page.locator(".accounts-settings button").first().click();
        await tv.page.locator('[data-view="accounts-confirm"]').waitFor();
        await assertSignOutDialog(tv.page, /^Sign out of /, false);
        const cancel = await focusedPaint(tv, '[data-focus="cancel"]', "focused Cancel");
        noWhiteOutline(cancel, "Cancel");
        assert.equal(cancel.shadow, "rgba(0, 0, 0, 0.5) 0px 8px 18px 0px");
        assert.equal(cancel.border, "rgba(0, 0, 0, 0)");
        assert.equal(cancel.transform.startsWith("matrix(1.012"), true, cancel.transform);
        assert.deepEqual(tv.console, []);
    } finally {
        await tv.page.context().close();
    }
});

test("Change Account after a sign-in screen keeps the blue account light", async () => {
    const tv = await openTv(browser, { app: "application" });
    try {
        await tv.page.fill("#signin-address", "silo.example.test");
        await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
        await tv.page.locator('[data-screen="code"]').waitFor();
        await tv.remote(10009);
        await tv.page.locator('[data-view="change-account"]').waitFor();
        const stage = await readLive(tv, () => document.querySelector(".accounts-screen .marquee-backdrop")?.getAttribute("data-stage") ?? null, undefined, (value) => value !== "", "sign-in backdrop stage");
        assert.equal(stage, "1", "the sign-in screen leaves MarqueeScene on the account stage, and Change Account does not reset it");
        const light = await settledPool(tv);
        assert.ok(light[2] > light[0] + 40, `the right-hand pool is the account blue, not the profile red ${JSON.stringify(light)}`);
        assert.deepEqual(tv.console, []);
    } finally {
        await tv.page.context().close();
    }
});

/** The settled right-hand pool, the canvas corner the tvOS mirror draws at the screen's right. */
async function settledPool(tv: Tv): Promise<[number, number, number]> {
    await tv.jump(2000);
    return readLive(tv, () => {
        const source = document.querySelector(".accounts-screen .marquee-backdrop-light");
        if (!(source instanceof HTMLCanvasElement) || source.width === 0) return null;
        const copy = document.createElement("canvas");
        copy.width = source.width;
        copy.height = source.height;
        const context = copy.getContext("2d");
        context?.drawImage(source, 0, 0);
        const pixel = context?.getImageData(source.width - 1, 0, 1, 1).data;
        if (pixel === undefined) return null;
        const sample: [number, number, number] = [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0];
        return sample;
    }, undefined, (value) => value[0] + value[2] > 0, "settled account light");
}

async function signIn(tv: Tv): Promise<void> {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    const code = [...tv.fake.devices.keys()].pop();
    assert.ok(code !== undefined);
    tv.fake.approve(code);
    await tv.jump(5000);
    await tv.page.locator('[data-screen="approved"], [data-screen="notice"], [data-screen="profiles"]').waitFor();
    if (await tv.screen() === "approved") await tv.jump(1000);
    await tv.page.locator('[data-screen="notice"], [data-screen="profiles"]').waitFor();
    if (await tv.screen() === "notice") await tv.page.getByRole("button", { name: "Continue", exact: true }).click();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    await tv.page.locator('[data-focus="profile:p-owner"]').click();
    await tv.page.locator('[data-focus="ask-every-launch"]').click();
    await tv.page.locator('[data-view="home"] [data-focus="movie:m0001"]').first().waitFor();
    await homeDetailsRead(tv);
}
