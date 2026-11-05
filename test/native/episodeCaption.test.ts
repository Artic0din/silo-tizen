import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
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

test("September uses Apple's medium-date abbreviation", () => {
    const module = new URL("../../src/ui/episodeCaption.ts", import.meta.url).href;
    const script = `import { episodeAirDate } from ${JSON.stringify(module)}; process.stdout.write(episodeAirDate("2026-09-05"));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], { env: { ...process.env, LANG: "en_AU.UTF-8", LC_ALL: "en_AU.UTF-8" }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "5 Sep 2026");
});
