import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { Browser, Request } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const BACK = 10009;
const OPAQUE = "1QcSHQRnh493V4dIh4eXh1h4kJUI";
const CAPTURE = process.env.PERSON_HERO_CAPTURE_DIR;

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function signIn(tv: Tv, catalog = new FakeDetails()): Promise<FakeDetails> {
    tv.fake.catalog = catalog;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
    assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner")), "selected");
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-focus="person:7"]').first().waitFor();
    return catalog;
}

async function person(tv: Tv, body: Record<string, unknown>): Promise<void> {
    await tv.page.route("**/api/v2/catalog/people/7", route => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "7", name: "River Vale", bio: "A synthetic performer whose work spans film and television.", birth_date: "1980-04-12", birthplace: "Melbourne", photo_url: "/art/river.svg", ...body }),
    }));
    await tv.page.locator('[data-focus="person:7"]').first().focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('.browse[data-view="person:7"] .person-portrait').waitFor();
}

async function shot(tv: Tv, name: string): Promise<void> {
    if (CAPTURE === undefined) return;
    await mkdir(CAPTURE, { recursive: true });
    await tv.page.screenshot({ path: `${CAPTURE}/${name}.png`, animations: "disabled" });
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`international initials work without Intl.Segmenter (${reducedMotion})`, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            await tv.page.emulateMedia({ reducedMotion });
            await tv.page.evaluate(() => Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true }));
            await signIn(tv);
            for (const [name, initials] of [["가 Kim", "가K"], ["क्षितिज शर्मा", "क्षिश"]]) {
                await person(tv, { name, photo_url: "" });
                assert.equal(await tv.page.locator(".person-portrait-initials").innerText(), initials);
                await tv.remote(BACK);
            }
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

test("living person shows a local age and keeps birth and birthplace", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.clock.setFixedTime(new Date(2026, 3, 11, 15, 0, 0).getTime());
        await signIn(tv);
        await person(tv, {});
        await tv.page.getByText("Born Apr 12, 1980", { exact: true }).waitFor();
        await tv.page.getByText("45 years old", { exact: true }).waitFor();
        await tv.page.getByText("Melbourne", { exact: true }).waitFor();
        assert.equal(await tv.page.getByText("years old", { exact: false }).count(), 1);
        await shot(tv, "living-age");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a deceased person shows death information and no living age", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.clock.setFixedTime(new Date(2026, 3, 11, 15, 0, 0).getTime());
        await signIn(tv);
        await person(tv, { death_date: "2010-01-02" });
        await tv.page.getByText("Born Apr 12, 1980", { exact: true }).waitFor();
        await tv.page.getByText("Died Jan 2, 2010", { exact: true }).waitFor();
        assert.equal(await tv.page.getByText("years old", { exact: false }).count(), 0);
        await shot(tv, "deceased");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("invalid and missing dates stay visible without inventing an age", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.clock.setFixedTime(new Date(2023, 1, 28, 12, 0, 0).getTime());
        await signIn(tv);
        await person(tv, { birth_date: "1980-02-31", birthplace: "Melbourne" });
        await tv.page.getByText("Born 1980-02-31", { exact: true }).waitFor();
        assert.equal(await tv.page.getByText("years old", { exact: false }).count(), 0);
        await tv.remote(BACK);
        await tv.page.route("**/api/v2/catalog/people/7", route => route.fulfill({
            status: 200, contentType: "application/json",
            body: JSON.stringify({ id: "7", name: "River Vale", birth_date: "2000-02-29", photo_url: "/art/river.svg" }),
        }));
        await tv.page.locator('[data-focus="person:7"]').first().focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByText("Born Feb 29, 2000", { exact: true }).waitFor();
        await tv.page.getByText("22 years old", { exact: true }).waitFor();
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a portrait without a photo shows initials and does not request an image", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await signIn(tv);
        const images: string[] = [];
        tv.page.on("request", request => { if (request.url().includes("/art/river.svg")) images.push(request.url()); });
        await person(tv, { name: "e\u0301lodie Martin", photo_url: "  ", photo_thumbhash: OPAQUE });
        const portrait = tv.page.locator(".person-portrait");
        assert.equal(await portrait.getAttribute("data-person-portrait"), "initials");
        assert.equal(await portrait.locator(".person-portrait-initials").textContent(), "E\u0301M");
        assert.equal(await portrait.locator("img, canvas").count(), 0);
        assert.equal(images.length, 0);
        assert.equal(await portrait.evaluate((node, hash) => node.outerHTML.includes(hash), OPAQUE), false);
        await shot(tv, "initials");
        await tv.remote(BACK);
        await person(tv, { name: "   ", photo_url: undefined });
        assert.equal(await tv.page.locator(".person-portrait-initials").textContent(), "?");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

async function holdPhoto(tv: Tv): Promise<{ requests: Request[]; release(status?: number): void }> {
    const requests: Request[] = [];
    let status = 0;
    const waiting: (() => void)[] = [];
    await tv.page.route("**/art/person-hero.svg", async route => {
        requests.push(route.request());
        if (status === 0) await new Promise<void>(resolve => waiting.push(resolve));
        const body = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="30"><rect width="20" height="30" fill="#336699"/></svg>`;
        await route.fulfill({ status, contentType: status === 200 ? "image/svg+xml" : "text/plain", body: status === 200 ? body : "no" }).catch(() => undefined);
    });
    return {
        requests,
        release(code = 200) {
            status = code;
            for (const resume of waiting.splice(0)) resume();
        },
    };
}

test("thumbhash stays under a held photo, focus does not fetch, and the loaded image fades", async () => {
    const tv = await openTv(browser, { app: "browse", ...(CAPTURE === undefined ? {} : { video: `${CAPTURE}/normal-motion` }) });
    try {
        await tv.page.emulateMedia({ reducedMotion: "no-preference" });
        await signIn(tv);
        const held = await holdPhoto(tv);
        await person(tv, { photo_url: "/art/person-hero.svg", photo_thumbhash: `  ${OPAQUE}  ` });
        const portrait = tv.page.locator(".person-portrait");
        assert.equal(await portrait.getAttribute("data-person-portrait"), "loading");
        const canvas = portrait.locator("canvas");
        assert.equal(await canvas.getAttribute("width"), "23");
        assert.equal(await canvas.getAttribute("height"), "32");
        const image = portrait.locator("img");
        assert.equal(await image.getAttribute("alt"), "");
        assert.equal(await image.getAttribute("referrerpolicy"), "no-referrer");
        assert.equal(await image.evaluate(node => getComputedStyle(node).opacity), "0");
        assert.equal(await portrait.locator(".person-portrait-initials").count(), 0);
        assert.equal(await portrait.evaluate((node, hash) => node.outerHTML.includes(hash), OPAQUE), false);
        const request = held.requests[0];
        assert.ok(request);
        assert.equal(new URL(request.url()).search, "");
        assert.equal(request.headers()["authorization"], undefined);
        assert.equal(request.headers()["x-profile-token"], undefined);
        assert.equal(request.headers()["referer"], undefined);
        const reads = tv.fake.requests.length;
        const photos = held.requests.length;
        await tv.page.locator('[data-focus="see-all"]').focus();
        await tv.page.keyboard.press("ArrowLeft");
        await tv.page.keyboard.press("ArrowRight");
        assert.equal(tv.fake.requests.length, reads, "focus movement must not fetch");
        assert.equal(held.requests.length, photos, "focus movement must not reload the portrait");
        await shot(tv, "thumbhash-held");
        held.release(200);
        await tv.eventually(async () => await portrait.getAttribute("data-person-portrait") === "loaded", "photo loaded");
        assert.equal(await image.evaluate(node => getComputedStyle(node).transitionDuration), "0.12s");
        await tv.eventually(async () => await image.evaluate(node => getComputedStyle(node).opacity) === "1", "photo faded in");
        await shot(tv, "photo-loaded");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("reduced motion shows the loaded photo without a fade", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await signIn(tv);
        await person(tv, { photo_thumbhash: OPAQUE });
        const image = tv.page.locator(".person-portrait img");
        await tv.eventually(async () => await tv.page.locator(".person-portrait").getAttribute("data-person-portrait") === "loaded", "photo loaded");
        assert.equal(await image.evaluate(node => getComputedStyle(node).transitionDuration), "0s");
        assert.equal(await image.evaluate(node => getComputedStyle(node).opacity), "1");
        await shot(tv, "reduced-motion-loaded");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a photo that fails keeps the thumbhash and does not replace it with initials", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await signIn(tv);
        const held = await holdPhoto(tv);
        await person(tv, { photo_url: "/art/person-hero.svg", photo_thumbhash: OPAQUE });
        held.release(404);
        const portrait = tv.page.locator(".person-portrait");
        await tv.eventually(async () => await portrait.getAttribute("data-person-portrait") === "error", "photo error");
        assert.equal(await portrait.locator("canvas").count(), 1);
        assert.equal(await portrait.locator("img").count(), 0);
        assert.equal(await portrait.locator(".person-portrait-initials").count(), 0);
        assert.equal(await portrait.locator(".person-portrait-missing").count(), 1);
        await shot(tv, "photo-error");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a photo without a thumbhash uses the surface until it loads or fails", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await signIn(tv);
        const held = await holdPhoto(tv);
        await person(tv, { photo_url: "/art/person-hero.svg", photo_thumbhash: "not base64" });
        const portrait = tv.page.locator(".person-portrait");
        assert.equal(await portrait.locator("canvas").count(), 0);
        assert.equal(await portrait.getAttribute("data-person-portrait"), "loading");
        held.release(404);
        await tv.eventually(async () => await portrait.getAttribute("data-person-portrait") === "error", "missing preview error");
        assert.equal(await portrait.locator(".person-portrait-initials").count(), 0);
        assert.equal(await portrait.locator(".person-portrait-missing").count(), 1);
        await shot(tv, "no-hash-error");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Back cancels a late portrait image before it can paint", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await signIn(tv);
        const held = await holdPhoto(tv);
        await person(tv, { photo_url: "/art/person-hero.svg", photo_thumbhash: OPAQUE });
        assert.equal(held.requests.length, 1);
        const failed = tv.page.waitForEvent("requestfailed", request => request.resourceType() === "image" && request.url().includes("/art/person-hero.svg"));
        await tv.remote(BACK);
        const request = await failed;
        assert.match(request.failure()?.errorText ?? "", /ABORTED|ERR_ABORTED|cancelled|canceled/i);
        assert.equal(await tv.page.locator(".person-portrait").count(), 0);
        held.release(200);
        await tv.jump(300);
        assert.equal(await tv.page.locator(".person-portrait").count(), 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("an authority change cancels a late portrait image", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await signIn(tv);
        const held = await holdPhoto(tv);
        await person(tv, { photo_url: "/art/person-hero.svg", photo_thumbhash: OPAQUE });
        const failed = tv.page.waitForEvent("requestfailed", request => request.resourceType() === "image" && request.url().includes("/art/person-hero.svg"));
        await tv.page.evaluate(() => window.browseHarness.clearProfile());
        const request = await failed;
        assert.match(request.failure()?.errorText ?? "", /ABORTED|ERR_ABORTED|cancelled|canceled/i);
        assert.equal(await tv.page.locator(".browse").count(), 0);
        assert.equal(await tv.page.locator(".person-portrait").count(), 0);
        assert.equal(await tv.page.locator("#successor").count(), 1);
        held.release(200);
        await tv.jump(300);
        assert.equal(await tv.page.locator(".person-portrait").count(), 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
