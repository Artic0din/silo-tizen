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
    let paneEntry: string | undefined;
    let destroyed = false;
    let removalPending = false;
    const destroy = (): void => { destroyed = true; host.destroy(); backdrop.destroy(); container.remove(); };
    const go = (account: SavedAccount | undefined, address?: string): void => { destroy(); open(account, address); };
    const showError = (message: string): void => {
        const retry = actionButton("retry", "Back", render);
        host.show({ name: "accounts-error", content: [el("h1", "accounts-title", message), retry.element], zones: [{ id: "error", layout: "column", items: [retry] }], focus: { zone: "error", key: "retry" }, back: render });
    };
    const confirm = (targets: readonly SavedAccount[], removeServer: boolean): void => {
        const dismiss = (): void => { render(false, false, removeServer); };
        const panel = el("div", removeServer ? "skyline-selector" : "accounts-dialog");
        const cancel = actionButton("cancel", "Cancel", dismiss);
        const accept = actionButton("confirm", removeServer ? "Remove" : "Sign Out", () => {
            if (removalPending) return;
            removalPending = true;
            cancel.element.setAttribute("disabled", "");
            accept.element.setAttribute("aria-disabled", "true");
            accept.element.textContent = removeServer ? "Removing…" : "Signing out…";
            panel.setAttribute("aria-busy", "true");
            accept.element.focus({ preventScroll: true });
            void (async () => {
                for (const row of targets) {
                    if (row.id === current?.accounts.localAccountId) onCurrentSignOut?.();
                    const cleared = row.id === current?.accounts.localAccountId ? (await current.session.logout()).storage : await signOutSavedAccount(row, core);
                    if (cleared === "failed") throw new Error("Could not remove the saved sign-in. Try again.");
                    directory.remove(row.id);
                }
                removalPending = false;
                if (!destroyed) render();
            })().catch((error: unknown) => { removalPending = false; if (!destroyed) showError(error instanceof Error ? error.message : "Could not sign out"); });
        });
        const address = targets[0]?.baseUrl;
        const serverName = address ? cachedBranding(core.publicStorage, address)?.serverName ?? new URL(address).host : "the server";
        const dialog = { id: "dialog", layout: "row" as const, items: [cancel, accept] };
        const view = { name: "accounts-confirm", zones: [dialog], focus: { zone: "dialog", key: "cancel" }, back: dismiss };
        if (removeServer) {
            accept.element.classList.add("skyline-destructive");
            const signsOut = targets.length === 1 ? `This signs out of ${targets[0]?.username ?? "its account"}.`
                : targets.length > 1 ? `This signs out of its ${targets.length} accounts.` : undefined;
            const scrim = el("div", "skyline-dropdown-scrim");
            scrim.setAttribute("data-confirmation", "true");
            scrim.addEventListener("click", () => { if (!removalPending) dismiss(); });
            panel.setAttribute("data-confirmation", "true");
            panel.setAttribute("role", "alertdialog");
            panel.setAttribute("aria-modal", "true");
            panel.style.left = "50%";
            panel.style.right = "auto";
            panel.style.top = "50%";
            const title = el("h2", "skyline-confirm-title", `Remove ${serverName}?`);
            title.id = "accounts-remove-title";
            panel.setAttribute("aria-labelledby", title.id);
            const header = el("div", "skyline-confirm-header");
            header.append(title);
            if (signsOut !== undefined) {
                const message = el("p", "skyline-confirm-message", signsOut);
                message.id = "accounts-remove-message";
                panel.setAttribute("aria-describedby", message.id);
                header.append(message);
            }
            const actions = el("div", "skyline-confirm-actions");
            actions.append(cancel.element, accept.element);
            panel.append(header, actions);
            const behind = container.querySelector<HTMLElement>(".accounts-settings");
            if (behind !== null) {
                behind.inert = true;
                behind.setAttribute("aria-hidden", "true");
            }
            host.show({ ...view, content: behind === null ? [scrim, panel] : [behind, scrim, panel] });
            return;
        }
        const lastAccount = directory.list().filter(row => row.baseUrl === address).length === targets.length;
        const message = lastAccount
            ? `This account's profiles and settings leave this TV, and ${serverName} will be removed from it.`
            : "This account's profiles and settings leave this TV. The server stays saved, so you can sign in again.";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-modal", "true");
        panel.append(el("h1", "signin-title", `Sign out of ${targets[0]?.username ?? "this account"} on ${serverName}?`),
            el("p", "signin-text", message), cancel.element, accept.element);
        host.show({ ...view, content: [panel] });
    };
    function render(railFocus = false, enterPane = false, focusFirst = false): void {
        if (removalPending) return;
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
                else {
                    const arrow = el("span", "accounts-chevron");
                    const icon = navigationIcon("chevron-right");
                    icon.setAttribute("viewBox", "7 3 11 18");
                    arrow.append(icon); item.element.append(arrow);
                }
                return item;
            };
            for (const address of [...new Set(rows.map(row => row.baseUrl))]) {
                const serverName = cachedBranding(core.publicStorage, address)?.serverName ?? new URL(address).host;
                panel.append(el("h2", "accounts-section-header", serverName.toUpperCase()));
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
            const entry = controls[0] === undefined ? undefined : { zone: "rows", key: controls[0].key };
            host.show({ name: "accounts-settings", content: [panel], zones: [{ id: "rows", layout: "column", items: controls }], focus: entry, back: () => { destroy(); back(); } }, focusFirst ? entry : undefined);
            return;
        }
        const addresses = [...new Set(rows.map(row => row.baseUrl))];
        if (!addresses.includes(selected ?? "")) selected = addresses[0];
        const rail = el("div", "accounts-rail");
        const pane = el("div", "accounts-pane");
        const serverItems = addresses.map(address => {
            const brand = cachedBranding(core.publicStorage, address);
            const item = actionButton(address, brand?.serverName ?? new URL(address).host, () => { selected = address; render(false, true); });
            const mark = el("img", "accounts-server-mark"); mark.src = brand?.markUrl ?? "icon.png"; mark.alt = "";
            item.element.prepend(mark);
            item.element.addEventListener("focus", () => { if (selected !== address) { selected = address; paneEntry = undefined; render(true); } });
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
        for (const item of accounts) item.element.addEventListener("focus", () => { paneEntry = item.key; });
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
            } }, railFocus ? { zone: "servers", key: selected ?? "add-server" } : enterPane ? { zone: "accounts", key: paneEntry ?? accounts.find(row => row.key === current?.accounts.localAccountId)?.key ?? accounts[0]!.key } : undefined);
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
