import assert from "node:assert/strict";
import { test } from "node:test";
import type { Card, Episode } from "../../src/contracts/v2/catalog.ts";
import type { SettingsCapabilities } from "../../src/contracts/v2/settings.ts";
import { SPOILER_IMAGE_KEY, SPOILER_OVERVIEW_KEY } from "../../src/contracts/v2/settings.ts";
import {
    EPISODE_SPOILER_BLUR_PX,
    SPOILER_INTRODUCED_IN,
    decodeSpoilerEffective,
    episodeDetailPresentation,
    hidesCardImage,
    hidesCardOverview,
    hidesEpisodeImage,
    hidesEpisodeListStill,
    hidesEpisodeOverview,
    isEpisodeUnwatched,
    marqueeUsesSeriesArt,
    spoilerSettingsSupported,
    type EpisodeSpoilerSettings,
    type EpisodeWatchState,
} from "../../src/ui/episodeSpoilers.ts";

const off: EpisodeSpoilerSettings = { hidesImages: false, hidesOverviews: false };
const images: EpisodeSpoilerSettings = { hidesImages: true, hidesOverviews: false };
const text: EpisodeSpoilerSettings = { hidesImages: false, hidesOverviews: true };
const both: EpisodeSpoilerSettings = { hidesImages: true, hidesOverviews: true };
const unwatched: EpisodeWatchState = { played: false };
const started: EpisodeWatchState = { played: false, isInProgress: true, positionSeconds: 0 };
const resumed: EpisodeWatchState = { played: false, positionSeconds: 12 };

function capability(revision: number, extras: Partial<SettingsCapabilities> = {}): SettingsCapabilities {
    return {
        apiVersion: 1,
        revision: "opaque",
        manifestRevision: revision,
        state: "available",
        allowed: true,
        scopes: ["profile"],
        supportsBatchedEffective: true,
        supportsAtomicShortcuts: true,
        clientFamilies: ["tv"],
        ...extras,
    };
}

test("unwatched episodes are those never started, and both switches default off", () => {
    assert.equal(SPOILER_INTRODUCED_IN, 17);
    assert.equal(EPISODE_SPOILER_BLUR_PX, 24);
    assert.equal(isEpisodeUnwatched(undefined), true, "missing user data has never been touched");
    assert.equal(isEpisodeUnwatched(unwatched), true);
    assert.equal(isEpisodeUnwatched({ played: false, isInProgress: false, positionSeconds: 0 }), true);
    assert.equal(isEpisodeUnwatched({ played: true }), false);
    assert.equal(isEpisodeUnwatched(started), false, "in progress counts as started even at position 0");
    assert.equal(isEpisodeUnwatched(resumed), false);
    assert.equal(hidesEpisodeImage(off, unwatched, true), false);
    assert.equal(hidesEpisodeOverview(off, unwatched), false);
});

test("image and description switches hide only an unwatched episode still", () => {
    assert.equal(hidesEpisodeImage(images, unwatched, true), true);
    assert.equal(hidesEpisodeImage(images, unwatched, undefined), true, "unknown provenance is protected");
    assert.equal(hidesEpisodeImage(images, unwatched, false), false, "series or season art stays visible");
    assert.equal(hidesEpisodeImage(images, started, true), false);
    assert.equal(hidesEpisodeImage(images, { played: true }, true), false);
    assert.equal(hidesEpisodeImage(text, unwatched, true), false);
    assert.equal(hidesEpisodeOverview(text, unwatched), true);
    assert.equal(hidesEpisodeOverview(text, resumed), false);
    assert.equal(hidesEpisodeOverview(images, unwatched), false);
    assert.equal(hidesEpisodeOverview(both, { played: true }), false);
});

test("cards, lists, the marquee and episode detail keep series art and series text", () => {
    const episode: Card = { id: "episode:1", type: "episode", title: "Pilot", year: undefined, posterUrl: "/still.jpg", backdropUrl: "/still.jpg", posterIsEpisodeStill: true, backdropIsEpisodeStill: true, seriesBackdropUrl: "/series.jpg", overview: "The door opens.", played: false, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined };
    const series: Card = { ...episode, id: "series:1", type: "series", overview: "A coastal observatory." };
    const startedCard: Card = { ...episode, played: false, positionSeconds: 30 };
    assert.equal(hidesCardImage(episode, both, false), true);
    assert.equal(hidesCardImage(episode, both, true), true);
    assert.equal(hidesCardImage({ ...episode, backdropUrl: undefined, posterIsEpisodeStill: false }, both, false), false);
    assert.equal(hidesCardImage(series, both, false), false);
    assert.equal(hidesCardImage(startedCard, both, true), false);
    assert.equal(hidesCardOverview(episode, both), true);
    assert.equal(hidesCardOverview(series, both), false);
    assert.equal(hidesCardOverview(startedCard, text), false);
    assert.equal(marqueeUsesSeriesArt(episode, both), true, "a series backdrop is never treated as a still");
    assert.equal(marqueeUsesSeriesArt({ ...episode, seriesBackdropUrl: undefined }, both), false);
    assert.equal(marqueeUsesSeriesArt({ ...episode, seriesBackdropUrl: undefined, backdropIsEpisodeStill: false }, both), false);
    const row: Episode = { id: "episode:1", seasonNumber: 1, episodeNumber: 2, title: "Pilot", runtimeMinutes: 40, stillUrl: "/still.jpg", played: false, stillIsEpisodeStill: true };
    assert.equal(hidesEpisodeListStill(row, both), true);
    assert.equal(hidesEpisodeListStill({ ...row, played: true }, both), false);
    assert.equal(hidesEpisodeListStill({ ...row, isInProgress: true }, both), false);
    assert.equal(hidesEpisodeListStill({ ...row, stillIsEpisodeStill: false }, both), false);
    const detail = { id: "episode:1", type: "episode" as const, title: "Pilot", overview: "The door opens.", posterUrl: "/poster.jpg", backdropUrl: "/still.jpg", backdropIsEpisodeStill: true, genres: [], versions: [], played: false, watch: { played: false, positionSeconds: undefined, lastFileId: undefined } };
    assert.deepEqual(episodeDetailPresentation(detail, both), { overview: undefined, hideBackdrop: true });
    assert.deepEqual(episodeDetailPresentation(detail, both, true), { overview: "The door opens.", hideBackdrop: false }, "marking watched reveals the still and the text");
    assert.deepEqual(episodeDetailPresentation({ ...detail, type: "series", overview: "A coastal observatory." }, both), { overview: "A coastal observatory.", hideBackdrop: false });
    assert.deepEqual(episodeDetailPresentation({ ...detail, backdropUrl: undefined, posterIsEpisodeStill: false }, images), { overview: "The door opens.", hideBackdrop: false });
});

test("spoiler settings appear only when the server serves both revision-17 keys", () => {
    assert.equal(spoilerSettingsSupported(capability(17)), true);
    assert.equal(spoilerSettingsSupported(capability(24)), true);
    assert.equal(spoilerSettingsSupported(capability(16)), false);
    assert.equal(spoilerSettingsSupported(capability(17, { supportsBatchedEffective: false })), false);
    assert.equal(spoilerSettingsSupported(capability(17, { allowed: false })), false);
    assert.equal(spoilerSettingsSupported(capability(17, { state: "unavailable" })), false);
    assert.equal(spoilerSettingsSupported(undefined), false);
    assert.deepEqual(decodeSpoilerEffective({ revision: 17, items: [{ key: SPOILER_IMAGE_KEY, value: true }, { key: SPOILER_OVERVIEW_KEY, value: false }] }), images);
    assert.deepEqual(decodeSpoilerEffective({ revision: 17, items: [] }), off, "a missing key is the default");
    assert.deepEqual(decodeSpoilerEffective({ revision: 17, items: [{ key: SPOILER_IMAGE_KEY, value: "yes" }, { key: SPOILER_OVERVIEW_KEY, value: 1 }] }), off, "a non-boolean reads as off");
});
