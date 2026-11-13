// The packaged app carries its fonts and their licenses, and its stylesheet loads those copies
// (npm test builds dist/wgt before the native tests run).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const stage = join(import.meta.dirname, "..", "..", "dist", "wgt");
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

test("the WGT stage ships Inter 4.1 unmodified with its OFL and loads it from the package", () => {
    assert.equal(sha256(join(stage, "fonts", "InterVariable.woff2")), "693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3");
    assert.equal(sha256(join(stage, "fonts", "Inter-LICENSE.txt")), "262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a");
    const css = readFileSync(join(stage, "js", "main.css"), "utf8");
    assert.match(css, /@font-face\s*\{[^}]*font-family:\s*"Inter"[^}]*url\("?\.\.\/fonts\/InterVariable\.woff2"?\)/);
    assert.match(css, /--silo-font:\s*"Inter",\s*system-ui,\s*sans-serif/);
    assert.doesNotMatch(css, /url\(["']?https?:/, "no remote font or CDN");
    assert.match(readFileSync(join(stage, "THIRD-PARTY-NOTICES.txt"), "utf8"), /Inter 4\.1 typeface[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/);
});

test("the WGT stage ships Roboto Mono unmodified with its OFL and loads it from the package", () => {
    assert.equal(sha256(join(stage, "fonts", "RobotoMono-Variable.ttf")), "66a80e79d17e4c7cabd162e2916578a4cc08fd19eef6e2a643305eae9c567b2b");
    assert.equal(sha256(join(stage, "fonts", "RobotoMono-LICENSE.txt")), "50ab8dd54680d3473f649c9db86fece88434d097c7834475c1c72d2f8c429215");
    const css = readFileSync(join(stage, "js", "main.css"), "utf8");
    assert.match(css, /@font-face\s*\{[^}]*font-family:\s*"Roboto Mono"[^}]*url\("?\.\.\/fonts\/RobotoMono-Variable\.ttf"?\)/);
    assert.match(css, /--silo-mono:\s*"Roboto Mono",\s*ui-monospace,\s*monospace/);
    assert.match(readFileSync(join(stage, "THIRD-PARTY-NOTICES.txt"), "utf8"), /Roboto Mono typeface[\s\S]*SIL Open Font License, Version 1\.1/);
});
