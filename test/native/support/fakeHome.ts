import { FakeCatalog } from "./fakeCatalog.ts";
import { problem, type Reply } from "./fakeSilo.ts";

/** Profile-resolved Home rows and their opaque, scope-bound catalog continuations. */
export class FakeHome extends FakeCatalog {
    readonly queries: Record<string, unknown>[] = [];
    detailMode: "normal" | "missing" | "restricted" | "unreadable" | "mismatch" = "normal";

    constructor() {
        super(70);
        const home = this.households.get("p-owner");
        if (home === undefined) throw new Error("Missing synthetic household");
        home.sections = [
            { id: "hero/opaque", sectionType: "recently_added", title: "Featured", items: ["movie:m0004"] },
            { id: "recent/12", sectionType: "recently_added", title: "Recently Added in Movies", items: [...this.titles.keys()].filter(id => id.startsWith("movie:m")) },
            { id: "because/opaque", sectionType: "because_you_watched", title: "Because you watched", items: ["movie:m0005"] },
            { id: "resume/opaque", sectionType: "continue_watching", title: "Continue Watching", items: ["movie:m0001", "episode:s1e12"] },
            { id: "future/opaque", sectionType: "future_valid_row", title: "Server Picks", items: ["movie:m0006"] },
            { id: "for/you", sectionType: "recommended_for_you", title: "Your discoveries", items: ["movie:m0007"] },
        ];
    }

    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        const url = new URL(path, "https://fake.invalid");
        const home = profileId === undefined ? undefined : this.households.get(profileId);
        if (url.pathname === "/catalog/query" && method === "POST" && body?.source === "section") {
            if (home === undefined) return problem(400, "profile_header_required", "Profile header required");
            this.queries.push(body);
            const section = home.sections.find(row => row.id === body.section_id);
            if (body.scope !== "home" || section === undefined) return problem(404, "not_found", "Not found");
            if (body.type !== undefined || body.sort !== undefined || body.library_id !== undefined) return problem(422, "validation_failed", "Unexpected row override");
            const offset = body.cursor === undefined ? 0 : body.cursor === "opaque:/+second==" ? 24 : body.cursor === "opaque:/+third==" ? 48 : -1;
            if (offset < 0) return problem(400, "invalid_cursor", "Invalid cursor");
            const reply = super.route("GET", "/home/sections", profileId);
            const rows = record(reply?.body).sections;
            if (!Array.isArray(rows)) throw new Error("Missing resolved rows");
            const row = rows.find((candidate: { id: string }) => candidate.id === section.id) as { items: unknown[] };
            const items = row.items;
            const limit = typeof body.limit === "number" ? body.limit : 50;
            const next = offset === 0 ? "opaque:/+second==" : "opaque:/+third==";
            return { status: 200, body: { window_cursor: "opaque:window", items: items.slice(offset, offset + limit), total: items.length, total_exact: true, page: offset + limit < items.length ? { has_more: true, next_cursor: next } : { has_more: false } } };
        }
        const reply = super.route(method, path, profileId, body);
        const response = reply?.status === 200 ? record(reply.body) : undefined;
        if (url.pathname === "/home/sections" && response !== undefined && Array.isArray(response.sections)) {
            return { status: 200, body: { ...response, sections: response.sections.map((row: Record<string, unknown>) => ({ ...row, featured: row.id === "hero/opaque", items: Array.isArray(row.items) ? row.items.slice(0, 24) : [] })) } };
        }
        if (url.pathname.startsWith("/catalog/items/") && reply?.status === 200) {
            const id = decodeURIComponent(url.pathname.slice("/catalog/items/".length));
            const chosen = this.fileIds.get(id) ?? "chosen";
            if (this.detailMode === "restricted") return problem(404, "not_found", "Not found");
            if (this.detailMode === "unreadable") return { status: 200, body: { content_id: 12 } };
            return { status: 200, body: { ...response, ...(this.detailMode === "mismatch" ? { content_id: "movie:other" } : {}),
                versions: this.detailMode === "missing" ? [] : [{ file_id: "43", duration: 9000 }, { file_id: chosen, duration: 1200 }],
                duration_seconds: 9000, user_data: { played: false, last_file_id: chosen, position_seconds: this.progress.get(id) ?? 321.5 },
            } };
        }
        return reply;
    }
}

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected synthetic object");
    return value as Record<string, unknown>;
}
