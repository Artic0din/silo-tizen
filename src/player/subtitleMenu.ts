import { el } from "../ui/screen.ts";
import type { SubtitleAppearance } from "../contracts/v2/subtitles.ts";
import type { TrackView } from "./controller.ts";
import { chevronForwardIcon, magnifyingGlassIcon } from "./playerIcons.ts";
import { appearanceSummary, BACKGROUND_COLORS, delayLabel, delayOptions, FONT_COLORS, FONT_FAMILIES, FONT_SIZES, opacityOptions, POSITIONS, providerLabel, resultDetail, STYLES } from "./subtitleAppearance.ts";

/** The Subtitles pane's state. A picker floats over the pane it opened from, including Video's PLAYBACK and SYNC rows. */
export type SubtitlePane =
    | { readonly kind: "tracks" }
    | { readonly kind: "appearance" }
    | { readonly kind: "picker"; readonly title: string; readonly field: string; readonly selected: string; readonly options: readonly { readonly id: string; readonly label: string }[]; readonly origin: { readonly pane: "tracks" | "appearance" | "video"; readonly focusId: string } };

function choice(id: string, label: string, current: boolean, detail?: string): HTMLButtonElement {
    const button = el("button", "player-choice");
    button.type = "button";
    button.setAttribute("data-focus", id);
    button.setAttribute("aria-pressed", String(current));
    const copy = el("span", "player-choice-copy");
    copy.append(el("span", "player-choice-label", label));
    if (detail !== undefined && detail !== "") copy.append(el("span", "player-choice-detail", detail));
    button.append(copy);
    if (current) button.className = "player-choice player-choice-current";
    return button;
}

/**
 * `HUDSettingRow` (TVPlayerInfoHUD.swift:494, label at 548): label left, value right-aligned, then a chevron when the row opens a picker.
 * `glyph` (text) or `icon` (inline SVG) stands in for its `systemImage` at 20pt semibold; Appearance's `textformat` reads "Aa".
 */
export function settingRow(id: string, label: string, value: string, options: { readonly chevron?: boolean; readonly glyph?: string; readonly icon?: string; readonly pressed?: boolean } = {}): HTMLButtonElement {
    const button = el("button", "player-choice player-setting");
    button.type = "button";
    button.setAttribute("data-focus", id);
    if (options.pressed !== undefined) button.setAttribute("aria-pressed", String(options.pressed));
    if (options.glyph !== undefined || options.icon !== undefined) {
        const glyph = el("span", "player-setting-glyph", options.glyph);
        if (options.icon !== undefined) glyph.innerHTML = options.icon;
        glyph.setAttribute("aria-hidden", "true");
        button.append(glyph);
    }
    button.append(el("span", "player-setting-label", label));
    if (value !== "") button.append(el("span", "player-setting-value", value));
    if (options.chevron !== false) {
        const chevron = el("span", "player-setting-chevron");
        chevron.innerHTML = chevronForwardIcon();
        button.append(chevron);
    }
    return button;
}

/** `PaneColumn` (TVPlayerInfoHUD.swift:314): an uppercase header over rows that scroll on their own. */
export function paneColumn(heading: string, className: string): { readonly column: HTMLElement; readonly rows: HTMLElement } {
    const column = el("div", `player-menu-column ${className}`);
    const rows = el("div", "player-menu-column-rows");
    column.append(el("h2", "player-menu-heading", heading), rows);
    return { column, rows };
}

/**
 * `HUDPickerDialog` (TVPlayerInfoHUD.swift:1042-1104) floats over the pane it opened from, which dims to 28% and
 * leaves the focus graph (`.disabled`, :1665-1666). Its title keeps its case; Back closes it (`onExitCommand`, :1092),
 * so it has no Back row.
 */
export function overlayPicker(list: HTMLElement, pane: Extract<SubtitlePane, { kind: "picker" }>): void {
    const behind = el("div", "player-menu-behind");
    behind.append(...Array.from(list.childNodes));
    behind.inert = true;
    for (const node of behind.querySelectorAll("[data-focus]")) node.removeAttribute("data-focus");
    const picker = el("div", "player-menu-picker");
    picker.setAttribute("role", "dialog");
    picker.setAttribute("aria-label", pane.title);
    const options = el("div", "player-menu-picker-options");
    for (const option of pane.options) options.append(choice(`subtitle-picker:${option.id}`, option.label, option.id === pane.selected));
    picker.append(el("h2", "player-menu-picker-title", pane.title), options);
    list.append(behind, picker);
}

function named(table: readonly (readonly [string, string])[], id: string): string {
    return table.find(row => row[0] === id)?.[1] ?? id;
}

export function pickerFor(tracks: TrackView, field: string): Omit<Extract<SubtitlePane, { kind: "picker" }>, "origin"> | undefined {
    const display = tracks.subtitleTools?.display;
    if (display === undefined) return undefined;
    const appearance = display.appearance;
    if (field === "delay") return { kind: "picker", title: "Subtitle Delay", field, selected: String(display.delayMs), options: delayOptions(display.delayMs) };
    if (field === "fontSize") return { kind: "picker", title: "Subtitle Size", field, selected: appearance.fontSize, options: FONT_SIZES.map(([id, label]) => ({ id, label })) };
    if (field === "position") return { kind: "picker", title: "Subtitle Position", field, selected: appearance.position, options: POSITIONS.map(([id, label]) => ({ id, label })) };
    if (field === "fontFamily") return { kind: "picker", title: "Subtitle Font", field, selected: appearance.fontFamily, options: FONT_FAMILIES.map(([id, label]) => ({ id, label })) };
    if (field === "fontColor") return { kind: "picker", title: "Text Color", field, selected: appearance.fontColor, options: FONT_COLORS.map(([id, label]) => ({ id, label })) };
    if (field === "textOpacity") return { kind: "picker", title: "Text Opacity", field, selected: String(appearance.textOpacity), options: opacityOptions(appearance.textOpacity, 25) };
    if (field === "textOutline") return { kind: "picker", title: "Outline", field, selected: String(appearance.textOutline), options: [{ id: "true", label: "On" }, { id: "false", label: "Off" }] };
    if (field === "textOutlineColor") return { kind: "picker", title: "Outline Color", field, selected: appearance.textOutlineColor, options: BACKGROUND_COLORS.map(([id, label]) => ({ id, label })) };
    if (field === "backgroundStyle") return { kind: "picker", title: "Subtitle Style", field, selected: appearance.backgroundStyle, options: STYLES.map(([id, label]) => ({ id, label })) };
    if (field === "backgroundColor") return { kind: "picker", title: "Background Color", field, selected: appearance.backgroundColor, options: BACKGROUND_COLORS.map(([id, label]) => ({ id, label })) };
    if (field === "backgroundOpacity") return { kind: "picker", title: "Background Opacity", field, selected: String(appearance.backgroundOpacity), options: opacityOptions(appearance.backgroundOpacity, 0) };
    return undefined;
}

export function appearanceDetail(appearance: SubtitleAppearance, field: string): string {
    switch (field) {
        case "fontSize": return named(FONT_SIZES, appearance.fontSize);
        case "position": return named(POSITIONS, appearance.position);
        case "fontFamily": return named(FONT_FAMILIES, appearance.fontFamily);
        case "fontColor": return named(FONT_COLORS, appearance.fontColor);
        case "textOpacity": return `${appearance.textOpacity}%`;
        case "textOutline": return appearance.textOutline ? "On" : "Off";
        case "textOutlineColor": return named(BACKGROUND_COLORS, appearance.textOutlineColor);
        case "backgroundStyle": return appearance.backgroundStyle === "outline" ? "Outline" : named(STYLES, appearance.backgroundStyle);
        case "backgroundColor": return named(BACKGROUND_COLORS, appearance.backgroundColor);
        case "backgroundOpacity": return appearance.backgroundOpacity === 0 ? "Off" : `${appearance.backgroundOpacity}%`;
        default: return "";
    }
}

/** Search and the delay, size, position and appearance rows: the OPTIONS column, or a pane that replaces both columns. */
export function fillSubtitleTools(list: HTMLElement, tracks: TrackView, pane: SubtitlePane, replace: boolean): void {
    const tools = tracks.subtitleTools;
    if (tools === undefined) return;
    if (pane.kind === "appearance") {
        const display = tools.display;
        if (display === undefined) return;
        list.append(el("h2", "player-menu-heading", "APPEARANCE"));
        list.append(choice("subtitle-appearance-back", "Back", false));
        const rows = ["backgroundStyle", "fontSize", "position", "fontFamily", "fontColor", ...(display.textOpacity ? ["textOpacity"] : []), "textOutline", "textOutlineColor", "backgroundColor", "backgroundOpacity"];
        const titles: Record<string, string> = { backgroundStyle: "Style", fontSize: "Size", position: "Position", fontFamily: "Font", fontColor: "Text color", textOpacity: "Text opacity", textOutline: "Outline", textOutlineColor: "Outline color", backgroundColor: "Background color", backgroundOpacity: "Background opacity" };
        for (const field of rows) list.append(choice(`subtitle-appearance:${field}`, titles[field] ?? field, false, appearanceDetail(display.appearance, field)));
        return;
    }
    const search = tools.search;
    if (search.phase !== "closed") {
        list.append(el("h2", "player-menu-heading", "SEARCH"));
        list.append(choice("subtitle-search-back", search.phase === "languages" ? "Back" : "Choose another language", false));
        if (search.phase === "searching") {
            list.append(el("p", "player-menu-note", search.status));
            list.append(choice("subtitle-search-cancel", "Cancel", false));
        } else if (search.phase === "failed") {
            if (search.message !== "") list.append(el("p", "player-menu-note", search.message));
            if (search.canRetry) list.append(choice("subtitle-search-retry", "Try Again", false));
        } else if (search.phase === "languages") {
            if (!search.offered && search.unavailableReason !== "") list.append(el("p", "player-menu-note", search.unavailableReason));
            for (const item of [...search.suggested, ...search.other]) list.append(choice(`subtitle-language:${item.code}`, item.label, item.code === search.language, item.hint));
        } else {
            for (const warning of search.warnings) list.append(el("p", "player-menu-note", warning));
            if (search.message !== "") list.append(el("p", "player-menu-note", search.message));
            for (const result of search.results) {
                const title = result.releaseName !== "" ? result.releaseName : providerLabel(result.provider);
                list.append(choice(`subtitle-result:${result.key}`, title, result.key === search.downloadingKey, [providerLabel(result.provider), result.format.toUpperCase(), resultDetail(result)].filter(part => part !== "").join(" · ")));
            }
        }
        return;
    }
    // SubtitlesPane.optionRowsContent (TVPlayerInfoHUD.swift:1964): Search, Delay, the device toggle, Size, Position, Appearance.
    if (!replace && search.offered) list.append(settingRow("subtitle-search", "Search Subtitles…", "", { icon: magnifyingGlassIcon() }));
    const display = tools.display;
    if (display === undefined || !tools.overlay) return;
    if (display.delay) list.append(settingRow("subtitle-delay", "Delay", delayLabel(display.delayMs)));
    if (display.deviceScope) list.append(settingRow("subtitle-device", "Only on this TV", display.deviceOverride ? "On" : "Off", { chevron: false, pressed: display.deviceOverride }));
    if (!display.styling) return;
    list.append(settingRow("subtitle-size", "Size", named(FONT_SIZES, display.appearance.fontSize)));
    list.append(settingRow("subtitle-position", "Position", named(POSITIONS, display.appearance.position)));
    list.append(settingRow("subtitle-appearance", "Appearance", appearanceSummary(display.appearance), { glyph: "Aa" }));
}
