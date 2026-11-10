import assert from "node:assert/strict";
import { test } from "node:test";
import { operations } from "../../src/api/operations.ts";
import { decodeCard, type Card, type UserLibrary } from "../../src/contracts/v2/catalog.ts";
import { decodeCatalogQueryPage } from "../../src/contracts/v2/discovery.ts";
import { ShowAudiobooks } from "../../src/ui/audiobookPreference.ts";
import { browseCardDestination, destinationOf, searchScope, visibleLibraries } from "../../src/ui/browseModel.ts";
import { homeRowLayout } from "../../src/ui/browseViews.ts";
import { libraryScope } from "../../src/ui/libraryDiscovery.ts";
import { SORT_KEYS, sortKeysFor } from "../../src/ui/libraryBrowse.ts";
import { navigationRoots } from "../../src/ui/navigation.ts";

const wire = (type: string): Record<string, unknown> => ({ content_id: "audiobook:dune", type, title: "Dune", poster_url: "/art/dune" });
const card = (type: Card["type"]): Card => ({ id: "audiobook:dune", type, title: "Dune", year: undefined, posterUrl: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined });
const library = (id: string, type: UserLibrary["type"]): UserLibrary => ({ id, name: type, type, sortOrder: Number(id) });

test("a card keeps its audiobook media type, under every spelling Apple accepts", () => {
    for (const spelling of ["audiobook", "audiobooks", "book", "books"]) assert.equal(decodeCard(wire(spelling), "card").type, "audiobook", spelling);
    assert.equal(decodeCard(wire("podcast"), "card").type, "unknown");
});

test("audiobook query cards keep their type so they open the audiobook detail", () => {
    const page = decodeCatalogQueryPage({ items: [wire("audiobook")], page: { has_more: false }, total: 1, total_exact: true, window_cursor: "w" });
    assert.equal(page.items[0]?.type, "audiobook");
    assert.deepEqual(destinationOf(page.items[0] as Card), { kind: "audiobook", id: "audiobook:dune", title: "Dune" });
});

test("Home, For You and Search open an audiobook card on its own detail", () => {
    assert.deepEqual(destinationOf(card("audiobook")), { kind: "audiobook", id: "audiobook:dune", title: "Dune" });
    assert.deepEqual(browseCardDestination(card("audiobook")), { kind: "audiobook", id: "audiobook:dune", title: "Dune" });
    // A series id on an audiobook never reroutes it to a series page.
    assert.deepEqual(browseCardDestination({ ...card("audiobook"), seriesId: "series:s", episodeNumber: 2 }), { kind: "audiobook", id: "audiobook:dune", title: "Dune" });
});

test("a row of only audiobooks is square; any other mix keeps Apple's layout", () => {
    const book = { type: "audiobook" } as const;
    assert.equal(homeRowLayout("recently_added", [book, book]), "square");
    assert.equal(homeRowLayout("recently_added", [book, { type: "movie" }]), "poster");
    assert.equal(homeRowLayout("recently_added", []), "poster");
    // Apple checks the still rows first: Continue Watching stays a resume row of stills.
    assert.equal(homeRowLayout("continue_watching", [book]), "thumbnail");
    assert.equal(homeRowLayout("next_up", [book]), "thumbnail");
    assert.equal(homeRowLayout("recently_added", [{ type: "episode" }, book]), "poster");
});

test("Audiobooks joins the bar only with the opt-in on and a visible audiobook library", () => {
    const video = [library("1", "movies"), library("2", "series")];
    const books = library("3", "audiobooks");
    const keys = (libraries: readonly UserLibrary[], show: boolean): string[] => navigationRoots(null, libraries, false, show).map(root => root.key);
    assert.deepEqual(keys([...video, books], true), ["home", "movies", "series", "audiobooks", "for_you", "calendar"]);
    assert.deepEqual(keys([...video, books], false), ["home", "movies", "series", "for_you", "calendar"]);
    assert.deepEqual(keys(video, true), ["home", "movies", "series", "for_you", "calendar"], "a server with no audiobook library gains no tab");
    assert.deepEqual(keys([library("4", "music"), books], true), ["home", "music", "audiobooks", "for_you", "calendar"]);
    assert.equal(navigationRoots(null, [books], false, true).find(root => root.key === "audiobooks")?.title, "Audiobooks");
    assert.deepEqual(navigationRoots(null, [books], false).map(root => root.key), ["home", "for_you", "calendar"], "off by default");
});

test("a hidden audiobook library is not offered, and a visible one is kept for the bar", () => {
    const libraries = [library("1", "movies"), library("3", "audiobooks"), library("5", "audiobooks")];
    assert.deepEqual(visibleLibraries(libraries, ["5"]).map(item => item.id), ["1", "3"]);
});

test("Search All names no scope while audiobooks take part, and a video scope otherwise", () => {
    assert.equal(searchScope(undefined, true, true), undefined);
    assert.equal(searchScope(undefined, false, true), "video_with_episodes");
    assert.equal(searchScope(undefined, false, false), "video");
    assert.equal(searchScope("audiobook", true, true), "audiobook");
    assert.equal(searchScope("movie", true, true), "movie");
    assert.equal(searchScope("series", false, false), "series");
});

test("an audiobook library is scoped by its id alone, as Apple omits the type", () => {
    assert.deepEqual(libraryScope(library("3", "audiobooks")), { library_id: "3" });
    assert.deepEqual(libraryScope(library("1", "movies")), { library_id: "1", type: "movie" });
    const spec = operations.listCatalogItems({ q: "dune", type: undefined, limit: 60, cursor: undefined });
    assert.doesNotMatch(spec.path, /type=/);
});

test("audiobook libraries offer Apple's sort keys, in Apple's order", () => {
    assert.deepEqual(sortKeysFor("audiobooks").map(entry => [entry.key, entry.label, entry.order]), [
        ["title", "Title", "asc"], ["author", "Author", "asc"], ["narrator", "Narrator", "asc"],
        ["series", "Series", "asc"], ["added_at", "Date Added", "desc"], ["runtime", "Runtime", "desc"],
    ]);
    assert.deepEqual(sortKeysFor("movies"), SORT_KEYS);
});

test("Show Audiobooks is off until chosen, kept per profile, and survives unusable storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
    const first = new ShowAudiobooks(storage, "silo.nav.showAudiobooks:a");
    assert.equal(first.value, false);
    first.set(true);
    assert.equal(new ShowAudiobooks(storage, "silo.nav.showAudiobooks:a").value, true);
    assert.equal(new ShowAudiobooks(storage, "silo.nav.showAudiobooks:b").value, false, "another profile is untouched");
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => undefined };
    const session = new ShowAudiobooks(broken, "x");
    session.set(true);
    assert.equal(session.value, true, "the choice holds for this run");
});
