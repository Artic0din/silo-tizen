import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import type { Browser } from "playwright";
import { launchBrowser } from "./support/tv.ts";

let browser: Browser;
let script: string;
before(async () => {
    browser = await launchBrowser();
    const result = await build({ entryPoints: ["src/ui/navigationAvatar.ts"], bundle: true, write: false, format: "iife", globalName: "avatarFixture", platform: "browser" });
    script = result.outputFiles[0]?.text ?? "";
    assert.ok(script);
});
after(async () => { await browser.close(); });

test("navigation avatar keeps its initial while pending and removes it after transparent artwork loads", async () => {
    const page = await browser.newPage();
    let release: () => void = () => assert.fail("Expected avatar request");
    let requested: () => void = () => undefined;
    const pending = new Promise<void>(resolve => { requested = resolve; });
    try {
        await page.route("https://art.example/avatar.svg", async route => {
            await new Promise<void>(resolve => { release = resolve; requested(); });
            await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="58" height="58"/>' });
        });
        await page.setContent("<main></main>");
        await page.addScriptTag({ content: script });
        await page.evaluate("document.querySelector('main').appendChild(avatarFixture.navigationAvatar(' River ', 'https://art.example/avatar.svg', 'https://silo.example', 58))");
        await pending;
        assert.equal(await page.locator(".navigation-avatar-fallback").innerText(), "R");
        assert.equal(await page.locator(".navigation-avatar-fallback").isVisible(), true);
        release();
        await page.locator("img").evaluate(image => (image as HTMLImageElement).decode());
        assert.equal(await page.locator(".navigation-avatar-fallback").isVisible(), false);
        assert.equal(await page.locator("img").isVisible(), true);
    } finally { release(); await page.close(); }
});

test("navigation avatar resolves relative paths, preserves error fallback and refuses unsafe URLs", async () => {
    const page = await browser.newPage();
    try {
        await page.route("https://silo.example/avatar.svg", route => route.fulfill({ status: 404, body: "Missing" }));
        await page.setContent("<main></main>");
        await page.addScriptTag({ content: script });
        await page.evaluate("document.querySelector('main').appendChild(avatarFixture.navigationAvatar('River', '/avatar.svg', 'https://silo.example', 58))");
        await page.locator("img").waitFor({ state: "hidden" });
        assert.equal(await page.locator("img").getAttribute("src"), "https://silo.example/avatar.svg");
        assert.equal(await page.locator(".navigation-avatar-fallback").isVisible(), true);
        for (const reference of ["javascript:alert(1)", "data:image/svg+xml,test", "http://art.example/avatar.svg", "upload:opaque"]) {
            await page.evaluate(reference => {
                document.querySelector("main")?.replaceChildren();
                return reference;
            }, reference);
            await page.evaluate(`document.querySelector('main').appendChild(avatarFixture.navigationAvatar('River', ${JSON.stringify(reference)}, 'https://silo.example', 58))`);
            assert.equal(await page.locator("img").count(), 0);
            assert.equal(await page.locator(".navigation-avatar-fallback").innerText(), "R");
        }
    } finally { await page.close(); }
});

test("a nameless navigation avatar shows the person glyph instead of an empty disc", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent("<main></main>");
        await page.addScriptTag({ content: script });
        await page.evaluate("document.querySelector('main').appendChild(avatarFixture.navigationAvatar('  ', undefined, 'https://silo.example', 58))");
        assert.equal(await page.locator(".navigation-avatar-fallback").innerText(), "");
        assert.equal(await page.locator(".navigation-avatar-fallback svg.navigation-avatar-person").count(), 1);
        await page.evaluate("document.querySelector('main').replaceChildren(avatarFixture.profileMenuAvatar('', undefined, '🦊', 'https://silo.example', 58))");
        assert.equal(await page.locator(".navigation-avatar-fallback").innerText(), "🦊", "an emoji avatar still wins over the glyph");
        assert.equal(await page.locator("svg").count(), 0);
    } finally { await page.close(); }
});
