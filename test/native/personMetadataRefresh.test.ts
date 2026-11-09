import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import { detailOperations } from "../../src/api/detailOperations.ts";
import { decodePerson, type Person } from "../../src/contracts/v2/details.ts";
import { WireError } from "../../src/contracts/v2/wire.ts";
import { PersonMetadataRefresh } from "../../src/ui/personMetadataRefresh.ts";
import { ManualClock, settle } from "./support/clock.ts";

function harness(dispatchError?: Error) {
    const clock = new ManualClock();
    let person = decodePerson({ id: "7", name: "River", bio: "  " });
    let answer: Person | Error = person;
    let reads = 0;
    let dispatches = 0;
    const refresh = new PersonMetadataRefresh(clock, () => person, async () => {
        dispatches++;
        if (dispatchError !== undefined) throw dispatchError;
        return undefined;
    }, async () => { reads++; if (answer instanceof Error) throw answer; return answer; }, updated => { if (updated !== undefined) person = updated; });
    const controller = new AbortController();
    return { clock, refresh, controller, start: () => refresh.start(controller.signal), reads: () => reads, dispatches: () => dispatches,
        answer: (value: Person | Error) => { answer = value; }, person: () => person };
}

test("Person refresh receipt and reads validate person identity; dispatch never replays", () => {
    const spec = detailOperations.refreshPerson("person/+7");
    assert.equal(spec.path, "/catalog/people/person%2F%2B7/refresh");
    assert.equal(spec.method, "POST");
    assert.equal(spec.retry, "never");
    assert.equal(spec.decode({ status: "queued", person_id: "person/+7" }), undefined);
    for (const receipt of [{ status: "queued", person_id: "8" }, { status: "done", person_id: "person/+7" }, {}]) assert.throws(() => spec.decode(receipt), WireError);
    assert.throws(() => detailOperations.person("7").decode({ id: "8", name: "Other" }), WireError);
});

test("Person polling starts after three seconds and settles after five unchanged reads", async () => {
    const h = harness(); h.start(); h.start();
    await h.clock.advance(2999);
    assert.equal(h.dispatches(), 1); assert.equal(h.reads(), 0);
    await h.clock.advance(1);
    assert.equal(h.reads(), 1);
    await h.clock.advance(12000);
    assert.equal(h.reads(), 5); assert.equal(h.refresh.refreshing, false);
    h.start(); await h.clock.advance(120000);
    assert.equal(h.dispatches(), 1); assert.equal(h.reads(), 5);
});

test("complete metadata does not dispatch or poll", async () => {
    const clock = new ManualClock();
    const person = decodePerson({ id: "7", name: "River", bio: "Bio", photo_url: "/art/person", birth_date: "1980-04-12" });
    const refresh = new PersonMetadataRefresh(clock, () => person, async () => assert.fail("unexpected dispatch"), async () => assert.fail("unexpected poll"), () => undefined);
    refresh.start(new AbortController().signal); await clock.advance(120000);
    assert.equal(refresh.refreshing, false);
});

test("changed metadata resets settled count; complete metadata ends polling", async () => {
    const h = harness(); h.start(); await h.clock.advance(12000);
    h.answer({ ...h.person(), imdbId: "new-provider-id" });
    await h.clock.advance(3000);
    await h.clock.advance(12000);
    assert.equal(h.refresh.refreshing, true);
    const complete = { ...h.person(), bio: "Bio", photoUrl: "/art/person", birthDate: "1980-04-12" };
    h.answer(complete); await h.clock.advance(3000);
    assert.deepEqual(h.person(), complete); assert.equal(h.refresh.refreshing, false);
});

for (const status of [400, 401, 403, 404, 422, 429, 500, 502, 503]) test(`Person rejected dispatch ${status} follows Apple's polling policy`, async () => {
    const h = harness(new ApiError({ kind: "http", status, retryAfterSeconds: undefined }));
    h.start(); await h.clock.advance(3000);
    assert.equal(h.dispatches(), 1);
    assert.equal(h.reads(), [429, 500, 502].includes(status) ? 1 : 0);
    h.controller.abort(); await settle();
});

for (const failure of [{ kind: "network" }, { kind: "timeout" }, { kind: "invalid_response", path: "person_refresh" }] as const) test(`Person ambiguous ${failure.kind} dispatch polls without repeating the write`, async () => {
    const h = harness(new ApiError(failure)); h.start(); await h.clock.advance(3000);
    assert.equal(h.reads(), 1); assert.equal(h.dispatches(), 1);
    h.controller.abort(); await settle();
});

test("failed polls stop at 120 seconds; leaving cancels and returning resumes without dispatch", async () => {
    const h = harness(); h.answer(new Error("Synthetic read failure")); h.start();
    await h.clock.advance(120000);
    assert.equal(h.reads(), 40); assert.equal(h.refresh.refreshing, false);
    h.start(); await h.clock.advance(3000); assert.equal(h.reads(), 40);
    const visit = harness(); visit.start(); await visit.clock.advance(3000);
    visit.controller.abort(); await settle(); await visit.clock.advance(9000);
    assert.equal(visit.reads(), 1); assert.equal(visit.refresh.refreshing, false);
    visit.refresh.start(new AbortController().signal); await visit.clock.advance(3000);
    assert.equal(visit.dispatches(), 1); assert.equal(visit.reads(), 2);
});

test("late metadata answer after leaving cannot repaint the route", async () => {
    const clock = new ManualClock();
    const original = decodePerson({ id: "7", name: "River" });
    let release = (_: Person): void => undefined;
    let updates = 0;
    const refresh = new PersonMetadataRefresh(clock, () => original, async () => undefined,
        () => new Promise(resolve => { release = resolve; }), person => { if (person !== undefined) updates++; });
    const controller = new AbortController(); refresh.start(controller.signal); await clock.advance(3000);
    controller.abort(); release({ ...original, bio: "Late" }); await settle();
    assert.equal(updates, 0); assert.equal(refresh.refreshing, false);
});
