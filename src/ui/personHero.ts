// Person hero facts and portrait. Age and dates follow the tvOS person page at
// silo-apple f334794 (unchanged at 1a7ccee): a Gregorian YYYY-MM-DD, local
// calendar components, age only while the person is living.

import type { Person } from "../contracts/v2/details.ts";
import { graphemeSegments } from "unicode-segmenter/grapheme";
import { artworkUrl } from "./browseModel.ts";
import { el } from "./screen.ts";
import { decodeThumbhash } from "./thumbhash.ts";

const PERSON_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CalendarDate {
    readonly year: number;
    readonly month: number;
    readonly day: number;
}

/** A real Gregorian calendar day. Invalid and non-`YYYY-MM-DD` values are absent. */
function parsePersonDate(value: string | undefined): CalendarDate | undefined {
    const trimmed = value?.trim();
    const match = trimmed === undefined ? null : PERSON_DATE.exec(trimmed);
    if (trimmed === undefined || trimmed === "" || match === null) return undefined;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    // Local components only. `new Date("YYYY-MM-DD")` is UTC and can shift the day.
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
    return { year, month, day };
}

function formatPersonDate(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === "") return undefined;
    const parsed = parsePersonDate(trimmed);
    if (parsed === undefined) return trimmed;
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(parsed.year, parsed.month - 1, parsed.day, 12));
}

/** Whole years from `birthValue` to `today`'s local date, or absent when that is not a living age. */
export function personAge(birthValue: string | undefined, today: Date): number | undefined {
    const birth = parsePersonDate(birthValue);
    if (birth === undefined) return undefined;
    let years = today.getFullYear() - birth.year;
    const month = today.getMonth() + 1;
    const day = today.getDate();
    if (month < birth.month || (month === birth.month && day < birth.day)) years -= 1;
    return years >= 0 ? years : undefined;
}

/** Born, then either Died or a living age, then birthplace. Blank facts are omitted. */
export function personMetadataBadges(person: { readonly birthDate?: string | undefined; readonly deathDate?: string | undefined; readonly birthplace?: string | undefined }, today: Date): string[] {
    const badges: string[] = [];
    const birth = formatPersonDate(person.birthDate);
    if (birth !== undefined) badges.push(`Born ${birth}`);
    const death = formatPersonDate(person.deathDate);
    if (death !== undefined) badges.push(`Died ${death}`);
    else {
        const age = personAge(person.birthDate, today);
        if (age !== undefined) badges.push(`${age} years old`);
    }
    const birthplace = person.birthplace?.trim();
    if (birthplace !== undefined && birthplace !== "") badges.push(birthplace);
    return badges;
}

/** First grapheme of each of the first two space-separated words, or "?". */
export function personInitials(name: string): string {
    const value = name.split(" ").filter(word => word !== "").slice(0, 2).map(firstGrapheme).join("").toLocaleUpperCase("en-US");
    return value === "" ? "?" : value;
}

function firstGrapheme(word: string): string {
    // Chromium 76 has no Intl.Segmenter; use the same complete rules on every TV.
    return graphemeSegments(word).next().value?.segment ?? "";
}

/**
 * The person portrait. No photo shows initials. A photo shows its thumbhash
 * underneath until the image loads, and drops the request when the portrait leaves the page.
 */
export function personPortrait(person: Person, baseUrl: string): HTMLElement {
    const box = el("div", "person-portrait browse-art browse-detail-art");
    const src = photoSource(person.photoUrl, baseUrl);
    if (src === undefined) {
        box.classList.add("browse-art-missing");
        box.dataset.personPortrait = "initials";
        box.appendChild(el("span", "person-portrait-initials", personInitials(person.name)));
        return box;
    }
    box.dataset.personPortrait = "loading";
    const preview = thumbhashLayer(person.photoThumbhash);
    if (preview !== undefined) box.appendChild(preview);
    const image = el("img", "person-portrait-photo browse-art-image");
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    let closed = false;
    const observer = new MutationObserver(() => {
        if (!box.isConnected) cancel();
    });
    const cancel = (): void => {
        if (closed) return;
        closed = true;
        image.onload = null;
        image.onerror = null;
        // Replacing the URL aborts the in-flight photo. An empty string would fetch the page itself.
        image.src = "data:,";
        image.removeAttribute("src");
        observer.disconnect();
    };
    image.onload = () => {
        if (closed || !box.isConnected) {
            cancel();
            return;
        }
        box.dataset.personPortrait = "loaded";
    };
    image.onerror = () => {
        if (closed || !box.isConnected) {
            cancel();
            return;
        }
        closed = true;
        observer.disconnect();
        image.onload = null;
        image.onerror = null;
        image.remove();
        box.classList.add("browse-art-missing");
        box.dataset.personPortrait = "error";
        const mark = el("span", "person-portrait-missing");
        mark.setAttribute("aria-hidden", "true");
        box.appendChild(mark);
    };
    box.appendChild(image);
    queueMicrotask(() => {
        if (closed || !box.isConnected) {
            cancel();
            return;
        }
        observer.observe(document.documentElement, { childList: true, subtree: true });
        image.src = src;
    });
    return box;
}

function photoSource(reference: string | undefined, baseUrl: string): string | undefined {
    const trimmed = reference?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : artworkUrl(trimmed, baseUrl);
}

function thumbhashLayer(encoded: string | undefined): HTMLCanvasElement | undefined {
    const decoded = decodeThumbhash(encoded);
    if (decoded === undefined) return undefined;
    const canvas = el("canvas", "person-portrait-thumbhash");
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    canvas.setAttribute("aria-hidden", "true");
    const context = canvas.getContext("2d");
    if (context === null) return undefined;
    context.putImageData(new ImageData(new Uint8ClampedArray(decoded.rgba), decoded.width, decoded.height), 0, 0);
    return canvas;
}
