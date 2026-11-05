import type { Audiobook, AudioRelated } from "../contracts/v2/audiobooks.ts";
import { audiobookPrimaryLabel } from "../contracts/v2/audiobooks.ts";
import type { FocusItem, Zone } from "./browseFocus.ts";
import { actionButton, artwork, cardItem, zoneNode } from "./browseViews.ts";
import { clockTime } from "./browseModel.ts";
import { el } from "./screen.ts";

export function audioPeople(names: readonly string[], visible = 2): string {
    const people = names.flatMap(name => name.split(",")).map(name => name.trim()).filter(Boolean);
    if (people.length > visible + 1) return `${people.slice(0, visible).join(", ")} & ${people.length - visible} more`;
    return people.length < 2 ? people.join("") : `${people.slice(0, -1).join(", ")} & ${people.at(-1)}`;
}
export function cleanAudioTitle(raw: string, series?: string): string {
    const original = raw.trim();
    let title = original;
    const article = (value: string): string => value.replace(/^(the|an|a) /i, "");
    if (series) {
        const core = article(series).trim(), hay = article(title);
        const rest = hay.slice(core.length);
        if (core && hay.toLowerCase().startsWith(core.toLowerCase()) && !/^\p{L}/u.test(rest)) title = rest.replace(/^[ \d–—:#-]+/u, "").trim() || title;
    }
    title = title.replace(/\s*\(\s*\d+\s+of\s+\d+\s*\)$/i, "").replace(/\s*\(\s*book\s+\d+\s*\)$/i, "").replace(/\s*\(\s*vol(?:ume)?\.?\s*\d+\s*\)$/i, "");
    return title.replace(/^[\s–—:·,\-]+|[\s–—:·,\-]+$/g, "") || original;
}
function runtime(seconds: number): string {
    if (seconds <= 0) return "";
    const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
    return hours > 0 ? `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}` : `${minutes}m`;
}

/** tvOS Lounge detail at silo-apple df891d2e; all dimensions come from its Swift. */
export function audiobookDetail(book: Audiobook, actions: readonly FocusItem[], baseUrl: string, open: (id: string) => void, notices: readonly HTMLElement[] = []): { content: HTMLElement[]; zones: Zone[] } {
    const metadata = book.metadata;
    const background = el("div", "audiobook-backdrop");
    background.append(artwork("audiobook-wash", book.poster, baseUrl, ""));
    const hero = el("div", "audiobook-hero");
    const identity = el("div", "audiobook-identity");
    identity.append(el("p", "audiobook-eyebrow", `AUDIOBOOK${metadata?.genres[0] ? ` · ${metadata.genres[0].toUpperCase()}` : ""}`), el("h1", "audiobook-title", cleanAudioTitle(book.title, metadata?.series?.name)));
    const series = metadata?.series;
    if (series?.name) {
        const volume = /\(\s*(\d+)\s+of\s+(\d+)\s*\)\s*$/i.exec(book.title);
        const index = series.entries.find(entry => entry.id === book.id)?.index ?? (volume === null ? undefined : Number(volume[1]));
        const total = volume === null ? undefined : Number(volume[2]);
        identity.append(el("p", "audiobook-series", `${series.name}${index !== undefined && index > 0 ? ` · Book ${index}${total !== undefined && total >= index && total > 1 ? ` of ${total}` : ""}` : ""}`.toUpperCase()));
    }
    const author = audioPeople(metadata?.authors ?? []), narrator = audioPeople(metadata?.narrators ?? []);
    if (author || narrator) identity.append(el("p", "audiobook-credits", [author ? `by ${author}` : "", narrator ? `read by ${narrator}` : ""].filter(Boolean).join("  ·  ")));
    const state = el("div", "audiobook-state");
    const label = audiobookPrimaryLabel(book);
    const chapterIndex = book.chapters.reduce((current, chapter, index) => chapter.start <= book.position ? index : current, -1);
    const chapter = book.chapters[chapterIndex];
    if (label !== "Play") {
        const fraction = label === "Play Again" ? 1 : book.duration > 0 ? Math.min(1, book.position / book.duration) : 0;
        const ring = el("div", "audiobook-ring", `${Math.round(fraction * 100)}%`);
        ring.style.setProperty("--audio-progress", `${fraction * 360}deg`); state.append(ring);
    }
    const lines = el("div", "audiobook-state-lines");
    lines.append(el("p", "audiobook-state-primary", label === "Resume" ? chapter === undefined ? `${runtime(book.position)} listened` : `Chapter ${chapterIndex + 1} · ${chapter.title}` : label === "Play Again" ? "Finished" : "Not started"));
    const secondary = label === "Resume" ? [chapter === undefined ? "" : `${clockTime(Math.max(0, book.position - chapter.start))} into the chapter`, runtime(Math.max(0, book.duration - book.position)) ? `${runtime(Math.max(0, book.duration - book.position))} left in the book` : ""].filter(Boolean).join(" · ") : [runtime(book.duration), label === "Play" && book.chapters.length ? `${book.chapters.length} chapters` : ""].filter(Boolean).join(" · ");
    if (secondary) lines.append(el("p", "audiobook-state-secondary", secondary));
    state.append(lines); identity.append(state, ...notices, zoneNode("browse-actions audiobook-detail-actions", actions));
    hero.append(artwork("audiobook-cover", book.poster, baseUrl, "Audiobook"), identity);
    const sections = el("div", "audiobook-sections");
    if (book.overview) sections.append(el("h2", "browse-section-title", "About"), el("p", "audiobook-overview", book.overview));
    const credits = [author ? `Written by ${audioPeople(metadata?.authors ?? [], 3)}` : "", narrator ? `Narrated by ${audioPeople(metadata?.narrators ?? [], 3)}` : "", metadata?.publisher, metadata?.year?.toString()].filter(Boolean).join(" · ");
    if (credits) sections.append(el("p", "audiobook-static-credits", credits));
    const zones: Zone[] = [{ id: "audio-actions", layout: "row", items: actions }];
    const rail = (id: string, title: string, entries: readonly AudioRelated[]): void => {
        if (entries.length === 0) return;
        const cards = entries.flatMap(entry => {
            const card = cardItem({ id: entry.id, title: entry.title, type: "unknown", posterUrl: entry.poster, year: entry.year, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined }, { baseUrl, cardDestination: card => ({ kind: "item", id: card.id, title: card.title }), open: destination => { if (destination.kind === "item") open(destination.id); } });
            if (card === undefined) return [];
            card.element.classList.add("audiobook-card"); return [card];
        });
        sections.append(el("h2", "browse-section-title", title), zoneNode("browse-row audiobook-rail", cards));
        zones.push({ id, layout: "row", items: cards });
    };
    if (metadata?.narrations.length) {
        const narrations = metadata.narrations.map(narration => actionButton(narration.id, [narration.title, narration.year].filter(value => value !== undefined).join(" · "), () => open(narration.id)));
        sections.append(el("h2", "browse-section-title", "Narrations"), zoneNode("audiobook-narrations", narrations));
        zones.push({ id: "narrations", layout: "column", items: narrations });
    }
    rail("series", series?.name ?? "Series", series?.entries ?? []);
    rail("author", "More by Author", metadata?.alsoByAuthor ?? []);
    rail("related", "Related", metadata?.similar ?? []);
    return { content: [background, hero, sections], zones };
}
