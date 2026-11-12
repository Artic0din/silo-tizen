import { artworkUrl } from "./browseModel.ts";
import { el } from "./screen.ts";

/** An original filled head-and-shoulders drawing standing in for the platform-owned `person.fill` symbol. */
function personGlyph(): SVGSVGElement {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("class", "navigation-avatar-person");
    icon.setAttribute("viewBox", "0 0 92 100");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(icon.namespaceURI, "path");
    path.setAttribute("d", "M46 2A24 24 0 1 1 46 50 24 24 0 0 1 46 2ZM0 100V90C0 70 20 58 46 58S92 70 92 90V100Z");
    icon.appendChild(path);
    return icon;
}

/** Apple ProfileAvatarView keeps its fallback only until the resolved image succeeds. */
export function navigationAvatar(name: string, reference: string | undefined, baseUrl: string, size: number, fallbackText?: string): HTMLElement {
    const avatar = el("span", "navigation-avatar");
    avatar.style.width = `${size}px`;
    avatar.style.height = `${size}px`;
    avatar.style.setProperty("--avatar-size", `${size}px`);
    avatar.setAttribute("aria-hidden", "true");
    const initial = fallbackText ?? Array.from(name.trim())[0]?.toUpperCase();
    const fallback = el("span", "navigation-avatar-fallback", initial ?? "");
    // ProfileAvatarView: a profile with no name shows a person glyph instead of an empty disc.
    if (initial === undefined) fallback.appendChild(personGlyph());
    avatar.appendChild(fallback);
    const url = artworkUrl(reference, baseUrl);
    if (url !== undefined) {
        const image = document.createElement("img");
        image.alt = "";
        image.addEventListener("load", () => { image.hidden = false; fallback.hidden = true; });
        image.addEventListener("error", () => { image.hidden = true; fallback.hidden = false; });
        image.src = url;
        avatar.appendChild(image);
    }
    return avatar;
}

/** Apple ProfileAvatarView in the top bar and Settings: a text (emoji) avatar replaces the initial at 45% of the diameter. */
export function profileMenuAvatar(name: string, reference: string | undefined, text: string | undefined, baseUrl: string, size: number): HTMLElement {
    const avatar = navigationAvatar(name, reference, baseUrl, size, text);
    if (text !== undefined) avatar.classList.add("navigation-avatar-emoji");
    return avatar;
}
