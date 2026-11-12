// DOM for item pages (movie, series, episode) and a season's episode list.

import type { Episode, ItemDetail, Season } from "../contracts/v2/catalog.ts";
import type { Credit, Person } from "../contracts/v2/details.ts";
import type { Card } from "../contracts/v2/catalog.ts";
import type { Destination } from "./browseModel.ts";
import type { DetailsState } from "./detailsState.ts";
import { TRANSLATE_DESCRIPTION_LABEL, type DescriptionTranslationStatus } from "./descriptionTranslation.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { artworkUrl, clockTime, episodeLabel, playChoices, seriesPlayback, withStartAudioLanguage, type PlayRequest } from "./browseModel.ts";
import { trailerCards, type TrailerCard } from "./trailerRail.ts";
import { actionButton, artwork, cardItem, heading, lines, mediaItem, type ViewContext, zoneNode } from "./browseViews.ts";
import { boxSetMovieRow, type BoxSetRowState } from "./boxSetRow.ts";
import { blurEpisodeStill, episodeDetailPresentation, hidesEpisodeListStill } from "./episodeSpoilers.ts";
import { personMetadataBadges, personPortrait } from "./personHero.ts";
import { el } from "./screen.ts";
import { detailAction, detailPanel } from "./detailsActions.ts";
import { initialSubtitle, matchesSubtitle } from "../player/preplaySubtitles.ts";
import { audioTitle as trackAudioTitle } from "../player/trackLabels.ts";
import type { SubtitleSignature } from "../contracts/v2/preplaySubtitles.ts";
import { seriesEpisodesView } from "./seriesEpisodesView.ts";
import { languageName } from "./cardOverlays.ts";
import { heroBackdrop, type Tints } from "./heroBackdrop.ts";
import { episodeAirDate, episodeRuntime } from "./episodeCaption.ts";
import { TMDB_LOGO_PATH } from "./acknowledgements.ts";
import { spinner } from "./marquee.ts";
import { defaultArtwork } from "./defaultArtwork.ts";
import { centredDialog } from "./confirmationDialog.ts";
import { choiceFromDetail } from "./watchPartyChoice.ts";

export const detailPalette = new Map<string, Tints>();
/** TVDecodedLogoTitle's easeInOut(duration: 0.2). */
const LOGO_CROSSFADE_MS = 200;
/** Logo URLs that have decoded on a visible Details page. Later paints of the same visit seed that image, as TVDecodedLogoTitle does from the pipeline cache (silo-apple e28300c61f044a9322f588203c8819d6f06e6197, TVDetailHero.swift). */
const decodedTitleLogos = new Set<string>();

/** OverlayData.advisoryAgeBadgeLabel at silo-apple e28300c6. */
function advisoryAgeBadgeLabel(age: number | undefined, source: string | undefined): string | undefined {
    if (age === undefined || age <= 0) return undefined;
    const named = source?.toLowerCase() === "commonsense" ? "Common Sense" : source?.toLowerCase() === "mdblist" ? "MDBList" : undefined;
    return [named, `${age}+`].filter(part => part !== undefined).join(" ");
}

function runtimeToken(minutes: number): string {
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

/** TVHeroMetadata fact tokens. Series omits runtime; an episode uses its air date. */
function factTokens(detail: ItemDetail, state: DetailsState | undefined, episode: Episode | undefined): string[] {
    if (episode !== undefined) {
        const playback = state?.nextEpisodeState;
        const selectedFile = playback?.detail.versions.find(file => file.fileId === playChoices(playback.detail, playback.selectedFileId, playback.preferredQuality)?.fromStart.fileId);
        const minutes = selectedFile?.durationSeconds ? Math.round(selectedFile.durationSeconds / 60) : episode.runtimeMinutes;
        return [episodeAirDate(episode.airDate), episodeRuntime(minutes)].filter((token): token is string => token !== undefined);
    }
    const tokens: string[] = [];
    if (detail.type === "episode") {
        const aired = episodeAirDate(detail.airDate);
        if (aired !== undefined) tokens.push(aired);
    } else if (detail.year !== undefined && detail.year > 0) tokens.push(String(detail.year));
    if (detail.type !== "series" && detail.runtimeMinutes !== undefined && detail.runtimeMinutes > 0) {
        const file = detail.versions.find(version => version.fileId === playChoices(detail, state?.selectedFileId, state?.preferredQuality)?.fromStart.fileId);
        const minutes = file?.durationSeconds ? Math.round(file.durationSeconds / 60) : detail.runtimeMinutes;
        tokens.push(runtimeToken(minutes));
    }
    const count = state?.series?.seasons.filter(season => !season.isSpecials && season.seasonNumber !== 0).length;
    if (detail.type === "series" && count) tokens.push(`${count} Season${count === 1 ? "" : "s"}`);
    return tokens;
}

/** Genres are one source token. A focused series episode splits season and episode. */
function sourceTokens(detail: ItemDetail, episode: Episode | undefined): string[] {
    if (episode !== undefined) return [episode.seasonNumber === 0 ? "Specials" : `Season ${episode.seasonNumber}`, `Episode ${episode.episodeNumber}`];
    if (detail.type === "episode") {
        const season = detail.seasonNumber === undefined ? undefined : detail.seasonNumber === 0 ? "Specials" : `Season ${detail.seasonNumber}`;
        const number = detail.episodeNumber !== undefined && detail.episodeNumber > 0 ? `Episode ${detail.episodeNumber}` : undefined;
        if (season !== undefined && number !== undefined) return [`${season} \u00B7 ${number}`];
        return [season, number].filter((token): token is string => token !== undefined);
    }
    return detail.genres.length === 0 ? [] : [detail.genres.slice(0, 2).join(", ")];
}

function metadataRow(detail: ItemDetail, state: DetailsState | undefined, episode: Episode | undefined): HTMLElement | undefined {
    const chips: { text: string; advisory: boolean }[] = [];
    const ratingChip = detail.contentRating?.trim();
    if (ratingChip) chips.push({ text: ratingChip, advisory: false });
    if (state?.showAdvisoryAge) {
        const advisory = advisoryAgeBadgeLabel(detail.advisoryAge, detail.advisorySource);
        if (advisory !== undefined) chips.push({ text: advisory, advisory: true });
    }
    const facts = factTokens(detail, state, episode);
    const ratings = (episode === undefined ? detail.extra?.ratings : state?.nextEpisodeState?.detail.extra?.ratings) ?? [];
    const sources = sourceTokens(detail, episode);
    if (chips.length === 0 && facts.length === 0 && ratings.length === 0 && sources.length === 0) return undefined;
    const row = el("p", "browse-meta");
    for (const chip of chips) {
        const badge = el("span", "details-rating-badge", chip.text);
        if (chip.advisory) badge.dataset.advisoryAge = chip.text;
        row.append(badge);
    }
    for (const fact of facts) row.append(el("span", "details-fact", fact));
    for (const rating of ratings) {
        const badge = el("span", "details-external-rating");
        badge.setAttribute("aria-label", `${rating.name} ${rating.display}`);
        if (rating.name.toUpperCase() === "TMDB") {
            const logo = el("img", "skyline-rating-logo");
            logo.src = TMDB_LOGO_PATH;
            logo.alt = "TMDB";
            // The logo has no width until it loads, so the row is measured again then.
            logo.addEventListener("load", () => fitRatings(row));
            badge.append(logo);
        } else badge.append(el("span", "", rating.name));
        badge.append(el("span", "details-rating-score", rating.display));
        row.append(badge);
    }
    const namedGenres = episode === undefined && detail.type !== "episode";
    for (const source of sources) row.append(el("span", namedGenres ? "details-genres" : "details-source", source));
    return row;
}

function overviewText(overview: string, status: DescriptionTranslationStatus | undefined): HTMLElement {
    const text = el("p", "browse-text browse-overview", overview);
    if (status !== undefined) text.classList.add("has-translation-status");
    if (status?.kind === "translating") text.classList.add("is-translating");
    return text;
}

function translationStatus(status: DescriptionTranslationStatus): HTMLElement {
    const line = el("p", "description-translation-status");
    line.dataset.translationStatus = status.kind;
    // SF Symbol "translate", drawn as the More menu's Translate Description icon.
    line.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2 5H14M8 2V5M5 5C5 11 10 14 14 15M12 5C12 11 7 14 3 15M13 22 18 10 23 22M15 18H21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    line.append(el("span", "", status.text));
    return line;
}

/** TVHeroTitle.split: the first of ": ", " — ", " – " or " - " whose trimmed halves are both non-empty. */
export function titleParts(raw: string): { primary: string; subtitle: string | undefined } {
    for (const separator of [": ", " \u2014 ", " \u2013 ", " - "]) {
        const at = raw.indexOf(separator);
        if (at < 0) continue;
        const head = raw.slice(0, at).trim(), tail = raw.slice(at + separator.length).trim();
        if (head !== "" && tail !== "") return { primary: head, subtitle: tail };
    }
    return { primary: raw, subtitle: undefined };
}

/**
 * TVDecodedLogoTitle: the text title stays until the logo has decoded, then the logo cross-fades in over 0.2 s.
 * A logo already decoded this visit, or Reduce Motion, swaps at once.
 */
export function decodedLogoTitle(holder: HTMLElement, logo: string | undefined, alt: string, allowed: () => boolean, showText: () => void, logoClass: string): void {
    showText();
    if (logo === undefined || !allowed()) return;
    const image = el("img", logoClass);
    image.alt = alt;
    image.referrerPolicy = "no-referrer";
    const cached = decodedTitleLogos.has(logo);
    image.addEventListener("load", () => {
        if (!allowed() || !holder.isConnected || holder.closest("[hidden]") !== null) return;
        decodedTitleLogos.add(logo);
        if (image.parentElement === holder) return;
        const outgoing = Array.from(holder.childNodes);
        holder.replaceChildren(image);
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        image.classList.add("details-logo-enter");
        const exit = el("span", "details-title-exit");
        exit.setAttribute("aria-hidden", "true");
        exit.append(...outgoing);
        holder.append(exit);
        setTimeout(() => exit.remove(), LOGO_CROSSFADE_MS);
    });
    image.addEventListener("error", () => {
        if (image.parentElement !== holder) return;
        decodedTitleLogos.delete(logo);
        showText();
    });
    image.src = logo;
    // A logo that already decoded this visit is in the title before the repaint connects, so the text fallback does not paint again.
    if (cached) holder.replaceChildren(image);
}

/** TVPlaybackSelectionSummaryView: a long value tightens, then shrinks to 0.75 of its size before it truncates. */
const READOUT_MIN_SCALE = 0.75;
function fitReadout(readout: HTMLElement): void {
    for (const value of Array.from(readout.querySelectorAll<HTMLElement>("span"))) {
        if (value.textContent === "" || value.scrollWidth <= value.clientWidth) continue;
        const size = parseFloat(getComputedStyle(value).fontSize);
        value.style.letterSpacing = "-0.5px";
        if (value.scrollWidth <= value.clientWidth) continue;
        value.style.fontSize = `${size * Math.max(READOUT_MIN_SCALE, value.clientWidth / value.scrollWidth)}px`;
    }
}

/** TVDetailHero factsRow's ViewThatFits: whole ratings drop from the end once genres have given way. */
function fitRatings(row: HTMLElement): void {
    while (row.scrollWidth > row.clientWidth + 0.5) {
        const last = Array.from(row.querySelectorAll(".details-external-rating")).at(-1);
        if (last === undefined) return;
        last.remove();
    }
}

function detailHeader(detail: ItemDetail, context: ViewContext, actions: readonly FocusItem[], state?: DetailsState, summary?: string, showsSummary = true): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    const label = episodeLabel(detail.seasonNumber, detail.episodeNumber);
    if (detail.type === "episode" && (detail.seriesTitle !== undefined || label !== undefined)) {
        nodes.push(el("p", "browse-kicker", [detail.seriesTitle, label].filter((part) => part !== undefined).join(" · ")));
    }
    const title = heading(detail.title);
    title.classList.add("requests-detail-title");
    const parts = titleParts(detail.title);
    const primary = el("span", "requests-title-primary", parts.primary);
    const secondary = parts.subtitle === undefined ? undefined : el("span", "requests-title-secondary", parts.subtitle);
    const showText = (): void => {
        title.replaceChildren(primary);
        if (secondary !== undefined) title.appendChild(secondary);
    };
    const allowed = state?.titleArtGuard();
    decodedLogoTitle(title, artworkUrl(detail.extra?.logoUrl, context.baseUrl), detail.title, () => allowed?.() ?? false, showText, "details-logo");
    nodes.push(title);
    const episode = state?.series?.episodes?.find(item => item.id === state.heroEpisodeId);
    const playback = state?.nextEpisodeState;
    const row = metadataRow(detail, state, episode);
    if (row !== undefined) nodes.push(row);
    const presentation = episodeDetailPresentation(detail, context.spoilers?.() ?? { hidesImages: false, hidesOverviews: false }, state?.values.get("watched"));
    const episodeOverview = episode === undefined ? undefined : episodeDetailPresentation({ type: "episode", overview: episode.overview || playback?.detail.overview, watch: { played: episode.played, isInProgress: episode.isInProgress, positionSeconds: episode.positionSeconds } }, context.spoilers?.() ?? { hidesImages: false, hidesOverviews: false }).overview;
    const overview = episode === undefined ? presentation.overview : [playback?.detail.title ?? episode.title, episodeOverview].filter(Boolean).join(" · ");
    const translation = state?.descriptions?.status(episode, playback?.detail);
    if (overview !== undefined && overview !== "") {
        nodes.push(overviewText(overview, translation));
        if (translation !== undefined) nodes.push(translationStatus(translation));
    }
    const directors = detail.extra?.crew.filter(credit => credit.role.toLowerCase() === "director").map(credit => credit.name);
    const credit = detail.type === "movie" ? directors?.length ? `Directed by ${directors.slice(0, 2).join(", ")}` : undefined : detail.extra?.cast.length ? `Starring ${detail.extra.cast.slice(0, 3).map(person => person.name).join(", ")}` : undefined;
    if (credit !== undefined) nodes.push(el("p", "details-director", credit));
    // TVPlaybackSelectionSummaryView always keeps its labels; a value it does not know yet is a quiet bar.
    const readout = el("div", "details-playback-summary");
    const values = new Map((summary?.split(" | ") ?? []).map(part => [part.slice(0, part.indexOf(": ")), part.slice(part.indexOf(": ") + 2)] as const));
    for (const label of ["Version", "Audio", "Subtitles"]) {
        const field = el("div", ""); field.dataset.trackSummary = label.toLowerCase();
        field.append(el("strong", "", label.toUpperCase()), el("span", "", values.get(label) ?? ""));
        readout.appendChild(field);
    }
    if (!showsSummary) { readout.style.opacity = "0"; readout.setAttribute("aria-hidden", "true"); }
    nodes.push(readout);
    // FocusHost places the view synchronously, so both are laid out by the next microtask.
    queueMicrotask(() => {
        if (row !== undefined) fitRatings(row);
        fitReadout(readout);
    });
    const layout = el("div", "details-hero");
    layout.dataset.mediaType = detail.type;
    // TVDetailHero draws only the backdrop. Without one the page keeps TVDetailPageSurface's fallback tint.
    const backdrop = artworkUrl(detail.backdropUrl, context.baseUrl);
    const background = heroBackdrop(backdrop ?? "", detail.backdropThumbhash, detailPalette, true, true);
    // Without a backdrop there is no frame, and nothing to blur.
    const frame = background.querySelector<HTMLElement>(".skyline-art-frame");
    if (presentation.hideBackdrop && frame !== null) blurEpisodeStill(frame);
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
        disclosure.append(nodes.find(node => node.matches(".details-director")) ?? el("div", "details-director"), readout);
        editorial.append(primary, disclosure);
        info.appendChild(editorial);
    } else info.append(...nodes);
    info.appendChild(zoneNode("browse-actions", actions));
    // TVMovieDetailView.actionColumn: a movie's pill sits under the action row. A series draws it in the episode block.
    const status = detail.type === "series" ? undefined : trailerStatus(state);
    if (status !== undefined) info.append(status);
    layout.appendChild(info);
    return [wash, layout];
}

function trailerStatus(state: DetailsState | undefined): HTMLElement | undefined {
    if (state?.trailers.message === undefined) return undefined;
    const status = el("p", "details-trailer-status", state.trailers.message);
    status.setAttribute("role", "status");
    status.setAttribute("aria-busy", String(state.trailers.fetching));
    const indicator = state.trailers.fetching ? spinner() : el("span", "", "ⓘ");
    indicator.setAttribute("aria-hidden", "true");
    status.prepend(indicator);
    return status;
}

export function itemView(detail: ItemDetail, seasons: readonly Season[], context: ViewContext, play: (request: PlayRequest) => void, back: () => void, state?: DetailsState, boxSet?: BoxSetRowState): View {
    detail = state === undefined ? detail : { ...detail, versions: state.detail.versions };
    const tracks = state?.nextEpisodeState ?? state;
    const playbackDetail = tracks?.detail ?? detail;
    const playbackChoices = playChoices(playbackDetail, tracks?.selectedFileId, tracks?.preferredQuality);
    const preferences = state?.unsettledEpisode ?? tracks;
    const actions: FocusItem[] = [];
    const notes: string[] = [];
    if (preferences?.audioPreference.pending) notes.push("Saving audio preference…");
    if (preferences?.subtitlePreference.pending) notes.push("Saving subtitle preference…");
    if (preferences?.subtitlePreference.failed) notes.push("Subtitle preference could not be confirmed.");
    if (preferences?.audioPreference.failed) notes.push("Could not confirm the audio preference. Check before playing.");
    // Apple's row has no preference-check buttons, so Play re-sends an unconfirmed save before it plays.
    const retriedPreference = (): boolean => {
        if (state === undefined || preferences === undefined) return false;
        const failed = (["subtitles", "audio"] as const).filter(kind => (kind === "audio" ? preferences.audioPreference : preferences.subtitlePreference).failed);
        for (const kind of failed) state.retryPreference(kind, preferences);
        return failed.length > 0;
    };
    const savePending = [preferences, tracks].some(owner => owner?.audioPreference.pending === true || owner?.subtitlePreference.pending === true);
    // deferPlay keeps a press that raced a shared preference save; Play starts it once the save confirms.
    if (tracks?.failedPlay !== undefined && !savePending) notes.push("Press Play again to start playback.");
    const choices = playChoices(detail, state?.selectedFileId, state?.preferredQuality);
    const choose = (request: PlayRequest): void => {
        if (retriedPreference()) return;
        const audioTrackId = state?.audioTrackId(true);
        const next = { ...request, ...(audioTrackId === undefined ? {} : { audioTrackId }), ...(state === undefined ? {} : { subtitle: state.subtitleIntent() }) };
        play(withStartAudioLanguage(next, detail.versions.find(file => file.fileId === next.fileId)));
    };
    if (choices?.resume !== undefined) {
        const resume = choices.resume;
        actions.push(actionButton("resume", `Resume ${clockTime(resume.startSeconds ?? 0)}`, () => choose(resume)));
        actions.push(actionButton("play", "Start Over", () => choose(choices.fromStart)));
    } else if (choices !== undefined) {
        actions.push(actionButton("play", "Play", () => choose(choices.fromStart)));
    } else if (detail.type === "movie" || detail.type === "episode") {
        // Apple keeps Play in the row; with no file to hand AVPlay it stays disabled beside this note.
        const play = actionButton("play", "Play", () => undefined);
        play.element.setAttribute("aria-disabled", "true");
        actions.push(play);
        notes.push("This title has no file this TV can play.");
    }
    const next = state?.series === undefined ? state?.playbackTargetId ?? detail.playContentId : state.playbackTargetId;
    if ((detail.type === "series" || detail.type === "season") && next !== undefined) {
        const target = state?.nextEpisode;
        const targetChoices = playbackChoices;
        const summary = state?.series?.railEpisodes?.find(episode => episode.id === next);
        const playNext = (startOver = false): void => {
            if (retriedPreference() || state?.episodePreferencesBlocked) return;
            if (target === undefined) { context.playEpisode?.(next, summary?.title ?? detail.title, startOver); return; }
            if (targetChoices === undefined) return;
            const audioTrackId = tracks?.audioTrackId(true);
            const request = { ...(targetChoices.resume ?? targetChoices.fromStart), startSeconds: startOver ? 0 : targetChoices.resume?.startSeconds, ...(audioTrackId === undefined ? {} : { audioTrackId }), ...(tracks === undefined ? {} : { subtitle: tracks.subtitleIntent() }) };
            play(withStartAudioLanguage(seriesPlayback(request, detail, summary), target.versions.find(file => file.fileId === request.fileId)));
        };
        const labelTarget = summary ?? target;
        const canResume = targetChoices?.resume !== undefined || target === undefined && summary?.inProgress === true;
        const failed = state?.nextEpisodeFailed === true;
        // TVDetailActionRow: "Loading episodes…" while the list loads, else "Play" with no episode to name.
        const label = labelTarget === undefined ? failed ? "Play" : "Loading episodes…" : `${canResume ? "Resume" : "Play"} ${episodeLabel(labelTarget.seasonNumber, labelTarget.episodeNumber) ?? labelTarget.title}`;
        // A failed episode read still plays through the episode route, which loads its own detail.
        const primary = actionButton("next-episode", label, () => { if (primary.element.getAttribute("aria-disabled") !== "true") playNext(); });
        // After a failed read, Play still knows the episode id, so it plays through the episode route.
        const unplayable = labelTarget === undefined && !failed || targetChoices === undefined && (state?.offline === true || target !== undefined);
        primary.element.setAttribute("aria-disabled", String(savePending || unplayable));
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
    const series = state?.series === undefined ? undefined : seriesEpisodesView(state.series, seriesContext, id => state.focusEpisode(id), next, id => state.blurEpisode(id));
    const seasonItems = series?.zones[0]?.items ?? (detail.type === "series" ? seasons.map((season) => seasonItem(detail.id, detail.title, season, context)) : []);
    const overview = episodeDetailPresentation(detail, context.spoilers?.() ?? { hidesImages: false, hidesOverviews: false }, state?.values.get("watched")).overview;
    const file = playbackDetail.versions.find(file => file.fileId === playbackChoices?.fromStart.fileId);
    const compactVersion = file?.compactLabel ?? "Auto";
    const versionValue = tracks?.selectedFileId === undefined && compactVersion !== "Auto" ? `Auto · ${compactVersion}` : compactVersion;
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
    const autoSubtitle = file?.effectiveSubtitle === undefined ? undefined : initialSubtitle({ kind: "auto" }, (file.subtitles ?? []).map((track, index) => ({ ...track, trackId: String(index), combinedIndex: index, delivery: "unknown" as const, url: undefined, streamIndex: undefined, containerTrackId: undefined, nativeSelectable: undefined, hlsRendition: undefined })), { ...file.effectiveSubtitle, audioLanguage: resolvedAudioTrack?.language });
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
    // TrackLabels.name: the language leads the popover row; a track's own title moves to its detail line.
    const audioRowTitle = (index: number): string => languageName(audio[index]?.language) ?? trackAudioTitle(audio[index]?.title, audio[index]?.language) ?? `Track ${index + 1}`;
    const audioLabel = (index: number): string => [languageName(audio[index]?.language), audioDetails(index)].filter(Boolean).join(' · ') || audioTitle(index);
    // TVPlaybackActionSelectors stay mounted and disable until a version is known.
    if (state !== undefined) {
        const ordinal = audio.findIndex((_track, index) => selectedAudio === `file:${file?.fileId}:audio:${index}`);
        const version = actionButton("version", `Version: ${versionValue}`, () => state.showPanel("version"));
        version.element.setAttribute("aria-disabled", String(playbackChoices === undefined || playbackDetail.versions.length === 0));
        version.element.setAttribute("aria-haspopup", "dialog");
        actions.push(version);
        const trigger = actionButton("audio", `Audio: ${ordinal === -1 ? "Auto" : audioLabel(ordinal)}`, () => state.showPanel("audio"));
        trigger.element.setAttribute("aria-disabled", String(playbackChoices === undefined || audio.length === 0));
        trigger.element.setAttribute("aria-haspopup", "dialog");
        trigger.element.setAttribute("aria-expanded", String(state.audioOpen));
        actions.push(trigger);
        const subtitles = actionButton("subtitles", `Subtitles: ${selectedSubtitleLabel}`, () => state.showPanel("subtitles"));
        subtitles.element.setAttribute("aria-disabled", String(playbackChoices === undefined));
        subtitles.element.setAttribute("aria-haspopup", "dialog");
        subtitles.element.setAttribute("aria-expanded", String(state.panel === "subtitles"));
        actions.push(subtitles);
    }
    if (actions.length === 0 && seasonItems.length === 0) {
        actions.push(actionButton("back", "Back", back));
    }
    const personal = state === undefined ? undefined : personalControls(state, true);
    if (state !== undefined) {
        // Watchlist shows while membership loads or fails; only a server or item that has no lists drops it.
        if (state.personalSupported !== false) actions.push(watchlistButton(state));
        const more = actionButton("more", "More", () => state.showPanel("more"));
        more.element.setAttribute("aria-haspopup", "dialog");
        actions.push(more);
    }
    const ordinal = audio.findIndex((_track, index) => selectedAudio === `file:${file?.fileId}:audio:${index}`);
    const resolvedAudio = audio[effectiveAudio] === undefined ? audio.length ? audioLabel(0) : "Unknown" : audioLabel(effectiveAudio);
    // Values stay empty until the focused episode's full versions arrive.
    const summary = playbackChoices === undefined ? undefined : `Version: ${versionValue} | Audio: ${ordinal === -1 ? "Auto · " : ""}${resolvedAudio} | Subtitles: ${subtitleSummary}`;
    // TVSeriesDetailView shows the readout while episodes load or while it has a target episode. Tizen reads a target's
    // playback detail only for the next-up episode, so the readout also hides once nothing is loading and no values came.
    const showsSummary = (detail.type !== "series" && detail.type !== "season") || state?.series === undefined || state.series.loading || state.nextEpisodeLoading || summary !== undefined;
    const content = [...detailHeader(detail, context, actions.map(detailAction), state, summary, showsSummary), ...lines(notes), ...personal?.notes ?? []];
    // A save in flight holds Play; a failed one leaves Play live so pressing it re-sends the save.
    for (const action of actions.filter(action => ["play", "resume", "next-episode", "start-over-episode"].includes(action.key))) {
        if (playbackChoices !== undefined) action.element.setAttribute("aria-disabled", String(savePending));
    }
    // Disabled controls stay in the row but take no focus (TVDisabledDetailActionsKey). One that disables under
    // focus keeps it until the viewer moves, so a repaint never moves focus by itself.
    const held = document.activeElement?.closest(".details-editorial .browse-actions") ? document.activeElement.getAttribute("data-focus") : null;
    const focusable = actions.filter(action => action.element.getAttribute("aria-disabled") !== "true" || action.key === held);
    for (const action of focusable) {
        if (action.element.getAttribute("aria-disabled") !== "true") continue;
        action.element.addEventListener("focusout", () => { const index = focusable.indexOf(action); if (index >= 0) focusable.splice(index, 1); }, { once: true });
    }
    if (state?.nextEpisodeFailed === true && !state.offline) content.push(...lines(["Could not load the next episode."], "error"));
    if (state?.titleArtPolicy === "failed" && !state.offline) content.push(...lines(["Could not load title-art settings."], "error"));
    // TVSeriesDetailView.episodeExperience: the trailer pill is the episode block's last line, under the rail.
    const seriesStatus = detail.type === "series" ? trailerStatus(state) : undefined;
    if (series !== undefined) content.push(...series.content);
    else if (seasonItems.length > 0) {
        content.push(el("h2", "browse-section-title", "Seasons"), zoneNode("browse-row", seasonItems));
    }
    if (seriesStatus !== undefined) { seriesStatus.classList.add("details-trailer-status-series"); content.push(seriesStatus); }
    const zones: Zone[] = [
        { id: "actions", layout: "row", items: focusable, restoreEntry: focusable.find(action => ["resume", "play", "next-episode"].includes(action.key))?.key ?? "watchlist" },
        ...series?.zones ?? [{ id: "seasons", layout: "row" as const, items: seasonItems }],
    ];
    const credits = detail.extra?.cast ?? [];
    if (credits.length > 0) {
        const occurrences = new Map<string, number>();
        const people = credits.slice(0, 24).map(credit => {
            const item = creditCard(credit, context);
            // Always key by identity/role/occurrence, including singleton credits.
            // A conditional key format used to rename a focused card when another
            // role for the same person appeared or disappeared, so FocusHost could
            // not restore it after trailer discovery refreshed the detail. Apple's
            // rail keys by index; Tizen keeps identity so a reorder of the same set
            // can still restore focus.
            const identity = `${credit.id ?? credit.name}\u001f${credit.role}`;
            const occurrence = occurrences.get(identity) ?? 0;
            occurrences.set(identity, occurrence + 1);
            // encodeURIComponent keeps the key CSS-selectable and free of JSON quotes.
            const key = `credit:${encodeURIComponent(credit.id ?? credit.name)}:${encodeURIComponent(credit.role)}:${occurrence}`;
            item.element.dataset.focus = key;
            return { ...item, key };
        });
        content.push(el("h2", "browse-section-title", "Cast & Crew"), zoneNode("browse-row details-people", people));
        // TVDetailCastRail.swift:37-38: tvDefaultFocus lands every entry on the first person.
        zones.push({ id: "people", layout: "row", items: people, entry: people[0]?.key });
    }
    if (state !== undefined && (detail.type === "movie" || detail.type === "series")) {
        // Show YouTube cards the way tvOS does when the YouTube app can open.
        // Select cannot hand off or play them through AVPlay, so it stays on the card.
        const extras = trailerCards(detail.extras, detail.videos, true).map(card => trailerCard(card, context, state, play));
        if (extras.length > 0) {
            content.push(el("h2", "browse-section-title", "Trailers & More"), zoneNode("browse-row details-extras", extras));
            // TVTrailersRail is a focus section with user-initiated default focus
            // on the first card, so every entry lands there, as in Cast and Related.
            zones.push({ id: "extras", layout: "row", items: extras, entry: extras[0]?.key });
            if (state.extraPending !== undefined) content.push(...lines(["Loading extra…"]));
            if (state.extraFailed !== undefined) content.push(...lines(["Could not load extra. Select its card to retry."], "error"));
        }
    }
    // TVMovieDetailView.swift:107-119: Cast, Trailers & More, then the box set.
    const movieRow = boxSet === undefined ? undefined : boxSetMovieRow(boxSet, detail.id, context);
    if (movieRow !== undefined) {
        content.push(...movieRow.content);
        zones.push(movieRow.zone);
    }
    if (state !== undefined) {
        // TVSimilarRail passes neither overlayData nor userState to TVMediaCard.
        // AppRouter.openRelatedTitle: a related pick replaces a page that a related pick opened.
        const openRelated = (destination: Destination): void => context.open(destination.kind === "item" ? { ...destination, fromRelated: true } : destination);
        const related = titleCards((state.related ?? []).map(card => ({ ...card, played: undefined })), { ...context, open: openRelated, overlays: undefined, cardOverlays: () => undefined });
        if (!(state.offline && state.related === undefined) && !state.relatedFailed && (state.related === undefined || related.length > 0)) {
            const section = zoneNode("browse-row", related);
            section.setAttribute("data-detail-section", "related");
            content.push(el("h2", "browse-section-title", detail.type === "movie" ? "Related Movies" : "Recommended Series"));
            // TVSimilarRail.swift:96-111: four untitled 220x330 cards while it loads; every entry lands on the first card.
            if (state.related === undefined) {
                for (let index = 0; index < 4; index++) { const placeholder = el("div", "details-related-placeholder"); placeholder.setAttribute("aria-hidden", "true"); section.append(placeholder); }
            } else zones.push({ id: "related", layout: "row", items: related, entry: related[0]?.key });
            content.push(section);
        }
    }
    const facts: { label: string; value: string }[] = [];
    const crew = detail.extra?.crew ?? [];
    const directors = creditLine(crew, ["director"]);
    if (directors !== undefined) facts.push({ label: "Director", value: directors });
    const writers = creditLine(crew, ["writer", "screenplay", "story"]);
    if (writers !== undefined) facts.push({ label: writerFactLabel(crew), value: writers });
    facts.push(...detail.extra?.facts ?? []);
    // TVDetailFactsSection: the "Details" header always shows; only the facts grid hides when empty.
    const factsPanel = el("div", "details-facts");
    factsPanel.setAttribute("aria-label", "Details");
    factsPanel.appendChild(el("h2", "browse-section-title", "Details"));
    content.push(factsPanel);
    if (facts.length > 0) {
        const table = el("dl", "details-facts-table");
        for (const fact of facts) { const row = el("div", "details-fact-row"); row.append(el("dt", "", fact.label.toUpperCase()), el("dd", "", fact.value)); table.append(row); }
        table.tabIndex = -1; table.dataset.focus = "fact:0"; factsPanel.append(table);
        const items = [{ key: "fact:0", element: table }];
        zones.push({ id: "facts", layout: "column", items });
    }
    const first = focusable[0] ?? seasonItems[0];
    const view: View = { name: `item:${detail.id}`, content, zones, focus: first === undefined ? undefined : { zone: focusable[0] === undefined ? "seasons" : "actions", key: first.key }, back };
    if (state?.panel === "audio") {
        const options = [undefined, ...audio.map((_track, index) => index)].map(ordinal => {
            const item = actionButton(`audio:${ordinal ?? "auto"}`, ordinal === undefined ? "Auto" : audioRowTitle(ordinal), () => { if (tracks !== undefined) state.noteEpisodePreference(tracks.detail.id); tracks?.selectAudio(ordinal); if (tracks !== state) state.closePanel(); });
            item.element.setAttribute("role", "radio");
            item.element.setAttribute("aria-checked", String(ordinal === undefined ? selectedAudio === undefined : ordinal === (effectiveAudio >= 0 ? effectiveAudio : 0)));
            if (ordinal !== undefined) {
                // DetailPlaybackFormatting.audioDetail: the track's own title leads unless it only repeats the name or layout.
                const qualifier = trackAudioTitle(audio[ordinal]?.title, audio[ordinal]?.language);
                const layout = audioDetails(ordinal).split(" · ").at(-1);
                const shownTitle = qualifier !== undefined && ![audioRowTitle(ordinal), layout].some(value => value?.toLowerCase() === qualifier.toLowerCase()) ? qualifier : undefined;
                const flags = [shownTitle, audioDetails(ordinal), audio[ordinal]?.isDefault ? "Default" : undefined, ordinal === file?.effectiveAudioTrackIndex ? "Preferred" : undefined].filter(Boolean).join(" · ");
                if (flags) item.element.append(el("small", "details-option-subtext", flags));
            }
            return item;
        });
        return detailPanel(view, state, "Audio", options);
    }
    if (state?.panel === "version") {
        const options = [undefined, ...playbackDetail.versions].map(version => {
            const item = actionButton(`version:${version?.fileId ?? "auto"}`, version?.label || "Auto", () => { tracks?.select(version?.fileId); state.closePanel(); });
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
            // DetailPlaybackFormatting.subtitleOptions: an embedded track with no codec is a format the server cannot deliver,
            // and a sidecar with no stream index cannot be chosen here; both stay listed, dimmed and unfocusable.
            const unsupported = track !== undefined && track.source !== "external" && (track.codec?.trim() ?? "") === "";
            const selectable = track === undefined || track.selectionIndex !== undefined && !unsupported;
            const item = actionButton(`subtitle:${choice ?? "auto"}`, track === undefined ? choice === "off" ? "Off" : "Auto" : languageName(track.language) ?? track.label ?? `Track ${Number(choice) + 1}`, () => { if (!selectable) return; if (tracks !== undefined) state.noteEpisodePreference(tracks.detail.id); tracks?.selectSubtitle(choice); if (tracks !== state) state.closePanel(); });
            if (track !== undefined) {
                const codec = /subrip|srt/i.test(track.codec ?? '') ? 'SRT' : track.codec?.toUpperCase();
                const label = track.label && ![track.codec?.toUpperCase(), codec, languageName(track.language)?.toUpperCase(), 'SDH', 'CC'].includes(track.label.toUpperCase()) ? track.label : undefined;
                const hearingImpaired = track.hearingImpaired || /\b(SDH|CC)\b/i.test(track.label ?? '');
                const availability = unsupported ? 'Unsupported format' : !selectable ? 'Available in player' : undefined;
                item.element.append(el('small', 'details-option-subtext', [label, codec, track.forced ? 'Forced' : undefined, hearingImpaired ? 'SDH' : undefined, track.isDefault ? 'Default' : undefined, track.source === 'external' ? 'External' : undefined, availability].filter(Boolean).join(' · ')));
                if (!selectable) item.element.setAttribute('aria-disabled', 'true');
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
            if (value !== undefined && !change?.pending) {
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
                const item = actionButton("season-watched", change?.pending ? "Updating season…" : value ? "Mark Season Unwatched" : "Mark Season Watched", () => {
                    if (state.busy) return;
                    state.closePanel();
                    seasonState.change("watched", change?.failed ? change.target : !value, change?.failed);
                });
                item.element.setAttribute("aria-disabled", String(state.busy));
                items.push(item);
            }
        }
        if (detail.type === "series" && state.focusedEpisodeId !== undefined) items.unshift(actionButton("series-overview", "Show Series Info", () => state.showSeriesOverview()));
        // TVSeriesDetailView.moreMenu: shuffle leads, the season on screen before the series. Each keeps its label and is only
        // disabled while a shuffle starts.
        if (detail.type === "series" && state.shuffleSupported && seasons.reduce((count, season) => count + season.episodeCount, 0) >= 2) {
            const shuffle = actionButton("shuffle-series", "Shuffle Series", () => state.startShuffle(play));
            shuffle.element.setAttribute("aria-disabled", String(state.shuffleStarting));
            items.unshift(shuffle);
        }
        const shuffleSeason = detail.type === "series" ? seasonToShuffle(state) : undefined;
        if (shuffleSeason !== undefined) {
            const name = shuffleSeason.isSpecials === true || shuffleSeason.seasonNumber === 0 ? shuffleSeason.title || "Specials" : `Season ${shuffleSeason.seasonNumber}`;
            const shuffle = actionButton("shuffle-season", `Shuffle ${name}`, () => state.startShuffle(play, shuffleSeason));
            shuffle.element.setAttribute("aria-disabled", String(state.shuffleStarting));
            items.unshift(shuffle);
        }
        if (detail.type === "movie" || detail.type === "series") items.push(actionButton("find-trailers", "Find Trailers", () => { state.trailers.start(state.detail); state.closePanel(); }));
        if (state.descriptions?.offers() === true) items.push(actionButton("translate-description", TRANSLATE_DESCRIPTION_LABEL, () => { state.descriptions?.translate(); state.closePanel(); }));
        // WatchPartyEntry.isAvailable: last, and only while the experimental switch is on and the server can host a party.
        // A series offers the episode its hero shows.
        const partyTitle = detail.type === "series" ? state.nextEpisode : detail.type === "movie" || detail.type === "episode" ? state.detail : undefined;
        if (context.watchParty?.offered() === true && partyTitle !== undefined) {
            items.push(actionButton("watch-party", "Watch Party", () => { state.closePanel(); context.watchParty?.open(choiceFromDetail(partyTitle)); }));
        }
        return detailPanel(view, state, "More", items.length ? items : [actionButton("close-more", "Close", () => state.closePanel())], menuNotes);
    }
    return view;
}

/** A failure Details shows as Apple's system alert: centred over the page, one OK, and Back dismisses it. */
export function withDetailsAlert(view: View, state: DetailsState | undefined): View {
    const seasonOwner = state?.series?.seasonNumber === undefined ? undefined : state.seasonStates.get(state.series.seasonNumber);
    const alert = state?.alert ?? seasonOwner?.alert;
    if (state === undefined || alert === undefined) return view;
    const dismiss = (): void => { seasonOwner?.dismissAlert(); state.dismissAlert(); };
    const ok = actionButton("alert-ok", "OK", dismiss);
    // PersonalStateNoticeAlert: a held change adds the destructive Discard Held Change before OK.
    const discard = alert.held === undefined ? undefined : actionButton("alert-discard", "Discard Held Change", () => state.discardHeld());
    const buttons = discard === undefined ? [ok] : [discard, ok];
    return { name: `${view.name}:alert`, content: centredDialog({ style: "alert", id: alert.id, title: alert.title, message: alert.message, buttons: buttons.map(item => item.element), ...(discard === undefined ? {} : { destructive: discard.element }), behind: view.content }), zones: [{ id: "alert", layout: buttons.length > 1 ? "column" : "row", items: buttons }], focus: { zone: "alert", key: ok.key }, back: dismiss };
}

/** TVSeriesDetailView.shuffleSeason: the season on screen, outside the series overview, once it has two episodes with files. */
function seasonToShuffle(state: DetailsState): Season | undefined {
    const series = state.series;
    if (!state.shuffleSeasonSupported || series === undefined || series.loading || series.seasonNumber === undefined) return undefined;
    if (state.focusedEpisodeId === undefined && !series.selectionOwnsHero) return undefined;
    const playable = (series.episodes ?? []).filter(episode => episode.seasonNumber === series.seasonNumber && (episode.files?.length ?? 0) > 0);
    return playable.length >= 2 ? series.seasons.find(season => season.seasonNumber === series.seasonNumber) : undefined;
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

/** TVCircleActionButton for Watchlist: always "Watchlist"; the icon fill and spoken label carry the state. */
function watchlistButton(state: DetailsState): FocusItem {
    const value = state.values.get("watchlist");
    const change = state.changes.get("watchlist");
    const item = actionButton("watchlist", value ? "Remove from watchlist" : "Add to watchlist", () => {
        if (value === undefined) { if (state.personalFailed && !state.busy) state.loadPersonal(); return; }
        state.change("watchlist", change?.failed ? change.target : !value, change?.failed);
    });
    // aria-pressed stays off until membership is known.
    const pressed = change?.pending ? change.target : value;
    if (pressed !== undefined) item.element.setAttribute("aria-pressed", String(pressed));
    return item;
}

/** `alerts`: Details presents a failed change as Apple's alert, so the control keeps its label and adds no note. */
export function personalControls(state: DetailsState, alerts = false): { items: FocusItem[]; notes: HTMLElement[] } {
    const items: FocusItem[] = [];
    const notes: HTMLElement[] = [];
    for (const kind of ["watched", "favorites", "watchlist"] as const) {
        if (kind !== "watched" && state.personalSupported === false) continue;
        const value = state.values.get(kind);
        if (value === undefined) continue;
        const change = state.changes.get(kind);
        const label = kind === "watched" ? `${state.detail.type === "series" || state.detail.type === "season" ? "Mark all" : "Mark"} ${value ? "unwatched" : "watched"}` : kind === "watchlist" ? value ? "Remove from watchlist" : "Add to watchlist" : value ? "Remove favorite" : "Add favorite";
        const item = actionButton(kind, change?.pending ? `Updating ${kind}…` : change?.failed && !alerts ? `Retry ${kind}` : label, () => state.change(kind, change?.failed ? change.target : !value, change?.failed));
        item.element.setAttribute("aria-pressed", String(value));
        item.element.setAttribute("aria-disabled", String(state.busy));
        items.push(item);
        if (change?.failed && !alerts) notes.push(...lines([`Could not update ${kind}.`], "error"));
    }
    if (state.personalFailed) items.push(actionButton("retry-personal", "Retry personal actions", () => { if (!state.busy) state.loadPersonal(); }));
    if (state.personalSupported === undefined && !state.offline) notes.push(...lines([state.personalFailed ? "Could not load personal actions." : "Loading personal actions."], state.personalFailed ? "error" : "info"));
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
    // TVDetailCastRail.swift:96: no character, no role line.
    if (credit.role.trim() !== "") element.appendChild(el("span", "browse-card-subtitle", credit.role));
    return { key, element };
}

function titleCards(cards: readonly Card[], context: ViewContext): FocusItem[] {
    const items: FocusItem[] = [];
    for (const card of cards) {
        const { preview: _preview, ...titlesContext } = context;
        const item = cardItem(card, titlesContext);
        if (item !== undefined) items.push(item);
    }
    return items;
}

/**
 * `DetailFacts.creditNames` at silo-apple `2ef3a171`: unique names in Unicode
 * order, three of them, then an ellipsis when more remain.
 */
export function creditLine(crew: readonly Credit[], jobs: readonly string[]): string | undefined {
    const wanted = new Set(jobs);
    const names = [...new Set(crew.filter(credit => wanted.has(credit.role.toLowerCase())).map(credit => credit.name))];
    names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    if (names.length === 0) return undefined;
    const shown = names.slice(0, 3).join(", ");
    return names.length > 3 ? `${shown}, …` : shown;
}

/** A screenplay credit uses "Writer". Every other writing credit uses "Written by". */
export function writerFactLabel(crew: readonly Credit[]): "Writer" | "Written by" {
    return crew.some(credit => credit.role.toLowerCase() === "screenplay") ? "Writer" : "Written by";
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
        const art = artwork("browse-art browse-still", episode.stillUrl, context.baseUrl, defaultArtwork("tv"));
        if (hidesEpisodeListStill(episode, context.spoilers?.() ?? { hidesImages: false, hidesOverviews: false })) blurEpisodeStill(art);
        element.appendChild(art);
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
