import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowseCache, clearBrowseCache } from "../../src/session/browseCache.ts";
import { ApiError } from "../../src/api/errors.ts";
import type { RequestSpec } from "../../src/api/http.ts";
import { connected, signIn } from "./support/harness.ts";
import { DetailsState } from "../../src/ui/detailsState.ts";
import { decodeItemDetail } from "../../src/contracts/v2/catalog.ts";
import { fixture } from "./support/fakeSilo.ts";
import { settle } from "./support/clock.ts";
import type { NativeSession } from "../../src/session/session.ts";
import { writeMayHaveApplied } from "../../src/ui/browseRoutes.ts";

const spec: RequestSpec<unknown> = { method: "GET", path: "/home/sections", retry: "safe", decode: value => value };
const offline = async (): Promise<never> => { throw new ApiError({ kind: "network" }); };
function storage() {
    const values = new Map<string, string>();
    return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const scope = ["server", "account", "profile"] as const;
test("session artwork URLs survive fallback while persisted snapshots omit them", async () => {
    const store = storage();
    const cache = new BrowseCache(store, scope, new AbortController().signal);
    const artwork = { poster_url: "https://image.invalid/poster?signature=session", backdrop_url: "https://image.invalid/backdrop", series_backdrop_url: "/series?signature=session", local_extras: [{ still_url: "/extra?signature=session" }], logo_url: "/logo?signature=session", cast: [{ photo_url: "https://image.invalid/portrait?signature=session" }] };
    for (const path of ["/home/sections", "/catalog/items/movie", "/catalog/items/series"]) {
        const request = { ...spec, path };
        await cache.read(request, async read => read.decode(artwork));
        assert.deepEqual(await cache.read(request, offline), artwork);
    }
    assert.doesNotMatch([...store.values.values()].join(), /signature|https:/);
    assert.deepEqual(new BrowseCache(store, scope, new AbortController().signal).peek(spec), { local_extras: [{}], cast: [{}] });
});

test("restored next episode remains available during failed offline revalidation", async () => {
    const episode = { ...decodeItemDetail(fixture("get_catalog_item_ok")), id: "episode:one", type: "episode" as const };
    const detail = { ...episode, id: "series:one", type: "series" as const, playContentId: episode.id };
    let reply: "offline" | "fresh" | "denied" = "offline";
    const session = { onAuthorityChange: () => () => {}, call: async <T>(spec: RequestSpec<T>): Promise<T> => {
        if (spec.path.startsWith("/catalog/items/episode")) {
            if (reply === "fresh") return { ...episode, title: "Fresh episode" } as T;
            if (reply === "denied") throw new ApiError({ kind: "http", status: 403, retryAfterSeconds: undefined });
        }
        return offline();
    } } as unknown as NativeSession;
    const prior = new DetailsState(detail, session, () => {}, async () => {});
    prior.nextEpisode = episode;
    prior.nextEpisodeState = new DetailsState(episode, session, () => {}, async () => {});
    const state = new DetailsState(detail, session, () => {}, async () => {});
    state.restore(prior);
    state.start();
    await settle();
    assert.equal(state.nextEpisode?.id, episode.id);
    assert.equal(state.nextEpisodeState?.detail.id, episode.id);
    assert.equal(state.nextEpisodeFailed, false);
    reply = "fresh";
    state.acceptDetail(detail);
    await settle();
    assert.equal(state.nextEpisode?.title, "Fresh episode");
    reply = "denied";
    state.acceptDetail(detail);
    await settle();
    assert.equal(state.nextEpisode, undefined, "a server refusal removes usable cached playback");
    assert.equal(state.nextEpisodeFailed, true);
    state.stop();
});

test("refresh transport failure leaves a mutation definitely unsent and retryable", async () => {
    const h = await connected(); await signIn(h);
    await h.clock.advance(3600 * 1000);
    h.fake.dropNextAnswer("/auth/refresh");
    await assert.rejects(h.core.session.call({ ...spec, method: "POST", retry: "never", path: "/unsent-write", profileScoped: false }), error => {
        assert.equal(error instanceof ApiError && error.failure.kind, "network");
        assert.equal(writeMayHaveApplied(error), false);
        return true;
    });
    assert.equal(h.fake.requests.filter(request => request.path === "/unsent-write").length, 0);
    assert.equal(h.core.session.signedIn, true);
});
test("retiring A after B caches content preserves B's snapshot and fences A's held read", async () => {
    const h = await connected(); await signIn(h);
    const store = h.storage;
    const aScope = [h.core.server.serverId, h.core.session.account!.id, "profile"];
    const a = new BrowseCache(store, aScope, h.core.session.authoritySignal);
    await a.read(spec, async request => request.decode({ title: "A private" }));
    let finish = (): void => {};
    const held = a.read(spec, async request => { await new Promise<void>(resolve => { finish = resolve; }); return request.decode({ title: "A late" }); });
    const bScope = [h.core.server.serverId, "B", "profile"];
    const b = new BrowseCache(store, bScope, new AbortController().signal);
    assert.equal(b.peek(spec), undefined);
    await assert.rejects(b.read(spec, offline));
    await b.read(spec, async request => request.decode({ title: "B private" }));
    await h.core.session.logout(); finish(); await held;
    assert.deepEqual(new BrowseCache(store, bScope, new AbortController().signal).peek(spec), { title: "B private" });
    assert.deepEqual(await b.read(spec, offline), { title: "B private" });
});
test("Details reads touch LRU order and retain relative artwork in memory", async () => {
    const cache = new BrowseCache(undefined, scope, new AbortController().signal);
    const item = (id: number): RequestSpec<unknown> => ({ ...spec, path: `/catalog/items/${id}` });
    for (let id = 0; id < 20; id++) await cache.read(item(id), async request => request.decode({ poster_url: "/api/v2/images/poster" }));
    assert.deepEqual(cache.peek(item(0)), { poster_url: "/api/v2/images/poster" });
    await cache.read(item(20), async request => request.decode({}));
    assert.ok(cache.peek(item(0)));
    assert.equal(cache.peek(item(1)), undefined);
});
test("Details LRU touches protect a visited title from the next insertion", async () => {
    const cache = new BrowseCache(undefined, scope, new AbortController().signal);
    const item = (id: number): RequestSpec<unknown> => ({ ...spec, path: `/catalog/items/${id}` });
    for (let id = 0; id < 20; id++) await cache.read(item(id), async request => request.decode(id));
    assert.equal(cache.peek(item(0)), 0);
    await cache.read(item(20), async request => request.decode(20));
    assert.equal(cache.peek(item(0)), 0);
    assert.equal(cache.peek(item(1)), undefined);
});
test("enrichment transport failures cannot displace Home recovery", async () => {
    const cache = new BrowseCache(undefined, scope, new AbortController().signal);
    await cache.read(spec, async request => request.decode({}));
    await cache.read(spec, offline);
    for (let id = 0; id < 40; id++) await assert.rejects(cache.read({ ...spec, path: `/catalog/items/${id}` }, offline));
    assert.equal(cache.isOffline(spec), true);
});
test("recovery drops a removed version selection", async () => {
    const h = await connected(); await signIn(h);
    const detail = decodeItemDetail(fixture("get_catalog_item_ok"));
    const state = new DetailsState(detail, h.core.session, () => {}, async () => {});
    state.selectedFileId = "removed-file";
    state.acceptDetail(detail);
    assert.equal(state.selectedFileId, undefined);
});
test("cached responses survive a new owner, remain available offline and recover", async () => {
    const store = storage();
    const cache = new BrowseCache(store, scope, new AbortController().signal);
    await cache.read(spec, async request => request.decode({ title: "Saved" }));
    const restored = new BrowseCache(store, scope, new AbortController().signal);
    assert.deepEqual(restored.peek(spec), { title: "Saved" });
    assert.deepEqual(await restored.read(spec, offline), { title: "Saved" });
    assert.equal(restored.offline, true);
    await restored.read(spec, async request => request.decode({ title: "Fresh" }));
    assert.equal(restored.offline, false);
    assert.deepEqual(restored.peek(spec), { title: "Fresh" });
});
test("server, account and profile each isolate content", async () => {
    for (const dimension of [0, 1, 2]) {
        const store = storage();
        const cache = new BrowseCache(store, scope, new AbortController().signal);
        await cache.read(spec, async request => request.decode({ title: "Private" }));
        const other: string[] = [...scope]; other[dimension] = "other";
        const changed = new BrowseCache(store, other, new AbortController().signal);
        assert.equal(changed.peek(spec), undefined);
        assert.equal(new BrowseCache(store, scope, new AbortController().signal).peek(spec), undefined);
    }
});
test("authority end clears snapshots and fences late answers, including sign-out", async () => {
    const store = storage(); const authority = new AbortController();
    const cache = new BrowseCache(store, scope, authority.signal);
    await cache.read(spec, async request => request.decode({ title: "Private" }));
    let finish: (() => void) | undefined;
    const late = cache.read(spec, async request => { await new Promise<void>(resolve => { finish = resolve; }); return request.decode({ title: "Late" }); });
    authority.abort(); finish?.(); await late;
    assert.equal(cache.peek(spec), undefined);
    assert.equal(new BrowseCache(store, scope, new AbortController().signal).peek(spec), undefined);
});
test("account removal clears snapshots", async () => {
    const store = storage(); const cache = new BrowseCache(store, scope, new AbortController().signal);
    await cache.read(spec, async request => request.decode({ title: "Private" }));
    clearBrowseCache(store);
    assert.equal(cache.peek(spec), undefined);
    assert.equal(new BrowseCache(store, scope, new AbortController().signal).peek(spec), undefined);
});
test("snapshots omit credentials and signed URLs, and details stay in memory", async () => {
    const store = storage(); const cache = new BrowseCache(store, scope, new AbortController().signal);
    const value = { title: "Safe", poster_url: "https://image.invalid/poster?signature=private", access_token: "private", nested: { url: "https://image.invalid/private" } };
    await cache.read(spec, async request => request.decode(value));
    assert.doesNotMatch([...store.values.values()].join(), /private|https:/);
    assert.deepEqual(cache.peek(spec), { title: "Safe", poster_url: value.poster_url, nested: {} });
    const detail = { ...spec, path: "/catalog/items/movie?image_size=large" };
    await cache.read(detail, async request => request.decode({ title: "Detail" }));
    assert.deepEqual(cache.peek(detail), { title: "Detail" });
    assert.equal(new BrowseCache(store, scope, new AbortController().signal).peek(detail), undefined);
});
test("cache is bounded and optional storage failure never breaks reads", async () => {
    const broken = { getItem: () => { throw Error("denied"); }, setItem: () => { throw Error("quota"); }, removeItem: () => { throw Error("denied"); } };
    const cache = new BrowseCache(broken, scope, new AbortController().signal);
    await cache.read(spec, async request => request.decode({ title: "Saved" }));
    assert.deepEqual(await cache.read(spec, offline), { title: "Saved" });
    for (let index = 0; index < 40; index++) await cache.read({ ...spec, path: `/catalog/items/${index}` }, async request => request.decode(index));
    assert.equal(cache.peek({ ...spec, path: "/catalog/items/0" }), undefined);
    assert.equal(cache.peek({ ...spec, path: "/catalog/items/39" }), 39);
    await cache.read(spec, async request => request.decode("x".repeat(2 * 1024 * 1024)));
    assert.equal(cache.peek(spec), undefined);
});
test("HTTP failures, cancellation and uncached operations never use fallback", async () => {
    const cache = new BrowseCache(undefined, scope, new AbortController().signal);
    await cache.read(spec, async request => request.decode({ title: "Saved" }));
    for (const failure of [{ kind: "http", status: 403, retryAfterSeconds: undefined }, { kind: "aborted" }] as const) {
        await assert.rejects(cache.read(spec, async () => { throw new ApiError(failure); }));
    }
    await assert.rejects(cache.read({ ...spec, method: "POST" }, offline));
});

test("a successful sibling request cannot hide a response still using fallback", async () => {
    const cache = new BrowseCache(undefined, scope, new AbortController().signal);
    await cache.read(spec, async request => request.decode({ title: "Saved" }));
    await cache.read(spec, offline);
    await cache.read({ ...spec, path: "/user/libraries" }, async request => request.decode([]));
    assert.equal(cache.offline, true);
    await cache.read(spec, async request => request.decode({ title: "Fresh" }));
    assert.equal(cache.offline, false);
});

test("metadata invalidation fences older reads and rejects malformed optional snapshots", async () => {
    const store = storage(); const cache = new BrowseCache(store, scope, new AbortController().signal);
    let finish: (() => void) | undefined;
    const pending = cache.read(spec, async request => { await new Promise<void>(resolve => { finish = resolve; }); return request.decode({ title: "Old" }); });
    cache.invalidate(); finish?.(); await pending;
    assert.equal(cache.peek(spec), undefined);
    store.setItem("silo.browseSnapshots.v1", "invalid json");
    const restored = new BrowseCache(store, scope, new AbortController().signal);
    assert.equal(restored.peek(spec), undefined);
    assert.equal(store.values.size, 0);
});

test("Details access refusals discard the previously cached response", async () => {
    const cache = new BrowseCache(undefined, scope, new AbortController().signal);
    const detail = { ...spec, path: "/catalog/items/movie" };
    for (const status of [403, 404]) {
        await cache.read(detail, async request => request.decode({ title: "Saved" }));
        await assert.rejects(cache.read(detail, async () => { throw new ApiError({ kind: "http", status, retryAfterSeconds: undefined }); }));
        assert.equal(cache.peek(detail), undefined);
    }
});

test("an HTTP refusal durably removes a persisted snapshot", async () => {
    const store = storage(); const cache = new BrowseCache(store, scope, new AbortController().signal);
    await cache.read(spec, async request => request.decode({ title: "Private" }));
    await assert.rejects(cache.read(spec, async () => { throw new ApiError({ kind: "http", status: 403, retryAfterSeconds: undefined }); }));
    assert.equal(new BrowseCache(store, scope, new AbortController().signal).peek(spec), undefined);
});

test("expired credentials still permit cached fallback when refresh cannot reach the server", async () => {
    const h = await connected(); await signIn(h);
    h.core.session.setProfile({ id: "p-owner", token: "proof" }, "profile_selected");
    const cache = new BrowseCache(h.storage, scope, h.core.session.authoritySignal);
    await cache.read(spec, async request => request.decode({ title: "Saved" }));
    await h.clock.advance(3600 * 1000);
    h.fake.script("/auth/refresh", { status: 503, body: {} });
    h.fake.dropNextAnswer("/auth/refresh");
    const value = await cache.read(spec, request => h.core.session.call({ ...request, profileScoped: true }));
    assert.deepEqual(value, { title: "Saved" });
    assert.equal(cache.offline, true);
});

test("fresh series metadata resets next-episode state owned by the cached play target", async () => {
    const h = await connected(); await signIn(h);
    const detail = { ...decodeItemDetail(fixture("get_catalog_item_ok")), type: "series" as const, playContentId: "episode:old" };
    const state = new DetailsState(detail, h.core.session, () => {}, async () => {});
    state.nextEpisode = { ...detail, id: "episode:old", type: "episode" };
    state.nextEpisodeLoading = true;
    state.nextEpisodeFailed = true;
    state.acceptDetail({ ...detail, playContentId: "episode:new" });
    assert.equal(state.nextEpisode, undefined);
    assert.equal(state.nextEpisodeLoading, false);
    assert.equal(state.nextEpisodeFailed, false);
});
