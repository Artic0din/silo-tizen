import type { ProfileSummary } from "../contracts/v2/wire.ts";
import { navigationAvatar } from "./navigationAvatar.ts";
import { navigationIcon } from "./navigationIcon.ts";
import { button, el, type Control, type Screen } from "./screen.ts";

// ProfileTilePalette and tvOS sizing, silo-apple 1a7ccee.
const PALETTE = [[217, 117, 97], [102, 143, 184], [176, 138, 102], [117, 158, 133], [199, 122, 133], [143, 122, 184], [92, 148, 158], [199, 163, 97]] as const;

function avatarReference(profile: ProfileSummary): string | undefined {
    if (profile.avatarUrl !== undefined) return profile.avatarUrl;
    const raw = profile.avatar?.trim();
    const preset = /^preset:dicebear:([^:]+):(.+)$/.exec(raw ?? "");
    if (preset !== null) return `https://api.dicebear.com/9.x/${encodeURIComponent(preset[1] ?? "")}/png?seed=${encodeURIComponent(preset[2] ?? "")}&size=440`;
    return raw !== undefined && (raw.includes("/") || /\.(png|jpe?g|webp|gif|svg|avif)(?:\?|$)/i.test(raw)) ? raw : undefined;
}

export function profileAvatar(profile: ProfileSummary, baseUrl: string): HTMLElement {
    const reference = avatarReference(profile);
    const raw = profile.avatar?.trim() ?? "";
    const imageLike = /^upload:|^preset:dicebear:|\/|\.(png|jpe?g|webp|gif|svg|avif)(?:\?|$)/i.test(raw);
    const fallback = !imageLike && raw !== "" ? raw : Array.from(profile.name.trim())[0]?.toUpperCase() ?? "?";
    const avatar = navigationAvatar(profile.name, reference, baseUrl, 220, fallback);
    avatar.classList.add("profile-avatar");
    if (!imageLike && raw !== "") avatar.classList.add("profile-avatar-text");
    let tintIndex = 5381 % PALETTE.length;
    for (const byte of new TextEncoder().encode(profile.id)) tintIndex = (tintIndex * 33 + byte) % PALETTE.length;
    const tint = PALETTE[tintIndex] ?? PALETTE[0];
    const light = tint.map(channel => Math.round(channel * 0.65 + 255 * 0.35));
    const dark = tint.map(channel => Math.round(channel * 0.55));
    avatar.style.background = `radial-gradient(circle 176px at 30% 25%, rgb(${light.join(",")}), rgb(${tint.join(",")}), rgb(${dark.join(",")}))`;
    return avatar;
}

interface PickerOptions {
    readonly profiles: readonly ProfileSummary[];
    readonly baseUrl: string;
    readonly accountName: string | undefined;
    readonly rememberedId: string | undefined;
    readonly focus: string;
    readonly choose: (profile: ProfileSummary) => void;
    readonly add: () => void;
    readonly changeServer: () => void;
    readonly signOut: () => void;
    readonly back: (() => void) | undefined;
}

export function profilePickerScreen(options: PickerOptions): Screen {
    const main = el("div", "profile-picker-main");
    main.append(el("h1", "profile-picker-title", "Who's watching?"), el("p", "profile-account", options.accountName === undefined ? " " : `Signed in as ${options.accountName}`));
    const grid = el("div", "profile-grid");
    const columns = Math.min(6, options.profiles.length + 1);
    grid.style.gridTemplateColumns = `repeat(${columns}, 240px)`;
    let lastTile: HTMLElement | undefined;
    const controls: Control[] = options.profiles.map((profile, index) => {
        const tile = button(`profile:${profile.id}`, "", () => options.choose(profile));
        tile.element.className = "profile-tile";
        tile.element.setAttribute("aria-label", `${profile.name}${profile.hasPin ? ", PIN protected" : ""}`);
        const face = el("span", "profile-face");
        face.appendChild(profileAvatar(profile, options.baseUrl));
        if (profile.hasPin) {
            const lock = el("span", "profile-lock");
            lock.setAttribute("aria-hidden", "true");
            face.appendChild(lock);
        }
        if (profile.isChild) face.appendChild(el("span", "profile-child", "KIDS"));
        tile.element.append(face, el("span", "profile-name", profile.name));
        if (profile.id === options.rememberedId) tile.element.appendChild(el("span", "profile-remembered", "Auto-login"));
        grid.appendChild(tile.element);
        return { ...tile, row: Math.floor(index / columns) };
    });
    const add = button("add-profile", "", options.add);
    add.element.className = "profile-tile profile-add";
    add.element.setAttribute("aria-label", "Add profile");
    const plus = el("span", "profile-add-circle", "+");
    plus.setAttribute("aria-hidden", "true");
    add.element.append(plus, el("span", "profile-name", "Add profile"));
    grid.appendChild(add.element);
    controls.push({ ...add, row: Math.floor(options.profiles.length / columns) });
    grid.addEventListener("focusin", event => {
        const target = event.target;
        if (target instanceof HTMLElement) lastTile = target.closest<HTMLButtonElement>(".profile-tile") ?? lastTile;
    });
    main.appendChild(grid);
    const footer = el("div", "profile-footer");
    const change = button("change-server", "Change server", options.changeServer);
    const out = button("signout", "Sign out", options.signOut);
    change.element.prepend(navigationIcon("switch-server"));
    out.element.prepend(navigationIcon("signout"));
    footer.append(change.element, out.element);
    const footerRow = Math.ceil((options.profiles.length + 1) / columns);
    controls.push({ ...change, row: footerRow }, { ...out, row: footerRow });
    footer.addEventListener("keydown", event => {
        if (event.key !== "ArrowUp" || lastTile?.isConnected !== true) return;
        event.preventDefault();
        event.stopPropagation();
        lastTile.focus();
    });
    return { name: "profiles", content: [main, footer], controls, focus: options.focus, back: options.back };
}
