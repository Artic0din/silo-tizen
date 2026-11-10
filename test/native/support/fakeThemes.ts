import type { FakeSilo, Reply } from "./fakeSilo.ts";
import { problem } from "./fakeSilo.ts";

/** Local theme song routes: the capability document and the playback grant. */
export class FakeThemes {
    available = true;
    delivery: "original" | "converted" = "original";
    /** Absolute proxy URL to hand back instead of this server's root-relative audio route. */
    proxyUrl: string | undefined;
    readonly grants: { owner: string; theme: string; body: Record<string, unknown> | undefined }[] = [];
    capabilityReads = 0;

    constructor(fake: FakeSilo) {
        const catalog = fake.catalog;
        fake.catalog = { ...(catalog?.playbackStopped === undefined ? {} : { playbackStopped: catalog.playbackStopped.bind(catalog) }), route: (method, path, profile, body, headers) => this.route(method, path, body) ?? catalog?.route(method, path, profile, body, headers) };
    }

    private route(method: string, path: string, body: Record<string, unknown> | undefined): Reply | undefined {
        const pathname = new URL(path, "https://fake.invalid").pathname;
        if (method === "GET" && pathname === "/catalog/themes/capabilities") {
            this.capabilityReads++;
            return { status: 200, body: this.available ? { state: "available", allowed: true, delivery: "routed", transcode: true, grant_lifetime_seconds: 300 } : { state: "unavailable" } };
        }
        const match = /^\/catalog\/items\/([^/]+)\/themes\/([^/]+)\/playback$/.exec(pathname);
        if (method === "POST" && match !== null) {
            if (!this.available) return problem(404, "not_found", "Not found");
            const owner = decodeURIComponent(match[1] ?? "");
            const theme = decodeURIComponent(match[2] ?? "");
            this.grants.push({ owner, theme, body });
            return { status: 200, body: {
                url: this.proxyUrl ?? `/api/v2/catalog/items/${encodeURIComponent(owner)}/themes/${encodeURIComponent(theme)}/audio?token=signed`,
                expires_at: "2026-01-02T03:09:05Z", delivery: this.delivery, content_type: this.delivery === "converted" ? "audio/mp4" : "audio/mpeg",
            } };
        }
        return undefined;
    }
}
