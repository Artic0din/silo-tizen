import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserLibrary } from "../../src/contracts/v2/catalog.ts";
import { browseQuery, DEFAULT_FILTER, SORT_KEYS, toggled, withSort, reset, BrowsePrefs } from "../../src/ui/libraryBrowse.ts";

const library: UserLibrary = { id: "12", name: "Movies", type: "movies", sortOrder: 0 };

test("Browse uses Apple's seven video sorts and flips only the selected key", () => {
    assert.deepEqual(SORT_KEYS.map(item => [item.key, item.order]), [["title", "asc"], ["added_at", "desc"], ["release_date", "desc"], ["year", "desc"], ["rating_imdb", "desc"], ["runtime", "desc"], ["resolution", "desc"]]);
    for (const sort of SORT_KEYS) {
        const chosen = sort.key === "title" ? DEFAULT_FILTER : withSort(DEFAULT_FILTER, sort.key);
        assert.equal(browseQuery(chosen, library, 100).order, sort.order);
        assert.equal(browseQuery(withSort(chosen, sort.key), library, 100).order, sort.order === "asc" ? "desc" : "asc");
    }
});

test("Browse composes prefix, sort, typed facet values and All/Any groups", () => {
    let filter = toggled(toggled(toggled(DEFAULT_FILTER, "genre", "Drama"), "genre", "Crime"), "decade", "1990");
    filter = toggled(toggled(filter, "dynamicRange", "hdr"), "watchStatus", "unwatched");
    filter = { ...withSort(filter, "added_at"), prefix: "#", matchAll: false };
    assert.deepEqual(browseQuery(filter, library, 100), {
        library_id: "12", type: "movie", limit: 100, sort: "added_at", order: "desc", match: "any", name_prefix: "#",
        groups: [
            { match: "any", rules: [{ field: "genre", op: "contains", value: "Crime" }, { field: "genre", op: "contains", value: "Drama" }] },
            { match: "any", rules: [{ field: "year", op: "between", value: [1990, 1999] }] },
            { match: "any", rules: [{ field: "hdr", op: "is", value: true }] },
            { match: "all", rules: [{ field: "watched", op: "is", value: false }] },
        ],
    });
    assert.deepEqual(reset(filter), { ...filter, matchAll: true, values: {} });
});

test("preserved Browse preferences keep filters but never the transient prefix", () => {
    const values = new Map<string, string>();
    const prefs = new BrowsePrefs({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }, "server-profile");
    const filter = { ...toggled(DEFAULT_FILTER, "genre", "Drama"), prefix: "T" };
    prefs.save(library, filter);
    assert.deepEqual(prefs.saved(library), { ...filter, prefix: undefined });
    assert.equal(new BrowsePrefs(undefined, "other-owner").saved(library), undefined);
    prefs.setPreserve(library, false);
    assert.equal(prefs.saved(library), undefined);
});

test("Movies and Series slices of one library keep separate preferences and preserve choices", () => {
    const values = new Map<string, string>();
    const prefs = new BrowsePrefs({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }, "server-profile");
    const series: UserLibrary = { ...library, type: "series" };
    const moviesFilter = withSort(DEFAULT_FILTER, "added_at"), seriesFilter = withSort(DEFAULT_FILTER, "year");
    prefs.save(library, moviesFilter); prefs.save(series, seriesFilter);
    assert.deepEqual(prefs.saved(library), moviesFilter);
    assert.deepEqual(prefs.saved(series), seriesFilter);
    prefs.setPreserve(series, false);
    assert.equal(prefs.saved(series), undefined);
    assert.deepEqual(prefs.saved(library), moviesFilter);
});

test("the preserve choice still works for the current session when optional storage is unavailable", () => {
    for (const storage of [undefined, { getItem: () => { throw new Error("unavailable"); }, setItem: () => { throw new Error("unavailable"); }, removeItem: () => { throw new Error("unavailable"); } }]) {
        const prefs = new BrowsePrefs(storage, "server-profile");
        prefs.setPreserve(library, false);
        assert.equal(prefs.preserve(library), false);
        prefs.save(library, withSort(DEFAULT_FILTER, "year"));
        assert.equal(prefs.saved(library), undefined);
        prefs.setPreserve(library, true);
        assert.equal(prefs.preserve(library), true);
    }
});
