import type { UserLibrary } from "../contracts/v2/catalog.ts";
import type { MenuItem, PrimaryMenu } from "../contracts/v2/navigation.ts";

const DEFAULT_MENU: readonly MenuItem[] = (["home", "movies", "series", "for_you", "calendar"] as const).map(destination => ({ type: "builtin", destination }));
export type NavigationRoot =
    | { readonly key: "home" | "movies" | "series" | "for_you" | "calendar" | "requests"; readonly title: string }
    | { readonly key: `library:${string}`; readonly title: string; readonly library: UserLibrary };

/** Apple TVPrimaryMenuProjection: preserve authored order and filter unavailable destinations. */
export function navigationRoots(menu: PrimaryMenu | null, libraries: readonly UserLibrary[], requests: boolean): NavigationRoot[] {
    const roots: NavigationRoot[] = [];
    const labels = { home: "Home", movies: "Movies", series: "Series", for_you: "For You", calendar: "Calendar" };
    for (const item of menu?.items ?? DEFAULT_MENU) {
        if (item.type === "library") {
            const library = libraries.find(library => library.id === String(item.library_id) && library.type !== "unknown");
            if (library !== undefined) roots.push({ key: `library:${library.id}`, title: item.label, library });
        } else if (item.type === "builtin") {
            const key = item.destination;
            if (key === "music" || key === "audiobooks") continue;
            if ((key === "movies" || key === "series") && !libraries.some(library => library.type === key || library.type === "mixed")) continue;
            roots.push({ key, title: labels[key] });
        }
    }
    if (!roots.some(root => root.key === "home")) roots.unshift({ key: "home", title: "Home" });
    if (requests) roots.push({ key: "requests", title: "Requests" });
    return roots.filter((root, index) => roots.findIndex(other => other.key === root.key) === index);
}
