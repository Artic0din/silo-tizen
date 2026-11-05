import { AccountDirectory, type SavedAccount } from "../session/accounts.ts";
import type { ConnectedServer, SessionCoreDeps } from "../session/core.ts";
import { signOutSavedAccount } from "../session/core.ts";
import { FocusHost, type FocusItem } from "./browseFocus.ts";
import { actionButton } from "./browseViews.ts";
import { MarqueeBackdrop } from "./marqueeBackdrop.ts";
import { systemClock } from "../api/clock.ts";
import { el } from "./screen.ts";
import { cachedBranding } from "./brandingCache.ts";
import { navigationIcon } from "./navigationIcon.ts";

export interface AccountsScreen { destroy(): void }
export function mountAccounts(root: HTMLElement, core: SessionCoreDeps, current: ConnectedServer | undefined,
    open: (account: SavedAccount | undefined, address?: string) => void, back: () => void, manage = false, onCurrentSignOut?: () => void): AccountsScreen {
    const container = el("section", "accounts-screen");
    const backdrop = new MarqueeBackdrop(core.clock ?? systemClock);
    backdrop.setStage(current ? 2 : 0);
    backdrop.setAccent(current ? cachedBranding(core.publicStorage, current.server.http.base.baseUrl)?.accentColor : undefined);
    const scrim = el("div", "accounts-scrim");
    container.append(backdrop.element);
    root.append(container);
    const host = new FocusHost(container);
    const directory = current?.accounts.directory ?? new AccountDirectory(core.publicStorage, core.randomBytes);
    let selected = current?.server.http.base.baseUrl ?? directory.list()[0]?.baseUrl;
    let destroyed = false;
    const destroy = (): void => { destroyed = true; host.destroy(); backdrop.destroy(); container.remove(); };
    const go = (account: SavedAccount | undefined, address?: string): void => { destroy(); open(account, address); };
    const showError = (message: string): void => {
        const retry = actionButton("retry", "Back", render);
        host.show({ name: "accounts-error", content: [el("h1", "accounts-title", message), retry.element], zones: [{ id: "error", layout: "column", items: [retry] }], focus: { zone: "error", key: "retry" }, back: render });
    };
    const confirm = (targets: readonly SavedAccount[], removeServer: boolean): void => {
        const cancel = actionButton("cancel", "Cancel", render);
        const accept = actionButton("confirm", removeServer ? "Remove Server" : "Sign Out", () => {
            void (async () => {
                accept.element.setAttribute("disabled", "");
                for (const row of targets) {
                    if (row.id === current?.accounts.localAccountId) onCurrentSignOut?.();
                    const cleared = row.id === current?.accounts.localAccountId ? (await current.session.logout()).storage : await signOutSavedAccount(row, core);
                    if (cleared === "failed") throw new Error("Could not remove the saved sign-in. Try again.");
                    directory.remove(row.id);
                }
                if (!destroyed) render();
            })().catch((error: unknown) => { if (!destroyed) showError(error instanceof Error ? error.message : "Could not sign out"); });
        });
        const panel = el("div", "accounts-dialog");
        panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true");
        const address = targets[0]?.baseUrl;
        const serverName = address ? cachedBranding(core.publicStorage, address)?.serverName ?? new URL(address).host : "the server";
        const lastAccount = directory.list().filter(row => row.baseUrl === address).length === targets.length;
        const message = lastAccount
            ? `This account's profiles and settings leave this TV, and ${serverName} will be removed from it.`
            : "This account's profiles and settings leave this TV. The server stays saved, so you can sign in again.";
        panel.append(el("h1", "signin-title", removeServer ? `Remove ${serverName}?` : `Sign out of ${targets[0]?.username ?? "this account"} on ${serverName}?`),
            el("p", "signin-text", message), cancel.element, accept.element);
        host.show({ name: "accounts-confirm", content: [panel], zones: [{ id: "dialog", layout: "row", items: [cancel, accept] }], focus: { zone: "dialog", key: "cancel" }, back: render });
    };
    function render(railFocus = false): void {
        const rows = directory.list();
        if (manage) {
            const panel = el("div", "accounts-settings");
            const header = el("header", "accounts-settings-header");
            const icon = el("span", "accounts-settings-icon");
            icon.append(navigationIcon("switch-server"));
            icon.setAttribute("aria-hidden", "true");
            const copy = el("div", "");
            copy.append(el("h1", "", "Accounts"), el("p", "", "Servers and the accounts signed in to them on this TV."));
            header.append(icon, copy); panel.append(header);
            const controls: FocusItem[] = [];
            const paneRow = (key: string, title: string, action: () => void, value?: string, destructive = false): FocusItem => {
                const item = actionButton(key, "", action);
                item.element.append(el("span", "accounts-row-title", title));
                if (value) item.element.append(el("span", "accounts-row-value", value));
                if (destructive) item.element.classList.add("accounts-destructive");
                else { const arrow = el("span", "accounts-chevron", "›"); arrow.setAttribute("aria-hidden", "true"); item.element.append(arrow); }
                return item;
            };
            for (const address of [...new Set(rows.map(row => row.baseUrl))]) {
                const serverName = cachedBranding(core.publicStorage, address)?.serverName ?? new URL(address).host;
                panel.append(el("h2", "browse-section-title", serverName.toUpperCase()));
                for (const row of rows.filter(row => row.baseUrl === address)) {
                    const detail = row.needsSignIn ? "Sign in again" : `${row.profileCount} ${row.profileCount === 1 ? "profile" : "profiles"}`;
                    const item = paneRow(row.id, row.username, () => row.needsSignIn ? expired(row) : confirm([row], false), detail);
                    controls.push(item); panel.append(item.element);
                }
                const add = paneRow(`add:${address}`, `Add an account on ${serverName}`, () => go(undefined, address));
                const remove = paneRow(`remove:${address}`, "Remove Server", () => confirm(rows.filter(row => row.baseUrl === address), true), undefined, true);
                controls.push(add, remove); panel.append(add.element, remove.element);
            }
            const add = paneRow("add-server", "Add a server", () => go(undefined));
            controls.push(add); panel.append(add.element, el("p", "signin-text", "Signing out of an account removes it and its settings from this TV. Signing out of a server's only account removes the server too."));
            container.classList.add("accounts-management");
            host.show({ name: "accounts-settings", content: [panel], zones: [{ id: "rows", layout: "column", items: controls }], focus: { zone: "rows", key: controls[0]!.key }, back: () => { destroy(); back(); } });
            return;
        }
        const addresses = [...new Set(rows.map(row => row.baseUrl))];
        if (!addresses.includes(selected ?? "")) selected = addresses[0];
        const rail = el("div", "accounts-rail");
        const pane = el("div", "accounts-pane");
        const serverItems = addresses.map(address => {
            const brand = cachedBranding(core.publicStorage, address);
            const item = actionButton(address, brand?.serverName ?? new URL(address).host, () => { selected = address; render(); });
            const mark = el("img", "accounts-server-mark"); mark.src = brand?.markUrl ?? "icon.png"; mark.alt = "";
            item.element.prepend(mark);
            item.element.addEventListener("focus", () => { if (selected !== address) { selected = address; render(true); } });
            item.element.setAttribute("aria-selected", String(address === selected));
            return item;
        });
        const addServer = actionButton("add-server", "Add server", () => go(undefined));
        const plus = el("span", "accounts-server-mark accounts-plus", "+"); plus.setAttribute("aria-hidden", "true");
        addServer.element.prepend(plus);
        serverItems.push(addServer);
        const accounts: FocusItem[] = rows.filter(row => row.baseUrl === selected).map(row => {
            const item = actionButton(row.id, "", () => manage ? confirm([row], false) : go(row));
            item.element.classList.add("account-card");
            item.element.append(el("span", "account-initial", row.username.slice(0, 1).toUpperCase()),
                el("span", "account-name", row.username));
            const name = item.element.lastElementChild!;
            if (row.profileCount > 0) name.append(el("span", "account-count", `${row.profileCount} ${row.profileCount === 1 ? "profile" : "profiles"}`));
            const badge = row.needsSignIn ? "SIGN IN AGAIN" : row.id === current?.accounts.localAccountId ? "CURRENT" : undefined;
            if (badge) item.element.append(el("span", "account-badge", badge));
            return item;
        });
        const addAccount = actionButton("add-account", "", () => go(undefined, selected));
        const name = el("span", "account-name", "Add an account");
        name.append(el("span", "account-count", `Sign in on ${selected ? cachedBranding(core.publicStorage, selected)?.serverName ?? new URL(selected).host : "a server"}`));
        addAccount.element.classList.add("account-card");
        addAccount.element.append(el("span", "account-initial", "+"), name);
        if (selected) accounts.push(addAccount);
        if (manage && selected) accounts.push(actionButton("remove-server", "Remove Server", () => confirm(rows.filter(row => row.baseUrl === selected), true)));
        rail.append(...serverItems.map(item => item.element)); pane.append(...accounts.map(item => item.element));
        const columns = el("div", "accounts-columns"); columns.append(rail, pane);
        const mark = el("img", "accounts-wordmark"); mark.src = "img/silo-wordmark.png"; mark.alt = "Silo";
        host.show({ name: "change-account", content: [backdrop.element, scrim, mark, el("h1", "accounts-title", "Change account"), el("p", "signin-text", "Choose a server, then the account to use on it."), columns],
            zones: [{ id: "servers", layout: "column", right: "accounts", items: serverItems }, { id: "accounts", layout: "column", left: "servers", items: accounts }],
            focus: accounts.length === 0 ? { zone: "servers", key: "add-server" } : { zone: "accounts", key: accounts.find(row => row.key === current?.accounts.localAccountId)?.key ?? accounts[0]!.key },
            back: () => {
                if (host.focused()?.zone === "accounts") { render(true); return; }
                destroy(); back();
            } }, railFocus ? { zone: "servers", key: selected ?? "add-server" } : undefined);
    }
    function expired(row: SavedAccount): void {
        const controls = [actionButton("signin", "Sign in again", () => go(row)), actionButton("signout", "Sign Out", () => confirm([row], false)), actionButton("cancel", "Cancel", render)];
        const panel = el("div", "accounts-dialog");
        panel.append(el("h1", "signin-title", `${row.username} needs to sign in again`), ...controls.map(item => item.element));
        host.show({ name: "account-expired", content: [panel], zones: [{ id: "choices", layout: "column", items: controls }], focus: { zone: "choices", key: "signin" }, back: render });
    }
    host.listen(); render();
    return { destroy };
}
