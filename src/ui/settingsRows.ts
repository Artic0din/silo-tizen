import { APPEARANCE_KEY, ADVISORY_KEY, METADATA_KEY, INTRO_SKIP_KEY, CREDITS_SKIP_KEY } from "../contracts/v2/settingsRows.ts";
import { AUTO_NEXT_KEY, NEXT_UP_KEY, CARD_PRESENTATION_KEY, type SettingValue, type SettingsKey } from "../contracts/v2/settings.ts";
import { DEFAULT_APPEARANCE } from "../contracts/v2/subtitles.ts";
import type { SettingsState } from "./settingsState.ts";

type Choice = readonly [SettingValue, string];
export interface SettingsRow { readonly id: string; readonly title: string; readonly key: SettingsKey; readonly member?: string; readonly choices: readonly Choice[] }
const onOff: readonly Choice[] = [[true, "On"], [false, "Off"]];
const choices = (values: readonly string[]): readonly Choice[] => values.map(value => [value, value[0]?.toUpperCase() + value.slice(1)]);
const colors: readonly Choice[] = [["#ffffff", "White"], ["#facc15", "Yellow"], ["#22c55e", "Green"], ["#06b6d4", "Cyan"], ["#d946ef", "Magenta"], ["#ef4444", "Red"], ["#3b82f6", "Blue"], ["#9ca3af", "Gray"], ["#000000", "Black"]];
const backgrounds: readonly Choice[] = [["#000000", "Black"], ["#374151", "Dark Gray"], ["#1e3a5f", "Navy"], ["#7f1d1d", "Dark Red"], ["#14532d", "Dark Green"]];
const appearance = (member: string, title: string, values: readonly Choice[]): SettingsRow => ({ id: `appearance-${member}`, title, key: APPEARANCE_KEY, member, choices: values });

export function settingsRows(category: string, state: SettingsState): readonly SettingsRow[] {
    const rows: readonly SettingsRow[] = category === "general" ? [
        { id: "advisory-age", title: "Show Advisory Age", key: ADVISORY_KEY, choices: onOff },
        { id: "poster-size", title: "Poster Size", key: CARD_PRESENTATION_KEY, member: "poster_size", choices: [["compact", "Compact"], ["standard", "Standard"], ["large", "Large"]] },
    ] : category === "playback" ? [
        { id: "auto-next", title: "Auto-Play Next Episode", key: AUTO_NEXT_KEY, choices: onOff },
        { id: "next-up", title: "Show Next Up", key: NEXT_UP_KEY, choices: [[0, "At end"], [10, "10 seconds before end"], [30, "30 seconds before end"], [60, "1 minute before end"], [120, "2 minutes before end"]] },
        { id: "skip-intros", title: "Skip Intros", key: INTRO_SKIP_KEY, choices: [["never", "Never"], ["ask", "Ask to skip"], ["always", "Skip automatically"]] },
        { id: "skip-credits", title: "Skip Credits", key: CREDITS_SKIP_KEY, choices: onOff },
    ] : category === "subtitles" ? [
        { id: "metadata-language", title: "Metadata Language", key: METADATA_KEY, choices: [[null, "Library default"], ...state.definitions.find(def => def.key === METADATA_KEY)?.options.map(option => [option.value, option.label] as const) ?? []] },
        appearance("fontSize", "Font Size", [["small", "Small"], ["medium", "Medium"], ["large", "Large"], ["xlarge", "X-Large"], ["xxlarge", "XX-Large"]]),
        appearance("fontFamily", "Font Family", choices(["sans-serif", "serif", "monospace"])),
        appearance("fontColor", "Font Color", colors),
        appearance("textOpacity", "Text Opacity", Array.from({ length: 20 }, (_, index) => [(index + 1) * 5, `${(index + 1) * 5}%`])),
        appearance("textOutline", "Text Outline", onOff),
        appearance("textOutlineColor", "Outline Color", backgrounds),
        appearance("backgroundStyle", "Background Style", [["box", "Box"], ["shadow", "Drop Shadow"], ["none", "None"]]),
        appearance("backgroundOpacity", "Background Opacity", Array.from({ length: 21 }, (_, index) => [index * 5, `${index * 5}%`])),
        appearance("backgroundColor", "Background Color", backgrounds),
        appearance("position", "Position", [["bottom", "Bottom"], ["lower-third", "Lower Third"], ["top", "Top"]]),
    ] : [];
    return rows.filter(row => (row.key !== METADATA_KEY || state.metadataEnabled) && state.definitions.some(def => def.key === row.key)).map(row => {
        const current = rowValue(row, state);
        return row.member?.endsWith("Opacity") && typeof current === "number" && !row.choices.some(([value]) => value === current) ? { ...row, choices: [...row.choices, [current, `${current}%`] as const].sort(([a], [b]) => Number(a) - Number(b)) } : row;
    });
}

export function rowValue(row: SettingsRow, state: SettingsState): SettingValue {
    const stored = state.stored(row.key);
    const value = row.key === APPEARANCE_KEY || row.key === METADATA_KEY ? stored?.isSet ? stored.value : row.key === APPEARANCE_KEY ? {} : null : state.effective.get(row.key)?.value ?? null;
    if (row.member === undefined) return value;
    const document = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, SettingValue>> : {};
    return document[row.member] as SettingValue ?? (row.key === APPEARANCE_KEY ? DEFAULT_APPEARANCE[row.member as keyof typeof DEFAULT_APPEARANCE] : "standard");
}

export function rowEdit(row: SettingsRow, value: SettingValue, state: SettingsState): SettingValue {
    if (row.member === undefined) return value;
    const stored = state.stored(row.key);
    const old = stored?.isSet ? stored.value : row.key === APPEARANCE_KEY ? {} : state.effective.get(row.key)?.value;
    const document = old !== null && typeof old === "object" && !Array.isArray(old) ? old as Readonly<Record<string, SettingValue>> : {};
    const next: Record<string, SettingValue> = { ...document, [row.member]: value };
    if (row.key === CARD_PRESENTATION_KEY) next.caption = "title_metadata";
    if (row.member === "textOutlineColor") next.textOutline = true;
    if (row.member === "backgroundColor" || (row.member === "backgroundOpacity" && Number(value) > 0)) next.backgroundStyle = "box";
    if ((row.member === "backgroundColor" || (row.member === "backgroundStyle" && value === "box")) && next.backgroundOpacity === 0) next.backgroundOpacity = 75;
    return next;
}
