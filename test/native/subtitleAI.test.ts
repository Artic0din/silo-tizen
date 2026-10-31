import assert from "node:assert/strict";
import { test } from "node:test";
import { SubtitleAI } from "../../src/player/subtitleAI.ts";
import { decodeAIStatus } from "../../src/contracts/v2/subtitleAI.ts";
import { connected, signIn } from "./support/harness.ts";
import { problem } from "./support/fakeSilo.ts";

const request = { media_file_id: "42", kind: "translate", source_index: 2, source_language: "en", target_language: "fr", start_position: 12 } as const;
const job = (status: string, extra: Record<string, unknown> = {}) => ({ job: { id: "opaque-job", media_file_id: "42", kind: "translate", source_index: 2, target_language: "fr", status, result_subtitle_id: status === "completed" ? "opaque-result" : null, ...extra } });

async function setup(remaining = 3, enabled = true) {
    const h = await connected();
    await signIn(h);
    const profile = (await h.core.profiles.list())[0];
    assert.ok(profile);
    h.core.profiles.select(profile);
    h.fake.script("/subtitles/ai/status", { status: 200, body: { enabled, transcribe_enabled: enabled, allowed: true, state: "available", revision: "opaque" } });
    h.fake.script("/subtitles/ai/quota", ...Array.from({ length: 3 }, () => ({ status: 200, body: { limited: true, limit: 5, used: 5 - remaining, remaining, period: "month" } })));
    h.fake.script("/settings/contract", { status: 200, body: { option_sets: { playback_subtitle_languages: { options: [{ value: "fr" }, { value: "en" }] } } } });
    const ai = new SubtitleAI(h.core.session, h.clock, "42", () => undefined);
    await h.clock.advance(0);
    return { h, ai };
}

test("AI gates translation and transcription independently and treats unknown states as unavailable", () => {
    assert.deepEqual(decodeAIStatus({ enabled: false, transcribe_enabled: true, allowed: true, state: "available" }), { translate: false, transcribe: true });
    assert.deepEqual(decodeAIStatus({ enabled: true, transcribe_enabled: true, allowed: true, state: "future" }), { translate: false, transcribe: false });
});

test("AI creates once, polls opaque identities and exposes a labeled completed result", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("pending") });
    h.fake.script("/subtitles/ai/jobs/opaque-job", { status: 200, body: job("completed") });
    await ai.start(request);
    await ai.start(request);
    assert.equal(ai.view?.busy, true);
    await h.clock.advance(2000);
    assert.deepEqual(ai.view?.results, [{ id: "opaque-result", label: "AI-translated · FR" }]);
    assert.equal(ai.view?.quota?.remaining, 3);
    const starts = h.fake.requests.filter(row => row.path === "/subtitles/ai/translate");
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0]?.body, request);
    assert.ok(starts[0]?.headers["x-profile-id"]);
    assert.equal(h.fake.requests.some(row => row.path.startsWith("/playback")), false);
    ai.destroy();
});

test("exhausted transcription quota blocks spending while translation and unavailable playback remain safe", async () => {
    const { h, ai } = await setup(0);
    await ai.start({ ...request, kind: "transcribe", target_language: "" });
    assert.match(ai.view?.message ?? "", /exhausted/);
    assert.equal(h.fake.requests.some(row => row.method === "POST" && row.path === "/subtitles/ai/translate"), false);
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("completed") });
    await ai.start(request);
    assert.equal(ai.view?.results.length, 1, "text translation does not spend ASR quota");
    ai.destroy();
    const unavailable = await setup(0, false);
    await unavailable.ai.start(request);
    assert.equal(unavailable.ai.view, undefined);
    assert.equal(unavailable.h.fake.requests.some(row => row.path === "/subtitles/ai/translate"), false);
    unavailable.ai.destroy();
});

test("unknown create outcomes are never resent and job failures report a reason", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("pending", { media_file_id: "wrong" }) });
    await ai.start(request);
    await ai.start(request);
    assert.equal(h.fake.requests.filter(row => row.path === "/subtitles/ai/translate").length, 1);
    assert.match(ai.view?.message ?? "", /not sent again/);
    ai.destroy();
    const failed = await setup();
    failed.h.fake.script("/subtitles/ai/translate", { status: 202, body: job("failed", { error_message: "Provider could not decode the source track." }) });
    await failed.ai.start(request);
    assert.match(failed.ai.view?.message ?? "", /could not decode/);
    failed.ai.destroy();
});

test("authority loss cancels polling and quota refusals never become playback failures", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("running") });
    await ai.start(request);
    h.core.profiles.clear();
    const count = h.fake.requests.length;
    await h.clock.advance(10000);
    assert.equal(h.fake.requests.length, count);
    ai.destroy();
    const refused = await setup();
    refused.h.fake.script("/subtitles/ai/translate", problem(429, "quota_exceeded", "Quota exhausted"));
    await refused.ai.start(request);
    assert.match(refused.ai.view?.message ?? "", /quota_exceeded/);
    refused.ai.destroy();
});

test("a rejected AI create is not replayed after account token refresh", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", problem(401, "authentication_required", "Sign in again"));
    await ai.start(request);
    assert.equal(h.fake.requests.filter(row => row.path === "/subtitles/ai/translate").length, 1);
    assert.equal(ai.view?.busy, false);
    ai.destroy();
});

test("lost polling or an unknown accepted status cannot create another quota-spending job", async () => {
    for (const status of ["pending", "future"]) {
        const { h, ai } = await setup();
        h.fake.script("/subtitles/ai/translate", { status: 202, body: job(status) });
        h.fake.script("/subtitles/ai/jobs/opaque-job", problem(400, "unavailable", "Job state unavailable"));
        await ai.start(request);
        await h.clock.advance(2000);
        await ai.start(request);
        assert.equal(h.fake.requests.filter(row => row.path === "/subtitles/ai/translate").length, 1);
        assert.equal(ai.view?.busy, true);
        ai.destroy();
    }
});
