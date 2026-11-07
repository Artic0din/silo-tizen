import type { MediaRequest, RequestTitle } from "../contracts/v2/requests.ts";
import { artworkUrl } from "./browseModel.ts";
import { heroBackdrop, type Tints } from "./heroBackdrop.ts";
import { requestProgress, type RequestProgress } from "./requestProgress.ts";
import { el } from "./screen.ts";
import { TMDB_LOGO_PATH } from "./acknowledgements.ts";
import { balanceTwoLineText } from "./textLayout.ts";

const palette = new Map<string, Tints>();
export function requestTrack(progress: RequestProgress, labels = false): HTMLElement {
    const track = el("div", "requests-track");
    track.dataset.requestDisplay = progress.display;
    track.setAttribute("aria-label", progress.long);
    for (const [index, label] of ["Requested", "Approved", "Downloading", "In your library"].entries()) {
        const step = el("span", "requests-step", labels ? label : "");
        step.dataset.state = index < progress.completed ? "complete" : index === progress.current ? "current" : "future";
        track.appendChild(step);
    }
    return track;
}
export function requestMetadata(title: RequestTitle | MediaRequest): string {
    const requested = "createdAt" in title && title.createdAt !== undefined ? `Requested ${requestDate(title.createdAt)}` : undefined;
    return [title.year, title.mediaType === "series" ? "Series" : "Movie", requested].filter(value => value !== undefined && value !== "").join(" · ");
}

export function requestDate(instant: number): string { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(instant)); }

export function requestQuality(targets: MediaRequest["targets"]): string | undefined {
    const phases = new Map([["completed", "done"], ["downloading", "downloading"], ["queued", "queued"], ["approved", "queued"], ["pending", "pending"], ["failed", "failed"]]);
    const progress = (targets?.length ?? 0) > 1 ? targets?.flatMap(target => target.quality && phases.has(target.status) ? [`${target.quality} ${phases.get(target.status)}`] : []) : undefined;
    return (progress?.length ? progress : targets?.map(target => target.quality).filter(Boolean))?.join(" · ") || undefined;
}

export function requestStatusLabel(progress: RequestProgress, text = progress.short): HTMLElement {
    const label = el("span", "requests-status-label", text);
    label.dataset.requestDisplay = progress.display;
    return label;
}

function strokeIcon(d: string): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); svg.setAttribute("viewBox", "0 0 24 24");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", d);
    svg.appendChild(path); return svg;
}

export function requestPosterBadge(progress: RequestProgress): HTMLElement | undefined {
    if (progress.display === "unavailable") return undefined;
    const badge = el("span", "requests-status-badge"); badge.dataset.requestDisplay = progress.display; badge.setAttribute("aria-hidden", "true");
    badge.appendChild(strokeIcon(progress.display === "inLibrary" ? "M5 12l4 4L19 6" : progress.display === "onTheWay" ? "M12 4v16m-6-6 6 6 6-6" : progress.display === "pending" ? "M12 7v5l3 2M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16" : "M12 4v10m0 4v2"));
    return badge;
}

export function requestPlusIcon(): SVGSVGElement {
    const icon = strokeIcon("M12 1.5v21M1.5 12h21"); icon.classList.add("requests-action-icon"); icon.setAttribute("aria-hidden", "true");
    return icon;
}

/** Apple's rail is a lazy stack in a 100...1820 scroll view with clipping disabled: a card that touches those bounds draws whole, and one past them does not draw. */
export function cullToRailBounds(rail: HTMLElement): void {
    const observer = new IntersectionObserver(entries => { for (const entry of entries) entry.target.classList.toggle("requests-card-culled", !entry.isIntersecting); }, { root: rail, rootMargin: "0px -100px" });
    for (const card of rail.querySelectorAll(".requests-card")) observer.observe(card);
}

function detailTitle(title: string): HTMLElement {
    const heading = el("h1", "requests-detail-title"); heading.setAttribute("aria-label", title);
    for (const separator of [": ", " — ", " – ", " - "]) {
        const at = title.indexOf(separator), primary = title.slice(0, at).trim(), secondary = title.slice(at + separator.length).trim();
        if (at >= 0 && primary && secondary) { heading.append(el("span", "requests-title-primary", primary), el("span", "requests-title-secondary", secondary)); return heading; }
    }
    heading.appendChild(el("span", "requests-title-primary", title)); return heading;
}

function detailMetadata(title: RequestTitle | MediaRequest): HTMLElement {
    const row = el("div", "requests-metadata requests-detail-metadata");
    if ("contentRating" in title && title.contentRating) row.appendChild(el("span", "requests-rating-chip", title.contentRating));
    if (title.year) row.appendChild(el("span", "", String(title.year)));
    if (title.mediaType === "series") {
        if ("numberOfSeasons" in title && title.numberOfSeasons !== undefined && title.numberOfSeasons > 0) row.appendChild(el("span", "", `${title.numberOfSeasons} season${title.numberOfSeasons === 1 ? "" : "s"}`));
    } else if ("runtime" in title && title.runtime !== undefined) row.appendChild(el("span", "", `${Math.floor(title.runtime / 60)}h ${title.runtime % 60}m`));
    const rating = requestRating(title); if (rating !== undefined) row.appendChild(rating);
    if ("genres" in title) for (const genre of title.genres?.slice(0, 3) ?? []) row.appendChild(el("span", "", genre));
    return row;
}

function requestRating(title: RequestTitle | MediaRequest): HTMLElement | undefined {
    if (!("voteAverage" in title) || title.voteAverage === undefined || title.voteAverage <= 0) return undefined;
    const rating = el("span", "requests-tmdb"), logo = el("img", ""); logo.src = TMDB_LOGO_PATH; logo.alt = "TMDB";
    rating.append(logo, el("span", "", title.voteAverage.toFixed(1))); return rating;
}

function detailProgress(title: RequestTitle | MediaRequest, progress: RequestProgress): HTMLElement {
    const block = el("div", "requests-detail-progress"); const fields = el("div", "requests-summary");
    const field = (label: string, value: string | HTMLElement): void => { const column = el("div", "requests-summary-field"); column.append(el("div", "requests-summary-label", label), typeof value === "string" ? el("div", "requests-summary-value", value) : value); fields.appendChild(column); };
    field("STATUS", requestStatusLabel(progress, progress.long));
    if ("createdAt" in title && title.createdAt !== undefined) field("REQUESTED", requestDate(title.createdAt));
    if ("targets" in title) { const quality = requestQuality(title.targets); if (quality !== undefined) field("QUALITY", quality); }
    const track = requestTrack(progress, true); track.classList.add("requests-track-labels");
    block.append(fields, track); return block;
}

export function requestHero(title: RequestTitle | MediaRequest, baseUrl: string, metadata?: RequestTitle, detail = false): HTMLElement {
    const root = el("div", detail ? "requests-hero requests-detail-hero" : "requests-hero");
    const path = metadata?.backdropPath ?? title.backdropPath;
    const reference = path?.startsWith("/") && !path.startsWith("//") ? `https://image.tmdb.org/t/p/w1280${path}` : path;
    const url = artworkUrl(reference, baseUrl);
    if (url !== undefined) root.appendChild(heroBackdrop(url, undefined, palette, detail));
    const copy = el("div", "requests-hero-copy");
    // Apple's detail progress excludes unavailable: the action says so, and nothing was requested (RequestDetailViewModel.progress).
    const titleProgress = requestProgress(title), progress = detail && titleProgress?.display === "unavailable" ? undefined : titleProgress;
    if (detail) {
        if (progress?.display !== "inLibrary") copy.appendChild(el("div", "requests-eyebrow", progress === undefined ? "Not in your library" : "Requested"));
        copy.append(detailTitle(title.title), detailMetadata(metadata ?? title));
    } else {
        const metadata = el("p", "requests-metadata"); metadata.appendChild(el("span", "", requestMetadata(title)));
        const rating = requestRating(title); if (rating !== undefined) metadata.appendChild(rating);
        copy.append(el("h1", "requests-hero-title", title.title), metadata);
    }
    copy.appendChild(el("p", "requests-synopsis", metadata?.overview ?? title.overview ?? ""));
    if (progress !== undefined) {
        if (detail && progress.display !== "inLibrary") copy.appendChild(detailProgress(title, progress));
        else if (!detail) { const status = el("div", "requests-progress"); status.append(requestStatusLabel(progress, progress.long), requestTrack(progress)); copy.appendChild(status); }
    }
    if (detail) {
        const credit = metadata?.director ? `Directed by ${metadata.director}` : metadata?.creators?.length ? `Created by ${metadata.creators.slice(0, 2).join(", ")}` : undefined;
        if (credit !== undefined) copy.appendChild(el("p", "requests-credit", credit));
    }
    if (detail) root.dataset.hasStatus = String(progress !== undefined && progress.display !== "inLibrary");
    root.appendChild(copy);
    if (!detail) requestAnimationFrame(() => {
        const heading = root.querySelector<HTMLElement>(".requests-hero-title"), synopsis = root.querySelector<HTMLElement>(".requests-synopsis");
        if (!root.isConnected || heading === null || synopsis === null) return;
        balanceTwoLineText(heading);
        synopsis.style.webkitLineClamp = heading.getBoundingClientRect().height > parseFloat(getComputedStyle(heading).lineHeight) * 1.5 ? "2" : "3";
    });
    return root;
}

/** Apple's `tray` symbol at its 51 x 37 size. */
export const TRAY_ICON = '<svg viewBox="0 0 51 37" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"><path d="M1.5 16 9.6 4.2a6 6 0 0 1 4.9-2.7h22a6 6 0 0 1 4.9 2.7L49.5 16v13.5a6 6 0 0 1-6 6h-36a6 6 0 0 1-6-6Z"/><path d="M1.5 16.5h14c1.3 0 2 .7 2.4 2a7.8 7.8 0 0 0 15.2 0c.4-1.3 1.1-2 2.4-2h14"/></svg>';
// The tvOS ProgressView: eight spokes stepping round, brightest ahead.
const SPINNER_ICON = `<svg viewBox="0 0 40 40" stroke="currentColor" stroke-width="4.5" stroke-linecap="round">${[1, .35, .35, .35, .4, .5, .65, .8].map((opacity, spoke) => `<path d="M20 3v8" opacity="${opacity}" transform="rotate(${spoke * 45} 20 20)"/>`).join("")}</svg>`;

function skeleton(width: number, height: number, opacity: number, radius = height / 2): HTMLElement {
    const node = el("div", "requests-loading-bar");
    node.style.width = `${width}px`; node.style.height = `${height}px`; node.style.borderRadius = `${radius}px`; node.style.background = `rgba(255,255,255,${opacity})`;
    return node;
}
function group(className: string, ...children: HTMLElement[]): HTMLElement {
    const node = el("div", className);
    node.append(...children);
    return node;
}
/** Apple TVRequestsLoadingView with RequestRailSkeleton: static fills, replaced in place by the real page. */
/** Apple's small ProgressView on a primary action that is submitting. */
export function requestActionSpinner(): HTMLElement {
    const spinner = el("span", "requests-action-spinner");
    spinner.setAttribute("aria-hidden", "true");
    spinner.innerHTML = SPINNER_ICON;
    return spinner;
}

export function requestsLoadingPage(): HTMLElement {
    const block = skeleton(520, 72, .14, 12);
    block.classList.add("requests-loading-block");
    const spinner = el("span", "requests-loading-spinner");
    spinner.setAttribute("aria-hidden", "true");
    spinner.innerHTML = SPINNER_ICON;
    const marquee = group("requests-loading-marquee", block,
        group("requests-loading-meta", skeleton(118, 22, .12), skeleton(82, 22, .12), skeleton(150, 22, .12)),
        group("requests-loading-copy", skeleton(720, 18, .12), skeleton(610, 18, .12)),
        group("requests-loading-status", spinner, el("span", "requests-loading-label", "Loading Requests")));
    const cards = Array.from({ length: 8 }, (_, index) => group("requests-loading-card", skeleton(176, 264, .09 + index % 3 * .01, 12), skeleton(176 * .76, 18, .14), skeleton(176 * .38, 18 * .8, .09)));
    return group("requests-loading", marquee, group("requests-loading-rail", skeleton(300, 28, .14), group("requests-loading-cards", ...cards)));
}
