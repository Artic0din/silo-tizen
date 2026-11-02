import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the packaged app requires Tizen 8.0", () => {
    const config = readFileSync(new URL("../../dist/wgt/config.xml", import.meta.url), "utf8");
    assert.match(config, /<tizen:application\b[^>]*\brequired_version="8\.0"/);
});
