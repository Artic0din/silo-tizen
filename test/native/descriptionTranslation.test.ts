import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import { decodeCard, decodeEpisodes, decodeItemDetail } from "../../src/contracts/v2/catalog.ts";
import { decodeDescriptionTranslationJob, decodeMetadataAICapability } from "../../src/contracts/v2/descriptionTranslation.ts";
import { descriptionTranslationOperations } from "../../src/api/descriptionTranslationOperations.ts";
import {
    DESCRIPTION_TRANSLATION_POLL_MS,
    MARQUEE_TRANSLATION_DWELL_MS,
    CardDescriptionTranslation,
    DescriptionTranslationCoordinator,
    descriptionTargets,
    descriptionTranslationStatus,
    marqueeTranslationRequest,
    type DescriptionJob,
} from "../../src/ui/descriptionTranslation.ts";
import { WireError } from "../../src/contracts/v2/wire.ts";
import { ManualClock } from "./support/clock.ts";
import { fixture } from "./support/fakeSilo.ts";

const capability = { allowed: true, on_view: "button", revision: "rev-1", state: "available" };
const job = (status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "job-1", target_kind: "item", content_id: "movie:heat-1995", target_language: "de", status, ...extra,
});

test("metadata AI enables on-view translation only when the profile is allowed and the state is available", () => {
    assert.deepEqual(decodeMetadataAICapability(capability), { enabled: true, onView: "button" });
    assert.deepEqual(decodeMetadataAICapability({ ...capability, on_view: "auto" }), { enabled: true, onView: "auto" });
    assert.deepEqual(decodeMetadataAICapability({ ...capability, on_view: "off" }), { enabled: true, onView: "off" });
    assert.deepEqual(decodeMetadataAICapability({ ...capability, on_view: "later" }), { enabled: true, onView: "off" });
    assert.deepEqual(decodeMetadataAICapability({ ...capability, state: "not_configured" }), { enabled: false, onView: "off" });
    assert.deepEqual(decodeMetadataAICapability({ ...capability, allowed: false }), { enabled: false, onView: "off" });
    assert.deepEqual(decodeMetadataAICapability({ ...capability, state: "disabled" }), { enabled: false, onView: "off" });
    assert.throws(() => decodeMetadataAICapability({ ...capability, revision: "" }), WireError);
});

test("a description job is failed when the server returns failed, canceled or cancelled", () => {
    assert.equal(decodeDescriptionTranslationJob(job("pending"), "movie:heat-1995").failed, false);
    assert.equal(decodeDescriptionTranslationJob(job("running"), "movie:heat-1995").failed, false);
    for (const status of ["failed", "canceled", "cancelled"]) {
        assert.equal(decodeDescriptionTranslationJob(job(status), "movie:heat-1995").failed, true, status);
    }
    assert.throws(() => decodeDescriptionTranslationJob(job("pending", { content_id: "other" }), "movie:heat-1995"), WireError);
    assert.throws(() => decodeDescriptionTranslationJob(job("pending", { target_kind: "library" }), "movie:heat-1995"), WireError);
    assert.throws(() => decodeDescriptionTranslationJob(job("pending", { id: "" }), "movie:heat-1995"), WireError);
});

test("cards, details and episodes keep pending language and machine-translated fields", () => {
    const sample = (fixture("list_catalog_items_ok").items as Record<string, unknown>[])[0];
    const card = decodeCard({ ...sample, pending_translation_language: "de", machine_translated_fields: ["tagline"] }, "card");
    assert.equal(card.pendingTranslationLanguage, "de");
    assert.deepEqual(card.machineTranslatedFields, ["tagline"]);
    const cleared = decodeCard({ ...sample, pending_translation_language: "" }, "card");
    assert.equal(cleared.pendingTranslationLanguage, undefined);
    const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"), pending_translation_language: "de", machine_translated_fields: ["overview", "tagline"] });
    assert.equal(detail.pendingTranslationLanguage, "de");
    assert.deepEqual(detail.machineTranslatedFields, ["overview", "tagline"]);
    const episodes = decodeEpisodes({ items: [{ content_id: "episode:1", season_number: 1, episode_number: 1, title: "Pilot", runtime: 40, pending_translation_language: "de", machine_translated_fields: ["overview"] }] });
    assert.equal(episodes[0]?.pendingTranslationLanguage, "de");
    assert.deepEqual(episodes[0]?.machineTranslatedFields, ["overview"]);
    assert.throws(() => decodeCard({ ...sample, machine_translated_fields: "overview" }, "card"), WireError);
});

test("overview status is Translating while a run is current and Translated by AI only when overview was machine-translated", () => {
    assert.deepEqual(descriptionTranslationStatus(true, ["overview"]), { kind: "translating", text: "Translating…" });
    assert.deepEqual(descriptionTranslationStatus(false, ["overview", "tagline"]), { kind: "machine-translated", text: "Translated by AI" });
    assert.equal(descriptionTranslationStatus(false, ["tagline"]), undefined);
    assert.equal(descriptionTranslationStatus(false, []), undefined);
    assert.equal(descriptionTranslationStatus(false, undefined), undefined);
});

test("the featured marquee is the only card that starts a translation, and only in auto mode", () => {
    assert.equal(MARQUEE_TRANSLATION_DWELL_MS, 1500);
    assert.deepEqual(DESCRIPTION_TRANSLATION_POLL_MS, [1000, 2000, 2000, 3000, 3000, 4000, 5000, 5000, 5000, 5000, 5000, 5000]);
    assert.deepEqual(marqueeTranslationRequest(true, "auto", "movie:1", "de"), { contentId: "movie:1", targetLanguage: "de" });
    assert.equal(marqueeTranslationRequest(false, "auto", "movie:1", "de"), undefined);
    assert.equal(marqueeTranslationRequest(true, "button", "movie:1", "de"), undefined);
    assert.equal(marqueeTranslationRequest(true, "off", "movie:1", "de"), undefined);
    assert.equal(marqueeTranslationRequest(true, "auto", "movie:1", undefined), undefined);
    assert.equal(marqueeTranslationRequest(true, "auto", "movie:1", ""), undefined);
});

function detail(pending: string | undefined, overview = "Original", fields?: readonly string[]) {
    const base = decodeItemDetail(fixture("get_catalog_item_ok"));
    return { ...base, ...(pending === undefined ? {} : { pendingTranslationLanguage: pending }), overview, ...(fields === undefined ? {} : { machineTranslatedFields: fields }) };
}

test("a run posts the pending language, polls until it clears, and an automatic run starts once", async () => {
    const clock = new ManualClock();
    const posts: string[] = [];
    let pending: string | undefined = "de";
    const coordinator = new DescriptionTranslationCoordinator(clock, async (key) => {
        posts.push(key.targetLanguage);
        const result: DescriptionJob = { id: "job-1", targetKind: "item", contentId: key.contentId, targetLanguage: key.targetLanguage, status: "pending", failed: false };
        return result;
    });
    const key = { contentId: "movie:heat-1995", targetLanguage: "de" };
    assert.equal(coordinator.translateAutomatically(key, async () => detail(pending), (value) => {
        if (Array.isArray(value)) return false;
        pending = (value as { pendingTranslationLanguage?: string }).pendingTranslationLanguage;
        return pending === undefined;
    }), true);
    assert.equal(coordinator.translateAutomatically(key, async () => detail(pending), () => false), false);
    assert.equal(coordinator.phase, "translating");
    assert.deepEqual(posts, ["de"]);
    await clock.advance(1000);
    assert.equal(coordinator.phase, "translating", "the first read still reports the language missing");
    pending = undefined;
    await clock.advance(2000);
    assert.equal(coordinator.phase, "idle");
    assert.deepEqual(posts, ["de"]);
});

test("a refused or failed job does one confirming read, and the cap reports failure", async () => {
    const clock = new ManualClock();
    let reads = 0;
    const refused = new DescriptionTranslationCoordinator(clock, async () => { throw new ApiError({ kind: "http", status: 422, retryAfterSeconds: undefined }); });
    const key = { contentId: "movie:heat-1995", targetLanguage: "de" };
    refused.translate(key, async () => { reads += 1; return detail(undefined, "Already there", ["overview"]); }, (value) => Array.isArray(value) ? false : (value as { pendingTranslationLanguage?: string }).pendingTranslationLanguage === undefined);
    await clock.advance(0);
    assert.equal(reads, 1);
    assert.equal(refused.phase, "idle");

    const failedJob = new DescriptionTranslationCoordinator(clock, async (jobKey) => ({ id: "job-1", targetKind: "item", contentId: jobKey.contentId, targetLanguage: jobKey.targetLanguage, status: "failed", failed: true }));
    let polled = 0;
    failedJob.translate(key, async () => { polled += 1; return detail("de"); }, () => false);
    await clock.advance(DESCRIPTION_TRANSLATION_POLL_MS.reduce((sum, delay) => sum + delay, 0));
    assert.equal(polled, 0, "a failed job does not poll");
    assert.equal(failedJob.phase, "failed");
    assert.equal(failedJob.hasFailed(key), true);

    const capped = new DescriptionTranslationCoordinator(clock, async (jobKey) => ({ id: "job-1", targetKind: "item", contentId: jobKey.contentId, targetLanguage: jobKey.targetLanguage, status: "pending", failed: false }));
    capped.translate(key, async () => detail("de"), () => false);
    await clock.advance(DESCRIPTION_TRANSLATION_POLL_MS.reduce((sum, delay) => sum + delay, 0));
    assert.equal(capped.phase, "failed");
});

test("button mode offers Translate until a run starts, and a failure offers it again", async () => {
    const clock = new ManualClock();
    let mode: "off" | "button" | "auto" = "button";
    const posts: string[] = [];
    const cards = new CardDescriptionTranslation({ onView: () => mode }, clock, async () => detail("de"), async (contentId, language) => {
        posts.push(`${contentId}:${language}`);
        return { id: "job-1", targetKind: "item", contentId, targetLanguage: language, status: "failed", failed: true };
    });
    const card = { id: "movie:heat-1995", overview: "Original", pendingTranslationLanguage: "de", machineTranslatedFields: undefined };
    assert.equal(cards.offers(card), true);
    assert.equal(marqueeTranslationRequest(true, mode, card.id, card.pendingTranslationLanguage), undefined);
    cards.cardDidAppear(card);
    await clock.advance(0);
    assert.deepEqual(posts, [], "button mode does not start from the card appearing");
    cards.translate(card);
    assert.equal(cards.offers(card), false, "the action hides while the run is in flight");
    await clock.advance(0);
    assert.deepEqual(posts, ["movie:heat-1995:de"]);
    assert.equal(cards.offers(card), true, "a failed run offers Translate again");
    mode = "off";
    assert.equal(cards.offers(card), false);
    cards.translate(card);
    await clock.advance(0);
    assert.deepEqual(posts, ["movie:heat-1995:de"]);
});

test("a landed card translation replaces the overview only while that language is still pending", async () => {
    const clock = new ManualClock();
    let pending: string | undefined = "de";
    const cards = new CardDescriptionTranslation({ onView: () => "auto" }, clock, async () => detail(pending, "Translated text", ["overview"]), async (_id, language) => ({ id: "job-1", targetKind: "item", contentId: "movie:heat-1995", targetLanguage: language, status: "pending", failed: false }));
    const card = (): { id: string; overview: string; pendingTranslationLanguage: string | undefined; machineTranslatedFields: undefined } => ({ id: "movie:heat-1995", overview: "Original", pendingTranslationLanguage: pending, machineTranslatedFields: undefined });
    cards.cardDidAppear(card());
    await clock.advance(1000);
    pending = undefined;
    await clock.advance(2000);
    pending = "de";
    const shown = cards.presentation(card());
    assert.equal(shown.overview, "Translated text");
    assert.equal(shown.pendingLanguage, undefined);
    assert.equal(shown.status?.text, "Translated by AI");
    pending = undefined;
    const reloaded = cards.presentation({ id: "movie:heat-1995", overview: "From the server", pendingTranslationLanguage: undefined, machineTranslatedFields: ["overview"] });
    assert.equal(reloaded.overview, "From the server");
    assert.equal(reloaded.status?.text, "Translated by AI");
});

test("description translation uses the catalog item route and does not retry the POST", () => {
    const spec = descriptionTranslationOperations.translateDescription("movie:heat 1995", "de");
    assert.equal(`${spec.method} ${spec.path}`, "POST /catalog/items/movie%3Aheat%201995/translate-description");
    assert.equal(spec.retry, "never");
    assert.deepEqual(spec.body, { target_language: "de" });
    const capability = descriptionTranslationOperations.metadataAI();
    assert.equal(`${capability.method} ${capability.path}`, "GET /capabilities/metadata-ai");
    assert.equal(capability.retry, "safe");
});

test("a series page translates its own description and the selected season's missing episodes", () => {
    const movie = decodeItemDetail({ ...fixture("get_catalog_item_ok"), pending_translation_language: "de" });
    assert.deepEqual(descriptionTargets(movie, undefined, undefined).item, { contentId: movie.id, targetLanguage: "de" });
    const { pendingTranslationLanguage: _ignored, ...withoutPending } = movie;
    const series = { ...withoutPending, id: "series:s1", type: "series" as const };
    const episodes = decodeEpisodes({ items: [
        { content_id: "episode:1", season_number: 1, episode_number: 1, title: "One", runtime: 40 },
        { content_id: "episode:2", season_number: 1, episode_number: 2, title: "Two", runtime: 40, pending_translation_language: "de" },
    ] });
    assert.deepEqual(descriptionTargets(series, { id: "season:1", number: 1 }, episodes).season, { contentId: "season:1", targetLanguage: "de" });
    assert.equal(descriptionTargets(series, { id: "season:1", number: 1 }, episodes).item, undefined);
    assert.equal(descriptionTargets(series, { id: "season:2", number: 2 }, episodes).season, undefined);
});

test("cancelling an automatic run lets the same card start again", async () => {
    const clock = new ManualClock();
    let posts = 0;
    const cards = new CardDescriptionTranslation({ onView: () => "auto" }, clock, async () => detail("de"), async () => {
        posts += 1;
        return { id: "job-1", targetKind: "item", contentId: "movie:heat-1995", targetLanguage: "de", status: "pending", failed: false };
    });
    const card = { id: "movie:heat-1995", overview: "Original", pendingTranslationLanguage: "de" as const, machineTranslatedFields: undefined };
    cards.cardDidAppear(card);
    await clock.advance(0);
    cards.cancel("movie:heat-1995");
    cards.cardDidAppear(card);
    await clock.advance(0);
    assert.equal(posts, 2);
});
