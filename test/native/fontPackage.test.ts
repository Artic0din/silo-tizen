// The packaged app carries its one UI font and its license, and its stylesheet loads that copy
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
