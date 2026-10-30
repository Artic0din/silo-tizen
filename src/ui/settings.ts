import type { NativeSession } from "../session/session.ts";
import { AUDIO_KEY, HIDDEN_KEY, numericLibraryId, type SettingValue, type SettingsKey } from "../contracts/v2/settings.ts";
import { FocusHost, type FocusItem, type FocusTarget } from "./browseFocus.ts";
import { actionButton, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import { remoteKey } from "./keys.ts";
import { SettingsState } from "./settingsState.ts";

type Category = "general" | "playback";
type Picker = "hidden" | "audio";
export interface SettingsScreen { destroy(): void }

export function mountSettings(root: HTMLElement, session: NativeSession, close: (hiddenChanged: boolean) => void): SettingsScreen {
    const container = el("section", "browse settings");
    container.setAttribute("aria-label", "Settings");
    root.appendChild(container);
    const host = new FocusHost(container);
    let category: Category = "general";
    let picker: Picker | undefined;
    let torn = false;
    const state = new SettingsState(session, () => render());
    const destroy = (): void => {
        if (torn) return;
        torn = true;
        stopAuthority();
        state.stop();
        container.removeEventListener("keydown", onKey, true);
        host.destroy();
        container.remove();
    };
    const stopAuthority = session.onAuthorityChange(destroy);
    const exit = (): void => { const changed = state.hiddenChanged; destroy(); close(changed); };
    const rowFocus = (): FocusTarget => ({ zone: "settings-rows", key: category === "general" ? "hidden" : "audio" });
    const back = (): void => {
        if (picker !== undefined) { picker = undefined; render(rowFocus()); }
        else if (host.focused()?.zone !== "settings-categories") render({ zone: "settings-categories", key: category });
        else exit();
    };
    const onKey = (event: KeyboardEvent): void => {
        const key = remoteKey(event);
        if (picker === undefined && key === "left" && host.focused()?.zone === "settings-rows") {
            event.preventDefault();
            render({ zone: "settings-categories", key: category });
        }
    };
    container.addEventListener("keydown", onKey, true);
    const openPicker = (next: Picker): void => { picker = next; render({ zone: "settings-picker", key: "back" }); };
    const commit = async (key: SettingsKey, value: SettingValue | undefined): Promise<void> => {
        const startedPicker = picker;
        if (value === undefined) await state.reset(key);
        else await state.save(key, value);
        if (!torn && startedPicker === picker && !state.busy && state.error === undefined) { picker = undefined; render(rowFocus()); }
    };
    const button = (key: string, label: string, action: () => void): FocusItem => {
        const blocked = state.busy || (state.canRetry && key !== "retry");
        const item = actionButton(key, label, () => { if (!blocked) action(); });
        if (blocked) item.element.setAttribute("aria-disabled", "true");
        return item;
    };
    const profileValue = (key: SettingsKey): string => {
        const stored = state.explicit.get(key);
        return stored?.isSet ? valueLabel(stored.value, key) : "Inherited";
    };
    const note = (key: SettingsKey): HTMLElement => {
        const effective = state.effective.get(key);
        const sources: Readonly<Record<string, string>> = { default: "Inherited default", profile: "Profile default", profile_device: "Device override", profile_library: "Library override", profile_series: "Series override" };
        const source = effective === undefined ? "" : sources[effective.source] ?? effective.source.replace(/_/g, " ");
        const permitted = effective?.constrained && effective.permittedValues !== undefined ? ` · Permitted: ${effective.permittedValues.map(value => valueLabel(value, key)).join(", ")}` : "";
        const text = effective === undefined ? "" : `On this TV: ${valueLabel(effective.value, key)} · ${source}${effective.constrained ? " · Limited by server policy" : ""}${permitted}`;
        return el("p", "settings-value", text);
    };
    const feedback = (): HTMLElement[] => {
        const nodes: HTMLElement[] = [];
        if (state.busy) { const pending = el("p", "browse-text", state.loaded ? "Saving…" : "Loading settings…"); pending.setAttribute("role", "status"); nodes.push(pending); }
        if (state.error !== undefined) { const error = el("p", "browse-text browse-error", state.error); error.setAttribute("role", "alert"); nodes.push(error); }
        return nodes;
    };
    const retryButton = (): FocusItem[] => state.error === undefined ? [] : [button("retry", state.canRetry ? "Check and retry" : "Reload settings", () => { void state.retry(); })];

    const renderPicker = (): void => {
        const hidden = picker === "hidden";
        const key = hidden ? HIDDEN_KEY : AUDIO_KEY;
        const stored = state.explicit.get(key);
        const controls: FocusItem[] = [actionButton("back", "Back", back)];
        const content: HTMLElement[] = [el("h1", "browse-title", hidden ? "Hidden libraries" : "Preferred audio"), note(key), ...feedback()];
        if (hidden) {
            const ids = stored?.isSet && Array.isArray(stored.value) ? stored.value : [];
            for (const library of state.libraries) {
                let id: number;
                try { id = numericLibraryId(library.id); } catch { content.push(el("p", "browse-text", `${library.name} · Unavailable`)); continue; }
                const selected = ids.includes(id);
                const item = button(`library:${library.id}`, `${library.name} · ${selected ? "Hidden" : "Visible"}`, () => { void state.setHidden(library.id, !selected); });
                item.element.setAttribute("role", "checkbox");
                item.element.setAttribute("aria-checked", String(selected));
                controls.push(item);
            }
            if (state.libraries.length === 0) content.push(el("p", "browse-text", "No accessible libraries."));
            const visibleIds = new Set(state.libraries.map(library => library.id));
            const unavailable = ids.filter(id => !visibleIds.has(String(id))).length;
            if (unavailable > 0) content.push(el("p", "browse-text", `${unavailable} unavailable ${unavailable === 1 ? "library will" : "libraries will"} remain hidden.`));
            controls.push(button("clear-hidden", "No hidden libraries", () => { void commit(key, null); }));
        } else {
            const current = stored?.isSet ? stored.value : undefined;
            const effective = state.effective.get(AUDIO_KEY);
            const options = [...new Set([...state.audioOptions, ...(effective?.suggestedValues?.filter((value): value is string | null => value === null || typeof value === "string") ?? []), ...(typeof current === "string" ? [current] : [])])];
            content.push(el("p", "browse-text", "Profile default. Device, library and series choices can take priority."));
            for (const value of options) {
                const item = button(`audio:${value ?? "null"}`, valueLabel(value), () => { void commit(key, value); });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(stored?.isSet === true && current === value));
                controls.push(item);
            }
        }
        if (stored?.isSet) controls.push(button("reset", "Use inherited default", () => { void commit(key, undefined); }));
        controls.push(...retryButton());
        content.push(zoneNode("settings-controls", controls));
        host.show({ name: `settings:${picker}`, content, zones: [{ id: "settings-picker", layout: "column", items: controls }], focus: { zone: "settings-picker", key: "back" }, back }, undefined);
    };

    function render(focus?: FocusTarget): void {
        if (torn) return;
        if (picker !== undefined) { renderPicker(); return; }
        const categories = (["general", "playback"] as const).map(id => {
            const item = actionButton(id, id === "general" ? "General" : "Playback", () => { category = id; render(rowFocus()); });
            item.element.setAttribute("aria-current", id === category ? "page" : "false");
            item.element.addEventListener("focus", () => { if (category !== id) { category = id; render({ zone: "settings-categories", key: id }); } });
            return item;
        });
        const rows: FocusItem[] = [];
        const body = el("div", "settings-pane");
        body.append(el("h2", "browse-section-title", category === "general" ? "General" : "Playback"), ...feedback());
        const key = category === "general" ? HIDDEN_KEY : AUDIO_KEY;
        if (state.loaded && state.definitions.some(def => def.key === key)) {
            rows.push(button(category === "general" ? "hidden" : "audio", `${category === "general" ? "Hidden libraries" : "Preferred audio"} · ${profileValue(key)}`, () => openPicker(category === "general" ? "hidden" : "audio")));
            body.appendChild(note(key));
        } else if (state.loaded) body.appendChild(el("p", "browse-text", "No supported settings in this category."));
        rows.push(...retryButton());
        rows.push(actionButton("settings-back", "Back", back));
        body.appendChild(zoneNode("settings-controls", rows));
        const panes = el("div", "settings-panes");
        panes.append(zoneNode("settings-categories", categories), body);
        host.show({ name: "settings", content: [el("h1", "browse-title", "Settings"), el("p", "settings-scope", "Profile defaults"), panes], zones: [
            { id: "settings-categories", layout: "column", right: "settings-rows", items: categories },
            { id: "settings-rows", layout: "column", left: "settings-categories", items: rows },
        ], focus: { zone: "settings-categories", key: category }, back }, focus);
    }
    host.listen();
    render();
    void state.load();
    return { destroy };
}

function valueLabel(value: SettingValue, key: SettingsKey = AUDIO_KEY): string {
    if (value === null) return key === HIDDEN_KEY ? "None hidden" : "No preference";
    if (Array.isArray(value)) return `${value.length} hidden`;
    return value === "x-silo-original" ? "Original language" : String(value);
}
