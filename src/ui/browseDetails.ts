// DOM for item pages (movie, series, episode) and a season's episode list.

import type { Episode, ItemDetail, Season } from "../contracts/v2/catalog.ts";
import type { Credit, Person } from "../contracts/v2/details.ts";
import type { Card } from "../contracts/v2/catalog.ts";
import type { DetailsState } from "./detailsState.ts";
import { TRANSLATE_DESCRIPTION_LABEL, type DescriptionTranslationStatus } from "./descriptionTranslation.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { artworkUrl, clockTime, episodeLabel, playChoices, type PlayRequest } from "./browseModel.ts";
import { trailerCards, type TrailerCard } from "./trailerRail.ts";
import { actionButton, artwork, cardItem, heading, lines, mediaItem, type ViewContext, zoneNode } from "./browseViews.ts";
import { personMetadataBadges, personPortrait } from "./personHero.ts";
import { el } from "./screen.ts";
import { detailAction, detailPanel } from "./detailsActions.ts";
import { initialSubtitle, matchesSubtitle } from "../player/preplaySubtitles.ts";
import type { SubtitleSignature } from "../contracts/v2/preplaySubtitles.ts";
import { seriesEpisodesView } from "./seriesEpisodesView.ts";
import { languageName } from "./cardOverlays.ts";
import { heroBackdrop, type Tints } from "./heroBackdrop.ts";
import { episodeAirDate, episodeRuntime } from "./episodeCaption.ts";
import { TMDB_LOGO_PATH } from "./acknowledgements.ts";

const detailPalette = new Map<string, Tints>();

function metaLine(detail: ItemDetail, state?: DetailsState): string {
    const parts: string[] = [];
    if (detail.year !== undefined) {
        parts.push(String(detail.year));
    }
    if (detail.runtimeMinutes !== undefined && detail.runtimeMinutes > 0) {
        const file = detail.versions.find(file => file.fileId === playChoices(detail, state?.selectedFileId)?.fromStart.fileId);
        const minutes = file?.durationSeconds ? Math.round(file.durationSeconds / 60) : detail.runtimeMinutes;
        parts.push(minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`);
    }
    const count = state?.series?.seasons.filter(season => !season.isSpecials).length;
    if (detail.type === "series" && count) parts.push(`${count} Season${count === 1 ? "" : "s"}`);
    return parts.join("\u2002·\u2002");
}

function overviewText(overview: string, status: DescriptionTranslationStatus | undefined): HTMLElement {
    const text = el("p", "browse-text browse-overview", overview);
    if (status !== undefined) text.classList.add("has-translation-status");
    if (status?.kind === "translating") text.classList.add("is-translating");
    return text;
}

function translationStatus(status: DescriptionTranslationStatus): HTMLElement {
    const line = el("p", "description-translation-status", status.text);
    line.dataset.translationStatus = status.kind;
    return line;
}

function detailHeader(detail: ItemDetail, context: ViewContext, actions: readonly FocusItem[], state?: DetailsState, summary?: string): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const label = episodeLabel(detail.seasonNumber, detail.episodeNumber);
    if (detail.type === "episode" && (detail.seriesTitle !== undefined || label !== undefined)) {
        nodes.push(el("p", "browse-kicker", [detail.seriesTitle, label].filter((part) => part !== undefined).join(" · ")));
    }
    const title = heading(detail.title);
    title.classList.add("requests-detail-title");
    const split = detail.title.indexOf(": ");
    title.textContent = "";
    title.appendChild(el("span", "requests-title-primary", split < 0 ? detail.title : detail.title.slice(0, split)));
    if (split >= 0) title.appendChild(el("span", "requests-title-secondary", detail.title.slice(split + 2)));
    const logo = artworkUrl(detail.extra?.logoUrl, context.baseUrl);
    const allowed = state?.titleArtGuard();
    if (logo !== undefined && allowed?.()) {
        const image = el("img", "details-logo");
        image.alt = detail.title;
        image.referrerPolicy = "no-referrer";
        image.addEventListener("load", () => {
            if (!allowed() || !title.isConnected || title.closest("[hidden]") !== null) return;
            title.textContent = "";
            title.appendChild(image);
        });
        image.src = logo;
    }
    nodes.push(title);
    if (state?.showAdvisoryAge && detail.advisoryAge !== undefined) nodes.push(el("p", "browse-meta", `Advisory Age ${detail.advisoryAge}+`));
    const episode = state?.series?.episodes?.find(episode => episode.id === state.heroEpisodeId);
    const playback = state?.nextEpisodeState;
    const selectedFile = playback?.detail.versions.find(file => file.fileId === playChoices(playback.detail, playback.selectedFileId)?.fromStart.fileId);
    const meta = episode === undefined ? metaLine(detail, state) : [episodeAirDate(episode.airDate), episodeRuntime(selectedFile?.durationSeconds ? Math.round(selectedFile.durationSeconds / 60) : episode.runtimeMinutes), episode.seasonNumber === 0 ? "Specials" : `Season ${episode.seasonNumber}`, `Episode ${episode.episodeNumber}`].filter(Boolean).join("\u2002·\u2002");
    const ratings = (episode === undefined ? detail.extra?.ratings : playback?.detail.extra?.ratings ?? episode.ratings)?.map(rating => `${rating.name} ${rating.display}`).join(" · ");
    const ratingChip = detail.contentRating?.trim();
    if (meta || ratings || ratingChip) {
        const facts = el("p", "browse-meta", meta);
        for (const rating of (episode === undefined ? detail.extra?.ratings : playback?.detail.extra?.ratings ?? episode.ratings) ?? []) {
            const badge = el("span", "details-external-rating");
            if (rating.name.toUpperCase() === "TMDB") {
                const logo = el("img", "skyline-rating-logo"); logo.src = TMDB_LOGO_PATH; logo.alt = "TMDB";
                badge.append(logo);
            } else badge.append(el("span", "", rating.name));
            badge.append(" ", el("span", "details-rating-score", rating.display)); facts.append("\u2002·\u2002", badge);
        }
        if (episode === undefined && detail.genres.length) facts.append("\u2002·\u2002", el("span", "details-genres", detail.genres.slice(0, detail.type === "series" ? 2 : 3).join(", ")));
        if (ratingChip) facts.prepend(el("span", "details-rating-badge", ratingChip));
        nodes.push(facts);
    }
    const overview = episode === undefined ? detail.overview : [playback?.detail.title ?? episode.title, episode.overview || playback?.detail.overview].filter(Boolean).join(" · ");
    const translation = state?.descriptions?.status(episode, playback?.detail);
    if ((overview !== undefined && overview !== "") || translation !== undefined) {
        if (overview !== undefined && overview !== "") nodes.push(overviewText(overview, translation));
        if (translation !== undefined) nodes.push(translationStatus(translation));
    }
    const directors = detail.extra?.crew.filter(credit => credit.role.toLowerCase() === "director").map(credit => credit.name);
    const credit = detail.type === "movie" ? directors?.length ? `Directed by ${directors.slice(0, 2).join(", ")}` : undefined : detail.extra?.cast.length ? `Starring ${detail.extra.cast.slice(0, 3).map(person => person.name).join(", ")}` : undefined;
    if (credit !== undefined) nodes.push(el("p", "details-director", credit));
    if (summary !== undefined) {
        const readout = el("div", "details-playback-summary");
        for (const part of summary.split(" | ")) {
            const at = part.indexOf(": ");
            const field = el("div", ""); field.dataset.trackSummary = part.slice(0, at).toLowerCase();
            field.append(el("strong", "", part.slice(0, at).toUpperCase()), el("span", "", part.slice(at + 2)));
            readout.appendChild(field);
        }
        nodes.push(readout);
    }
    const layout = el("div", "details-hero");
    layout.dataset.mediaType = detail.type;
    const backdrop = artworkUrl(detail.backdropUrl ?? detail.posterUrl, context.baseUrl);
    const background = heroBackdrop(backdrop ?? "", undefined, detailPalette, true);
    const wash = background.querySelector<HTMLElement>(".skyline-tint-wash")!;
    wash.classList.add("details-page-wash");
    wash.remove();
    layout.appendChild(background);
    const info = el("div", "details-editorial");
    if (detail.type === "series") {
        const lift = (context.posterScale?.() ?? 1) > 1 ? 32 : 0;
        layout.style.height = `${690 - lift}px`;
        info.style.paddingTop = `${116 - lift}px`;
        const editorial = el("div", "details-series-editorial");
        const primary = el("div", "details-series-primary");
        const disclosure = el("div", "details-series-disclosure");
        primary.append(...nodes.filter(node => !node.matches(".details-director, .details-playback-summary")));
        disclosure.append(nodes.find(node => node.matches(".details-director")) ?? el("div", "details-director"), nodes.find(node => node.matches(".details-playback-summary")) ?? el("div", "details-playback-summary"));
        editorial.append(primary, disclosure);
        info.appendChild(editorial);
    } else info.append(...nodes);
    info.appendChild(zoneNode("browse-actions", actions));
    layout.appendChild(info);
    return [wash, layout];
}

export function itemView(detail: ItemDetail, seasons: readonly Season[], context: ViewContext, play: (request: PlayRequest) => void, back: () => void, state?: DetailsState): View {
    detail = state === undefined ? detail : { ...detail, versions: state.detail.versions };
    const tracks = state?.nextEpisodeState ?? state;
    const playbackDetail = tracks?.detail ?? detail;
    const playbackChoices = playChoices(playbackDetail, tracks?.selectedFileId);
    const preferences = state?.unsettledEpisode ?? tracks;
    const actions: FocusItem[] = [];
    const notes: string[] = [];
    if (preferences?.audioPreference.pending) notes.push("Saving audio preference…");
    if (preferences?.subtitlePreference.pending) notes.push("Saving subtitle preference…");
    if (preferences?.subtitlePreference.failed) {
        notes.push("Subtitle preference could not be confirmed.");
        actions.push(actionButton("retry-subtitle-preference", "Check subtitle preference", () => state?.retryPreference("subtitles", preferences)));
    }
    if (preferences?.audioPreference.failed) {
        notes.push("Could not confirm the audio preference. Check before playing.");
        actions.push(actionButton("retry-audio-preference", "Check audio preference", () => state?.retryPreference("audio", preferences)));
    }
    const choices = playChoices(detail, state?.selectedFileId);
    const choose = (request: PlayRequest): void => {
        const audioTrackId = state?.audioTrackId(true);
        play({ ...request, ...(audioTrackId === undefined ? {} : { audioTrackId }), ...(state === undefined ? {} : { subtitle: state.subtitleIntent() }) });
    };
    if (choices?.resume !== undefined) {
        const resume = choices.resume;
        actions.push(actionButton("resume", `Resume from ${clockTime(resume.startSeconds ?? 0)}`, () => choose(resume)));
        actions.push(actionButton("play", "Play from start", () => choose(choices.fromStart)));
    } else if (choices !== undefined) {
        actions.push(actionButton("play", "Play", () => choose(choices.fromStart)));
    } else if (detail.type === "movie" || detail.type === "episode") {
        notes.push("This title has no file this TV can play.");
    }
    const next = state?.series === undefined ? state?.playbackTargetId ?? detail.playContentId : state.playbackTargetId;
    if ((detail.type === "series" || detail.type === "season") && next !== undefined) {
        const target = state?.nextEpisode;
        const targetChoices = playbackChoices;
        const playNext = (startOver = false): void => {
            if (state?.episodePreferencesBlocked) return;
            if (target === undefined) { context.playEpisode?.(next, state?.series?.railEpisodes?.find(episode => episode.id === next)?.title ?? detail.title, startOver); return; }
            if (targetChoices === undefined) return;
            const audioTrackId = tracks?.audioTrackId(true);
            play({ ...(targetChoices.resume ?? targetChoices.fromStart), startSeconds: startOver ? 0 : targetChoices.resume?.startSeconds, ...(audioTrackId === undefined ? {} : { audioTrackId }), ...(tracks === undefined ? {} : { subtitle: tracks.subtitleIntent() }) });
        };
        const summary = state?.series?.railEpisodes?.find(episode => episode.id === next);
        const labelTarget = summary ?? target;
        const canResume = targetChoices?.resume !== undefined || target === undefined && summary?.inProgress === true;
        const label = labelTarget === undefined ? "Loading episode…" : `${canResume ? "Resume" : "Play"} ${episodeLabel(labelTarget.seasonNumber, labelTarget.episodeNumber) ?? labelTarget.title}`;
        const primary = actionButton("next-episode", state?.nextEpisodeFailed === true ? "Retry episode" : target !== undefined && targetChoices === undefined ? "Episode unavailable" : label, () => {
            if (state?.nextEpisodeFailed === true) state.loadNextEpisode();
            else playNext();
        });
        primary.element.setAttribute("aria-disabled", String(state?.episodePreferencesBlocked || (state?.nextEpisodeFailed !== true && target !== undefined && targetChoices === undefined)));
        actions.push(primary);
        if (canResume) actions.push(actionButton("start-over-episode", "Start Over", () => playNext(true)));
        if (target !== undefined && targetChoices === undefined) notes.push("This episode has no file this TV can play.");
    }
    const seriesContext: ViewContext = { ...context, playEpisode: (id, title, startOver) => {
        const cached = state?.cachedEpisode(id);
        if (state?.episodePreferencesBlocked || cached?.audioPreference.pending || cached?.audioPreference.failed || cached?.subtitlePreference.pending || cached?.subtitlePreference.failed) return;
        const audioTrackId = cached?.audioTrackId(true);
        context.playEpisode?.(id, title, startOver, cached === undefined ? undefined : { ...(cached.selectedFileId === undefined ? {} : { fileId: cached.selectedFileId }), ...(audioTrackId === undefined ? {} : { audioTrackId }), subtitle: cached.subtitleIntent() });
    } };
    const series = state?.series === undefined ? undefined : seriesEpisodesView(state.series, seriesContext, id => state.focusEpisode(id), next);
    const seasonItems = series?.zones[0]?.items ?? (detail.type === "series" ? seasons.map((season) => seasonItem(detail.id, detail.title, season, context)) : []);
    const overview = detail.overview;
    const file = playbackDetail.versions.find(file => file.fileId === playbackChoices?.fromStart.fileId);
    const audio = file?.audio ?? [];
    const selectedAudio = tracks?.audioTrackId(true);
    const explicitAudio = audio.findIndex((_track, index) => selectedAudio === `file:${file?.fileId}:audio:${index}`);
    const effectiveAudio = explicitAudio >= 0 ? explicitAudio : file?.effectiveAudioTrackIndex ?? audio.findIndex(track => track.isDefault);
    const resolvedAudioTrack = audio[effectiveAudio] ?? audio[0];
    const subtitle = tracks?.subtitleIntent();
    const subtitleLabel = (track: SubtitleSignature): string => {
        const codec = /subrip|srt/i.test(track.codec ?? '') ? 'SRT' : track.codec?.toUpperCase();
        const label = track.label && ![track.codec?.toUpperCase(), codec].includes(track.label.toUpperCase()) ? track.label : undefined;
        const name = [languageName(track.language) ?? "Unknown language", label, track.forced ? "Forced" : undefined, track.hearingImpaired ? "SDH" : undefined].filter(Boolean).join(' · ');
        return codec ? `${name} · ${codec}` : name;
    };
    const selectedSubtitleLabel = subtitle?.kind === "track" ? subtitleLabel(subtitle.signature) : subtitle?.kind === "off" ? "Off" : "Auto";
    const autoSubtitle = file?.effectiveSubtitle === undefined ? undefined : initialSubtitle({ kind: "auto" }, (file.subtitles ?? []).map((track, index) => ({ ...track, trackId: String(index), combinedIndex: index, delivery: "unknown" as const })), { ...file.effectiveSubtitle, audioLanguage: resolvedAudioTrack?.language });
    const autoSubtitleTrack = autoSubtitle === undefined ? undefined : file?.subtitles?.[Number(autoSubtitle)];
    const subtitleSummary = selectedSubtitleLabel !== "Auto" ? selectedSubtitleLabel : `Auto · ${autoSubtitleTrack === undefined ? "None" : subtitleLabel(autoSubtitleTrack)}`;
    const audioDetails = (index: number): string => {
        const track = audio[index];
        const rawLayout = track?.layout?.replace(/\(.*\)/, '').trim();
        const layout = /stereo/i.test(rawLayout ?? '') ? 'Stereo' : /mono/i.test(rawLayout ?? '') ? 'Mono' : rawLayout || (track?.channels === 6 ? '5.1' : track?.channels === 8 ? '7.1' : track?.channels === 2 ? 'Stereo' : track?.channels === 1 ? 'Mono' : track?.channels === undefined ? undefined : `${track.channels}ch`);
        return [track?.codec?.toUpperCase(), layout].filter(Boolean).join(' · ');
    };
    const audioTitle = (index: number): string => {
        const track = audio[index];
        const embedded = track?.embeddedTitle?.trim();
        const meaningful = embedded && !/^(?:ATSC|AC-?3|E-?AC-?3|AAC|DTS|FLAC|PCM|OPUS|MP3|VORBIS)(?:\b|$)/i.test(embedded) ? embedded : undefined;
        return meaningful ?? languageName(track?.language) ?? `Track ${index + 1}`;
    };
    const audioLabel = (index: number): string => [languageName(audio[index]?.language), audioDetails(index)].filter(Boolean).join(' · ') || audioTitle(index);
    const seriesSelectors = detail.type === "series";
    if ((playbackChoices !== undefined || seriesSelectors) && state !== undefined) {
        const ordinal = audio.findIndex((_track, index) => selectedAudio === `file:${file?.fileId}:audio:${index}`);
        const trigger = actionButton("audio", `Audio: ${ordinal === -1 ? "Auto" : audioLabel(ordinal)}`, () => state.showPanel("audio"));
        trigger.element.setAttribute("aria-disabled", String(playbackChoices === undefined && (!seriesSelectors || state.nextEpisode !== undefined || state.nextEpisodeFailed)));
        trigger.element.setAttribute("aria-haspopup", "dialog");
        trigger.element.setAttribute("aria-expanded", String(state.audioOpen));
        actions.push(trigger);
        const subtitles = actionButton("subtitles", `Subtitles: ${selectedSubtitleLabel}`, () => state.showPanel("subtitles"));
        subtitles.element.setAttribute("aria-disabled", String(playbackChoices === undefined && (!seriesSelectors || state.nextEpisode !== undefined || state.nextEpisodeFailed)));
        subtitles.element.setAttribute("aria-haspopup", "dialog");
        subtitles.element.setAttribute("aria-expanded", String(state.panel === "subtitles"));
        actions.push(subtitles);
    }
    if (detail.type === "series" && seasonItems.length === 0) {
        notes.push("This series has no seasons yet.");
    }
    if (actions.length === 0 && seasonItems.length === 0) {
        actions.push(actionButton("back", "Back", back));
    }
    if (state?.titleArtPolicy === "failed") actions.push(actionButton("retry-title-art", "Retry title art", () => state.loadTitleArt()));
    if (tracks?.failedPlay !== undefined) {
        const request = tracks.failedPlay;
        actions.push(actionButton("retry-play", "Try again", () => play(request)));
    }
    const personal = state === undefined ? undefined : personalControls(state);
    const watchlist = personal?.items.find(item => item.key === "watchlist");
    if (watchlist !== undefined) actions.push(watchlist);
    if (state !== undefined) {
        if (playbackDetail.versions.length > 0 || seriesSelectors) {
            const version = actionButton("version", `Version: ${file?.label || "Auto"}`, () => state.showPanel("version"));
            version.element.setAttribute("aria-disabled", String(playbackChoices === undefined && (!seriesSelectors || state.nextEpisode !== undefined || state.nextEpisodeFailed)));
            version.element.setAttribute("aria-haspopup", "dialog");
            actions.splice(actions.findIndex(item => item.key === "audio"), 0, version);
        }
        const more = actionButton("more", "More", () => state.showPanel("more"));
        more.element.setAttribute("aria-haspopup", "dialog");
        actions.push(more);
    }
    const ordinal = audio.findIndex((_track, index) => selectedAudio === `file:${file?.fileId}:audio:${index}`);
    const resolvedAudio = audio[effectiveAudio] === undefined ? audio.length ? audioLabel(0) : "Unknown" : audioLabel(effectiveAudio);
    const versionLabel = file?.label?.match(/\b(?:\d{3,4}p|4K|8K)\b/i)?.[0] ?? file?.label ?? "Auto";
    // Season summaries lack versions; omit unavailable values without fetching on loaded-season moves.
    const summary = playbackChoices === undefined ? undefined : `Version: ${tracks?.selectedFileId === undefined && versionLabel !== "Auto" ? "Auto · " : ""}${versionLabel} | Audio: ${ordinal === -1 ? "Auto · " : ""}${resolvedAudio} | Subtitles: ${subtitleSummary}`;
    const content = [...detailHeader(detail, context, actions.map(detailAction), state, summary), ...lines(notes), ...personal?.notes ?? []];
    if (tracks?.preparingPlay) {
        const status = el("p", "browse-text", "Checking resume position…");
        status.setAttribute("role", "status");
        content.push(status);
    }
    for (const action of actions.filter(action => ["play", "resume", "next-episode", "start-over-episode", "retry-play"].includes(action.key))) {
        if (playbackChoices !== undefined) action.element.setAttribute("aria-disabled", String(state?.episodePreferencesBlocked || tracks?.preparingPlay || tracks?.audioPreference.pending || tracks?.audioPreference.failed || tracks?.subtitlePreference.pending || tracks?.subtitlePreference.failed));
    }
    if (tracks?.failedPlay !== undefined) {
        content.push(...lines(["Could not prepare playback."], "error"));
    }
    if (state?.nextEpisodeFailed === true) content.push(...lines(["Could not load the next episode."], "error"));
    if (state?.titleArtPolicy === "failed") content.push(...lines(["Could not load title-art settings."], "error"));
    if (series !== undefined) content.push(...series.content);
    else if (seasonItems.length > 0) {
        content.push(el("h2", "browse-section-title", "Seasons"), zoneNode("browse-row", seasonItems));
    }
    const zones: Zone[] = [
        { id: "actions", layout: "row", items: actions },
        ...series?.zones ?? [{ id: "seasons", layout: "row" as const, items: seasonItems }],
    ];
    const credits: Credit[] = [];
    for (const credit of [...detail.extra?.cast ?? [], ...detail.extra?.crew ?? []]) {
        const index = credits.findIndex((previous) => credit.id ? previous.id === credit.id : previous.id === undefined && previous.name === credit.name);
        const previous = credits[index];
        if (previous === undefined) credits.push(credit);
    }
    if (credits.length > 0) {
        const people = credits.slice(0, 24).map((credit) => creditCard(credit, context));
        content.push(el("h2", "browse-section-title", "Cast & Crew"), zoneNode("browse-row details-people", people));
        zones.push({ id: "people", layout: "row", items: people });
    }
    if (state !== undefined && (detail.type === "movie" || detail.type === "series")) {
        // Show YouTube cards the way tvOS does when the YouTube app can open.
        // Select cannot hand off or play them through AVPlay, so it stays on the card.
        const extras = trailerCards(detail.extras, detail.videos, true).map(card => trailerCard(card, context, state, play));
        if (extras.length > 0) {
            content.push(el("h2", "browse-section-title", "Trailers & More"), zoneNode("browse-row details-extras", extras));
            // TVTrailersRail is a focus section with user-initiated default focus
            // on the first card, so every entry lands there. Other rails keep
            // the last visited item.
            zones.push({ id: "extras", layout: "row", items: extras, entry: extras[0]?.key });
            if (state.extraPending !== undefined) content.push(...lines(["Loading extra…"]));
            if (state.extraFailed !== undefined) content.push(...lines(["Could not load extra. Select its card to retry."], "error"));
        }
    }
    if (state !== undefined) {
        // TVSimilarRail passes neither overlayData nor userState to TVMediaCard.
        const related = titleCards((state.related ?? []).map(card => ({ ...card, played: undefined })), { ...context, overlays: undefined, cardOverlays: () => undefined });
        if (!state.relatedFailed && (state.related === undefined || related.length > 0)) {
            const section = zoneNode("browse-row", related);
            section.setAttribute("data-detail-section", "related");
            content.push(el("h2", "browse-section-title", detail.type === "movie" ? "Related Movies" : "Recommended Series"));
            if (state.related === undefined) {
                content.push(...lines(["Loading related titles."]));
                for (let index = 0; index < 6; index++) { const placeholder = el("div", "details-related-placeholder"); placeholder.setAttribute("aria-hidden", "true"); section.append(placeholder); }
            } else zones.push({ id: "related", layout: "row", items: related });
            content.push(section);
        }
    }
    const facts: { label: string; value: string }[] = [];
    for (const [label, jobs] of [["DIRECTOR", ["director"]], ["WRITTEN BY", ["writer", "screenplay", "story"]]] as const) {
        const names = [...new Set(detail.extra?.crew.filter(credit => (jobs as readonly string[]).includes(credit.role.toLowerCase())).map(credit => credit.name))];
        if (names.length) facts.push({ label, value: names.slice(0, 3).join(", ") });
    }
    facts.push(...detail.extra?.facts ?? []);
    if (facts.length > 0) {
        const panel = el("div", "details-facts");
        panel.setAttribute("aria-label", "Details");
        panel.appendChild(el("h2", "browse-section-title", "Details"));
        const table = el("dl", "details-facts-table");
        for (const fact of facts) { const row = el("div", "details-fact-row"); row.append(el("dt", "", fact.label.toUpperCase()), el("dd", "", fact.value)); table.append(row); }
        table.tabIndex = -1; table.dataset.focus = "fact:0"; panel.append(table);
        const items = [{ key: "fact:0", element: table }];
        content.push(panel);
        zones.push({ id: "facts", layout: "column", items });
    }
    const first = actions[0] ?? seasonItems[0];
    const view: View = { name: `item:${detail.id}`, content, zones, focus: first === undefined ? undefined : { zone: actions[0] === undefined ? "seasons" : "actions", key: first.key }, back };
    if (state?.panel === "audio") {
        const options = [undefined, ...audio.map((_track, index) => index)].map(ordinal => {
            const item = actionButton(`audio:${ordinal ?? "auto"}`, ordinal === undefined ? "Auto" : audioTitle(ordinal), () => { if (tracks !== undefined) state.noteEpisodePreference(tracks.detail.id); tracks?.selectAudio(ordinal); if (tracks !== state) state.closePanel(); });
            item.element.setAttribute("role", "radio");
            item.element.setAttribute("aria-checked", String(ordinal === undefined ? selectedAudio === undefined : ordinal === (effectiveAudio >= 0 ? effectiveAudio : 0)));
            if (ordinal !== undefined) {
                const flags = [audioDetails(ordinal), audio[ordinal]?.isDefault ? "Default" : undefined, ordinal === file?.effectiveAudioTrackIndex ? "Preferred" : undefined].filter(Boolean).join(" · ");
                if (flags) item.element.append(el("small", "details-option-subtext", flags));
            }
            return item;
        });
        return detailPanel(view, state, "Audio", options);
    }
    if (state?.panel === "version") {
        const options = [undefined, ...playbackDetail.versions].map((version, index) => {
            const label = version?.label?.replace(/\bh264\b/gi, 'H.264').replace(/\bh265\b/gi, 'HEVC').replace(/\b(aac|eac3|ac3|hevc|av1|dts)\b/gi, codec => codec.toUpperCase());
            const item = actionButton(`version:${version?.fileId ?? "auto"}`, label || (version === undefined ? "Auto" : `Version ${index}`), () => { tracks?.select(version?.fileId); state.closePanel(); });
            if (version?.detailLabel) item.element.append(el("small", "details-option-subtext", version.detailLabel));
            item.element.setAttribute("role", "radio");
            item.element.setAttribute("aria-checked", String(version?.fileId === tracks?.selectedFileId));
            return item;
        });
        return detailPanel(view, state, "Version", options);
    }
    if (state?.panel === "subtitles") {
        const ordered = (file?.subtitles ?? []).map((track, index) => ({ track, index })).sort((a, b) => {
            const language = (track: SubtitleSignature): string => languageName(track.language) ?? '\uffff';
            const preferred = file?.effectiveSubtitle?.language;
            const preference = (track: SubtitleSignature): number => preferred !== undefined && language(track) === (languageName(preferred) ?? preferred) ? 0 : 1;
            const rank = (track: SubtitleSignature): number => ['srt|subrip', 'ass', 'ssa', 'vtt|webvtt', 'mov_text|movtext|tx3g', 'sup|pgs|hdmv', 'dvd|vobsub|dvb'].findIndex(pattern => new RegExp(pattern, 'i').test(track.codec ?? ''));
            const format = (track: SubtitleSignature): number => rank(track) < 0 ? 7 : rank(track);
            const variant = (track: SubtitleSignature): number => track.hearingImpaired || /\b(SDH|CC)\b/i.test(track.label ?? '') ? 2 : track.forced ? 1 : 0;
            return preference(a.track) - preference(b.track) || language(a.track).localeCompare(language(b.track)) || format(a.track) - format(b.track) || variant(a.track) - variant(b.track) || a.index - b.index;
        });
        const choices = [undefined, "off" as const, ...ordered.map(item => item.index)];
        const options = choices.map(choice => {
            const track = typeof choice === "number" ? file?.subtitles?.[choice] : undefined;
            const item = actionButton(`subtitle:${choice ?? "auto"}`, track === undefined ? choice === "off" ? "Off" : "Auto" : languageName(track.language) ?? track.label ?? `Track ${Number(choice) + 1}`, () => { if (tracks !== undefined) state.noteEpisodePreference(tracks.detail.id); tracks?.selectSubtitle(choice); if (tracks !== state) state.closePanel(); });
            if (track !== undefined) {
                const codec = /subrip|srt/i.test(track.codec ?? '') ? 'SRT' : track.codec?.toUpperCase();
                const label = track.label && ![track.codec?.toUpperCase(), codec, languageName(track.language)?.toUpperCase(), 'SDH', 'CC'].includes(track.label.toUpperCase()) ? track.label : undefined;
                const variant = /\bCC\b/i.test(track.label ?? '') ? 'CC' : track.hearingImpaired || /\bSDH\b/i.test(track.label ?? '') ? 'SDH' : undefined;
                item.element.append(el('small', 'details-option-subtext', [label, codec, track.forced ? 'Forced' : undefined, variant, track.source === 'external' ? 'External' : undefined].filter(Boolean).join(' · ')));
            }
            item.element.setAttribute("role", "radio");
            item.element.setAttribute("aria-checked", String(track === undefined ? subtitle?.kind === (choice === "off" ? "off" : "auto") : subtitle?.kind === "track" && matchesSubtitle(track, subtitle.signature)));
            if (choice === "off") item.element.append(el("small", "details-option-subtext", "Start without subtitles"));
            return item;
        });
        return detailPanel(view, state, "Subtitles", options);
    }
    if (state?.panel === "more") {
        const menuNotes = [...personal?.notes ?? []];
        const items = personal?.items.filter(item => item.key !== "watchlist") ?? [];
        items.sort((a, b) => Number(b.key === "favorites") - Number(a.key === "favorites"));
        for (const item of items) {
            const value = state.values.get(item.key as "favorites" | "watched");
            const change = state.changes.get(item.key as "favorites" | "watched");
            if (value !== undefined && !change?.pending && !change?.failed) {
                item.element.textContent = item.key === "favorites" ? value ? "Remove from Favorites" : "Add to Favorites"
                    : detail.type === "series" ? value ? "Mark Series Unwatched" : "Mark Series Watched"
                    : detail.type === "season" ? value ? "Mark Season Unwatched" : "Mark Season Watched"
                    : value ? "Mark as Unwatched" : "Mark as Watched";
            }
            item.element.addEventListener("click", () => { if (!state.busy) state.closePanel(); }, { capture: true });
        }
        const seasonState = state.series?.seasonNumber === undefined ? undefined : state.seasonStates.get(state.series.seasonNumber);
        if (seasonState !== undefined) {
            const value = seasonState.values.get("watched");
            const change = seasonState.changes.get("watched");
            if (value !== undefined) {
                const item = actionButton("season-watched", change?.pending ? "Updating season…" : change?.failed ? "Retry season watched" : value ? "Mark Season Unwatched" : "Mark Season Watched", () => {
                    if (state.busy) return;
                    state.closePanel();
                    seasonState.change("watched", change?.failed ? change.target : !value, change?.failed);
                });
                item.element.setAttribute("aria-disabled", String(state.busy));
                items.push(item);
                if (change?.failed) menuNotes.push(...lines(["Could not update season watched."], "error"));
            }
        }
        if (detail.type === "series" && state.focusedEpisodeId !== undefined) items.unshift(actionButton("series-overview", "Show Series Info", () => state.showSeriesOverview()));
        if (detail.type === "series" && state.shuffleSupported && seasons.reduce((count, season) => count + season.episodeCount, 0) >= 2) {
            const shuffle = actionButton("shuffle-series", state.shuffleStarting ? "Starting shuffle…" : "Shuffle Series", () => state.startShuffle(play));
            shuffle.element.setAttribute("aria-disabled", String(state.shuffleStarting));
            items.unshift(shuffle);
            if (state.shuffleFailed) menuNotes.push(...lines(["Couldn't start the shuffle. Try again."], "error"));
        }
        if (state.descriptions?.offers() === true) items.push(actionButton("translate-description", TRANSLATE_DESCRIPTION_LABEL, () => { state.descriptions?.translate(); state.closePanel(); }));
        return detailPanel(view, state, "More", items.length ? items : [actionButton("close-more", "Close", () => state.closePanel())], menuNotes);
    }
    return view;
}

function trailerCard(card: TrailerCard, context: ViewContext, state: DetailsState, play: (request: PlayRequest) => void): FocusItem {
    let title = card.title;
    let key = card.id;
    switch (card.role) {
        case "local":
            title = state.extraPending === card.extra.contentId ? "Loading extra…" : state.extraFailed === card.extra.contentId ? `Retry ${card.title}` : card.title;
            key = `extra:${card.extra.contentId}`;
            break;
        case "remote":
            break;
        default: {
            const unexpected: never = card;
            return unexpected;
        }
    }
    const local = card.role === "local" ? card.extra : undefined;
    const element = el("button", "browse-card details-extra");
    element.type = "button";
    element.tabIndex = -1;
    element.dataset.focus = key;
    const still = artwork("browse-art browse-still", card.stillUrl, context.baseUrl, filmMark());
    still.append(playMark());
    element.append(still, el("span", "browse-card-title", title));
    const pending = card.role === "local" && (state.extraPending === card.extra.contentId || state.extraFailed === card.extra.contentId);
    if (card.caption !== undefined && !pending) element.append(el("span", "browse-card-subtitle", card.caption));
    if (local !== undefined) {
        element.setAttribute("aria-disabled", String(state.extraPending !== undefined));
        element.addEventListener("click", () => state.playExtra(local, play));
    }
    return { key, element };
}

/** Stand-in for SF Symbol film at 48pt, used when a local extra has no still. */
function filmMark(): SVGSVGElement {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 48 48");
    icon.setAttribute("width", "48");
    icon.setAttribute("height", "48");
    icon.setAttribute("aria-hidden", "true");
    const frame = document.createElementNS(icon.namespaceURI, "rect");
    frame.setAttribute("x", "6");
    frame.setAttribute("y", "10");
    frame.setAttribute("width", "36");
    frame.setAttribute("height", "28");
    frame.setAttribute("rx", "3");
    frame.setAttribute("fill", "none");
    frame.setAttribute("stroke", "currentColor");
    frame.setAttribute("stroke-width", "2");
    icon.append(frame);
    return icon;
}

/** The existing Play glyph, drawn at the trailer's 24pt play.fill size. */
function playMark(): HTMLElement {
    const badge = el("span", "details-extra-play");
    badge.setAttribute("aria-hidden", "true");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const shape = document.createElementNS(icon.namespaceURI, "path");
    shape.setAttribute("d", "M8 4 21 12 8 20Z");
    shape.setAttribute("fill", "#fff");
    icon.appendChild(shape);
    badge.appendChild(icon);
    return badge;
}

export function personalControls(state: DetailsState): { items: FocusItem[]; notes: HTMLElement[] } {
    const items: FocusItem[] = [];
    const notes: HTMLElement[] = [];
    for (const kind of ["watched", "favorites", "watchlist"] as const) {
        const value = state.values.get(kind);
        if (value === undefined) continue;
        const change = state.changes.get(kind);
        const label = kind === "watched" ? `${state.detail.type === "series" || state.detail.type === "season" ? "Mark all" : "Mark"} ${value ? "unwatched" : "watched"}` : kind === "watchlist" ? value ? "Remove from watchlist" : "Add to watchlist" : value ? "Remove favorite" : "Add favorite";
        const item = actionButton(kind, change?.pending ? `Updating ${kind}…` : change?.failed ? `Retry ${kind}` : label, () => state.change(kind, change?.failed ? change.target : !value, change?.failed));
        item.element.setAttribute("aria-pressed", String(value));
        item.element.setAttribute("aria-disabled", String(state.busy));
        items.push(item);
        if (change?.failed) notes.push(...lines([`Could not update ${kind}.`], "error"));
    }
    if (state.personalFailed) items.push(actionButton("retry-personal", "Retry personal actions", () => { if (!state.busy) state.loadPersonal(); }));
    if (state.personalSupported === undefined) notes.push(...lines([state.personalFailed ? "Could not load personal actions." : "Loading personal actions."], state.personalFailed ? "error" : "info"));
    return { items, notes };
}

function creditCard(credit: Credit, context: ViewContext): FocusItem {
    const key = credit.id ? `person:${credit.id}` : `credit:${credit.name}:${credit.role}`;
    // A credit without a server person_id has facts, but no invented person route.
    const element = el(credit.id ? "button" : "div", "browse-card details-person");
    element.setAttribute("data-focus", key);
    element.tabIndex = -1;
    const id = credit.id;
    if (id) element.addEventListener("click", () => context.open({ kind: "person", id, title: credit.name }));
    element.appendChild(artwork("browse-art details-photo", credit.photoUrl, context.baseUrl, credit.name));
    element.appendChild(el("span", "browse-card-title", credit.name));
    element.appendChild(el("span", "browse-card-subtitle", credit.role));
    return { key, element };
}

function titleCards(cards: readonly Card[], context: ViewContext): FocusItem[] {
    const items: FocusItem[] = [];
    for (const card of cards.slice(0, 24)) {
        const { preview: _preview, ...titlesContext } = context;
        const item = cardItem(card, titlesContext);
        if (item !== undefined) items.push(item);
    }
    return items;
}

export function personHero(person: Person, baseUrl: string, metadataLoading = false): HTMLElement {
    const hero = el("div", "browse-detail details-person-hero");
    hero.appendChild(personPortrait(person, baseUrl));
    const info = el("div", "browse-detail-info");
    info.appendChild(heading(person.name));
    const facts = personMetadataBadges(person, new Date());
    if (facts.length > 0 || metadataLoading) {
        const row = el("div", "person-facts");
        for (const fact of facts) row.appendChild(el("span", "person-fact", fact));
        if (metadataLoading) {
            const loading = el("span", "person-fact person-metadata-loading", "Loading metadata");
            loading.setAttribute("role", "status");
            row.appendChild(loading);
        }
        info.appendChild(row);
    }
    if (person.bio) info.appendChild(el("p", "browse-text browse-overview", person.bio));
    hero.appendChild(info);
    return hero;
}

function seasonItem(seriesId: string, seriesTitle: string, season: Season, context: ViewContext): FocusItem {
    const key = `season:${season.seasonNumber}`;
    const element = el("button", "browse-card");
    element.type = "button";
    element.setAttribute("data-focus", key);
    element.appendChild(artwork("browse-art", season.posterUrl, context.baseUrl, season.title));
    element.appendChild(el("span", "browse-card-title", season.title));
    element.appendChild(el("span", "browse-card-subtitle", season.episodeCount === 1 ? "1 episode" : `${season.episodeCount} episodes`));
    element.addEventListener("click", () => context.open({ kind: "season", id: season.id, seriesId, seasonNumber: season.seasonNumber, title: `${seriesTitle} · ${season.title}` }));
    return mediaItem({ key, element }, { id: season.id, title: season.title, type: "season" }, context);
}

export function seasonView(name: string, title: string, episodes: readonly Episode[], context: ViewContext, back: () => void, play: (request: PlayRequest) => void, detail?: ItemDetail, state?: DetailsState): View {
    const items = episodes.map((episode): FocusItem => {
        const element = el("button", "browse-episode");
        element.type = "button";
        element.setAttribute("data-focus", episode.id);
        element.appendChild(artwork("browse-art browse-still", episode.stillUrl, context.baseUrl, episode.title));
        const info = el("span", "browse-episode-info");
        info.appendChild(el("span", "browse-card-title", `${episode.episodeNumber}. ${episode.title}`));
        const runtime = episode.runtimeMinutes > 0 ? `${episode.runtimeMinutes} min` : "";
        info.appendChild(el("span", "browse-card-subtitle", runtime));
        if (episode.played) {
            const badge = el("span", "browse-watched");
            badge.appendChild(el("span", "silo-sr-only", "Watched"));
            element.firstElementChild?.appendChild(badge);
        }
        element.appendChild(info);
        element.addEventListener("click", () => context.playEpisode === undefined ? context.open({ kind: "item", id: episode.id, title: episode.title }) : context.playEpisode(episode.id, episode.title));
        return mediaItem({ key: episode.id, element }, { id: episode.id, title: episode.title, type: "episode" }, context);
    });
    const header = detail === undefined ? undefined : itemView(detail, [], context, play, back, state);
    const heroEnd = (header?.content.findIndex(node => node.classList.contains("details-hero")) ?? -1) + 1;
    const content = [...(header?.content.slice(0, heroEnd) ?? [heading(title)]), ...(items.length === 0 ? lines(["This season has no episodes yet."]) : []), zoneNode("browse-episodes", items), ...header?.content.slice(heroEnd) ?? []];
    const fallback = items.length === 0 ? [actionButton("back", "Back", back)] : [];
    if (fallback.length > 0) {
        content.push(zoneNode("browse-actions", fallback));
    }
    if (header !== undefined && state?.panel !== undefined) {
        for (const node of content) if (!node.matches(".skyline-selector, .skyline-dropdown-scrim")) { node.inert = true; node.setAttribute("aria-hidden", "true"); }
        return { ...header, content };
    }
    const zones: Zone[] = [
        { id: "episodes", layout: "column", items },
        { id: "status", layout: "row", items: fallback },
    ];
    const first = items[0] ?? fallback[0];
    return { name, content, zones: [...header?.zones.filter((zone) => zone.id === "actions") ?? [], ...zones, ...header?.zones.filter((zone) => zone.id !== "actions") ?? []], focus: first === undefined ? undefined : { zone: items[0] === undefined ? "status" : "episodes", key: first.key }, back };
}
