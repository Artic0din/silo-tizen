import type { MediaRequest, MyRequests, RequestPage, RequestsCapability, RequestTitle, RequestsHub } from "../contracts/v2/requests.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import type { ErrorState } from "./browseRoutes.ts";
import { actionButton, artwork, FAILURE_ICON, lines, recoveryActions, searchState, zoneNode } from "./browseViews.ts";
import { requestPosterUrl } from "./browseModel.ts";
import { el } from "./screen.ts";
import { orderRequests, requestProgress } from "./requestProgress.ts";
import { canCancel, canRemove } from "./requestRemoval.ts";
import { cullToRailBounds, requestActionSpinner, requestHero, requestPlusIcon, requestPosterBadge, requestsLoadingPage, requestStatusLabel, TRAY_ICON } from "./requestsScene.ts";

export type RequestWrite = "create" | "cancel" | "follow" | "unfollow";
export type RequestsSource =
    | { readonly kind: "hub" }
    | { readonly kind: "search"; query: string; page: number }
    | { readonly kind: "mine"; cursor: string | undefined }
    | { readonly kind: "media"; title: RequestTitle }
    | { readonly kind: "request"; id: string };
export interface RequestsState {
    source: RequestsSource;
    data: RequestsHub | RequestPage | MyRequests | RequestTitle | MediaRequest | undefined;
    detail?: RequestTitle | undefined;
    detailFailed?: boolean;
    /** What the last failed read means; shown while `failure` is set and the hub has no rows. */
    error?: ErrorState;
    preview?: RequestTitle | MediaRequest;
    /** The search title and field row, kept across renders so the focused field is never detached. */
    search?: { readonly head: readonly HTMLElement[]; readonly items: readonly FocusItem[] };
    writing: boolean;
    uncertain: boolean;
    /** Apple isSubmitting and isCancelling: a write and the read that settles it. */
    action?: RequestWrite | undefined;
    /** Apple isSubmissionUnconfirmed and isCancelUnconfirmed: `action` may have landed and no read has shown it. */
    unconfirmed?: boolean;
    /** Apple actionErrorMessage, beside the action until the next write or a settling read. */
    actionMessage?: string | undefined;
    /** Apple MyRequestsViewModel.actingId: the list row whose cancel or remove is running. */
    actingId?: string | undefined;
    /** Apple unconfirmedActions: a lost cancel or remove stays held until a later list read. */
    heldIds?: readonly string[] | undefined;
    /** Apple notice, under the rows, cleared after three seconds. */
    notice?: string | undefined;
    /** Apple actionErrorMessage for a list cancel or remove. */
    listMessage?: string | undefined;
}
export function requestsState(source: RequestsSource): RequestsState { return { source, data: undefined, writing: false, uncertain: false }; }
export interface RequestsHandlers {
    readonly capability: RequestsCapability;
    readonly busy: boolean;
    readonly failure: string | undefined;
    readonly profileId: string;
    readonly back: () => void;
    readonly retry: () => void;
    /** Ends the session for a 401; undefined when this client cannot sign out from here. */
    readonly signIn: (() => void) | undefined;
    readonly open: (source: RequestsSource) => void;
    readonly openCatalog: (id: string, title: string) => void;
    readonly write: (action: RequestWrite) => void;
    /** Apple's card context menu. Hub and My Requests records only. */
    readonly menu?: (record: MediaRequest) => void;
    readonly search: () => void;
    readonly edit: () => void;
    readonly next: (page: number | string) => void;
}
export function requestCard(title: RequestTitle | MediaRequest, baseUrl: string, open: () => void, preview?: (title: RequestTitle | MediaRequest) => void): FocusItem {
    const key = "id" in title ? title.id : `${title.mediaType}:${title.tmdbId}`;
    const progress = requestProgress(title), label = `${title.title} · ${progress?.short ?? "Not requested"}`;
    const item = actionButton(key, label, open);
    item.element.className = "browse-card requests-card";
    item.element.setAttribute("aria-label", label);
    const art = artwork("browse-art", requestPosterUrl(title.posterPath), baseUrl, title.title);
    if ("request" in title && progress !== undefined) { const badge = requestPosterBadge(progress); if (badge !== undefined) art.appendChild(badge); }
    const subtitle = el("span", "browse-card-subtitle");
    if (!("request" in title) && progress !== undefined) subtitle.appendChild(requestStatusLabel(progress));
    else subtitle.textContent = title.year?.toString() ?? "";
    item.element.replaceChildren(art, el("span", "browse-card-title", title.title), subtitle);
    if (preview !== undefined) item.element.addEventListener("focus", () => preview(title));
    return item;
}
const browsable = (title: RequestTitle): boolean => title.mediaType === "movie" || title.mediaType === "series";
/** Apple TVPageFocusOwner: an inert page holds focus with no highlight, so the remote always has a target. */
function pageOwner(page: HTMLElement, label: string): FocusItem {
    page.tabIndex = -1;
    page.setAttribute("role", "status");
    page.setAttribute("aria-label", label);
    page.setAttribute("data-focus", "requests-page");
    return { key: "requests-page", element: page };
}
/** Apple ErrorView.recoveryPlan: a 401 offers sign-in, a 403 or 404 prefers leaving when there is somewhere to go, and otherwise leaving is the remote's Back. */
function errorPlaceholder(state: RequestsState, h: RequestsHandlers, name: string, goBack?: () => void): View {
    const error = state.error ?? { headline: "Something went wrong", message: h.failure ?? "", signIn: false };
    const page = searchState(error.headline, error.message, "requests-state requests-failure", FAILURE_ICON);
    page.setAttribute("role", "alert");
    const items = recoveryActions(error, actionButton("retry", "Try Again", h.retry), goBack === undefined ? undefined : actionButton("go-back", "Go Back", goBack), h.signIn === undefined ? undefined : actionButton("sign-in", "Sign In Again", h.signIn));
    page.appendChild(zoneNode("browse-actions", items));
    return { name, content: [page], zones: [{ id: "status", layout: "column", items }], focus: { zone: "status", key: items[0]?.key ?? "retry" }, back: h.back };
}
/** Apple TVRequestsPage.placeholder: the whole hub while it has no rows to show. */
function hubPlaceholder(state: RequestsState, h: RequestsHandlers): View | undefined {
    const data = state.data;
    if (data !== undefined && "sections" in data && (orderRequests(data.mine.items).length > 0 || data.sections.some(section => section.results.some(browsable)))) return undefined;
    const placeholder = (content: HTMLElement, zone: Zone): View => ({ name: "requests:hub", content: [zoneNode("skyline-content", [{ key: "", element: content }])], zones: [zone], focus: { zone: zone.id, key: zone.items[0]?.key ?? "" }, back: h.back });
    if (h.failure !== undefined) {
        const view = errorPlaceholder(state, h, "requests:hub");
        return { ...view, content: [zoneNode("skyline-content", view.content.map(element => ({ key: "", element })))] };
    }
    const page = data === undefined ? requestsLoadingPage() : searchState("Nothing here yet", "Use Search to find a movie or series to request", "requests-state requests-empty", TRAY_ICON);
    return placeholder(page, { id: "page", layout: "row", items: [pageOwner(page, data === undefined ? "Loading requests" : "Nothing here yet")] });
}
export function requestsView(state: RequestsState, h: RequestsHandlers, baseUrl: string): View {
    const source = state.source, data = state.data;
    const hub = source.kind === "hub";
    const detailPage = source.kind === "media" || source.kind === "request";
    const bannerText = state.listMessage ?? state.notice;
    const withNotice = (view: View): View => {
        if (bannerText === undefined) return view;
        const banner = el("p", "requests-list-notice", bannerText);
        banner.setAttribute("role", "status");
        return { ...view, content: [...view.content, banner] };
    };
    // Apple RequestDetailView: with no page to keep, a failed read is the whole screen.
    const placeholder = hub ? hubPlaceholder(state, h) : detailPage && data === undefined && h.failure !== undefined ? errorPlaceholder(state, h, `requests:${source.kind}`, h.back) : undefined;
    if (placeholder !== undefined) return withNotice(placeholder);
    const content: HTMLElement[] = [];
    const zones: Zone[] = [];
    const openCard = (title: RequestTitle | MediaRequest): void => {
        if (requestProgress(title)?.display === "inLibrary" && title.libraryContentId) h.openCatalog(title.libraryContentId, title.title);
        else h.open("id" in title ? { kind: "request", id: title.id } : { kind: "media", title });
    };
    const preview = el("div", "requests-preview");
    const paint = (title: RequestTitle | MediaRequest): void => { state.preview = title; preview.replaceChildren(requestHero(title, baseUrl)); };
    const add = (id: string, items: FocusItem[], grid = false, into: HTMLElement[] = content): void => {
        if (items.length === 0) return;
        into.push(zoneNode(grid ? hub ? "browse-row requests-rail" : "requests-grid" : "browse-actions", items));
        const enabled = items.filter(item => !(item.element instanceof HTMLButtonElement) || !item.element.disabled);
        if (enabled.length > 0) zones.push({ id, layout: grid && !hub ? "grid" : "row", ...(grid && !hub ? { columns: 4 } : {}), ...(grid && hub ? { spatial: true } : {}), items: enabled });
    };
    /** Apple's rowView: the eyebrow, heading and rail scroll as one view-aligned target. */
    const hubRow = (id: string, head: readonly HTMLElement[], items: FocusItem[]): void => {
        const nodes = [...head];
        add(id, items, true, nodes);
        const row = el("section", "requests-row");
        row.setAttribute("data-section", id);
        row.append(...nodes);
        content.push(row);
    };
    const card = (title: RequestTitle | MediaRequest, open: () => void): FocusItem => requestCard(title, baseUrl, open, hub ? paint : undefined);
    /** Apple TVRequestsPage.card: Cancel Request and Remove Request live on the record's context menu. */
    const ownCard = (record: MediaRequest): FocusItem => {
        const item = card(record, () => openCard(record));
        const held = state.heldIds ?? [];
        const cancel = canCancel(record, state.actingId, held);
        const remove = canRemove(record, h.capability.removeFailed, state.actingId, held);
        if (state.actingId === record.id) item.element.dataset.busy = "true";
        const offered = [cancel ? "cancel" : undefined, remove ? "remove" : undefined].filter((name): name is string => name !== undefined);
        if (offered.length === 0) return item;
        item.element.dataset.requestActions = offered.join(" ");
        return h.menu === undefined ? item : { ...item, quickAction: () => h.menu?.(record) };
    };
    const titleItems = (titles: readonly RequestTitle[]): FocusItem[] => titles.filter(browsable).map(title => card(title, () => openCard(title)));
    if (source.kind === "search") {
        if (state.search === undefined) {
            const input = el("input", "browse-input") as HTMLInputElement;
            input.type = "search"; input.setAttribute("aria-label", "Search requests"); input.value = source.query;
            input.addEventListener("input", () => { source.query = input.value; h.edit(); });
            input.addEventListener("keydown", event => { if (event.key === "Enter" || event.keyCode === 65376) { event.preventDefault(); event.stopPropagation(); h.search(); } });
            const items = [{ key: "query", element: input }, actionButton("submit", "Search", () => h.search())];
            state.search = { head: [el("h1", "browse-title", "Requests"), zoneNode("browse-actions", items)], items };
        }
        content.push(...state.search.head);
        zones.push({ id: "search", layout: "row", items: [...state.search.items] });
    } else if (!hub && source.kind !== "media" && source.kind !== "request") content.push(el("h1", "browse-title", source.kind === "mine" ? "My Requests" : "Requests"));
    if (hub) content.push(preview);
    // A hub with rows keeps them through a failed or running refresh, as Apple's does; a detail's held action says why itself.
    if (!hub && h.failure !== undefined && state.actionMessage === undefined) content.push(...lines([h.failure], "error"));
    if (!hub && h.busy && !(detailPage && data !== undefined)) content.push(...lines(["Loading requests…"], "info"));
    if (data !== undefined) {
        if ("sections" in data) {
            const mine = orderRequests(data.mine.items);
            const titles = [...mine, ...data.sections.flatMap(section => section.results)];
            const identity = (title: RequestTitle | MediaRequest): string => "id" in title ? title.id : `${title.mediaType}:${title.tmdbId}`;
            const previous = state.preview;
            const initial = (previous === undefined ? undefined : titles.find(title => identity(title) === identity(previous))) ?? titles[0];
            if (initial !== undefined) paint(initial);
            if (mine.length > 0) hubRow("mine", [el("h2", "requests-heading", "Your requests")], mine.map(ownCard));
            let eyebrow = true;
            for (const section of data.sections) {
                if (!section.results.some(browsable)) continue;
                hubRow(`row:${section.key}`, [...(eyebrow ? [el("p", "requests-discover", "Discover")] : []), el("h2", "requests-heading", section.title)], titleItems(section.results));
                eyebrow = false;
            }
        } else if ("results" in data) {
            add("results", titleItems(data.results), true);
            if (data.results.length === 0) content.push(...lines(["No titles found."], "info"));
            add("pages", [...(data.page > 1 ? [actionButton("previous", "Previous page", () => h.next(data.page - 1))] : []), ...(data.nextPage <= data.totalPages ? [actionButton("next", "Next page", () => h.next(data.nextPage))] : [])]);
        } else if ("items" in data) {
            add("mine", data.items.map(ownCard), true);
            if (data.items.length === 0) content.push(...lines(["No requests yet."], "info"));
            if (data.cursor !== undefined) { const cursor = data.cursor; add("pages", [actionButton("next", "Next page", () => h.next(cursor))]); }
        } else if ("title" in data) {
            const metadata = "request" in data ? data : state.detail;
            const hero = requestHero(data, baseUrl, metadata, true);
            content.push(hero);
            if (state.detailFailed) content.push(...lines(["Could not load title information. Refresh to try again."], "error"));
            const actions: FocusItem[] = [];
            const inert = state.writing || state.uncertain || h.busy;
            // Apple's primary action: one button whose label and style morph, so focus stays put (RequestDetailView.swift:11).
            const requestAction = (): FocusItem => {
                const request = actionButton("create", "Request", () => h.write("create"));
                request.element.classList.add("requests-primary-action");
                const label = state.action !== "create" ? "Request" : state.unconfirmed ? "Not confirmed yet" : "Requesting…";
                request.element.setAttribute("aria-label", label);
                if (state.action !== "create") { request.element.classList.add("requests-interactive-action"); request.element.prepend(requestPlusIcon()); }
                else if (state.unconfirmed) request.element.replaceChildren(requestStatusLabel({ display: "unavailable", short: label, long: label, completed: 0, current: undefined }));
                else request.element.replaceChildren(requestActionSpinner(), el("span", "", label));
                return request;
            };
            if ("request" in data) {
                if (data.request.requestable) actions.push(requestAction());
                if (h.capability.follow && data.request.id !== undefined && !data.request.requestedByViewer) actions.push(actionButton("follow", data.request.following ? "Unfollow" : "Follow", () => h.write(data.request.following ? "unfollow" : "follow")));
            } else {
                // Apple's canCancel hides Cancel while it runs and until a read settles an unconfirmed one. A list cancel owns the same gate.
                if (data.profileId === h.profileId && data.outcome === "active" && data.status === "pending" && state.action !== "cancel" && state.actingId === undefined) actions.push(actionButton("cancel", "Cancel request", () => h.write("cancel")));
            }
            const progress = requestProgress(data);
            // A request that ended no longer blocks a new one once the fresh title says so (RequestDetailViewModel.primaryAction).
            const requestAgain = !("request" in data) && state.detail?.request.requestable === true && (progress?.display === "unavailable" || progress?.display === "needsAttention");
            if (requestAgain) actions.unshift(requestAction());
            else if (progress !== undefined) {
                const catalogId = data.libraryContentId;
                const inLibrary = progress.display === "inLibrary" && !!catalogId;
                const primary = actionButton("status", inLibrary ? "Open in Library" : progress.long, () => { if (inLibrary && !inert) h.openCatalog(catalogId, data.title); });
                primary.element.classList.add("requests-primary-action");
                if (inLibrary) primary.element.classList.add("requests-interactive-action");
                primary.element.dataset.requestDisplay = progress.display;
                primary.element.replaceChildren(inLibrary ? el("span", "", "Open in Library") : requestStatusLabel(progress, progress.long));
                primary.element.setAttribute("aria-label", inLibrary ? "Open in Library" : progress.long);
                actions.unshift(primary);
            }
            // A disabled button leaves the focus zones, so the primary action stays focusable and only ignores presses (RequestDetailView.swift:438).
            if (inert) for (const action of actions) {
                if (action.element.classList.contains("requests-primary-action")) action.element.setAttribute("aria-disabled", "true");
                else (action.element as HTMLButtonElement).disabled = true;
            }
            if (actions.length > 0) {
                const row = zoneNode("browse-actions requests-detail-actions", actions);
                // Apple shows an unconfirmed write's message once its read has answered.
                if (state.actionMessage !== undefined && !(state.unconfirmed && h.busy)) {
                    const message = el("p", "requests-action-message", state.actionMessage);
                    message.setAttribute("role", "alert");
                    row.appendChild(message);
                }
                (hero.querySelector(".requests-hero-copy") ?? hero).appendChild(row);
                const enabled = actions.filter(action => !(action.element as HTMLButtonElement).disabled);
                if (enabled.length > 0) zones.push({ id: "mutations", layout: "row", spatial: true, items: enabled });
            }
            if ((metadata?.recommendations?.length ?? 0) > 0) {
                content.push(el("h2", "requests-heading", "More like this"));
                const items = titleItems(metadata?.recommendations ?? []);
                const rail = zoneNode("browse-row requests-rail", items);
                cullToRailBounds(rail); content.push(rail);
                zones.push({ id: "related", layout: "row", spatial: true, items });
            }
        }
    }
    // Apple's detail has no controls below More like this; these recover failures and hold focus while none is otherwise available.
    const recovering = h.failure !== undefined || state.detailFailed === true || zones.length === 0 || (state.uncertain && !state.writing && !h.busy);
    if (!hub && (!detailPage || recovering)) add("actions", [actionButton("refresh", h.failure !== undefined ? "Retry" : "Refresh", h.retry), actionButton("back", "Back", h.back)]);
    return withNotice({ name: `requests:${source.kind}`, content: hub ? [zoneNode("skyline-content", content.map(element => ({ key: "", element })))] : content, zones, focus: { zone: zones[0]?.id ?? "actions", key: zones[0]?.items[0]?.key ?? "back" }, back: h.back });
}
