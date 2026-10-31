import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePerson } from "../../src/contracts/v2/details.ts";
import { personAge, personInitials, personMetadataBadges } from "../../src/ui/personHero.ts";
import { decodeThumbhash } from "../../src/ui/thumbhash.ts";
import { WireError } from "../../src/contracts/v2/wire.ts";

const OPAQUE = "1QcSHQRnh493V4dIh4eXh1h4kJUI";
const ALPHA = "X5qGNQw7oElslqhGWfSE+Q6oJ1h2iHB2Rw==";

test("person photo_thumbhash is consumed and strict", () => {
    assert.equal(decodePerson({ id: "7", name: "River Vale", photo_thumbhash: OPAQUE }).photoThumbhash, OPAQUE);
    assert.equal(decodePerson({ id: "7", name: "River Vale" }).photoThumbhash, undefined);
    assert.equal(decodePerson({ id: "7", name: "River Vale", photo_thumbhash: "" }).photoThumbhash, "");
    assert.throws(() => decodePerson({ id: "7", name: "River Vale", photo_thumbhash: 7 }), WireError);
});

test("living age uses local calendar components and skips a birthday that has not arrived", () => {
    const before = new Date(2026, 3, 11, 23, 30, 0);
    const onDay = new Date(2026, 3, 12, 0, 0, 0);
    assert.equal(personAge("1980-04-12", before), 45);
    assert.equal(personAge("1980-04-12", onDay), 46);
    assert.equal(personAge("1980-04-12", new Date(2026, 0, 1)), 45);
    assert.equal(personAge("2026-04-11", new Date(2026, 3, 11)), 0);
    assert.equal(personAge("2026-04-12", new Date(2026, 3, 11)), undefined);
    assert.equal(personAge("2000-12-31", new Date(2026, 11, 30)), 25);
    assert.equal(personAge("2000-12-31", new Date(2026, 11, 31)), 26);
    assert.equal(personAge("2000-01-01", new Date(2026, 11, 31)), 26);
    assert.equal(personAge("2000-01-01", new Date(2027, 0, 1)), 27);
});

test("leap-day age follows the Gregorian calendar instead of a rolled UTC date", () => {
    assert.equal(personAge("2000-02-29", new Date(2023, 1, 28)), 22);
    assert.equal(personAge("2000-02-29", new Date(2023, 2, 1)), 23);
    assert.equal(personAge("2000-02-29", new Date(2024, 1, 29)), 24);
    assert.equal(personAge("1900-02-29", new Date(2026, 2, 1)), undefined);
    assert.equal(personAge("1980-02-31", new Date(2026, 3, 11)), undefined);
    assert.equal(personAge("1980-4-12", new Date(2026, 3, 12)), undefined);
    assert.equal(personAge("  1980-04-12  ", new Date(2026, 3, 12)), 46);
    assert.equal(personAge("   ", new Date(2026, 3, 12)), undefined);
    assert.equal(personAge(undefined, new Date(2026, 3, 12)), undefined);
});

test("metadata keeps birth and death text and shows age only for a living person", () => {
    const today = new Date(2026, 3, 11);
    assert.deepEqual(personMetadataBadges({ birthDate: "1980-04-12", birthplace: " Melbourne " }, today), ["Born Apr 12, 1980", "45 years old", "Melbourne"]);
    assert.deepEqual(personMetadataBadges({ birthDate: "1980-04-12", deathDate: "2010-01-02", birthplace: "Melbourne" }, today), ["Born Apr 12, 1980", "Died Jan 2, 2010", "Melbourne"]);
    assert.deepEqual(personMetadataBadges({ birthDate: "1980-04-12", deathDate: "not-a-date" }, today), ["Born Apr 12, 1980", "Died not-a-date"]);
    assert.deepEqual(personMetadataBadges({ birthDate: "1980-02-31", deathDate: "   " }, today), ["Born 1980-02-31"]);
    assert.deepEqual(personMetadataBadges({ birthplace: "  " }, today), []);
});

test("initials use the first two words and Unicode graphemes", () => {
    assert.equal(personInitials("Ada Lovelace"), "AL");
    assert.equal(personInitials("  Ada   Lovelace  "), "AL");
    assert.equal(personInitials("Cher"), "C");
    assert.equal(personInitials(""), "?");
    assert.equal(personInitials("   "), "?");
    assert.equal(personInitials("李 小龙"), "李小");
    assert.equal(personInitials("e\u0301lodie Martin"), "E\u0301M");
    assert.equal(personInitials("🙂 Rivera"), "🙂R");
    assert.equal(personInitials("ßeta Test"), "SST");
    assert.equal(personInitials("🇺🇸 Canada"), "🇺🇸C");
    assert.equal(personInitials("👨‍👩‍👧‍👦 Smith"), "👨‍👩‍👧‍👦S");
});

test("initials keep Hangul syllables and Indic conjuncts intact", () => {
    assert.equal(personInitials("가 Kim"), "가K");
    assert.equal(personInitials("क्षितिज शर्मा"), "क्षिश");
});

test("oversized photo hashes are rejected before Base64 decoding", (context) => {
    const decoder = context.mock.method(globalThis, "atob");
    assert.equal(decodeThumbhash("A".repeat(4096)), undefined);
    assert.equal(decoder.mock.callCount(), 0);
    assert.equal(decodeThumbhash(" ".repeat(4096) + OPAQUE), undefined);
    assert.equal(decoder.mock.callCount(), 0);
});

test("thumbhash decode matches the Apple canonical vectors and rejects damaged hashes", () => {
    const opaque = decodeThumbhash(OPAQUE);
    assert.ok(opaque);
    assert.equal(opaque.width, 23);
    assert.equal(opaque.height, 32);
    assert.equal(opaque.rgba.length, 23 * 32 * 4);
    assert.deepEqual([opaque.rgba[0], opaque.rgba[1], opaque.rgba[2], opaque.rgba[3]], [64, 77, 113, 255]);
    assert.ok(opaque.rgba.every((value, index) => index % 4 !== 3 || value === 255));

    const alpha = decodeThumbhash(ALPHA);
    assert.ok(alpha);
    assert.equal(alpha.width, 32);
    assert.equal(alpha.height, 32);
    assert.equal(alpha.rgba.length, 32 * 32 * 4);
    assert.deepEqual([alpha.rgba[0], alpha.rgba[1], alpha.rgba[2], alpha.rgba[3]], [219, 65, 45, 0]);
    const alphaValues = [...alpha.rgba].filter((_, index) => index % 4 === 3);
    assert.ok(alphaValues.some(value => value < 255));
    assert.ok(alphaValues.some(value => value > 0));

    const low = new Uint8Array(17);
    low[3] = 1;
    const clamped = decodeThumbhash(Buffer.from(low).toString("base64"));
    assert.ok(clamped);
    assert.equal(clamped.width, 14);
    assert.equal(clamped.height, 32);

    assert.equal(decodeThumbhash(""), undefined);
    assert.equal(decodeThumbhash("   "), undefined);
    assert.equal(decodeThumbhash("not base64"), undefined);
    const valid = Buffer.from(OPAQUE, "base64");
    assert.equal(decodeThumbhash(Buffer.from(valid.subarray(0, valid.length - 1)).toString("base64")), undefined);
    assert.equal(decodeThumbhash(Buffer.from(Buffer.concat([valid, Buffer.from([0])])).toString("base64")), undefined);
    assert.equal(decodeThumbhash(Buffer.from([0, 0, 0x80, 1, 0]).toString("base64")), undefined);
    assert.equal(decodeThumbhash(Buffer.from([0, 0, 0, 0, 0]).toString("base64")), undefined);
});
