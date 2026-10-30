import { boolean, nonEmptyString, object, WireError } from "./wire.ts";

export interface TrickplayManifest {
    readonly fileId: string;
    readonly intervalMs: number;
    readonly width: number;
    readonly height: number;
    readonly columns: number;
    readonly rows: number;
    readonly count: number;
    readonly sheets: readonly string[];
    readonly expiresAt: number;
}

export interface SeekThumbnail {
    readonly url: string;
    readonly index: number;
    readonly sheet: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly sheetWidth: number;
    readonly sheetHeight: number;
}

function positive(obj: ReturnType<typeof object>, key: string): number {
    const value = obj[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new WireError(`trickplay.${key}`, "a positive safe integer");
    }
    return value;
}

/** Signed URLs are opaque; resolve only root-relative paths, retaining the API origin's port. */
function sheetURL(raw: string, origin: string): string {
    let url: URL;
    const published = raw.startsWith("/") && !raw.startsWith("//") ? origin + raw : raw;
    if (!/^https:\/\//i.test(published)) throw new WireError("trickplay.sheet.url", "an absolute HTTPS URL or root-relative path");
    try {
        url = new URL(published);
    } catch {
        throw new WireError("trickplay.sheet.url", "an HTTPS signed URL");
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "" || /[\s\\]/.test(published)) {
        throw new WireError("trickplay.sheet.url", "an HTTPS signed URL");
    }
    return published;
}

export function decodeTrickplay(value: unknown, fileId: string, origin: string): TrickplayManifest {
    const obj = object(value, "trickplay");
    const identity = nonEmptyString(obj, "file_id", "trickplay");
    if (identity !== fileId) throw new WireError("trickplay.file_id", "the effective file");
    const intervalMs = positive(obj, "interval_ms");
    const width = positive(obj, "thumbnail_width");
    const height = positive(obj, "thumbnail_height");
    const columns = positive(obj, "tile_columns");
    const rows = positive(obj, "tile_rows");
    const count = positive(obj, "thumbnail_count");
    for (const product of [columns * rows, columns * width, rows * height, count * intervalMs]) {
        if (!Number.isSafeInteger(product)) throw new WireError("trickplay.geometry", "safe integer geometry");
    }
    const expiry = nonEmptyString(obj, "expires_at", "trickplay");
    const expiresAt = Date.parse(expiry);
    const normalized = expiry.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(expiry) || !Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== normalized) {
        throw new WireError("trickplay.expires_at", "an ISO UTC instant");
    }
    const raw = obj.sheets;
    if (!Array.isArray(raw) || raw.length !== Math.ceil(count / (columns * rows))) {
        throw new WireError("trickplay.sheets", "complete sheet coverage");
    }
    const sheets = raw.map((entry: unknown) => {
        const sheet = object(entry, "trickplay.sheet");
        const index = sheet.index;
        if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) throw new WireError("trickplay.sheet.index", "a sheet index");
        return { index, url: sheetURL(nonEmptyString(sheet, "url", "trickplay.sheet"), origin) };
    }).sort((a, b) => a.index - b.index);
    if (sheets.some((sheet, index) => sheet.index !== index)) throw new WireError("trickplay.sheets", "unique contiguous indexes");
    return { fileId, intervalMs, width, height, columns, rows, count, sheets: sheets.map((sheet) => sheet.url), expiresAt };
}

/** Catalog versions do not carry this watch-state availability flag. */
export function decodeTrickplayFiles(value: unknown): readonly string[] {
    const obj = object(value, "watch");
    if (!Array.isArray(obj.versions)) throw new WireError("watch.versions", "an array");
    return obj.versions.flatMap((entry: unknown) => {
        const version = object(entry, "watch.version");
        const fileId = nonEmptyString(version, "file_id", "watch.version");
        return version.trickplay_available !== undefined && boolean(version, "trickplay_available", "watch.version") ? [fileId] : [];
    });
}

export function thumbnailAt(manifest: TrickplayManifest, seconds: number): SeekThumbnail | undefined {
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    const index = Math.min(manifest.count - 1, Math.floor(seconds / (manifest.intervalMs / 1000)));
    const cells = manifest.columns * manifest.rows;
    const sheet = Math.floor(index / cells);
    const url = manifest.sheets[sheet];
    if (url === undefined) return undefined;
    const cell = index % cells;
    return { url, index, sheet, x: (cell % manifest.columns) * manifest.width,
        y: Math.floor(cell / manifest.columns) * manifest.height, width: manifest.width, height: manifest.height,
        sheetWidth: manifest.columns * manifest.width, sheetHeight: manifest.rows * manifest.height };
}
