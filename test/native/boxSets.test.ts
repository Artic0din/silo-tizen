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
    boxSetPlayVerb,
    boxSetYears,
    decodeCatalogBoxSetDetail,
    decodeCatalogBoxSetList,
    decodeCatalogItemBoxSet,
} from "../../src/contracts/v2/boxSets.ts";
import type { NativeSession } from "../../src/session/session.ts";
import { BoxSetRowState, boxSetRowFilms, boxSetRowSlots, boxSetRowStart } from "../../src/ui/boxSetRow.ts";
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

test("a movie page reads its box set, and the row keeps the film on screen", () => {
    const detail = decodeCatalogBoxSetDetail({ ...harryPotter, items: [movie("hp1", "Philosopher's Stone", 2001, true), movie("hp2", "Chamber of Secrets", 2002, false)] });
    assert.equal(decodeCatalogItemBoxSet({ box_set: { ...harryPotter, items: detail.items.map(item => movie(item.id, item.title, item.year ?? 0, item.played === true)) } })?.boxSet.id, "1241");
    assert.equal(decodeCatalogItemBoxSet({}), undefined);
    assert.equal(decodeCatalogItemBoxSet({ box_set: null }), undefined);
    assert.equal(boxSetOperations.forItem("movie:m0001").path, "/catalog/items/movie%3Am0001/box-set?image_size=medium");
    assert.equal(boxSetOperations.forItem("movie:m0001", "12").path, "/catalog/items/movie%3Am0001/box-set?image_size=medium&library_id=12");
    assert.equal(boxSetOperations.forItem("movie:m0001").retry, "safe");
    assert.equal(boxSetPlayVerb(detail), "Continue");
    const finished = decodeCatalogBoxSetDetail({ ...harryPotter, movie_count: 2, played_count: 2, items: [movie("a", "Azkaban", 2004, true)] });
    assert.equal(boxSetPlayVerb(finished), "Play");

    const cases: { current: number | undefined; count: number; slots: number; start: number }[] = [
        { current: 1, count: 8, slots: 2, start: 0 },
        { current: 2, count: 8, slots: 2, start: 1 },
        { current: 5, count: 10, slots: 5, start: 4 },
        { current: 7, count: 8, slots: 2, start: 6 },
        { current: 7, count: 8, slots: 5, start: 3 },
        { current: 2, count: 3, slots: 5, start: 0 },
        { current: undefined, count: 8, slots: 2, start: 0 },
    ];
    for (const sample of cases) assert.equal(boxSetRowStart(sample.current, sample.count, sample.slots), sample.start);
    assert.equal(boxSetRowSlots(1744, 220, 44), 6);
    const films = Array.from({ length: 8 }, (_, index) => ({ id: `hp${index}` }));
    assert.deepEqual(boxSetRowFilms(films, "hp7", 6, true).map(film => film.id), ["hp3", "hp4", "hp5", "hp6", "hp7"]);
});

test("a finished box-set row refreshes when the movie is marked watched, and Back restarts a cancelled read once", async () => {
    const pending: Array<(detail: ReturnType<typeof decodeCatalogBoxSetDetail>) => void> = [];
    const session = {
        call: () => new Promise(resolve => pending.push(resolve)),
    } as unknown as NativeSession;
    const row = new BoxSetRowState(session, "movie:m0001", async () => true, () => undefined);
    const answer = (played: boolean) => decodeCatalogBoxSetDetail({
        ...harryPotter,
        played_count: played ? 1 : 0,
        items: [movie("movie:m0001", "Philosopher's Stone", 2001, played)],
    });
    const settle = async (): Promise<void> => {
        await Promise.resolve();
        await Promise.resolve();
    };
    const take = (index: number): (detail: ReturnType<typeof decodeCatalogBoxSetDetail>) => void => {
        const resolve = pending[index];
        assert.ok(resolve, `box-set read ${index + 1} was sent`);
        return resolve;
    };

    row.start();
    await settle();
    assert.equal(pending.length, 1);
    row.start();
    await settle();
    assert.equal(pending.length, 1, "a read still out is left alone");
    take(0)(answer(false));
    await settle();
    assert.equal(row.detail?.items[0]?.played, false);

    row.start();
    await settle();
    assert.equal(pending.length, 2, "marking the movie watched rereads the finished row");
    take(1)(answer(true));
    await settle();
    assert.equal(row.detail?.items[0]?.played, true, "the row shows the film as watched");

    row.start();
    await settle();
    const held = pending.length;
    assert.equal(held, 3);
    row.stop();
    row.start();
    await settle();
    assert.equal(pending.length, held + 1, "Back starts the cancelled read again");
    row.start();
    await settle();
    assert.equal(pending.length, held + 1, "Back starts that read once");
    take(held - 1)(answer(true));
    await settle();
    assert.equal(row.detail?.items[0]?.played, true, "the cancelled answer does not replace the row");
    take(held)(answer(false));
    await settle();
    assert.equal(row.detail?.items[0]?.played, false);
});
