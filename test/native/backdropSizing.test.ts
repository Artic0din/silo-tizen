import assert from "node:assert/strict";
import { test } from "node:test";
import { detailArtworkQuery, episodeArtworkQuery, homeArtworkQuery, type ImageCapabilities } from "../../src/contracts/v2/images.ts";
import { operations } from "../../src/api/operations.ts";

const capability: ImageCapabilities = { state: "available", param: "image_size", sizes: ["small", "medium", "large"], slotWidthParams: {} };

test("Details requests large artwork, including episode stills used as backdrops", () => {
    assert.equal(operations.getCatalogItem("episode:e").path, "/catalog/items/episode%3Ae?image_size=large");
});

test("cold Home never stretches a small backdrop while its capability probe is pending", () => {
    assert.deepEqual(homeArtworkQuery(undefined, 1), { image_size: "large" });
});

test("tvOS uses large on servers without per-slot widths", () => {
    assert.deepEqual(homeArtworkQuery(capability, 1), { image_size: "large" });
});

test("tvOS asks for the 1344 fill width at display scale without inflating posters", () => {
    const slots = { ...capability, slotWidthParams: { backdrop: "backdrop_width", logo: "logo_width" } };
    assert.deepEqual(homeArtworkQuery(slots, 1), { image_size: "medium", logo_width: "880", backdrop_width: "1344" });
    assert.deepEqual(homeArtworkQuery(slots, 2), { image_size: "medium", logo_width: "1760", backdrop_width: "2688" });
    assert.equal(operations.getCatalogItem("episode:e", homeArtworkQuery(slots, 1)).path,
        "/catalog/items/episode%3Ae?image_size=medium&logo_width=880&backdrop_width=1344");
});

test("Details asks for Apple TV's detail slot widths, so cast photos are not fetched at 500 px for a 200 px circle", () => {
    const slots = { ...capability, slotWidthParams: { poster: "poster_width", backdrop: "backdrop_width", logo: "logo_width", still: "still_width", photo: "photo_width" } };
    assert.deepEqual(detailArtworkQuery(slots, 1), { image_size: "medium", logo_width: "880", backdrop_width: "1344", poster_width: "460", photo_width: "200" });
    assert.deepEqual(detailArtworkQuery(slots, 2), { image_size: "medium", logo_width: "1760", backdrop_width: "2688", poster_width: "920", photo_width: "400" });
    assert.equal(detailArtworkQuery(slots, 1).backdrop_width, homeArtworkQuery(slots, 1).backdrop_width, "opening an item reuses Home's hero backdrop");
});

test("Details keeps its one-size fallbacks without per-slot widths", () => {
    assert.deepEqual(detailArtworkQuery(undefined, 1), {});
    assert.deepEqual(detailArtworkQuery({ ...capability, state: "unavailable" }, 1), {});
    assert.deepEqual(detailArtworkQuery(capability, 1), { image_size: "large" });
});

test("the episode rail asks for stills at the 360 pt card width, as ArtworkSurface.episodes does on tvOS", () => {
    const slots = { ...capability, slotWidthParams: { still: "still_width", backdrop: "backdrop_width" } };
    assert.deepEqual(episodeArtworkQuery(slots, 1), { still_width: "360" });
    assert.deepEqual(episodeArtworkQuery(slots, 2), { still_width: "720" });
    assert.deepEqual(episodeArtworkQuery(slots, 1.5), { still_width: "540" });
    assert.equal(operations.listSeasonEpisodes("series:s", 1, episodeArtworkQuery(slots, 1)).path, "/catalog/series/series%3As/seasons/1/episodes?still_width=360");
});

test("the episode rail keeps the small one-size still without per-slot widths", () => {
    assert.deepEqual(episodeArtworkQuery(undefined, 1), {});
    assert.deepEqual(episodeArtworkQuery({ ...capability, state: "unavailable" }, 1), {});
    assert.deepEqual(episodeArtworkQuery(capability, 1), {});
    assert.equal(operations.listSeasonEpisodes("series:s", 1).path, "/catalog/series/series%3As/seasons/1/episodes?image_size=small");
});
