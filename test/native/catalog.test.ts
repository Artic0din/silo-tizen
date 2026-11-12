// Browse contract: the vendored fixtures decode with the production decoders, the operations
// send the documented paths and parameters, and the browse rules pick what to show and play.

import assert from "node:assert/strict";
import { test } from "node:test";
import { operations } from "../../src/api/operations.ts";
import {
    decodeCatalogPage,
    decodeEpisodes,
    decodeHiddenLibraries,
    decodeHomeSections,
    decodeItemDetail,
    decodeSeasons,
    decodeUserLibraries,
    decodeWatchDetail,
    type ItemDetail,
} from "../../src/contracts/v2/catalog.ts";
import { WireError } from "../../src/contracts/v2/wire.ts";

test("episode rows retain air date, overview and episode ratings", () => {
    const episodes = decodeEpisodes({ items: [{ content_id: "episode:1", season_number: 1, episode_number: 2, title: "Pilot", runtime: 52, air_date: "2026-02-18", overview: "An arrival", ratings: [{ name: "IMDb", display: "8.1" }] }] });
    assert.equal(episodes[0]?.airDate, "2026-02-18");
    assert.equal(episodes[0]?.overview, "An arrival");
    assert.deepEqual(episodes[0]?.ratings, [{ name: "IMDb", display: "8.1" }]);
});

test("episode rows retain resume seconds from user data", () => {
    const episode = { content_id: "episode:1", season_number: 1, episode_number: 2, title: "Pilot", runtime: 52 };
    const decode = (user_data: Record<string, unknown>) => decodeEpisodes({ items: [{ ...episode, user_data }] })[0];
    assert.equal(decode({ played: true, position_seconds: 60.5, duration_seconds: 240 })?.positionSeconds, 60.5);
    assert.equal(decode({ played: true, position_seconds: 60.5, duration_seconds: 240 })?.durationSeconds, 240);
    assert.throws(() => decode({ played: false, position_seconds: "60", duration_seconds: 240 }), WireError);
    assert.throws(() => decode({ played: false, position_seconds: 60, duration_seconds: "240" }), WireError);
});

test("local extras retain authoritative watch targets and numeric file IDs", () => {
    const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"), extras: [{ content_id: "extra:1", file_id: 71, kind: "trailer", title: "Trailer", duration_seconds: 90, still_url: "/extra.jpg" }] });
    assert.deepEqual(detail.extras, [{ contentId: "extra:1", fileId: "71", kind: "trailer", title: "Trailer", durationSeconds: 90, stillUrl: "/extra.jpg" }]);
});

test("item videos keep the contract fields and a missing official flag does not reject the detail", () => {
    const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"), videos: [
        { kind: "trailer", site: "YouTube", site_key: "abc_def-1", name: "Official Trailer", language: "en", is_official: true },
        { kind: "teaser", site: "vimeo", site_key: "v1" },
    ] });
    assert.deepEqual(detail.videos, [
        { kind: "trailer", site: "YouTube", siteKey: "abc_def-1", name: "Official Trailer", language: "en", isOfficial: true },
        { kind: "teaser", site: "vimeo", siteKey: "v1", name: undefined, language: undefined, isOfficial: false },
    ]);
    assert.deepEqual(decodeItemDetail(fixture("get_catalog_item_ok")).videos, []);
    assert.throws(() => decodeItemDetail({ ...fixture("get_catalog_item_ok"), videos: [{ kind: "trailer", site: "youtube", site_key: "k", is_official: "yes" }] }), WireError);
});
import { type Destination, artworkUrl, clockTime, destinationOf, playChoices, resumeSeconds, browseCardDestination, seriesPlayback, visibleLibraries } from "../../src/ui/browseModel.ts";
import { moveWithin } from "../../src/ui/browseFocus.ts";
import { fixture } from "./support/fakeSilo.ts";

test("browse fixtures decode with the production decoders", () => {
    assert.deepEqual(decodeUserLibraries(fixture("user_libraries")), [{ id: "12", name: "Movies", type: "movies", sortOrder: 2 }]);
    assert.deepEqual(decodeHiddenLibraries(fixture("list_effective_settings_ok")), [], "the fixture holds other keys only");

    const sections = decodeHomeSections(fixture("list_home_sections_ok"));
    assert.equal(sections.length, 1);
    assert.equal(sections[0]?.id, "continue_watching");
    assert.equal(sections[0]?.sectionType, "continue_watching");
    assert.deepEqual(sections[0]?.items[0], {
        id: "movie:heat-1995",
        type: "movie",
        title: "Heat",
        year: 1995,
        posterUrl: "https://s3.example.test/poster.jpg",
        posterThumbhash: undefined,
        backdropUrl: undefined,
        backdropThumbhash: undefined,
        overview: undefined,
        runtimeMinutes: 170,
        durationSeconds: 10200,
        positionSeconds: 1200.5,
        progressUpdatedAt: "2026-01-02T03:04:05.000Z",
        seriesId: undefined,
        seriesTitle: undefined,
        seasonNumber: undefined,
        episodeNumber: undefined,
        seriesBackdropUrl: undefined,
        contentRating: "R",
        genres: ["Crime"],
        overlay: { resolution: "4K", hdr: "Dolby Vision", audio: undefined, audioChannels: undefined, videoCodec: undefined, container: undefined, aspectRatio: undefined, releaseType: undefined, edition: undefined, multiAudio: undefined, multiSub: undefined },
        played: false,
        favorite: false,
        watchlist: true,
        logoUrl: undefined,
        ratingImdb: 8.3,
        ratingTmdb: undefined,
        ratingRtCritic: undefined,
        ratingRtAudience: undefined,
        advisoryAge: undefined,
        originalLanguage: undefined,
        studios: undefined,
        networks: undefined,
        showStatus: undefined,
    });

    const page = decodeCatalogPage(fixture("list_catalog_items_ok"));
    assert.deepEqual(page.items.map((card) => card.id), ["movie:heat-1995", "movie:alien-1979"]);
    assert.equal(page.total, 3);
    assert.equal(page.totalExact, true);
    assert.ok(page.nextCursor?.startsWith("eyJ2Ijox"));

    const detail = decodeItemDetail(fixture("get_catalog_item_ok"));
    assert.equal(detail.advisorySource, undefined);
    assert.equal(decodeItemDetail({ ...fixture("get_catalog_item_ok"), advisory_age: 13, advisory_source: "commonsense" }).advisorySource, "commonsense");
    assert.equal(detail.type, "movie");
    assert.equal(detail.tagline, "A Los Angeles crime saga");
    assert.deepEqual(detail.versions, [{ detailLabel: "0 MB", fileId: "120", effectiveAudioTrackIndex: 1, durationSeconds: 0, audio: [], label: "2160p", compactLabel: "2160p", resolution: "2160p" }]);
    assert.deepEqual(detail.watch, { played: true, positionSeconds: undefined, lastFileId: "120" });

    assert.deepEqual(decodeSeasons(fixture("list_series_seasons_ok")), [
        { userData: { played: false, watchedCount: 1, inProgressCount: 0 }, isSpecials: false, id: "series:severance-S01", seasonNumber: 1, title: "Season 1", episodeCount: 9, posterUrl: "https://images.example/season.webp" },
    ]);
    assert.equal(decodeSeasons(fixture("list_series_seasons_without_artwork"))[0]?.posterUrl, undefined);

    const episodes = decodeEpisodes(fixture("list_season_episodes_ok"));
    assert.deepEqual(episodes.map((episode) => [episode.id, episode.episodeNumber, episode.runtimeMinutes, episode.played]), [
        ["episode:severance-s01e01", 1, 57, true],
        ["episode:severance-s01e02", 2, 57, false],
    ]);
});

test("Home featured is a boolean independent of the opaque section identity and type", () => {
    const section = { id: "opaque/row", section_type: "future_valid_row", title: "Synthetic picks", items: [] };
    assert.equal(decodeHomeSections({ sections: [{ ...section, featured: true }] })[0]?.featured, true);
    assert.equal(decodeHomeSections({ sections: [section] })[0]?.featured, false);
    assert.throws(() => decodeHomeSections({ sections: [{ ...section, featured: "true" }] }), WireError);
});

for (const [wire, field] of [["backdrop_thumbhash", "backdropThumbhash"], ["poster_thumbhash", "posterThumbhash"]] as const) test(`Home ${wire} retains strings and rejects malformed wire values`, () => {
    const raw = fixture("list_home_sections_ok") as { sections: { items: Record<string, unknown>[] }[] };
    const card = raw.sections[0]?.items[0];
    assert.ok(card);
    card[wire] = "1QcSHQRnh493V4dIh4eXh1h4kJUI";
    assert.equal(decodeHomeSections(raw)[0]?.items[0]?.[field], card[wire]);
    card[wire] = ["invalid"];
    assert.throws(() => decodeHomeSections(raw), WireError);
});

test("unknown media and library kinds decode as unknown; wrong shapes fail without echoing values", () => {
    const sections = decodeHomeSections({
        sections: [{ id: "books", section_type: "recommendations", title: "Books", items: [{ content_id: "ebook:1", type: "ebook", title: "Dune" }] }],
    });
    assert.equal(sections[0]?.items[0]?.type, "unknown");
    assert.equal(decodeUserLibraries({ items: [{ id: "3", name: "Audio", type: "audiobooks", sort_order: 1 }] })[0]?.type, "audiobooks");
    assert.equal(decodeUserLibraries({ items: [{ id: "4", name: "Future", type: "future", sort_order: 2 }] })[0]?.type, "unknown");
    assert.deepEqual(
        decodeHiddenLibraries({ items: [{ key: "ui.disabled_library_ids", value: [13, 15], source: "profile", definition_revision: 1 }], revision: 1 }),
        ["13", "15"],
    );
    assert.deepEqual(decodeHiddenLibraries({ items: [{ key: "ui.disabled_library_ids", value: null, source: "default", definition_revision: 1 }], revision: 1 }), []);
    assert.throws(() => decodeCatalogPage({ items: [{ content_id: "m", type: "movie" }], total: 1, total_exact: true }), (error: unknown) => {
        assert.ok(error instanceof WireError);
        assert.equal(error.path, "catalog_page.items[0].title");
        return true;
    });
    const secret = "sig-should-not-appear";
    assert.throws(() => decodeHiddenLibraries({ items: [{ key: "ui.disabled_library_ids", value: [secret] }] }), (error: unknown) => {
        assert.ok(error instanceof WireError);
        assert.equal(error.message.indexOf(secret), -1);
        return true;
    });
});

test("browse operations are profile-scoped reads on the documented paths", () => {
    const specs = [
        operations.listUserLibraries(),
        operations.hiddenLibraries(),
        operations.listHomeSections(),
        operations.listHomeSections({ logo_width: "880" }, 20),
        operations.homeCapabilities(),
        operations.listCatalogItems({ libraryId: "12", type: "movie", limit: 24, cursor: "abc/+=" }),
        operations.listCatalogItems({ q: "heat & co", type: "video", limit: 24, cursor: undefined }),
        operations.getCatalogItem("movie:heat 1995"),
        operations.listSeriesSeasons("series:severance"),
        operations.listSeasonEpisodes("series:severance", 0),
    ];
    assert.deepEqual(specs.map((spec) => `${spec.method} ${spec.path}`), [
        "GET /user/libraries",
        "GET /settings/values/effective?keys=ui.disabled_library_ids",
        "GET /home/sections?image_size=small",
        "GET /home/sections?image_size=small&logo_width=880&item_limit=20",
        "GET /home/capabilities",
        "GET /catalog?library_id=12&type=movie&limit=24&cursor=abc%2F%2B%3D&image_size=small",
        "GET /catalog?q=heat%20%26%20co&type=video&limit=24&image_size=small",
        "GET /catalog/items/movie%3Aheat%201995?image_size=large",
        "GET /catalog/series/series%3Aseverance/seasons?image_size=small",
        "GET /catalog/series/series%3Aseverance/seasons/0/episodes?image_size=small",
    ]);
    assert.ok(specs.every((spec) => spec.retry === "safe"));
    assert.ok(specs.every((spec) => spec.path.indexOf("include_hidden") === -1));
});

test("episode-inclusive text search uses the existing GET operation with opaque continuation", () => {
    const spec = operations.listCatalogItems({ q: "Signal & echo", type: "video_with_episodes", limit: 24, cursor: "opaque+/= ?字" });
    assert.equal(spec.method, "GET");
    assert.equal(spec.path, "/catalog?q=Signal%20%26%20echo&type=video_with_episodes&limit=24&cursor=opaque%2B%2F%3D%20%3F%E5%AD%97&image_size=small");
    assert.equal(spec.retry, "safe");
    assert.equal(spec.body, undefined);
});

test("Home keeps movies, series, seasons and episodes, and leaves other media out", () => {
    const card = { id: "x", title: "X", year: undefined, posterUrl: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined };
    assert.deepEqual(route(destinationOf({ ...card, type: "movie" })), { kind: "item", id: "x", title: "X" });
    assert.deepEqual(route(destinationOf({ ...card, type: "episode" })), { kind: "item", id: "x", title: "X" });
    assert.deepEqual(route(destinationOf({ ...card, type: "season", seriesId: "s", seasonNumber: 0 })), { kind: "season", id: "x", seriesId: "s", seasonNumber: 0, title: "X" });
    assert.equal(route(destinationOf({ ...card, type: "season" })), undefined, "a season without its series cannot open");
    assert.equal(route(destinationOf({ ...card, type: "unknown" })), undefined);
});

test("Search Select opens an episode or season on its series and leaves movies and series on themselves", () => {
    const card = { id: "episode:s1e12", title: "Pilot", year: undefined, posterUrl: undefined, seriesId: "series:s1", seriesTitle: "Harbor Lights", seasonNumber: 1, episodeNumber: 2 };
    assert.deepEqual(route(browseCardDestination({ ...card, type: "episode" })), {
        kind: "item", id: "series:s1", title: "Harbor Lights", seriesContext: { seasonNumber: 1, episodeId: "episode:s1e12" },
    });
    assert.deepEqual(route(browseCardDestination({ ...card, type: "episode", seriesTitle: "  " })), {
        kind: "item", id: "series:s1", title: "Pilot", seriesContext: { seasonNumber: 1, episodeId: "episode:s1e12" },
    });
    assert.deepEqual(route(browseCardDestination({ ...card, type: "episode", seriesId: " episode:s1e12 " })), { kind: "item", id: "episode:s1e12", title: "Pilot" });
    assert.deepEqual(route(browseCardDestination({ ...card, id: "season:s1", type: "season", episodeNumber: undefined, title: "Season 1" })), {
        kind: "item", id: "series:s1", title: "Harbor Lights", seriesContext: { seasonNumber: 1, episodeId: undefined },
    });
    assert.deepEqual(route(browseCardDestination({ ...card, id: "movie:heat", type: "movie", seriesId: undefined, title: "Heat" })), { kind: "item", id: "movie:heat", title: "Heat" });
    assert.deepEqual(route(browseCardDestination({ ...card, id: "series:s1", type: "series", seriesId: undefined, title: "Harbor Lights" })), { kind: "item", id: "series:s1", title: "Harbor Lights" });
    assert.equal(route(browseCardDestination({ ...card, type: "unknown" })), undefined);
});

/** The routing fields of a destination; the loading seed is checked on its own. */
function route(destination: Destination | undefined): Destination | undefined {
    if (destination === undefined || destination.kind !== "item") return destination;
    const { seed: _seed, ...rest } = destination;
    return rest;
}

test("a card opens its Details page seeded with what Apple's loading frame paints", () => {
    const card = { id: "episode:s1e12", title: "Pilot", year: 2024, posterUrl: undefined, seriesId: "series:s1", seriesTitle: "Harbor Lights", seasonNumber: 1, episodeNumber: 2, overview: "A storm.", runtimeMinutes: 52, contentRating: "TV-14", genres: ["Drama", "Mystery"], logoUrl: "/logo", backdropUrl: "/still", backdropThumbhash: "hash", seriesBackdropUrl: "/series-art", played: false, positionSeconds: 30 };
    const movie = destinationOf({ ...card, id: "movie:heat", type: "movie" });
    assert.deepEqual(movie?.kind === "item" ? movie.seed : undefined, { type: "movie", title: "Pilot", year: 2024, overview: "A storm.", runtimeMinutes: 52, contentRating: "TV-14", genre: "Drama", backdropUrl: "/still", backdropThumbhash: "hash", backdropIsEpisodeStill: undefined }, "only an episode card swaps in the series backdrop");
    const episode = destinationOf({ ...card, type: "episode" });
    assert.deepEqual(episode?.kind === "item" ? { backdrop: episode.seed?.backdropUrl, hash: episode.seed?.backdropThumbhash, still: episode.seed?.backdropIsEpisodeStill, watch: episode.seed?.episodeWatch } : undefined,
        { backdrop: "/series-art", hash: undefined, still: false, watch: { played: false, isInProgress: true, positionSeconds: 30 } }, "an episode card shows its series backdrop");
    const parent = browseCardDestination({ ...card, type: "episode" });
    assert.deepEqual(parent?.kind === "item" ? parent.seed : undefined, { type: "series", title: "Harbor Lights", backdropUrl: "/series-art", backdropIsEpisodeStill: false }, "the parent Series frame keeps only the series title and backdrop");
});


test("libraries: supported kinds, audiobooks included, in server order, minus the profile's own hidden list", () => {
    const libraries = [
        { id: "13", name: "Shows", type: "series" as const, sortOrder: 3 },
        { id: "12", name: "Movies", type: "movies" as const, sortOrder: 1 },
        { id: "14", name: "Books", type: "unknown" as const, sortOrder: 0 },
        { id: "15", name: "Home videos", type: "mixed" as const, sortOrder: 2 },
        { id: "16", name: "Audio", type: "audiobooks" as const, sortOrder: 4 },
    ];
    assert.deepEqual(visibleLibraries(libraries, ["15"]).map((library) => library.id), ["12", "13", "16"]);
    assert.deepEqual(visibleLibraries(libraries, ["16"]).map((library) => library.id), ["12", "15", "13"], "a hidden audiobook library is dropped");
});

test("artwork: references resolve against the server; only HTTPS is drawn; nothing is added to the URL", () => {
    const base = "https://silo.example.test/silo";
    assert.equal(artworkUrl("/api/v2/artwork/p/w300.webp?exp=1&sig=abc", base), "https://silo.example.test/api/v2/artwork/p/w300.webp?exp=1&sig=abc");
    assert.equal(artworkUrl("api/v2/artwork/p.webp?exp=1&sig=abc", base), "https://silo.example.test/silo/api/v2/artwork/p.webp?exp=1&sig=abc");
    assert.equal(artworkUrl("https://s3.example.test/poster.jpg?X-Amz-Signature=1", base), "https://s3.example.test/poster.jpg?X-Amz-Signature=1");
    assert.equal(artworkUrl("http://s3.example.test/poster.jpg", base), undefined);
    assert.equal(artworkUrl("javascript:alert(1)", base), undefined);
    assert.equal(artworkUrl("", base), undefined);
    assert.equal(artworkUrl(undefined, base), undefined);
    const plain = "http://192.168.1.20:8091";
    assert.equal(artworkUrl("/api/v2/artwork/p.webp?sig=abc", plain), "http://192.168.1.20:8091/api/v2/artwork/p.webp?sig=abc", "a plain-HTTP server's own artwork is drawn");
    assert.equal(artworkUrl("javascript:alert(1)", plain), undefined);
});

test("resume: positive positions resume unless within 5 seconds of the end", () => {
    assert.equal(resumeSeconds(1200.5, 10200), 1200.5);
    assert.equal(resumeSeconds(10195, 10200), undefined);
    assert.equal(resumeSeconds(10194.9, 10200), 10194.9);
    assert.equal(resumeSeconds(0, 10200), undefined);
    assert.equal(resumeSeconds(30, 10200), undefined, "PlaybackResumePoint: 30 s or less plays from the start");
    assert.equal(resumeSeconds(30.5, 10200), 30.5);
    assert.equal(resumeSeconds(undefined, 10200), undefined);
    assert.equal(resumeSeconds(300, undefined), 300, "an unknown length still resumes");
    assert.equal(clockTime(1200.5), "20:00");
    assert.equal(clockTime(3725), "1:02:05");
});

function movie(overrides: Partial<ItemDetail>): ItemDetail {
    return { ...decodeItemDetail(fixture("get_catalog_item_ok")), ...overrides };
}

test("play: the last-played version when still listed, else the first; resume point from the watch state", () => {
    assert.deepEqual(playChoices(movie({ watch: { played: false, positionSeconds: 600, lastFileId: "121" }, durationSeconds: 7200, versions: [{ fileId: "120", durationSeconds: 0 }, { fileId: "121", durationSeconds: 0 }] })), {
        resume: { contentId: "movie:heat-1995", fileId: "121", title: "Heat", startSeconds: 600 },
        fromStart: { contentId: "movie:heat-1995", fileId: "121", title: "Heat", startSeconds: 0 },
    });
    const gone = playChoices(movie({ watch: { played: false, positionSeconds: 7198, lastFileId: "999" }, durationSeconds: undefined, versions: [{ fileId: "120", durationSeconds: 7200 }] }));
    assert.equal(gone?.fromStart.fileId, "120");
    assert.equal(gone?.resume, undefined, "7198 of the file's 7200 seconds is finished");
    assert.equal(playChoices(movie({ versions: [] })), undefined);
    assert.equal(playChoices(movie({ type: "series" })), undefined);
});

test("series Resume and Start Over keep the page series line when the episode item omits it", () => {
    const episode = movie({
        id: "episode:s1e25",
        type: "episode",
        title: "Going Green",
        seriesId: "series:spidey",
        seriesTitle: undefined,
        seasonNumber: undefined,
        episodeNumber: undefined,
        versions: [{ fileId: "42", durationSeconds: 1500 }],
        watch: { played: false, positionSeconds: 90, lastFileId: "42" },
    });
    const choices = playChoices(episode);
    assert.ok(choices?.resume);
    assert.equal(choices.resume.seriesTitle, undefined);
    assert.equal(choices.resume.seasonNumber, undefined);
    const series = movie({ id: "series:spidey", type: "series", title: "Spidey and His Amazing Friends", versions: [] });
    const rail = { seasonNumber: 1, episodeNumber: 25 };
    const resume = seriesPlayback({ ...choices.resume, subtitle: { kind: "auto" } }, series, rail);
    const startOver = seriesPlayback({ ...choices.fromStart, startSeconds: 0, subtitle: { kind: "auto" } }, series, rail);
    assert.equal(resume.seriesTitle, "Spidey and His Amazing Friends");
    assert.equal(resume.seasonNumber, 1);
    assert.equal(resume.episodeNumber, 25);
    assert.equal(resume.title, "Going Green");
    assert.equal(resume.startSeconds, 90);
    assert.equal(startOver.seriesTitle, resume.seriesTitle);
    assert.equal(startOver.seasonNumber, 1);
    assert.equal(startOver.episodeNumber, 25);
    assert.equal(startOver.startSeconds, 0);
    const kept = seriesPlayback({ ...choices.fromStart, seriesTitle: "Kept", seasonNumber: 2, episodeNumber: 3 }, series, rail);
    assert.equal(kept.seriesTitle, "Kept");
    assert.equal(kept.seasonNumber, 2);
    assert.equal(kept.episodeNumber, 3);
});

test("focus moves inside rows, columns and grids, and reports the edges", () => {
    const grid = { layout: "grid" as const, columns: 6 };
    assert.equal(moveWithin(grid, 15, 0, "right"), 1);
    assert.equal(moveWithin(grid, 15, 5, "right"), undefined, "the row's last column");
    assert.equal(moveWithin(grid, 15, 6, "left"), undefined, "the row's first column");
    assert.equal(moveWithin(grid, 15, 2, "down"), 8);
    assert.equal(moveWithin(grid, 15, 10, "down"), 14, "the partly filled last row is still below");
    assert.equal(moveWithin(grid, 15, 13, "down"), undefined);
    assert.equal(moveWithin(grid, 15, 3, "up"), undefined);
    assert.equal(moveWithin(grid, 15, 14, "right"), undefined, "no item after the last");
    const row = { layout: "row" as const };
    assert.equal(moveWithin(row, 3, 2, "right"), undefined);
    assert.equal(moveWithin(row, 3, 1, "down"), undefined);
    const column = { layout: "column" as const };
    assert.equal(moveWithin(column, 3, 0, "down"), 1);
    assert.equal(moveWithin(column, 3, 1, "right"), undefined);
});

// silo-server internal/apiv2/watch.go sends both presentation fields as snake_case and omits them when empty.
test("watch detail versions decode presentation group key and part index, and leave them undefined when omitted", () => {
    const detail = decodeWatchDetail({
        content_id: "movie:1", type: "movie", title: "Two discs",
        versions: [
            { file_id: "cd2", duration_seconds: 3000, presentation_group_key: "disc-set", presentation_part_index: 2 },
            { file_id: "single", duration_seconds: 6000 },
        ],
    });
    assert.equal(detail.versions[0]?.presentationGroupKey, "disc-set");
    assert.equal(detail.versions[0]?.presentationPartIndex, 2);
    assert.equal(detail.versions[1]?.presentationGroupKey, undefined);
    assert.equal(detail.versions[1]?.presentationPartIndex, undefined);
});
