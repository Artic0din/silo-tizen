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
    type ItemDetail,
} from "../../src/contracts/v2/catalog.ts";
import { WireError } from "../../src/contracts/v2/wire.ts";
import { artworkUrl, clockTime, destinationOf, playChoices, resumeSeconds, visibleLibraries } from "../../src/ui/browseModel.ts";
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
        backdropUrl: undefined,
        overview: undefined,
        runtimeMinutes: 170,
        durationSeconds: 10200,
        positionSeconds: 1200.5,
        seriesId: undefined,
        seriesTitle: undefined,
        seasonNumber: undefined,
        episodeNumber: undefined,
    });

    const page = decodeCatalogPage(fixture("list_catalog_items_ok"));
    assert.deepEqual(page.items.map((card) => card.id), ["movie:heat-1995", "movie:alien-1979"]);
    assert.equal(page.total, 3);
    assert.equal(page.totalExact, true);
    assert.ok(page.nextCursor?.startsWith("eyJ2Ijox"));

    const detail = decodeItemDetail(fixture("get_catalog_item_ok"));
    assert.equal(detail.type, "movie");
    assert.equal(detail.tagline, "A Los Angeles crime saga");
    assert.deepEqual(detail.versions, [{ fileId: "120", durationSeconds: 0, audio: [], label: "2160p" }]);
    assert.deepEqual(detail.watch, { played: true, positionSeconds: undefined, lastFileId: "120" });

    assert.deepEqual(decodeSeasons(fixture("list_series_seasons_ok")), [
        { isSpecials: false, id: "series:severance-S01", seasonNumber: 1, title: "Season 1", episodeCount: 9, posterUrl: "https://images.example/season.webp" },
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

test("unknown media and library kinds decode as unknown; wrong shapes fail without echoing values", () => {
    const sections = decodeHomeSections({
        sections: [{ id: "books", section_type: "recommendations", title: "Books", items: [{ content_id: "ebook:1", type: "ebook", title: "Dune" }] }],
    });
    assert.equal(sections[0]?.items[0]?.type, "unknown");
    assert.equal(decodeUserLibraries({ items: [{ id: "3", name: "Audio", type: "audiobooks", sort_order: 1 }] })[0]?.type, "unknown");
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
        "GET /catalog?library_id=12&type=movie&limit=24&cursor=abc%2F%2B%3D&image_size=small",
        "GET /catalog?q=heat%20%26%20co&type=video&limit=24&image_size=small",
        "GET /catalog/items/movie%3Aheat%201995?image_size=medium",
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
    assert.deepEqual(destinationOf({ ...card, type: "movie" }), { kind: "item", id: "x", title: "X" });
    assert.deepEqual(destinationOf({ ...card, type: "episode" }), { kind: "item", id: "x", title: "X" });
    assert.deepEqual(destinationOf({ ...card, type: "season", seriesId: "s", seasonNumber: 0 }), { kind: "season", id: "x", seriesId: "s", seasonNumber: 0, title: "X" });
    assert.equal(destinationOf({ ...card, type: "season" }), undefined, "a season without its series cannot open");
    assert.equal(destinationOf({ ...card, type: "unknown" }), undefined);
});

test("libraries: video kinds in server order, minus the profile's own hidden list", () => {
    const libraries = [
        { id: "13", name: "Shows", type: "series" as const, sortOrder: 3 },
        { id: "12", name: "Movies", type: "movies" as const, sortOrder: 1 },
        { id: "14", name: "Books", type: "unknown" as const, sortOrder: 0 },
        { id: "15", name: "Home videos", type: "mixed" as const, sortOrder: 2 },
    ];
    assert.deepEqual(visibleLibraries(libraries, ["15"]).map((library) => library.id), ["12", "13"]);
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
});

test("resume: positive positions resume unless within 5 seconds of the end", () => {
    assert.equal(resumeSeconds(1200.5, 10200), 1200.5);
    assert.equal(resumeSeconds(10195, 10200), undefined);
    assert.equal(resumeSeconds(10194.9, 10200), 10194.9);
    assert.equal(resumeSeconds(0, 10200), undefined);
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
