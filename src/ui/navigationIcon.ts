const PATHS = {
    Recommended: "M10 5 12 11 18 13 12 15 10 21 8 15 2 13 8 11ZM19 2 20 5 23 6 20 7 19 10 18 7 15 6 18 5Z",
    Collections: "M2 8 12 3 22 8 12 13ZM2 13 12 18 22 13M2 18 12 23 22 18",
    Browse: "M3 3H9V9H3ZM15 3H21V9H15ZM3 15H9V21H3ZM15 15H21V21H15Z",
    Genres: "M3 3H12L22 13 13 22 3 12ZM7 7H8",
    "Recently Added": "M12 3A9 9 0 1 1 3 12 9 9 0 0 1 12 3ZM12 7V12L16 15",
    movies: "M3 5H21V20H3ZM3 10H21M7 5 10 10M14 5 17 10",
    series: "M3 7H21V20H3ZM7 2 12 7 17 2",
    watchlist: "M6 3H18V22L12 18 6 22Z",
    favorites: "M12 21 3 12C-2 4 8 0 12 7 16 0 26 4 21 12Z",
    history: "M4 6A9 9 0 1 1 3 14M3 3V9H9M12 6V12L16 15",
    "switch-profile": "M8 3A4 4 0 1 1 8 11 4 4 0 0 1 8 3ZM1 22V18C1 12 15 12 15 18V22M18 4A4 4 0 0 1 18 12M19 15C23 15 23 19 23 22",
    settings: "M12 3 15 7 20 6 21 12 20 18 15 17 12 21 9 17 4 18 3 12 4 6 9 7ZM12 8A4 4 0 1 1 12 16 4 4 0 0 1 12 8Z",
    "switch-server": "M3 3H21V10H3ZM3 14H21V21H3ZM7 6H8M7 17H8",
    signout: "M10 3H3V21H10M8 12H22M17 7 22 12 17 17",
} as const;

/** Original line drawings substitute for platform-owned SF Symbols. */
export function navigationIcon(name: string): SVGSVGElement {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("class", "skyline-menu-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    const path = document.createElementNS(icon.namespaceURI, "path");
    path.setAttribute("d", name in PATHS ? PATHS[name as keyof typeof PATHS] : "M4 20 12 3 20 20M7 14H17");
    icon.appendChild(path);
    return icon;
}
