import type { NativeSession } from "../session/session.ts";
import { AUDIO_KEY, HIDDEN_KEY, QUALITY_KEY, BITRATE_KEY, SEEK_BACK_KEY, SEEK_FORWARD_KEY, SHOW_FORCED_KEY, SUBTITLE_LANGUAGE_KEY, SUBTITLE_MODE_KEY, TITLE_ART_KEY, numericLibraryId, type SettingValue, type SettingsKey } from "../contracts/v2/settings.ts";
import { FocusHost, type FocusItem, type FocusTarget } from "./browseFocus.ts";
import { actionButton, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import { remoteKey } from "./keys.ts";
import { SettingsState } from "./settingsState.ts";
import type { ProfileLaunch, LaunchBehavior } from "../session/profileLaunch.ts";
import { acknowledgementsDocument } from "./acknowledgements.ts";
import { settingsRows, rowValue, rowEdit, type SettingsRow } from "./settingsRows.ts";
import { APPEARANCE_KEY } from "../contracts/v2/settingsRows.ts";
import { qrCode } from "./qr.ts";
import { navigationAvatar } from "./navigationAvatar.ts";
import { decodeAppearance, DEFAULT_APPEARANCE } from "../contracts/v2/subtitles.ts";
import { applySubtitleAppearance } from "../player/subtitleView.ts";

type Category = "general" | "playback" | "subtitles" | "server";
const CATEGORY_LABELS = { general: "General", playback: "Playback", subtitles: "Subtitles", server: "Server" } as const;
const CATEGORY_DETAILS = { general: "App and navigation", playback: "Quality and episodes", subtitles: "Language and appearance", server: "Connection and version" } as const;
const CATEGORY_BLURBS = {
    general: "App-level options for this TV.",
    playback: "Streaming quality and episode behavior for this TV.",
    subtitles: "Language, behavior, and on-screen appearance.",
    server: "The Silo server this TV is connected to.",
} as const;
const SUBTITLE_FOOTER = "Used to pick a matching track when one is available. Forced subtitles cover foreign-language dialogue even when subtitles are off or set to auto.";
const MODE_CHOICES = [["auto", "Auto"], ["always", "Always"], ["off", "Off"]] as const;
const LAUNCH_CHOICES = [["automatic", "Automatic"], ["askEveryLaunch", "Every Time"], ["afterOneHour", "After 1 Hour"], ["afterTwelveHours", "After 12 Hours"]] as const;
/** Apple scrolls its Acknowledgements document by remote presses while the document holds focus. */
const DOCUMENT_STEP = 160;
type Picker = "hidden" | "audio" | "quality" | "bitrate" | "seek-back" | "seek-forward" | "subtitle-language" | "subtitle-mode";
const PICKER_KEYS = { hidden: HIDDEN_KEY, audio: AUDIO_KEY, quality: QUALITY_KEY, bitrate: BITRATE_KEY, "seek-back": SEEK_BACK_KEY, "seek-forward": SEEK_FORWARD_KEY, "subtitle-language": SUBTITLE_LANGUAGE_KEY, "subtitle-mode": SUBTITLE_MODE_KEY } as const;
const PICKER_LABELS = { hidden: "Hidden libraries", audio: "Audio Language", quality: "Resolution", bitrate: "Maximum Bitrate", "seek-back": "Skip Back", "seek-forward": "Skip Forward", "subtitle-language": "Language", "subtitle-mode": "Behavior" } as const;
const BITRATE_CHOICES = [200000, 100000, 60000, 40000, 20000, 15000, 10000, 6000, 4000, 2000, 1500];
export interface SettingsActions { readonly profileName: string; readonly profileAvatarUrl?: string | undefined; readonly accountName?: string | undefined; readonly switchProfile: () => void; readonly signOut?: () => void; readonly serverName?: string | undefined; readonly switchServer?: () => void }
export interface SettingsScreen { destroy(): void }

export function mountSettings(root: HTMLElement, session: NativeSession, close: (hiddenChanged: boolean) => void, launch?: ProfileLaunch, actions?: SettingsActions): SettingsScreen {
    const container = el("section", "browse settings");
    container.setAttribute("aria-label", "Settings");
    root.appendChild(container);
    const host = new FocusHost(container);
    let category: Category = "general";
    let picker: Picker | undefined;
    let extraPicker: SettingsRow | undefined;
    let privacy = false;
    let paneSnapshot: HTMLElement | undefined;
    let activeModal: string | undefined;
    let confirmingAppearanceReset = false;
    let returnRow: Picker | "acknowledgements" | "subtitle-forced" = "hidden";
    let acknowledging = false;
    let confirmingSignOut = false;
    let choosingLaunch = false;
    let bitrateDraft = "";
    let bitrateError: string | undefined;
    let torn = false;
    let launchPending = false;
    let launchError = false;
    let launchTarget: LaunchBehavior = "askEveryLaunch";
    const launchController = new AbortController();
    const saveLaunch = (behavior: LaunchBehavior): void => {
        if (launchPending || launch === undefined) return;
        launchTarget = behavior;
        launchPending = true;
        launchError = false;
        render();
        launch.setBehavior(behavior, launchController.signal).then(() => {
            if (torn) return;
            launchPending = false;
            choosingLaunch = false;
            render({ zone: "settings-rows", key: "remember-profile" });
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
        if (confirmingAppearanceReset) { confirmingAppearanceReset = false; render({ zone: "settings-rows", key: "reset-appearance" }); }
        else if (privacy) { privacy = false; render({ zone: "settings-rows", key: "privacy" }); }
        else if (extraPicker !== undefined) { const key = extraPicker.id; extraPicker = undefined; render({ zone: "settings-rows", key }); }
        else if (choosingLaunch) { choosingLaunch = false; render({ zone: "settings-rows", key: "remember-profile" }); }
        else if (confirmingSignOut) { confirmingSignOut = false; render({ zone: "settings-categories", key: "settings-signout" }); }
        else if (acknowledging) { acknowledging = false; render(rowFocus()); }
        else if (picker !== undefined) { picker = undefined; render(rowFocus()); }
        else if (host.focused()?.zone !== "settings-categories") render({ zone: "settings-categories", key: category });
        else exit();
    };
    const onKey = (event: KeyboardEvent): void => {
        const key = remoteKey(event);
        if (picker === undefined && !acknowledging && !confirmingSignOut && key === "right" && host.focused()?.zone === "settings-categories") {
            event.preventDefault();
            const first = container.querySelector<HTMLElement>(".settings-pane [data-focus]")?.getAttribute("data-focus");
            if (first !== undefined && first !== null) render({ zone: "settings-rows", key: first });
            return;
        }
        const credits = container.querySelector<HTMLElement>(".acknowledgements-document");
        if (acknowledging && credits !== null && host.focused()?.key === "document" && (key === "up" || key === "down")) {
            // The document scrolls until an edge; Up from its top then reaches Done.
            const before = credits.scrollTop;
            credits.scrollTop += key === "down" ? DOCUMENT_STEP : -DOCUMENT_STEP;
            if (credits.scrollTop !== before || key === "down") event.preventDefault();
            return;
        }
        if (picker === undefined && !acknowledging && key === "left" && host.focused()?.zone === "settings-rows") {
            event.preventDefault();
            render({ zone: "settings-categories", key: category });
        }
    };
    container.addEventListener("keydown", onKey, true);
    const openPicker = (next: Picker): void => {
        picker = next;
        returnRow = next;
        bitrateError = undefined;
        const stored = state.stored(BITRATE_KEY);
        bitrateDraft = stored?.isSet && typeof stored.value === "number" ? String(stored.value) : "";
        render();
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
    const subtitleEntry = (): Picker | "subtitle-forced" => state.definitions.some(def => def.key === SUBTITLE_LANGUAGE_KEY) ? "subtitle-language" : state.definitions.some(def => def.key === SUBTITLE_MODE_KEY) ? "subtitle-mode" : "subtitle-forced";
    const subtitlePicker = (id: "subtitle-language" | "subtitle-mode", value: SettingValue): FocusItem => {
        const text = id === "subtitle-language" ? (typeof value === "string" ? value : "None") : value === "always" ? "Always" : value === "off" ? "Off" : "Auto";
        const item = button(id, PICKER_LABELS[id], () => openPicker(id));
        item.element.replaceChildren(el("span", "settings-row-title", PICKER_LABELS[id]), el("span", "settings-row-value", text), el("span", "settings-chevron", "›"));
        return item;
    };
    const profileValue = (key: SettingsKey): string => {
        const stored = state.explicit.get(key);
        return stored?.isSet ? label(stored.value, key) : "Inherited";
    };
    const label = (value: SettingValue, key: SettingsKey): string => key === QUALITY_KEY ? value === "2160p" ? "4K" : value === "auto" ? "Auto" : state.definitions.find(def => def.key === key)?.options.find(option => option.value === value)?.label ?? String(value) : key === SEEK_BACK_KEY || key === SEEK_FORWARD_KEY
        ? state.definitions.find(def => def.key === key)?.options.find(option => option.value === value)?.label ?? String(value)
        : valueLabel(value, key);
    const scopeValue = (key: SettingsKey): string => {
        const stored = state.stored(key);
        return state.scope(key) === "profile_device" ? `This TV: ${stored?.isSet ? label(stored.value, key) : "Use Profile Setting"}` : `Profile default: ${profileValue(key)}`;
    };
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

    const showModal = (name: string, title: string, content: HTMLElement[], controls: FocusItem[], zone = "settings-picker"): void => {
        const card = el("div", "settings-modal settings-controls");
        card.setAttribute("role", "dialog");
        card.setAttribute("aria-modal", "true");
        card.setAttribute("aria-label", title);
        const list = zoneNode("settings-modal-options", controls);
        list.dataset.scrollKey = name;
        for (const item of controls) {
            if (item.element.getAttribute("aria-checked") === "true") {
                const check = el("span", "settings-checkmark");
                check.setAttribute("aria-hidden", "true");
                item.element.appendChild(check);
            }
        }
        card.append(...content, list);
        const scrim = el("div", "settings-modal-scrim");
        scrim.appendChild(card);
        const background = paneSnapshot?.cloneNode(true) as HTMLElement | undefined;
        if (background !== undefined) {
            background.inert = true;
            background.setAttribute("aria-hidden", "true");
            background.querySelectorAll("[data-focus]").forEach(node => node.removeAttribute("data-focus"));
        }
        const selected = controls.find(item => item.element.getAttribute("aria-checked") === "true") ?? controls[0];
        const initialFocus = { zone, key: selected?.key ?? "" };
        const opening = activeModal !== name;
        activeModal = name;
        host.show({ name, content: [...(background === undefined ? [] : [background]), scrim], zones: [{ id: zone, layout: "column", items: controls }], focus: initialFocus, back }, opening ? initialFocus : undefined);
    };

    const renderPicker = (): void => {
        if (picker === undefined) return;
        const hidden = picker === "hidden";
        const key = PICKER_KEYS[picker];
        const stored = state.stored(key);
        const controls: FocusItem[] = [];
        const content: HTMLElement[] = [el("h1", "browse-title", picker === "bitrate" ? "Maximum bitrate (kbps)" : PICKER_LABELS[picker]), el("p", "settings-value", scopeValue(key)), ...(state.scope(key) === "profile_device" ? [el("p", "settings-value", `Profile default: ${profileValue(key)}`)] : []), note(key), ...feedback()];
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
            const current = stored?.isSet ? stored.value : state.scope(key) === "profile" ? state.effective.get(key)?.value : undefined;
            const effective = state.effective.get(AUDIO_KEY);
            const options = [...new Set([...state.audioOptions, ...(effective?.suggestedValues?.filter((value): value is string | null => value === null || typeof value === "string") ?? []), ...(typeof current === "string" ? [current] : [])])].filter(value => value !== null || state.scope(key) === "profile" || current === null);
            content.push(el("p", "browse-text", state.scope(key) === "profile_device" ? "This TV. Library and series choices can take priority." : "Profile default. Device, library and series choices can take priority."));
            for (const value of options) {
                const item = button(`audio:${value ?? "null"}`, valueLabel(value), () => { void commit(key, value); });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(current === value));
                controls.push(item);
            }
        } else if (picker === "subtitle-language" || picker === "subtitle-mode") {
            const current = state.subtitleProfileValue(picker === "subtitle-language" ? SUBTITLE_LANGUAGE_KEY : SUBTITLE_MODE_KEY);
            const choices: readonly (readonly [SettingValue, string])[] = picker === "subtitle-language" ? [[null, "None"], ...state.subtitleOptions.map(value => [value, value] as const)] : MODE_CHOICES;
            for (const [value, text] of choices) {
                const item = button(`${picker}:${value ?? "none"}`, text, () => {
                    if (current === value) { picker = undefined; render(rowFocus()); return; }
                    void commit(key, value);
                });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(current === value));
                controls.push(item);
            }
        } else if (picker === "quality" || picker === "seek-back" || picker === "seek-forward") {
            const current = stored?.isSet ? stored.value : state.scope(key) === "profile" ? state.effective.get(key)?.value : undefined;
            const options = picker === "quality" ? ["auto", "2160p", "1080p", "720p", "480p"].flatMap(value => state.qualityOptions.filter(option => option.value === value)) : state.definitions.find(def => def.key === key)?.options ?? [];
            if (current !== undefined && !options.some(option => option.value === current)) content.push(el("p", "browse-text", `Current ${state.scope(key) === "profile_device" ? "device" : "profile"} value: ${label(current, key)} · Not offered`));
            for (const option of options) {
                const item = button(`${picker}:${option.value}`, label(option.value, key), () => { void commit(key, option.value); });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(current === option.value));
                controls.push(item);
            }
        } else {
            const current = stored?.isSet ? stored.value : state.scope(key) === "profile" ? state.effective.get(key)?.value : undefined;
            const caps = [...new Set([...BITRATE_CHOICES, ...(typeof current === "number" ? [current] : [])])].sort((a, b) => b - a);
            for (const value of caps) {
                const item = button(`bitrate:${value}`, `${value / 1000} Mbps`, () => { void commit(key, value); });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(current === value));
                controls.push(item);
            }
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
            const noLimit = button("no-limit", "No limit", () => { void commit(key, null); });
            noLimit.element.setAttribute("aria-checked", String(current === null));
            controls.unshift(noLimit);
        }
        if (picker !== "subtitle-language" && picker !== "subtitle-mode" && (state.scope(key) === "profile_device" || stored?.isSet)) {
            const reset = button("reset", state.scope(key) === "profile_device" ? "Use Profile Setting" : "Use inherited default", () => { void commit(key, undefined); });
            if (state.scope(key) === "profile_device") { reset.element.setAttribute("role", "radio"); reset.element.setAttribute("aria-checked", String(stored?.isSet !== true)); }
            controls.unshift(reset);
        }
        controls.push(...retryButton());
        showModal(`settings:${picker}`, PICKER_LABELS[picker], content, controls);
    };

    const renderAcknowledgements = (): void => {
        const done = actionButton("done", "Done", back);
        const credits = acknowledgementsDocument();
        credits.tabIndex = 0;
        credits.setAttribute("data-focus", "document");
        credits.setAttribute("aria-label", "Acknowledgements and open-source licenses");
        const panel = el("div", "acknowledgements-panel");
        const heading = el("div", "acknowledgements-heading");
        heading.append(el("p", "acknowledgements-eyebrow", "CREDITS"), el("h1", "acknowledgements-title", "Acknowledgements"));
        const header = el("div", "acknowledgements-header");
        header.append(heading, zoneNode("acknowledgements-actions", [done]));
        panel.append(header, credits);
        host.show({ name: "settings:acknowledgements", content: [panel], zones: [
            { id: "acknowledgements-actions", layout: "row", down: "acknowledgements-document", items: [done] },
            { id: "acknowledgements-document", layout: "column", up: "acknowledgements-actions", items: [{ key: "document", element: credits }] },
        ], focus: { zone: "acknowledgements-document", key: "document" }, back }, undefined);
    };

    function render(focus?: FocusTarget): void {
        if (torn) return;
        if (confirmingAppearanceReset) {
            const controls = [actionButton("cancel", "Cancel", back), button("reset", "Reset", () => { void state.save(APPEARANCE_KEY, { ...DEFAULT_APPEARANCE }).then(() => { if (!torn && confirmingAppearanceReset && state.error === undefined) back(); }); }), ...retryButton()];
            host.show({ name: "settings:reset-appearance", content: [el("h1", "browse-title", "Reset Appearance?"), el("p", "settings-value", state.scope(APPEARANCE_KEY) === "profile_device" ? "This restores this TV's subtitle appearance to the defaults." : "This restores this profile's subtitle appearance to the defaults on all devices."), ...feedback(), zoneNode("settings-controls", controls)], zones: [{ id: "settings-picker", layout: "column", items: controls }], focus: { zone: "settings-picker", key: "cancel" }, back });
            return;
        }
        if (privacy) {
            const done = actionButton("back", "Done", back);
            const code = qrCode("https://siloserver.org/privacy", "Privacy Policy QR code");
            const image = el("div", "settings-privacy-qr");
            if (code !== undefined) { code.style.width = "320px"; code.style.height = "320px"; image.appendChild(code); }
            const copy = el("div", "settings-privacy-copy");
            copy.append(el("h1", "browse-title", "Privacy Policy"), el("p", "settings-value", "Scan this code with your phone or tablet to read Silo's privacy policy."), el("p", "settings-value", "https://siloserver.org/privacy"));
            const handoff = el("div", "settings-privacy-card");
            handoff.append(image, copy);
            showModal("settings:privacy", "Privacy Policy", [handoff], [done]);
            return;
        }
        if (extraPicker !== undefined) {
            const row = extraPicker;
            const current = rowValue(row, state);
            const controls = [...row.choices.map(([value, text]) => {
                const item = button(`choice:${String(value)}`, text, () => {
                    void state.save(row.key, rowEdit(row, value, state)).then(() => { if (!torn && extraPicker === row && state.error === undefined) back(); });
                });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(current === value));
                return item;
            })];
            const reset = button("reset-row", row.key === "ui.card_presentation" ? "Use Profile Default" : state.scope(row.key) === "profile_device" ? "Use Profile Setting" : "Use inherited default", () => { void state.reset(row.key).then(() => { if (!torn && extraPicker === row && state.error === undefined) back(); }); });
            if (state.scope(row.key) === "profile_device") {
                const inherited = state.stored(row.key)?.isSet !== true;
                reset.element.setAttribute("aria-checked", String(inherited));
                if (inherited) for (const item of controls) item.element.setAttribute("aria-checked", "false");
            }
            controls.unshift(reset);
            controls.push(...retryButton());
            showModal(`settings:${row.id}`, row.title, [el("h1", "browse-title", row.title), ...feedback()], controls);
            return;
        }
        if (choosingLaunch && launch !== undefined) {
            const controls = [...LAUNCH_CHOICES.map(([behavior, text]) => {
                const item = actionButton(`launch:${behavior === "automatic" ? "true" : behavior === "askEveryLaunch" ? "false" : behavior}`, text, () => { if (!launchPending) saveLaunch(behavior); });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(launch.behavior === behavior));
                const descriptions = {
                    automatic: "Use the last profile selected on this device. A protected profile can reopen without asking for its PIN.",
                    askEveryLaunch: "Show Who's Watching whenever you return to Silo.",
                    afterOneHour: "Show Who's Watching when you've been away from Silo for 1 hour.",
                    afterTwelveHours: "Show Who's Watching when you've been away from Silo for 12 hours.",
                };
                const detail = el("span", "settings-option-detail", descriptions[behavior]);
                detail.id = `settings-launch-${behavior}-detail`;
                item.element.setAttribute("aria-label", text);
                item.element.setAttribute("aria-describedby", detail.id);
                item.element.appendChild(detail);
                item.element.setAttribute("aria-disabled", String(launchPending));
                return item;
            })];
            showModal("settings:launch", "Profile Selection", [el("h1", "browse-title", "Profile Selection"), ...(launchError ? [el("p", "browse-error", "Could not save the launch choice. Try again.")] : []), ...(launchPending ? [el("p", "browse-text", "Saving launch choice…")] : [])], controls, "settings-launch");
            return;
        }
        if (confirmingSignOut) {
            const account = actions?.accountName?.trim() || "this account";
            const server = actions?.serverName?.trim() || "this server";
            const controls = [actionButton("cancel-signout", "Cancel", back), actionButton("confirm-signout", "Sign Out", () => { destroy(); actions?.signOut?.(); })];
            host.show({ name: "settings:signout", content: [el("h1", "browse-title", `Sign out of ${account} on ${server}?`), el("p", "settings-value", "This account's profiles and settings leave this TV. The server stays saved, so you can sign in again."), zoneNode("settings-controls", controls)], zones: [{ id: "settings-confirm", layout: "column", items: controls }], focus: { zone: "settings-confirm", key: "cancel-signout" }, back });
            return;
        }
        if (acknowledging) { renderAcknowledgements(); return; }
        if (picker !== undefined) { renderPicker(); return; }
        activeModal = undefined;
        const categories = (["general", "playback", "subtitles", "server"] as const).map(id => {
            const item = actionButton(id, CATEGORY_LABELS[id], () => { category = id; returnRow = id === "general" ? "hidden" : id === "playback" ? "quality" : id === "subtitles" ? subtitleEntry() : "acknowledgements"; render(rowFocus()); });
            item.element.replaceChildren(el("span", "settings-category-title", CATEGORY_LABELS[id]), el("span", "settings-category-detail", CATEGORY_DETAILS[id]));
            item.element.setAttribute("aria-label", `${CATEGORY_LABELS[id]}, ${CATEGORY_DETAILS[id]}`);
            item.element.setAttribute("aria-current", id === category ? "page" : "false");
            item.element.addEventListener("focus", () => { if (category !== id) { category = id; render({ zone: "settings-categories", key: id }); } });
            return item;
        });
        if (actions !== undefined) {
            const account = session.account?.role === "admin" ? "Administrator" : actions.accountName?.trim() || "Signed in";
            const profile = actionButton("settings-profile", actions.profileName, () => { destroy(); actions.switchProfile(); });
            profile.element.classList.add("settings-profile");
            const copy = el("span", "settings-profile-copy");
            copy.append(el("span", "settings-profile-name", actions.profileName), el("span", "settings-profile-account", account));
            profile.element.replaceChildren(navigationAvatar(actions.profileName, actions.profileAvatarUrl, session.http.base.baseUrl, 64), copy, el("span", "settings-chevron", "›"));
            profile.element.setAttribute("aria-label", `${actions.profileName}, ${account}`);
            categories.unshift(profile);
            if (actions.signOut !== undefined) {
                const signOut = actionButton("settings-signout", "Sign Out", () => { confirmingSignOut = true; render(); });
                signOut.element.classList.add("settings-signout");
                categories.push(signOut);
            }
        }
        const rows: FocusItem[] = [];
        const body = el("div", "settings-pane");
        body.append(el("h2", "browse-section-title", CATEGORY_LABELS[category]), el("p", "settings-blurb", CATEGORY_BLURBS[category]), ...(category === "server" ? [] : feedback()));
        const pickers: readonly Picker[] = category === "server" ? ["hidden"] : category === "playback" ? ["quality", "bitrate", "audio", "seek-back", "seek-forward"] : [];
        if (category === "server") {
            body.append(el("h3", "settings-section-header", "ACTIVE SERVER"), el("p", "settings-value", `Server: ${actions?.serverName ?? session.http.base.baseUrl}`));
            body.appendChild(el("p", "settings-value", `Address: ${session.http.base.baseUrl}`));
            const policy = actionButton("privacy", "Privacy Policy", () => { privacy = true; render(); });

            if (actions?.switchServer !== undefined) {
                const manage = actionButton("manage-servers", "Manage Servers", () => { destroy(); actions.switchServer?.(); });
                rows.push(manage); body.appendChild(manage.element);
            }
            // Apple's Server pane: an ABOUT section whose Acknowledgements row opens the credits.
            const item = actionButton("acknowledgements", "Acknowledgements", () => { acknowledging = true; returnRow = "acknowledgements"; render(); });
            body.append(el("h3", "settings-section-header", "ABOUT"), el("p", "settings-value", `App Version: ${APP_VERSION}`), policy.element, item.element);
            rows.push(policy);
            rows.push(item);
        }
        if (category === "general" && launch !== undefined) {
            const item = actionButton("remember-profile", "Profile Selection", () => { choosingLaunch = true; render(); });
            item.element.append(el("span", "settings-row-value", LAUNCH_CHOICES.find(([value]) => value === launch.behavior)?.[1] ?? "Every Time"), el("span", "settings-chevron", "›"));
            item.element.setAttribute("aria-disabled", String(launchPending));
            rows.push(item);
            body.append(el("h3", "settings-section-header", "PROFILE AT LAUNCH"), item.element);
            if (launchError) {
                const error = el("p", "browse-text browse-error", "Could not save the launch choice.");
                error.setAttribute("role", "alert");
                body.appendChild(error);
                const retry = actionButton("retry-launch", "Retry launch choice", () => saveLaunch(launchTarget));
                rows.push(retry); body.appendChild(retry.element);
            }
        }
        const titleArt = state.effective.get(TITLE_ART_KEY);
        if (category === "general" && state.loaded && titleArt !== undefined) {
            body.appendChild(el("h3", "settings-section-header", "TITLE PAGES"));
            const all = titleArt.source === "profile";
            for (const [key, text, checked, action] of [
                ["title-art", "Show Title Art", titleArt.value === true, () => { void state.save(TITLE_ART_KEY, titleArt.value !== true); }],
                ["title-art-all", "Apply to All Devices", all, () => { void state.setTitleArtScope(!all); }],
            ] as const) {
                const item = button(key, text, action);
                item.element.appendChild(el("span", "settings-row-value", checked ? "On" : "Off"));
                item.element.setAttribute("role", "switch");
                item.element.setAttribute("aria-label", text);
                item.element.setAttribute("aria-checked", String(checked));
                rows.push(item);
                body.appendChild(item.element);
            }
            body.appendChild(el("p", "settings-value", `${titleArt.value ? "On" : "Off"} · ${titleArt.source === "default" ? "Inherited default" : all ? "All devices" : "This TV"}`));
        }
        for (const id of pickers) {
            const key = PICKER_KEYS[id];
            if (!state.loaded || !state.definitions.some(def => def.key === key)) continue;
            const section = id === "quality" ? "QUALITY" : id === "audio" ? "STREAMING" : id === "seek-back" ? "VIDEO" : undefined;
            if (section !== undefined) body.appendChild(el("h3", "settings-section-header", section));
            const item = button(id, PICKER_LABELS[id], () => openPicker(id));
            const value = state.effective.get(key)?.value ?? null;
            const displayValue = key === BITRATE_KEY && typeof value === "number" && value >= 1000 ? `${Number((value / 1000).toFixed(1))} Mbps` : label(value, key);
            item.element.replaceChildren(el("span", "settings-row-title", PICKER_LABELS[id]), el("span", "settings-row-value", displayValue), el("span", "settings-chevron", "›"));
            rows.push(item);
            body.append(item.element);
        }
        if (category === "subtitles" && state.loaded) {
            const language = state.definitions.some(def => def.key === SUBTITLE_LANGUAGE_KEY);
            const mode = state.definitions.some(def => def.key === SUBTITLE_MODE_KEY);
            const forced = state.definitions.some(def => def.key === SHOW_FORCED_KEY);
            if (language || mode || forced) {
                body.appendChild(el("h3", "settings-section-header", "PROFILE"));
                if (language) rows.push(subtitlePicker("subtitle-language", state.subtitleProfileValue(SUBTITLE_LANGUAGE_KEY)));
                if (mode) rows.push(subtitlePicker("subtitle-mode", state.subtitleProfileValue(SUBTITLE_MODE_KEY)));
                if (forced) {
                    const on = state.subtitleProfileValue(SHOW_FORCED_KEY) === true;
                    const item = button("subtitle-forced", "Show Forced Subtitles", () => { void state.save(SHOW_FORCED_KEY, !on); });
                    item.element.appendChild(el("span", "settings-row-value", on ? "On" : "Off"));
                    item.element.setAttribute("role", "switch");
                    item.element.setAttribute("aria-label", "Show Forced Subtitles");
                    item.element.setAttribute("aria-checked", String(on));
                    rows.push(item);
                }
                for (const item of rows) body.appendChild(item.element);
                body.appendChild(el("p", "settings-value", SUBTITLE_FOOTER));
                const override = subtitleOverride(state);
                if (override !== undefined) body.appendChild(el("p", "settings-value", `Override active — ${override}`));
            }
        }
        if (state.loaded) {
            for (const row of settingsRows(category, state)) {
                const value = rowValue(row, state);
                const item = button(row.id, row.title, () => {
                    if (row.id === "poster-size" && state.effective.get(row.key)?.source === "profile_device") return;
                    if (row.id === "advisory-age" || row.member === "textOutline") { void state.save(row.key, rowEdit(row, value !== true, state)); return; }
                    extraPicker = row; render();
                });
                item.element.appendChild(el("span", "settings-row-value", row.choices.find(([choice]) => choice === value)?.[1] ?? String(value)));
                if (row.id === "advisory-age" || row.member === "textOutline") { item.element.setAttribute("role", "switch"); item.element.setAttribute("aria-label", row.title); item.element.setAttribute("aria-checked", String(value === true)); }
                rows.push(item); body.appendChild(item.element);
                if (row.id === "poster-size" && state.client.get(row.key)?.isSet) {
                    const inherited = button("poster-profile-default", "Use Profile Default", () => { void state.reset(row.key); });
                    rows.push(inherited); body.appendChild(inherited.element);
                }
                if (row.id === "poster-size" && state.effective.get(row.key)?.source === "profile_device") {
                    item.element.setAttribute("aria-disabled", "true");
                    const synced = button("use-synced-tv", "Use Synced TV Settings", () => { void state.resetPosterDevice(); });
                    rows.push(synced); body.appendChild(synced.element);
                }
            }
            if (category === "subtitles" && state.definitions.some(def => def.key === APPEARANCE_KEY)) {
                const preview = el("div", "settings-subtitle-preview");
                const text = el("span", "", "Subtitles will look like this");
                preview.appendChild(text);
                const stored = state.stored(APPEARANCE_KEY);
                applySubtitleAppearance(preview, text, decodeAppearance({ profile_id: "preview", effective_value: JSON.stringify(stored?.isSet ? stored.value : {}) }, "preview"));
                preview.style.position = "relative"; preview.style.height = "150px";
                text.style.position = "absolute";
                text.style.top = preview.style.top; text.style.bottom = preview.style.bottom;
                preview.style.top = "auto"; preview.style.bottom = "auto";
                body.appendChild(preview);
                const reset = button("reset-appearance", "Reset Appearance", () => { confirmingAppearanceReset = true; render(); });
                rows.push(reset); body.append(reset.element, note(APPEARANCE_KEY));
                if (state.definitions.some(def => def.key === APPEARANCE_KEY && def.device)) {
                    const device = state.scope(APPEARANCE_KEY) === "profile_device";
                    const toggle = button("appearance-device", "Only on This TV", () => { void state.setAppearanceDevice(!device); });
                    toggle.element.setAttribute("role", "switch"); toggle.element.setAttribute("aria-label", "Only on This TV"); toggle.element.setAttribute("aria-checked", String(device));
                    rows.push(toggle); body.appendChild(toggle.element);
                }
            }
        }
        if (state.loaded && rows.length === 0) body.appendChild(el("p", "browse-text", "No supported settings in this category."));
        const settingRows = rows.length;
        if (category !== "server") rows.push(...retryButton());

        body.classList.add("settings-controls");
        body.appendChild(zoneNode("settings-controls", rows.slice(settingRows)));
        const panes = el("div", "settings-panes");
        const rail = zoneNode("settings-categories", categories);
        rail.appendChild(el("p", "settings-version", `Silo ${APP_VERSION}`));
        panes.append(rail, body);
        paneSnapshot = panes;
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

const SUBTITLE_OVERRIDE: Readonly<Record<string, string>> = {
    profile_client: "This device family has a more specific subtitle setting. Changes here update the profile default, but the family override still applies.",
    profile_device: "This device, for this profile, has a more specific subtitle setting. Changes here update the profile default, but the device override still applies.",
    profile_library: "A library-specific subtitle setting overrides this profile default. Changes here are saved for the profile, but the library override still applies.",
    profile_series: "A series-specific subtitle setting overrides this profile default. Changes here are saved for the profile, but the series override still applies.",
};
const MIXED_SUBTITLE_OVERRIDE = "More specific device, library, or series subtitle settings override this profile default. Changes here are saved for the profile, but those overrides still apply where configured.";

function subtitleOverride(state: SettingsState): string | undefined {
    const scopes = new Set<string>();
    for (const key of [SUBTITLE_LANGUAGE_KEY, SUBTITLE_MODE_KEY, SHOW_FORCED_KEY] as const) {
        const source = state.effective.get(key)?.source;
        if (source === undefined || source === "profile" || source === "account" || source === "default") continue;
        scopes.add(source);
    }
    if (scopes.size === 0) return undefined;
    if (scopes.size > 1) return MIXED_SUBTITLE_OVERRIDE;
    const [scope] = [...scopes];
    return scope === undefined ? undefined : SUBTITLE_OVERRIDE[scope] ?? "A more specific subtitle setting overrides this profile default. Changes here are saved for the profile, but the override still applies.";
}

function valueLabel(value: SettingValue, key: SettingsKey = AUDIO_KEY): string {
    if (key === BITRATE_KEY) return value === null ? "No limit" : `${value} kbps`;
    if (value === null) return key === HIDDEN_KEY ? "None hidden" : "No preference";
    if (Array.isArray(value)) return `${value.length} hidden`;
    if (typeof value === "object") return key === "ui.card_presentation" && "poster_size" in value ? String(value.poster_size) : "Custom appearance";
    return value === "x-silo-original" ? "Original language" : String(value);
}
