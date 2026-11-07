import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { fixture, problem, type Reply } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const NOW = "2026-01-02T03:04:05.678Z";
const MEASURED = {
    connection: "remote",
    probe: { kbps: 48000, lower_bound: false, measured_at: NOW, transport: "wifi" },
    auto_budget_kbps: 35280,
};

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function setup(prepare?: (page: Page) => Promise<void>) {
    const tv = await openTv(browser, { app: "browse", ...(prepare === undefined ? {} : { prepare }) });
    tv.fake.catalog = new FakeCatalog();
    const settings = new FakeSettings(tv.fake);
    settings.devicePlayback = false;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase) === "signed_in", "sign in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount(true));
    await tv.page.locator('[data-view="home"]').waitFor();
    await tv.eventually(async () => ["keys=ui.title_art", "keys=ui.card_overlays"].every(key => tv.fake.requests.some(request => request.path.startsWith("/settings/values/effective?") && request.path.includes(key))), "Home settings reads");
    return { tv, settings };
}

async function openSettings(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).waitFor();
}

function featuresOf(body: Record<string, unknown>): string[] {
    return Array.isArray(body.features) ? body.features.filter((feature): feature is string => typeof feature === "string") : [];
}

function serveConnection(tv: Tv, connection: Record<string, unknown> | "missing", probe?: Reply): void {
    const origin = tv.fake.origin;
    tv.fake.extraRoutes.push((method, path) => {
        if (method === "GET" && path === "/playback/capabilities") {
            return { status: 200, body: { ...fixture("playback_capability_available"), bandwidth_probe_url: `${origin}/api/v2/playback/bandwidth-probe?media_path=true` } };
        }
        if (method === "GET" && path === "/playback/connection") {
            return connection === "missing" ? problem(404, "not_found", "Not found") : { status: 200, body: connection };
        }
        if (method === "GET" && path.split("?")[0] === "/playback/bandwidth-probe") return probe ?? { status: 500, text: "" };
        if (method === "POST" && path === "/playback/bandwidth-probe/results") return { status: 204 };
        return undefined;
    });
}

function probes(tv: Tv) {
    return tv.fake.requests.filter(request => request.path.split("?")[0] === "/playback/bandwidth-probe");
}

function reports(tv: Tv) {
    return tv.fake.requests.filter(request => request.method === "POST" && request.path === "/playback/bandwidth-probe/results");
}

test("Connection speed stays hidden without connection_speed_v1", async () => {
    const { tv } = await setup();
    const raw = fixture("playback_capability_available");
    tv.fake.extraRoutes.push((method, path) => {
        if (method === "GET" && path === "/playback/capabilities") {
            return { status: 200, body: { ...raw, features: featuresOf(raw).filter(feature => feature !== "connection_speed_v1") } };
        }
        return undefined;
    });
    try {
        await openSettings(tv);
        await tv.eventually(async () => tv.fake.requests.some(request => request.path === "/playback/capabilities"), "capabilities");
        await tv.page.locator('[data-focus="playback"]').click();
        assert.equal(await tv.page.locator('[data-focus="connection-speed"]').count(), 0);
        assert.equal(tv.fake.requests.some(request => request.path === "/playback/connection"), false);
        assert.equal(probes(tv).length, 0);
        assert.deepEqual(await tv.page.locator(".settings-section-header").allTextContents(), ["QUALITY", "STREAMING", "EPISODES", "SPOILERS", "VIDEO"]);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Playback shows the stored speed and tests only from Test speed", async () => {
    const { tv } = await setup();
    serveConnection(tv, MEASURED, { status: 429, headers: { "Retry-After": "12" }, body: { title: "wait" } });
    try {
        await openSettings(tv);
        await tv.eventually(async () => tv.fake.requests.some(request => request.path === "/playback/connection"), "stored connection");
        const reads = tv.fake.requests.filter(request => request.path === "/playback/connection").length;
        const requests = tv.fake.requests.length;
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "playback");
        await tv.page.locator(".settings-connection-line").waitFor();
        assert.equal(tv.fake.requests.length, requests, "focusing Playback adds no request");
        assert.equal(tv.fake.requests.filter(request => request.path === "/playback/connection").length, reads);
        assert.equal(probes(tv).length, 0);
        assert.equal(await tv.page.locator(".settings-connection-line").textContent(), "48 Mbps · measured just now on Wi-Fi");
        assert.equal(await tv.page.locator('[data-focus="connection-speed"] .settings-row-value').textContent(), "Test speed");
        assert.equal(await tv.page.locator(".settings-connection-budget").textContent(), "Auto plays videos up to 35 Mbps without converting them.");
        assert.deepEqual(await tv.page.locator(".settings-section-header").allTextContents(), ["QUALITY", "CONNECTION", "STREAMING", "EPISODES", "SPOILERS", "VIDEO"]);
        const order = await tv.page.evaluate(() => {
            const footer = document.querySelector(".settings-quality-footer");
            const connection = [...document.querySelectorAll(".settings-section-header")].find(node => node.textContent === "CONNECTION");
            const streaming = [...document.querySelectorAll(".settings-section-header")].find(node => node.textContent === "STREAMING");
            if (footer === null || connection === undefined || streaming === undefined) return false;
            return Boolean(footer.compareDocumentPosition(connection) & Node.DOCUMENT_POSITION_FOLLOWING)
                && Boolean(connection.compareDocumentPosition(streaming) & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        assert.equal(order, true);
        const stored = tv.fake.requests.find(request => request.path === "/playback/connection");
        assert.equal(stored?.headers["x-profile-id"], "p-owner");
        assert.ok(stored?.headers.authorization?.startsWith("Bearer "));
        assert.ok(stored?.headers["x-silo-device-id"]);
        await tv.jump(60_000);
        assert.equal(await tv.page.locator(".settings-connection-line").textContent(), "48 Mbps · measured 1 minute ago on Wi-Fi");
        const hold = tv.fake.hold("/playback/bandwidth-probe");
        try {
            await tv.page.locator('[data-focus="connection-speed"]').click();
            await tv.page.locator('[data-focus="connection-speed"] .settings-row-value', { hasText: "Testing…" }).waitFor();
            await tv.eventually(async () => probes(tv).length === 1, "probe download");
            const probe = probes(tv)[0];
            assert.ok(probe?.path.includes("size=1000000000"));
            assert.ok(probe?.path.includes("media_path=true"));
            assert.equal(probe?.headers["x-profile-id"], "p-owner");
            assert.ok(probe?.headers.authorization?.startsWith("Bearer "));
            assert.ok(probe?.headers["x-silo-device-id"]);
            assert.equal(reports(tv).length, 0);
        } finally { hold.release(); }
        await tv.eventually(async () => tv.pendingReplies === 0, "probe answer");
        await tv.page.getByText("Try again in 12 seconds", { exact: true }).waitFor();
        assert.equal(reports(tv).length, 0);
        await tv.jump(12_000);
        assert.equal(await tv.page.getByText("Try again in 12 seconds", { exact: true }).count(), 0);
        assert.equal(await tv.page.locator(".settings-connection-line").textContent(), "48 Mbps · measured 1 minute ago on Wi-Fi");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a failed speed test says to try again and does not report", async () => {
    const { tv } = await setup();
    serveConnection(tv, MEASURED);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="connection-speed"]').waitFor();
        assert.equal(probes(tv).length, 0);
        await tv.page.locator('[data-focus="connection-speed"]').click();
        await tv.page.getByText("Couldn't measure the connection speed. Try again.", { exact: true }).waitFor();
        assert.equal(probes(tv).length, 1);
        assert.equal(reports(tv).length, 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("leaving Playback cancels the test without a failure", async () => {
    const { tv } = await setup();
    serveConnection(tv, MEASURED);
    const hold = tv.fake.hold("/playback/bandwidth-probe");
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator(".settings-connection-line").waitFor();
        await tv.page.locator('[data-focus="connection-speed"]').click();
        await tv.page.locator('[data-focus="connection-speed"] .settings-row-value', { hasText: "Testing…" }).waitFor();
        await tv.eventually(async () => probes(tv).length === 1, "probe started");
        await tv.page.locator('[data-focus="general"]').click();
        await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).waitFor();
        assert.equal(reports(tv).length, 0);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator(".settings-connection-line").waitFor();
        assert.equal(await tv.page.locator(".settings-connection-line").textContent(), "48 Mbps · measured just now on Wi-Fi");
        assert.equal(await tv.page.locator(".browse-error").count(), 0);
        assert.equal(await tv.page.locator('[data-focus="connection-speed"] .settings-row-value').textContent(), "Test speed");
    } finally { hold.release(); }
    try {
        await tv.eventually(async () => tv.pendingReplies === 0, "cancelled probe settled");
        assert.equal(await tv.page.locator(".browse-error").count(), 0);
        assert.equal(reports(tv).length, 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("an unmeasured connection and a playback sample use Apple's lines", async () => {
    const { tv } = await setup();
    serveConnection(tv, { connection: "remote" });
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator(".settings-connection-line").waitFor();
        assert.equal(await tv.page.locator(".settings-connection-line").textContent(), "Not measured yet");
        assert.equal(await tv.page.locator(".settings-connection-budget").count(), 0);
        assert.equal(await tv.page.locator('[data-focus="connection-speed"] .settings-row-value').textContent(), "Test speed");
    } finally { await tv.page.context().close(); }
    const sample = await setup();
    serveConnection(sample.tv, { connection: "remote", playback_sample: { kbps: 51200, measured_at: "2026-01-02T01:04:05.678Z" } });
    try {
        await openSettings(sample.tv);
        await sample.tv.page.locator('[data-focus="playback"]').click();
        await sample.tv.page.locator(".settings-connection-line").waitFor();
        assert.equal(await sample.tv.page.locator(".settings-connection-line").textContent(), "Faster than 51 Mbps · seen during playback 2 hours ago");
        assert.equal(await sample.tv.page.locator(".settings-connection-budget").count(), 0);
    } finally { await sample.tv.page.context().close(); }
    const bound = await setup();
    serveConnection(bound.tv, { connection: "remote", probe: { kbps: 115000, lower_bound: true, measured_at: NOW, transport: "wifi" } });
    try {
        await openSettings(bound.tv);
        await bound.tv.page.locator('[data-focus="playback"]').click();
        await bound.tv.page.locator(".settings-connection-line").waitFor();
        assert.equal(await bound.tv.page.locator(".settings-connection-line").textContent(), "Faster than 115 Mbps · measured just now on Wi-Fi");
    } finally { await bound.tv.page.context().close(); }
});

test("a missed connection read still offers Test speed", async () => {
    const { tv } = await setup();
    serveConnection(tv, "missing");
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator(".settings-connection-line").waitFor();
        assert.equal(await tv.page.locator(".settings-connection-line").textContent(), "Not measured yet");
        assert.equal(await tv.page.locator('[data-focus="connection-speed"] .settings-row-value').textContent(), "Test speed");
        assert.equal(probes(tv).length, 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Test speed while offline fails without a download", async () => {
    const { tv } = await setup();
    serveConnection(tv, MEASURED);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator(".settings-connection-line").waitFor();
        await tv.page.evaluate(() => {
            Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
        });
        await tv.page.locator('[data-focus="connection-speed"]').click();
        await tv.page.getByText("Couldn't measure the connection speed. Try again.", { exact: true }).waitFor();
        assert.equal(await tv.page.locator(".settings-connection-line").textContent(), "48 Mbps · measured just now on Wi-Fi");
        assert.equal(probes(tv).length, 0);
        assert.equal(reports(tv).length, 0);
    } finally { await tv.page.context().close(); }
});

test("a cellular connection skips the test", async () => {
    const { tv } = await setup(async (page) => {
        await page.addInitScript(() => {
            Object.defineProperty(navigator, "connection", { configurable: true, value: { type: "cellular", saveData: false } });
        });
    });
    serveConnection(tv, MEASURED);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator(".settings-connection-line").waitFor();
        assert.equal(await tv.page.locator(".settings-connection-line").textContent(), "Speed tests are skipped on cellular, and the Cellular Quality settings apply.");
        assert.equal(await tv.page.locator('[data-focus="connection-speed"] .settings-row-value').count(), 0);
        assert.equal(await tv.page.locator(".settings-connection-budget").count(), 0);
        assert.equal(await tv.page.locator('[data-focus="connection-speed"]').getAttribute("aria-disabled"), "true");
        await tv.page.locator('[data-focus="connection-speed"]').click({ force: true });
        assert.equal(probes(tv).length, 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
