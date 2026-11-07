import assert from "node:assert/strict";
import { test } from "node:test";
import type { Credit } from "../../src/contracts/v2/details.ts";
import { creditLine, writerFactLabel } from "../../src/ui/browseDetails.ts";

const credit = (name: string, role: string): Credit => ({ id: undefined, name, role, photoUrl: undefined });

test("detail credits follow Apple's sorted three-name line", () => {
    const crew = [
        ...Array.from({ length: 35 }, (_, index) => credit(`Crew ${index}`, "Director")),
        credit("Zed Writer", "Writer"),
        credit("Ada Screen", "Screenplay"),
    ];
    assert.equal(creditLine(crew, ["director"]), "Crew 0, Crew 1, Crew 10, …");
    assert.equal(creditLine(crew, ["writer", "screenplay", "story"]), "Ada Screen, Zed Writer");
    assert.equal(writerFactLabel(crew), "Writer");
    assert.equal(writerFactLabel([credit("Only Writer", "Writer")]), "Written by");
});
