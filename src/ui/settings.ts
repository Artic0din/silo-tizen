import type { NativeSession } from "../session/session.ts";
import { AUDIO_KEY, HIDDEN_KEY, QUALITY_KEY, BITRATE_KEY, SEEK_BACK_KEY, SEEK_FORWARD_KEY, TITLE_ART_KEY, numericLibraryId, type SettingValue, type SettingsKey } from "../contracts/v2/settings.ts";
import { FocusHost, type FocusItem, type FocusTarget } from "./browseFocus.ts";
import { actionButton, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import { remoteKey } from "./keys.ts";
import { SettingsState } from "./settingsState.ts";
import type { ProfileLaunch } from "../session/profileLaunch.ts";

type Category = "general" | "playback";
type Picker = "hidden" | "audio" | "quality" | "bitrate" | "seek-back" | "seek-forward";
const PICKER_KEYS = { hidden: HIDDEN_KEY, audio: AUDIO_KEY, quality: QUALITY_KEY, bitrate: BITRATE_KEY, "seek-back": SEEK_BACK_KEY, "seek-forward": SEEK_FORWARD_KEY } as const;
const PICKER_LABELS = { hidden: "Hidden libraries", audio: "Preferred audio", quality: "Preferred quality", bitrate: "Maximum bitrate", "seek-back": "Video rewind interval", "seek-forward": "Video fast-forward interval" } as const;
export interface SettingsScreen { destroy(): void }

export function mountSettings(root: HTMLElement, session: NativeSession, close: (hiddenChanged: boolean) => void, launch?: ProfileLaunch): SettingsScreen {
    const container = el("section", "browse settings");
    container.setAttribute("aria-label", "Settings");
    root.appendChild(container);
    const host = new FocusHost(container);
    let category: Category = "general";
    let picker: Picker | undefined;
    let returnRow: Picker = "hidden";
    let bitrateDraft = "";
    let bitrateError: string | undefined;
    let torn = false;
    let launchPending = false;
    let launchError = false;
    let launchTarget = false;
    const launchController = new AbortController();
    const saveLaunch = (remember: boolean): void => {
        if (launchPending || launch === undefined) return;
        launchTarget = remember;
        launchPending = true;
        launchError = false;
        render();
        launch.setRemember(remember, launchController.signal).then(() => {
            if (torn) return;
            launchPending = false;
            render();
        }, () => {
            if (torn) return;
            launchPending = false;
            launchError = true;
            render();
        });
    };
    const state = new SettingsState(session, () => render());
    const destroy = (): void => {
        if (torn) return;
        torn = true;
        launchController.abort();
        stopAuthority();
        state.stop();
        container.removeEventListener("keydown", onKey, true);
        host.destroy();
        container.remove();
    };
    const stopAuthority = session.onAuthorityChange(destroy);
    const exit = (): void => { const changed = state.hiddenChanged; destroy(); close(changed); };
    const rowFocus = (): FocusTarget => ({ zone: "settings-rows", key: returnRow });
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
    const openPicker = (next: Picker): void => {
        picker = next;
        returnRow = next;
        bitrateError = undefined;
        const stored = state.explicit.get(BITRATE_KEY);
        bitrateDraft = stored?.isSet && typeof stored.value === "number" ? String(stored.value) : "";
        render({ zone: "settings-picker", key: "back" });
    };
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
        return stored?.isSet ? label(stored.value, key) : "Inherited";
    };
    const label = (value: SettingValue, key: SettingsKey): string => key === QUALITY_KEY || key === SEEK_BACK_KEY || key === SEEK_FORWARD_KEY
        ? state.definitions.find(def => def.key === key)?.options.find(option => option.value === value)?.label ?? String(value)
        : valueLabel(value, key);
    const note = (key: SettingsKey): HTMLElement => {
        const effective = state.effective.get(key);
        const sources: Readonly<Record<string, string>> = { default: "Inherited default", profile: "Profile default", profile_device: "Device override", profile_library: "Library override", profile_series: "Series override" };
        const source = effective === undefined ? "" : sources[effective.source] ?? effective.source.replace(/_/g, " ");
        const permitted = effective?.constrained && effective.permittedValues !== undefined ? ` · Permitted: ${effective.permittedValues.map(value => label(value, key)).join(", ")}` : "";
        const text = effective === undefined ? "" : `On this TV: ${label(effective.value, key)} · ${source}${effective.constrained ? " · Limited by server policy" : ""}${permitted}`;
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
        if (picker === undefined) return;
        const hidden = picker === "hidden";
        const key = PICKER_KEYS[picker];
        const stored = state.explicit.get(key);
        const controls: FocusItem[] = [actionButton("back", picker === "bitrate" ? "Cancel" : "Back", back)];
        const content: HTMLElement[] = [el("h1", "browse-title", picker === "bitrate" ? "Maximum bitrate (kbps)" : PICKER_LABELS[picker]), el("p", "settings-value", `Profile default: ${profileValue(key)}`), note(key), ...feedback()];
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
        } else if (picker === "audio") {
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
        } else if (picker === "quality" || picker === "seek-back" || picker === "seek-forward") {
            const current = stored?.isSet ? stored.value : undefined;
            const options = picker === "quality" ? state.qualityOptions : state.definitions.find(def => def.key === key)?.options ?? [];
            if (current !== undefined && !options.some(option => option.value === current)) content.push(el("p", "browse-text", `Current profile value: ${label(current, key)} · Not offered`));
            for (const option of options) {
                const item = button(`${picker}:${option.value}`, option.label, () => { void commit(key, option.value); });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(current === option.value));
                controls.push(item);
            }
        } else {
            const input = el("input", "browse-button settings-input");
            input.type = "text";
            input.inputMode = "numeric";
            input.pattern = "[0-9]*";
            input.setAttribute("aria-label", "Maximum bitrate (kbps)");
            input.setAttribute("data-focus", "bitrate-input");
            input.value = bitrateDraft;
            input.readOnly = state.busy || state.canRetry;
            input.addEventListener("input", () => { bitrateDraft = input.value; });
            if (bitrateError !== undefined) {
                input.setAttribute("aria-invalid", "true");
                input.setAttribute("aria-describedby", "bitrate-error");
                const error = el("p", "browse-text browse-error", bitrateError);
                error.id = "bitrate-error";
                error.setAttribute("role", "alert");
                content.push(error);
            }
            controls.push({ key: "bitrate-input", element: input });
            controls.push(button("save", "Save", () => {
                const cap = Number(bitrateDraft);
                if (!/^\d+$/.test(bitrateDraft) || !Number.isInteger(cap) || cap < 100 || cap > 200000) {
                    bitrateError = "Enter a whole number from 100 to 200000 kbps, or choose No limit.";
                    render();
                    return;
                }
                bitrateError = undefined;
                void commit(key, cap);
            }));
            controls.push(button("no-limit", "No limit", () => { void commit(key, null); }));
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
            const item = actionButton(id, id === "general" ? "General" : "Playback", () => { category = id; returnRow = id === "general" ? "hidden" : "audio"; render(rowFocus()); });
            item.element.setAttribute("aria-current", id === category ? "page" : "false");
            item.element.addEventListener("focus", () => { if (category !== id) { category = id; render({ zone: "settings-categories", key: id }); } });
            return item;
        });
        const rows: FocusItem[] = [];
        const body = el("div", "settings-pane");
        body.append(el("h2", "browse-section-title", category === "general" ? "General" : "Playback"), ...feedback());
        const pickers: readonly Picker[] = category === "general" ? ["hidden"] : ["audio", "quality", "bitrate", "seek-back", "seek-forward"];
        const titleArt = state.effective.get(TITLE_ART_KEY);
        if (category === "general" && state.loaded && titleArt !== undefined) {
            const all = titleArt.source === "profile";
            for (const [key, text, checked, action] of [
                ["title-art", "Show Title Art", titleArt.value === true, () => { void state.save(TITLE_ART_KEY, titleArt.value !== true); }],
                ["title-art-all", "Apply to All Devices", all, () => { void state.setTitleArtScope(!all); }],
            ] as const) {
                const item = button(key, text, action);
                item.element.setAttribute("role", "switch");
                item.element.setAttribute("aria-checked", String(checked));
                rows.push(item);
                body.appendChild(item.element);
            }
            body.appendChild(el("p", "settings-value", `${titleArt.value ? "On" : "Off"} · ${titleArt.source === "default" ? "Inherited default" : all ? "All devices" : "This TV"}`));
        }
        for (const id of pickers) {
            const key = PICKER_KEYS[id];
            if (!state.loaded || !state.definitions.some(def => def.key === key)) continue;
            const item = button(id, `${PICKER_LABELS[id]} · ${profileValue(key)}`, () => openPicker(id));
            rows.push(item);
            body.append(item.element, note(key));
        }
        if (category === "general" && launch !== undefined) {
            const item = actionButton("remember-profile", launchPending ? "Saving launch choice…" : launch.remembered ? "Launch profile: Remember this profile" : "Launch profile: Ask who's watching", () => saveLaunch(!launch.remembered));
            item.element.setAttribute("aria-disabled", String(launchPending));
            rows.push(item);
            body.appendChild(item.element);
            if (launchError) {
                const error = el("p", "browse-text browse-error", "Could not save the launch choice.");
                error.setAttribute("role", "alert");
                body.appendChild(error);
                const retry = actionButton("retry-launch", "Retry launch choice", () => saveLaunch(launchTarget));
                rows.push(retry); body.appendChild(retry.element);
            }
        }
        if (state.loaded && rows.length === 0) body.appendChild(el("p", "browse-text", "No supported settings in this category."));
        const settingRows = rows.length;
        rows.push(...retryButton());
        rows.push(actionButton("settings-back", "Back", back));
        body.classList.add("settings-controls");
        body.appendChild(zoneNode("settings-controls", rows.slice(settingRows)));
        const panes = el("div", "settings-panes");
        panes.append(zoneNode("settings-categories", categories), body);
        host.show({ name: "settings", content: [el("h1", "browse-title", "Settings"), panes], zones: [
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
    if (key === BITRATE_KEY) return value === null ? "No limit" : `${value} kbps`;
    if (value === null) return key === HIDDEN_KEY ? "None hidden" : "No preference";
    if (Array.isArray(value)) return `${value.length} hidden`;
    return value === "x-silo-original" ? "Original language" : String(value);
}
