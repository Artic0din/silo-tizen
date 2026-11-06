import assert from "node:assert/strict";
import { test } from "node:test";
import { requestOperations as operations } from "../../src/api/requestOperations.ts";
import { decodeDiscover, decodeMediaRequest, decodeMyRequests, decodeRequestsCapability, decodeRequestTitle, decodeRequestPage } from "../../src/contracts/v2/requests.ts";
import { FakeRequests } from "./support/fakeRequests.ts";
import { decodeCatalogSearchCapabilities } from "../../src/contracts/v2/discovery.ts";
import { fixture } from "./support/fakeSilo.ts";
import { decodePeople } from "../../src/contracts/v2/details.ts";
import { detailOperations } from "../../src/api/detailOperations.ts";
import { searchRequestCatalogId } from "../../src/ui/globalSearch.ts";
import { artworkUrl, requestPosterUrl } from "../../src/ui/browseModel.ts";
import { errorState, unconfirmedWriteMessage, writeFailureMessage, writeMayHaveApplied } from "../../src/ui/browseRoutes.ts";
import { ApiError } from "../../src/api/errors.ts";
import { SessionError } from "../../src/session/session.ts";

test("Search retains optional native People scope and request catalog identity strictly", () => {
    const capability = { ...fixture("get_catalog_search_capabilities_ok"), people_media_scope: true };
    assert.equal(Reflect.get(decodeCatalogSearchCapabilities(capability), "peopleMediaScope"), true);
    assert.throws(() => decodeCatalogSearchCapabilities({ ...capability, people_media_scope: "true" }));
    const title = { ...new FakeRequests().title(), library_content_id: "movie:heat" };
    assert.equal(Reflect.get(decodeRequestTitle(title), "libraryContentId"), "movie:heat");
    assert.throws(() => decodeRequestTitle({ ...title, library_content_id: 42 }));
});

test("Search People decodes bounded native collections and uses the exact scoped endpoint", () => {
    assert.equal(detailOperations.people("River & Vale", "series").path, "/catalog/people?q=River%20%26%20Vale&media_scope=series&limit=20");
    assert.equal(decodePeople({ items: [{ id: "7", name: "River" }] })[0]?.name, "River");
    for (const value of [{}, { items: {} }, { items: [{ id: 7, name: "River" }] }]) assert.throws(() => decodePeople(value));
});

test("Search Request routing follows recognized display state before availability and requires a real catalog identity", () => {
    const title = decodeRequestTitle({ ...new FakeRequests().title(), availability: "available", library_content_id: "movie:heat" });
    assert.equal(searchRequestCatalogId(title), "movie:heat");
    for (const state of ["processing", "partially_available", "failed", "pending", "approved", "declined", "cancelled"]) assert.equal(searchRequestCatalogId({ ...title, request: { ...title.request, state } }), undefined);
    assert.equal(searchRequestCatalogId({ ...title, libraryContentId: " " }), undefined);
    assert.equal(searchRequestCatalogId({ ...title, libraryContentId: undefined }), undefined);
    assert.equal(searchRequestCatalogId({ ...title, availability: "missing", request: { ...title.request, state: "new_state", status: "completed" } }), "movie:heat");
});

test("Request posters resolve TMDB paths before normal image admission", () => {
    assert.equal(requestPosterUrl("/poster.jpg"), "https://image.tmdb.org/t/p/w342/poster.jpg");
    assert.equal(requestPosterUrl("https://images.example.test/poster.jpg"), "https://images.example.test/poster.jpg");
    for (const scheme of ["HTTPS", "hTtPs"]) {
        const reference = `${scheme}://images.example.test/poster.jpg`;
        assert.equal(requestPosterUrl(reference), reference);
        assert.equal(artworkUrl(requestPosterUrl(reference), "https://silo.example.test"), "https://images.example.test/poster.jpg");
    }
    for (const path of [undefined, "", "poster.jpg", "//images.example.test/poster.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA"]) assert.equal(requestPosterUrl(path), undefined);
    assert.equal(artworkUrl(requestPosterUrl("http://images.example.test/poster.jpg"), "https://silo.example.test"), undefined);
    assert.equal(artworkUrl(requestPosterUrl("HtTp://images.example.test/poster.jpg"), "https://silo.example.test"), undefined);
    assert.equal(artworkUrl(requestPosterUrl("/poster.jpg"), "https://silo.example.test/prefix"), "https://image.tmdb.org/t/p/w342/poster.jpg");
});

test("Requests retains optional TMDB artwork on result, detail and record reads", () => {
    const fake = new FakeRequests();
    for (const title of [decodeRequestTitle({ ...fake.title(), poster_path: "/poster.jpg", backdrop_path: "/backdrop.jpg" }), decodeMediaRequest({ ...fake.record, poster_path: "/poster.jpg", backdrop_path: "/backdrop.jpg" })]) {
        assert.equal(title.posterPath, "/poster.jpg");
        assert.equal(title.backdropPath, "/backdrop.jpg");
    }
    assert.equal(decodeRequestTitle(fake.title()).posterPath, undefined);
    assert.throws(() => decodeRequestTitle({ ...fake.title(), poster_path: 42 }));
    for (const field of ["poster_path", "backdrop_path"]) {
        assert.throws(() => decodeRequestTitle({ ...fake.title(), [field]: null }));
        assert.throws(() => decodeMediaRequest({ ...fake.record, [field]: null }));
    }
});

test("Requests decodes pinned optional title metadata and related request identities", () => {
    const fake = new FakeRequests();
    const detail = decodeRequestTitle({ ...fake.title(), year: 1995, runtime: 170, vote_average: 8.3, genres: ["Drama"], director: "Michael Mann", creators: ["Creator"], number_of_seasons: 3, recommendations: [{ ...fake.title(), tmdb_id: 950 }] });
    assert.equal(detail.year, 1995); assert.equal(detail.runtime, 170); assert.equal(detail.voteAverage, 8.3);
    assert.deepEqual(detail.genres, ["Drama"]); assert.equal(detail.recommendations?.[0]?.tmdbId, 950);
    assert.deepEqual(detail.creators, ["Creator"]); assert.equal(detail.numberOfSeasons, 3);
    for (const value of [{ year: "1995" }, { runtime: "170" }, { genres: [5] }, { recommendations: [{}] }]) assert.throws(() => decodeRequestTitle({ ...fake.title(), ...value }));
});

test("Request records retain the local-date instant and quality target summary fields", () => {
    const fake = new FakeRequests();
    const record = decodeMediaRequest({ ...fake.record, created_at: "2026-01-02T12:00:00Z", targets: [{ quality: "1080p", status: "queued" }, { quality: "4K", status: "completed" }] });
    assert.equal(record.createdAt, 1767355200000);
    assert.deepEqual(record.targets, [{ quality: "1080p", status: "queued" }, { quality: "4K", status: "completed" }]);
    assert.throws(() => decodeMediaRequest({ ...fake.record, created_at: "not a date" }));
    assert.throws(() => decodeMediaRequest({ ...fake.record, targets: [{ quality: 42, status: "queued" }] }));
});

test("Requests preserves optional catalog destinations without accepting malformed identities", () => {
    const fake = new FakeRequests();
    assert.equal(decodeRequestTitle({ ...fake.title(), library_content_id: "series:opaque/+" }).libraryContentId, "series:opaque/+");
    assert.equal(decodeMediaRequest({ ...fake.record, library_content_id: "movie:opaque/+" }).libraryContentId, "movie:opaque/+");
    assert.equal(decodeRequestTitle(fake.title()).libraryContentId, undefined);
    assert.equal(decodeRequestTitle({ ...fake.title(), library_content_id: "" }).libraryContentId, "");
    assert.throws(() => decodeRequestTitle({ ...fake.title(), library_content_id: 42 }));
});

test("Requests contract consumes capability, ordered discovery, detail and cursor pages", () => {
    const fake = new FakeRequests();
    const title = decodeRequestTitle(fake.title());
    assert.equal(title.tmdbId, 949);
    assert.equal(decodeRequestsCapability({ requests_enabled: true, allowed: false, state: "available", follow_supported: true }).enabled, false);
    assert.equal(decodeRequestsCapability({ requests_enabled: false, allowed: true, state: "disabled", follow_supported: true }).enabled, false);
    assert.throws(() => decodeRequestsCapability({ requests_enabled: true }));
    assert.throws(() => decodeRequestTitle({ ...fake.title(), tmdb_id: -1 }));
    assert.throws(() => decodeMyRequests({ items: [], page: { has_more: true } }));
    assert.equal(decodeMyRequests({ items: [], page: { has_more: true, next_cursor: "opaque/+" } }).cursor, "opaque/+");
    const section = { key: "custom", title: "Custom", page: 1, total_pages: 9, next_page: 4, results: [fake.title()] };
    assert.equal(decodeRequestPage(section).nextPage, 4);
    assert.deepEqual(decodeDiscover({ items: [section], row_order: [{ key: "future", type: "future" }, { key: "custom", type: "tmdb_list" }] }).map(row => row.key), ["custom"]);
    assert.deepEqual(decodeDiscover({ items: [] }), [], "Apple's models do not read row_order");
    assert.deepEqual(decodeDiscover({ items: [section] }).map(row => row.key), ["custom"], "without row_order the server's order stands");
});
test("Requests writes have no automatic transport replay; paths and bodies match native API", () => {
    const title = decodeRequestTitle(new FakeRequests().title());
    for (const spec of [operations.create(title), operations.cancel("opaque/id"), operations.remove("opaque/id"), operations.follow(title, true), operations.follow(title, false)]) assert.equal(spec.retry, "never");
    assert.deepEqual(operations.create(title).body, { media_type: "movie", tmdb_id: 949, title: "Heat" });
    assert.equal(operations.cancel("opaque/id").path, "/requests/opaque%2Fid/cancel");
    assert.equal(operations.remove("a/b?c").method, "DELETE");
    assert.equal(operations.remove("a/b?c").path, "/requests/a%2Fb%3Fc");
    assert.equal(operations.follow(title, true).method, "PUT");
    assert.equal(operations.follow(title, false).method, "DELETE");
    assert.equal(operations.mine("opaque/+").path, "/requests/mine?limit=24&cursor=opaque%2F%2B");
    assert.equal(operations.search("Heat & ice", 2).path, "/requests/search?q=Heat%20%26%20ice&media_type=all&page=2");
});

test("a failed write sorts and words like Apple's RequestMutationFailure and RequestErrorCopy", () => {
    const answered = (status: number, id: string, detail?: string): ApiError => new ApiError({ kind: "problem", retryAfterSeconds: undefined, problem: { id, status, title: "Title", instance: "urn:test", errors: [], ...(detail === undefined ? {} : { detail }) } });
    const http = new ApiError({ kind: "http", status: 503, retryAfterSeconds: undefined });
    for (const definite of [answered(409, "conflict", "Already requested"), http, new SessionError("unavailable")]) assert.equal(writeMayHaveApplied(definite), false);
    for (const uncertain of [new ApiError({ kind: "network" }), new ApiError({ kind: "timeout" }), new ApiError({ kind: "aborted" }), new ApiError({ kind: "invalid_response", path: "/requests" }), new TypeError("unknown")]) assert.equal(writeMayHaveApplied(uncertain), true);
    assert.equal(writeFailureMessage(answered(400, "validation_failed", "Hidden")), "That request couldn't be submitted");
    for (const id of ["capability_disabled", "capability_not_configured", "capability_unsupported"]) assert.equal(writeFailureMessage(answered(409, id, "Hidden")), "Requests are turned off");
    assert.equal(writeFailureMessage(answered(409, "conflict", "Already requested")), "Already requested");
    assert.equal(writeFailureMessage(answered(409, "conflict", "  ")), "Title");
    assert.equal(writeFailureMessage(http), "The server ran into a problem. Try again in a moment.");
    assert.equal(unconfirmedWriteMessage("create"), "We couldn't confirm the request. Check My Requests before trying again.");
    assert.equal(unconfirmedWriteMessage("cancel"), "We couldn't confirm the cancellation. Reopen My Requests to check it.");
    assert.equal(unconfirmedWriteMessage("follow"), "Could not confirm the change. Refresh before trying again.");
});
test("errorState follows Apple's ErrorState copy and ErrorView headline", () => {
    const http = (status: number) => new ApiError({ kind: "http", status, retryAfterSeconds: undefined });
    const problem = (status: number, id: string, detail?: string) => new ApiError({ kind: "problem", problem: { id, status, title: "Title", instance: "urn:test", errors: [], ...(detail === undefined ? {} : { detail }) }, retryAfterSeconds: undefined });
    const wrong = "Something went wrong";
    for (const [error, expected] of [
        [http(401), { headline: "Session expired", message: "Your session has expired. Sign in again to continue.", signIn: true }],
        [problem(401, "token_invalid", "Hidden"), { headline: "Session expired", message: "Your session has expired. Sign in again to continue.", signIn: true }],
        [new SessionError("session_ended"), { headline: "Session expired", message: "Your session has expired. Sign in again to continue.", signIn: true }],
        [http(403), { headline: "Not allowed", message: "You don't have permission to do this. Ask your server admin if you need access.", signIn: false }],
        [problem(403, "password_change_required", "Protocol text"), { headline: "Not allowed", message: "You don't have permission to do this. Ask your server admin if you need access.", signIn: false }],
        [problem(403, "permission_denied", "Requests are not allowed."), { headline: "Not allowed", message: "Requests are not allowed.", signIn: false }],
        [problem(404, "not_found", "Hidden"), { headline: "Not found", message: "We couldn't find what you were looking for. It may have been removed or moved.", signIn: false }],
        [http(408), { headline: wrong, message: "The server took too long to respond. Try again in a moment.", signIn: false }],
        [http(504), { headline: wrong, message: "The server took too long to respond. Try again in a moment.", signIn: false }],
        [http(429), { headline: wrong, message: "Too many requests. Please wait a moment and try again.", signIn: false }],
        [http(503), { headline: wrong, message: "The server ran into a problem. Try again in a moment.", signIn: false }],
        [new SessionError("unavailable"), { headline: wrong, message: "The server ran into a problem. Try again in a moment.", signIn: false }],
        [http(418), { headline: wrong, message: "Something went wrong while talking to the server.", signIn: false }],
        [problem(500, "internal", "The server's own words."), { headline: wrong, message: "The server's own words.", signIn: false }],
        [problem(500, "internal"), { headline: wrong, message: "Title", signIn: false }],
        [new ApiError({ kind: "network" }), { headline: wrong, message: "Can't reach the server. Check your connection and try again.", signIn: false }],
        [new ApiError({ kind: "timeout" }), { headline: wrong, message: "Can't reach the server. Check your connection and try again.", signIn: false }],
        [new ApiError({ kind: "invalid_response", path: "x" }), { headline: wrong, message: "The server response was in an unexpected format.", signIn: false }],
    ] as const) assert.deepEqual(errorState(error), expected);
});
