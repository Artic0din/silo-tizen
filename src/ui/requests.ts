import type { MediaRequest, MyRequests, RequestPage, RequestsCapability, RequestSection, RequestTitle } from "../contracts/v2/requests.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { actionButton, lines, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";

export type RequestsSource =
    | { readonly kind: "hub" }
    | { readonly kind: "search"; query: string; page: number }
    | { readonly kind: "mine"; cursor: string | undefined }
    | { readonly kind: "row"; key: string; page: number }
    | { readonly kind: "media"; title: RequestTitle }
    | { readonly kind: "request"; id: string };
export interface RequestsState {
    readonly source: RequestsSource;
    data: readonly RequestSection[] | RequestPage | MyRequests | RequestTitle | MediaRequest | undefined;
    input?: HTMLInputElement;
    writing: boolean;
    uncertain: boolean;
}
export function requestsState(source: RequestsSource): RequestsState { return { source, data: undefined, writing: false, uncertain: false }; }
export interface RequestsHandlers {
    readonly capability: RequestsCapability;
    readonly busy: boolean;
    readonly failure: string | undefined;
    readonly profileId: string;
    readonly back: () => void;
    readonly retry: () => void;
    readonly open: (source: RequestsSource) => void;
    readonly write: (action: "create" | "cancel" | "follow" | "unfollow") => void;
    readonly search: () => void;
    readonly edit: () => void;
    readonly next: (page: number | string) => void;
}
export function requestsView(state: RequestsState, h: RequestsHandlers): View {
    const source = state.source, data = state.data;
    const content: HTMLElement[] = [el("h1", "browse-title", source.kind === "mine" ? "My Requests" : "Requests")];
    const zones: Zone[] = [];
    const add = (id: string, items: FocusItem[], grid = false): void => {
        if (items.length === 0) return;
        content.push(zoneNode(grid ? "requests-grid" : "browse-actions", items));
        const enabled = items.filter(item => !(item.element instanceof HTMLButtonElement) || !item.element.disabled);
        if (enabled.length > 0) zones.push({ id, layout: grid ? "grid" : "row", ...(grid ? { columns: 4 } : {}), items: enabled });
    };
    const titleItems = (titles: readonly RequestTitle[]): FocusItem[] => titles.filter(title => title.mediaType === "movie" || title.mediaType === "series").map(title => actionButton(`${title.mediaType}:${title.tmdbId}`, `${title.title} · ${title.availability === "available" ? "Available" : title.request.state ?? "Not requested"}`, () => h.open({ kind: "media", title })));
    if (source.kind === "hub") add("tools", [actionButton("search", "Search requests", () => h.open({ kind: "search", query: "", page: 1 })), actionButton("mine", "My Requests", () => h.open({ kind: "mine", cursor: undefined }))]);
    if (source.kind === "search") {
        if (state.input === undefined) {
            const input = el("input", "browse-input") as HTMLInputElement;
            input.type = "search"; input.setAttribute("aria-label", "Search requests"); input.value = source.query;
            input.addEventListener("input", () => { source.query = input.value; h.edit(); });
            input.addEventListener("keydown", event => { if (event.key === "Enter" || event.keyCode === 65376) { event.preventDefault(); event.stopPropagation(); h.search(); } });
            state.input = input;
        }
        add("search", [{ key: "query", element: state.input }, actionButton("submit", "Search", h.search)]);
    }
    if (h.failure !== undefined) content.push(...lines([h.failure], "error"));
    if (h.busy || state.writing) content.push(...lines([state.writing ? "Saving request…" : "Loading requests…"], "info"));
    if (data !== undefined) {
        if (Array.isArray(data)) {
            const sections = data as readonly RequestSection[];
            for (const section of sections) {
                content.push(el("h2", "browse-title", section.title));
                add(`row:${section.key}`, [...titleItems(section.results), ...(section.nextPage <= section.totalPages ? [actionButton("more", "See all", () => h.open({ kind: "row", key: section.key, page: 1 }))] : [])], true);
            }
            if (sections.every(section => section.results.length === 0)) content.push(...lines(["No titles available."], "info"));
        } else if ("results" in data) {
            add("results", titleItems(data.results), true);
            if (data.results.length === 0) content.push(...lines(["No titles found."], "info"));
            add("pages", [...(data.page > 1 ? [actionButton("previous", "Previous page", () => h.next(data.page - 1))] : []), ...(data.nextPage <= data.totalPages ? [actionButton("next", "Next page", () => h.next(data.nextPage))] : [])]);
        } else if ("items" in data) {
            add("mine", data.items.map(item => actionButton(item.id, `${item.title} · ${item.state}`, () => h.open({ kind: "request", id: item.id }))), true);
            if (data.items.length === 0) content.push(...lines(["No requests yet."], "info"));
            if (data.cursor !== undefined) { const cursor = data.cursor; add("pages", [actionButton("next", "Next page", () => h.next(cursor))]); }
        } else if ("title" in data) {
            content.push(el("h2", "browse-title", data.title), ...lines(data.overview === undefined ? [] : [data.overview], "info"));
            const actions: FocusItem[] = [];
            if ("request" in data) {
                content.push(...lines([data.availability === "available" ? "Available" : data.request.state ?? data.request.reason ?? "Not requested"], "info"));
                if (data.request.requestable) actions.push(actionButton("create", "Request title", () => h.write("create")));
                if (h.capability.follow && data.request.id !== undefined && !data.request.requestedByViewer) actions.push(actionButton("follow", data.request.following ? "Unfollow" : "Follow", () => h.write(data.request.following ? "unfollow" : "follow")));
            } else {
                content.push(...lines([data.state], "info"));
                if (data.profileId === h.profileId && data.outcome === "active" && data.status === "pending") actions.push(actionButton("cancel", "Cancel request", () => h.write("cancel")));
            }
            for (const action of actions) (action.element as HTMLButtonElement).disabled = state.writing || state.uncertain || h.busy;
            add("mutations", actions);
        }
    }
    add("actions", [actionButton("refresh", h.failure === undefined ? "Refresh" : "Retry", h.retry), actionButton("back", "Back", h.back)]);
    return { name: `requests:${source.kind}`, content, zones, focus: { zone: zones[0]?.id ?? "actions", key: zones[0]?.items[0]?.key ?? "back" }, back: h.back };
}
