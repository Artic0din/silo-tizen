import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const YOUTUBE = { kind: "trailer", site: "YouTube", site_key: "abc_def-1", name: "Official Trailer", is_official: true };

function trailerTest(name: string, body: (tv: Tv, catalog: FakeDetails) => Promise<void>): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        const catalog = new FakeDetails();
        tv.fake.catalog = catalog;
        try {
            await tv.page.evaluate(() => window.browseHarness.connect());
            await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
            tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
            await tv.jump(5000);
            await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
            await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
            await tv.page.evaluate(() => window.browseHarness.mount());
            await body(tv, catalog);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

trailerTest("a movie with only a YouTube video shows Trailers & More and leaves playback alone", async (tv, catalog) => {
    catalog.videos = [YOUTUBE, { kind: "trailer", site: "vimeo", site_key: "v1", is_official: false }];
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator(".details-extras").waitFor();
    assert.deepEqual(await tv.page.locator(".details-extras [data-focus]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["remote:YouTube:abc_def-1"]);
    // The section after the row can paint later, and the caption gap is measured to it.
    await tv.page.locator(".details-extras + *").waitFor();
    const metrics = await tv.page.evaluate(() => {
        const row = document.querySelector<HTMLElement>(".details-extras")!;
        const card = row.querySelector<HTMLElement>(".details-extra")!;
        const still = card.querySelector<HTMLElement>(".browse-still")!;
        const title = card.querySelector<HTMLElement>(".browse-card-title")!;
        const caption = card.querySelector<HTMLElement>(".browse-card-subtitle")!;
        const next = row.nextElementSibling!.getBoundingClientRect().top;
        const stillBox = still.getBoundingClientRect();
        const titleStyle = getComputedStyle(title);
        const captionStyle = getComputedStyle(caption);
        return {
            gap: next - caption.getBoundingClientRect().bottom,
            stillWidth: stillBox.width,
            stillHeight: stillBox.height,
            radius: getComputedStyle(still).borderRadius,
            titleGap: title.getBoundingClientRect().top - stillBox.bottom,
            captionGap: caption.getBoundingClientRect().top - title.getBoundingClientRect().bottom,
            titleSize: titleStyle.fontSize,
            titleWeight: titleStyle.fontWeight,
            titleColor: titleStyle.color,
            captionSize: captionStyle.fontSize,
            captionWeight: captionStyle.fontWeight,
            captionColor: captionStyle.color,
            titleText: title.textContent,
            captionText: caption.textContent,
            badge: card.querySelector<HTMLElement>(".details-extra-play")?.getBoundingClientRect().width,
        };
    });
    assert.equal(metrics.titleText, "Official Trailer");
    assert.equal(metrics.captionText, "YouTube");
    assert.ok(Math.abs(metrics.gap - 76) < 1, JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.stillWidth - 470) < 1, JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.stillHeight - 264) < 1, JSON.stringify(metrics));
    assert.equal(metrics.radius, "18px");
    assert.ok(Math.abs(metrics.titleGap - 14) < 1, JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.captionGap - 5) < 1, JSON.stringify(metrics));
    assert.equal(metrics.titleSize, "21px");
    assert.equal(metrics.titleWeight, "600");
    assert.equal(metrics.titleColor, "rgba(237, 237, 237, 0.92)");
    assert.equal(metrics.captionSize, "17px");
    assert.equal(metrics.captionWeight, "500");
    assert.equal(metrics.captionColor, "rgba(237, 237, 237, 0.6)");
    assert.equal(metrics.badge, 60);
    const before = tv.fake.requests.length;
    await tv.page.locator(".details-people [data-focus]").first().focus();
    await tv.remote(40);
    assert.equal(await tv.focused(), "remote:YouTube:abc_def-1");
    assert.equal(tv.fake.requests.length, before, "moving onto the rail must not fetch");
    await tv.page.locator('[data-focus="remote:YouTube:abc_def-1"]').click();
    assert.equal(await tv.focused(), "remote:YouTube:abc_def-1");
    assert.equal(tv.fake.requests.filter(request => request.path.includes("/playback/") || request.path.includes("/versions")).length, 0);
    const focused = await tv.page.locator(".details-extra:focus .browse-still").evaluate(node => getComputedStyle(node).transform);
    assert.equal(focused, "none");
});

trailerTest("a series with a YouTube video shows the rail and hides it when the list is empty", async (tv, catalog) => {
    catalog.videos = [YOUTUBE];
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator(".details-extras").waitFor();
    assert.equal(await tv.page.getByRole("heading", { name: "Trailers & More", exact: true }).count(), 1);
    catalog.videos = [];
    await tv.remote(10009);
    await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
    await tv.page.locator('[data-focus="next-episode"]').waitFor();
    assert.equal(await tv.page.locator(".details-extras").count(), 0);
});

trailerTest("local extras stay ahead of YouTube cards and keep a 48px gap", async (tv, catalog) => {
    catalog.extras = [{ content_id: "extra:1", file_id: 42, kind: "featurette", title: "Making Of", duration_seconds: 90, still_url: "/art/extra.svg" }];
    catalog.videos = [YOUTUBE];
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator(".details-extras").waitFor();
    const cards = await tv.page.locator(".details-extra").evaluateAll(nodes => nodes.map(node => ({
        key: node.getAttribute("data-focus"),
        caption: node.querySelector(".browse-card-subtitle")?.textContent,
    })));
    assert.deepEqual(cards, [
        { key: "extra:extra:1", caption: "1:30" },
        { key: "remote:YouTube:abc_def-1", caption: "YouTube" },
    ]);
    // A Details repaint can replace the row between resolving a locator and reading it, and a detached row measures 0.
    const gap = await tv.page.evaluate(() => {
        const [first, second] = [...document.querySelectorAll(".details-extras .details-extra")].map(node => node.getBoundingClientRect());
        return second!.left - first!.right;
    });
    assert.ok(Math.abs(gap - 48) < 1, String(gap));
});

trailerTest("down from cast always enters Trailers & More on the first card", async (tv, catalog) => {
    catalog.extras = [{ content_id: "extra:1", file_id: 42, kind: "featurette", title: "Making Of", duration_seconds: 90, still_url: "/art/extra.svg" }];
    catalog.videos = [YOUTUBE];
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
    await tv.page.locator(".details-extras").waitFor();
    await tv.page.getByText("Loading related titles.", { exact: true }).waitFor({ state: "hidden" });
    const firstCast = await tv.page.locator(".details-people [data-focus]").first().getAttribute("data-focus");
    await tv.page.locator(".details-people [data-focus]").first().focus();
    await tv.remote(40);
    assert.equal(await tv.focused(), "extra:extra:1");
    await tv.remote(39);
    assert.equal(await tv.focused(), "remote:YouTube:abc_def-1");
    await tv.remote(38);
    assert.equal(await tv.focused(), firstCast);
    await tv.remote(40);
    assert.equal(await tv.focused(), "extra:extra:1");
});
