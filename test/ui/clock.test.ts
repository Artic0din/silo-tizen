import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { launchBrowser, openTv, pauseTvClock } from "./support/tv.ts";

test("the paused TV clock cannot consume a deadline during host delays", async () => {
    const browser = await launchBrowser();
    try {
        const tv = await openTv(browser);
        await pauseTvClock(tv);
        const time = await tv.page.evaluate(() => Date.now());
        await setTimeout(100);
        assert.equal(await tv.page.evaluate(() => Date.now()), time);
        await tv.page.evaluate(() => {
            document.body.dataset.elapsed = "no";
            window.setTimeout(() => { document.body.dataset.elapsed = "yes"; }, 1500);
        });
        await tv.jump(1499);
        await setTimeout(100);
        assert.equal(await tv.page.evaluate(() => Date.now()), time + 1499);
        assert.equal(await tv.page.locator("body").getAttribute("data-elapsed"), "no");
        await tv.jump(1);
        assert.equal(await tv.page.locator("body").getAttribute("data-elapsed"), "yes");
    } finally { await browser.close(); }
});
