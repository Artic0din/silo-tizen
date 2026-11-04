import assert from "node:assert/strict";
import { test } from "node:test";
import { episodeAirDate, episodeRuntime } from "../../src/ui/episodeCaption.ts";

test("episode captions format local calendar dates without shifting the day", () => {
    const expected = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(2026, 1, 18));
    assert.equal(episodeAirDate("2026-02-18"), expected);
    assert.equal(episodeAirDate("2026-2-18"), expected);
    assert.equal(episodeAirDate("2026-02-30"), "2026-02-30");
    assert.equal(episodeAirDate(undefined), undefined);
});

test("episode runtimes use Apple's hours and minutes and omit unknown runtimes", () => {
    assert.equal(episodeRuntime(52), "52m");
    assert.equal(episodeRuntime(60), "1h 0m");
    assert.equal(episodeRuntime(92), "1h 32m");
    assert.equal(episodeRuntime(0), undefined);
});
