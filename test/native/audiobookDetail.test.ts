import assert from "node:assert/strict";
import { test } from "node:test";
import type { Audiobook, AudiobookDetail } from "../../src/contracts/v2/audiobooks.ts";
import { audiobookPage, cleanTitle, formatHMS, formatRuntime, peopleSummary, seriesLine, volumeIn } from "../../src/ui/audiobookDetail.ts";

// Expectations follow silo-apple AudiobookDetailFormattingTests.swift, TVAudiobookViewModel.swift and TVAudiobookChaptersView.swift.

const NO_DETAIL: AudiobookDetail = { authors: [], narrators: [], publisher: undefined, totalDurationSeconds: undefined, series: undefined, otherNarrations: [], alsoByAuthor: [], similar: [] };
const person = (name: string) => ({ name, personId: undefined, photoUrl: undefined });
function book(overrides: Partial<Audiobook> = {}): Audiobook {
    return {
        id: "audiobook:tide", title: "The Tide Owes", overview: undefined, year: undefined, genres: [], posterUrl: undefined, position: 0, played: false, duration: 10800,
        parts: [{ fileId: "1", duration: 10800, offset: 0 }],
        chapters: [
            { title: "Opening", start: 0, end: 3600, partIndex: 0 },
            { title: "What the Tide Owes", start: 3600, end: 7200, partIndex: 0 },
            { title: "Chapter 3", start: 7200, end: 10800, partIndex: 0 },
        ],
        detail: NO_DETAIL, ...overrides,
    };
}

test("titles lose the series locator Apple lifts out", () => {
    assert.equal(cleanTitle("Stormlight Archive 5 - Wind and Truth (5 of 5)", "The Stormlight Archive"), "Wind and Truth");
    assert.equal(cleanTitle("Project Hail Mary", undefined), "Project Hail Mary");
    assert.equal(cleanTitle("The Way of Kings", "The Stormlight Archive"), "The Way of Kings");
    assert.equal(cleanTitle("Some Story (2 of 3)", undefined), "Some Story");
    assert.equal(cleanTitle("American Gods", "A"), "American Gods");
    assert.equal(cleanTitle("Dunes of Arrakis", "Dune"), "Dunes of Arrakis");
    assert.equal(cleanTitle("Dune Saga 12 - Dune Messiah", "Dune Saga"), "Dune Messiah");
    assert.equal(cleanTitle("Dune (Book 1)", undefined), "Dune");
    assert.equal(cleanTitle("Dune (Vol. 2)", undefined), "Dune");
    assert.equal(cleanTitle("  ", undefined), "");
});

test("the volume locator and series line use the title's total, not the entry count", () => {
    assert.deepEqual(volumeIn("Stormlight Archive 5 - Wind and Truth (5 of 5)"), { index: 5, total: 5 });
    assert.deepEqual(volumeIn("Project Hail Mary"), { index: undefined, total: undefined });
    assert.equal(seriesLine("The Stormlight Archive", 5, 5), "The Stormlight Archive · Book 5 of 5");
    assert.equal(seriesLine("Mistborn", undefined, undefined), "Mistborn");
    assert.equal(seriesLine("Mistborn", 2, undefined), "Mistborn · Book 2");
    assert.equal(seriesLine("Mistborn", 2, 1), "Mistborn · Book 2", "a total below the index is ignored");
    assert.equal(seriesLine("Mistborn", 1, 1), "Mistborn · Book 1", "a one-book total is not shown");
    assert.equal(seriesLine(undefined, 2, 3), undefined);
    assert.equal(seriesLine("  ", 2, 3), undefined);
});

test("credit lists roll up past three names and join small lists naturally", () => {
    assert.equal(peopleSummary(["Danny Montooth", "James Konicek", "Drew Kopas", "Andy Clemence", "Bradley Foster Smith"], 2), "Danny Montooth, James Konicek & 3 more");
    assert.equal(peopleSummary(["Danny Montooth, James Konicek, Drew Kopas, Andy Clemence, Bradley Foster Smith"], 2), "Danny Montooth, James Konicek & 3 more");
    assert.equal(peopleSummary(["Brandon Sanderson"]), "Brandon Sanderson");
    assert.equal(peopleSummary(["A", "B"]), "A & B");
    assert.equal(peopleSummary(["A", "B", "C"]), "A, B & C");
    assert.equal(peopleSummary([]), undefined);
    assert.equal(peopleSummary(["", "  "]), undefined);
});

test("time labels match PlayerTimeFormatter", () => {
    assert.equal(formatRuntime(10800), "3h");
    assert.equal(formatRuntime(5 * 3600 + 28 * 60 + 59), "5h 28m");
    assert.equal(formatRuntime(42 * 60), "42m");
    assert.equal(formatRuntime(0), "");
    assert.equal(formatRuntime(Number.NaN), "");
    assert.equal(formatHMS(512), "8:32");
    assert.equal(formatHMS(3725), "1:02:05");
    assert.equal(formatHMS(-1), "0:00");
});

test("the hero names the book, its genre, series, author and narrator", () => {
    const page = audiobookPage(book({
        title: "Stormlight Archive 5 - Wind and Truth (5 of 5)", genres: ["Fantasy", "Epic"],
        detail: { ...NO_DETAIL, authors: [person("Brandon Sanderson")], narrators: [person("Michael Kramer"), person("Kate Reading")], series: { name: "The Stormlight Archive", entries: [] } },
    }));
    assert.equal(page.title, "Wind and Truth");
    assert.equal(page.eyebrow, "AUDIOBOOK · FANTASY");
    assert.equal(page.seriesLine, "The Stormlight Archive · Book 5 of 5");
    assert.deepEqual(page.credits, { author: "Brandon Sanderson", narrator: "Michael Kramer & Kate Reading" });
    assert.equal(audiobookPage(book()).eyebrow, "AUDIOBOOK");
    assert.equal(audiobookPage(book()).credits, undefined);
    assert.equal(audiobookPage(book()).seriesLine, undefined);
});

test("the series entry's own index wins over the title's", () => {
    const page = audiobookPage(book({ title: "Book (2 of 7)", detail: { ...NO_DETAIL, series: { name: "Saga", entries: [{ id: "audiobook:tide", title: "Book", year: undefined, seriesIndex: 4, posterUrl: undefined }] } } }));
    assert.equal(page.seriesLine, "Saga · Book 4 of 7");
});

test("a book in progress shows its ring, chapter and Resume", () => {
    const page = audiobookPage(book({ position: 4112 }));
    assert.deepEqual(page.state, { kind: "inProgress", fraction: 4112 / 10800, percent: 38, line1: "Chapter 2 · What the Tide Owes", line2: "8:32 into the chapter · 1h 51m left in the book" });
    assert.deepEqual(page.primary, { label: "Resume", icon: "play" });
    assert.equal(page.resumeSeconds, 4112);
});

test("a book without chapters reports listened time", () => {
    const page = audiobookPage(book({ position: 3725, chapters: [] }));
    assert.equal(page.state.kind, "inProgress");
    if (page.state.kind === "inProgress") {
        assert.equal(page.state.line1, "1h 2m listened");
        assert.equal(page.state.line2, "1h 57m left in the book");
    }
});

test("an unstarted book says so and offers Play, even for a stray first half minute", () => {
    for (const position of [0, 20, 30]) {
        const page = audiobookPage(book({ position }));
        assert.deepEqual(page.state, { kind: "notStarted", line1: "Not started", line2: "3h · 3 chapters" }, String(position));
        assert.deepEqual(page.primary, { label: "Play", icon: "play" });
        assert.equal(page.resumeSeconds, undefined);
    }
    assert.equal(audiobookPage(book({ chapters: [], duration: 0, parts: [{ fileId: "1", duration: 0, offset: 0 }] })).state.kind, "notStarted");
});

test("a finished book, by flag or within five seconds of the end, offers Play Again", () => {
    for (const finished of [book({ played: true }), book({ position: 10797 })]) {
        const page = audiobookPage(finished);
        assert.deepEqual(page.state, { kind: "finished", line1: "Finished", line2: "3h" });
        assert.deepEqual(page.primary, { label: "Play Again", icon: "restart" });
    }
});

test("a played book with a resumable position still offers Resume, as Apple checks Resume first", () => {
    const page = audiobookPage(book({ played: true, position: 100 }));
    assert.equal(page.state.kind, "inProgress");
    assert.equal(page.primary.label, "Resume");
});

test("Chapters is offered for real chapters or several parts, and not otherwise", () => {
    assert.equal(audiobookPage(book()).showsChapters, true);
    const twoParts = [{ fileId: "1", duration: 5400, offset: 0 }, { fileId: "2", duration: 5400, offset: 5400 }];
    assert.equal(audiobookPage(book({ chapters: [], parts: twoParts })).showsChapters, true);
    assert.equal(audiobookPage(book({ chapters: [] })).showsChapters, false);
});

test("the chapter picker marks the current chapter, finished ones and progress through the current one", () => {
    const picker = audiobookPage(book({ position: 4112 })).picker;
    assert.deepEqual(picker.rows.map(row => [row.id, row.number, row.title, row.duration, row.isCurrent, row.isDone]), [
        ["chapter-0", 1, "Opening", 3600, false, true],
        ["chapter-1", 2, "What the Tide Owes", 3600, true, false],
        ["chapter-2", 3, "Chapter 3", 3600, false, false],
    ]);
    assert.equal(picker.rows[1]?.progress, 512 / 3600);
    assert.equal(picker.rows[0]?.progress, undefined);
    assert.equal(picker.defaultRowId, "chapter-1");
    assert.equal(picker.subline, "38% · Chapter 2 of 3 · 1h 51m left");
    assert.equal(audiobookPage(book()).picker.subline, "3 chapters · 3h");
    assert.equal(audiobookPage(book()).picker.defaultRowId, "chapter-0");
});

test("a finished book marks every chapter done", () => {
    assert.ok(audiobookPage(book({ played: true })).picker.rows.every(row => row.isDone));
});

test("without chapters the picker lists the parts at their offsets", () => {
    const parts = [{ fileId: "1", duration: 5400, offset: 0 }, { fileId: "2", duration: 5400, offset: 5400 }];
    const picker = audiobookPage(book({ chapters: [], parts })).picker;
    assert.deepEqual(picker.rows.map(row => [row.id, row.number, row.title, row.duration, row.startSeconds]), [
        ["part-0", 1, "Part 1", 5400, 0], ["part-1", 2, "Part 2", 5400, 5400],
    ]);
    assert.equal(picker.subline, "2 parts · 3h");
});

test("about, narrations and rails appear only when the book has them", () => {
    assert.equal(audiobookPage(book()).sections.hasContent, false);
    const detail: AudiobookDetail = {
        authors: [person("A"), person("B"), person("C"), person("D"), person("E")], narrators: [person("N")], publisher: "Tor", totalDurationSeconds: undefined,
        series: { name: "Saga", entries: [{ id: "audiobook:b1", title: "One", year: 2001, seriesIndex: 1, posterUrl: undefined }] },
        otherNarrations: [{ id: "audiobook:alt", title: "Dune", year: 2020, narrators: ["X", "Y"] }, { id: "audiobook:alt2", title: "Dune (Audible)", year: undefined, narrators: [] }],
        alsoByAuthor: [{ id: "audiobook:c", title: "Other", year: undefined, seriesIndex: undefined, posterUrl: undefined }], similar: [],
    };
    const sections = audiobookPage(book({ overview: "Spice.", year: 1965, detail })).sections;
    assert.equal(sections.hasContent, true);
    assert.equal(sections.about, "Spice.");
    assert.equal(sections.credits, "Written by A, B, C & 2 more · Narrated by N · Tor · 1965");
    assert.deepEqual(sections.narrations.map(row => [row.id, row.label, row.year]), [["audiobook:alt", "X, Y", 2020], ["audiobook:alt2", "Dune (Audible)", undefined]]);
    assert.deepEqual(sections.rails.map(rail => [rail.title, rail.items.map(item => [item.id, item.caption])]), [["Saga", [["audiobook:b1", "Book 1"]]], ["More by Author", [["audiobook:c", undefined]]]]);
    assert.equal(audiobookPage(book({ detail: { ...NO_DETAIL, otherNarrations: detail.otherNarrations } })).sections.hasContent, true);
});
