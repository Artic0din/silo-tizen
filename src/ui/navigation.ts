import type { UserLibrary } from "../contracts/v2/catalog.ts";
import type { PrimaryMenu } from "../contracts/v2/navigation.ts";

export type NavigationRoot = { readonly key: "home" | "movies" | "series" | "music" | "for_you" | "calendar"; readonly title: string };

/** Apple TVRootDestination.visibleRoots: fixed roots filtered by visible library types. */
export function navigationRoots(_menu: PrimaryMenu | null, libraries: readonly UserLibrary[], _requests: boolean): NavigationRoot[] {
    const roots: NavigationRoot[] = [{ key: "home", title: "Home" }];
    for (const key of ["movies", "series", "music"] as const) {
        if (libraries.some(library => library.type === key || (key !== "music" && library.type === "mixed"))) {
            roots.push({ key, title: { movies: "Movies", series: "Series", music: "Music" }[key] });
        }
    }
    // Audiobooks requires an enabled local feature; this client has no audiobook feature.
    return [...roots, { key: "for_you", title: "For You" }, { key: "calendar", title: "Calendar" }];
}
