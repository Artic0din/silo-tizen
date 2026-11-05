const PATHS = {
    credits: "M9 3H7V9L4 12 7 15V21H9M15 3H17V9L20 12 17 15V21H15",
    qr: "M3 3H9V9H3ZM15 3H21V9H15ZM3 15H9V21H3ZM15 15H18V18H21V21H15ZM21 12H12V21",
    document: "M5 2H15L20 7V22H5ZM15 2V7H20M8 11H17M8 15H17M8 19H14",
    privacy: "M8 12V4A2 2 0 0 1 12 4V10A2 2 0 0 1 16 9V12A2 2 0 0 1 20 11V17C20 24 10 24 7 19L3 13A2 2 0 0 1 6 11L8 14Z",
    playback: "M3 5H21V19H3ZM10 9 16 12 10 15Z",
    subtitles: "M3 4H21V18H8L3 22ZM6 9H10M14 9H18M6 13H10M14 13H18",
    "chevron-right": "M9 5 16 12 9 19",
    Recommended: "M10 5 12 11 18 13 12 15 10 21 8 15 2 13 8 11ZM19 2 20 5 23 6 20 7 19 10 18 7 15 6 18 5Z",
    Collections: "M2 8 12 3 22 8 12 13ZM2 13 12 18 22 13M2 18 12 23 22 18",
    Browse: "M3 3H9V9H3ZM15 3H21V9H15ZM3 15H9V21H3ZM15 15H21V21H15Z",
    Genres: "M3 3H12L22 13 13 22 3 12ZM7 7H8",
    "Recently Added": "M12 3A9 9 0 1 1 3 12 9 9 0 0 1 12 3ZM12 7V12L16 15",
    movies: "M3 5H21V20H3ZM3 10H21M7 5 10 10M14 5 17 10",
    series: "M3 7H21V20H3ZM7 2 12 7 17 2",
    watchlist: "M6 3H18V22L12 18 6 22Z",
    favorites: "M12 21 3 12C-2 4 8 0 12 7 16 0 26 4 21 12Z",
    requests: "M3 3L22 12 3 21 7 12ZM7 12H22",
    music: "M9 18V4L21 2V16M9 7L21 5M9 18A3 3 0 1 1 6 15M21 16A3 3 0 1 1 18 13",
    history: "M4 6A9 9 0 1 1 3 14M3 3V9H9M12 6V12L16 15",
    "switch-profile": "M8 3A4 4 0 1 1 8 11 4 4 0 0 1 8 3ZM1 22V18C1 12 15 12 15 18V22M18 4A4 4 0 0 1 18 12M19 15C23 15 23 19 23 22",
    settings: "M12 3 15 7 20 6 21 12 20 18 15 17 12 21 9 17 4 18 3 12 4 6 9 7ZM12 8A4 4 0 1 1 12 16 4 4 0 0 1 12 8Z",
    "switch-server": "M3 3H21V10H3ZM3 14H21V21H3ZM7 6H8M7 17H8",
    signout: "M10 3H3V21H10M8 12H22M17 7 22 12 17 17",
    reset: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5",
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
