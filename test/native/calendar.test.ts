import assert from "node:assert/strict";
import { test } from "node:test";
import { getCalendar } from "../../src/api/calendarOperations.ts";
import { decodeCalendar } from "../../src/contracts/v2/calendar.ts";
import { calendarDestination, calendarEventKey, calendarWeek, eventTime, localDateKey, shiftDay } from "../../src/ui/calendarState.ts";
import { FakeCalendar } from "./support/fakeCalendar.ts";

export const event = { content_id: "episode:s1e22", type: "episode", title: "Harbor Lights", series_id: "series:s1", season_number: 2, episode_number: 2, air_date: "2026-10-03", local_air_date: "2026-10-04", air_at: "2026-10-03T16:00:00Z", watched: false, badges: ["finale"] };

test("Calendar request has only the verified query and rejects invalid bounds", () => {
    const spec = getCalendar({ start: "2026-09-28", end: "2026-10-04", timezone: "Australia/Melbourne", filter: "following" });
    assert.equal(spec.path, "/calendar?start=2026-09-28&end=2026-10-04&timezone=Australia%2FMelbourne&filter=following");
    assert.equal(spec.method, "GET"); assert.equal(spec.retry, "safe"); assert.equal(spec.body, undefined);
    for (const [start, end] of [["2026-02-29", "2026-03-01"], ["2026-10-04", "2026-10-03"], ["2026-01-01", "2026-02-01"]]) {
        assert.throws(() => getCalendar({ start: start ?? "", end: end ?? "", timezone: "UTC", filter: "everything" }), RangeError);
    }
    assert.doesNotThrow(() => getCalendar({ start: "2026-01-01", end: "2026-01-31", timezone: "UTC", filter: "trending" }));
    assert.throws(() => getCalendar({ start: "2026-01-01", end: "2026-01-07", timezone: "bad/zone", filter: "following" }), RangeError);
});

test("synthetic Calendar follows favorites, watchlist and rolled-up progress with library access enforced server-side", () => {
    const catalog = new FakeCalendar();
    catalog.favoriteIds.add("movie:m0002");
    catalog.progress.set("episode:s1e12", 30);
    catalog.watchlistIds.clear();
    const spec = getCalendar({ start: "2025-12-29", end: "2026-01-04", timezone: "Australia/Melbourne", filter: "following" });
    const reply = catalog.route("GET", spec.path, "p-owner");
    const ids = decodeCalendar(reply?.body).flatMap(day => day.items.map(event => event.contentId));
    assert.deepEqual(ids, ["movie:m0001", "movie:m0002", "episode:s1e22", "season:s1:2"], "episode progress rolls up to the series independently of watchlist");
    const owner = catalog.households.get("p-owner"); assert.ok(owner); owner.hidden = [12, 15];
    assert.deepEqual(decodeCalendar(catalog.route("GET", spec.path, "p-owner")?.body).flatMap(day => day.items.map(event => event.contentId)), ["episode:s1e22", "season:s1:2"]);
    const all = getCalendar({ start: "2025-12-29", end: "2026-01-04", timezone: "Australia/Melbourne", filter: "everything" });
    assert.deepEqual(decodeCalendar(catalog.route("GET", all.path, "p-kid")?.body).flatMap(day => day.items.map(event => event.contentId)), ["movie:k1"]);
});

test("Calendar unrestricted access excludes a title linked to any disabled library", () => {
    const catalog = new FakeCalendar();
    catalog.libraryMemberships.set("movie:m0001", ["12", "15"]);
    const query = getCalendar({ start: "2025-12-29", end: "2026-01-04", timezone: "Australia/Melbourne", filter: "everything" });
    const ids = () => decodeCalendar(catalog.route("GET", query.path, "p-owner")?.body).flatMap(day => day.items.map(event => event.contentId));
    assert.equal(ids().includes("movie:m0001"), false);
    const owner = catalog.households.get("p-owner"); assert.ok(owner); owner.hidden = [];
    assert.equal(ids().filter(id => id === "movie:m0001").length, 1);
    catalog.libraryMemberships.set("movie:m0001", ["16"]);
    assert.equal(ids().includes("movie:m0001"), false, "another profile's library does not grant access");
});

test("Calendar restricted access subtracts hidden libraries before testing all memberships", () => {
    const catalog = new FakeCalendar();
    catalog.restrictedProfiles.add("p-owner");
    catalog.libraryMemberships.set("movie:m0001", ["15", "16"]);
    const query = getCalendar({ start: "2025-12-29", end: "2026-01-04", timezone: "Australia/Melbourne", filter: "everything" });
    const ids = () => decodeCalendar(catalog.route("GET", query.path, "p-owner")?.body).flatMap(day => day.items.map(event => event.contentId));
    assert.equal(ids().includes("movie:m0001"), false, "hidden and disallowed memberships do not grant access");
    catalog.libraryMemberships.set("movie:m0001", ["12", "15"]);
    assert.equal(ids().includes("movie:m0001"), true, "a remaining allowed membership stays visible");
    const owner = catalog.households.get("p-owner"); assert.ok(owner); owner.hidden = [12, 15];
    assert.equal(ids().includes("movie:m0001"), false);
});

test("authoritative groups and date-only events survive extreme zones and the repeated DST hour", () => {
    const cases = [
        { date: "2026-10-05", source: "2026-10-03", at: "2026-10-04T11:30:00Z", zone: "Pacific/Kiritimati", time: "01:30" },
        { date: "2026-10-03", source: "2026-10-05", at: "2026-10-04T10:30:00Z", zone: "Etc/GMT+12", time: "22:30" },
    ];
    for (const c of cases) {
        const items = decodeCalendar({ events: [{ date: c.date, items: [{ ...event, local_air_date: c.date, air_date: c.source, air_at: c.at }, { ...event, type: "movie", local_air_date: c.date, air_date: c.date, air_at: undefined }] }] })[0]?.items;
        const timed = items?.[0], dateOnly = items?.[1];
        assert.ok(timed && dateOnly);
        assert.equal(eventTime(timed, c.zone)?.replace(/[^0-9:]/g, ""), c.time);
        assert.equal(timed.localAirDate, c.date); assert.equal(timed.airDate, c.source);
        assert.equal(eventTime(dateOnly, c.zone), undefined); assert.equal(dateOnly.localAirDate, c.date);
    }
    const repeated = decodeCalendar({ events: [{ date: "2026-04-05", items: ["2026-04-04T15:59:00Z", "2026-04-04T16:00:00Z"].map(air_at => ({ ...event, air_at, local_air_date: "2026-04-05" })) }] })[0]?.items;
    assert.ok(repeated?.[0] && repeated[1]);
    assert.match(eventTime(repeated[0], "Australia/Melbourne") ?? "", /02:59/);
    assert.match(eventTime(repeated[1], "Australia/Melbourne") ?? "", /02:00/);
    assert.notEqual(calendarEventKey(repeated[0]), calendarEventKey(repeated[1]));
    assert.deepEqual(calendarDestination(repeated[0]), { kind: "item", id: "series:s1", title: "Harbor Lights", seriesContext: { seasonNumber: 2, episodeId: "episode:s1e22" } });
    assert.equal(calendarDestination({ ...repeated[0], seriesId: undefined })?.id, "episode:s1e22");
    assert.equal(calendarDestination({ ...repeated[0], type: "future_kind" }), undefined);
});

test("Calendar decoder retains all events, metadata and unknown enum values; rejects malformed boundaries", () => {
    const items = Array.from({ length: 31 }, (_, i) => ({ ...event, content_id: `episode:${i}` }));
    const days = decodeCalendar({ events: [{ date: "2026-10-04", items }] });
    assert.equal(days[0]?.items.length, 31);
    assert.equal(days[0]?.items[0]?.airAt, event.air_at);
    assert.deepEqual(days[0]?.items[0]?.badges, ["finale"]);
    assert.equal(decodeCalendar({ events: [{ date: "2026-10-04", items: [{ ...event, type: "new_type", badges: ["new_badge"] }] }] })[0]?.items[0]?.type, "new_type");
    for (const patch of [{ watched: null }, { badges: null }, { season_number: 1.2 }, { local_air_date: "2026-10-03" }, { air_at: "2026-02-30T01:00:00Z" }, { air_time: "25:00" }, { poster_url: 1 }]) {
        assert.throws(() => decodeCalendar({ events: [{ date: "2026-10-04", items: [{ ...event, ...patch }] }] }));
    }
    assert.throws(() => decodeCalendar({ events: null }));
    assert.throws(() => decodeCalendar({ events: [{ date: "2026-10-04", items: null }] }));
});

test("local calendar arithmetic keeps seven dates across Melbourne midnight and both DST transitions", () => {
    const prior = process.env.TZ; process.env.TZ = "Australia/Melbourne";
    try {
        assert.equal(localDateKey(new Date("2026-10-30T13:00:00Z")), "2026-10-31");
        assert.deepEqual(calendarWeek(new Date("2026-10-03T16:00:00Z")), ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
        assert.equal(new Date("2026-10-03T15:59:00Z").getHours(), 1);
        assert.equal(new Date("2026-10-03T16:00:00Z").getHours(), 3);
        assert.equal(new Date("2026-04-04T15:59:00Z").getHours(), 2);
        assert.equal(new Date("2026-04-04T16:00:00Z").getHours(), 2);
        assert.equal(calendarWeek(new Date("2026-04-04T16:00:00Z"))[6], "2026-04-05");
        assert.equal(shiftDay("2026-10-04", 1), "2026-10-05");
    } finally { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; }
});
