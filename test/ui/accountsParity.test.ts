// Change Account and Settings › Accounts against Apple TV.
// Apple TV source: silo-apple 6587e57a
// TVChangeAccountView.swift:197-198 (opening spinner), :388 (dimmed tile), :411-442 (badge);
// TVAccountsSettingsView.swift:40, :119, :169-173 (order, hidden zero count);
// ChangeAccountModel.swift:77-80, :115 (profile count, server order); ServerRegistry.swift sortedEntries.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { ACTIVE, keys, openChangeAccount, openSettingsAccounts, seedAccounts, withSignedInTv } from "./support/accounts.ts";
import { launchBrowser, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

test("Change Account lists the active server first, then servers and accounts by last use", async () => {
    await withSignedInTv(browser, async tv => {
        const { baseUrl, owner } = await seedAccounts(tv, 1, [
            { id: "xb-old", baseUrl: "https://b.example.test", username: "b-old", profileCount: 1, needsSignIn: false, lastUsedAt: 100 },
            { id: "xb-new", baseUrl: "https://b.example.test", username: "b-new", profileCount: 1, needsSignIn: false, lastUsedAt: 300 },
            { id: "xc", baseUrl: "https://c.example.test", username: "c", profileCount: 1, needsSignIn: false, lastUsedAt: 200 },
            { id: "older", baseUrl: ACTIVE, username: "older", profileCount: 1, needsSignIn: false, lastUsedAt: 5 },
            { id: "newer", baseUrl: ACTIVE, username: "newer", profileCount: 1, needsSignIn: false, lastUsedAt: 50 },
        ]);
        await openChangeAccount(tv);
        assert.deepEqual(await keys(tv, ".accounts-rail button"), [baseUrl, "https://b.example.test", "https://c.example.test", "add-server"]);
        assert.deepEqual(await keys(tv, ".accounts-pane button"), ["newer", "older", owner, "add-account"]);
        await tv.page.locator('[data-focus="https://b.example.test"]').focus();
        await tv.page.locator('[data-focus="xb-new"]').waitFor();
        assert.deepEqual(await keys(tv, ".accounts-pane button"), ["xb-new", "xb-old", "add-account"]);
    });
});

test("Settings › Accounts lists servers and accounts in the same order and hides a zero profile count", async () => {
    await withSignedInTv(browser, async tv => {
        const { baseUrl } = await seedAccounts(tv, 1, [
            { id: "xb", baseUrl: "https://b.example.test", username: "b", profileCount: 0, needsSignIn: false, lastUsedAt: 300 },
            { id: "xc", baseUrl: "https://c.example.test", username: "c", profileCount: 2, needsSignIn: false, lastUsedAt: 200 },
            { id: "older", baseUrl: ACTIVE, username: "older", profileCount: 1, needsSignIn: false, lastUsedAt: 5 },
            { id: "newer", baseUrl: ACTIVE, username: "newer", profileCount: 0, needsSignIn: true, lastUsedAt: 50 },
        ]);
        await openSettingsAccounts(tv);
        const all = await keys(tv, ".accounts-settings button");
        const account = (id: string): number => all.indexOf(id);
        assert.ok(account("newer") < account("older"), "most recent account first within a server");
        assert.ok(account("newer") < account("xb") && account("xb") < account("xc"), "active server, then by last use");
        assert.ok(account("older") < account(`add:${baseUrl}`));
        const values = await tv.page.locator(".accounts-settings button").evaluateAll(nodes => nodes.map(node => [node.getAttribute("data-focus"), node.querySelector(".accounts-row-value")?.textContent ?? null]));
        const valueOf = (id: string): string | null | undefined => values.find(entry => entry[0] === id)?.[1];
        assert.equal(valueOf("xb"), null, "a zero count is hidden");
        assert.equal(valueOf("xc"), "2 profiles");
        assert.equal(valueOf("older"), "1 profile");
        assert.equal(valueOf("newer"), "Sign in again");
        assert.equal(await tv.page.getByText("0 profiles").count(), 0);
    });
});

test("the SIGN IN AGAIN badge is the warning colour with an open lock, and its tile is dimmed", async () => {
    await withSignedInTv(browser, async tv => {
        const { owner } = await seedAccounts(tv, 9, [
            { id: "expired", baseUrl: ACTIVE, username: "expired", profileCount: 1, needsSignIn: true, lastUsedAt: 1 },
        ]);
        await openChangeAccount(tv);
        const paint = (id: string): Promise<{ text: string; color: string; fill: string; line: string; height: number; icon: boolean; gap: string; weight: string; size: string; tile: string }> =>
            tv.page.locator(`[data-focus="${id}"]`).evaluate(card => {
                const badge = card.querySelector<HTMLElement>(".account-badge")!;
                const style = getComputedStyle(badge);
                const svg = badge.querySelector("svg");
                return { text: badge.textContent ?? "", color: style.color, fill: style.backgroundColor, line: style.borderTopColor, height: badge.offsetHeight,
                    icon: svg !== null, gap: style.columnGap, weight: style.fontWeight, size: style.fontSize, tile: getComputedStyle(card.querySelector(".account-initial")!).opacity };
            });
        const focusOn = (id: string): Promise<void> => tv.page.locator(`[data-focus="${id}"]`).focus();
        await focusOn(owner);
        const current = await paint(owner);
        assert.equal(current.text, "CURRENT");
        assert.equal(current.color, "rgb(237, 237, 237)");
        assert.equal(current.line, "rgba(255, 255, 255, 0.14)");
        assert.equal(current.icon, false);
        assert.equal(current.height, 36);
        assert.equal(current.size, "18px");
        assert.equal(current.tile, "1");
        assert.equal(current.fill, "rgba(0, 0, 0, 0.85)", "a focused card's badge turns near-opaque black");

        await focusOn("expired");
        assert.equal((await paint(owner)).fill, "rgba(0, 0, 0, 0.45)", "an unfocused CURRENT badge is black at 45%");
        const warning = await paint("expired");
        assert.equal(warning.text, "SIGN IN AGAIN");
        assert.equal(warning.color, "rgb(244, 200, 105)");
        assert.equal(warning.line, "rgba(244, 200, 105, 0.35)");
        assert.equal(warning.fill, "rgba(0, 0, 0, 0.85)");
        assert.equal(warning.icon, true);
        assert.equal(warning.height, 36);
        assert.equal(warning.gap, "6px");
        assert.equal(warning.weight, "600");
        assert.equal(warning.size, "18px");
        assert.equal(warning.tile, "0.55", "the tile of an account that must sign in again is dimmed");

        await focusOn(owner);
        assert.equal((await paint("expired")).fill, "rgba(244, 200, 105, 0.08)", "an unfocused warning badge is the warning colour at 8%");
    });
});

test("choosing a saved account that is not open shows a spinner on its card until it opens, and Back cancels", async () => {
    await withSignedInTv(browser, async tv => {
        await seedAccounts(tv, 9, [
            { id: "cold", baseUrl: ACTIVE, username: "cold", profileCount: 1, needsSignIn: false, lastUsedAt: 1 },
        ]);
        await openChangeAccount(tv);
        const hold = tv.fake.hold("/system/info");
        await tv.page.locator('[data-focus="cold"]').click();
        await tv.page.locator('[data-focus="cold"] .marquee-spinner').waitFor({ timeout: 3000 });
        assert.equal(await tv.page.locator('[data-focus="cold"] .account-badge').count(), 0, "the spinner takes the badge's place");
        assert.equal(await tv.page.locator('[data-view="change-account"]').count(), 1, "Change Account stays up while the account opens");
        assert.equal(await tv.page.locator(".marquee-spinner").count(), 1, "only the opening card spins");
        await tv.page.locator(".account-card").first().click();
        assert.equal(await tv.page.locator('[data-view="change-account"]').count(), 1, "another card is ignored while one opens");
        await tv.remote(10009);
        await tv.page.locator('[data-focus="cold"] .marquee-spinner').waitFor({ state: "detached", timeout: 3000 });
        assert.equal(await tv.page.locator('[data-view="change-account"]').count(), 1, "Back cancels the open and stays on Change Account");
        hold.release();
    });
});

test("a saved account that is not open yet opens from Change Account and ends at its picker", async () => {
    await withSignedInTv(browser, async tv => {
        tv.fake.nextUser = { id: "2", username: "alex" };
        await openChangeAccount(tv);
        await tv.page.locator('[data-focus="add-account"]').click();
        await tv.page.locator('[data-screen="code"]').waitFor();
        const code = [...tv.fake.devices.keys()].pop();
        assert.ok(code !== undefined);
        tv.fake.approve(code);
        await tv.jump(5000);
        await tv.page.locator('[data-screen="approved"], [data-screen="notice"], [data-screen="profiles"]').first().waitFor();
        if (await tv.screen() === "approved") await tv.jump(1000);
        await tv.page.locator('[data-screen="notice"], [data-screen="profiles"]').first().waitFor();
        if (await tv.screen() === "notice") await tv.page.getByRole("button", { name: "Continue", exact: true }).click();
        await tv.page.locator('[data-focus="profile:p-owner"]').click();
        await tv.page.locator('[data-focus="ask-every-launch"]').click();
        await tv.page.locator('[data-view="home"] [data-focus="movie:m0001"]').first().waitFor();
        // A restart leaves laura saved but not open.
        await tv.page.evaluate(() => window.appHarness.mount());
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        await tv.page.locator('[data-focus="change-server"]').click();
        await tv.page.locator('[data-view="change-account"]').waitFor();
        const hold = tv.fake.hold("/system/info");
        await tv.page.locator(".account-card").filter({ hasText: "laura" }).click();
        await tv.page.locator(".account-card .marquee-spinner").waitFor({ timeout: 3000 });
        assert.equal(await tv.page.locator('[data-screen="code"], [data-screen="entry"]').count(), 0, "no sign-in screen flashes while the account opens");
        hold.release();
        await tv.page.locator('[data-screen="profiles"]').waitFor();
        assert.equal(await tv.page.locator('[data-view="change-account"]').count(), 0);
        assert.equal(await tv.page.locator('[data-screen="code"]').count(), 0);
    });
});

test("an account that cannot open quietly hands over to sign-in, as before", async () => {
    await withSignedInTv(browser, async tv => {
        await seedAccounts(tv, 9, [
            { id: "cold", baseUrl: ACTIVE, username: "cold", profileCount: 1, needsSignIn: false, lastUsedAt: 1 },
        ]);
        await openChangeAccount(tv);
        const hold = tv.fake.hold("/system/info");
        await tv.page.locator('[data-focus="cold"]').click();
        await tv.page.locator('[data-focus="cold"] .marquee-spinner').waitFor({ timeout: 3000 });
        hold.release();
        await tv.page.locator('[data-screen="code"], [data-screen="entry"], [data-screen="credentials"]').first().waitFor({ timeout: 10000 });
        assert.equal(await tv.page.locator('[data-view="change-account"]').count(), 0);
    });
});
