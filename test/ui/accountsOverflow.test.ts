// Change Account columns show when rows are hidden above or below.
// Apple TV source: silo-apple 6587e57a, TVOverflowColumn in TVChangeAccountView.swift:444-498
// (6 pt gap, 24 pt chevron row, 10 pt between chevrons, 20 pt semibold at 50% of #EDEDED,
// 48 pt edge fades that clear only on the side with hidden rows, hidden when scrollTop is within 1 pt of an end).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright";
import { ACTIVE, openChangeAccount, openSettingsAccounts, seedAccounts, withSignedInTv, type SeedRow } from "./support/accounts.ts";
import { launchBrowser, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const DOWN = 40;
const UP = 38;
const LEFT = 37;
const RIGHT = 39;

interface ColumnState { above: boolean; below: boolean; up: string; down: string; mask: string; chevronsHeight: number; chevronsGap: number; chevronSize: number; chevronColor: string; fade: boolean }

/** What the viewer sees of one column: its overflow flags, its two chevrons' opacity and its edge fade. */
function column(page: Page, name: "rail" | "pane"): Promise<ColumnState> {
    return page.evaluate((which) => {
        const scroller = document.querySelector<HTMLElement>(`.accounts-${which}`)!;
        const wrapper = scroller.parentElement!;
        const chevrons = wrapper.querySelector<HTMLElement>(".accounts-chevrons")!;
        const [up, down] = Array.from(chevrons.children) as HTMLElement[];
        const mask = getComputedStyle(scroller).maskImage;
        return {
            above: scroller.dataset.overflowAbove === "true",
            below: scroller.dataset.overflowBelow === "true",
            up: getComputedStyle(up!).opacity,
            down: getComputedStyle(down!).opacity,
            mask,
            chevronsHeight: chevrons.offsetHeight,
            chevronsGap: chevrons.getBoundingClientRect().top - scroller.getBoundingClientRect().bottom,
            chevronSize: up!.getBoundingClientRect().width,
            chevronColor: getComputedStyle(chevrons).color,
            fade: mask.includes("rgba(0, 0, 0, 0)"),
        };
    }, name);
}

/** The scroll animation runs on the page clock, so step it until the flags and chevrons match. */
async function settled(tv: Tv, name: "rail" | "pane", want: { above: boolean; below: boolean }): Promise<ColumnState> {
    for (let step = 0; step < 60; step++) {
        const state = await column(tv.page, name);
        if (state.above === want.above && state.below === want.below && state.up === (want.above ? "1" : "0") && state.down === (want.below ? "1" : "0")) return state;
        await tv.jump(100);
        // The chevron fade is a CSS transition, which runs on real time.
        await tv.page.waitForTimeout(30);
    }
    throw new Error(`${name} never reached overflow ${JSON.stringify(want)}: ${JSON.stringify(await column(tv.page, name))}`);
}

const servers = (count: number): SeedRow[] => Array.from({ length: count }, (_, index) => ({
    id: `xs${index}`, baseUrl: `https://s${index}.example.test`, username: `s${index}`, profileCount: 1, needsSignIn: false, lastUsedAt: 1000 - index,
}));
const accountsOnActive = (count: number): SeedRow[] => Array.from({ length: count }, (_, index) => ({
    id: `a${index}`, baseUrl: ACTIVE, username: `a${index}`, profileCount: 1, needsSignIn: false, lastUsedAt: 500 - index,
}));
async function press(tv: Tv, key: number, times: number): Promise<void> {
    for (let step = 0; step < times; step++) await tv.remote(key);
}

test("a short Change Account shows no fade and no chevron", async () => {
    await withSignedInTv(browser, async tv => {
        await openChangeAccount(tv);
        for (const name of ["rail", "pane"] as const) {
            const state = await column(tv.page, name);
            assert.deepEqual([state.above, state.below, state.up, state.down, state.fade], [false, false, "0", "0", false], name);
        }
    });
});

test("the accounts pane fades its edge and shows a chevron only where rows are hidden", async () => {
    await withSignedInTv(browser, async tv => {
        await seedAccounts(tv, 1, accountsOnActive(10));
        await openChangeAccount(tv);
        // Opens on the current account, the 11th of 12 cards; ten Ups reach the first.
        await press(tv, UP, 10);
        const top = await settled(tv, "pane", { above: false, below: true });
        assert.equal(top.fade, true, "the bottom edge fades");
        assert.match(top.mask, /^linear-gradient\(/);
        assert.match(top.mask, /rgb\(0, 0, 0\)[^,]*, rgb\(0, 0, 0\) 48px/, "the top edge is solid with 48px of fade room");
        assert.match(top.mask, /calc\(100% - 48px\)/);
        assert.equal(top.chevronsHeight, 24);
        assert.equal(top.chevronsGap, 6);
        assert.equal(top.chevronSize, 20);
        assert.equal(top.chevronColor, "rgba(237, 237, 237, 0.5)");

        await press(tv, DOWN, 5);
        const middle = await settled(tv, "pane", { above: true, below: true });
        assert.equal(middle.mask.match(/rgba\(0, 0, 0, 0\)/g)?.length, 2, "both edges fade");

        await press(tv, DOWN, 6);
        const bottom = await settled(tv, "pane", { above: true, below: false });
        assert.equal(bottom.fade, true, "the top edge fades");
        assert.equal(bottom.mask.match(/rgba\(0, 0, 0, 0\)/g)?.length, 1);

        await press(tv, UP, 11);
        const back = await settled(tv, "pane", { above: false, below: true });
        assert.equal(back.mask, top.mask, "scrolling back restores the first state");
        const rail = await column(tv.page, "rail");
        assert.deepEqual([rail.above, rail.below, rail.up, rail.down], [false, false, "0", "0"], "the short rail is untouched");
    });
});

test("the server rail fades its edge and shows a chevron only where servers are hidden", async () => {
    await withSignedInTv(browser, async tv => {
        await seedAccounts(tv, 1, servers(14));
        await openChangeAccount(tv);
        await press(tv, LEFT, 1);
        await settled(tv, "rail", { above: false, below: true });
        // Down walks the rail, and the pane follows each server.
        await press(tv, DOWN, 16);
        const bottom = await settled(tv, "rail", { above: true, below: false });
        assert.equal(bottom.fade, true);
        await press(tv, UP, 16);
        await settled(tv, "rail", { above: false, below: true });
        await press(tv, RIGHT, 1);
        const pane = await column(tv.page, "pane");
        assert.deepEqual([pane.above, pane.below], [false, false], "the pane has its own flags");
    });
});

test("Settings › Accounts keeps a plain scroll with no fade or chevron", async () => {
    await withSignedInTv(browser, async tv => {
        await seedAccounts(tv, 1, [...servers(6), ...accountsOnActive(8)]);
        await openSettingsAccounts(tv);
        assert.equal(await tv.page.locator(".accounts-chevrons").count(), 0);
        assert.equal(await tv.page.locator(".accounts-settings").evaluate(node => getComputedStyle(node).maskImage), "none");
    });
});
