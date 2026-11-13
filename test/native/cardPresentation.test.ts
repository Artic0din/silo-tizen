import assert from "node:assert/strict";
import { test } from "node:test";
import type { Card } from "../../src/contracts/v2/catalog.ts";
import { cardYears, homeCaption, marqueeBadges, marqueeMeta, marqueeRating, runtimeText } from "../../src/ui/cardPresentation.ts";

const episode: Card = { id: "episode:e", type: "episode", title: "Fire Drill", year: 2026, posterUrl: undefined, seriesId: "series:s", seriesTitle: "Abbott", seasonNumber: 9, episodeNumber: 8 };

test("runtime and time left use Apple's minute formatting and progress limits", () => {
    assert.deepEqual([0, 45, 60, 135].map(runtimeText), [undefined, "45m", "1h 0m", "2h 15m"]);
    assert.deepEqual(marqueeMeta({ ...episode, durationSeconds: 1290, positionSeconds: 450 }, true), { lead: ["S9 E8", "Fire Drill", "22m"], trailing: ["14m left"] }, "runtime falls back to the rounded duration");
    assert.deepEqual(marqueeMeta({ ...episode, durationSeconds: 1000, positionSeconds: 950 }, true), { lead: ["S9 E8", "Fire Drill", "17m"], trailing: [] }, "95% watched shows no time left");
    assert.deepEqual(marqueeMeta({ ...episode, durationSeconds: 1000, positionSeconds: 940 }, true), { lead: ["S9 E8", "Fire Drill", "17m"], trailing: ["1m left"] });
    assert.deepEqual(marqueeMeta({ ...episode, durationSeconds: 1000, positionSeconds: 400 }, false), { lead: ["S9 E8", "Fire Drill", "17m"], trailing: [] }, "time left is Continue Watching only");
    assert.deepEqual(marqueeMeta({ ...episode, seasonNumber: undefined }, false), { lead: ["Episode 8", "Fire Drill"], trailing: [] });
    assert.deepEqual(marqueeMeta({ ...episode, type: "movie", genres: ["", "Drama"], year: 0 }, false), { lead: ["Drama"], trailing: [] });
});

test("file chips normalise resolution, Dolby Vision and Atmos", () => {
    assert.deepEqual(marqueeBadges({ resolution: "UHD", hdr: "DV", audio: "Dolby Atmos" }), ["4K", "DOLBY VISION", "ATMOS"]);
    assert.deepEqual(marqueeBadges({ resolution: " 720P ", hdr: "hdr10", audio: " " }), ["720p", "HDR10"]);
    assert.deepEqual(marqueeBadges({ resolution: "sd", hdr: undefined, audio: undefined }), ["SD"]);
    assert.deepEqual(marqueeBadges(undefined), []);
});

test("Home captions episodes by series and drop titles that repeat it", () => {
    assert.deepEqual(homeCaption(episode, false), { title: "Abbott", line: "S09E08 · Fire Drill" });
    assert.deepEqual(homeCaption({ ...episode, title: "abbott " }, true), { title: "Abbott", line: "S09E08" });
    assert.deepEqual(homeCaption({ ...episode, seriesTitle: " " }, false), { title: "Fire Drill", line: "S09E08 · Fire Drill" });
    assert.deepEqual(homeCaption({ ...episode, type: "movie", seriesTitle: undefined }, true), { title: "Fire Drill", line: "2026" });
});

test("the marquee rating is IMDb, else TMDB, out of 10 with one decimal, never for episodes", () => {
    const movie: Card = { ...episode, type: "movie" };
    assert.deepEqual(marqueeRating({ ...movie, ratingImdb: 8.46, ratingTmdb: 7 }), { name: "IMDb", display: "8.5" });
    assert.deepEqual(marqueeRating({ ...movie, ratingImdb: 0, ratingTmdb: 7 }), { name: "TMDB", display: "7.0" }, "an unusable IMDb score falls back");
    assert.deepEqual(marqueeRating({ ...movie, ratingImdb: 10.5, ratingTmdb: Number.NaN }), undefined);
    assert.deepEqual(marqueeRating({ ...episode, ratingImdb: 9 }), undefined);
});

test("cardYears follows Apple CardYears: a series shows the years it ran", () => {
    const series = (showStatus: string | undefined, lastAirDate?: string, year: number | undefined = 2019): Card => ({ id: "series:s", type: "series", title: "Show", year, posterUrl: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined, showStatus, ...(lastAirDate === undefined ? {} : { lastAirDate }) });
    assert.equal(cardYears(series("returning", undefined, 2024)), "2024 – Present");
    assert.equal(cardYears(series("ended", "2023-05-28")), "2019 – 2023");
    assert.equal(cardYears(series("cancelled", "2023-05-28")), "2019 – 2023");
    assert.equal(cardYears(series("ended")), "2019", "an ended series without a last air date shows its year");
    assert.equal(cardYears(series("ended", "2019-12-01")), "2019", "a series that ended the year it started shows one year");
    assert.equal(cardYears(series("in production", "2023-05-28")), "2019", "other airing states show the year");
    assert.equal(cardYears(series(undefined)), "2019");
    assert.equal(cardYears({ ...series("returning"), year: undefined }), undefined);
    assert.equal(cardYears({ ...series("returning"), type: "movie" }), "2019", "only a series shows a range");
    assert.equal(cardYears({ ...series("returning"), year: 12345 }), "12345 – Present", "years are not grouped (LocaleFormat.integer)");
});
