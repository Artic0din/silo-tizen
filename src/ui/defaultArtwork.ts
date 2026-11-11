// What a poster, thumbnail or still shows when its artwork is missing or failed, after silo-apple
// DefaultArtwork.swift (tvOS values): a #16171C base, three faint brand glows and a small mark for the
// item's type. The glows and the mark's size are in defaultArtwork rules of browse.css, in container
// units so the same markup fits a poster and a 16:9 thumbnail.

export type ArtworkSymbol = "film" | "tv" | "headphones" | "book.closed";

/** silo-apple `ArtworkPlaceholderSymbol.forMediaType`, with `SiloMediaType`'s type spellings. */
export function artworkSymbol(type: string | undefined): ArtworkSymbol {
    switch (type?.trim().toLowerCase()) {
        case "audiobook": case "audiobooks": case "book": case "books":
        case "podcast": case "podcasts":
            return "headphones";
        case "series": case "show": case "shows": case "tv": case "tvshows":
        case "episode": case "episodes":
        case "season": case "season_premiere":
            return "tv";
        case "ebook": case "ebooks": case "manga": case "comic": case "comics":
            return "book.closed";
        default:
            return "film";
    }
}

function roundedRect(x: number, y: number, width: number, height: number, radius: number): string {
    const r = Math.min(radius, width / 2, height / 2);
    return `M${x + r} ${y}H${x + width - r}A${r} ${r} 0 0 1 ${x + width} ${y + r}V${y + height - r}A${r} ${r} 0 0 1 ${x + width - r} ${y + height}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + height - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

/** SF Symbol film: a frame with five sprocket holes down each side and two picture windows. */
function filmPath(): string {
    const holes = [0, 1, 2, 3, 4].flatMap(row => [roundedRect(18.6, 17 + row * 15.75, 11, 10.5, 2.5), roundedRect(111.4, 17 + row * 15.75, 11, 10.5, 2.5)]);
    return [roundedRect(10.5, 9, 120, 89, 10), ...holes, roundedRect(37.75, 17, 65.5, 32.25, 2.5), roundedRect(37.75, 57.75, 65.5, 32.25, 2.5)].join("");
}

/**
 * The drawn marks stand in for SF Symbols, which are not on Tizen. Each viewBox is the glyph's drawn
 * bounds at 100pt regular, because Apple's Canvas fills its mark rectangle with the glyph, so the width
 * rule sizes the visible shape. The group is drawn at one opacity, in CSS.
 */
const MARKS: Readonly<Record<ArtworkSymbol, { readonly viewBox: string; readonly markup: string }>> = {
    film: { viewBox: "10.5 9 120 89", markup: `<path fill-rule="evenodd" d="${filmPath()}"/>` },
    tv: {
        viewBox: "12 9 124 97",
        markup: `<path fill-opacity=".31" d="${roundedRect(20, 17, 108, 64.5, 5)}"/><path fill-rule="evenodd" d="${roundedRect(12, 9, 124, 80.5, 13)}${roundedRect(20, 17, 108, 64.5, 5)}${roundedRect(45, 98, 58, 8, 4)}"/>`,
    },
    headphones: {
        viewBox: "12 9 101 98",
        markup: `<path fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" d="M16.5 86C13 48 31 13.5 62.5 13.5S112 48 108.5 86"/>`
            + `<path stroke="currentColor" stroke-width="5" stroke-linejoin="round" d="M22 79 27 69 38 69.5 41 75 47 95 46 101 40 104.5H29L23 99Z"/>`
            + `<path stroke="currentColor" stroke-width="5" stroke-linejoin="round" d="M103 79 98 69 87 69.5 84 75 78 95 79 101 85 104.5H96L102 99Z"/>`,
    },
    "book.closed": {
        viewBox: "12 9 84 103",
        markup: `<g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">`
            + `<path d="M16 86V27Q16 13 30 13H78Q92 13 92 27V76"/><path stroke-width="6" d="M29 16V84"/>`
            + `<path d="M16 86V96Q16 108 28 108H92M20 86H86Q80 92 86 100"/></g>`,
    },
};

/** Builds a node on demand: most cards load their image, so the SVG is parsed only for ones that need it. */
export type DefaultArtworkFactory = () => HTMLElement;

const templates = new Map<ArtworkSymbol, HTMLElement>();

function buildDefaultArtwork(symbol: ArtworkSymbol): HTMLElement {
    const art = document.createElement("div");
    art.className = "default-artwork";
    art.dataset.symbol = symbol;
    art.setAttribute("aria-hidden", "true");
    const glow = document.createElement("div");
    glow.className = "default-artwork-glow";
    art.append(glow, artworkMark(symbol, "default-artwork-mark"));
    return art;
}

/** The drawn stand-in for one SF Symbol, filled with currentColor. */
export function artworkMark(symbol: ArtworkSymbol, className: string): SVGSVGElement {
    const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    mark.setAttribute("class", className);
    mark.setAttribute("viewBox", MARKS[symbol].viewBox);
    mark.setAttribute("focusable", "false");
    mark.setAttribute("aria-hidden", "true");
    mark.setAttribute("fill", "currentColor");
    mark.innerHTML = MARKS[symbol].markup;
    return mark;
}

/**
 * The mark and glows of silo-apple `DefaultArtwork(symbol:)`, as a factory `artwork()` calls only when the
 * image is missing or fails. One template per symbol is parsed once and cloned. Decoration only: the card's
 * label names the item.
 */
export function defaultArtwork(symbol: ArtworkSymbol): DefaultArtworkFactory {
    return () => {
        let template = templates.get(symbol);
        if (template === undefined) {
            template = buildDefaultArtwork(symbol);
            templates.set(symbol, template);
        }
        return template.cloneNode(true) as HTMLElement;
    };
}
