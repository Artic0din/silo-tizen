import { object, string } from "./wire.ts";

export interface SubtitleAppearance {
    readonly fontSize: "small" | "medium" | "large" | "xlarge" | "xxlarge";
    readonly fontFamily: string;
    readonly fontColor: string;
    readonly backgroundColor: string;
    readonly backgroundStyle: "box" | "shadow" | "outline" | "none";
    readonly backgroundOpacity: number;
    readonly textOpacity: number;
    readonly textOutline: boolean;
    readonly textOutlineColor: string;
    readonly position: "bottom" | "lower-third" | "top";
}

export const DEFAULT_APPEARANCE: SubtitleAppearance = {
    fontSize: "large", fontFamily: "sans-serif", fontColor: "#ffffff", backgroundColor: "#000000", backgroundStyle: "box",
    backgroundOpacity: 75, textOpacity: 100, textOutline: false, textOutlineColor: "#000000", position: "bottom",
};

export function decodeAppearance(value: unknown, profileId: string): SubtitleAppearance {
    const body = object(value, "subtitle_appearance");
    if (string(body, "profile_id", "subtitle_appearance") !== profileId) throw new Error("Subtitle profile mismatch");
    const effective = string(body, "effective_value", "subtitle_appearance");
    const raw = effective === "" ? {} : object(JSON.parse(effective) as unknown, "appearance");
    const result = { ...DEFAULT_APPEARANCE, ...raw };
    if (!["small", "medium", "large", "xlarge", "xxlarge"].includes(String(result.fontSize)) || !["bottom", "lower-third", "top"].includes(String(result.position)) || !["box", "shadow", "outline", "none"].includes(String(result.backgroundStyle))) throw new Error("Invalid subtitle style");
    for (const key of ["fontColor", "backgroundColor", "textOutlineColor"] as const) if (typeof result[key] !== "string" || !/^#[0-9a-f]{6}$/i.test(result[key])) throw new Error("Invalid subtitle color");
    if (typeof result.fontFamily !== "string" || result.fontFamily.length > 64 || !/^[^\x00-\x1f"'(){};:,\\/ ][^\x00-\x1f"'(){};:,\\/]*$/.test(result.fontFamily)) throw new Error("Invalid subtitle font");
    for (const key of ["backgroundOpacity", "textOpacity"] as const) if (!Number.isInteger(result[key]) || Number(result[key]) < (key === "textOpacity" ? 1 : 0) || Number(result[key]) > 100) throw new Error("Invalid subtitle opacity");
    if (typeof result.textOutline !== "boolean") throw new Error("Invalid subtitle outline");
    return result as SubtitleAppearance;
}

export interface SubtitleCue { readonly start: number; readonly end: number; readonly text: string }

function seconds(value: string): number {
    const parts = value.trim().replace(",", ".").split(":").map(Number);
    return parts.length === 3 ? (parts[0] ?? NaN) * 3600 + (parts[1] ?? NaN) * 60 + (parts[2] ?? NaN) : parts.length === 2 ? (parts[0] ?? NaN) * 60 + (parts[1] ?? NaN) : NaN;
}

export function decodeCues(text: string, format: string, origin: number): readonly SubtitleCue[] {
    const cues: SubtitleCue[] = [];
    const add = (start: number, end: number, text: string): void => {
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) cues.push({ start: start + origin, end: end + origin, text });
    };
    const plain = (text: string): string => text.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|nbsp|quot|apos);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&quot;": '"', "&apos;": "'" })[entity] ?? entity);
    if (format === "vtt" || format === "webvtt" || format === "srt") {
        for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
            const lines = block.split("\n");
            const index = lines.findIndex(line => line.includes(" --> "));
            const timing = lines[index]?.match(/^(\S+)\s+-->\s+(\S+)/);
            if (timing !== null && timing !== undefined) add(seconds(timing[1] ?? ""), seconds(timing[2] ?? ""), plain(lines.slice(index + 1).join("\n")));
        }
    } else if (format === "ass" || format === "ssa") {
        // shortcut: ASS text only; add a full renderer when authored styles and drawings are required.
        let fields: string[] = [];
        let events = false;
        for (const line of text.split(/\r?\n/)) {
            if (line.startsWith("[")) events = line.trim().toLowerCase() === "[events]";
            if (!events) continue;
            if (/^Format:/i.test(line)) fields = line.slice(7).split(",").map(field => field.trim().toLowerCase());
            if (!/^Dialogue:/i.test(line) || fields[fields.length - 1] !== "text") continue;
            const parts = line.slice(9).split(",");
            if (/\\p[1-9]/.test(parts.slice(fields.length - 1).join(","))) continue;
            add(seconds(parts[fields.indexOf("start")] ?? ""), seconds(parts[fields.indexOf("end")] ?? ""), parts.slice(fields.length - 1).join(",").replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " "));
        }
    } else throw new Error("Unsupported subtitle format");
    return cues.sort((a, b) => a.start - b.start);
}
