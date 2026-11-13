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
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().waitFor();
    return catalog;
}

async function person(tv: Tv, body: Record<string, unknown>): Promise<void> {
    await tv.page.route("**/api/v2/catalog/people/7", route => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "7", name: "River Vale", bio: "A synthetic performer whose work spans film and television.", birth_date: "1980-04-12", birthplace: "Melbourne", photo_url: "/art/river.svg", ...body }),
    }));
    await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('.browse[data-view="person:7"] .person-portrait').waitFor();
    await tv.eventually(async () => await tv.page.getByText("Loading metadata", { exact: true }).count() === 0, "person metadata ready");
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
        await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByText("Born Feb 29, 2000", { exact: true }).waitFor();
        await tv.page.getByText("22 years old", { exact: true }).waitFor();
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a portrait without a photo shows initials and does not request an image", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        // Defer the preceding lazy image so the boundary cannot depend on viewport prefetch.
        await tv.page.addStyleTag({ content: '[data-view^="item:"] .details-people [data-focus^="credit:7:"] img { display: none; }' });
        await signIn(tv);
        await tv.page.locator('.details-people [data-focus^="credit:7:"] img').first().evaluate(image => {
            const photo = image as HTMLImageElement;
            photo.loading = "eager";
            return photo.decode();
        });
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
        await tv.page.locator('[data-focus="filter:video"]').focus();
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
        await tv.eventually(async () => held.requests.length === 1, "the held portrait request before Back");
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

async function filmography(tv: Tv): Promise<void> {
    await signIn(tv);
    await person(tv, {});
    await tv.page.locator('.browse[data-view="person:7"] .browse-grid .browse-card').first().waitFor();
}

async function firstRowCount(tv: Tv): Promise<number> {
    return tv.page.locator(".browse-grid").evaluate(grid => {
        const cards = [...grid.querySelectorAll<HTMLElement>(".browse-card")];
        const top = cards[0]?.getBoundingClientRect().top ?? 0;
        return cards.filter(card => Math.abs(card.getBoundingClientRect().top - top) < 2).length;
    });
}

async function columnAgainstChips(tv: Tv): Promise<{ overlaps: boolean }[]> {
    return tv.page.locator(".browse-grid").evaluate(grid => {
        const cards = [...grid.querySelectorAll<HTMLElement>(".browse-card")].slice(0, 3);
        const chips = [...document.querySelectorAll<HTMLElement>(".person-filmography-filters [data-focus]")];
        return cards.map(card => {
            const origin = card.getBoundingClientRect();
            // At-rest frames: a just-clicked chip is still scaling up around its centre, which would widen it past column 1.
            const rects = chips.map(chip => {
                const frame = chip.getBoundingClientRect();
                const centre = frame.left + frame.width / 2;
                return { left: centre - chip.offsetWidth / 2, right: centre + chip.offsetWidth / 2 };
            });
            return { overlaps: rects.some(chip => origin.left < chip.right && chip.left < origin.right) };
        });
    });
}

/** Movies is focused and is not the selected filter. Up uses the card frame, not that chip. */
async function upFromColumns(tv: Tv, columns: number, selected: string): Promise<void> {
    assert.equal(await tv.page.locator(`[data-focus="${selected}"]`).getAttribute("aria-pressed"), "true");
    const placement = await columnAgainstChips(tv);
    // Was [true, true, false] while the 1600px grid overlapped its cards and pulled column 1 under Series (#426).
    assert.deepEqual(placement.map(item => item.overlaps), [true, false, false], "only column 0 meets the chip row; columns 1 and 2 have no chip above them");
    await tv.page.locator('[data-focus="filter:movie"]').focus();
    assert.equal(await tv.focused(), "filter:movie");
    for (let column = 0; column < columns; column += 1) {
        await tv.page.keyboard.press("ArrowDown");
        for (let guard = 0; guard < columns; guard += 1) {
            const before = await tv.focused();
            await tv.page.keyboard.press("ArrowLeft");
            if (await tv.focused() === before) break;
        }
        for (let step = 0; step < column; step += 1) await tv.page.keyboard.press("ArrowRight");
        const card = await tv.focused();
        assert.match(card ?? "", /^(movie|series):/, `column ${column} kept a card`);
        await tv.page.keyboard.press("ArrowUp");
        // Replaces `assert.equal(landed, column <= 1 ? selected : card, "column ${column} used to return to the focused Movies chip")`.
        // That followed the selected filter, which matches column 0 only while All is selected.
        const landed = await tv.focused();
        const expected = column === 0 ? "filter:video" : card;
        assert.equal(landed, expected, `column ${column} lands on the chip spanning the card's left edge; selected ${selected} does not decide`);
        assert.ok(landed, "focus was lost");
        await tv.page.locator('[data-focus="filter:movie"]').focus();
    }
    assert.equal(await tv.page.locator(`[data-focus="${selected}"]`).getAttribute("aria-pressed"), "true", "moving Up does not select Movies");
}

test("Up from a filmography card follows that card against the chips", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await filmography(tv);
        const columns = await firstRowCount(tv);
        assert.ok(columns >= 3, "the first filmography row has a column with no chip above it");
        await upFromColumns(tv, columns, "filter:video");
        await tv.page.locator('[data-focus="filter:series"]').click();
        await tv.eventually(async () => await tv.page.locator(".browse-grid .browse-card").count() === 3, "Series filmography");
        const seriesColumns = await firstRowCount(tv);
        assert.equal(seriesColumns, 3, "Series uses the wider card positions in the first three columns");
        await upFromColumns(tv, seriesColumns, "filter:series");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Down into the filmography grid uses Apple's bottom scroll inset", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await filmography(tv);
        await tv.page.locator('[data-focus="filter:video"]').focus();
        await tv.page.keyboard.press("ArrowDown");
        await tv.jump(300);
        const placed = await tv.page.locator(".browse").evaluate(node => {
            const browse = node.getBoundingClientRect();
            const card = node.querySelector(".browse-grid .browse-card:focus")?.getBoundingClientRect();
            const title = node.querySelector(".person-filmography-heading")?.getBoundingClientRect();
            const name = node.querySelector(".details-person-hero .browse-title")?.getBoundingClientRect();
            const art = node.querySelector(".browse-grid .browse-card:focus .browse-art")?.getBoundingClientRect();
            return {
                scroll: node.scrollTop,
                clearance: card === undefined ? -1 : browse.bottom - card.bottom,
                titleTop: title?.top ?? -1,
                titleBottom: title?.bottom ?? -1,
                nameBottom: name?.bottom ?? 1,
                outlineTop: art?.top ?? -1,
            };
        });
        // Was 92: the generic 32px reveal plus the 60px safe area, 40px short of PersonDetailView's 72px bottom padding.
        assert.equal(Math.round(placed.clearance), 132, `was 92; scroll ${placed.scroll}, title ${placed.titleTop}, outline ${placed.outlineTop}`);
        assert.ok(placed.titleTop >= 0 && placed.titleBottom > placed.titleTop, "the filmography title stays fully below the top edge");
        assert.ok(placed.nameBottom <= 0, `person title bottom ${placed.nameBottom} still shows a descender at the top edge`);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("the person name and facts sit on Apple's line box", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await signIn(tv);
        await person(tv, {});
        await tv.page.locator(".details-person-hero").waitFor();
        // Query and measure in one synchronous step: a repaint rebuilds the hero and detaches a node resolved earlier.
        const placed = await tv.page.evaluate(() => {
            const hero = document.querySelector(".details-person-hero");
            if (hero === null) return null;
            const portrait = hero.querySelector(".person-portrait")?.getBoundingClientRect();
            const name = hero.querySelector(".browse-title");
            const facts = hero.querySelector(".person-facts")?.getBoundingClientRect();
            const nameBox = name?.getBoundingClientRect();
            if (portrait === undefined || nameBox === undefined || facts === undefined || !(name instanceof Element)) return null;
            return {
                nameTop: nameBox.top - portrait.top,
                nameHeight: nameBox.height,
                factsTop: facts.top - portrait.top,
                lineHeight: getComputedStyle(name).lineHeight,
                marginTop: getComputedStyle(name).marginTop,
            };
        });
        // PersonDetailView.swift:466 pads the column 10pt. The name at line 451 is
        // .system(size: 72, weight: .bold). That face's line height is 84.796875
        // (ascender 69.609375, descender -15.1875, leading 0) and SwiftUI lays the
        // text out 85pt tall. The facts row is the VStack spacing of 22 at line 449
        // below that box: 10 + 85 + 22 = 117.
        assert.deepEqual(placed, { nameTop: 10, nameHeight: 85, factsTop: 117, lineHeight: "85px", marginTop: "0px" });
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("person biography uses Apple's body size, line and clamp", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await signIn(tv);
        const paragraph = "This biography sentence is long enough to wrap across the overview column more than once on the person page.";
        await person(tv, { bio: Array.from({ length: 6 }, () => paragraph).join("\n\n") });
        await tv.page.locator('.browse[data-view^="person:"] .browse-overview').waitFor();
        // Query and measure in one synchronous step: a repaint can detach a node resolved earlier (zero height).
        const bio = await tv.page.evaluate(() => {
            const node = document.querySelector('.browse[data-view^="person:"] .browse-overview');
            if (node === null) return null;
            const computed = getComputedStyle(node);
            return { fontSize: computed.fontSize, lineHeight: computed.lineHeight, height: node.getBoundingClientRect().height, clipped: node.scrollHeight > node.clientHeight };
        });
        // PersonDetailView.swift:459 .siloBody (Typography.swift:28, 26pt regular), lineLimit(7) at :461, no lineSpacing.
        // Apple TV at 2ef3a171 draws those lines 31px apart (measured, 8 Nov 2026), so seven lines are 217px tall.
        // 26 times --silo-sf-cap-scale (#418); the line stays 31.
        assert.deepEqual(bio, { fontSize: "25.181px", lineHeight: "31px", height: 217, clipped: true });
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("person biography keeps the blank line between paragraphs", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await signIn(tv);
        const first = "First paragraph of the biography.";
        const second = "Second paragraph starts after the blank line.";
        await person(tv, { bio: `${first}\n\n${second}` });
        await tv.page.locator(".details-person-hero .browse-overview").waitFor();
        // Availability and filmography loads repaint the hero, so a node resolved earlier can be detached
        // (all-zero rects, "paragraph gap 0"). Query and measure in one synchronous step instead.
        const gap = await tv.page.evaluate(parts => {
            const node = document.querySelector(".details-person-hero .browse-overview");
            const text = node?.firstChild;
            if (text === null || text === undefined) return -1;
            const value = text.textContent ?? "";
            const range = document.createRange();
            range.setStart(text, 0);
            range.setEnd(text, parts.first.length);
            const opening = range.getBoundingClientRect();
            const start = value.indexOf(parts.second);
            range.setStart(text, start);
            range.setEnd(text, start + parts.second.length);
            return range.getBoundingClientRect().top - opening.bottom;
        }, { first, second });
        assert.ok(gap > 20, `paragraph gap ${gap}`);
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
