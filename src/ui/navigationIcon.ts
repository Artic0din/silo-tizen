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
    audiobooks: "M5 3H19V21H5ZM5 17H19M9 7H15",
    "watch-party": "M12 3A3.5 3.5 0 1 1 12 10 3.5 3.5 0 0 1 12 3ZM5 8A2.5 2.5 0 1 1 5 13 2.5 2.5 0 0 1 5 8ZM19 8A2.5 2.5 0 1 1 19 13 2.5 2.5 0 0 1 19 8ZM6 21V19C6 14 18 14 18 19V21M1 20V18C1 15 4 14 6 14.5M23 20V18C23 15 20 14 18 14.5",
    music: "M9 18V4L21 2V16M9 7L21 5M9 18A3 3 0 1 1 6 15M21 16A3 3 0 1 1 18 13",
    history: "M4 6A9 9 0 1 1 3 14M3 3V9H9M12 6V12L16 15",
    "switch-profile": "M8 3A4 4 0 1 1 8 11 4 4 0 0 1 8 3ZM1 22V18C1 12 15 12 15 18V22M18 4A4 4 0 0 1 18 12M19 15C23 15 23 19 23 22",
    settings: "M12 3 15 7 20 6 21 12 20 18 15 17 12 21 9 17 4 18 3 12 4 6 9 7ZM12 8A4 4 0 1 1 12 16 4 4 0 0 1 12 8Z",
    "switch-server": "M3 3H21V10H3ZM3 14H21V21H3ZM7 6H8M7 17H8",
    signout: "M10 3H3V21H10M8 12H22M17 7 22 12 17 17",
    reset: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5",
} as const;

/**
 * Apple's top-bar menus draw filled SF Symbols at 20 pt semibold in a 30 pt frame (silo-apple 7e478b2
 * `tvOS/Navigation/TVTopMenuBar.swift:1034-1037`, `:1061-1063`, `:1183-1200`; `Components/ProfileMenuRow.swift:51`).
 * These are original filled drawings in the same 24-unit box as the line icons, sized to each symbol's measured ink;
 * a glyph wider or taller than the box overruns it as Apple's does. Change Account keeps Apple's outlined circle, so it
 * adds a stroked part.
 */
const FILLED: Readonly<Record<string, { readonly fill: string; readonly stroke?: string }>> = {
    // person.2.fill
    "switch-profile": { fill: "M4.2 2.1A4.3 4.3 0 1 1 4.2 10.7 4.3 4.3 0 0 1 4.2 2.1ZM18.5 .8A5.3 5.3 0 1 1 18.5 11.4 5.3 5.3 0 0 1 18.5 .8ZM-3.7 20.2C-3.7 16.3 0 13.2 4.2 13.2C6.2 13.2 8 13.8 9.4 14.9C7.8 16.6 6.9 18.4 6.9 20.2V22.2H-1.7Q-3.7 22.2 -3.7 20.2ZM8.3 20.2C8.3 16 13 12.7 18 12.7S27.7 16 27.7 20.2Q27.7 22.2 25.7 22.2H10.3Q8.3 22.2 8.3 20.2Z" },
    // clock.fill
    history: { fill: "M12 0A12 12 0 1 1 12 24 12 12 0 0 1 12 0ZM12 4.4A.95 .95 0 0 0 11.05 5.35V11.05H7.4A.95 .95 0 0 0 7.4 12.95H12A.95 .95 0 0 0 12.95 12V5.35A.95 .95 0 0 0 12 4.4Z" },
    // paperplane.fill
    requests: { fill: "M23.6 -.9 -.5 9.3Q-1.6 9.8 -.4 10.5L8.9 14.1ZM23.6 -.9 10.4 15.6 13.9 23.3Q14.5 24.3 15.1 23.2Z" },
    // gearshape.fill
    settings: { fill: "M9.16 2.72 9.29 -.2 14.71 -.2 14.84 2.72 16.55 3.44 18.72 1.46 22.54 5.28 20.56 7.45 21.28 9.16 24.2 9.29 24.2 14.71 21.28 14.84 20.56 16.55 22.54 18.72 18.72 22.54 16.55 20.56 14.84 21.28 14.71 24.2 9.29 24.2 9.16 21.28 7.45 20.56 5.28 22.54 1.46 18.72 3.44 16.55 2.72 14.84 -.2 14.71 -.2 9.29 2.72 9.16 3.44 7.45 1.46 5.28 5.28 1.46 7.45 3.44ZM12 9A3 3 0 1 1 12 15 3 3 0 0 1 12 9Z" },
    // person.crop.circle.badge.checkmark: the ring and person stop short of the badge, which carries a cut-out tick.
    "switch-server": {
        fill: "M1.8 11.5A6 6 0 1 1 1.8 23.5 6 6 0 0 1 1.8 11.5ZM-1.95 18.12 .93 21.14 5.48 15.89 4.12 14.71 .87 18.46 -.65 16.88Z",
        stroke: "M2.59 9.05A11.1 11.1 0 1 1 8.69 22.44M13.8 4.2A3.25 3.25 0 1 1 13.8 10.7 3.25 3.25 0 0 1 13.8 4.2ZM10 18.9C11.3 17.1 12.5 16.4 13.8 16.4C15.9 16.4 17.9 17.6 19.6 20.1",
    },
    // bookmark.fill
    watchlist: { fill: "M5.6 -.5H18.4Q20.4 -.5 20.4 1.5V25.2Q20.4 26.8 19 25.8L12 19.4 5 25.8Q3.6 26.8 3.6 25.2V1.5Q3.6 -.5 5.6 -.5Z" },
    // heart.fill
    favorites: { fill: "M12 22.4C11.6 22.4 11.1 22.2 10.7 21.9C4.6 17.6 0 13 0 7.4C0 3.4 2.9 .4 6.6 .4C8.9 .4 10.8 1.7 12 3.7C13.2 1.7 15.1 .4 17.4 .4C21.1 .4 24 3.4 24 7.4C24 13 19.4 17.6 13.3 21.9C12.9 22.2 12.4 22.4 12 22.4Z" },
    // sparkles, also the library cascade's Recommended (tvOS/Screens/Libraries/TVLibraryPillRow.swift:30)
    Recommended: { fill: "M13.8 5.8Q15.72 13.48 23.4 15.4Q15.72 17.32 13.8 25Q11.88 17.32 4.2 15.4Q11.88 13.48 13.8 5.8ZM5.3 3.6Q6.24 7.36 10 8.3Q6.24 9.24 5.3 13Q4.36 9.24 .6 8.3Q4.36 7.36 5.3 3.6ZM11.3 -1.6Q11.88 .72 14.2 1.3Q11.88 1.88 11.3 4.2Q10.72 1.88 8.4 1.3Q10.72 .72 11.3 -1.6Z" },
};

/** A top-bar menu row's icon: Apple's filled glyph where it draws one, else the shared line drawing. */
export function menuIcon(name: string): SVGSVGElement {
    const shape = FILLED[name];
    const icon = navigationIcon(name);
    if (shape === undefined) return icon;
    icon.replaceChildren();
    icon.classList.add("skyline-menu-icon-filled");
    icon.setAttribute("stroke", "none");
    const fill = document.createElementNS(icon.namespaceURI, "path");
    fill.setAttribute("d", shape.fill);
    fill.setAttribute("fill", "currentColor");
    fill.setAttribute("fill-rule", "evenodd");
    icon.appendChild(fill);
    if (shape.stroke !== undefined) {
        const stroke = document.createElementNS(icon.namespaceURI, "path");
        stroke.setAttribute("d", shape.stroke);
        stroke.setAttribute("stroke", "currentColor");
        // SF semibold weight at 20 pt: about 1.8 pt, 2.2 units of this box.
        stroke.setAttribute("stroke-width", "2.2");
        stroke.setAttribute("stroke-linecap", "round");
        icon.appendChild(stroke);
    }
    return icon;
}

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
