import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { mkdir } from "node:fs/promises";
import { FakeRequests } from "../native/support/fakeRequests.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });
async function start(tv: Tv, fake = new FakeRequests(), offerSignOut = false): Promise<FakeRequests> {
    tv.fake.catalog = fake;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? ""); await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(offer => window.browseHarness.mount(offer), offerSignOut);
    await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
    return fake;
}
const button = (tv: Tv, key: string) => tv.page.locator(`[data-focus="${key}"]`).last();
/** Selecting the shown tab reads nothing; a fresh read comes from leaving and returning, as on Apple TV. */
const revisitRequests = async (tv: Tv): Promise<void> => {
    await button(tv, "home").click(); await tv.page.locator('.browse[data-view="home"]').waitFor();
    await button(tv, "requests").click();
};
test("dense request captions retain the matched native title words", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests();
        tv.fake.script("/requests/mine?limit=50", { status: 200, body: { items: [
            { ...fake.record, id: "street", title: "Street Fighter" },
            { ...fake.record, id: "neuro", title: "Neuromancer" },
        ], page: { has_more: false } } });
        await start(tv, fake); await button(tv, "requests").click();
        await button(tv, "street").waitFor();
        await tv.page.evaluate(async () => document.fonts.ready);
        for (const key of ["street", "neuro"]) assert.ok(await button(tv, key).locator(".browse-card-title").evaluate(node => {
            const text = document.createRange(); text.selectNodeContents(node);
            return text.getBoundingClientRect().width <= node.clientWidth;
        }), `${key} must fit without an ellipsis`);
    } finally { await tv.page.context().close(); }
});
test("Requests backdrop leaves shelf headings and captions painted above it", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.route("https://image.tmdb.org/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#111"/></svg>' }));
        const fake = new FakeRequests(); fake.created = true;
        Object.assign(fake.record, { backdrop_path: "/backdrop.svg" });
        await start(tv, fake); await button(tv, "requests").click();
        await button(tv, "request-one").waitFor();
        await tv.page.locator(".requests-preview img").evaluate(async node => { await (node as HTMLImageElement).decode(); });
        assert.equal(await tv.page.locator(".requests-preview .skyline-top-scrim").evaluate(node => node.getBoundingClientRect().height), 190, "bright Requests artwork keeps the shared native top-menu scrim");
        for (const selector of [".requests-heading", ".requests-card .browse-card-title"]) {
            const png = await tv.page.locator(selector).first().screenshot({ animations: "disabled" });
            const bright = await tv.page.evaluate(async encoded => {
                const image = new Image(); image.src = `data:image/png;base64,${encoded}`; await image.decode();
                const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
                const context = canvas.getContext("2d"); if (context === null) throw new Error("Missing test canvas");
                context.drawImage(image, 0, 0);
                const pixels = context.getImageData(0, 0, image.width, image.height).data;
                let count = 0;
                for (let index = 0; index < pixels.length; index += 4) if ((pixels[index] ?? 0) > 220 && (pixels[index + 1] ?? 0) > 220 && (pixels[index + 2] ?? 0) > 220) count++;
                return count;
            }, png.toString("base64"));
            assert.ok(bright > 20, `${selector} must paint readable text above the backdrop (${bright} bright pixels)`);
        }
        await button(tv, "request-one").click(); await view(tv, "request");
        const wash = await tv.page.locator(".requests-detail-hero .skyline-tint-wash").evaluate(node => getComputedStyle(node).backgroundImage);
        assert.notEqual(wash, "none", "the detail wash must be accepted by the CSS renderer");
        assert.equal(wash.includes("240.64deg"), false, "Details uses the uniform base rather than the root diagonal");
        assert.equal(await tv.page.locator(".requests-detail-hero .skyline-top-scrim").count(), 0);
    } finally { await tv.page.context().close(); }
});
test("Requests hub has mine first, horizontal rails and a passive loaded preview", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true;
        await start(tv, fake); await button(tv, "requests").click();
        await button(tv, "movie:949").waitFor();
        await tv.page.addStyleTag({ content: "* { font-family: SamsungOne; font-weight: 600; }" });
        const synopsis = await tv.page.locator(".requests-preview .requests-synopsis").evaluate(node => {
            const style = getComputedStyle(node); return [style.fontFamily, style.fontWeight];
        });
        assert.match(synopsis[0] ?? "", /Inter/);
        assert.equal(synopsis[1], "400");
        assert.equal(await tv.page.locator('.requests-rail').count(), 2);
        assert.equal(await tv.page.locator('.requests-heading').first().textContent(), "Your requests");
        assert.equal(await tv.page.locator('.requests-preview h1').textContent(), "Heat");
        assert.ok(Math.abs(await tv.page.locator(".requests-hero-copy").evaluate(node => node.getBoundingClientRect().bottom) - 536) < 1, "the marquee anchors its content bottom, including short descriptions");
        assert.equal(await tv.page.locator('.requests-preview button').count(), 0);
        assert.equal(await tv.focused(), "request-one", "accepted first load enters the first native request card");
        assert.equal(await tv.page.locator('.browse.requests-hub > .skyline-content').evaluate(node => node.getBoundingClientRect().top), 596);
        assert.equal(await tv.page.locator('.requests-rail .browse-art').first().evaluate(node => getComputedStyle(node).width), "176px");
        await button(tv, "request-one").focus();
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        const focusedArt = button(tv, "request-one").locator(".browse-art");
        assert.equal(await focusedArt.evaluate(node => node.getBoundingClientRect().width), 176);
        assert.notEqual(await focusedArt.evaluate(node => getComputedStyle(node).boxShadow), "none");
        await tv.page.emulateMedia({ reducedMotion: "no-preference" });
        const reads = tv.fake.paths().length;
        await tv.remote(40); await tv.remote(37);
        assert.equal(tv.fake.paths().length, reads, "focus never reads metadata");
        await button(tv, "request-one").click(); await view(tv, "request");
        await tv.remote(10009); assert.equal(await tv.focused(), "request-one");
    } finally { await tv.page.context().close(); }
});
test("wrapped request titles limit synopsis to two lines and retain the provider rating", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(), title = fake.title.bind(fake);
        fake.title = () => ({ ...title(), title: "Apocalypse Z: New World", overview: "A long overview describing the world and the characters. ".repeat(12), vote_average: 6.1 });
        await start(tv, fake); await button(tv, "requests").click();
        await tv.page.locator(".requests-preview h1").waitFor();
        await tv.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        assert.equal(await tv.page.locator(".requests-preview .requests-synopsis").evaluate(node => getComputedStyle(node).webkitLineClamp), "2");
        assert.equal(await tv.page.locator(".requests-preview h1").evaluate(node => {
            const text = node.firstChild; if (text === null) throw new Error("Missing title text");
            const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1); const firstTop = range.getBoundingClientRect().top;
            const prefix = node.textContent?.indexOf("Z:") ?? -1; range.setStart(text, prefix); range.setEnd(text, prefix + 2);
            if (range.getBoundingClientRect().top !== firstTop) return false;
            const start = node.textContent?.indexOf("New") ?? -1; range.setStart(text, start); range.setEnd(text, start + 3);
            return range.getBoundingClientRect().top > firstTop;
        }), true, "the matched Apocalypse title wraps New World together");
        assert.equal(await tv.page.locator(".requests-preview .requests-tmdb").textContent(), "6.1");
        assert.ok(Math.abs(await tv.page.locator(".requests-hero-copy").evaluate(node => node.getBoundingClientRect().bottom) - 536) < 1);
    } finally { await tv.page.context().close(); }
});
test("a wrapped hero title fills its first line like Apple TV", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(), title = fake.title.bind(fake);
        fake.title = () => ({ ...title(), title: "Law & Order: Special Victims Unit" });
        await start(tv, fake); await button(tv, "requests").click();
        await tv.page.locator(".requests-preview h1").waitFor();
        await tv.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        assert.deepEqual(await tv.page.locator(".requests-preview h1").evaluate(node => {
            const text = node.firstChild; if (text === null) throw new Error("Missing title text");
            const top = (word: string): number => {
                const start = node.textContent?.indexOf(word) ?? -1, range = document.createRange();
                range.setStart(text, start); range.setEnd(text, start + word.length);
                return range.getBoundingClientRect().top;
            };
            return [top("Special") === top("Law"), top("Victims") > top("Law")];
        }), [true, true]);
    } finally { await tv.page.context().close(); }
});
test("a cancelled request can be requested again from its page, as on Apple TV", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true;
        await start(tv, fake); await button(tv, "requests").click();
        await button(tv, "request-one").click(); await button(tv, "cancel").click();
        await button(tv, "create").waitFor();
        assert.equal(await tv.page.locator(".requests-eyebrow").textContent(), "Not in your library");
        assert.equal(await tv.page.locator(".requests-detail-progress").count(), 0);
        assert.equal(await button(tv, "status").count(), 0);
        await tv.eventually(async () => await tv.focused() === "create", "focus reaches the new action");
        await button(tv, "create").click();
        await tv.eventually(async () => tv.fake.paths().filter(path => path === "POST /requests").length === 1 && await button(tv, "status").count() === 1, "the new request shows its status");
        assert.equal(await tv.page.locator(".requests-eyebrow").textContent(), "Requested");
        assert.equal(await tv.page.locator(".requests-detail-progress").count(), 1);
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests").length, 1);
    } finally { await tv.page.context().close(); }
});
test("an unrequested title that cannot be requested is not labelled Requested", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(), title = fake.title.bind(fake);
        fake.title = () => ({ ...title(), request: { requestable: false, following: false, requested_by_viewer: false } });
        await start(tv, fake); await button(tv, "requests").click();
        await button(tv, "movie:949").click();
        await button(tv, "status").waitFor();
        assert.equal(await button(tv, "status").textContent(), "Unavailable");
        assert.equal(await tv.page.locator(".requests-eyebrow").textContent(), "Not in your library");
        assert.equal(await tv.page.locator(".requests-detail-progress").count(), 0);
    } finally { await tv.page.context().close(); }
});
test("Requests loads its complete bounded mine list and groups active requests before landed titles", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests();
        const record = (id: string, state: string, created: string) => ({ ...fake.record, id, title: id, state, created_at: created });
        tv.fake.script("/requests/mine?limit=50", { status: 200, body: { items: [record("landed", "available", "2026-01-03T12:00:00Z"), record("older", "pending", "2026-01-01T12:00:00Z")], page: { has_more: true, next_cursor: "next/+" } } });
        tv.fake.script("/requests/mine?limit=50&cursor=next%2F%2B", { status: 200, body: { items: [record("newer", "pending", "2026-01-02T12:00:00Z"), record("cancelled", "cancelled", "2026-01-04T12:00:00Z")], page: { has_more: false } } });
        await start(tv, fake); await button(tv, "requests").click();
        await button(tv, "movie:949").waitFor();
        assert.deepEqual(await tv.page.locator('.requests-heading').first().locator('xpath=following-sibling::*[1]').locator('.requests-card').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["newer", "older", "landed"]);
    } finally { await tv.page.context().close(); }
});
test("either failed hub read fails a first load, and a later failed refresh keeps the rows", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true;
        tv.fake.script("/requests/discover", problem(400, "validation_failed", "Unavailable"));
        await start(tv, fake); await button(tv, "requests").click();
        await tv.page.getByRole("button", { name: "Try Again", exact: true }).waitFor();
        await tv.page.getByText("Unavailable", { exact: true }).waitFor();
        assert.equal(await button(tv, "request-one").count(), 0, "Apple reads both sections together (RequestsHubViewModel.load)");
        await tv.page.getByRole("button", { name: "Try Again", exact: true }).click(); await button(tv, "movie:949").waitFor();
        await tv.page.getByText("Loading requests…").waitFor({ state: "detached" });
        // A settled write marks the hub stale, and Back reads it again.
        await button(tv, "request-one").click(); await button(tv, "cancel").waitFor();
        await button(tv, "cancel").click();
        await tv.eventually(async () => fake.cancelled && await button(tv, "cancel").count() === 0, "cancelled");
        tv.fake.script("/requests/mine?limit=50", problem(400, "validation_failed", "Unavailable"));
        const failed = tv.page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/requests/mine"));
        await tv.remote(10009); await failed;
        await tv.eventually(async () => await tv.page.getByRole("button", { name: "Try Again", exact: true }).count() === 0 && await tv.page.getByText("Unavailable", { exact: true }).count() === 0, "a failed refresh is silent");
        assert.equal(await button(tv, "movie:949").count(), 1);
        assert.equal(await button(tv, "request-one").count(), 1, "the earlier rows stay");
        assert.equal(await button(tv, "refresh").count(), 0);
        fake.cancelled = false; fake.created = true;
        const mineReads = tv.fake.paths().filter(path => path === "GET /requests/mine?limit=50").length;
        await revisitRequests(tv);
        await tv.eventually(async () => tv.fake.paths().filter(path => path === "GET /requests/mine?limit=50").length > mineReads, "returning to the tab reads again");
        await button(tv, "request-one").waitFor();
    } finally { await tv.page.context().close(); }
});
test("Requests catalog routing follows displayed state and a nonempty catalog identity", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); const original = fake.title.bind(fake);
        let state = "processing", catalogId = "movie:m0002";
        fake.title = () => ({ ...original(), availability: "available", library_content_id: catalogId, request: { requestable: false, following: false, requested_by_viewer: false, state, status: "queued" } });
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "movie:949").click();
        await view(tv, "media"); await tv.remote(10009);
        state = "available"; await button(tv, "requests").click();
        await tv.page.getByText("Loading requests…").waitFor({ state: "detached" });
        await button(tv, "movie:949").click();
        await tv.page.locator('.browse[data-view="item:movie:m0002"]').waitFor();
        await tv.remote(10009); catalogId = ""; await button(tv, "requests").click();
        await tv.page.getByText("Loading requests…").waitFor({ state: "detached" });
        await button(tv, "movie:949").click(); await view(tv, "media");
        assert.equal(tv.fake.paths().filter(path => path.startsWith("POST /requests")).length, 0);
    } finally { await tv.page.context().close(); }
});
test("request record detail reads verified title metadata and recommendations", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true;
        const original = fake.title.bind(fake);
        Object.assign(fake.record, { created_at: "2026-01-02T12:00:00Z", targets: [{ quality: "1080p", status: "queued" }, { quality: "4K", status: "completed" }] });
        fake.title = () => ({ ...original(), year: 1995, runtime: 170, director: "Michael Mann", recommendations: [{ ...original(), tmdb_id: 950, title: "Related title" }] });
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "request-one").click();
        await view(tv, "request");
        await tv.page.getByText("Directed by Michael Mann", { exact: true }).waitFor();
        assert.equal(await tv.page.locator(".requests-detail-hero .requests-synopsis").evaluate(node => getComputedStyle(node).color), "rgba(255, 255, 255, 0.92)");
        assert.equal(await tv.page.locator(".requests-credit").evaluate(node => getComputedStyle(node).fontSize), "23px");
        await tv.page.getByText("REQUESTED", { exact: true }).waitFor();
        await tv.page.getByText("QUALITY", { exact: true }).waitFor();
        assert.ok(await tv.page.locator(".requests-credit").evaluate(node => node.getBoundingClientRect().top) > await tv.page.locator(".requests-track-labels").evaluate(node => node.getBoundingClientRect().bottom));
        await tv.page.getByText("1080p queued · 4K done", { exact: true }).waitFor();
        await tv.page.getByRole("heading", { name: "More like this" }).waitFor();
        const poster = tv.page.locator(".requests-detail-hero ~ .requests-rail .browse-art").first();
        assert.equal(await poster.evaluate(node => node.getBoundingClientRect().width), 220);
        await tv.page.locator(".browse").evaluate(node => (node as HTMLElement).style.setProperty("--poster-scale", "0.86"));
        assert.ok(Math.abs(await poster.evaluate(node => node.getBoundingClientRect().width) - 189.2) < 0.1);
        await button(tv, "movie:950").click(); await view(tv, "media");
        assert.equal(tv.fake.paths().filter(path => path.startsWith("POST /requests")).length, 0);
    } finally { await tv.page.context().close(); }
});
test("series request details show seasons and creators and open a newly available catalog title", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true;
        Object.assign(fake.record, { media_type: "series" });
        const title = fake.title.bind(fake);
        fake.title = () => ({ ...title(), media_type: "series", number_of_seasons: 3, creators: ["Creator One", "Creator Two", "Creator Three"] });
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "request-one").click();
        await tv.page.locator(".requests-detail-title").waitFor();
        assert.equal(await tv.page.getByText("3 seasons", { exact: true }).count(), 1);
        await tv.page.getByText("Created by Creator One, Creator Two", { exact: true }).waitFor();
        // A ready detail has no Refresh; a failed metadata read offers it, and the next read shows the new state.
        await tv.remote(10009); await view(tv, "hub");
        tv.fake.script("/requests/detail/series/949", problem(400, "validation_failed", "Unavailable"));
        await button(tv, "request-one").click();
        await tv.page.getByText("Could not load title information. Refresh to try again.").waitFor();
        Object.assign(fake.record, { state: "available", library_content_id: "movie:m0002" });
        await button(tv, "refresh").click();
        await tv.page.getByRole("button", { name: "Open in Library", exact: true }).click();
        await tv.page.locator('.browse[data-view="item:movie:m0002"]').waitFor();
        assert.equal(tv.fake.paths().filter(path => path.startsWith("POST /requests")).length, 0);
    } finally { await tv.page.context().close(); }
});
test("a hub section capability refusal rechecks permission and retires Requests", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        const held = tv.fake.hold("/requests/discover", true);
        tv.fake.script("/requests/discover", problem(409, "capability_disabled", "Disabled"));
        await button(tv, "requests").click();
        await tv.eventually(async () => tv.fake.paths().includes("GET /requests/discover"), "hub read started");
        fake.enabled = false; held.release();
        await tv.page.locator('.browse[data-view="home"]').waitFor();
        assert.equal(await button(tv, "requests").count(), 0);
    } finally { await tv.page.context().close(); }
});
test("Requests artwork spans discover, rows, mine and both details with accessible fallback", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests();
        Object.assign(fake.record, { poster_path: "/request-poster.jpg", backdrop_path: "/request-backdrop.jpg" });
        const title = fake.title.bind(fake);
        fake.title = () => ({ ...title(), poster_path: "/request-poster.jpg", backdrop_path: "/request-backdrop.jpg" });
        await tv.page.route("https://image.tmdb.org/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513"><rect width="342" height="513" fill="blue"/></svg>' }));
        await start(tv, fake);
        const check = async (selector: string): Promise<void> => {
            await tv.page.locator(selector).waitFor();
            const image = tv.page.locator(selector).locator("img");
            assert.equal(await image.count(), 1, "request surface renders its poster");
            assert.equal(await image.getAttribute("src"), "https://image.tmdb.org/t/p/w342/request-poster.jpg");
            assert.equal(await image.getAttribute("referrerpolicy"), "no-referrer");
            assert.equal(await image.getAttribute("alt"), "");
            assert.equal(await image.getAttribute("loading"), "lazy");
            await image.scrollIntoViewIfNeeded();
            await image.evaluate(image => (image as HTMLImageElement).decode());
        };
        await button(tv, "requests").click();
        await check('[data-focus="movie:949"]');
        await tv.page.getByRole("button", { name: "Heat · Not requested", exact: true }).waitFor();
        assert.equal(await button(tv, "more").count(), 0, "a paginated row has no See all tile, as on Apple TV");
        await button(tv, "movie:949").click(); await view(tv, "media");
        await tv.page.locator('.requests-detail-hero .skyline-backdrop').waitFor();
        await button(tv, "create").click();
        await tv.eventually(async () => fake.created && await button(tv, "create").count() === 0, "created");
        await tv.remote(10009); await button(tv, "request-one").waitFor();
        await check('[data-focus="request-one"]');
        await button(tv, "request-one").click(); await view(tv, "request");
        await tv.page.locator('.requests-detail-hero .skyline-backdrop').waitFor();
        await button(tv, "cancel").waitFor();
        const focused = await tv.focused();
        await tv.page.locator('.requests-detail-hero .skyline-backdrop').dispatchEvent("error");
        await tv.page.locator('.requests-detail-hero h1').getByText("Heat", { exact: true }).waitFor();
        assert.equal(await tv.focused(), focused, "image failure preserves focus");
        await tv.remote(10009);
        for (const poster of [undefined, "", "bad-path", "http://images.example.test/poster.jpg"]) {
            fake.title = () => ({ ...title(), poster_path: poster });
            await button(tv, "requests").click(); await button(tv, "movie:949").waitFor();
            await tv.page.getByText("Loading requests…").waitFor({ state: "detached" });
            await button(tv, "movie:949").locator(".browse-art-missing").getByText("Heat", { exact: true }).waitFor();
            assert.equal(await button(tv, "movie:949").locator("img").count(), 0);
        }
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
async function view(tv: Tv, kind: string): Promise<void> { await tv.page.locator(`.browse[data-view="requests:${kind}"]`).waitFor(); }
async function evidence(tv: Tv, name: string): Promise<void> {
    if (!process.env.REQUESTS_EVIDENCE) return;
    await mkdir(process.env.REQUESTS_EVIDENCE, { recursive: true });
    await tv.page.screenshot({ path: `${process.env.REQUESTS_EVIDENCE}/${name}.png` });
}
test("Requests hub, create, Your requests and cancel preserve return focus", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv); await evidence(tv, "home");
        await button(tv, "requests").click(); await view(tv, "hub");
        await button(tv, "movie:949").waitFor(); await evidence(tv, "hub");
        const count = tv.fake.requests.length; await button(tv, "movie:949").focus(); await tv.remote(40);
        assert.equal(tv.fake.requests.length, count, "focus never fetches");
        await button(tv, "movie:949").click(); await view(tv, "media");
        await button(tv, "create").waitFor(); await evidence(tv, "detail");
        await button(tv, "create").click();
        await tv.eventually(async () => fake.created && await button(tv, "create").count() === 0, "created");
        await tv.remote(10009); await view(tv, "hub");
        await button(tv, "request-one").waitFor();
        assert.equal(await tv.focused(), "movie:949", "Back from a detail restores its originating card after the write refresh");
        await button(tv, "request-one").click(); await view(tv, "request"); await button(tv, "cancel").waitFor();
        await evidence(tv, "my-request"); await button(tv, "cancel").click();
        await tv.eventually(async () => fake.cancelled && await button(tv, "cancel").count() === 0, "cancelled");
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests").length, 1);
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests/request-one/cancel").length, 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
test("Requests disabled, empty, failure, Try Again and capability removal", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.enabled = false; await start(tv, fake);
        assert.equal(await button(tv, "requests").count(), 0);
        fake.enabled = true;
        await tv.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await button(tv, "requests").waitFor(); await button(tv, "requests").click(); await view(tv, "hub");
        await tv.page.getByText("Loading requests…", { exact: true }).waitFor({ state: "detached" });
        await button(tv, "movie:949").waitFor();
        fake.requestsEmpty = true; await revisitRequests(tv);
        await tv.page.getByText("Nothing here yet", { exact: true }).waitFor(); await evidence(tv, "empty");
        await tv.page.getByText("Loading requests…", { exact: true }).waitFor({ state: "detached" });
        fake.requestFailure = problem(400, "validation_failed", "Unavailable"); await revisitRequests(tv);
        await tv.page.getByRole("button", { name: "Try Again", exact: true }).waitFor(); await evidence(tv, "failure");
        await tv.page.getByText("Loading requests…", { exact: true }).waitFor({ state: "detached" });
        fake.requestFailure = undefined; fake.requestsEmpty = false; await button(tv, "retry").click(); await button(tv, "movie:949").waitFor();
        await tv.page.getByText("Loading requests…").waitFor({ state: "detached" });
        fake.enabled = false; await button(tv, "movie:949").click();
        await tv.page.locator('.browse[data-view="home"]').waitFor();
        assert.equal(await button(tv, "requests").count(), 0);
        assert.equal(await tv.focused(), "home");
    } finally { await tv.page.context().close(); }
});
test("follow and unfollow never replay lost answers; refresh reconciles create", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv); fake.following = true; fake.requestedByOther = true;
        await button(tv, "requests").click(); await button(tv, "movie:949").click(); await button(tv, "follow").waitFor();
        await button(tv, "follow").click();
        await tv.eventually(async () => !fake.following, "unfollowed");
        await tv.page.getByRole("button", { name: "Follow", exact: true }).waitFor();
        await button(tv, "follow").click();
        await tv.page.getByRole("button", { name: "Unfollow", exact: true }).waitFor();
        assert.equal(tv.fake.paths().filter(path => path === "PUT /requests/follows/movie/949").length, 1);
        // A different viewer's request remains followable after unfollowing.
        fake.following = true; await tv.remote(10009); await view(tv, "hub"); await button(tv, "movie:949").click();
        await tv.page.getByRole("button", { name: "Unfollow", exact: true }).waitFor();
        tv.fake.script("/requests/detail/movie/949", { status: 400, text: "bad" });
        tv.fake.dropNextAnswer("/requests/follows/movie/949"); await button(tv, "follow").click();
        await tv.page.getByText("Could not confirm the change. Refresh before trying again.").waitFor();
        await tv.jump(2000);
        assert.equal(tv.fake.paths().filter(path => path === "DELETE /requests/follows/movie/949").length, 2);
        assert.equal(await button(tv, "follow").isDisabled(), true);
        fake.requestedByOther = false;
        await button(tv, "refresh").click(); await button(tv, "create").waitFor();
        await tv.eventually(async () => !await button(tv, "create").isDisabled(), "refreshed");
        tv.fake.script("/requests/detail/movie/949", { status: 400, text: "bad" });
        tv.fake.dropNextAnswer("/requests"); await button(tv, "create").click();
        await tv.page.getByText(UNCONFIRMED_REQUEST).waitFor();
        await tv.jump(2000); assert.equal(tv.fake.paths().filter(path => path === "POST /requests").length, 1);
        await button(tv, "refresh").click();
        await tv.eventually(async () => await button(tv, "create").count() === 0, "create reconciled");
    } finally { await tv.page.context().close(); }
});
test("late Requests answer cannot survive a profile switch", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        const held = tv.fake.hold("/requests/discover", true);
        await button(tv, "requests").click(); await view(tv, "hub");
        await tv.eventually(async () => tv.fake.paths().includes("GET /requests/discover"), "held discovery");
        await evidence(tv, "loading");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-kid"));
        held.release(); await tv.jump(1);
        assert.equal(await tv.page.locator(".browse").count(), 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("cancel lost response is read back without replay and writes refuse refresh replay", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv); fake.created = true;
        await button(tv, "requests").click();
        await button(tv, "request-one").click(); await button(tv, "cancel").waitFor();
        tv.fake.script("/requests/request-one", { status: 400, text: "bad" });
        tv.fake.dropNextAnswer("/requests/request-one/cancel"); await button(tv, "cancel").click();
        await tv.page.getByText(UNCONFIRMED_CANCEL).waitFor();
        await tv.jump(2000);
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests/request-one/cancel").length, 1);
        assert.equal(await button(tv, "cancel").count(), 0, "Apple hides an unconfirmed Cancel until a read settles it");
        assert.equal(await tv.focused(), "status");
        await tv.remote(38);
        assert.notEqual(await tv.focused(), "cancel", "disabled actions are absent from focus zones");
        await button(tv, "refresh").focus(); await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await button(tv, "cancel").count() === 0, "cancel reconciled");
        await tv.remote(10009); await button(tv, "movie:949").click(); await button(tv, "create").waitFor();
        const refreshes = tv.fake.paths().filter(path => path.includes("/auth/refresh")).length;
        tv.fake.script("/requests", problem(401, "token_refresh_required", "Refresh required"));
        await button(tv, "create").click();
        await tv.page.getByText("Refresh required").waitFor();
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests").length, 1);
        assert.equal(tv.fake.paths().filter(path => path.includes("/auth/refresh")).length, refreshes + 1, "session may refresh, but never resends the write");
    } finally { await tv.page.context().close(); }
});

test("a held write fences profile changes", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv); await button(tv, "requests").click(); await button(tv, "movie:949").click(); await button(tv, "create").waitFor();
        const write = tv.fake.hold("/requests", true);
        await button(tv, "create").click();
        await tv.eventually(async () => tv.fake.paths().includes("POST /requests"), "write held");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-kid"));
        write.release(); await tv.jump(1);
        assert.equal(await tv.page.locator(".browse").count(), 0);
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests").length, 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("reopened detail reconciles after a background write settles", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        await button(tv, "requests").click(); await button(tv, "movie:949").click(); await button(tv, "create").waitFor();
        const held = tv.fake.hold("/requests", true);
        await button(tv, "create").click();
        await tv.eventually(async () => fake.created, "write processed");
        await tv.remote(10009); await button(tv, "movie:949").click();
        await tv.page.getByRole("button", { name: "Waiting for approval", exact: true }).waitFor();
        // Serve stale media state until the held write's answer has reached the client.
        fake.created = false; await tv.remote(10009); await button(tv, "movie:949").click(); await button(tv, "create").waitFor();
        assert.equal(await button(tv, "create").isDisabled(), true);
        fake.created = true; held.release();
        await tv.eventually(async () => await button(tv, "create").count() === 0, "visible detail reconciled after settlement");
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests").length, 1);
    } finally { await tv.page.context().close(); }
});

test("a late Requests read keeps focus the person moved meanwhile", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv); await button(tv, "requests").click(); await view(tv, "hub"); await button(tv, "movie:949").waitFor();
        const reads = tv.fake.paths().filter(path => path === "GET /requests/discover").length;
        const held = tv.fake.hold("/requests/discover");
        await revisitRequests(tv);
        await tv.eventually(async () => tv.fake.paths().filter(path => path === "GET /requests/discover").length > reads, "held refresh");
        await tv.remote(38);
        const moved = await tv.focused();
        assert.equal(moved, "requests");
        assert.notEqual(moved, "refresh");
        held.release();
        await button(tv, "movie:949").waitFor();
        await tv.page.getByText("Loading requests…").waitFor({ state: "detached" });
        assert.equal(await tv.focused(), moved);
    } finally { await tv.page.context().close(); }
});

test("a settled write refreshes the retained Requests hub", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        await button(tv, "requests").click(); await button(tv, "movie:949").click(); await button(tv, "create").waitFor();
        const held = tv.fake.hold("/requests", true);
        await button(tv, "create").click();
        await tv.eventually(async () => fake.created, "write processed");
        fake.created = false; await tv.remote(10009); await view(tv, "hub");
        await tv.page.getByRole("button", { name: "Heat · Not requested" }).waitFor();
        await button(tv, "home").click(); await tv.page.locator('.browse[data-view="home"]').waitFor();
        fake.created = true;
        const answered = tv.page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/requests"));
        held.release(); await answered; await tv.jump(1);
        await button(tv, "requests").click(); await view(tv, "hub");
        await tv.page.getByRole("button", { name: "Heat · Pending" }).last().waitFor();
    } finally { await tv.page.context().close(); }
});

const UNCONFIRMED_REQUEST = "We couldn't confirm the request. Check My Requests before trying again.";
const UNCONFIRMED_CANCEL = "We couldn't confirm the cancellation. Reopen My Requests to check it.";
const actionMessage = (tv: Tv) => tv.page.locator(".requests-detail-actions .requests-action-message");
test("a paginated discovery row ends at its last title, as Apple's first-page rail does", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); await start(tv, fake);
        await button(tv, "requests").click(); await button(tv, "movie:949").waitFor();
        assert.equal(await tv.page.locator(".requests-rail [data-focus]").count(), 1, "the server's page 1 of 2 shows its titles and no trailing tile");
        await button(tv, "movie:949").focus(); await tv.remote(39);
        assert.equal(await tv.focused(), "movie:949", "Right stops on the last title");
        assert.equal(tv.fake.paths().filter(path => path.includes("/discover/rows/")).length, 0, "no further page is read");
    } finally { await tv.page.context().close(); }
});
test("Request keeps focus on the action through submitting and settling, and morphs in place", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); nativeDetail(fake, "Heat", 3); await start(tv, fake);
        await button(tv, "requests").click(); await button(tv, "movie:949").click(); await view(tv, "media"); await button(tv, "create").waitFor();
        const write = tv.fake.hold("/requests", true);
        await button(tv, "create").focus(); await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => tv.fake.paths().includes("POST /requests"), "write held");
        const submitting = async (): Promise<void> => {
            assert.equal(await tv.focused(), "create");
            assert.equal(await button(tv, "create").textContent(), "Requesting…");
            assert.equal(await button(tv, "create").getAttribute("aria-label"), "Requesting…");
            assert.equal(await button(tv, "create").getAttribute("aria-disabled"), "true");
            assert.equal(await button(tv, "create").locator(".requests-action-spinner svg").count(), 1, "Apple's small ProgressView replaces the plus");
            assert.equal(await button(tv, "create").locator(".requests-action-icon").count(), 0);
            assert.equal(await button(tv, "create").evaluate(node => node.classList.contains("requests-interactive-action")), false, "Apple's secondary pill while non-interactive");
            assert.equal(await tv.page.locator('[data-focus="refresh"], [data-focus="back"]').count(), 0, "Apple shows no other controls");
            assert.equal(await tv.page.getByText(/Saving request|Loading requests/).count(), 0, "nor a status line");
        };
        await submitting();
        await tv.page.keyboard.press("Enter");
        const settle = tv.fake.hold("/requests/detail/movie/949", true);
        write.release();
        await tv.eventually(async () => fake.created && tv.fake.paths().filter(path => path === "GET /requests/detail/movie/949").length === 2, "settling read held");
        await submitting();
        settle.release();
        await tv.eventually(async () => await button(tv, "status").count() === 1, "the read morphs the pill");
        assert.equal(await tv.focused(), "status", "focus moves with the pill");
        assert.equal(await actionMessage(tv).count(), 0);
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests").length, 1, "a press while submitting is inert");
    } finally { await tv.page.context().close(); }
});
test("a refused Request stays focused and interactive with the server's message beside it", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); nativeDetail(fake, "Heat", 3); await start(tv, fake);
        await button(tv, "requests").click(); await button(tv, "movie:949").click(); await view(tv, "media"); await button(tv, "create").waitFor();
        await button(tv, "create").focus();
        tv.fake.script("/requests", problem(409, "conflict", "Already requested by you"));
        const reads = tv.fake.paths().length;
        await tv.page.keyboard.press("Enter");
        await actionMessage(tv).getByText("Already requested by you").waitFor();
        assert.equal(await tv.focused(), "create");
        assert.equal(await button(tv, "create").getAttribute("aria-disabled"), null);
        assert.equal(await button(tv, "create").textContent(), "Request");
        assert.equal(await tv.page.locator('[data-focus="refresh"], [data-focus="back"], .browse-error').count(), 0, "no recovery controls for a definite answer");
        assert.deepEqual(tv.fake.paths().slice(reads).filter(path => path.includes("/requests/detail/")), [], "a definite failure needs no read");
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => fake.created, "the person may try again");
        await tv.eventually(async () => await actionMessage(tv).count() === 0, "the next write clears the message");
    } finally { await tv.page.context().close(); }
});
test("an unconfirmed Request holds the action, reads back and never resends", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); nativeDetail(fake, "Heat", 3); await start(tv, fake);
        await button(tv, "requests").click(); await button(tv, "movie:949").click(); await view(tv, "media"); await button(tv, "create").waitFor();
        await button(tv, "create").focus();
        tv.fake.script("/requests/detail/movie/949", { status: 400, text: "bad" });
        tv.fake.dropNextAnswer("/requests"); await tv.page.keyboard.press("Enter");
        await actionMessage(tv).getByText(UNCONFIRMED_REQUEST).waitFor();
        assert.equal(await tv.focused(), "create", "the held action keeps focus");
        assert.equal(await button(tv, "create").textContent(), "Not confirmed yet");
        assert.equal(await button(tv, "create").getAttribute("aria-disabled"), "true");
        assert.equal(await tv.page.locator(".browse-error").count(), 0, "the action's message stands in for the failed read's");
        await tv.page.keyboard.press("Enter");
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests").length, 1, "never resent");
        await button(tv, "refresh").focus(); await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await button(tv, "status").count() === 1, "a read settles the hold");
        assert.equal(await actionMessage(tv).count(), 0, "the server's answer releases the message");
        assert.equal(await button(tv, "refresh").count(), 0, "and the recovery row");
    } finally { await tv.page.context().close(); }
});
test("an unconfirmed Request whose read succeeds settles without a message", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); await start(tv, fake);
        await button(tv, "requests").click(); await button(tv, "movie:949").click(); await view(tv, "media"); await button(tv, "create").waitFor();
        await button(tv, "create").focus();
        tv.fake.dropNextAnswer("/requests"); await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await button(tv, "status").count() === 1, "the automatic read settles it");
        assert.equal(await tv.focused(), "status");
        assert.equal(await actionMessage(tv).count(), 0);
        assert.equal(await tv.page.getByText(UNCONFIRMED_REQUEST).count(), 0);
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests").length, 1);
    } finally { await tv.page.context().close(); }
});
test("Cancel leaves focus on the action beside it through writing, settling and failure", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true; nativeDetail(fake, "Heat", 3);
        Object.assign(fake.record, { state: "pending", status: "pending" });
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "request-one").click(); await view(tv, "request"); await button(tv, "cancel").waitFor();
        await button(tv, "cancel").focus();
        tv.fake.script("/requests/request-one/cancel", problem(409, "conflict", "This request can no longer be changed"));
        await tv.page.keyboard.press("Enter");
        await actionMessage(tv).getByText("This request can no longer be changed").waitFor();
        assert.equal(await tv.focused(), "status", "focus stays on the pill Cancel left it on");
        assert.equal(await button(tv, "cancel").isDisabled(), false, "a definite failure offers Cancel again");
        await button(tv, "cancel").focus();
        const write = tv.fake.hold("/requests/request-one/cancel", true);
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => tv.fake.paths().filter(path => path === "POST /requests/request-one/cancel").length === 2, "cancel held");
        assert.equal(await button(tv, "cancel").count(), 0, "Apple hides Cancel while it runs");
        assert.equal(await tv.focused(), "status");
        assert.equal(await tv.page.locator('[data-focus="refresh"], [data-focus="back"]').count(), 0);
        assert.equal(await actionMessage(tv).count(), 0, "the next write clears the message");
        const settle = tv.fake.hold("/requests/request-one", true);
        write.release();
        await tv.eventually(async () => fake.cancelled, "cancel processed");
        await tv.jump(1);
        assert.equal(await button(tv, "cancel").count(), 0, "and while its read settles");
        assert.equal(await tv.focused(), "status");
        settle.release();
        await tv.eventually(async () => await button(tv, "create").count() === 1, "the read morphs the pill into Request, because the title is requestable again");
        assert.equal(await tv.focused(), "create");
    } finally { await tv.page.context().close(); }
});
test("a failed detail read uses ErrorView's recovery order, and Back works by the remote", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); await start(tv, fake);
        await button(tv, "requests").click(); await button(tv, "movie:949").waitFor();
        await button(tv, "movie:949").focus();
        fake.requestFailure = problem(404, "not_found", "Hidden");
        await tv.page.keyboard.press("Enter");
        await button(tv, "go-back").waitFor();
        assert.deepEqual(await tv.page.locator(".requests-failure .browse-button").allTextContents(), ["Go Back", "Try Again"], "a 404 prefers leaving");
        assert.equal(await tv.focused(), "go-back");
        assert.equal(await tv.page.locator(".requests-failure .search-state-title").textContent(), "Not found");
        await tv.remote(40); assert.equal(await tv.focused(), "retry");
        await tv.remote(38); assert.equal(await tv.focused(), "go-back");
        await tv.page.keyboard.press("Enter");
        fake.requestFailure = undefined;
        await view(tv, "hub"); await button(tv, "movie:949").waitFor();
        await tv.eventually(async () => await tv.focused() === "movie:949", "Go Back restores the card");
        await tv.page.keyboard.press("Enter"); await button(tv, "create").waitFor();
        await tv.remote(10009); await view(tv, "hub"); await button(tv, "movie:949").waitFor();
        fake.requestFailure = { status: 503, text: "unavailable" };
        await button(tv, "movie:949").focus(); await tv.page.keyboard.press("Enter");
        await button(tv, "retry").waitFor();
        assert.deepEqual(await tv.page.locator(".requests-failure .browse-button").allTextContents(), ["Try Again"], "Back is the remote's job on any other failure");
        fake.requestFailure = undefined;
        await tv.remote(10009); await view(tv, "hub");
        await tv.eventually(async () => await tv.focused() === "movie:949", "the remote's Back restores the card");
    } finally { await tv.page.context().close(); }
});
test("a settling write keeps focus the person moved meanwhile", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); nativeDetail(fake, "Heat", 3); await start(tv, fake);
        await button(tv, "requests").click(); await button(tv, "movie:949").click(); await button(tv, "create").waitFor();
        let held = tv.fake.hold("/requests", true);
        fake.requestFailure = problem(400, "validation_failed", "Unavailable");
        await button(tv, "create").click();
        await tv.eventually(async () => tv.fake.paths().includes("POST /requests"), "failing write held");
        assert.equal(await tv.focused(), "create");
        await tv.remote(40); assert.equal(await tv.focused(), "movie:1000");
        held.release();
        await tv.page.getByText("That request couldn't be submitted").waitFor();
        assert.equal(await tv.focused(), "movie:1000", "a failed write keeps moved focus");
        fake.requestFailure = undefined;
        await tv.eventually(async () => !await button(tv, "create").isDisabled(), "a definite failure offers Request again");
        held = tv.fake.hold("/requests", true);
        await button(tv, "create").click();
        await tv.eventually(async () => fake.created, "write held");
        assert.equal(await tv.focused(), "create");
        await tv.remote(40); await tv.remote(39); assert.equal(await tv.focused(), "movie:1001");
        held.release();
        await tv.eventually(async () => await button(tv, "create").count() === 0 && await button(tv, "refresh").count() === 0, "write settled on the ready page");
        assert.equal(await tv.focused(), "movie:1001", "a settled write keeps moved focus");
    } finally { await tv.page.context().close(); }
});

test("ready Requests hub uses native shell controls only", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true;
        await start(tv, fake); await button(tv, "requests").click();
        await button(tv, "request-one").waitFor();
        for (const name of ["Search requests", "My Requests", "Refresh", "Back"]) {
            assert.equal(await tv.page.getByRole("button", { name, exact: true }).count(), 0, `${name} is not a ready-hub tool`);
        }
        assert.equal(await tv.page.locator('.requests-heading').first().textContent(), "Your requests");
        assert.equal(await button(tv, "search").count(), 1);
    } finally { await tv.page.context().close(); }
});

test("Requests tab Select reads nothing, focus stays passive and leaving fences the rebuild's read", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv); await button(tv, "requests").click(); await button(tv, "movie:949").waitFor();
        const reads = () => tv.fake.paths().filter(path => path === "GET /requests/discover").length;
        const before = reads();
        await button(tv, "requests").focus(); await tv.remote(39); await tv.remote(37);
        assert.equal(reads(), before, "navigation focus does not refresh");
        await button(tv, "requests").click();
        assert.equal(reads(), before, "selecting the shown tab reads nothing, as on Apple TV");
        const held = tv.fake.hold("/requests/discover", true);
        await revisitRequests(tv);
        await tv.eventually(async () => reads() === before + 1, "returning rebuilds with one read");
        await button(tv, "requests").click();
        assert.equal(reads(), before + 1, "pending read is neither replaced nor duplicated");
        await button(tv, "home").click();
        held.release();
        await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
        assert.equal(await tv.page.locator('.browse[data-view="requests:hub"]').count(), 0);
        assert.equal(tv.fake.paths().filter(path => /^(POST|PUT|DELETE) \/requests/.test(path)).length, 0);
    } finally { await tv.page.context().close(); }
});

const LONG_OVERVIEW = "Nearly two decades after he seized control of the Imperium, Paul Atreides is now a ruthless Emperor, and must face the consequences of his reign as old allies return, terrifying new threats emerge, and betrayal lurks in every shadow. Haunted by visions of Imperial collapse and the reach of his own legend, he turns to the desert once more.";
function nativeDetail(fake: FakeRequests, title: string, count: number): void {
    const original = fake.title.bind(fake);
    Object.assign(fake.record, { title, overview: LONG_OVERVIEW, created_at: "2026-11-01T12:00:00Z", state: "approved", status: "queued", targets: [{ quality: "1080p", status: "queued" }] });
    fake.title = () => ({ ...original(), title, overview: LONG_OVERVIEW, year: 2026, runtime: 150, vote_average: 6.1, content_rating: "+13", genres: ["Science Fiction", "Adventure"], director: "Denis Villeneuve",
        recommendations: Array.from({ length: count }, (_, index) => ({ ...original(), tmdb_id: 1000 + index, title: `Related ${index}` })) });
}
const top = (tv: Tv, selector: string) => tv.page.locator(selector).first().evaluate(node => node.getBoundingClientRect().top);
const hit = (tv: Tv, key: string, x: number, y: number) => tv.page.evaluate(({ key, x, y }) => document.elementFromPoint(x, y)?.closest(`[data-focus="${key}"]`) !== null && document.elementFromPoint(x, y) !== null, { key, x, y });
const pseudo = (tv: Tv, selector: string, which: string, ...properties: string[]) => tv.page.locator(selector).first().evaluate((node, { which, properties }) => {
    const style = getComputedStyle(node, which); return properties.map(property => style.getPropertyValue(property));
}, { which, properties });
test("status detail clips its action at the native 810 hero edge and starts posters at 866", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true; nativeDetail(fake, "Dune: Part Three", 3);
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "request-one").click();
        await view(tv, "request"); await tv.page.getByText("Directed by Denis Villeneuve", { exact: true }).waitFor();
        await tv.page.evaluate(async () => document.fonts.ready);
        assert.equal(await tv.focused(), "status");
        assert.equal(await tv.page.locator(".requests-rating-chip").textContent(), "+13", "the server rating passes through unchanged");
        assert.equal(await tv.page.locator(".requests-detail-hero").evaluate(node => node.getBoundingClientRect().height), 810);
        assert.equal(await top(tv, ".requests-heading"), 810);
        assert.equal(await top(tv, ".requests-detail-hero ~ .requests-rail .browse-art"), 866);
        const action = await button(tv, "status").evaluate(node => { const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, transform: getComputedStyle(node).transform }; });
        assert.ok(Math.abs(action.top - 744) <= 1, `action top ${action.top}`);
        assert.ok(action.bottom > 810, `the focused action extends past the clip (${action.bottom})`);
        assert.ok(action.transform.startsWith("matrix(1.025"), `compact focus scale survives the clip (${action.transform})`);
        assert.equal(await hit(tv, "status", 300, 805), true, "action paints above the hero edge");
        assert.equal(await hit(tv, "status", 300, 815), false, "action is clipped below the hero edge");
        assert.deepEqual(await tv.page.locator(".requests-detail-hero").evaluate(node => [node.scrollTop, document.querySelector(".browse")?.scrollTop]), [0, 0], "focusing the clipped action never scrolls the hero");
    } finally { await tv.page.context().close(); }
});
test("unrequested detail keeps its action whole with posters at 746 and native chrome values", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); nativeDetail(fake, "Apocalypse Z: New World", 3);
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "movie:949").click();
        await view(tv, "media"); await tv.page.getByText("Directed by Denis Villeneuve", { exact: true }).waitFor();
        await tv.page.evaluate(async () => document.fonts.ready);
        assert.equal(await tv.focused(), "create");
        assert.equal(await tv.page.locator(".requests-detail-hero").evaluate(node => node.getBoundingClientRect().height), 690);
        assert.equal(await top(tv, ".requests-heading"), 690);
        assert.equal(await top(tv, ".requests-detail-hero ~ .requests-rail .browse-art"), 746);
        const action = await button(tv, "create").evaluate(node => { const rect = node.getBoundingClientRect(), icon = node.querySelector(".requests-action-icon")?.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, height: rect.height, right: rect.right, iconWidth: icon?.width, iconTag: node.querySelector(".requests-action-icon")?.tagName, shadow: getComputedStyle(node).boxShadow }; });
        assert.ok(action.bottom <= 690, `the whole action stays inside the hero (${action.bottom})`);
        assert.equal(await hit(tv, "create", 285, action.bottom - 2), true, "the action's lowest row is painted");
        assert.equal(action.iconTag, "svg", "the plus is a drawn glyph rather than a small text character");
        assert.ok(Math.abs((action.iconWidth ?? 0) - 24.6) < 0.1, `plus width ${action.iconWidth}`);
        assert.ok(Math.abs(action.height - 77.9) < 0.1, `pill height ${action.height}`);
        assert.ok(Math.abs(action.left - 95.4) <= 1 && Math.abs(action.right - 474.6) <= 1, `native pill spans 95.4 to 474.6, got ${action.left} to ${action.right}`);
        assert.equal(action.shadow, "rgba(0, 0, 0, 0.24) 0px 4px 20px 0px", "compact focus shadow");
        const eyebrow = await tv.page.locator(".requests-eyebrow").evaluate(node => { const style = getComputedStyle(node); return [style.letterSpacing, style.paddingTop, style.paddingLeft, style.backgroundColor, style.boxShadow, style.fontSize, style.fontWeight, node.getBoundingClientRect().height]; });
        assert.deepEqual(eyebrow, ["1.2px", "8px", "16px", "rgba(0, 0, 0, 0.55)", "rgba(255, 255, 255, 0.18) 0px 0px 0px 1px inset", "18px", "600", 38]);
        assert.deepEqual(await tv.page.locator(".requests-tmdb span").first().evaluate(node => { const style = getComputedStyle(node); return [node.textContent, style.fontWeight, style.color, style.fontSize]; }), ["6.1", "700", "rgb(255, 255, 255)", "24px"]);
    } finally { await tv.page.context().close(); }
});
test("request status dots, hub captions, poster badges and the magnifier use native values", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true; nativeDetail(fake, "Dune: Part Three", 1);
        tv.fake.script("/requests/mine?limit=50", { status: 200, body: { items: [
            { ...fake.record, id: "adding", title: "The Odyssey", state: "processing", status: "completed" },
            { ...fake.record, id: "partly", title: "Road Wars", state: "partially_available", status: "queued" },
            { ...fake.record, title: "Neuromancer" },
        ], page: { has_more: false } } });
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "adding").waitFor();
        await tv.page.evaluate(async () => document.fonts.ready);
        assert.deepEqual(await pseudo(tv, ".skyline-search", "::before", "width", "border-top-width", "left", "top"), ["22px", "3px", "16px", "15px"], "magnifier ring");
        assert.deepEqual((await pseudo(tv, ".skyline-search", "::after", "height", "border-top-left-radius")), ["4px", "2px"], "magnifier handle");
        for (const [key, text] of [["adding", "Adding to library"], ["partly", "Partly in library"]] as const) assert.ok(await button(tv, key).locator(".requests-status-label").evaluate((node, text) => {
            const range = document.createRange(); range.selectNodeContents(node);
            const card = node.closest(".requests-card")?.getBoundingClientRect();
            return node.textContent === text && card !== undefined && range.getBoundingClientRect().right <= card.right;
        }, text), `${text} must fit the 176 px card`);
        const widths = await button(tv, "request-one").locator(".requests-status-label").evaluate(node => getComputedStyle(node).letterSpacing);
        assert.equal(widths, "-0.6px", "the caption calibration tracks Inter to the native word widths");
        assert.deepEqual(await pseudo(tv, ".requests-card .requests-status-label", "::before", "width"), ["10px"], "caption dot stays RequestStatusLabel's 10 px");
        assert.equal(await tv.page.locator(".requests-card .requests-status-label").first().evaluate(node => getComputedStyle(node).alignItems), "baseline", "caption dot keeps its baseline alignment");
        // Built and read in one task: a hub refresh can replace anything left in the tree between evaluates.
        assert.deepEqual(await tv.page.evaluate(() => {
            const badge = document.createElement("span"); badge.className = "requests-status-badge"; badge.dataset.requestDisplay = "inLibrary";
            badge.innerHTML = '<svg viewBox="0 0 24 24"></svg>'; document.body.appendChild(badge);
            const style = getComputedStyle(badge), glyph = getComputedStyle(badge.firstElementChild as Element);
            const values = [style.backgroundColor, style.boxShadow, glyph.width, glyph.strokeWidth];
            badge.remove(); return values;
        }), ["rgb(52, 211, 153)", "rgba(0, 0, 0, 0.35) 0px 0px 8px 0px", "28px", "3px"], "badge tint, shadow and heavy glyph");
        await button(tv, "request-one").click(); await view(tv, "request");
        await tv.page.getByText("Directed by Denis Villeneuve", { exact: true }).waitFor();
        assert.deepEqual(await pseudo(tv, '[data-focus="status"] .requests-status-label', "::before", "width", "height"), ["14px", "14px"], "action dot");
        assert.deepEqual(await button(tv, "status").locator(".requests-status-label").evaluate(node => { const style = getComputedStyle(node); return [style.alignItems, style.columnGap, style.fontSize, style.fontWeight]; }), ["center", "14px", "28px", "600"]);
        assert.deepEqual(await pseudo(tv, ".requests-summary .requests-status-label", "::before", "width", "height"), ["11px", "11px"], "summary dot");
        assert.deepEqual(await tv.page.locator(".requests-summary .requests-status-label").evaluate(node => { const style = getComputedStyle(node); return [style.alignItems, style.columnGap]; }), ["center", "10px"]);
    } finally { await tv.page.context().close(); }
});
test("More like this draws only cards inside the native rail bounds yet focus reaches every item", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true; nativeDetail(fake, "Dune: Part Three", 12);
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "request-one").click();
        await view(tv, "request"); await button(tv, "movie:1011").waitFor();
        await tv.page.locator(".browse").evaluate(node => (node as HTMLElement).style.setProperty("--poster-scale", "0.86"));
        const rail = ".requests-detail-hero ~ .requests-rail .requests-card";
        const painted = () => tv.page.locator(rail).evaluateAll(nodes => nodes.filter(node => getComputedStyle(node).opacity !== "0" && node.getBoundingClientRect().left < 1920).map(node => node.getAttribute("data-focus")));
        await tv.eventually(async () => (await painted()).length === 8, "eight posters painted at rest");
        const cards = await tv.page.locator(rail).evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { left: Math.round(rect.left), right: Math.round(rect.right), opacity: getComputedStyle(node).opacity }; }));
        assert.equal(cards[7]?.opacity, "1"); assert.ok(Math.abs((cards[7]?.right ?? 0) - 1837) <= 2, `eighth poster ends near 1837 (${cards[7]?.right})`);
        assert.ok(Math.abs((cards[8]?.left ?? 0) - 1870) <= 2, `ninth poster starts at 1870 (${cards[8]?.left})`); assert.equal(cards[8]?.opacity, "0", "the ninth poster stays unpainted at rest");
        await tv.remote(40);
        assert.equal(await tv.focused(), "movie:1001", "the poster nearest the action's centre, Apple 04b");
        await tv.remote(37);
        assert.equal(await tv.focused(), "movie:1000");
        for (let index = 1; index < 12; index++) {
            await tv.remote(39);
            assert.equal(await tv.focused(), `movie:${1000 + index}`, "Right reaches every recommendation");
            assert.equal(await button(tv, `movie:${1000 + index}`).evaluate(node => getComputedStyle(node).opacity), "1", "the focused card is always painted");
        }
        await tv.eventually(async () => (await painted()).includes("movie:1011"), "last card painted after scrolling");
    } finally { await tv.page.context().close(); }
});

// Apple TVRequestsLoadingView, ErrorView and EmptyStateView, measured from the 1920x1080 hierarchy dumps.
const box = (tv: Tv, selector: string) => tv.page.locator(selector).first().evaluate(node => { const rect = node.getBoundingClientRect(); return [rect.left, rect.top, rect.width, rect.height].map(value => Math.round(value)); });
const near = (actual: readonly number[], expected: readonly number[], tolerance: number, label: string): void => {
    assert.equal(actual.length, expected.length, label);
    actual.forEach((value, index) => assert.ok(Math.abs(value - (expected[index] ?? 0)) <= tolerance, `${label}: ${actual.join(",")} is not within ${tolerance} of ${expected.join(",")}`));
};
const focusedHighlight = (tv: Tv) => tv.page.evaluate(() => { const style = getComputedStyle(document.activeElement ?? document.body); return [style.outlineStyle, style.boxShadow]; });
const hubReads = (tv: Tv) => tv.fake.paths().filter(path => path === "GET /requests/discover").length;

test("Requests loading is Apple's passive skeleton page and owns focus without a highlight", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        const held = tv.fake.hold("/requests/discover", true);
        await button(tv, "requests").click();
        const page = tv.page.locator(".requests-loading");
        await page.waitFor();
        await tv.eventually(async () => hubReads(tv) === 1, "hub read started");
        assert.equal(await page.getAttribute("aria-label"), "Loading requests");
        assert.equal(await tv.page.getByText("Loading requests…").count(), 0, "the old line is gone");
        await tv.page.getByText("Loading Requests", { exact: true }).waitFor();
        assert.equal(await tv.page.getByRole("button", { name: "Back", exact: true }).count(), 0);
        assert.equal(await tv.page.evaluate(() => document.activeElement?.classList.contains("requests-loading")), true, "the page holds focus");
        assert.deepEqual(await focusedHighlight(tv), ["none", "none"], "and draws no focus highlight");
        near(await box(tv, ".requests-loading-block"), [88, 188, 520, 72], 0, "marquee block");
        assert.equal(await tv.page.locator(".requests-loading-block").evaluate(node => getComputedStyle(node).borderRadius), "12px");
        assert.deepEqual(await tv.page.locator(".requests-loading-meta .requests-loading-bar").evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return [Math.round(rect.left), Math.round(rect.top), rect.width, rect.height]; })), [[88, 280, 118, 22], [220, 280, 82, 22], [316, 280, 150, 22]]);
        assert.deepEqual(await tv.page.locator(".requests-loading-copy .requests-loading-bar").evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return [Math.round(rect.left), Math.round(rect.top), rect.width, rect.height]; })), [[88, 322, 720, 18], [88, 353, 610, 18]]);
        // The spinner steps through 45 degree turns, which changes its bounding box; measure it at rest.
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        near(await box(tv, ".requests-loading-spinner"), [88, 395, 40, 40], 0, "spinner");
        await tv.page.emulateMedia({ reducedMotion: "no-preference" });
        const label = await tv.page.locator(".requests-loading-label").evaluate(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return { left: rect.left, centre: rect.top + rect.height / 2, size: style.fontSize, weight: style.fontWeight, color: style.color }; });
        assert.deepEqual(label, { left: 142, centre: 415, size: "20px", weight: "500", color: "rgba(237, 237, 237, 0.72)" });
        near(await box(tv, ".requests-loading-rail > .requests-loading-bar"), [88, 614, 300, 28], 0, "rail header");
        const cards = await tv.page.locator(".requests-loading-card > :first-child").evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return [Math.round(rect.left), Math.round(rect.top), rect.width, rect.height]; }));
        assert.equal(cards.length, 8);
        assert.deepEqual(cards[0], [88, 662, 176, 264]);
        assert.deepEqual(cards[7], [1544, 662, 176, 264]);
        const reads = tv.fake.requests.length;
        await tv.remote(38);
        assert.equal(await tv.focused(), "requests", "Up reaches the Requests tab");
        await tv.remote(40);
        assert.equal(await tv.page.evaluate(() => document.activeElement?.classList.contains("requests-loading")), true, "Down returns to the placeholder");
        await tv.remote(37); await tv.remote(39);
        assert.equal(await tv.page.evaluate(() => document.activeElement?.classList.contains("requests-loading")), true, "sideways stays on the placeholder");
        assert.equal(tv.fake.requests.length, reads, "focus moves never fetch");
        await tv.remote(38);
        held.release();
        await button(tv, "movie:949").waitFor();
        assert.equal(await tv.focused(), "requests", "an answer never pulls focus out of the bar");
        await tv.remote(40);
        assert.equal(await tv.focused(), "movie:949");
    } finally { await tv.page.context().close(); }
});

test("Requests failure uses Apple's ErrorView, its copy and Try Again shows loading first", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        fake.requestFailure = { status: 503, text: "unavailable" };
        await button(tv, "requests").click();
        const again = tv.page.getByRole("button", { name: "Try Again", exact: true });
        await again.waitFor();
        await tv.page.getByRole("heading", { name: "Something went wrong" }).waitFor();
        await tv.page.getByText("The server ran into a problem. Try again in a moment.", { exact: true }).waitFor();
        await tv.eventually(async () => await tv.focused() === "retry", "Try Again focused on entry");
        await tv.page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
        await button(tv, "requests").focus();
        const heading = await tv.page.locator(".requests-failure h2").evaluate(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return [style.fontSize, style.fontWeight, Math.round(rect.top), Math.round(rect.height)]; });
        assert.deepEqual(heading, ["36px", "600", 436, 43]);
        const body = await tv.page.locator(".requests-failure p").evaluate(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return [style.fontSize, Math.round(rect.top), Math.round(rect.height), style.color]; });
        assert.deepEqual(body, ["26px", 527, 32, "rgba(237, 237, 237, 0.6)"]);
        near(await box(tv, ".requests-failure .search-state-icon"), [935, 335, 50, 53], 0, "icon box");
        assert.equal(await tv.page.locator(".requests-failure .search-state-icon").evaluate(node => getComputedStyle(node).color), "rgb(176, 0, 32)");
        near(await box(tv, ".requests-failure .browse-button"), [860, 623, 200, 62], 0, "Try Again at rest");
        const rest = await again.evaluate(node => { const style = getComputedStyle(node); return [style.fontSize, style.fontWeight, style.backgroundColor, style.color]; });
        assert.deepEqual(rest, ["28px", "600", "rgba(237, 237, 237, 0.72)", "rgb(0, 0, 0)"]);
        await tv.remote(40);
        assert.equal(await tv.focused(), "retry", "Down from the bar returns to Try Again");
        const focused = await again.evaluate(node => { const style = getComputedStyle(node); return { background: style.backgroundColor, transform: style.transform, ring: style.boxShadow.includes("rgb(255, 255, 255) 0px 0px 0px 2px") }; });
        assert.deepEqual(focused, { background: "rgb(237, 237, 237)", transform: "matrix(1.055, 0, 0, 1.055, 0, 0)", ring: true });
        await tv.remote(38);
        assert.equal(await tv.focused(), "requests", "Up from the error reaches the Requests tab");
        await tv.remote(40);
        const held = tv.fake.hold("/requests/discover", true);
        await tv.page.keyboard.press("Enter");
        await tv.page.locator(".requests-loading").waitFor();
        assert.equal(await again.count(), 0, "Try Again shows loading first");
        assert.equal(await tv.page.evaluate(() => document.activeElement?.classList.contains("requests-loading")), true, "focus is never lost");
        held.release();
        await again.waitFor();
        await tv.eventually(async () => await tv.focused() === "retry", "Try Again focused again");
        tv.offline = true;
        await tv.page.keyboard.press("Enter");
        await tv.page.getByText("Can't reach the server. Check your connection and try again.", { exact: true }).waitFor();
        await tv.eventually(async () => await tv.focused() === "retry", "Try Again focused after the network failure");
        tv.offline = false; fake.requestFailure = undefined;
        await tv.page.keyboard.press("Enter");
        await button(tv, "movie:949").waitFor();
        assert.equal(await tv.focused(), "movie:949", "a recovered page focuses its first card");
    } finally { await tv.page.context().close(); }
});

test("Requests 401 offers Sign In Again first, then Try Again", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv, new FakeRequests(), true);
        fake.requestFailure = problem(401, "not_a_session_code", "Refused");
        await button(tv, "requests").click();
        await tv.page.getByRole("heading", { name: "Session expired" }).waitFor();
        await tv.page.getByText("Your session has expired. Sign in again to continue.", { exact: true }).waitFor();
        await tv.eventually(async () => await tv.focused() === "sign-in", "Sign In Again is primary");
        await tv.remote(40);
        assert.equal(await tv.focused(), "retry");
        await tv.remote(38);
        await tv.page.keyboard.press("Enter");
        assert.equal(await tv.page.evaluate(() => window.browseHarness.signOutCalls), 1);
    } finally { await tv.page.context().close(); }
});

test("Requests failure follows Apple's status mapping with recovery the hub can offer", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        fake.requestFailure = problem(403, "forbidden", "Protocol text");
        await button(tv, "requests").click();
        await tv.page.getByRole("heading", { name: "Not allowed" }).waitFor();
        await tv.page.getByText("You don't have permission to do this. Ask your server admin if you need access.", { exact: true }).waitFor();
        assert.equal(await tv.page.getByRole("button", { name: "Go Back", exact: true }).count(), 0, "the hub is a root, so it has no stack to go back through");
        await tv.page.getByRole("button", { name: "Try Again", exact: true }).waitFor();
        fake.requestFailure = { status: 404, text: "gone" };
        await tv.page.getByRole("button", { name: "Try Again", exact: true }).click();
        await tv.page.getByRole("heading", { name: "Not found" }).waitFor();
        await tv.page.getByText("We couldn't find what you were looking for. It may have been removed or moved.", { exact: true }).waitFor();
        fake.requestFailure = problem(500, "internal", "Server's own words");
        await tv.page.getByRole("button", { name: "Try Again", exact: true }).click();
        await tv.page.getByRole("heading", { name: "Something went wrong" }).waitFor();
        await tv.page.getByText("Server's own words", { exact: true }).waitFor();
        fake.requestFailure = problem(403, "permission_denied", "Requests are not allowed.");
        await tv.page.getByRole("button", { name: "Try Again", exact: true }).click();
        await tv.page.getByRole("heading", { name: "Not allowed" }).waitFor();
        await tv.page.getByText("Requests are not allowed.", { exact: true }).waitFor();
    } finally { await tv.page.context().close(); }
});

test("Requests empty is Apple's EmptyStateView and owns focus without a highlight", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv); fake.requestsEmpty = true;
        await button(tv, "requests").click();
        const page = tv.page.locator(".requests-empty");
        await page.waitFor();
        await tv.eventually(async () => await tv.page.evaluate(() => document.activeElement?.classList.contains("requests-empty") === true), "placeholder owns focus");
        assert.equal(await page.getAttribute("aria-label"), "Nothing here yet");
        await tv.page.getByRole("heading", { name: "Nothing here yet" }).waitFor();
        await tv.page.getByText("Use Search to find a movie or series to request", { exact: true }).waitFor();
        assert.equal(await tv.page.getByText("No titles available.").count(), 0);
        assert.deepEqual(await focusedHighlight(tv), ["none", "none"]);
        const title = await tv.page.locator(".requests-empty h2").evaluate(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return [style.fontSize, style.fontWeight, Math.round(rect.top), Math.round(rect.height)]; });
        assert.deepEqual(title, ["28px", "600", 502, 34]);
        const subtitle = await tv.page.locator(".requests-empty p").evaluate(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return [style.fontSize, Math.round(rect.top), Math.round(rect.height), style.color]; });
        assert.deepEqual(subtitle, ["22px", 548, 27, "rgba(237, 237, 237, 0.6)"]);
        near(await box(tv, ".requests-empty .search-state-icon svg"), [935, 449, 51, 37], 0, "tray glyph");
        assert.equal(await tv.page.locator(".requests-empty .search-state-icon").evaluate(node => getComputedStyle(node).color), "rgba(237, 237, 237, 0.3)");
        const reads = tv.fake.requests.length;
        await tv.remote(38);
        assert.equal(await tv.focused(), "requests");
        await tv.remote(40);
        assert.equal(await tv.page.evaluate(() => document.activeElement?.classList.contains("requests-empty")), true, "Down returns to the placeholder");
        assert.equal(tv.fake.requests.length, reads);
    } finally { await tv.page.context().close(); }
});

test("ready hub: Up reaches the tab, Down returns to the first card and tabs switch only on Select", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true;
        await start(tv, fake); await button(tv, "requests").click();
        await button(tv, "request-one").waitFor();
        await tv.eventually(async () => await tv.focused() === "request-one", "Select enters the content");
        const rows = await tv.page.locator(".requests-rail").count();
        assert.ok(rows > 1);
        await tv.remote(40);
        const lower = await tv.focused();
        assert.notEqual(lower, "request-one");
        await tv.remote(38);
        assert.equal(await tv.focused(), "request-one");
        await tv.remote(40); await tv.remote(38); await tv.remote(38);
        assert.equal(await tv.focused(), "requests", "Up from the first row reaches the Requests tab");
        const reads = tv.fake.requests.length;
        await tv.remote(37);
        assert.equal(await tv.focused(), "calendar", "moving across tabs");
        assert.equal(await tv.page.locator('.browse[data-view="requests:hub"]').count(), 1, "does not switch them");
        assert.equal(tv.fake.requests.length, reads, "or fetch");
        await tv.remote(39); await tv.remote(40);
        assert.equal(await tv.focused(), "request-one");
    } finally { await tv.page.context().close(); }
});

test("Down from the bar returns to the first card, not the last-focused one", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true;
        tv.fake.script("/requests/mine?limit=50", { status: 200, body: { items: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map(id => ({ ...fake.record, id })), page: { has_more: false } } });
        tv.fake.script("/requests/mine?limit=50", { status: 200, body: { items: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map(id => ({ ...fake.record, id })), page: { has_more: false } } });
        await start(tv, fake); await button(tv, "requests").click();
        await button(tv, "a").waitFor();
        await tv.eventually(async () => await tv.focused() === "a", "first card");
        for (let press = 0; press < 10; press++) await tv.remote(39);
        assert.equal(await tv.focused(), "k");
        await tv.remote(38);
        assert.equal(await tv.focused(), "requests");
        await tv.remote(40);
        assert.equal(await tv.focused(), "a", "the first card, not the last-focused k");
        await tv.eventually(async () => await tv.page.locator(".requests-rail").first().evaluate(node => node.scrollLeft) === 0, "the row returned to its start");
    } finally { await tv.page.context().close(); }
});

test("returning to the Requests tab rebuilds the page, shows loading, then focuses the first card", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true;
        await start(tv, fake); await button(tv, "requests").click();
        await button(tv, "request-one").waitFor();
        await tv.page.evaluate(() => { (document.querySelector('[data-focus="movie:949"]') as HTMLElement | null)?.focus(); });
        await button(tv, "home").click(); await tv.page.locator('.browse[data-view="home"]').waitFor();
        const reads = hubReads(tv);
        const held = tv.fake.hold("/requests/discover", true);
        await button(tv, "requests").click();
        await tv.page.locator(".requests-loading").waitFor();
        assert.equal(await button(tv, "request-one").count(), 0, "the earlier page is gone");
        await tv.eventually(async () => hubReads(tv) === reads + 1, "one fresh read");
        held.release();
        await button(tv, "request-one").waitFor();
        await tv.eventually(async () => await tv.focused() === "request-one", "first card, not the earlier focus");
        assert.equal(hubReads(tv), reads + 1);
    } finally { await tv.page.context().close(); }
});

test("top bar anchors follow the native row at 8 px gaps", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv);
        await tv.page.evaluate(async () => document.fonts.ready);
        const frames = await tv.page.locator(".skyline-tabs .browse-button").evaluateAll(nodes => nodes.map(node => { const rect = node.getBoundingClientRect(); return { key: node.getAttribute("data-focus") ?? "", left: rect.left, right: rect.right, centre: rect.left + rect.width / 2 }; }));
        const gaps = frames.slice(1).map((frame, index) => Math.round(frame.left - (frames[index]?.right ?? 0)));
        assert.deepEqual(gaps, gaps.map(() => 8));
        const home = await button(tv, "home").evaluate(node => { const style = getComputedStyle(node); return parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth); });
        assert.equal(home, 29, "Apple's 29 px tab inset includes the capsule edge");
        // 11-error-http503 hierarchy. This fixture orders Movies before Series, which leaves every other anchor unchanged.
        const frame = (key: string) => { const found = frames.find(entry => entry.key === key); assert.ok(found, key); return found; };
        for (const [key, centre] of [["search", 461.5], ["home", 562.5], ["for_you", 999], ["calendar", 1162.5]] as const) assert.ok(Math.abs(frame(key).centre - centre) <= 1.5, `${key} centre ${frame(key).centre}, Apple ${centre}`);
        const requests = frame("requests");
        assert.ok(Math.abs(requests.left - 1253) <= 1.5 && Math.abs(requests.right - 1422) <= 1.5, `Requests pill ${requests.left}-${requests.right}, Apple 1253-1422`);
    } finally { await tv.page.context().close(); }
});

// The second parity pass, against Apple's 1920x1080 captures in pairs 01b, 02a-c, 03, 04b-c, 05b-c, 08a-c and 09e.
const hubTitle = (fake: FakeRequests, id: number): Record<string, unknown> => ({ ...fake.title(), tmdb_id: id, title: `Title ${id}` });
function manyRows(tv: Tv, fake: FakeRequests): void {
    const record = (id: string): Record<string, unknown> => ({ ...fake.record, id });
    const mine = { status: 200, body: { items: ["a", "b", "c", "d", "e"].map(record), page: { has_more: false } } };
    tv.fake.script("/requests/mine?limit=50", mine, mine, mine);
    const sections = ["one", "two", "three"].map((key, row) => ({ key, title: `Row ${key}`, page: 1, total_pages: 1, total_results: 5, results: [0, 1, 2, 3, 4].map(index => hubTitle(fake, 2000 + row * 10 + index)) }));
    const route = fake.route.bind(fake);
    fake.route = (method, path, profile, body) => method === "GET" && path === "/requests/discover"
        ? { status: 200, body: { items: sections, row_order: sections.map(section => ({ key: section.key, title: section.title, type: "tmdb_chart" })) } }
        : route(method, path, profile, body);
}
const settledScroll = (tv: Tv) => tv.page.waitForTimeout(260);
const rowTops = (tv: Tv) => tv.page.evaluate(() => {
    const active = document.activeElement as HTMLElement, row = active.closest(".requests-row") as HTMLElement;
    const y = (selector: string): number | undefined => row.querySelector(selector)?.getBoundingClientRect().top;
    return { eyebrow: y(".requests-discover"), heading: y(".requests-heading") };
});
const untransformedArtTop = (tv: Tv) => tv.page.evaluate(() => (document.activeElement as HTMLElement).getBoundingClientRect().top);

test("hub rows align to the 596 band top, keep the heading visible and the eyebrow above it", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true; manyRows(tv, fake);
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "a").waitFor();
        await tv.eventually(async () => await tv.focused() === "a", "first card");
        assert.deepEqual(await tv.page.locator(".requests-discover").evaluate(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return [rect.top, rect.height, style.fontSize, style.letterSpacing, style.color]; }), [1049, 21, "17px", "1.6px", "rgba(237, 237, 237, 0.55)"], "the first row stops 10 px above DISCOVER");
        assert.equal(await top(tv, ".requests-row:nth-of-type(2) .requests-heading"), 1074);
        let tops = await rowTops(tv);
        assert.equal(tops.heading, 596); assert.equal(await untransformedArtTop(tv), 662);
        assert.equal(await top(tv, '[data-focus="b"] .browse-art'), 662, "unfocused art sits on Apple's row line, not centred in a taller card");
        assert.equal(await top(tv, '[data-focus="b"] .browse-card-title'), 948);
        await tv.remote(40); await settledScroll(tv);
        tops = await rowTops(tv);
        assert.equal(tops.eyebrow, 596); assert.equal(tops.heading, 621); assert.equal(await untransformedArtTop(tv), 687);
        await tv.remote(40); await settledScroll(tv);
        tops = await rowTops(tv);
        assert.equal(tops.eyebrow, undefined); assert.equal(tops.heading, 596); assert.equal(await untransformedArtTop(tv), 662);
        assert.equal(await tv.page.evaluate(() => [...document.querySelectorAll(".requests-card .browse-card-subtitle")].filter(node => { const rect = node.getBoundingClientRect(); return rect.bottom > 586 && rect.top < 596; }).length), 0, "no earlier row reaches the band");
        await tv.remote(40); await tv.remote(40); await settledScroll(tv);
        tops = await rowTops(tv);
        assert.equal(tops.heading, 596, "the last row still reaches the band top"); assert.equal(await untransformedArtTop(tv), 662);
        for (let press = 0; press < 3; press++) await tv.remote(38);
        await settledScroll(tv);
        assert.equal(await tv.focused(), "a");
        tops = await rowTops(tv);
        assert.equal(tops.heading, 596, "re-entering the first row shows its heading"); assert.equal(await untransformedArtTop(tv), 662);
        await tv.remote(38); assert.equal(await tv.focused(), "requests");
        await tv.remote(40); await settledScroll(tv);
        assert.equal(await tv.focused(), "a"); assert.equal(await untransformedArtTop(tv), 662);
    } finally { await tv.page.context().close(); }
});
test("Up and Down between hub rows keep the visual column; Down from the bar goes to the first card", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true; manyRows(tv, fake);
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "a").waitFor();
        await tv.eventually(async () => await tv.focused() === "a", "first card");
        await tv.remote(39); await tv.remote(39); assert.equal(await tv.focused(), "c");
        await tv.remote(40); assert.equal(await tv.focused(), "movie:2002", "third card below");
        await tv.remote(38); assert.equal(await tv.focused(), "c", "third card above");
        await tv.remote(39); await tv.remote(40); assert.equal(await tv.focused(), "movie:2003", "the moved column wins over the remembered card");
        await tv.remote(38); assert.equal(await tv.focused(), "d");
        for (let press = 0; press < 3; press++) await tv.remote(37);
        await tv.remote(38); assert.equal(await tv.focused(), "requests");
        await tv.remote(40); assert.equal(await tv.focused(), "a");
    } finally { await tv.page.context().close(); }
});
test("Select on the shown Requests tab moves focus to the first card without a read or a loading page", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.created = true; manyRows(tv, fake);
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "a").waitFor();
        await tv.eventually(async () => await tv.focused() === "a", "first card");
        await tv.remote(38); assert.equal(await tv.focused(), "requests");
        const reads = tv.fake.paths().length;
        await tv.page.keyboard.press("Enter");
        assert.equal(await tv.focused(), "a");
        assert.equal(await tv.page.locator(".requests-loading").count(), 0);
        await tv.page.waitForTimeout(100); await tv.jump(1);
        assert.equal(tv.fake.paths().filter(path => path.startsWith("GET /requests")).length, tv.fake.paths().slice(0, reads).filter(path => path.startsWith("GET /requests")).length, "selecting the shown tab reads nothing");
        assert.equal(await tv.focused(), "a", "focus stays on the first card");
    } finally { await tv.page.context().close(); }
});
test("a ready detail has no focus stop below More like this, and every failure keeps a visible retry", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); nativeDetail(fake, "Apocalypse Z: New World", 3);
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "movie:949").click();
        await view(tv, "media"); await button(tv, "create").waitFor(); await button(tv, "movie:1000").waitFor();
        assert.equal(await button(tv, "refresh").count(), 0); assert.equal(await button(tv, "back").count(), 0);
        await tv.remote(40); assert.equal(await tv.focused(), "movie:1000");
        await tv.remote(40); assert.equal(await tv.focused(), "movie:1000", "Down from the rail stays on the poster");
        fake.requestFailure = { status: 503, text: "unavailable" };
        await tv.remote(10009); await view(tv, "hub"); await button(tv, "movie:949").click();
        const retry = button(tv, "retry");
        await tv.page.getByRole("button", { name: "Try Again", exact: true }).waitFor();
        await tv.eventually(async () => await tv.focused() === "retry", "failed detail focuses Try Again");
        await view(tv, "media");
        const rect = await retry.evaluate(node => { const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
        assert.equal(await hit(tv, "retry", rect.x, rect.y), true, "Try Again is painted");
        assert.equal(rect.x, 960, "Try Again is centred, as in ErrorView");
        assert.equal(await tv.page.locator(".requests-failure .search-state-title").textContent(), "Something went wrong", "the hub's error page, not a plain message");
        assert.equal(await tv.page.locator(".requests-failure .search-state-description").textContent(), "The server ran into a problem. Try again in a moment.");
        assert.equal(await tv.page.locator('[data-focus="back"], [data-focus="refresh"]').count(), 0, "Apple's error page has no Back or Refresh control");
        await tv.remote(38); assert.equal(await tv.focused(), "retry", "Up has nowhere to go on a pushed page");
        await tv.remote(40); assert.equal(await tv.focused(), "retry", "nor Down");
        fake.requestFailure = undefined; await retry.click(); await button(tv, "create").waitFor();
        assert.equal(await button(tv, "retry").count(), 0, "recovery leaves the ready page");
        assert.equal(await button(tv, "refresh").count(), 0, "recovery leaves the ready page");
        await tv.eventually(async () => await tv.focused() === "create", "recovery focuses the action");
    } finally { await tv.page.context().close(); }
});
test("record detail with a failed metadata read keeps Refresh, painted above the backdrop", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.route("https://image.tmdb.org/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#a50"/></svg>' }));
        const fake = new FakeRequests(); fake.created = true;
        Object.assign(fake.record, { backdrop_path: "/backdrop.svg" });
        tv.fake.script("/requests/detail/movie/949", { status: 400, text: "bad" });
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "request-one").click();
        await view(tv, "request");
        const refresh = button(tv, "refresh"); await refresh.waitFor();
        const notice = tv.page.getByText("Could not load title information. Refresh to try again.");
        await notice.waitFor();
        await tv.page.locator(".requests-detail-hero .skyline-tint-wash").waitFor();
        await tv.page.waitForTimeout(260);
        const paints = (selector: string) => tv.page.locator(selector).last().evaluate(node => { const r = node.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, Math.min(r.y + r.height / 2, 1079)); return { left: r.left, painted: top === node || node.contains(top), onScreen: r.top < 1080, layer: getComputedStyle(node).zIndex }; });
        // The tint takes no hit tests, so its layer is asserted directly; x04-record-metadata-failure is the painted proof.
        for (const selector of ['[data-focus="refresh"]', ".browse-error"]) assert.deepEqual(await paints(selector), { left: 100, painted: true, onScreen: true, layer: selector === ".browse-error" ? "1" : "auto" }, `${selector} paints above the page tint on the page inset`);
    } finally { await tv.page.context().close(); }
});
test("More like this scrolls the page to its end, enters under the action and offsets as Apple's rail does", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.route("https://image.tmdb.org/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#a50"/></svg>' }));
        const fake = new FakeRequests(); fake.created = true; nativeDetail(fake, "Dune: Part Three", 12);
        Object.assign(fake.record, { backdrop_path: "/backdrop.svg" });
        const title = fake.title.bind(fake); fake.title = () => ({ ...title(), backdrop_path: "/backdrop.svg" });
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "request-one").click();
        await view(tv, "request"); await button(tv, "movie:1000").waitFor();
        await tv.page.locator(".browse").evaluate(node => (node as HTMLElement).style.setProperty("--poster-scale", "0.86"));
        await tv.page.evaluate(async () => document.fonts.ready);
        await button(tv, "status").evaluate(node => { (node.querySelector(".requests-status-label") as HTMLElement).style.width = "301px"; });
        assert.equal(await tv.page.locator(".requests-detail-hero .skyline-art-frame").evaluate(node => { const rect = node.getBoundingClientRect(); return [rect.left, rect.width]; }).then(value => value.map(Math.round).join()), "691,1229", "the detail artwork is 64% of the screen, flush right");
        assert.equal(await tv.page.locator(".requests-detail-hero .requests-synopsis").evaluate(node => getComputedStyle(node).lineHeight), "36px");
        assert.equal(await button(tv, "status").evaluate(node => getComputedStyle(node).transform.startsWith("matrix(1.025")), true);
        await tv.remote(40); await settledScroll(tv);
        assert.equal(await tv.focused(), "movie:1001", "the poster nearest the action's centre");
        assert.equal(Math.round(await top(tv, ".requests-detail-hero ~ .requests-rail .requests-card")), 569);
        assert.equal(Math.round(await top(tv, ".requests-detail-hero ~ .requests-heading")), 513);
        assert.equal(Math.round(await tv.page.locator(".requests-detail-hero .skyline-art-frame").evaluate(node => node.getBoundingClientRect().top)), -297, "the artwork leaves with the page");
        assert.deepEqual(await tv.page.locator(".requests-detail-hero .skyline-tint-wash").evaluate(node => { const rect = node.getBoundingClientRect(); return [rect.top, rect.height]; }), [0, 1080], "the page tint stays");
        assert.equal(await hit(tv, "status", 300, 505), true, "the action paints above the scrolled hero edge");
        assert.equal(await hit(tv, "status", 300, 520), false, "and stays clipped at it");
        for (const expected of [1002, 1003, 1004, 1005, 1006, 1007, 1008]) { await tv.remote(39); assert.equal(await tv.focused(), `movie:${expected}`); await settledScroll(tv); }
        const edge = await tv.page.locator(".requests-detail-hero ~ .requests-rail .requests-card").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().left));
        assert.ok(Math.abs((edge[8] ?? 0) - 1551) <= 1, `ninth poster at ${edge[8]}`);
        assert.ok(Math.abs((edge[9] ?? 0) - 1772) <= 1, `tenth poster at ${edge[9]}`);
        await tv.eventually(async () => await button(tv, "movie:1009").evaluate(node => getComputedStyle(node).opacity) === "1", "the tenth poster touches the rail bounds and draws");
    } finally { await tv.page.context().close(); }
});
test("a short action enters the first poster, and pill backgrounds follow TVPillButtonStyle", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); nativeDetail(fake, "Apocalypse Z: New World", 3);
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "movie:949").click();
        await view(tv, "media"); await button(tv, "movie:1000").waitFor();
        await tv.page.locator(".browse").evaluate(node => (node as HTMLElement).style.setProperty("--poster-scale", "0.86"));
        await tv.remote(40); await settledScroll(tv);
        assert.equal(await tv.focused(), "movie:1000");
        assert.equal(Math.round(await top(tv, ".requests-detail-hero ~ .requests-rail .requests-card")), 569);
        assert.equal(await button(tv, "create").evaluate(node => getComputedStyle(node).backgroundColor), "rgba(255, 255, 255, 0.1)", "primary rest fill");
        await tv.remote(10009); await view(tv, "hub");
        fake.created = true; await revisitRequests(tv); await button(tv, "request-one").click();
        await view(tv, "request"); await button(tv, "movie:1000").waitFor(); await tv.remote(40);
        assert.equal(await button(tv, "status").evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0.52)", "secondary rest fill");
    } finally { await tv.page.context().close(); }
});
test("a hub read fault goes out once, and an answer without row_order reaches the empty page", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv);
        fake.requestFailure = { status: 503, text: "unavailable" };
        await button(tv, "requests").click();
        await button(tv, "retry").waitFor();
        await tv.jump(3000);
        assert.equal(tv.fake.paths().filter(path => path === "GET /requests/discover").length, 1, "Apple's hub sends discover once");
        assert.equal(tv.fake.paths().filter(path => path.startsWith("GET /requests/mine")).length, 1, "Apple's hub sends mine once");
        fake.requestFailure = undefined;
        const route = fake.route.bind(fake);
        fake.route = (method, path, profile, body) => method === "GET" && (path === "/requests/discover" || path.startsWith("/requests/mine")) ? { status: 200, body: { items: [] } } : route(method, path, profile, body);
        await button(tv, "retry").click();
        await tv.page.getByRole("heading", { name: "Nothing here yet" }).waitFor();
    } finally { await tv.page.context().close(); }
});
test("hub marquee uses Apple's title width, synopsis rhythm, rating row and focused card stroke", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(), title = fake.title.bind(fake);
        fake.title = () => ({ ...title(), title: "Heat", year: 1995, overview: "A long overview describing the world and the characters. ".repeat(12), vote_average: 7.5 });
        await start(tv, fake); await button(tv, "requests").click(); await button(tv, "movie:949").waitFor();
        await tv.page.evaluate(async () => document.fonts.ready);
        // Apple 01: title 244, meta 361, synopsis 400 to 491, status 509; with no status the copy ends at 536 as well.
        assert.equal(await top(tv, ".requests-preview .requests-metadata") - await top(tv, ".requests-hero-title"), 117);
        assert.equal(await tv.page.locator(".requests-hero-copy").evaluate(node => node.getBoundingClientRect().bottom), 536);
        assert.equal(await tv.page.locator(".requests-hero-title").evaluate(node => node.getBoundingClientRect().width), 880);
        const synopsis = await tv.page.locator(".requests-preview .requests-synopsis").evaluate(node => { const style = getComputedStyle(node), rect = node.getBoundingClientRect(); return [style.lineHeight, rect.width]; });
        assert.deepEqual(synopsis, ["32px", 780]);
        const row = await tv.page.locator(".requests-preview .requests-metadata").evaluate(node => { const text = node.querySelector("span")?.getBoundingClientRect(), logo = node.querySelector("img")?.getBoundingClientRect(), value = node.querySelector(".requests-tmdb span") as HTMLElement; return { dot: Math.round((logo?.left ?? 0) - (text?.right ?? 0)), gap: Math.round(value.getBoundingClientRect().left - (logo?.right ?? 0)), color: getComputedStyle(value).color, weight: getComputedStyle(value).fontWeight }; });
        assert.deepEqual(row, { dot: 15, gap: 7, color: "rgb(160, 160, 160)", weight: "700" });
        assert.equal(await tv.page.locator(".requests-card:focus .browse-art").evaluate(node => getComputedStyle(node, "::after").content !== "none" && getComputedStyle(node, "::after").boxShadow !== "none"), true, "the focused card carries Apple's light edge");
        assert.match(await tv.page.locator(".requests-card:focus .browse-art").evaluate(node => getComputedStyle(node, "::after").backgroundImage), /radial-gradient\(145% 70% at 25% 0(px|%)/, "the focused poster carries the upper-left sheen measured against Apple's pair 02a");
        assert.equal((await tv.page.locator(".requests-card:focus .browse-art").evaluate(node => getComputedStyle(node, "::after").boxShadow)).split(/,\s*(?=rgba)/).length, 3, "top, even and bottom edge strokes");
    } finally { await tv.page.context().close(); }
});
