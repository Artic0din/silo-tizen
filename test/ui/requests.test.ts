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
async function start(tv: Tv, fake = new FakeRequests()): Promise<FakeRequests> {
    tv.fake.catalog = fake;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? ""); await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
    return fake;
}
const button = (tv: Tv, key: string) => tv.page.locator(`[data-focus="${key}"]`).last();
async function view(tv: Tv, kind: string): Promise<void> { await tv.page.locator(`.browse[data-view="requests:${kind}"]`).waitFor(); }
async function evidence(tv: Tv, name: string): Promise<void> {
    if (!process.env.REQUESTS_EVIDENCE) return;
    await mkdir(process.env.REQUESTS_EVIDENCE, { recursive: true });
    await tv.page.screenshot({ path: `${process.env.REQUESTS_EVIDENCE}/${name}.png` });
}
test("Requests hub, search, create, My Requests and cancel preserve return focus", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = await start(tv); await evidence(tv, "home");
        await button(tv, "requests").click(); await view(tv, "hub");
        await button(tv, "movie:949").waitFor(); await evidence(tv, "hub");
        const count = tv.fake.requests.length; await button(tv, "movie:949").focus(); await tv.remote(40);
        assert.equal(tv.fake.requests.length, count, "focus never fetches");
        await button(tv, "search").click(); await view(tv, "search");
        await tv.page.getByRole("searchbox", { name: "Search requests" }).fill("Heat");
        await button(tv, "submit").click(); await button(tv, "movie:949").waitFor();
        await evidence(tv, "search"); await button(tv, "movie:949").click(); await view(tv, "media");
        await button(tv, "create").waitFor(); await evidence(tv, "detail");
        await button(tv, "create").click();
        await tv.eventually(async () => fake.created && await button(tv, "create").count() === 0, "created");
        await tv.remote(10009); await view(tv, "search");
        assert.equal(await tv.focused(), "movie:949");
        await tv.remote(10009); await view(tv, "hub"); await button(tv, "mine").click(); await view(tv, "mine");
        await button(tv, "request-one").click(); await view(tv, "request"); await button(tv, "cancel").waitFor();
        await evidence(tv, "my-request"); await button(tv, "cancel").click();
        await tv.eventually(async () => fake.cancelled && await button(tv, "cancel").count() === 0, "cancelled");
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests").length, 1);
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests/request-one/cancel").length, 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
test("Requests disabled, empty, failure, Retry and capability removal", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests(); fake.enabled = false; await start(tv, fake);
        assert.equal(await button(tv, "requests").count(), 0);
        fake.enabled = true;
        await tv.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await button(tv, "requests").waitFor(); await button(tv, "requests").click(); await view(tv, "hub");
        fake.requestsEmpty = true; await button(tv, "refresh").click();
        await tv.page.getByText("No titles available.", { exact: true }).waitFor(); await evidence(tv, "empty");
        fake.requestFailure = problem(400, "validation_failed", "Unavailable"); await button(tv, "refresh").click();
        await tv.page.getByRole("button", { name: "Retry", exact: true }).waitFor(); await evidence(tv, "failure");
        fake.requestFailure = undefined; fake.requestsEmpty = false; await button(tv, "refresh").click(); await button(tv, "movie:949").waitFor();
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
        fake.following = true; await button(tv, "refresh").click();
        await tv.page.getByRole("button", { name: "Unfollow", exact: true }).waitFor();
        tv.fake.dropNextAnswer("/requests/follows/movie/949"); await button(tv, "follow").click();
        await tv.page.getByText("Could not confirm the change. Refresh before trying again.").waitFor();
        await tv.jump(2000);
        assert.equal(tv.fake.paths().filter(path => path === "DELETE /requests/follows/movie/949").length, 2);
        assert.equal(await button(tv, "follow").isDisabled(), true);
        fake.requestedByOther = false;
        await button(tv, "refresh").click(); await button(tv, "create").waitFor();
        await tv.eventually(async () => !await button(tv, "create").isDisabled(), "refreshed");
        tv.fake.dropNextAnswer("/requests"); await button(tv, "create").click();
        await tv.page.getByText("Could not confirm the change. Refresh before trying again.").waitFor();
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
        await button(tv, "requests").click(); await button(tv, "mine").click();
        await button(tv, "request-one").click(); await button(tv, "cancel").waitFor();
        tv.fake.dropNextAnswer("/requests/request-one/cancel"); await button(tv, "cancel").click();
        await tv.page.getByText("Could not confirm the change. Refresh before trying again.").waitFor();
        await tv.jump(2000);
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests/request-one/cancel").length, 1);
        assert.equal(await button(tv, "cancel").isDisabled(), true);
        assert.equal(await tv.focused(), "refresh");
        await tv.remote(38);
        assert.notEqual(await tv.focused(), "cancel", "disabled actions are absent from focus zones");
        await button(tv, "refresh").focus(); await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await button(tv, "cancel").count() === 0, "cancel reconciled");
        await tv.remote(10009); await tv.remote(10009); await button(tv, "movie:949").click(); await button(tv, "create").waitFor();
        const refreshes = tv.fake.paths().filter(path => path.includes("/auth/refresh")).length;
        tv.fake.script("/requests", problem(401, "token_refresh_required", "Refresh required"));
        await button(tv, "create").click();
        await tv.page.getByText("Could not confirm the change. Refresh before trying again.").waitFor();
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests").length, 1);
        assert.equal(tv.fake.paths().filter(path => path.includes("/auth/refresh")).length, refreshes + 1, "session may refresh, but never resends the write");
    } finally { await tv.page.context().close(); }
});

test("editing search fences late results and a held write fences profile changes", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv); await button(tv, "requests").click(); await button(tv, "search").click();
        const input = tv.page.getByRole("searchbox", { name: "Search requests" });
        await input.fill("Heat");
        const held = tv.fake.hold("/requests/search", true);
        await button(tv, "submit").click();
        await tv.eventually(async () => tv.fake.paths().includes("GET /requests/search?q=Heat&media_type=all&page=1"), "search held");
        await input.fill("Other"); held.release(); await tv.jump(1);
        assert.equal(await button(tv, "movie:949").count(), 0);
        await button(tv, "submit").click(); await button(tv, "movie:949").click(); await button(tv, "create").waitFor();
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
        await tv.page.getByText("pending", { exact: true }).waitFor();
        // Serve stale media state until the held write's answer has reached the client.
        fake.created = false; await button(tv, "refresh").click(); await button(tv, "create").waitFor();
        assert.equal(await button(tv, "create").isDisabled(), true);
        fake.created = true; held.release();
        await tv.eventually(async () => await button(tv, "create").count() === 0, "visible detail reconciled after settlement");
        assert.equal(tv.fake.paths().filter(path => path === "POST /requests").length, 1);
    } finally { await tv.page.context().close(); }
});

test("typing in Requests search keeps the field attached and focused", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv); await button(tv, "requests").click(); await button(tv, "search").click(); await view(tv, "search");
        const input = tv.page.getByRole("searchbox", { name: "Search requests" });
        await input.focus();
        await tv.page.evaluate(() => {
            const field = document.activeElement as HTMLInputElement & { blurs?: number };
            field.blurs = 0; field.addEventListener("blur", () => { field.blurs = (field.blurs ?? 0) + 1; });
        });
        const blurs = () => tv.page.evaluate(() => (document.querySelector('[aria-label="Search requests"]') as HTMLInputElement & { blurs?: number }).blurs);
        await input.pressSequentially("Hea");
        assert.equal(await blurs(), 0, "editing never detaches the field");
        await input.press("Enter"); await button(tv, "movie:949").waitFor();
        await input.pressSequentially("t");
        assert.equal(await input.inputValue(), "Heat");
        assert.equal(await blurs(), 0, "results and edits never detach the field");
        assert.equal(await input.evaluate(field => field === document.activeElement), true);
    } finally { await tv.page.context().close(); }
});

test("a late Requests read keeps focus the person moved meanwhile", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await start(tv); await button(tv, "requests").click(); await view(tv, "hub"); await button(tv, "movie:949").waitFor();
        const reads = tv.fake.paths().filter(path => path === "GET /requests/discover").length;
        const held = tv.fake.hold("/requests/discover");
        await button(tv, "refresh").click();
        await tv.eventually(async () => tv.fake.paths().filter(path => path === "GET /requests/discover").length > reads, "held refresh");
        await tv.remote(39);
        const moved = await tv.focused();
        assert.notEqual(moved, "refresh");
        held.release();
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
        await tv.page.getByRole("button", { name: "Heat · pending" }).waitFor();
    } finally { await tv.page.context().close(); }
});
