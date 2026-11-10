import type { NativeSession } from "../session/session.ts";
import { AUDIO_KEY, HDR_KEY, HIDDEN_KEY, QUALITY_KEY, BITRATE_KEY, SEEK_BACK_KEY, SEEK_FORWARD_KEY, SHOW_FORCED_KEY, SUBTITLE_LANGUAGE_KEY, SUBTITLE_MODE_KEY, TITLE_ART_KEY, type SettingValue, type SettingsKey } from "../contracts/v2/settings.ts";
import { FocusHost, type FocusItem, type FocusTarget } from "./browseFocus.ts";
import { actionButton, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import { remoteKey } from "./keys.ts";
import { SettingsState } from "./settingsState.ts";
import type { ProfileLaunch, LaunchBehavior } from "../session/profileLaunch.ts";
import { acknowledgementsDocument } from "./acknowledgements.ts";
import type { EpisodeSpoilerPreferences } from "./episodeSpoilers.ts";
import { settingsRows, rowValue, rowEdit, BUFFERING_ROW_ID, type SettingsRow } from "./settingsRows.ts";
import { APPEARANCE_KEY, BUFFERING_MODE_KEY } from "../contracts/v2/settingsRows.ts";
import { qrCode } from "./qr.ts";
import { navigationAvatar } from "./navigationAvatar.ts";
import { navigationIcon } from "./navigationIcon.ts";
import { decodeAppearance, DEFAULT_APPEARANCE } from "../contracts/v2/subtitles.ts";
import { applySubtitleAppearance } from "../player/subtitleView.ts";
import { pairedProfileDescription, pairedProfileLabel, profileSelectionCaption } from "./pairedProfile.ts";
import { BUFFERING_QUALITY_MODES, BUFFERING_QUALITY_TITLE, bitrateLabel, qualityFooter } from "./qualitySettings.ts";
import { ConnectionSpeed, LEARNED_LIMIT_RESET_ACTION, learnedLimitText } from "./connectionSpeed.ts";
import { signOutConfirmationCopy } from "./signOutConfirmation.ts";
import type { ShowAudiobooks } from "./audiobookPreference.ts";
import { EXPERIMENTAL_FEATURES, type ExperimentalFeatures } from "../session/experimentalFeatures.ts";

type Category = "general" | "playback" | "subtitles" | "server";
const CATEGORY_LABELS = { general: "General", playback: "Playback", subtitles: "Subtitles", server: "Server" } as const;
const CATEGORY_DETAILS = { general: "App and navigation", playback: "Quality and episodes", subtitles: "Language and appearance", server: "Connection and version" } as const;
const CATEGORY_ICONS = { general: "settings", playback: "playback", subtitles: "subtitles", server: "switch-server" } as const;
const CATEGORY_BLURBS = {
    general: "App-level options for this TV.",
    playback: "Streaming quality and episode behavior for this TV.",
    subtitles: "Language, behavior, and on-screen appearance.",
    server: "The Silo server this TV is connected to.",
} as const;
const SUBTITLE_FOOTER = "Used to pick a matching track when one is available. Forced subtitles cover foreign-language dialogue even when subtitles are off or set to auto.";
/** First sentence of SettingsViewModel.hdrFooterText (136-143), without "without Dolby Vision". The tvOS original-file sentence is omitted; see docs/settings.md. */
// After STREAMING, as TVPlaybackSettingsView.swift:248. The Lossless and TrueHD sentences at 251-257 are not on this pane.
const HDR_FOOTER = "With HDR off, videos the server converts for this device are sent in SDR.";
/** tvOS preview point sizes at 1080 lines, then ×0.5. SubtitleAppearance.swift:36-41; SubtitleAppearancePreview.swift:19-21,128-129. */
const TV_PREVIEW_POINT_SIZE = { small: 43, medium: 51, large: 58, xlarge: 74, xxlarge: 88 } as const;
const MODE_CHOICES = [["auto", "Auto"], ["always", "Always"], ["off", "Off"]] as const;
const LAUNCH_CHOICES = [["automatic", "Automatic"], ["askEveryLaunch", "Every Time"], ["afterOneHour", "After 1 Hour"], ["afterTwelveHours", "After 12 Hours"]] as const;
/** Apple scrolls its Acknowledgements document by remote presses while the document holds focus. */
const DOCUMENT_STEP = 160;
type Picker = "audio" | "quality" | "bitrate" | "seek-back" | "seek-forward" | "subtitle-language" | "subtitle-mode";
const PICKER_KEYS = { audio: AUDIO_KEY, quality: QUALITY_KEY, bitrate: BITRATE_KEY, "seek-back": SEEK_BACK_KEY, "seek-forward": SEEK_FORWARD_KEY, "subtitle-language": SUBTITLE_LANGUAGE_KEY, "subtitle-mode": SUBTITLE_MODE_KEY } as const;
const PICKER_LABELS = { audio: "Audio Language", quality: "Resolution", bitrate: "Maximum Bitrate", "seek-back": "Skip Back", "seek-forward": "Skip Forward", "subtitle-language": "Language", "subtitle-mode": "Behavior" } as const;
const BITRATE_CHOICES = [200000, 100000, 60000, 40000, 20000, 15000, 10000, 6000, 4000, 2000, 1500];
export interface SettingsActions { readonly showAudiobooks?: ShowAudiobooks; readonly profileName: string; readonly profileAvatarUrl?: string | undefined; readonly accountName?: string | undefined; readonly switchProfile: () => void; readonly signOut?: () => void; readonly serverName?: string | undefined; readonly switchServer?: (back: () => void) => void; /** True when this sign-out removes the saved server. Unreadable account lists return false. */ readonly removesServer?: () => boolean }
export interface SettingsScreen { destroy(): void }

export function mountSettings(root: HTMLElement, session: NativeSession, close: (hiddenChanged: boolean, titleArt?: boolean) => void, launch?: ProfileLaunch, actions?: SettingsActions, accounts?: (back: () => void) => void, spoilers?: EpisodeSpoilerPreferences, experimental?: ExperimentalFeatures): SettingsScreen {
    const container = el("section", "browse settings");
    container.setAttribute("aria-label", "Settings");
    root.appendChild(container);
    const host = new FocusHost(container);
    let category: Category = "general";
    let picker: Picker | undefined;
    let extraPicker: SettingsRow | undefined;
    let confirmingPlaybackReset = false;
    let pendingPlaybackReset: SettingsKey[] = [];
    let privacy = false;
    let paneSnapshot: HTMLElement | undefined;
    let activeModal: string | undefined;
    let modalPaneTop = 0;
    let confirmingAppearanceReset = false;
    let returnRow: Picker | "acknowledgements" | "subtitle-forced" = "acknowledgements";
    let acknowledging = false;
    let confirmingSignOut = false;
    let choosingLaunch = false;
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
            const focus = choosingLaunch ? { zone: "settings-rows", key: "remember-profile" } : undefined;
            choosingLaunch = false;
            render(focus);
        }, () => {
            if (torn) return;
            launchPending = false;
            launchError = true;
            render();
        });
    };
    const state = new SettingsState(session, () => render());
    const connection = new ConnectionSpeed(session, () => { if (!torn) render(host.focused()); });
    const stopSpoilers = spoilers?.subscribe(() => { if (!torn) render(host.focused()); }) ?? (() => undefined);
    const destroy = (): void => {
        if (torn) return;
        torn = true;
        connection.stop();
        stopSpoilers();
        launchController.abort();
        stopAuthority();
        state.stop();
        container.removeEventListener("keydown", onKey, true);
        host.destroy();
        container.remove();
    };
    const stopAuthority = session.onAuthorityChange(destroy);
    const exit = (): void => {
        const changed = state.hiddenChanged;
        const titleArt = state.effective.get(TITLE_ART_KEY)?.value;
        destroy();
        close(changed, typeof titleArt === "boolean" ? titleArt : undefined);
    };
    const rowFocus = (): FocusTarget => ({ zone: "settings-rows", key: returnRow });
    const back = (): void => {
        if (confirmingPlaybackReset) { if (state.busy) return; confirmingPlaybackReset = false; pendingPlaybackReset = []; render({ zone: "settings-rows", key: "reset-playback" }); }
        else if (confirmingAppearanceReset) { confirmingAppearanceReset = false; render({ zone: "settings-rows", key: "reset-appearance" }); }
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
    const devicePlaybackKeys = (): readonly SettingsKey[] => [QUALITY_KEY, BITRATE_KEY, AUDIO_KEY, HDR_KEY, ...settingsRows("playback", state).map(row => row.key)];
    const hdrSwitch = (id: string, title: string, on: boolean, action: () => void): FocusItem => {
        const item = button(id, title, action);
        item.element.appendChild(el("span", "settings-row-value", on ? "On" : "Off"));
        item.element.setAttribute("role", "switch");
        item.element.setAttribute("aria-label", title);
        item.element.setAttribute("aria-checked", String(on));
        return item;
    };
    const subtitleEntry = (): Picker | "subtitle-forced" => state.definitions.some(def => def.key === SUBTITLE_LANGUAGE_KEY) ? "subtitle-language" : state.definitions.some(def => def.key === SUBTITLE_MODE_KEY) ? "subtitle-mode" : "subtitle-forced";
    const subtitlePicker = (id: "subtitle-language" | "subtitle-mode", value: SettingValue): FocusItem => {
        const text = id === "subtitle-language" ? (typeof value === "string" ? value : "None") : value === "always" ? "Always" : value === "off" ? "Off" : "Auto";
        const item = button(id, PICKER_LABELS[id], () => openPicker(id));
        item.element.replaceChildren(el("span", "settings-row-title", PICKER_LABELS[id]), el("span", "settings-row-value", text), el("span", "settings-chevron", "›"));
        return item;
    };
    const label = (value: SettingValue, key: SettingsKey): string => key === QUALITY_KEY ? value === "2160p" ? "4K" : value === "auto" ? "Auto" : state.definitions.find(def => def.key === key)?.options.find(option => option.value === value)?.label ?? String(value) : key === SEEK_BACK_KEY || key === SEEK_FORWARD_KEY
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
    const resetPlayback = async (retry = false): Promise<void> => {
        if (state.busy) return;
        if (retry) {
            await state.retry();
            if (torn || state.error !== undefined) return;
        }
        while (pendingPlaybackReset.length > 0) {
            const key = pendingPlaybackReset[0];
            if (torn || !confirmingPlaybackReset || key === undefined) return;
            await state.reset(key);
            if (torn || state.error !== undefined) return;
            pendingPlaybackReset.shift();
        }
        if (!torn) back();
    };

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
                item.element.prepend(check);
            }
        }
        card.append(...content);
        if (name !== "settings:privacy") {
            const hint = el("span", "settings-picker-hint");
            const icon = el("span", "settings-back-icon", "↩"); icon.setAttribute("aria-hidden", "true");
            hint.append(icon, el("span", "", "Menu to close"));
            card.append(el("p", "settings-picker-subtitle", "Choose an option"), hint);
        }
        const privacyCopy = card.querySelector(".settings-privacy-copy");
        if (privacyCopy !== null) privacyCopy.append(...controls.map(item => item.element));
        else card.append(list);
        const scrim = el("div", "settings-modal-scrim");
        scrim.appendChild(card);
        if (activeModal !== name) modalPaneTop = paneSnapshot?.querySelector<HTMLElement>(".settings-pane")?.scrollTop ?? 0;
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
        const snapshotPane = background?.querySelector<HTMLElement>(".settings-pane");
        if (snapshotPane !== null && snapshotPane !== undefined) snapshotPane.scrollTop = modalPaneTop;
    };

    const renderPicker = (): void => {
        if (picker === undefined) return;
        const key = PICKER_KEYS[picker];
        const stored = state.stored(key);
        const controls: FocusItem[] = [];
        const content: HTMLElement[] = [el("h1", "browse-title", PICKER_LABELS[picker]), ...feedback()];
        if (picker === "audio") {
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
            // SiloQualityPresets.bitrateChoices(including:): a stored cap no preset covers stays in descending order and selected.
            const extra = typeof current === "number" && current > 0 && !BITRATE_CHOICES.includes(current) ? [current] : [];
            const caps = [...BITRATE_CHOICES, ...extra].sort((a, b) => b - a);
            for (const value of caps) {
                const item = button(`bitrate:${value}`, bitrateLabel(value), () => { void commit(key, value); });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(current === value));
                controls.push(item);
            }
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
        if (confirmingPlaybackReset) {
            const playbackKeys = devicePlaybackKeys();
            const keys = playbackKeys.filter(key => state.scope(key) === "profile_device");
            const controls = [button("cancel-playback-reset", "Cancel", back), button("confirm-playback-reset", "Reset", () => {
                if (state.busy) return;
                if (pendingPlaybackReset.length === 0) pendingPlaybackReset = [...keys];
                void resetPlayback();
            }), ...(state.error === undefined ? [] : [button("retry", state.canRetry ? "Check and retry" : "Reload settings", () => { void resetPlayback(true); })])];
            showModal("settings:reset-playback", "Use Profile Settings?", [el("h1", "browse-title", "Use Profile Settings?"), el("p", "settings-value", "Removes the playback settings changed on this TV, so it uses your profile's settings again."), ...feedback()], controls);
            return;
        }
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
            copy.prepend(navigationIcon("privacy"));
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
            if (row.member === undefined && state.scope(row.key) === "profile_device") {
                const inherited = state.stored(row.key)?.isSet !== true;
                reset.element.setAttribute("aria-checked", String(inherited));
                if (inherited) for (const item of controls) item.element.setAttribute("aria-checked", "false");
            }
            if (row.member === undefined && state.scope(row.key) === "profile_device") controls.unshift(reset);
            controls.push(...retryButton());
            showModal(`settings:${row.id}`, row.title, [el("h1", "browse-title", row.title), ...feedback()], controls);
            return;
        }
        if (choosingLaunch && launch !== undefined) {
            const controls = [...LAUNCH_CHOICES.map(([behavior, text]) => {
                const item = actionButton(`launch:${behavior === "automatic" ? "true" : behavior === "askEveryLaunch" ? "false" : behavior}`, text, () => { if (!launchPending) saveLaunch(behavior); });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(launch.behavior === behavior));
                const detail = el("span", "settings-option-detail", profileSelectionCaption(behavior));
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
            const copy = signOutConfirmationCopy(actions?.accountName, actions?.serverName, actions?.removesServer?.() ?? false);
            const controls = [actionButton("cancel-signout", "Cancel", back), actionButton("confirm-signout", "Sign Out", () => { destroy(); actions?.signOut?.(); })];
            host.show({ name: "settings:signout", content: [el("h1", "browse-title", copy.title), el("p", "settings-value", copy.message), zoneNode("settings-controls", controls)], zones: [{ id: "settings-confirm", layout: "column", items: controls }], focus: { zone: "settings-confirm", key: "cancel-signout" }, back });
            return;
        }
        if (acknowledging) { renderAcknowledgements(); return; }
        if (picker !== undefined) { renderPicker(); return; }
        activeModal = undefined;
        const categories = (["general", "playback", "subtitles", "server"] as const).map(id => {
            const item = actionButton(id, CATEGORY_LABELS[id], () => { category = id; returnRow = id === "general" ? "acknowledgements" : id === "playback" ? "quality" : id === "subtitles" ? subtitleEntry() : "acknowledgements"; render(rowFocus()); });
            const icon = el("span", "settings-category-icon");
            icon.append(navigationIcon(CATEGORY_ICONS[id]));
            const copy = el("span", "settings-category-copy");
            copy.append(el("span", "settings-category-title", CATEGORY_LABELS[id]), el("span", "settings-category-detail", CATEGORY_DETAILS[id]));
            item.element.replaceChildren(icon, copy);
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
            profile.element.replaceChildren(navigationAvatar(actions.profileName, actions.profileAvatarUrl, session.http.base.baseUrl, 68), copy, el("span", "settings-chevron", "›"));
            profile.element.setAttribute("aria-label", `${actions.profileName}, ${account}`);
            categories.unshift(profile);
            if (actions.signOut !== undefined) {
                const signOut = actionButton("settings-signout", "Sign Out", () => { confirmingSignOut = true; render({ zone: "settings-confirm", key: "cancel-signout" }); });
                signOut.element.classList.add("settings-signout");
                const icon = el("span", "settings-signout-icon");
                icon.append(navigationIcon("signout")); signOut.element.prepend(icon);
                categories.push(signOut);
            }
        }
        const rows: FocusItem[] = [];
        const body = el("div", "settings-pane");
        body.dataset.scrollKey = `settings-pane:${category}`;
        const header = el("div", "settings-pane-header");
        const tile = el("span", "settings-header-icon"); tile.append(navigationIcon(CATEGORY_ICONS[category]));
        const headerCopy = el("div", ""); headerCopy.append(el("h2", "browse-section-title", CATEGORY_LABELS[category]), el("p", "settings-blurb", CATEGORY_BLURBS[category]));
        header.append(tile, headerCopy);
        body.append(header, ...feedback());
        if (category === "playback") connection.watch();
        else connection.unwatch();
        const pickers: readonly Picker[] = category === "playback" ? ["quality", "bitrate", "audio", "seek-back", "seek-forward"] : [];
        if (category === "server") {
            const info = (title: string, value: string): HTMLElement => {
                const row = el("div", "settings-info-row"); row.append(el("span", "", title), el("span", "settings-row-value", value)); return row;
            };
            body.append(el("h3", "settings-section-header", "ACTIVE SERVER"), info("Server", actions?.serverName ?? session.http.base.baseUrl), info("Address", session.http.base.baseUrl));
            const policy = actionButton("privacy", "Privacy Policy", () => { privacy = true; render(); });

            if (accounts) {
                const item = actionButton("accounts", "Accounts", () => {
                    host.stop(); container.hidden = true;
                    accounts(() => {
                        if (torn) return;
                        container.hidden = false; host.listen();
                        category = "general"; returnRow = "acknowledgements";
                        render({ zone: "settings-categories", key: "general" });
                    });
                });
                rows.push(item); body.append(item.element);
            }
            if (accounts === undefined && actions?.switchServer !== undefined) {
                const manage = actionButton("manage-servers", "Manage Servers", () => {
                    host.stop(); container.hidden = true;
                    actions.switchServer?.(() => {
                        if (torn) return;
                        container.hidden = false; host.listen();
                        render({ zone: "settings-rows", key: "manage-servers" });
                    });
                });
                rows.push(manage); body.appendChild(manage.element);
            }
            // Apple's Server pane: an ABOUT section whose Acknowledgements row opens the credits.
            const item = actionButton("acknowledgements", "Acknowledgements", () => { acknowledging = true; returnRow = "acknowledgements"; render(); });
            const hidden = state.effective.get(HIDDEN_KEY)?.value;
            if (Array.isArray(hidden) && hidden.length > 0) {
                const restore = button("restore-libraries", "Restore All Libraries", () => { void state.save(HIDDEN_KEY, []); });
                rows.push(restore); body.appendChild(restore.element);
            }
            body.append(el("h3", "settings-section-header", "ABOUT"), info("App Version", APP_VERSION), policy.element, item.element);
            rows.push(policy);
            rows.push(item);
        }
        if (category === "general" && launch !== undefined && actions?.switchProfile !== undefined) {
            const item = actionButton("paired-profile", "Paired Silo Profile", () => { destroy(); actions.switchProfile(); });
            item.element.append(el("span", "settings-row-value", pairedProfileLabel(launch.rememberedProfileId, session.activeProfile?.id, actions.profileName)), el("span", "settings-chevron", "›"));
            rows.push(item);
            body.append(el("h3", "settings-section-header", "TV USER"), item.element, el("p", "settings-value", pairedProfileDescription(launch.behavior === "askEveryLaunch")));
        }
        if (category === "general" && launch !== undefined) {
            const item = actionButton("remember-profile", "Profile Selection", () => { choosingLaunch = true; render(); });
            item.element.append(el("span", "settings-row-value", LAUNCH_CHOICES.find(([value]) => value === launch.behavior)?.[1] ?? "Every Time"), el("span", "settings-chevron", "›"));
            item.element.setAttribute("aria-disabled", String(launchPending));
            rows.push(item);
            body.append(el("h3", "settings-section-header", "PROFILE AT LAUNCH"), item.element, el("p", "settings-value", profileSelectionCaption(launch.behavior)));
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
            const titleArtState = titleArt.value === true ? "on" : "off";
            body.appendChild(el("p", "settings-value", all
                ? `Title art is ${titleArtState} on every device signed into this profile. Changing it here changes it everywhere. Turn off Apply to All Devices to choose for this TV only.`
                : "Use logo artwork as the title when available. Only affects this TV. Your other devices keep their own setting."));
        }
        for (const id of pickers) {
            if (id === "seek-back" || id === "seek-forward") continue;
            const key = PICKER_KEYS[id];
            if (!state.loaded || !state.definitions.some(def => def.key === key)) continue;
            const section = id === "quality" ? "QUALITY" : id === "audio" ? "STREAMING" : undefined;
            if (section !== undefined) body.appendChild(el("h3", "settings-section-header", section));
            const item = button(id, PICKER_LABELS[id], () => openPicker(id));
            const value = state.effective.get(key)?.value ?? null;
            const displayValue = key === BITRATE_KEY ? bitrateLabel(typeof value === "number" ? value : null) : label(value, key);
            item.element.replaceChildren(el("span", "settings-row-title", PICKER_LABELS[id]), el("span", "settings-row-value", displayValue), el("span", "settings-chevron", "›"));
            rows.push(item);
            body.append(item.element);
        }
        // TVPlaybackSettingsView.swift:60-120: Resolution, Maximum Bitrate, the buffering row, the learned limit, then one footer.
        const bufferingRow = category === "playback" && state.loaded ? settingsRows("playback", state).find(row => row.id === BUFFERING_ROW_ID) : undefined;
        if (bufferingRow !== undefined) {
            const mode = rowValue(bufferingRow, state);
            const item = button(BUFFERING_ROW_ID, BUFFERING_QUALITY_TITLE, () => { extraPicker = bufferingRow; render(); });
            item.element.replaceChildren(el("span", "settings-row-title", BUFFERING_QUALITY_TITLE), el("span", "settings-row-value", BUFFERING_QUALITY_MODES.find(([value]) => value === mode)?.[1] ?? "Automatically"), el("span", "settings-chevron", "›"));
            rows.push(item);
            beforeStreaming(body, [item.element]);
        }
        // The server's default mode is Automatically; Never ignores the limit (SettingsViewModel.learnedConnectionLimitText).
        const learned = category === "playback" && state.effective.get(BUFFERING_MODE_KEY)?.value !== "never" ? connection.learnedLimit : undefined;
        if (learned !== undefined) {
            const text = learnedLimitText(learned);
            const item = button("learned-limit", text, () => {
                void connection.resetLearnedLimit().then(cleared => {
                    if (!cleared || torn) return;
                    // The row is gone, so focus moves to the row above it only if it is still on Reset (TVPlaybackSettingsView.swift:116-124).
                    const focused = host.focused();
                    render(focused?.key === "learned-limit" ? { zone: "settings-rows", key: bufferingRow === undefined ? "bitrate" : BUFFERING_ROW_ID } : focused);
                });
            });
            item.element.replaceChildren(el("span", "settings-row-title", text), el("span", "settings-row-value", LEARNED_LIMIT_RESET_ACTION));
            item.element.classList.add("settings-learned-limit");
            rows.push(item);
            beforeStreaming(body, [item.element]);
        }
        if (category === "playback" && state.loaded && state.definitions.some(def => def.key === QUALITY_KEY)) {
            const resolution = state.effective.get(QUALITY_KEY)?.value;
            const bitrate = state.effective.get(BITRATE_KEY)?.value;
            beforeStreaming(body, [el("p", "settings-value settings-quality-footer", qualityFooter(typeof resolution === "string" ? resolution : null, typeof bitrate === "number" ? bitrate : null, bufferingRow !== undefined))]);
        }
        if (category === "playback" && connection.learnedResetError !== undefined) {
            const warning = el("p", "browse-text browse-error", connection.learnedResetError);
            warning.setAttribute("role", "alert");
            beforeStreaming(body, [warning]);
        }
        const speed = category === "playback" ? connection.view : undefined;
        if (speed !== undefined) {
            const item = button("connection-speed", "Connection speed", () => connection.test());
            const copy = el("span", "settings-connection-copy");
            copy.append(el("span", "settings-row-title", "Connection speed"), el("span", "settings-connection-line", speed.line));
            item.element.replaceChildren(copy, ...(speed.action === undefined ? [] : [el("span", "settings-row-value", speed.action)]));
            item.element.classList.add("settings-connection-speed");
            if (speed.disabled) item.element.setAttribute("aria-disabled", "true");
            if (speed.testing) item.element.setAttribute("aria-busy", "true");
            const nodes: HTMLElement[] = [el("h3", "settings-section-header", "CONNECTION"), item.element];
            // Never ignores the limit the server's budget counts, so Apple drops the sentence (SettingsViewModel.swift:626-632).
            const ignoresLimit = state.effective.get(BUFFERING_MODE_KEY)?.value === "never" && connection.learnedLimit !== undefined;
            if (speed.budget !== undefined && !ignoresLimit) nodes.push(el("p", "settings-value settings-connection-budget", speed.budget));
            if (speed.message !== undefined) {
                const warning = el("p", "browse-text browse-error", speed.message);
                warning.setAttribute("role", "alert");
                nodes.push(warning);
            }
            beforeStreaming(body, nodes);
            rows.push(item);
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
            if (category === "general") body.appendChild(el("h3", "settings-section-header", "CARDS & POSTERS"));
            if (category === "playback") {
                if (state.definitions.some(def => def.key === HDR_KEY)) {
                    const hdrOn = state.effective.get(HDR_KEY)?.value === true;
                    const item = hdrSwitch("hdr", "HDR", hdrOn, () => { void state.save(HDR_KEY, !hdrOn); });
                    rows.push(item);
                    body.appendChild(item.element);
                    body.appendChild(el("p", "settings-value settings-hdr-footer", HDR_FOOTER));
                }
                body.appendChild(el("h3", "settings-section-header", "EPISODES"));
            }
            for (const row of settingsRows(category, state).filter(row => row.id !== BUFFERING_ROW_ID)) {
                if (row.id === "metadata-language") body.appendChild(el("h3", "settings-section-header", "METADATA"));
                const value = rowValue(row, state);
                const item = button(row.id, row.title, () => {
                    if (row.id === "poster-size" && state.effective.get(row.key)?.source === "profile_device") return;
                    if (row.id === "advisory-age" || row.member === "textOutline") { void state.save(row.key, rowEdit(row, value !== true, state)); return; }
                    extraPicker = row; render();
                });
                const outlineOff = row.member === "textOutlineColor" && rowValue({ ...row, member: "textOutline" }, state) !== true;
                const backgroundOff = (row.member === "backgroundOpacity" || row.member === "backgroundColor") && rowValue({ ...row, member: "backgroundStyle" }, state) !== "box";
                item.element.appendChild(el("span", "settings-row-value", outlineOff || backgroundOff ? "—" : row.choices.find(([choice]) => choice === value)?.[1] ?? String(value)));
                if (row.id !== "advisory-age" && row.member !== "textOutline") item.element.appendChild(el("span", "settings-chevron", "›"));
                if (row.id === "advisory-age" || row.member === "textOutline") { item.element.setAttribute("role", "switch"); item.element.setAttribute("aria-label", row.title); item.element.setAttribute("aria-checked", String(value === true)); }
                rows.push(item); body.appendChild(item.element);
                if (row.id === "advisory-age") body.appendChild(el("p", "settings-value", "Show a suggested minimum viewer age, such as Common Sense Media’s, on movie and show details. This does not change what the profile may watch."));
                if (row.id === "poster-size" && state.client.get(row.key)?.isSet) {
                    const inherited = button("poster-profile-default", "Use Profile Default", () => { void state.reset(row.key); });
                    rows.push(inherited); body.appendChild(inherited.element);
                }
                if (row.id === "poster-size" && state.effective.get(row.key)?.source === "profile_device") {
                    item.element.setAttribute("aria-disabled", "true");
                    const synced = button("use-synced-tv", "Use Synced TV Settings", () => { void state.resetPosterDevice(); });
                    rows.push(synced); body.appendChild(synced.element);
                }
                if (row.id === "poster-size") body.appendChild(el("p", "settings-value", "Poster size syncs with other TV-family devices on this profile."));
            }
            if (category === "playback") {
                if (spoilers?.showsSettings === true) {
                    body.appendChild(el("h3", "settings-section-header", "SPOILERS"));
                    for (const [key, text, checked, setting] of [
                        ["spoiler-images", "Blur unwatched episode images", spoilers.settings.hidesImages, "images"],
                        ["spoiler-overviews", "Hide unwatched episode descriptions", spoilers.settings.hidesOverviews, "overviews"],
                    ] as const) {
                        const item = button(key, text, () => spoilers.toggle(setting));
                        item.element.appendChild(el("span", "settings-row-value", checked ? "On" : "Off"));
                        item.element.setAttribute("role", "switch");
                        item.element.setAttribute("aria-label", text);
                        item.element.setAttribute("aria-checked", String(checked));
                        const unavailable = item.element.getAttribute("aria-disabled") === "true" || !spoilers.allowsEditing;
                        item.element.setAttribute("aria-disabled", String(unavailable));
                        rows.push(item);
                        body.appendChild(item.element);
                    }
                    body.appendChild(el("p", "settings-value", spoilers.footer));
                }
                const skipRows = (["seek-back", "seek-forward"] as const).filter(id => state.definitions.some(def => def.key === PICKER_KEYS[id]));
                if (skipRows.length > 0) body.appendChild(el("h3", "settings-section-header", "VIDEO"));
                for (const id of skipRows) {
                    const item = button(id, PICKER_LABELS[id], () => openPicker(id));
                    item.element.replaceChildren(el("span", "settings-row-title", PICKER_LABELS[id]), el("span", "settings-row-value", label(state.effective.get(PICKER_KEYS[id])?.value ?? (id === "seek-back" ? 10 : 30), PICKER_KEYS[id])), el("span", "settings-chevron", "›"));
                    rows.push(item); body.appendChild(item.element);
                }
                if (skipRows.length > 0) body.appendChild(el("p", "settings-value", "Used by the remote and on-screen skip buttons. Applies to every device signed in to this profile."));
                const playbackKeys = devicePlaybackKeys();
                if (playbackKeys.some(key => state.scope(key) === "profile_device")) {
                    const reset = button("reset-playback", "Use Profile Settings", () => { confirmingPlaybackReset = true; render(); });
                    reset.element.classList.add("settings-destructive");
                    reset.element.prepend(navigationIcon("reset"));
                    rows.push(reset);
                    body.append(el("h3", "settings-section-header", "RESET"), reset.element, el("p", "settings-value", "Removes the playback settings changed on this TV, so it uses your profile's settings again."));
                }
            }
            if (category === "subtitles" && state.definitions.some(def => def.key === APPEARANCE_KEY)) {
                const preview = el("div", "settings-subtitle-preview");
                const text = el("span", "", "Subtitles will look like this");
                preview.appendChild(text);
                const stored = state.stored(APPEARANCE_KEY);
                const appearance = decodeAppearance({ profile_id: "preview", effective_value: JSON.stringify(stored?.isSet ? stored.value : {}) }, "preview");
                // The preview is laid out by flexbox, so it ignores the top and bottom this also sets for the player.
                applySubtitleAppearance(preview, text, appearance);
                text.style.fontSize = `${TV_PREVIEW_POINT_SIZE[appearance.fontSize] * 0.5}px`;
                text.style.fontWeight = "600";
                text.style.padding = appearance.backgroundStyle === "box" ? "4px 10px" : "0";
                text.style.borderRadius = "4px";
                preview.style.alignItems = appearance.position === "top" ? "flex-start" : "flex-end";
                preview.style.paddingBlock = appearance.position === "lower-third" ? "33px" : "12px";
                body.appendChild(preview);
                const reset = button("reset-appearance", "Reset Appearance", () => { confirmingAppearanceReset = true; render(); });
                rows.push(reset); body.append(reset.element, el("p", "settings-value settings-appearance-footer", `${state.scope(APPEARANCE_KEY) === "profile_device" ? "Saved only on this TV. Other devices use the profile's settings." : "Saved for this profile on all devices."} Subtitles with their own built-in styling keep their original appearance; image-based subtitles keep their authored fonts and colors but follow the size, position, and background settings.`));
                if (state.definitions.some(def => def.key === APPEARANCE_KEY && def.device)) {
                    const device = state.scope(APPEARANCE_KEY) === "profile_device";
                    const toggle = button("appearance-device", "Only on This TV", () => { void state.setAppearanceDevice(!device); });
                    toggle.element.setAttribute("role", "switch"); toggle.element.setAttribute("aria-label", "Only on This TV"); toggle.element.setAttribute("aria-checked", String(device));
                    toggle.element.appendChild(el("span", "settings-row-value", device ? "On" : "Off"));
                    rows.push(toggle); body.appendChild(toggle.element);
                }
            }
        }
        if (category === "general" && actions?.showAudiobooks !== undefined) {
            // TVGeneralSettingsView TOP MENU: a client_local opt-in, stored on this TV per profile.
            const audiobooks = actions.showAudiobooks;
            const on = audiobooks.value;
            const item = button("show-audiobooks", "Show Audiobooks", () => { audiobooks.set(!audiobooks.value); render({ zone: "settings-rows", key: "show-audiobooks" }); });
            item.element.appendChild(el("span", "settings-row-value", on ? "On" : "Off"));
            item.element.setAttribute("role", "switch");
            item.element.setAttribute("aria-label", "Show Audiobooks");
            item.element.setAttribute("aria-checked", String(on));
            rows.push(item);
            body.append(el("h3", "settings-section-header", "TOP MENU"), item.element, el("p", "settings-value", "Adds an Audiobooks tab when an audiobook library is available."));
        }
        if (state.loaded && rows.length === 0) body.appendChild(el("p", "browse-text", "No supported settings in this category."));
        if (category === "server") {
            for (const row of rows) {
                const icon = row.key === "accounts" ? "switch-profile" : row.key === "privacy" ? "privacy" : row.key === "acknowledgements" ? "credits" : "switch-server";
                row.element.classList.add("settings-server-action");
                row.element.prepend(navigationIcon(icon));
                row.element.appendChild(navigationIcon(row.key === "privacy" ? "qr" : row.key === "acknowledgements" ? "document" : "chevron-right"));
            }
        }
        // Apple's Server pane ends with EXTRA FEATURES: one On/Off row per experimental feature, off until chosen on this device.
        if (category === "server" && experimental !== undefined) {
            body.appendChild(el("h3", "settings-section-header", "EXTRA FEATURES"));
            for (const feature of EXPERIMENTAL_FEATURES) {
                const on = experimental.isEnabled(feature.id);
                const key = `experimental-${feature.id}`;
                const toggle = actionButton(key, feature.title, () => { experimental.setEnabled(feature.id, !on); render({ zone: "settings-rows", key }); });
                toggle.element.setAttribute("role", "switch"); toggle.element.setAttribute("aria-label", feature.title); toggle.element.setAttribute("aria-checked", String(on));
                toggle.element.appendChild(el("span", "settings-row-value", on ? "On" : "Off"));
                rows.push(toggle); body.appendChild(toggle.element);
            }
        }
        const retries = retryButton();
        rows.push(...retries);

        body.classList.add("settings-controls");
        const firstAppearance = body.querySelector('[data-focus^="appearance-"]');
        const preview = body.querySelector(".settings-subtitle-preview");
        const deviceToggle = body.querySelector('[data-focus="appearance-device"]');
        if (firstAppearance !== null && preview !== null) {
            body.insertBefore(el("h3", "settings-section-header", "APPEARANCE"), firstAppearance);
            body.insertBefore(preview, firstAppearance);
            if (deviceToggle !== null) body.insertBefore(deviceToggle, firstAppearance);
            const group = el("div", "settings-nested-group");
            body.insertBefore(group, firstAppearance);
            for (const row of rows.filter(item => item.key.startsWith("appearance-") && item.key !== "appearance-device" || item.key === "reset-appearance")) group.appendChild(row.element);
        }
        body.appendChild(zoneNode("settings-controls", retries));
        // Remote order follows the visible order, including connected Retry controls.
        rows.sort((a, b) => a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
        const panes = el("div", "settings-panes");
        const rail = zoneNode("settings-categories", categories);
        rail.prepend(el("h1", "browse-title", "Settings"));
        rail.appendChild(el("p", "settings-version", `Silo ${APP_VERSION}`));
        panes.append(rail, body);
        paneSnapshot = panes;
        host.show({ name: "settings", content: [panes], zones: [
            { id: "settings-categories", layout: "column", right: "settings-rows", items: categories },
            { id: "settings-rows", layout: "column", left: "settings-categories", items: rows },
        ], focus: { zone: "settings-categories", key: category }, back }, focus);
    }
    connection.start();
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

/** Inserts nodes above the STREAMING header, or at the end when the pane has none. */
function beforeStreaming(body: HTMLElement, nodes: readonly HTMLElement[]): void {
    const streaming = [...body.children].find(node => node.classList.contains("settings-section-header") && node.textContent === "STREAMING");
    for (const node of nodes) {
        if (streaming !== undefined) body.insertBefore(node, streaming);
        else body.appendChild(node);
    }
}

function valueLabel(value: SettingValue, key: SettingsKey = AUDIO_KEY): string {
    if (key === BITRATE_KEY) return bitrateLabel(typeof value === "number" ? value : null);
    if (value === null) return key === HIDDEN_KEY ? "None hidden" : "No preference";
    if (Array.isArray(value)) return `${value.length} hidden`;
    if (typeof value === "object") return key === "ui.card_presentation" && "poster_size" in value ? String(value.poster_size) : "Custom appearance";
    return value === "x-silo-original" ? "Original language" : String(value);
}
