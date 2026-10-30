import assert from "node:assert/strict";
import { test } from "node:test";
import { detailOperations, type PersonalAction } from "../../src/api/detailOperations.ts";
import { decodeItemDetail } from "../../src/contracts/v2/catalog.ts";
import { decodePerson, decodeMembership, decodePersonalCapability } from "../../src/contracts/v2/details.ts";
import { playChoices } from "../../src/ui/browseModel.ts";
import { fixture } from "./support/fakeSilo.ts";

test("Details decodes real facts and person identity without manufacturing routes", () => {
    const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"),
        cast: [{ person_id: "person/a", name: "River Vale", character: "Alex", order: 0 }],
        crew: [{ name: "Sky Reed", job: "Director" }],
        ratings: [{ source: "plugin", name: "Critics", score: 90, display: "90%" }],
        studios: ["North Studio"], countries: ["AU"], original_language: "en",
    });
    assert.equal(detail.extra?.cast[0]?.id, "person/a");
    assert.equal(detail.extra?.crew[0]?.id, undefined);
    assert.equal(detail.extra?.ratings[0]?.display, "90%");
    assert.equal(decodePerson({ id: "7", name: "River Vale", bio: "Actor" }).bio, "Actor");
    assert.equal(decodeMembership({ item_id: "movie:a", is_member: false }).member, false);
    assert.equal(decodePersonalCapability({ state: "available", allowed: true, membership_supported: true, revision: "r" }), true);
    assert.equal(decodePersonalCapability({ state: "future", allowed: true, membership_supported: true, revision: "r" }), false);
    assert.throws(() => decodeMembership({ item_id: "movie:a", is_member: "false" }));
    assert.throws(() => decodePerson({ id: 7, name: "River Vale" }));
});

test("Details operations use pinned paths, bounded queries and explicit mutation safety", () => {
    assert.equal(detailOperations.person("a/b").path, "/catalog/people/a%2Fb");
    const filmography = new URL(detailOperations.filmography("a/b").path, "https://example.test");
    assert.equal(filmography.searchParams.get("source"), "person");
    assert.equal(filmography.searchParams.get("person_id"), "a/b");
    assert.equal(filmography.searchParams.get("type"), "video");
    assert.equal(filmography.searchParams.get("limit"), "24");
    assert.equal(detailOperations.similar("a/b").path, "/recommendations/similar/a%2Fb?limit=24&image_size=small");
    assert.equal(detailOperations.membership("watchlist", "a/b").path, "/watchlist/a%2Fb/membership");
    assert.equal(detailOperations.setPersonal("favorites", "a/b", true).method, "PUT");
    assert.equal(detailOperations.setPersonal("watched", "a/b", true).method, "POST");
    assert.equal(detailOperations.setPersonal("watched", "a/b", false).method, "DELETE");
    const kinds: PersonalAction[] = ["watchlist", "favorites", "watched"];
    for (const kind of kinds) {
        assert.equal(detailOperations.setPersonal(kind, "a/b", true).retry, "never", "UI retries only after an explicit press");
    }
});

test("explicit version selection preserves its file id and uses that file's end margin", () => {
    const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"), duration_seconds: 9000,
        versions: [{ file_id: "long", duration: 9000 }, { file_id: "short", duration: 1200 }],
        user_data: { played: false, position_seconds: 1196, last_file_id: "long" },
    });
    assert.equal(playChoices(detail)?.resume?.fileId, "long");
    assert.equal(playChoices(detail, "short")?.fromStart.fileId, "short");
    assert.equal(playChoices(detail, "short")?.resume, undefined);
    assert.equal(playChoices(detail, "missing"), undefined, "a removed explicit selection cannot silently play another file");
});

test("S-D3 watched flags are independent of optional progress and unknown stays unknown", () => {
    for (const type of ["movie", "episode"]) {
        const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"), type, user_data: undefined, user_state: { played: false } });
        assert.equal(detail.played, false);
        assert.equal(detail.watch, undefined);
    }
    assert.equal(decodeItemDetail({ ...fixture("get_catalog_item_ok"), user_data: undefined, user_state: undefined }).played, undefined);
    assert.equal(decodeItemDetail({ ...fixture("get_catalog_item_ok"), user_state: undefined, user_data: { played: false } }).played, false);
    assert.equal(decodeItemDetail({ ...fixture("get_catalog_item_ok"), user_state: { played: false }, user_data: { played: true } }).played, false);
    assert.throws(() => decodeItemDetail({ ...fixture("get_catalog_item_ok"), user_state: { played: "false" } }), /user_state.played/);
});
