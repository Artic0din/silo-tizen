import { FakeDetails } from "./fakeDetails.ts";
import { problem, type Reply } from "./fakeSilo.ts";

export class FakeRequests extends FakeDetails {
    enabled = true;
    following = false;
    requestedByOther = false;
    created = false;
    cancelled = false;
    requestsEmpty = false;
    requestFailure: Reply | undefined;
    readonly record = { id: "request-one", media_type: "movie", tmdb_id: 949, title: "Heat", overview: "A detective pursues a professional thief.", requested_by_profile_id: "p-owner", state: "pending", status: "pending", outcome: "active" };
    title(): Record<string, unknown> {
        return { media_type: "movie", tmdb_id: 949, title: "Heat", overview: this.record.overview, availability: "missing", in_watchlist: false,
            request: { requestable: !this.created && !this.requestedByOther, following: this.following, requested_by_viewer: this.created, ...(this.created || this.following || this.requestedByOther ? { request_id: this.record.id, state: "pending" } : {}) } };
    }
    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        const url = new URL(path, "https://fake.invalid"), p = url.pathname;
        if (!p.startsWith("/requests")) return super.route(method, path, profileId, body);
        if (p === "/requests/status") return { status: 200, body: { requests_enabled: this.enabled, allowed: true, state: this.enabled ? "available" : "disabled", follow_supported: true } };
        if (!this.enabled) return problem(409, "capability_disabled", "Requests disabled");
        if (this.requestFailure !== undefined) return this.requestFailure;
        if (p === "/requests" && method === "POST") { this.created = true; this.cancelled = false; return { status: 201, body: this.record }; }
        if (p.endsWith("/cancel")) { this.created = false; this.cancelled = true; return { status: 200, body: { ...this.record, state: "cancelled", outcome: "cancelled" } }; }
        if (p.startsWith("/requests/follows/")) { this.following = method === "PUT"; return { status: method === "PUT" ? 200 : 204, ...(method === "PUT" ? { body: this.title().request } : {}) }; }
        if (p.startsWith("/requests/detail/")) return { status: 200, body: this.title() };
        if (p === "/requests/mine") return { status: 200, body: { items: this.created || this.cancelled ? [{ ...this.record, ...(this.cancelled ? { state: "cancelled", outcome: "cancelled" } : {}) }] : [], page: { has_more: false } } };
        if (p === `/requests/${this.record.id}`) return { status: 200, body: { ...this.record, ...(this.cancelled ? { state: "cancelled", outcome: "cancelled" } : {}) } };
        const page = { page: Number(url.searchParams.get("page") ?? 1), total_pages: 2, total_results: 2, results: this.requestsEmpty ? [] : [this.title()] };
        if (p === "/requests/search") return { status: 200, body: page };
        const section = { ...page, key: "trending_movies", title: "Trending Movies" };
        if (p.startsWith("/requests/discover/rows/")) return { status: 200, body: section };
        if (p === "/requests/discover") return { status: 200, body: { items: [section], row_order: [{ key: section.key, title: section.title, type: "tmdb_chart" }] } };
        return undefined;
    }
}
