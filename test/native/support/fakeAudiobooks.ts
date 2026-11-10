import { FakeCatalog } from "./fakeCatalog.ts";
import type { Reply } from "./fakeSilo.ts";

const LIBRARY = "14";

/** An owner household with an audiobook library: square covers on Home, a library and a detail page per book. */
export class FakeAudiobooks extends FakeCatalog {
    constructor() {
        super(12);
        const books = [
            { id: "audiobook:tide", title: "Stormlight Archive 5 - The Tide Owes (5 of 5)", year: 2024 },
            { id: "audiobook:dune", title: "Dune", year: 1965 },
            { id: "audiobook:hail", title: "Project Hail Mary", year: 2021 },
            { id: "audiobook:fresh", title: "Piranesi", year: 2020 },
        ] as const;
        for (const book of books) this.add({ ...book, type: "audiobook", libraryId: LIBRARY });
        this.progress.set("audiobook:tide", 4112);
        this.progress.set("audiobook:dune", 40);
        const home = this.households.get("p-owner");
        if (home === undefined) throw new Error("Missing synthetic household");
        home.sections = [
            { id: "listen", sectionType: "continue_watching", title: "Continue Listening", items: ["audiobook:tide"] },
            { id: "shelf", sectionType: "recently_added", title: "Recently Added Audiobooks", items: books.map(book => book.id) },
            ...home.sections.filter(row => row.id === "recently_added"),
        ];
        home.librarySections = [{ id: "library-picks", sectionType: "recently_added", title: "Audiobook Picks", items: books.map(book => book.id) }];
    }

    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        const url = new URL(path, "https://fake.invalid");
        const id = /^\/catalog\/items\/(audiobook[^/]*)$/.exec(url.pathname)?.[1];
        const reply = super.route(method, path, profileId, body);
        if (reply?.status !== 200 || method === "DELETE") return reply;
        const found = id !== undefined && method === "GET" ? this.book(decodeURIComponent(id), reply.body as Record<string, unknown>) : reply.body;
        return { status: 200, body: plain(found) };
    }

    private book(id: string, base: Record<string, unknown>): Record<string, unknown> {
        const position = this.progress.get(id) ?? 0;
        const chapters = (titles: readonly string[]): Record<string, unknown>[] => titles.map((title, index) => ({
            index, title, start_seconds: index * 3600, end_seconds: (index + 1) * 3600, source: "embedded",
        }));
        return {
            ...base,
            content_id: id, type: "audiobook", genres: ["Fantasy", "Epic"],
            overview: "The war for Roshar reaches its last turn, and the oaths that bound the Radiants are tested one more time.",
            user_data: { played: false, position_seconds: position },
            versions: [{ file_id: "af-1", presentation_kind: "audiobook_part", presentation_part_index: 1, duration: 10800, codec_audio: "aac", chapters: chapters(["Opening", "What the Tide Owes", ""]) }],
            audiobook: {
                authors: [{ name: "Brandon Sanderson" }],
                narrators: [{ name: "Michael Kramer" }, { name: "Kate Reading" }],
                publisher: "Tor Books",
                total_duration_seconds: 10800,
                series: { name: "The Stormlight Archive", entries: [
                    { content_id: "audiobook:dune", title: "The Way of Kings", year: 2010, series_index: 1, poster_url: "/art/audiobook%3Adune.svg" },
                    { content_id: "audiobook:hail", title: "Words of Radiance", year: 2014, series_index: 2, poster_url: "/art/audiobook%3Ahail.svg" },
                    { content_id: id, title: "The Tide Owes", year: 2024, series_index: 5, poster_url: `/art/${encodeURIComponent(id)}.svg` },
                ] },
                other_narrations: [{ content_id: "audiobook:fresh", title: "The Tide Owes", year: 2025, narrators: ["Steven Pacey"] }],
                related: { also_by_author: [{ content_id: "audiobook:hail", title: "Mistborn", year: 2006, poster_url: "/art/audiobook%3Ahail.svg" }], similar: [] },
            },
        };
    }
}

/** The vendored movie fixtures carry a genre, runtime and cast; a book has none of them on a card. */
function plain(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(plain);
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    const mapped = Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, plain(entry)]));
    if (record.type !== "audiobook" || typeof record.content_id !== "string") return mapped;
    const { runtime, rating_imdb, rating_tmdb, cast, crew, ...rest } = mapped;
    void runtime; void rating_imdb; void rating_tmdb;
    return { ...rest, genres: ["Fantasy"], ...(Array.isArray(cast) ? { cast: [] } : {}), ...(Array.isArray(crew) ? { crew: [] } : {}) };
}
