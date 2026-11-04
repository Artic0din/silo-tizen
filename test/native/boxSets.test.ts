import assert from "node:assert/strict";
import { test } from "node:test";
import { boxSetOperations } from "../../src/api/boxSetOperations.ts";
import { fixture } from "./support/fakeSilo.ts";
import { decodeCatalogSearchCapabilities } from "../../src/contracts/v2/discovery.ts";
import {
    boxSetCardCaption,
    boxSetFacts,
    boxSetFilmCount,
    boxSetPlayLabel,
    boxSetYears,
    decodeCatalogBoxSetDetail,
    decodeCatalogBoxSetList,
} from "../../src/contracts/v2/boxSets.ts";
import { WireError } from "../../src/contracts/v2/wire.ts";

const harryPotter = {
    id: "1241",
    library_id: "1",
    title: "Harry Potter Collection",
    overview: "Wizards.",
    poster_url: "/api/v2/artwork/tmdb/collections/1241/poster/w300.webp",
    poster_thumbhash: "x/cF",
    movie_count: 8,
    played_count: 3,
    first_year: 2001,
    last_year: 2011,
};

function movie(id: string, title: string, year: number, played: boolean): Record<string, unknown> {
    return { content_id: id, type: "movie", title, year, user_state: { played, is_favorite: false, in_watchlist: false } };
}

test("box set reads keep release order, Apple's captions, and the search capability", () => {
    const detail = decodeCatalogBoxSetDetail({
        ...harryPotter,
        items: [
            movie("hp1", "Philosopher's Stone", 2001, true),
            movie("hp2", "Chamber of Secrets", 2002, false),
            movie("hp3", "Prisoner of Azkaban", 2004, true),
        ],
    });
    assert.deepEqual(detail.items.map(item => item.id), ["hp1", "hp2", "hp3"]);
    assert.equal(detail.items[1]?.played, false);
    assert.equal(boxSetPlayLabel(detail), "Continue · Chamber of Secrets");
    const finished = decodeCatalogBoxSetDetail({
        ...harryPotter,
        movie_count: 2,
        played_count: 2,
        items: [movie("a", "Azkaban", 2004, true), movie("b", "Goblet", 2005, true)],
    });
    assert.equal(boxSetPlayLabel(finished), "Play Azkaban");
    assert.deepEqual(boxSetFacts(detail), ["8 films", "2001 – 2011", "3 of 8 watched"]);
    assert.equal(boxSetCardCaption(detail.boxSet), "3 / 8 watched");
    assert.equal(boxSetYears(2001, 2011), "2001 – 2011");
    assert.equal(boxSetYears(2021, 2021), "2021");
    assert.equal(boxSetYears(undefined, undefined), undefined);
    assert.equal(boxSetFilmCount(1), "1 film");
    assert.equal(boxSetFilmCount(4), "4 films");
    assert.equal(decodeCatalogBoxSetList({ items: [harryPotter] })[0]?.id, "1241");
    assert.deepEqual(decodeCatalogBoxSetList({ items: [] }), []);

    const capability = fixture("get_catalog_search_capabilities_ok");
    assert.equal(decodeCatalogSearchCapabilities(capability).boxSets, undefined);
    assert.equal(decodeCatalogSearchCapabilities({ ...capability, box_sets: true }).boxSets, true);
    assert.equal(decodeCatalogSearchCapabilities({ ...capability, box_sets: false }).boxSets, false);
    assert.throws(() => decodeCatalogSearchCapabilities({ ...capability, box_sets: "true" }), WireError);
    assert.throws(() => decodeCatalogBoxSetDetail({ ...harryPotter, items: [{ content_id: 1 }] }), WireError);

    assert.equal(boxSetOperations.search("harry potter", 5).path, "/catalog/box-sets?q=harry%20potter&limit=5");
    assert.equal(boxSetOperations.search("harry potter", 5).retry, "safe");
    assert.equal(boxSetOperations.get("1241", "1").path, "/catalog/box-sets/1241?library_id=1&image_size=medium");
    assert.throws(() => boxSetOperations.search("  ", 5), RangeError);
    assert.throws(() => boxSetOperations.search("potter", 21), RangeError);
    assert.throws(() => boxSetOperations.get("1241", ""), RangeError);
});
