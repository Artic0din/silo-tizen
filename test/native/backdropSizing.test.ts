import assert from "node:assert/strict";
import { test } from "node:test";
import { homeArtworkQuery, type ImageCapabilities } from "../../src/contracts/v2/images.ts";
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
