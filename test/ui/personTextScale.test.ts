// Every Person text size is Apple's tvOS point size times --silo-sf-cap-scale, and each line runs about as wide as
// SF Pro's (issue #418, the method from #399's detailsTextScale.test.ts).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const PAGE = '.browse[data-view="person:7"]';
const BIO = "A synthetic performer whose work spans film and television.";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

function personTest(name: string, person: Record<string, unknown>, body: (tv: Tv) => Promise<void>): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        tv.fake.catalog = new FakeDetails();
        try {
            await tv.page.route("**/api/v2/catalog/people/7", route => route.fulfill({ json: { id: "7", name: "River Vale", ...person } }));
            await tv.page.route("**/api/v2/catalog/people/7/refresh", route => route.fulfill({ status: 202, json: { status: "queued", person_id: "7" } }));
            await tv.page.evaluate(() => window.browseHarness.connect());
            await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
            tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
            await tv.jump(5000);
            await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
            await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
            await tv.page.evaluate(() => window.browseHarness.mount());
            await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
            await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().click();
            await tv.page.locator(`${PAGE} .browse-grid .browse-card-title`).first().waitFor();
            await tv.page.locator(`${PAGE} .person-title-count`).waitFor();
            await tv.page.evaluate(() => document.fonts.ready);
            await body(tv);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    });
}

/** Rendered text under `root` whose size is not a whole Apple point times the cap scale, as "classes size". */
function unscaledText(root: string): string[] {
    const cap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--silo-sf-cap-scale"));
    const found = new Set<string>();
    for (const node of document.querySelectorAll(`${root}, ${root} *`)) {
        if (node.getClientRects().length === 0) continue;
        if (![...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() !== "")) continue;
        const style = getComputedStyle(node);
        if (style.visibility === "hidden") continue;
        const points = parseFloat(style.fontSize) / cap;
        if (Math.abs(points - Math.round(points)) > 0.002) found.add(`${node.tagName.toLowerCase()}.${[...node.classList].join(".")} ${style.fontSize}`);
    }
    return [...found].sort();
}

/** Width of the first node under `selector` whose text is `text`, or NaN. */
function widthOf({ selector, text }: { selector: string; text: string }): number {
    const node = [...document.querySelectorAll(selector)].find(candidate => (candidate.textContent ?? "").trim() === text);
    if (node === undefined) return Number.NaN;
    const range = document.createRange();
    range.selectNodeContents(node);
    return Math.round(range.getBoundingClientRect().width * 10) / 10;
}

type Line = { readonly selector: string; readonly text: string; readonly width: number };

async function assertSfWidths(tv: Tv, lines: readonly Line[]): Promise<void> {
    for (const line of lines) {
        const width = await tv.page.evaluate(widthOf, { selector: line.selector, text: line.text });
        assert.ok(Math.abs(width / line.width - 1) < 0.015, `${line.text}: ${width}px against SF Pro's ${line.width}px`);
    }
}

personTest("the Person page uses Apple's points times the cap scale", { bio: BIO, birth_date: "1980-04-12", birthplace: "Melbourne", photo_url: "/art/river.svg" }, async tv => {
    await tv.eventually(async () => await tv.page.getByText("Loading metadata", { exact: true }).count() === 0, "person metadata ready");
    await tv.page.locator(`${PAGE} .browse-overview`).waitFor();
    assert.deepEqual(await tv.page.evaluate(unscaledText, PAGE), []);
});

personTest("the metadata capsule and initials use Apple's points times the cap scale", { birth_date: "1980-04-12" }, async tv => {
    await tv.page.getByText("Loading metadata", { exact: true }).waitFor();
    await tv.page.locator(`${PAGE} .person-portrait-initials`).waitFor();
    assert.deepEqual(await tv.page.evaluate(unscaledText, PAGE), []);
    // PersonMetadataRefreshIndicator: siloSmall in siloSecondaryText on siloSurfaceVariant at 0.72 (PersonDetailView.swift:730-738).
    const capsule = await tv.page.locator(`${PAGE} .person-metadata-loading`).evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
    assert.deepEqual(capsule, { color: "rgba(237, 237, 237, 0.6)", background: "rgba(14, 15, 18, 0.72)" });
    await assertSfWidths(tv, [
        { selector: `${PAGE} .person-metadata-loading`, text: "Loading metadata", width: 157.65 },
        { selector: `${PAGE} .person-portrait-initials`, text: "RV", width: 107.63 },
    ]);
});

/** CoreText's SF Pro widths (NSFont.systemFont, the face tvOS draws) at Apple's tvOS size and weight. */
personTest("Person text runs within 1.5% of SF Pro's width at Apple's size", { bio: BIO, birth_date: "1980-04-12", birthplace: "Melbourne", photo_url: "/art/river.svg" }, async tv => {
    await tv.eventually(async () => await tv.page.getByText("Loading metadata", { exact: true }).count() === 0, "person metadata ready");
    await tv.page.locator(`${PAGE} .browse-overview`).waitFor();
    await assertSfWidths(tv, [
        { selector: `${PAGE} .details-person-hero .browse-title`, text: "River Vale", width: 322.26 },
        { selector: `${PAGE} .person-fact`, text: "Melbourne", width: 94.11 },
        { selector: `${PAGE} .person-fact`, text: "Born Apr 12, 1980", width: 156.96 },
        { selector: `${PAGE} .browse-overview`, text: BIO, width: 664.54 },
        { selector: `${PAGE} .person-filmography-heading .browse-section-title`, text: "Filmography", width: 201.98 },
        { selector: `${PAGE} .person-filmography-filters .browse-button`, text: "Movies", width: 67.98 },
        { selector: `${PAGE} .person-filmography-filters .browse-button`, text: "Series", width: 59.06 },
        { selector: `${PAGE} .person-title-count`, text: "63 titles", width: 77.38 },
        { selector: `${PAGE} .browse-grid .browse-card-title`, text: "Quiet Hills", width: 108.91 },
        { selector: `${PAGE} .browse-grid .browse-card-subtitle`, text: "2014", width: 44.40 },
    ]);
});
