// Apple TV HUD values from TVPlayerInfoHUD.swift and SubtitleAppearance.swift.
// Member side effects match feat/216-settings-rows `rowEdit` for playback.subtitle_appearance
// (settingsRows.ts): picking an outline color turns the outline on, a background color or a
// positive opacity selects Box, and Box with no opacity restores 75. That branch owns the
// Settings page; this player writes the same key and the same profile / profile_device scope.

import type { SubtitleAppearance } from "../contracts/v2/subtitles.ts";
import { decodeSettingsCapabilities } from "../contracts/v2/settings.ts";
import { integer, object, WireError } from "../contracts/v2/wire.ts";

export const APPEARANCE_KEY = "playback.subtitle_appearance";
export const SYNC_KEY = "player.subtitle_sync_ms";
export const SYNC_PROFILE_REVISION = 19;
export const TEXT_OPACITY_REVISION = 14;
export const DELAY_MIN = -2000;
export const DELAY_MAX = 2000;
export const DELAY_STEP = 100;

export const FONT_SIZES = [["small", "Small"], ["medium", "Medium"], ["large", "Large"], ["xlarge", "X-Large"], ["xxlarge", "XX-Large"]] as const;
export const POSITIONS = [["bottom", "Bottom"], ["lower-third", "Lower Third"], ["top", "Top"]] as const;
export const STYLES = [["box", "Box"], ["shadow", "Drop Shadow"], ["none", "None"]] as const;
export const FONT_FAMILIES = [["sans-serif", "Sans-serif"], ["serif", "Serif"], ["monospace", "Monospace"]] as const;
export const FONT_COLORS = [["#ffffff", "White"], ["#facc15", "Yellow"], ["#22c55e", "Green"], ["#06b6d4", "Cyan"], ["#d946ef", "Magenta"], ["#ef4444", "Red"], ["#3b82f6", "Blue"], ["#9ca3af", "Gray"], ["#000000", "Black"]] as const;
export const BACKGROUND_COLORS = [["#000000", "Black"], ["#374151", "Dark Gray"], ["#1e3a5f", "Navy"], ["#7f1d1d", "Dark Red"], ["#14532d", "Dark Green"]] as const;

export interface LabeledChoice { readonly id: string; readonly label: string }
export interface SubtitleControlSupport {
    readonly delay: boolean;
    readonly styling: boolean;
    readonly deviceScope: boolean;
    readonly syncAtProfile: boolean;
    readonly textOpacity: boolean;
}

export type AppearanceMember = "fontSize" | "fontFamily" | "fontColor" | "textOpacity" | "textOutline" | "textOutlineColor" | "backgroundStyle" | "backgroundOpacity" | "backgroundColor" | "position";

export function delayLabel(milliseconds: number): string {
    if (milliseconds === 0) return "0 ms";
    return `${milliseconds > 0 ? "+" : ""}${milliseconds} ms`;
}

export function delayOptions(current: number): readonly LabeledChoice[] {
    const values = new Set<number>();
    for (let value = DELAY_MIN; value <= DELAY_MAX; value += DELAY_STEP) values.add(value);
    values.add(current);
    return [...values].sort((left, right) => left - right).map(value => ({ id: String(value), label: delayLabel(value) }));
}

export function clampDelay(milliseconds: number): number {
    return Math.max(-10000, Math.min(10000, milliseconds));
}

function label(table: readonly (readonly [string, string])[], id: string): string {
    return table.find(row => row[0] === id)?.[1] ?? id;
}

export function appearanceSummary(appearance: SubtitleAppearance): string {
    const style = appearance.backgroundStyle === "outline" ? "Outline" : label(STYLES, appearance.backgroundStyle);
    return `${style}, ${label(FONT_SIZES, appearance.fontSize)}, ${label(POSITIONS, appearance.position)}`;
}

export function editAppearance(appearance: SubtitleAppearance, member: AppearanceMember, value: string | number | boolean): SubtitleAppearance {
    const next: { -readonly [Key in keyof SubtitleAppearance]: SubtitleAppearance[Key] } = { ...appearance };
    switch (member) {
        case "fontSize":
            if (FONT_SIZES.some(row => row[0] === value)) next.fontSize = value as SubtitleAppearance["fontSize"];
            return next;
        case "position":
            if (POSITIONS.some(row => row[0] === value)) next.position = value as SubtitleAppearance["position"];
            return next;
        case "fontFamily":
            if (typeof value === "string" && FONT_FAMILIES.some(row => row[0] === value)) next.fontFamily = value;
            return next;
        case "fontColor":
            if (typeof value === "string" && FONT_COLORS.some(row => row[0] === value)) next.fontColor = value;
            return next;
        case "textOutlineColor":
            if (typeof value === "string" && BACKGROUND_COLORS.some(row => row[0] === value)) {
                next.textOutlineColor = value;
                next.textOutline = true;
            }
            return next;
        case "backgroundColor":
            if (typeof value === "string" && BACKGROUND_COLORS.some(row => row[0] === value)) {
                next.backgroundColor = value;
                next.backgroundStyle = "box";
                if (next.backgroundOpacity === 0) next.backgroundOpacity = 75;
            }
            return next;
        case "backgroundStyle":
            if (value === "box" || value === "shadow" || value === "none") {
                next.backgroundStyle = value;
                if (value === "box" && next.backgroundOpacity === 0) next.backgroundOpacity = 75;
            }
            return next;
        case "backgroundOpacity":
            if (typeof value === "number") {
                next.backgroundOpacity = value;
                if (value > 0) next.backgroundStyle = "box";
            }
            return next;
        case "textOpacity":
            if (typeof value === "number") next.textOpacity = value;
            return next;
        case "textOutline":
            if (typeof value === "boolean") next.textOutline = value;
            return next;
        default: {
            const unexpected: never = member;
            return unexpected;
        }
    }
}

export function appearanceValue(appearance: SubtitleAppearance, includeTextOpacity: boolean): { [key: string]: string | number | boolean | undefined } {
    const value: { [key: string]: string | number | boolean | undefined } = { ...appearance };
    if (!includeTextOpacity) delete value.textOpacity;
    return value;
}

export function syncWriteScope(deviceOverride: boolean, allowed: readonly string[], manifest: number): "profile" | "profile_device" {
    const profile = allowed.includes("profile") && manifest >= SYNC_PROFILE_REVISION;
    const device = allowed.includes("profile_device");
    if ((deviceOverride || !profile) && device) return "profile_device";
    return "profile";
}

export function opacityOptions(current: number, lowest: number): readonly LabeledChoice[] {
    const values = new Set<number>();
    for (let value = lowest; value <= 100; value += 25) values.add(value);
    values.add(current);
    return [...values].sort((left, right) => left - right).map(value => ({ id: String(value), label: value === 0 ? "Off" : `${value}%` }));
}

export function allowedScopes(contract: unknown, key: string): readonly string[] {
    const revision = integer(object(contract, "settings_contract"), "revision", "settings_contract");
    return definitionScopes(contract, key, revision) ?? [];
}

function definitionScopes(contract: unknown, key: string, revision: number): readonly string[] | undefined {
    const body = object(contract, "settings_contract");
    if (!Array.isArray(body.definitions)) throw new WireError("settings_contract.definitions", "an array");
    const found = body.definitions.map(entry => object(entry, "setting_definition")).find(entry => entry.key === key && integer(entry, "introduced_in", "setting_definition") <= revision);
    if (found === undefined) return undefined;
    if (!Array.isArray(found.allowed_scopes) || found.allowed_scopes.some(scope => typeof scope !== "string")) throw new WireError("setting_definition.allowed_scopes", "strings");
    return found.allowed_scopes.filter((scope): scope is string => typeof scope === "string");
}

export function subtitleControlSupport(contract: unknown, capabilityValue: unknown): SubtitleControlSupport {
    const capability = decodeSettingsCapabilities(capabilityValue);
    const hidden = { delay: false, styling: false, deviceScope: false, syncAtProfile: false, textOpacity: false };
    if (capability.apiVersion !== 1 || capability.state !== "available" || !capability.allowed || !capability.scopes.includes("profile")) return hidden;
    const revision = Math.min(integer(object(contract, "settings_contract"), "revision", "settings_contract"), capability.manifestRevision);
    const appearance = definitionScopes(contract, APPEARANCE_KEY, revision);
    const sync = definitionScopes(contract, SYNC_KEY, revision);
    const styling = appearance?.includes("profile") === true;
    const delay = sync !== undefined && (sync.includes("profile") || sync.includes("profile_device"));
    return {
        delay, styling,
        deviceScope: styling && appearance?.includes("profile_device") === true && capability.scopes.includes("profile_device"),
        syncAtProfile: delay && sync?.includes("profile") === true && capability.manifestRevision >= SYNC_PROFILE_REVISION,
        textOpacity: styling && capability.manifestRevision >= TEXT_OPACITY_REVISION,
    };
}

const ALIASES: Readonly<Record<string, string>> = {
    alb: "sq", arm: "hy", baq: "eu", bur: "my", chi: "zh", cze: "cs", dut: "nl", fre: "fr",
    geo: "ka", ger: "de", gre: "el", ice: "is", mac: "mk", mao: "mi", may: "ms", per: "fa",
    rum: "ro", slo: "sk", tib: "bo", wel: "cy",
};

export function languageIdentity(code: string): string {
    const parts = code.trim().replaceAll("_", "-").split("-");
    const primary = (parts[0] ?? "").toLowerCase();
    parts[0] = ALIASES[primary] ?? primary;
    return parts.filter(part => part !== "").join("-").toLowerCase();
}

export function languageLabel(code: string, catalogLabel?: string): string {
    if (catalogLabel !== undefined && catalogLabel.trim() !== "") return catalogLabel;
    try {
        const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code.replaceAll("_", "-"));
        if (name !== undefined && name.toLowerCase() !== code.toLowerCase()) return name.replace(/(^|\s)\p{L}/gu, letter => letter.toUpperCase());
    } catch { /* An unknown code keeps its own spelling. */ }
    return code.toUpperCase();
}

export interface LanguageChoice { readonly code: string; readonly label: string; readonly hint?: string }

export function languageChoices(catalog: readonly { readonly code: string; readonly label?: string }[], preferred: string | undefined): { readonly suggested: readonly LanguageChoice[]; readonly other: readonly LanguageChoice[] } {
    const seen = new Set<string>();
    const suggested: LanguageChoice[] = [];
    const preferredCode = preferred?.trim();
    if (preferredCode) {
        const identity = languageIdentity(preferredCode);
        const known = catalog.find(item => languageIdentity(item.code) === identity);
        suggested.push({ code: known?.code ?? preferredCode, label: languageLabel(known?.code ?? preferredCode, known?.label), hint: "Preferred" });
        seen.add(identity);
    }
    const other = catalog.filter(item => item.code.trim() !== "" && !seen.has(languageIdentity(item.code)))
        .map(item => ({ code: item.code, label: languageLabel(item.code, item.label) }))
        .sort((left, right) => left.label.localeCompare(right.label, "en", { sensitivity: "accent" }));
    return { suggested, other };
}

export function scoreTier(score: number): "good" | "fair" | "poor" {
    if (score >= 70) return "good";
    if (score >= 40) return "fair";
    return "poor";
}

export function providerLabel(provider: string): string {
    switch (provider.toLowerCase()) {
        case "opensubtitles": return "OpenSubtitles";
        case "subdl": return "SubDL";
        case "subsource": return "Subsource";
        default: return provider;
    }
}

export function resultDetail(result: { readonly language: string; readonly downloads: number; readonly hearingImpaired: boolean }): string {
    const parts: string[] = [];
    if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(result.language)) parts.push(languageLabel(result.language));
    if (result.downloads > 0) parts.push(`${result.downloads} downloads`);
    if (result.hearingImpaired) parts.push("HI");
    return parts.join(" · ");
}
