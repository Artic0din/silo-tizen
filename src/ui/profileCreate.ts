import { ApiError } from "../api/errors.ts";
import { operations } from "../api/operations.ts";
import type { UserLibrary } from "../contracts/v2/catalog.ts";
import type { ProfileCreateBody, ProfileSummary } from "../contracts/v2/wire.ts";
import type { ConnectedServer } from "../session/core.ts";
import { ProfileManagement } from "../session/profileManagement.ts";
import { pinProblem, pinScreen } from "./pinScreen.ts";
import { profileAvatar } from "./profilePicker.ts";
import { PROFILE_STYLES, profilePresets } from "./profilePresets.ts";
import { actions, button, el, type Control, type Screen } from "./screen.ts";

export interface ProfileCreateFlow { destroy(): void; }
interface Options {
    readonly server: ConnectedServer;
    readonly profiles: readonly ProfileSummary[];
    readonly show: (screen: Screen, focus?: string) => void;
    readonly finished: (profileId?: string, uncertain?: boolean) => void;
}

export function createProfileFlow(options: Options): ProfileCreateFlow {
    const management = new ProfileManagement(options.server);
    const controller = new AbortController();
    const bootstrap = options.profiles.length === 0;
    let ended = false;
    let submitting = false;
    let name = "", pin = "", style = "fun-emoji", batch = 0, selected = 0;
    let child = false, restricted = false, rating = "PG";
    const allowed = new Set<string>();
    let libraries: UserLibrary[] | undefined;
    let librariesFailed = false;
    let updateLibraries = (): void => undefined;

    const destroy = (): void => { ended = true; controller.abort(); management.close(); pin = ""; };
    const finish = (profileId?: string, uncertain = false): void => {
        try { destroy(); }
        catch {
            const retry = button("cleanup-retry", "Try again", () => finish(profileId, uncertain));
            options.show({ name: "profile-cleanup", content: [el("h1", "signin-title", "Could not leave profile management"), actions([retry])], controls: [retry], focus: retry.key, back: undefined });
            return;
        }
        options.finished(profileId, uncertain);
    };
    const showProblem = (line: string): void => {
        const back = button("creation-back", "Choose profile", () => finish(undefined, submitting));
        options.show({ name: "profile-create-error", content: [el("h1", "signin-title", "Profile could not be created"), el("p", "signin-text signin-error", line), actions([back])], controls: [back], focus: back.key, back: () => finish(undefined, submitting) });
    };
    const loadLibraries = (): void => {
        librariesFailed = false;
        void options.server.session.call({ ...operations.listUserLibraries(), profileScoped: true, signal: controller.signal }).then(found => {
            if (ended) return;
            libraries = found;
            updateLibraries();
        }, () => { if (!ended) { librariesFailed = true; updateLibraries(); } });
    };

    const render = (focus = "create-name", error?: string): void => {
        if (ended) return;
        const controls: Control[] = [];
        updateLibraries = () => undefined;
        let drawLibraries: (() => void) | undefined;
        let row = 0;
        const column = el("div", "profile-create-controls");
        const section = (title: string, content: HTMLElement, trailing?: HTMLElement): void => {
            const block = el("section", "profile-create-section");
            const heading = el("div", "profile-create-section-heading");
            heading.appendChild(el("h2", "profile-create-label", title));
            if (trailing !== undefined) heading.appendChild(trailing);
            block.append(heading, content);
            column.appendChild(block);
        };
        const rowButton = (key: string, label: string, run: () => void): Control => {
            const control = { ...button(key, label, () => { if (!submitting) run(); }), row };
            controls.push(control);
            return control;
        };
        const styles = el("div", "profile-style-row");
        for (const [id, label] of PROFILE_STYLES) {
            const control = rowButton(`style:${id}`, label, () => { style = id; selected = 0; render(`style:${id}`); });
            control.element.setAttribute("aria-pressed", String(style === id));
            styles.appendChild(control.element);
        }
        row++;
        section("Style", styles);
        const presets = profilePresets(style, batch);
        if (style !== "initials") {
            const shuffle = rowButton("shuffle-avatars", "Shuffle avatars", () => { batch++; selected = 0; render("shuffle-avatars"); });
            const grid = el("div", "profile-preset-grid");
            presets.forEach((reference, index) => {
                row = 2 + Math.floor(index / 6);
                const control = rowButton(`preset:${index}`, `Avatar ${index + 1}`, () => { selected = index; render(`preset:${index}`); });
                control.element.className = "profile-preset";
                control.element.setAttribute("aria-pressed", String(selected === index));
                const avatar = profileAvatar({ id: `preset-${index}`, name, hasPin: false, isPrimary: false, isChild: child, avatar: reference, avatarUrl: undefined }, options.server.server.http.base.baseUrl);
                avatar.style.background = "none";
                avatar.querySelector(".navigation-avatar-fallback")?.remove();
                control.element.appendChild(avatar);
                grid.appendChild(control.element);
            });
            row = 5;
            section("Avatar", grid, shuffle.element);
        } else section("Avatar", el("p", "signin-text", "Uses your profile name"));
        const nameInput = el("input", "signin-input");
        nameInput.id = "create-profile-name";
        nameInput.setAttribute("aria-label", "Profile name");
        nameInput.value = name; nameInput.maxLength = 64; nameInput.autocomplete = "off";
        nameInput.setAttribute("data-focus", "create-name");
        controls.push({ key: "create-name", element: nameInput, row: row++, done: "create-pin" });
        section("Name", nameInput);
        const pinInput = el("input", "signin-input");
        pinInput.id = "create-profile-pin";
        pinInput.setAttribute("aria-label", "4-digit PIN");
        pinInput.type = "password"; pinInput.inputMode = "numeric"; pinInput.maxLength = 4;
        pinInput.value = pin; pinInput.autocomplete = "off";
        pinInput.setAttribute("data-focus", "create-pin");
        controls.push({ key: "create-pin", element: pinInput, row: row++, done: "create-submit" });
        section("PIN (optional)", pinInput);
        if (!bootstrap) {
            const toggle = rowButton("create-child", `Child Profile: ${child ? "On" : "Off"}`, () => { child = !child; render("create-child"); });
            row++; column.appendChild(toggle.element);
            if (child) {
                const ratings = ["G", "PG", "PG-13", "R", "NC-17"];
                const limit = rowButton("create-rating", `Content rating: ${rating}`, () => { rating = ratings[(ratings.indexOf(rating) + 1) % ratings.length] ?? "PG"; render("create-rating"); });
                row++; column.appendChild(limit.element);
                const access = rowButton("create-libraries", `Restrict libraries: ${restricted ? "On" : "Off"}`, () => { restricted = !restricted; render("create-libraries"); });
                row++; column.appendChild(access.element);
                if (restricted) {
                    const slot = el("div", "profile-library-options");
                    const firstRow = row;
                    let previous: Control[] = [];
                    drawLibraries = () => {
                        const active = document.activeElement;
                        const key = active instanceof HTMLElement ? active.dataset.focus : undefined;
                        for (const old of previous) { const index = controls.indexOf(old); if (index >= 0) controls.splice(index, 1); }
                        const content: HTMLElement[] = [];
                        previous = [];
                        if (libraries === undefined) {
                            content.push(el("p", "signin-text", librariesFailed ? "Could not load libraries." : "Loading libraries."));
                            if (librariesFailed) { const retry = { ...button("libraries-retry", "Try again", loadLibraries), row: firstRow }; previous.push(retry); content.push(retry.element); }
                        } else for (const library of libraries) {
                            const control = { ...button(`library:${library.id}`, `${library.name}: ${allowed.has(library.id) ? "Allowed" : "Blocked"}`, () => {
                                if (submitting) return;
                                if (allowed.has(library.id)) allowed.delete(library.id); else allowed.add(library.id);
                                drawLibraries?.();
                            }), row: firstRow + previous.length };
                            previous.push(control); content.push(control.element);
                        }
                        slot.replaceChildren(...content);
                        for (let index = 0; index < controls.length; index++) {
                            const control = controls[index];
                            if (control?.key === "create-submit" || control?.key === "create-cancel") controls[index] = { ...control, row: firstRow + previous.length };
                        }
                        const index = controls.findIndex(control => control.key === "create-submit");
                        controls.splice(index < 0 ? controls.length : index, 0, ...previous);
                        if (active !== null && !active.isConnected) (controls.find(control => control.key === key) ?? controls.find(control => control.key === "create-submit"))?.element.focus();
                    };
                    column.appendChild(slot);
                }
            }
        }
        const status = el("p", error === undefined ? "signin-text" : "signin-text signin-error", error ?? "");
        status.setAttribute("role", error === undefined ? "status" : "alert");
        if (error === undefined) column.appendChild(status);
        else {
            status.id = "profile-create-error";
            const field = controls.find(control => control.key === focus)?.element ?? nameInput;
            field.setAttribute("aria-describedby", status.id);
            field.after(status);
        }
        const submit = rowButton("create-submit", submitting ? "Creating profile" : "Create Profile", () => {
            name = nameInput.value; pin = pinInput.value;
            if (!name.trim()) { render("create-name", "Enter a profile name."); return; }
            if (pin !== "" && !/^\d{4}$/.test(pin)) { render("create-pin", "Enter all four PIN digits or leave the PIN empty."); return; }
            if (child && restricted && (libraries === undefined || allowed.size === 0)) { render("create-libraries", "Choose at least one library."); return; }
            const body: ProfileCreateBody = { name: name.trim(), ...(style === "initials" ? {} : { avatar: presets[selected] }), ...(pin === "" ? {} : { pin }),
                ...(!bootstrap ? { is_child: child, ...(child ? { max_content_rating: rating, library_restrictions_enabled: restricted, ...(restricted ? { allowed_library_ids: [...allowed].sort() } : {}) } : {}) } : {}) };
            submitting = true; pin = ""; pinInput.value = "";
            submit.element.textContent = "Creating profile";
            void management.create(body, controller.signal).then(profile => { if (!ended) finish(profile.id); }, (failure: unknown) => {
                if (ended) return;
                const status = failure instanceof ApiError ? failure.status : undefined;
                const certain = status !== undefined && [400, 403, 409, 422].includes(status);
                if (certain) { submitting = false; render("create-name", "The server could not create this profile. Check the name and household limits, or return to profiles."); }
                else showProblem("The request may already have created this profile. Check the profile list before trying again.");
            });
        });
        const cancel = { ...button("create-cancel", "Cancel", () => finish(undefined, submitting)), row };
        controls.push(cancel);
        column.appendChild(actions([submit, cancel]));
        const preview = el("div", "profile-create-preview");
        const updatePreview = (): void => {
            preview.replaceChildren(profileAvatar({ id: "new-profile", name, hasPin: pin !== "", isPrimary: false, isChild: child, avatarUrl: undefined, ...(style === "initials" ? {} : { avatar: presets[selected] }) }, options.server.server.http.base.baseUrl), el("h2", "profile-name", name || "New Profile"));
        };
        nameInput.addEventListener("input", () => { name = nameInput.value; updatePreview(); });
        pinInput.addEventListener("input", () => { pin = pinInput.value.replace(/\D/g, "").slice(0, 4); pinInput.value = pin; });
        updatePreview();
        const header = el("div", "profile-create-header");
        const headerCancel = { ...button("create-header-cancel", "Cancel", () => finish(undefined, submitting)), row: -1 };
        controls.unshift(headerCancel);
        header.append(el("h1", "profile-create-title", "New Profile"), headerCancel.element);
        const body = el("div", "profile-create-body"); body.append(preview, column);
        options.show({ name: "profile-create", content: [header, body], controls, focus, back: () => finish(undefined, submitting) }, focus);
        if (error !== undefined && status.isConnected) status.scrollIntoView({ block: "nearest" });
        updateLibraries = drawLibraries ?? (() => undefined);
        drawLibraries?.();
    };

    const ready = (): void => { render(); if (!bootstrap) loadLibraries(); };
    const begin = management.begin(options.profiles);
    if (begin === "ready") ready();
    else if (begin === "pin_required" && management.primaryProfile !== undefined) {
        const primary = management.primaryProfile;
        const screen = pinScreen(primary, options.server.server.http.base.baseUrl, [], pin => {
            void management.verifyPin(pin, controller.signal).then(result => {
                if (ended) return;
                if (result.status === "verified") ready();
                else screen.reject(pinProblem(result), result.status === "wrong_pin" || result.status === "locked");
            }, () => { if (!ended) screen.reject("The PIN could not be checked. Try again.", false); });
        }, () => finish());
        options.show(screen.screen);
    } else showProblem(begin === "primary_missing" ? "The primary household profile is unavailable." : "Profile management ended. Choose a profile again.");
    return { destroy };
}
