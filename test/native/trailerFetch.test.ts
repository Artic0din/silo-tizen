import assert from "node:assert/strict";
import { test } from "node:test";
import { TrailerFetch } from "../../src/ui/trailerFetch.ts";
import { detailOperations } from "../../src/api/detailOperations.ts";
import { decodeItemDetail } from "../../src/contracts/v2/catalog.ts";
import { fixture } from "./support/fakeSilo.ts";
import { ManualClock } from "./support/clock.ts";
import { ApiError } from "../../src/api/errors.ts";

const baseline = () => decodeItemDetail(fixture("get_catalog_item_ok"));
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('trailer refresh is one non-replayed profile write with the real fixture', () => {
    const spec = detailOperations.refreshTrailers('movie:a/b');
    assert.equal(spec.path, '/catalog/items/movie%3Aa%2Fb/trailers/refresh');
    assert.equal(spec.method, 'POST'); assert.equal(spec.retry, 'never');
    assert.equal(spec.decode(fixture('refresh_catalog_item_trailers_ok')).status, 'queued');
    assert.throws(() => spec.decode({}));
});

test('trailer fetch terminal outcomes use Apple copy and clear after three seconds', async () => {
    for (const [status, message] of [['cooldown', 'Trailers were checked recently'], ['disabled', 'Trailers are disabled for this library'], ['unknown', 'No trailers found']]) {
        const clock = new ManualClock();
        const run = new TrailerFetch(async () => ({ status: status!, nextAllowedAt: undefined }), async () => baseline(), () => {}, () => {}, clock);
        run.start(baseline()); await flush();
        assert.equal(run.message, message); assert.equal(run.fetching, false);
        await clock.advance(3000); assert.equal(run.message, undefined);
    }
});

test('queued trailers ignore the baseline, find replacement identities, and resume without another POST', async () => {
    const clock = new ManualClock(); let posts = 0; let reads = 0; let found = 0;
    const detail = baseline();
    const run = new TrailerFetch(async () => { posts++; return { status: 'queued', nextAllowedAt: undefined }; }, async () => {
        reads++;
        return reads === 1 ? detail : { ...detail, extras: [{ contentId: 'extra:new', fileId: undefined, title: 'New', kind: 'trailer', stillUrl: undefined, durationSeconds: undefined }] };
    }, () => { found++; }, () => {}, clock);
    run.start(detail); run.start(detail); await flush();
    await clock.advance(3000); assert.equal(found, 0);
    run.stop(); run.stop(); run.resume(); await flush();
    await clock.advance(3000);
    assert.equal(posts, 1); assert.equal(found, 1); assert.equal(run.message, undefined);
});

test('unchanged trailers cannot settle before sixty seconds', async () => {
    const clock = new ManualClock(); const detail = baseline();
    const run = new TrailerFetch(async () => ({ status: 'queued', nextAllowedAt: undefined }), async () => detail, () => {}, () => {}, clock);
    run.start(detail); await flush();
    for (let i = 0; i < 19; i++) await clock.advance(3000);
    assert.equal(run.fetching, true);
    await clock.advance(3000); assert.equal(run.message, 'No trailers found');
});

test('failed polls exhaust the two minute window and authority cancellation cannot publish late data', async () => {
    const clock = new ManualClock(); const detail = baseline();
    let calls = 0;
    const run = new TrailerFetch(async () => ({ status: 'queued', nextAllowedAt: undefined }), async () => { calls++; throw new Error('offline'); }, () => assert.fail('unexpected publication'), () => {}, clock);
    run.start(detail); await flush();
    await clock.advance(120000);
    assert.equal(run.message, 'No trailers found'); assert.equal(calls, 40);
    run.start(detail); await flush(); run.stop(false); run.resume();
    await clock.advance(120000); assert.equal(calls, 40); assert.equal(run.message, undefined);
});

test('a failed POST is never retried and distinguishes rate limits from transport errors', async () => {
    for (const rateLimited of [false, true]) {
        const clock = new ManualClock(); let calls = 0;
        const run = new TrailerFetch(async () => { calls++; throw rateLimited ? new ApiError({ kind: 'http', status: 429, retryAfterSeconds: undefined }) : new Error('offline'); }, async () => baseline(), () => assert.fail('unexpected publication'), () => {}, clock);
        run.start(baseline()); await flush();
        assert.equal(run.message, rateLimited ? 'Please wait a moment and try again' : "Couldn't reach the server — try again");
        await clock.advance(120000); assert.equal(calls, 1);
    }
});

test('interrupted start resumes without another POST', async () => {
    const clock = new ManualClock(); let posts = 0; let reads = 0;
    const detail = baseline();
    const run = new TrailerFetch(async () => { posts++; return { status: 'queued', nextAllowedAt: undefined }; }, async () => { reads++; return detail; }, () => {}, () => {}, clock);
    run.start(detail); await flush();
    run.stop();
    run.start(detail); await flush();
    await clock.advance(3000);
    assert.equal(posts, 1);
    assert.equal(reads >= 1, true);
});
