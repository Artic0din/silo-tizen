import { fixture, problem, type FakeSilo, type Reply } from "./fakeSilo.ts";
import type { Clock } from "../../../src/api/clock.ts";

/** Pinned watch/manifest shapes; synthetic file flags, expiry and signatures, no real media. */
export class FakeTrickplay {
    readonly files = new Map<string, boolean>([["42", true], ["43", true]]);
    readonly manifests: Reply[] = [];
    readonly clock: Clock;
    manifestReads = 0;
    watchReads = 0;

    constructor(fake: FakeSilo, clock: Clock) {
        this.clock = clock;
        fake.extraRoutes.push((method, path, headers) => {
            const url = new URL(path, fake.origin);
            if (method !== "GET" || !/^\/watch\/[^/]+(?:\/trickplay)?$/.test(url.pathname)) return undefined;
            if (fake.authenticate(headers) === undefined) return problem(401, "authentication_required", "Authentication required");
            if (headers["x-profile-id"] === undefined) return problem(422, "validation_failed", "Profile required");
            const fileId = url.searchParams.get("file_id");
            if (!url.pathname.endsWith("/trickplay")) {
                this.watchReads++;
                return { status: 200, body: { ...fixture("get_watch_state_ok"), versions: [...this.files].map(([id, available]) => ({ file_id: id, trickplay_available: available })) } };
            }
            this.manifestReads++;
            if (fileId === null || !this.files.has(fileId) || this.files.get(fileId) !== true) return problem(404, "not_found", "No previews");
            return this.manifests.shift() ?? { status: 200, body: this.manifest(fileId) };
        });
    }

    manifest(fileId = "42"): Record<string, unknown> {
        const base = fixture("get_watch_trickplay_ok");
        if (!Array.isArray(base.sheets)) throw new Error("Invalid fixture sheets");
        return { ...base, file_id: fileId, expires_at: new Date(this.clock.now() + 120000).toISOString(),
            sheets: base.sheets.map((_sheet, index) => ({ index, url: `/api/v2/artwork/trickplay/${fileId}/9913/${index}.9913.jpg?exp=${Math.floor(this.clock.now() / 1000) + 120}&sig=synthetic-${this.manifestReads}` })) };
    }
}
