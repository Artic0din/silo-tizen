import assert from "node:assert/strict";
import { test } from "node:test";
import { artworkSymbol } from "../../src/ui/defaultArtwork.ts";

// silo-apple ArtworkPlaceholderSymbol.forMediaType, which SiloMediaType's type spellings feed.
test("the placeholder mark follows the catalog type the way Apple's ArtworkPlaceholderSymbol does", () => {
    const expected: ReadonlyArray<readonly [string | undefined, string]> = [
        [undefined, "film"],
        ["movie", "film"],
        ["movies", "film"],
        ["collection", "film"],
        ["", "film"],
        ["series", "tv"],
        ["show", "tv"],
        ["shows", "tv"],
        ["tv", "tv"],
        ["tvshows", "tv"],
        ["episode", "tv"],
        ["episodes", "tv"],
        ["season", "tv"],
        ["season_premiere", "tv"],
        ["audiobook", "headphones"],
        ["audiobooks", "headphones"],
        ["book", "headphones"],
        ["books", "headphones"],
        ["podcast", "headphones"],
        ["podcasts", "headphones"],
        ["ebook", "book.closed"],
        ["ebooks", "book.closed"],
        ["manga", "book.closed"],
        ["comic", "book.closed"],
        ["comics", "book.closed"],
        ["  Series ", "tv"],
        ["EPISODE", "tv"],
        ["Ebook", "book.closed"],
    ];
    for (const [type, symbol] of expected) assert.equal(artworkSymbol(type), symbol, JSON.stringify(type));
});
