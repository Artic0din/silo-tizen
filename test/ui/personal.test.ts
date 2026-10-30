import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { mkdir } from "node:fs/promises";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { problem, type Reply } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";
import { personalQuery } from "../../src/ui/personalLists.ts";

class PersonalCatalog extends FakeDetails {
    readonly excluded = new Set<string>();
    private readonly membershipState = new Map<string, Set<string>>();
    unavailable = false;
    capabilityReplies: Reply[] = [];
    pageReplies: Reply[] = [];
    override route(method: string, path: string, profile: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        if (path.startsWith("/capabilities/personal-lists")) return this.capabilityReplies.shift() ?? { status: 200, body: { revision: "1", state: this.unavailable ? "unsupported" : "available", allowed: !this.unavailable, membership_supported: true } };
        const personal = /^\/(watchlist|favorites)\/([^/?]+)(?:\/membership)?(?:\?.*)?$/.exec(path);
        if (personal?.[1] !== undefined && personal[2] !== undefined) {
            const members = this.members(profile, personal[1]);
            const id = decodeURIComponent(personal[2]);
            if (method === "GET") return { status: 200, body: { item_id: id, is_member: members.has(id) } };
            const reply = super.route(method, path, profile, body);
            if (reply?.status === 204) {
                if (method === "DELETE") members.delete(id);
                else members.add(id);
            }
            return reply;
        }
        if (path.startsWith("/catalog/query") && typeof body?.source === "string" && ["watchlist", "favorites", "history"].includes(body.source)) {
            assert.equal(method, "POST");
            assert.equal(body.limit, 24);
            const failure = this.pageReplies.shift();
            if (failure !== undefined) return failure;
            const scope = `${profile}:${body.source}:${body.type}`;
            // Unset scope queries media_items; episode history aggregates into series there.
            const scoped = [...this.titles.values()].filter(t => (profile === "p-kid" ? t.libraryId === "16" : ["12", "13"].includes(t.libraryId)) && (body.type === undefined || body.type === "video" ? ["movie", "series"].includes(t.type) : t.type === body.type));
            const members = body.source === "history" ? undefined : this.members(profile, body.source);
            const included = (id: string): boolean => !this.excluded.has(id) && (members?.has(id) ?? true);
            const ids = scoped.filter(t => included(t.id));
            const cursor = body.cursor;
            if (cursor !== undefined && (typeof cursor !== "string" || !cursor.startsWith(scope + ":"))) return problem(400, "invalid_cursor", "Invalid cursor");
            const offset = typeof cursor === "string" ? Number(cursor.slice(scope.length + 1)) : 0;
            // The immutable fixture order stands in for the server's fenced keyset.
            // A removed row before the anchor cannot shift a later page backwards.
            const remaining = scoped.slice(offset).filter(t => included(t.id));
            const selected = remaining.slice(0, 24);
            const last = selected[selected.length - 1];
            const next = last === undefined ? offset : scoped.indexOf(last) + 1;
            const cards = selected.map(t => {
                const reply = super.route("GET", `/catalog/items/${encodeURIComponent(t.id)}`, profile);
                return reply?.body;
            });
            return { status: 200, body: { window_cursor: scope, items: cards, total: ids.length, total_exact: true, page: remaining.length > 24 ? { has_more: true, next_cursor: `${scope}:${next}` } : { has_more: false } } };
        }
        return super.route(method, path, profile, body);
    }
    private members(profile: string | undefined, source: string): Set<string> {
        const key = JSON.stringify([profile, source]);
        let members = this.membershipState.get(key);
        if (members === undefined) {
            members = new Set(this.titles.keys());
            this.membershipState.set(key, members);
        }
        return members;
    }
}
let browser: Browser;
test("pinned History scope distinguishes aggregated media from episode queries", () => {
    const catalog = new PersonalCatalog();
    const query = (type?: string): Record<string, unknown>[] => {
        const reply = catalog.route("POST", "/catalog/query", "p-owner", { source: "history", limit: 24, ...(type === undefined ? {} : { type }) });
        return (reply?.body as { items: Record<string, unknown>[] }).items;
    };
    assert.ok(query().every(item => item.type !== "episode"));
    assert.ok(query("episode").some(item => item.type === "episode"));
});
test("History episode filter requests the public episode scope", () => {
    assert.equal(personalQuery("history", "episode").type, "episode");
});
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });
async function setup(record = false): Promise<{ tv: Tv; catalog: PersonalCatalog }> {
    const tv = await openTv(browser, { app: "browse", ...(!record || process.env.PERSONAL_VIDEO === undefined ? {} : { video: process.env.PERSONAL_VIDEO }) });
    const catalog = new PersonalCatalog();
    tv.fake.catalog = catalog;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-view="home"]').waitFor();
    return { tv, catalog };
}
async function openList(tv: Tv, source: string): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator(`[data-focus="${source}"]`).click({ timeout: 2000 });
    await tv.page.locator(`[data-view="personal:${source}"] .browse-card`).first().waitFor();
}
test("Details return discards an abandoned personal-page turn", async () => {
    const { tv } = await setup();
    try {
        await openList(tv, "watchlist");
        await tv.page.locator('[data-focus="next"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByText("Page 2 of 3", { exact: true }).waitFor();
        const held = tv.fake.hold("/catalog/query", true);
        await tv.page.locator('[data-focus="next"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => tv.fake.requests.filter(r => r.path.startsWith("/catalog/query")).length === 3, "pending third page");
        await tv.page.keyboard.press("ArrowUp");
        await tv.page.keyboard.press("ArrowRight");
        assert.equal(await tv.focused(), "movie:m0026");
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-view="item:movie:m0026"]').waitFor();
        await tv.remote(10009);
        const cached = await tv.page.locator('.browse [data-focus="movie:m0026"]').elementHandle();
        assert.ok(cached);
        held.release();
        await tv.eventually(async () => await cached.evaluate(node => !node.isConnected), "personal-page refresh rendered");
        assert.equal(await tv.page.getByText("Page 2 of 3", { exact: true }).count(), 1);
        assert.equal(await tv.focused(), "movie:m0026");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const source of ["watchlist", "favorites"]) test(`integrated Details removes ${source} membership without changing the other list`, async () => {
    const { tv, catalog } = await setup();
    try {
        await openList(tv, source);
        for (let page = 2; page <= 3; page++) {
            await tv.page.locator('[data-focus="next"]').click();
            await tv.page.getByText(`Page ${page} of 3`, { exact: true }).waitFor();
        }
        await tv.page.locator('.browse [data-focus="movie:m0050"]').click();
        await tv.page.locator('[data-view="item:movie:m0050"]').waitFor();
        const remove = tv.page.getByRole("button", { name: source === "favorites" ? "Remove favorite" : "Remove from watchlist", exact: true });
        await tv.eventually(async () => await remove.count() === 1, "Details exposes authoritative list membership");
        const held = tv.fake.hold(`/${source}/movie%3Am0050/membership`, true);
        await remove.click();
        await tv.eventually(async () => catalog.mutations.length === 1, "Details removal committed");
        assert.equal(await tv.page.locator(`[data-focus="${source}"]`).getAttribute("aria-disabled"), "true");
        held.release();
        await tv.page.getByRole("button", { name: source === "favorites" ? "Add favorite" : "Add to watchlist", exact: true }).waitFor();
        await tv.remote(10009);
        await tv.eventually(async () => await tv.page.locator('.browse [data-focus="movie:m0050"]').count() === 0, "confirmed removal reconciles the current page");
        assert.equal(await tv.page.getByText("Page 3 of 3", { exact: true }).count(), 1);
        assert.equal(await tv.focused(), "movie:m0051");
        assert.equal(catalog.mutations.length, 1);
        await tv.page.locator('[data-focus="back"]').click();
        await tv.page.locator('[data-view="home"]').waitFor();
        await openList(tv, source === "watchlist" ? "favorites" : "watchlist");
        for (let page = 2; page <= 3; page++) {
            await tv.page.locator('[data-focus="next"]').click();
            await tv.page.getByText(`Page ${page} of 3`, { exact: true }).waitFor();
        }
        assert.equal(await tv.page.locator('.browse [data-focus="movie:m0050"]').count(), 1);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const removed of [false, true]) test(`later-page Details return ${removed ? "removes the item with nearby fallback" : "keeps unchanged page and identity"}`, async () => {
    const { tv, catalog } = await setup();
    try {
        await openList(tv, "watchlist");
        for (let index = 2; index <= 3; index++) {
            await tv.page.locator('[data-focus="next"]').click();
            await tv.page.getByText(`Page ${index} of 3`, { exact: true }).waitFor();
        }
        await tv.page.locator('.browse [data-focus="movie:m0050"]').click();
        await tv.page.locator('[data-view="item:movie:m0050"]').waitFor();
        if (removed) catalog.excluded.add("movie:m0050");
        const held = tv.fake.hold("/catalog/query", true);
        await tv.remote(10009);
        assert.equal(await tv.focused(), "movie:m0050");
        held.release();
        await tv.eventually(async () => tv.fake.requests.filter(r => r.path.startsWith("/catalog/query")).length >= 4, "refresh sent");
        await tv.page.waitForTimeout(200);
        assert.equal(await tv.page.getByText("Page 3 of 3", { exact: true }).count(), 1);
        assert.equal(await tv.focused(), removed ? "movie:m0051" : "movie:m0050");
        assert.equal(await tv.page.locator('.browse [data-focus="movie:m0050"]').count(), removed ? 0 : 1);
    } finally { await tv.page.context().close(); }
});
test("personal destinations page on the server, restore Details focus and reconcile changed membership", async () => {
    const { tv, catalog } = await setup();
    try {
        for (const source of ["watchlist", "favorites", "history"]) {
            await openList(tv, source);
            assert.equal(await tv.page.locator(".browse .browse-card").count(), 24);
            const reads = tv.fake.requests.length;
            await tv.page.locator(".browse .browse-card").first().focus();
            await tv.page.keyboard.press("ArrowRight");
            assert.equal(tv.fake.requests.length, reads);
            await tv.page.locator('[data-focus="next"]').click();
            await tv.page.getByText("Page 2 of 3", { exact: true }).waitFor();
            const id = await tv.page.locator(".browse .browse-card").first().getAttribute("data-focus");
            await tv.page.locator(".browse .browse-card").first().click();
            await tv.page.locator('[data-view^="item:movie:"]').waitFor();
            await tv.remote(10009);
            await tv.page.getByText("Page 2 of 3", { exact: true }).waitFor();
            await tv.eventually(async () => await tv.focused() === id, "unchanged later page identity");
            assert.ok(id);
            await tv.page.locator(".browse .browse-card").first().click();
            await tv.page.locator('[data-view^="item:movie:"]').waitFor();
            catalog.excluded.add(id);
            await tv.remote(10009);
            await tv.eventually(async () => await tv.page.locator(`.browse-card[data-focus="${id}"]`).count() === 0, "membership refresh");
            catalog.excluded.clear();
            await tv.page.locator('[data-focus="back"]').click();
            await tv.page.locator('[data-view="home"]').waitFor();
            assert.equal(await tv.focused(), "profiles");
        }
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Favorites filters the whole result before paging and retains opaque continuation", async () => {
    const { tv } = await setup();
    try {
        await openList(tv, "favorites");
        const seen: string[] = [];
        for (let page = 1; page <= 3; page++) {
            await tv.page.getByText(`Page ${page} of 3`, { exact: true }).waitFor();
            seen.push(...await tv.page.locator(".browse .browse-card").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus") ?? "")));
            if (page < 3) await tv.page.locator('[data-focus="next"]').click();
        }
        assert.equal(new Set(seen).size, 60);
        assert.ok(seen.every(id => id.startsWith("movie:")));
        await tv.page.locator('[data-focus="filter:series"]').click();
        await tv.eventually(async () => await tv.page.locator(".browse .browse-card").count() === 3, "server series filter");
        assert.deepEqual(await tv.page.locator(".browse .browse-card").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["series:s1", "series:s2", "series:s3"]);
        const query = tv.fake.requests.filter(r => r.path.startsWith("/catalog/query")).pop();
        assert.equal(query?.body?.type, "series");
        assert.equal(query?.body?.cursor, undefined);
        assert.equal(await tv.focused(), "filter:series");
    } finally { await tv.page.context().close(); }
});

test("failed subsequent page retains rows and cursor; retry retries that page; invalid cursor restarts", async () => {
    const { tv, catalog } = await setup();
    try {
        await openList(tv, "watchlist");
        catalog.pageReplies.push(problem(503, "service_unavailable", "Unavailable"), problem(503, "service_unavailable", "Unavailable"));
        await tv.page.locator('[data-focus="next"]').click();
        await tv.jump(1000);
        await tv.page.locator('[data-focus="retry"]').waitFor();
        assert.equal(await tv.page.locator(".browse .browse-card").count(), 24);
        assert.equal(await tv.page.locator(".browse .browse-card").first().getAttribute("data-focus"), "movie:m0001");
        await tv.page.locator('[data-focus="retry"]').click();
        await tv.page.getByText("Page 2 of 3", { exact: true }).waitFor();
        assert.equal(await tv.page.locator(".browse .browse-card").first().getAttribute("data-focus"), "movie:m0025");
        assert.equal(tv.fake.requests.filter(r => r.path.startsWith("/catalog/query")).pop()?.body?.cursor, "p-owner:watchlist:video:24");
        catalog.pageReplies.push(problem(400, "invalid_cursor", "Invalid cursor"));
        await tv.page.locator('[data-focus="next"]').click();
        await tv.page.locator('[data-focus="retry"]').waitFor();
        await tv.page.locator('[data-focus="retry"]').click();
        await tv.page.getByText("Page 1 of 3", { exact: true }).waitFor();
        assert.equal(tv.fake.requests.filter(r => r.path.startsWith("/catalog/query")).pop()?.body?.cursor, undefined);
    } finally { await tv.page.context().close(); }
});

test("capability failures are retryable errors, unsupported is explicit, empty remains navigable", async () => {
    const { tv, catalog } = await setup();
    try {
        catalog.capabilityReplies.push({ status: 200, body: { allowed: true } });
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="watchlist"]').click();
        await tv.page.getByText("The server sent an answer this TV could not read.").waitFor();
        assert.equal(tv.fake.requests.filter(r => r.path.startsWith("/catalog/query")).length, 0);
        catalog.unavailable = true;
        await tv.page.locator('[data-focus="retry"]').click();
        await tv.page.getByText("Watchlist is unavailable.").waitFor();
        await tv.page.locator('[data-focus="back"]').click();
        catalog.unavailable = false;
        for (const id of catalog.titles.keys()) catalog.excluded.add(id);
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="watchlist"]').click();
        await tv.page.getByText("No watchlist", { exact: true }).waitFor();
        assert.equal(await tv.focused(), "back");
    } finally { await tv.page.context().close(); }
});

test("profile change drops late personal answers and PIN-scopes the replacement list", async () => {
    const { tv } = await setup();
    try {
        const held = tv.fake.hold("/catalog/query", true);
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="history"]').click();
        await tv.eventually(async () => tv.fake.requests.some(r => r.path.startsWith("/catalog/query")), "held personal read");
        await tv.page.evaluate(() => window.browseHarness.clearProfile());
        held.release();
        await tv.jump(0);
        assert.equal(await tv.page.locator(".browse").count(), 0);
        assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-kid", "2468")), "verified");
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-view="home"]').waitFor();
        await openList(tv, "watchlist");
        assert.equal(await tv.page.locator(".browse .browse-card").count(), 8);
        const read = tv.fake.requests.filter(r => r.path.startsWith("/catalog/query")).pop();
        assert.equal(read?.headers["x-profile-id"], "p-kid");
        assert.ok(read?.headers["x-profile-token"]?.startsWith("pvt-"));
        assert.ok((await tv.page.locator(".browse .browse-card").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-focus") ?? ""))).every(id => id.startsWith("movie:k")));
    } finally { await tv.page.context().close(); }
});

test("remote personal journey keeps scrolled focus visible with Reduced Motion and restores Details identity", async () => {
    const { tv } = await setup(true);
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        const step = async (key: string): Promise<void> => {
            await tv.page.keyboard.press(key);
            if (process.env.PERSONAL_VIDEO !== undefined) await tv.page.waitForTimeout(350);
        };
        await step("ArrowUp");
        for (let i = 0; i < 4; i++) await step("ArrowRight");
        await step("Enter");
        const output = process.env.PERSONAL_CAPTURE;
        if (output !== undefined) {
            await mkdir(output, { recursive: true });
            await tv.page.screenshot({ path: `${output}/profile-after.png` });
        }
        await step("ArrowDown");
        await step("ArrowDown");
        assert.equal(await tv.focused(), "watchlist");
        await step("Enter");
        await tv.page.locator('[data-view="personal:watchlist"] .browse-card').first().waitFor();
        if (output !== undefined) await tv.page.screenshot({ path: `${output}/watchlist.png` });
        for (let i = 0; i < 3; i++) await step("ArrowDown");
        for (let i = 0; i < 5; i++) await step("ArrowRight");
        assert.equal(await tv.focused(), "movie:m0024");
        const focus = await tv.page.evaluate(() => {
            const rect = document.activeElement?.getBoundingClientRect();
            return { top: rect?.top ?? -1, bottom: rect?.bottom ?? 2000, transition: getComputedStyle(document.activeElement ?? document.body).transitionDuration };
        });
        assert.ok(focus.top >= 0 && focus.bottom <= 1080, JSON.stringify(focus));
        assert.ok(focus.transition.split(",").every(s => s.trim() === "0s"));
        if (output !== undefined) await tv.page.screenshot({ path: `${output}/watchlist-scrolled.png` });
        await step("Enter");
        await tv.page.locator('[data-view="item:movie:m0024"]').waitFor();
        await tv.remote(10009);
        await tv.page.locator('[data-view="personal:watchlist"] .browse-card').first().waitFor();
        await tv.eventually(async () => await tv.focused() === "movie:m0024", "restored card identity");
        assert.equal(await tv.page.locator(".browse .browse-card").count(), 24);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("History includes episodes and cached Details return remains visible during reconciliation", async () => {
    const { tv } = await setup();
    try {
        await openList(tv, "history");
        assert.equal(tv.fake.requests.filter(r => r.path.startsWith("/catalog/query")).pop()?.body?.type, "video");
        await tv.page.locator('.browse [data-focus="movie:m0002"]').click();
        await tv.page.locator('[data-view="item:movie:m0002"]').waitFor();
        const held = tv.fake.hold("/catalog/query", true);
        await tv.remote(10009);
        await tv.page.locator('[data-view="personal:history"]').waitFor();
        assert.equal(await tv.page.locator(".browse .browse-card").count(), 24);
        assert.equal(await tv.focused(), "movie:m0002");
        held.release();
        await tv.page.getByText("Page 1 of 3", { exact: true }).waitFor();
        for (let page = 2; page <= 3; page++) {
            await tv.page.locator('.browse [data-focus="next"]').click();
            await tv.page.getByText(`Page ${page} of 3`, { exact: true }).waitFor();
        }
        assert.ok(await tv.page.locator('.browse .browse-card[data-focus^="series:"]').count() > 0);
        await tv.page.getByRole("button", { name: "Episodes", exact: true }).click();
        await tv.eventually(async () => await tv.page.locator('.browse .browse-card[data-focus^="episode:"]').count() > 0, "episode scope");
        assert.equal(tv.fake.requests.filter(r => r.path.startsWith("/catalog/query")).pop()?.body?.type, "episode");
        assert.equal(tv.fake.requests.filter(r => r.path.startsWith("/catalog/query")).pop()?.body?.cursor, undefined);
        assert.ok(await tv.page.locator('.browse .browse-card[data-focus^="episode:"]').count() > 0);
        await tv.page.locator('.browse .browse-card[data-focus^="episode:"]').first().click();
        await tv.page.locator('[data-view^="item:episode:"]').waitFor();
        await tv.remote(10009);
        await tv.page.locator('[data-view="personal:history"]').waitFor();
    } finally { await tv.page.context().close(); }
});
