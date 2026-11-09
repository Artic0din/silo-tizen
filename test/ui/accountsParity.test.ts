// Change Account and Settings › Accounts against Apple TV.
// Apple TV source: silo-apple 6587e57a
// TVChangeAccountView.swift:197-198 (opening spinner), :388 (dimmed tile), :411-442 (badge);
// TVAccountsSettingsView.swift:40, :119, :169-173 (order, hidden zero count);
// ChangeAccountModel.swift:77-80, :115 (profile count, server order); ServerRegistry.swift sortedEntries.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

interface SeedRow { id: string; baseUrl: string; username: string; profileCount: number; needsSignIn: boolean; lastUsedAt?: number }

/** Stands for the signed-in account's server, which is only known once the app has signed in. */
const ACTIVE = "@active";

async function withSignedInTv(body: (tv: Tv) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "application" });
    const catalog = new FakeCatalog();
    catalog.fileIds.set("movie:m0001", "42");
    tv.fake.catalog = catalog;
    try {
        await signIn(tv);
        await body(tv);
        assert.deepEqual(tv.console, []);
    } finally {
        await tv.page.context().close();
    }
}

/** Rewrites the saved list: the signed-in account keeps its identity but gets `ownerLastUsedAt`; `extra` rows follow. */
async function seedAccounts(tv: Tv, ownerLastUsedAt: number, extra: readonly SeedRow[]): Promise<{ owner: string; baseUrl: string }> {
    return tv.page.evaluate(([stamp, rows]) => {
        const storage = window.appHarness.storage;
        const saved = JSON.parse(storage.getItem("silo.native.accounts.v1")!) as { accounts: Record<string, unknown>[] };
        const owner = saved.accounts[0]!;
        owner.lastUsedAt = stamp;
        for (const row of rows) saved.accounts.push({ ...owner, ...row, baseUrl: row.baseUrl === "@active" ? owner.baseUrl : row.baseUrl, accountId: row.id, serverId: row.id.startsWith("x") ? "other-server" : owner.serverId });
        storage.setItem("silo.native.accounts.v1", JSON.stringify(saved));
        return { owner: owner.id as string, baseUrl: owner.baseUrl as string };
    }, [ownerLastUsedAt, extra] as const);
}

async function openChangeAccount(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    await tv.page.locator('[data-view="change-account"]').waitFor();
}

async function openSettingsAccounts(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.locator('[data-focus="server"]').click();
    await tv.page.getByRole("button", { name: "Accounts", exact: true }).click();
    await tv.page.locator('[data-view="accounts-settings"]').waitFor();
}

const keys = (tv: Tv, selector: string): Promise<string[]> =>
    tv.page.locator(selector).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus") ?? ""));

test("Change Account lists the active server first, then servers and accounts by last use", async () => {
    await withSignedInTv(async tv => {
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
    await withSignedInTv(async tv => {
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
    await withSignedInTv(async tv => {
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

test("choosing a saved account that is not open shows a spinner on its card until it opens", async () => {
    await withSignedInTv(async tv => {
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
        hold.release();
    });
});

/** Adds a real second account (laura), then restarts so it is saved but not open, and opens Change Account. */
async function openChangeAccountWithColdLaura(tv: Tv): Promise<void> {
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
}

test("a saved account that is not open yet opens from Change Account and ends at its picker", async () => {
    await withSignedInTv(async tv => {
        await openChangeAccountWithColdLaura(tv);
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

// ChangeAccountModel.choose has no cancel: Menu in the pane only returns focus to the rail (TVChangeAccountView.swift:64, :283).
test("Back while an account opens moves focus to the rail and the open still completes", async () => {
    await withSignedInTv(async tv => {
        await openChangeAccountWithColdLaura(tv);
        const hold = tv.fake.hold("/system/info");
        const laura = tv.page.locator(".account-card").filter({ hasText: "laura" });
        await laura.click();
        await laura.locator(".marquee-spinner").waitFor({ timeout: 3000 });
        assert.equal(await tv.page.evaluate(() => document.activeElement?.closest(".accounts-pane") !== null), true, "focus starts on the opening card");
        await tv.remote(10009);
        const onRail = (): Promise<boolean> => tv.page.evaluate(() => document.activeElement?.closest(".accounts-rail") !== null);
        assert.equal(await onRail(), true, "Back returns focus to the rail");
        assert.equal(await laura.locator(".marquee-spinner").count(), 1, "the card keeps spinning");
        await tv.remote(10009);
        assert.equal(await tv.page.locator('[data-view="change-account"]').count(), 1, "Back on the rail does not leave while an account opens");
        hold.release();
        await tv.page.locator('[data-screen="profiles"]').waitFor({ timeout: 10000 });
        const saved = await tv.page.evaluate(() => JSON.parse(window.appHarness.storage.getItem("silo.native.accounts.v1")!) as { accounts: { id: string; username: string }[]; selected?: string });
        assert.equal(saved.accounts.find(row => row.id === saved.selected)?.username, "laura", "the saved selection is the account that opened");
        assert.equal(saved.accounts[0]?.username, "laura");
    });
});

test("an account that cannot open quietly hands over to sign-in, as before", async () => {
    await withSignedInTv(async tv => {
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

async function signIn(tv: Tv): Promise<void> {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    const code = [...tv.fake.devices.keys()].pop();
    assert.ok(code !== undefined);
    tv.fake.approve(code);
    await tv.jump(5000);
    await tv.page.locator('[data-screen="approved"], [data-screen="notice"], [data-screen="profiles"]').waitFor();
    if (await tv.screen() === "approved") await tv.jump(1000);
    await tv.page.locator('[data-screen="notice"], [data-screen="profiles"]').waitFor();
    if (await tv.screen() === "notice") await tv.page.getByRole("button", { name: "Continue", exact: true }).click();
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    await tv.page.locator('[data-focus="profile:p-owner"]').click();
    await tv.page.locator('[data-focus="ask-every-launch"]').click();
    await tv.page.locator('[data-view="home"] [data-focus="movie:m0001"]').first().waitFor();
    await homeDetailsRead(tv);
}
