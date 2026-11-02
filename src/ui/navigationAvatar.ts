import { artworkUrl } from "./browseModel.ts";
import { el } from "./screen.ts";

/** Apple ProfileAvatarView keeps its fallback only until the resolved image succeeds. */
export function navigationAvatar(name: string, reference: string | undefined, baseUrl: string, size: number): HTMLElement {
    const avatar = el("span", "navigation-avatar");
    avatar.style.width = `${size}px`;
    avatar.style.height = `${size}px`;
    avatar.setAttribute("aria-hidden", "true");
    const fallback = el("span", "navigation-avatar-fallback", Array.from(name.trim())[0]?.toUpperCase() ?? "");
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
