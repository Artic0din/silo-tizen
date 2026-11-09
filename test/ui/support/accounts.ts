// Shared setup for the Change Account and Settings › Accounts UI tests: a signed-in TV with extra saved accounts.

import assert from "node:assert/strict";
import type { Browser } from "playwright";
import { FakeCatalog } from "../../native/support/fakeCatalog.ts";
import { homeDetailsRead, openTv, type Tv } from "./tv.ts";

export interface SeedRow { id: string; baseUrl: string; username: string; profileCount: number; needsSignIn: boolean; lastUsedAt?: number }

/** Stands for the signed-in account's server, which is only known once the app has signed in. */
export const ACTIVE = "@active";

export async function withSignedInTv(browser: Browser, body: (tv: Tv) => Promise<void>): Promise<void> {
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
export async function seedAccounts(tv: Tv, ownerLastUsedAt: number, extra: readonly SeedRow[]): Promise<{ owner: string; baseUrl: string }> {
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

export async function openChangeAccount(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Change Account", exact: true }).click();
    await tv.page.locator('[data-view="change-account"]').waitFor();
}

export async function openSettingsAccounts(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.locator('[data-focus="server"]').click();
    await tv.page.getByRole("button", { name: "Accounts", exact: true }).click();
    await tv.page.locator('[data-view="accounts-settings"]').waitFor();
}

export const keys = (tv: Tv, selector: string): Promise<string[]> =>
    tv.page.locator(selector).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus") ?? ""));

export async function signIn(tv: Tv): Promise<void> {
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
