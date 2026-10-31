import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import type { RequestSpec } from "../../src/api/http.ts";
import { requestsOperations as api } from "../../src/api/requestsOperations.ts";
import { decodeDiscoverSections, decodeMediaRequest, decodeMediaRequestPage, decodeRequestMediaDetail, decodeRequestMediaPage, decodeRequestStatus, requestsAvailable } from "../../src/contracts/v2/requests.ts";
import { WireError } from "../../src/contracts/v2/wire.ts";
import {
    actionFailure, applyRequests, createBody, mediaStateLabel, nextProviderPage, providerPages, readRequests, requestChoices, RequestsUnavailable, sendRequestAction, turnProviderPage, unavailableAnswer,
} from "../../src/ui/requestsState.ts";
import { FakeRequests } from "./support/fakeRequests.ts";
import { fixture, problem } from "./support/fakeSilo.ts";
import { connected, signIn } from "./support/harness.ts";

test("vendored Requests fixtures decode exactly", () => {
    const status = decodeRequestStatus(fixture("request_status_ok"));
    assert.deepEqual(status, { revision: "9c237d932443dc27a6808f2714b19c1ac949c62fccbe0bfb557ddcb54629b583", state: "available", allowed: true, requestsEnabled: true, followSupported: true, discoverRowsSupported: true });
    assert.equal(requestsAvailable(status), true);
    for (const off of [{ state: "disabled" }, { allowed: false }, { requests_enabled: false }, { state: "brand_new" }]) {
        assert.equal(requestsAvailable(decodeRequestStatus({ ...fixture("request_status_ok"), ...off })), false);
    }
    assert.equal(decodeRequestStatus({ ...fixture("request_status_ok"), state: "brand_new" }).state, "unknown");
    const mine = decodeMediaRequestPage(fixture("list_my_requests_ok"));
    assert.deepEqual(mine.items.map(item => [item.id, item.state, item.download?.percent]), [["r-2", "pending", undefined], ["r-1", "processing", 43]]);
    assert.equal(mine.nextCursor, undefined);
    assert.equal(decodeMediaRequest(fixture("create_request_ok")).id, "r-new");
    assert.equal(decodeMediaRequest(fixture("cancel_request_ok")).state, "approved");
});

test("Requests decoders reject malformed consumed members without echoing values", () => {
    const status = fixture("request_status_ok");
    for (const broken of [{ allowed: "yes" }, { revision: undefined }, { follow_supported: undefined }, { state: 1 }]) {
        assert.throws(() => decodeRequestStatus({ ...status, ...broken }), WireError);
    }
    assert.throws(() => decodeMediaRequestPage({ items: [], page: { has_more: true } }), /next_cursor/);
    assert.throws(() => decodeMediaRequestPage({ items: [], page: { has_more: true, next_cursor: "" } }), /next_cursor/);
    assert.equal(decodeMediaRequestPage({ items: [], page: { has_more: false, next_cursor: "" } }).nextCursor, undefined, "has_more decides, as in the catalog decoder");
    const request = fixture("list_my_requests_ok").items as Record<string, unknown>[];
    assert.throws(() => decodeMediaRequest({ ...request[1], download: { ...(request[1]?.download as object), percent: 101 } }), WireError);
    assert.throws(() => decodeMediaRequest({ ...request[0], targets: null }), WireError);
    const result = { media_type: "film", tmdb_id: 7, title: "X", availability: "missing", in_watchlist: false, request: { requestable: true, following: false, requested_by_viewer: false } };
    assert.equal(decodeRequestMediaPage({ page: 1, total_pages: 1, results: [result] }).results[0]?.mediaType, "unknown", "media types are additive");
    assert.throws(() => decodeRequestMediaPage({ page: 0, total_pages: 1, results: [] }), WireError);
    assert.throws(() => decodeRequestMediaPage({ page: 1, total_pages: 1, results: [{ ...result, tmdb_id: 0 }] }), WireError);
    assert.throws(() => decodeRequestMediaPage({ page: 1, total_pages: 1, results: [{ ...result, in_watchlist: undefined }] }), WireError);
    assert.throws(() => decodeDiscoverSections({ items: [] }), /row_order/);
    const detail = { ...result, media_type: "movie", genres: ["Drama"], production_companies: [], networks: [], cast: [], creators: [], recommendations: [], seasons: [] };
    assert.equal(decodeRequestMediaDetail(detail).genres[0], "Drama");
    assert.throws(() => decodeRequestMediaDetail({ ...detail, cast: undefined }), WireError);
    assert.throws(() => decodeRequestMediaDetail({ ...detail, seasons: [{ season_number: 1, episode_count: 2, availability: "missing" }] }), WireError);
    try { decodeRequestStatus({ ...status, revision: "secret-token-value", allowed: "secret-token-value" }); }
    catch (error) { assert.ok(error instanceof WireError && !error.message.includes("secret")); }
});

test("operation paths, methods and retry classes match the pinned contract", () => {
    const specs = [
        [api.requestStatus(), "GET", "/requests/status", "safe"],
        [api.discover(), "GET", "/requests/discover", "safe"],
        [api.discoverRow("trending_movies", 2), "GET", "/requests/discover/trending_movies?page=2", "safe"],
        [api.discoverRow("r_cozy", 1), "GET", "/requests/discover/rows/r_cozy?page=1", "safe"],
        [api.brands("networks"), "GET", "/requests/discover/networks", "safe"],
        [api.browseBrand({ kind: "genres", slug: "sci fi", mediaType: "series" }, 3), "GET", "/requests/discover/browse/genre/sci%20fi?media_type=series&page=3", "safe"],
        [api.browseBrand({ kind: "studios", slug: "a/b" }, 1), "GET", "/requests/discover/browse/studio/a%2Fb?page=1", "safe"],
        [api.browseBrand({ kind: "networks", slug: "hbo" }, 1), "GET", "/requests/discover/browse/network/hbo?page=1", "safe"],
        [api.search(" heat & dust ", 1), "GET", "/requests/search?q=heat%20%26%20dust&page=1", "safe"],
        [api.detail("series", 1399), "GET", "/requests/detail/series/1399", "safe"],
        [api.mine(undefined), "GET", "/requests/mine?limit=24", "safe"],
        [api.mine("a+/="), "GET", "/requests/mine?limit=24&cursor=a%2B%2F%3D", "safe"],
        [api.create({ media_type: "movie", tmdb_id: 7, title: "X" }), "POST", "/requests", "never"],
        [api.cancel("r/1"), "POST", "/requests/r%2F1/cancel", "never"],
        [api.follow("movie", 7), "PUT", "/requests/follows/movie/7", "never"],
        [api.unfollow("movie", 7), "DELETE", "/requests/follows/movie/7", "never"],
    ] as const;
    for (const [spec, method, path, retry] of specs) assert.deepEqual([spec.method, spec.path, spec.retry], [method, path, retry]);
    assert.deepEqual(api.cancel("r-1").body, {});
    for (const bad of [() => api.discoverRow("Bad-Row", 1), () => api.discoverRow("trending_movies", 0), () => api.search(" ", 1), () => api.search("x", 501), () => api.detail("movie", 0), () => api.cancel("")]) assert.throws(bad, RangeError);
});

test("provider pages follow next_page, stop at the reported end and TMDB's page 500", () => {
    const page = (current: number, total: number, nextPage?: number) => ({ page: current, totalPages: total, nextPage, results: [] });
    assert.equal(nextProviderPage(page(1, 3)), 2);
    assert.equal(nextProviderPage(page(1, 3, 3)), 3);
    assert.equal(nextProviderPage(page(2, 3, 4)), undefined, "next_page past total_pages ends the row");
    assert.equal(nextProviderPage(page(3, 3)), undefined);
    assert.equal(nextProviderPage(page(500, 900)), undefined);
    const pages = providerPages();
    assert.equal(turnProviderPage(pages, 1), false, "nothing shown yet");
    pages.data = page(1, 3, 3);
    assert.equal(turnProviderPage(pages, 1), true);
    assert.equal(turnProviderPage(pages, 1), false, "one turn at a time");
    applyRequests({ screen: "search", submitted: "x", pages }, { screen: "search", data: page(3, 3) });
    assert.deepEqual(pages.previous, [1]);
    assert.equal(turnProviderPage(pages, -1), true);
    assert.deepEqual(pages.want, { page: 1, previous: [] });
});

test("labels and offered writes follow request state and the follow capability", () => {
    const status = decodeRequestStatus(fixture("request_status_ok"));
    const base = { mediaType: "movie" as const, tmdbId: 7, title: "X", year: 2001, overview: "o", posterPath: "/p.jpg", backdropPath: undefined, availability: "missing", libraryContentId: undefined, tvdbId: undefined, genres: [], runtime: undefined, tagline: undefined, contentRating: undefined, seasons: [] };
    const state = { requestable: true, following: false, requestedByViewer: false, reason: undefined, requestId: undefined, state: undefined, status: undefined, download: undefined };
    assert.deepEqual(requestChoices({ ...base, request: state }, status), { request: true, cancel: false, follow: false, unfollow: false });
    const other = { ...state, requestable: false, requestId: "r", state: "approved", status: "approved" };
    assert.deepEqual(requestChoices({ ...base, request: other }, status), { request: false, cancel: false, follow: true, unfollow: false });
    assert.deepEqual(requestChoices({ ...base, request: { ...other, following: true } }, status), { request: false, cancel: false, follow: false, unfollow: true });
    assert.deepEqual(requestChoices({ ...base, request: other }, { ...status, followSupported: false }), { request: false, cancel: false, follow: false, unfollow: false });
    assert.deepEqual(requestChoices({ ...base, request: { ...other, requestedByViewer: true, following: true, status: "pending" } }, status), { request: false, cancel: true, follow: false, unfollow: false });
    assert.equal(requestChoices({ ...base, request: { ...other, requestedByViewer: true, status: "downloading" } }, status).cancel, false);
    assert.equal(mediaStateLabel("missing", { ...other, state: "processing", download: { phase: "downloading", percent: 43 } }), "Processing · 43%");
    assert.equal(mediaStateLabel("available", state), "Available");
    assert.equal(mediaStateLabel("missing", { ...state, requestable: false, reason: "quota_exceeded" }), "Request limit reached");
    assert.equal(mediaStateLabel("missing", { ...state, requestable: false, reason: "toString" }), "Unavailable");
    assert.equal(mediaStateLabel("missing", state), undefined);
    assert.deepEqual(createBody({ ...base, request: state, year: 0, overview: "" }), { media_type: "movie", tmdb_id: 7, title: "X", poster_path: "/p.jpg" });
});

test("disabled capability answers close Requests; other failures stay retryable", () => {
    const answer = (status: number, id: string) => new ApiError({ kind: "problem", problem: { id, status, title: "t", instance: "", errors: [] }, retryAfterSeconds: undefined });
    assert.equal(unavailableAnswer(answer(409, "capability_disabled")), true);
    assert.equal(unavailableAnswer(answer(409, "capability_not_configured")), true);
    assert.equal(unavailableAnswer(answer(501, "capability_unsupported")), true);
    assert.equal(unavailableAnswer(answer(409, "conflict")), false);
    assert.equal(unavailableAnswer(answer(503, "unavailable")), false);
    assert.match(actionFailure(new ApiError({ kind: "timeout" })), /did not confirm/);
    assert.match(actionFailure(answer(409, "conflict")), /changed on the server/);
});

async function signedIn() {
    const harness = await connected();
    const catalog = new FakeRequests();
    harness.fake.catalog = catalog;
    await signIn(harness);
    const profiles = harness.core.profiles;
    const owner = (await profiles.list()).find(profile => profile.id === "p-owner");
    assert.ok(owner);
    profiles.select(owner);
    return { harness, catalog, session: harness.core.session };
}

test("the hub reads status first and never lists Discover while Requests are off", async () => {
    const { harness, catalog, session } = await signedIn();
    const read = <T>(spec: RequestSpec<T>) => session.call<T>({ ...spec, profileScoped: true });
    const seen: string[] = [];
    const answer = await readRequests({ screen: "hub", data: undefined }, read, status => seen.push(status.state));
    assert.equal(answer.screen === "hub" && answer.data.rowOrder.length, 5);
    assert.deepEqual(seen, ["available"]);
    catalog.disable();
    const before = harness.fake.requests.length;
    await assert.rejects(readRequests({ screen: "hub", data: undefined }, read, () => undefined), RequestsUnavailable);
    assert.deepEqual(harness.fake.paths().slice(before), ["GET /requests/status"]);
    await assert.rejects(readRequests({ screen: "mine", cursors: [undefined], index: 0, pendingIndex: undefined, data: undefined }, read, () => undefined), RequestsUnavailable);
    assert.equal(harness.fake.requests[harness.fake.requests.length - 1]?.headers["x-profile-id"], "p-owner");
});

test("create, cancel, follow and unfollow are each sent once, even after a lost answer or a refreshed token", async () => {
    const { harness, catalog, session } = await signedIn();
    const call = <T>(spec: RequestSpec<T>) => session.call<T>({ ...spec, profileScoped: true, replayAfterRefresh: false });
    const read = <T>(spec: RequestSpec<T>) => session.call<T>({ ...spec, profileScoped: true });
    const detail = async (type: "movie" | "series", id: number) => await read(api.detail(type, id));
    const writes = () => harness.fake.requests.filter(request => request.method !== "GET" && request.path.startsWith("/requests")).map(request => `${request.method} ${request.path}`);

    harness.fake.dropNextAnswer("/requests");
    await assert.rejects(sendRequestAction("create", await detail("movie", 1001), call), (error: unknown) => error instanceof ApiError && error.failure.kind === "network");
    assert.deepEqual(writes(), ["POST /requests"], "the lost create is not resent");
    const landed = await detail("movie", 1001);
    assert.equal(landed.request.requestedByViewer, true, "the reread shows the create landed");
    assert.deepEqual(harness.fake.requests.filter(r => r.path === "/requests").map(r => r.body), [{ media_type: "movie", tmdb_id: 1001, title: "Request Movie 1", year: 2001, overview: "Request Movie 1 overview.", poster_path: "/poster-1.jpg" }]);

    harness.fake.expireAccessTokens();
    await assert.rejects(sendRequestAction("cancel", landed, call), (error: unknown) => error instanceof ApiError && error.status === 401);
    assert.deepEqual(writes(), ["POST /requests", "POST /requests/r-3/cancel"], "a 401 refreshes but never replays the write");
    await sendRequestAction("cancel", await detail("movie", 1001), call);
    assert.equal(catalog.requests.find(request => request.id === "r-3")?.outcome, "cancelled");

    const series = await detail("series", 1399);
    await sendRequestAction("follow", series, call);
    assert.equal((await detail("series", 1399)).request.following, true);
    harness.fake.script("/requests/follows/series/1399", problem(503, "unavailable", "Down"));
    await assert.rejects(sendRequestAction("unfollow", series, call), (error: unknown) => error instanceof ApiError && error.status === 503);
    await sendRequestAction("unfollow", series, call);
    assert.equal((await detail("series", 1399)).request.following, false);
    assert.deepEqual(writes().slice(3), ["PUT /requests/follows/series/1399", "DELETE /requests/follows/series/1399", "DELETE /requests/follows/series/1399"], "a 503 is not retried by the transport");
});
