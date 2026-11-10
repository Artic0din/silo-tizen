import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { AUDIO_KEY, HDR_KEY, HIDDEN_KEY, QUALITY_KEY, BITRATE_KEY, SUBTITLE_LANGUAGE_KEY, SUBTITLE_MODE_KEY, SHOW_FORCED_KEY } from "../../src/contracts/v2/settings.ts";
import { fixture, problem } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, readLive, type Tv } from "./support/tv.ts";

const DOLBY_VISION_KEY = "player.dolby_vision_enabled";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function setup(devicePlayback = false, accountRole?: string | null) {
    const tv = await openTv(browser, { app: "browse", ...(process.env.SETTINGS_CAPTURE_DIR === undefined ? {} : { video: process.env.SETTINGS_CAPTURE_DIR }) });
    tv.fake.catalog = new FakeCatalog();
    const settings = new FakeSettings(tv.fake);
    settings.devicePlayback = devicePlayback;
    if (accountRole !== undefined) tv.fake.accountRole = accountRole;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase) === "signed_in", "sign in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount(true));
    await tv.page.locator('[data-view="home"]').waitFor();
    // Home reads title art and poster badges when it loads; let those settle before scripting settings replies.
    await tv.eventually(async () => ["keys=ui.title_art", "keys=ui.card_overlays"].every(key => tv.fake.requests.some(request => request.path.startsWith("/settings/values/effective?") && request.path.includes(key))), "Home settings reads");
    return { tv, settings };
}
async function openSettings(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).count(), 1, "avatar menu exposes Settings");
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).waitFor();
}

test("the subtitle preview draws sans-serif in the bundled semibold face", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="subtitles"]').click();
        const preview = tv.page.locator(".settings-subtitle-preview span");
        await preview.waitFor();
        const face = (): Promise<{ family: string; weight: string }> => preview.evaluate(node => {
            const style = getComputedStyle(node);
            return { family: style.fontFamily.replaceAll('"', ""), weight: style.fontWeight };
        });
        assert.deepEqual(await face(), { family: "Inter, sans-serif", weight: "600" });
        for (const [label, family] of [["Serif", "serif, sans-serif"], ["Monospace", "monospace, sans-serif"]] as const) {
            await tv.page.getByRole("button", { name: /Font Family/ }).click();
            await tv.page.getByRole("radio", { name: label, exact: true }).click();
            await tv.eventually(async () => (await face()).family === family, `${label} preview face`);
            assert.deepEqual(await face(), { family, weight: "600" });
        }
    } finally { await tv.page.context().close(); }
});

test("Settings pins its rail, resets pane scroll and keeps modal background geometry", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    try {
        await openSettings(tv);
        const rail = await tv.page.evaluate(() => {
            const first = document.querySelector<HTMLElement>('[data-focus="general"]')!;
            const second = document.querySelector<HTMLElement>('[data-focus="playback"]')!;
            return { width: first.getBoundingClientRect().width, height: first.getBoundingClientRect().height, pitch: second.getBoundingClientRect().top - first.getBoundingClientRect().top, icons: document.querySelectorAll('.settings-category-icon').length };
        });
        assert.deepEqual(rail, { width: 490, height: 82, pitch: 88, icons: 4 });
        const railDetails = await tv.page.evaluate(() => ({
            signOutIcon: document.querySelector('[data-focus="settings-signout"] svg') !== null,
            iconSize: getComputedStyle(document.querySelector('.settings-category-icon svg')!).width,
            profileGap: getComputedStyle(document.querySelector('.settings-profile')!).gap,
            versionTop: getComputedStyle(document.querySelector('.settings-version')!).marginTop,
        }));
        assert.deepEqual(railDetails, { signOutIcon: true, iconSize: "22px", profileGap: "18px", versionTop: "10px" });
        await tv.page.locator('[data-focus="subtitles"]').click();
        const appearance = await tv.page.evaluate(() => {
            const first = document.querySelector('[data-focus="appearance-fontSize"]')!.getBoundingClientRect();
            const second = document.querySelector('[data-focus="appearance-fontFamily"]')!.getBoundingClientRect();
            return { height: first.height, pitch: second.top - first.top,
                order: [...document.querySelectorAll('.settings-pane .settings-subtitle-preview, .settings-pane [data-focus^="appearance-"], .settings-pane [data-focus="reset-appearance"]')].map(node => node.getAttribute('data-focus') ?? 'preview') };
        });
        assert.equal(appearance.height, 66);
        assert.equal(appearance.pitch, 74);
        assert.deepEqual(appearance.order.slice(0, 3), ["preview", "appearance-device", "appearance-fontSize"]);
        const previewBox = await tv.page.evaluate(() => {
            const pane = document.querySelector<HTMLElement>(".settings-pane");
            const preview = document.querySelector<HTMLElement>(".settings-subtitle-preview");
            if (pane === null || preview === null) return null;
            const previous = pane.style.maxHeight;
            pane.style.maxHeight = "320px";
            const box = preview.getBoundingClientRect();
            const style = getComputedStyle(preview);
            const result = {
                height: box.height,
                width: box.width,
                flexShrink: style.flexShrink,
                minHeight: style.minHeight,
                constrained: pane.scrollHeight > pane.clientHeight,
                direction: getComputedStyle(pane).flexDirection,
            };
            pane.style.maxHeight = previous;
            return result;
        });
        assert.deepEqual(previewBox, { height: 150, width: 958, flexShrink: "0", minHeight: "150px", constrained: true, direction: "column" });
        assert.equal(appearance.order.at(-1), "reset-appearance");
        assert.equal(await tv.page.locator('[data-focus="metadata-language"]').count(), 0, "metadata AI is unavailable");
        assert.equal(await tv.page.locator('[data-focus="appearance-textOutlineColor"] .settings-row-value').textContent(), "—");
        await tv.page.locator('[data-focus="appearance-position"]').focus();
        await tv.jump(300);
        const before = await tv.page.evaluate(() => ({ rail: document.querySelector('.settings-categories')!.getBoundingClientRect().top, header: document.querySelector('.settings-pane-header')!.getBoundingClientRect().top, top: document.querySelector('.settings-pane')!.scrollTop }));
        assert.ok(before.top > 0);
        await tv.page.locator('[data-focus="appearance-position"]').click();
        assert.deepEqual(await tv.page.getByRole("radio").allTextContents(), ["Bottom", "Lower Third", "Top"]);
        assert.equal(await tv.page.getByText("Choose an option", { exact: true }).count(), 1);
        assert.equal(await tv.page.getByText("Menu to close", { exact: true }).count(), 1);
        const during = await tv.page.evaluate(() => ({ rail: document.querySelector('.settings-categories')!.getBoundingClientRect().top, header: document.querySelector('.settings-pane-header')!.getBoundingClientRect().top }));
        assert.equal(during.rail, before.rail, JSON.stringify(await tv.page.evaluate(() => [...document.querySelectorAll(".settings, .settings-panes, .settings-pane, .settings-categories")].map(n => ({name: n.className, height: n.clientHeight, scroll: n.scrollTop, rect: n.getBoundingClientRect().toJSON(), style: getComputedStyle(n).overflowY})))));
        assert.equal(during.header, before.header);
        const save = tv.fake.hold("/settings/values/playback.subtitle_appearance", true);
        await tv.page.getByRole("radio", { name: "Top", exact: true }).click();
        await tv.eventually(async () => tv.fake.requests.some(request => request.method === "PUT" && request.path.includes("playback.subtitle_appearance")), "appearance save pending");
        const savingHeader = await tv.page.locator('.settings-pane-header').evaluate(node => node.getBoundingClientRect().top);
        save.release();
        assert.equal(savingHeader, before.header, "saving rerenders keep the background pane offset");
        await tv.page.getByRole("dialog").waitFor({ state: "detached" });
        await tv.page.locator('[data-focus="general"]').click();
        assert.equal(await tv.page.locator('.settings-pane').evaluate(node => node.scrollTop), 0);
        await tv.page.locator('[data-focus="subtitles"]').click();
        assert.equal(await tv.page.locator('.settings-pane').evaluate(node => node.scrollTop), 0, "returning to a category starts at the top too");
    } finally { await tv.page.context().close(); }
});

test("remaining settings expose only honoured rows and save profile appearance", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    tv.fake.script("/capabilities/metadata-ai", { status: 200, body: { revision: "test", allowed: true, state: "available", on_view: "button" } });
    try {
        await openSettings(tv);
        assert.equal(await tv.page.getByRole("button", { name: /Poster Size/ }).count(), 1, "Poster Size row is available");
        await tv.page.getByRole("button", { name: /Poster Size/ }).click();
        await tv.page.getByRole("radio", { name: "Large", exact: true }).click();
        await tv.page.locator('[data-focus="poster-size"]').waitFor();
        assert.deepEqual(settings.device("p-owner", "client:tv").get("ui.card_presentation"), { poster_size: "large", caption: "title_metadata" });
        const posterWrite = tv.fake.requests.find(request => request.method === "PUT" && request.path.includes("ui.card_presentation"));
        assert.equal(posterWrite?.path, "/settings/values/ui.card_presentation?scope=profile_client");
        assert.equal(posterWrite?.headers["x-silo-client-family"], "tv");
        await tv.page.getByRole("switch", { name: "Show Advisory Age", exact: true }).click();
        await tv.eventually(async () => settings.profile().get("catalog.show_advisory_age") === true, "advisory profile write");
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.getByRole("button", { name: /Auto-Play Next Episode/ }).click();
        await tv.page.getByRole("radio", { name: "Off", exact: true }).click();
        await tv.page.locator('[data-focus="auto-next"]').waitFor();
        assert.equal(tv.fake.requests.find(request => request.method === "PUT" && request.path.includes("auto_play_next"))?.path, "/settings/values/playback.auto_play_next?scope=profile_device");
        assert.equal(settings.profile().has("playback.auto_play_next"), false);
        await tv.page.locator('[data-focus="subtitles"]').click();
        await tv.page.getByRole("button", { name: /Font Size/ }).click();
        await tv.page.getByRole("radio", { name: "Small", exact: true }).click();
        await tv.eventually(async () => JSON.stringify(settings.profile().get("playback.subtitle_appearance"))?.includes('"fontSize":"small"') === true, "appearance profile write");
        await tv.page.locator('[data-focus="appearance-fontSize"]').waitFor();
        const caption = await tv.page.locator(".settings-subtitle-preview span").evaluate(node => {
            const element = node as HTMLElement;
            return { fontSize: element.style.fontSize, align: getComputedStyle(element).textAlign, weight: getComputedStyle(element).fontWeight };
        });
        assert.deepEqual(caption, { fontSize: "21.5px", align: "center", weight: "600" });
        const previewLook = () => tv.page.locator(".settings-subtitle-preview").evaluate(node => {
            const box = node.getBoundingClientRect();
            const text = node.querySelector("span") as HTMLElement;
            const rect = text.getBoundingClientRect();
            const style = getComputedStyle(node);
            const textStyle = getComputedStyle(text);
            return {
                gradient: style.backgroundImage,
                border: style.borderTopWidth,
                radius: style.borderTopLeftRadius,
                padding: textStyle.padding,
                textRadius: textStyle.borderTopLeftRadius,
                centred: Math.abs((rect.left + rect.right) / 2 - (box.left + box.right) / 2) < 1,
                hugsText: rect.width < box.width / 2,
                bottomGap: Math.round(box.bottom - rect.bottom),
            };
        });
        assert.deepEqual(await previewLook(), {
            gradient: "linear-gradient(98.9deg, rgb(82, 82, 82), rgb(15, 15, 15))",
            border: "0px",
            radius: "18px",
            padding: "4px 10px",
            textRadius: "4px",
            centred: true,
            hugsText: true,
            bottomGap: 12,
        });
        assert.equal(await tv.page.locator(".settings-subtitle-preview span").evaluate(node => getComputedStyle(node).lineHeight), "25.8px", "the line scales with the Small preview size");
        await tv.page.getByRole("button", { name: /Position/ }).click();
        await tv.page.getByRole("radio", { name: "Lower Third", exact: true }).click();
        await tv.page.locator('[data-focus="appearance-position"]').waitFor();
        assert.equal((await previewLook()).bottomGap, 33);
        await tv.page.getByRole("button", { name: /Position/ }).click();
        await tv.page.getByRole("radio", { name: "Top", exact: true }).click();
        await tv.page.locator('[data-focus="appearance-position"]').waitFor();
        assert.equal(await tv.page.locator(".settings-subtitle-preview").evaluate(node => Math.round((node.querySelector("span") as Element).getBoundingClientRect().top - node.getBoundingClientRect().top)), 12);
        await tv.page.getByRole("button", { name: /Position/ }).click();
        await tv.page.getByRole("radio", { name: "Bottom", exact: true }).click();
        await tv.page.locator('[data-focus="appearance-position"]').waitFor();
        const deviceId = tv.fake.requests.find(request => request.path === "/settings/contract/capabilities")?.headers["x-silo-device-id"];
        assert.ok(deviceId);
        await tv.page.getByRole("switch", { name: "Only on This TV", exact: true }).click();
        await tv.eventually(async () => settings.device("p-owner", deviceId).has("playback.subtitle_appearance"), "device appearance copied");
        await tv.page.getByRole("button", { name: /Font Color/ }).click();
        await tv.page.getByRole("radio", { name: "Red", exact: true }).click();
        await tv.eventually(async () => JSON.stringify(settings.device("p-owner", deviceId).get("playback.subtitle_appearance"))?.includes('"fontColor":"#ef4444"') === true, "device appearance write");
        assert.deepEqual(settings.profile().get("playback.subtitle_appearance"), { fontSize: "small", position: "bottom" });
        await tv.page.locator('[data-focus="appearance-fontColor"]').waitFor();
        await tv.page.getByRole("button", { name: /Font Color/ }).click();
        await tv.remote(10009);
        await tv.page.getByRole("switch", { name: "Only on This TV", exact: true }).click();
        await tv.eventually(async () => await tv.page.getByRole("switch", { name: "Only on This TV", exact: true }).getAttribute("aria-checked") === "false", "profile appearance restored");
        assert.equal(await tv.page.getByRole("alert").count(), 0, "device reset is confirmed at the deleted scope");
        assert.deepEqual(settings.profile().get("playback.subtitle_appearance"), { fontSize: "small", position: "bottom" });
        await tv.page.getByRole("switch", { name: "Only on This TV", exact: true }).click();
        await tv.eventually(async () => await tv.page.getByRole("switch", { name: "Only on This TV", exact: true }).getAttribute("aria-checked") === "true", "device override enabled again");
        await tv.page.getByRole("button", { name: "Reset Appearance", exact: true }).click();
        await tv.page.getByRole("button", { name: "Reset", exact: true }).click();
        await tv.page.locator('[data-focus="reset-appearance"]').waitFor();
        assert.equal(JSON.stringify(settings.device("p-owner", deviceId).get("playback.subtitle_appearance")).includes('"fontSize":"large"'), true);
        assert.deepEqual(settings.profile().get("playback.subtitle_appearance"), { fontSize: "small", position: "bottom" });
        await tv.page.getByRole("button", { name: /Metadata Language/ }).click();
        await tv.page.getByRole("radio", { name: "fr", exact: true }).click();
        await tv.eventually(async () => settings.profile().get("catalog.metadata_language") === "fr", "metadata profile write");
        await tv.page.locator('[data-focus="metadata-language"]').waitFor();
        await tv.page.locator('[data-focus="server"]').click();
        await tv.page.getByText("Address", { exact: true }).waitFor();
        await tv.page.getByRole("button", { name: "Privacy Policy", exact: true }).click();
        assert.equal(await tv.page.getByRole("img", { name: "Privacy Policy QR code" }).count(), 1);
        assert.equal(await tv.page.getByRole("button", { name: /HDR|Dolby Vision|Lossless|Seek Cache/ }).count(), 0);
        assert.equal(await tv.page.locator(".settings-hdr-footer").count(), 0);
    } finally { await tv.page.context().close(); }
});

test("revision 25 subtitle rows and Show Next Up stay available without incidental writes", async () => {
    const { tv, settings } = await setup(true);
    settings.revision = 25;
    settings.profileSubtitles = true;
    const contract = fixture("settings_contract_ok");
    const definitions = [
        { key: SUBTITLE_MODE_KEY, introduced_in: 1, persistence: "remote", allowed_scopes: ["profile"], value_schema: { type: "enum", values: [{ value: "auto", label: "Auto" }, { value: "always", label: "Always" }, { value: "off", label: "Off" }] }, default_value: "auto", recommended_control: "select" },
        { key: SHOW_FORCED_KEY, introduced_in: 1, persistence: "remote", allowed_scopes: ["profile"], value_schema: { type: "boolean" }, default_value: true, recommended_control: "switch" },
        { key: "playback.next_up_prompt_seconds", introduced_in: 1, persistence: "remote", allowed_scopes: ["profile", "profile_device"], value_schema: { type: "integer", minimum: 0, maximum: 120 }, default_value: 30, recommended_control: "slider" },
    ];
    tv.fake.script("/settings/contract", { status: 200, body: { ...contract, revision: 25, definitions: [...contract.definitions as object[], ...definitions] } });
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="subtitles"]').click();
        assert.equal(await tv.page.locator('[data-focus="subtitle-mode"]').count(), 1);
        assert.equal(await tv.page.getByRole("switch", { name: "Show Forced Subtitles", exact: true }).count(), 1);
        await tv.page.locator('[data-focus="playback"]').click();
        assert.equal(await tv.page.locator('[data-focus="next-up"]').count(), 1);
        const deviceId = tv.fake.requests.find(request => request.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
        assert.ok(deviceId);
        assert.equal(settings.device("p-owner", deviceId).has("playback.next_up_prompt_seconds"), false);
        assert.equal(settings.profile().has("playback.next_up_prompt_seconds"), false);
        assert.equal(await tv.page.getByRole("alert").count(), 0);
    } finally { await tv.page.context().close(); }
});

test("Show Next Up follows Apple episode order, timing choices and profile inheritance", async () => {
    const { tv, settings } = await setup(true);
    settings.remainingRows = true;
    settings.profile().set("playback.next_up_prompt_seconds", 30);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        const episodeRows = await tv.page.locator('.settings-pane [data-focus]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")).filter(id => ["auto-next", "next-up", "skip-intros", "skip-credits"].includes(id ?? "")));
        assert.deepEqual(episodeRows, ["auto-next", "next-up", "skip-intros", "skip-credits"]);
        await tv.page.locator('[data-focus="next-up"]').click();
        assert.deepEqual(await tv.page.locator('.settings-modal button').allTextContents(), ["Use Profile Setting", "At end", "10 seconds before end", "30 seconds before end", "1 minute before end", "2 minutes before end"]);
        assert.equal(await tv.page.locator('[data-focus="reset-row"]').getAttribute("aria-checked"), "true");
        const reads = tv.fake.requests.length;
        await tv.remote(40);
        assert.equal(tv.fake.requests.length, reads);
        await tv.page.getByRole("radio", { name: "1 minute before end", exact: true }).click();
        await tv.page.locator('[data-focus="next-up"]').waitFor();
        const deviceId = tv.fake.requests.find(request => request.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
        assert.ok(deviceId);
        assert.equal(settings.device("p-owner", deviceId).get("playback.next_up_prompt_seconds"), 60);
        assert.equal(settings.profile().get("playback.next_up_prompt_seconds"), 30);
        await tv.page.locator('[data-focus="next-up"]').click();
        await tv.page.getByRole("button", { name: "Use Profile Setting", exact: true }).click();
        await tv.page.locator('[data-focus="next-up"]').waitFor();
        assert.equal(settings.device("p-owner", deviceId).has("playback.next_up_prompt_seconds"), false);
        assert.match(await tv.page.locator('[data-focus="next-up"]').innerText(), /30 seconds before end/);
        assert.equal(await tv.focused(), "next-up");
    } finally { await tv.page.context().close(); }
});

for (const failFirst of [false, true]) test(`Playback profile reset confirms and clears device overrides with retry=${failFirst}`, async () => {
    const { tv, settings } = await setup(true);
    settings.profile().set(QUALITY_KEY, "720p");
    const deviceId = tv.fake.requests.find(request => request.headers['x-silo-device-id'])?.headers['x-silo-device-id'];
    assert.ok(deviceId);
    const device = settings.device('p-owner', deviceId);
    device.set(QUALITY_KEY, "1080p");
    device.set(BITRATE_KEY, 1500);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.getByRole('button', { name: 'Use Profile Settings', exact: true }).click();
        assert.equal(await tv.focused(), 'cancel-playback-reset');
        await tv.remote(10009);
        assert.equal(device.get(QUALITY_KEY), '1080p');
        await tv.page.getByRole('button', { name: 'Use Profile Settings', exact: true }).click();
        if (failFirst) tv.fake.script(`/settings/values/${QUALITY_KEY}?scope=profile_device`, problem(503, 'unavailable', 'Try again'));
        await tv.page.getByRole('button', { name: 'Reset', exact: true }).click();
        if (failFirst) {
            await tv.page.getByRole('button', { name: 'Check and retry', exact: true }).waitFor();
            await tv.jump(5000);
            await tv.page.getByRole('button', { name: 'Check and retry', exact: true }).click();
        }
        await tv.eventually(async () => !device.has(QUALITY_KEY) && !device.has(BITRATE_KEY), 'device playback reset');
        assert.equal(settings.profile().get(QUALITY_KEY), '720p');
        assert.ok(tv.fake.requests.filter(r => r.method === 'DELETE').every(r => r.path.includes('scope=profile_device')));
    } finally { await tv.page.context().close(); }
});

test("measured Settings pickers centre the selected choice and privacy handoff", async () => {
    const { tv, settings } = await setup(true);
    settings.remainingRows = true;
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="remember-profile"]').click();
        assert.equal(await tv.page.getByRole("dialog").count(), 1);
        assert.equal(await tv.page.getByRole("radio", { checked: true }).evaluate(node => node === document.activeElement), true);
        assert.equal(await tv.page.getByRole("dialog").getByText("Show Who's Watching whenever you return to Silo.", { exact: true }).count(), 1);
        assert.equal(await tv.page.locator('.settings-checkmark').count(), 1);
        await tv.remote(10009);
        assert.equal(await tv.focused(), "remember-profile");
        assert.equal(await tv.page.locator('[data-focus="settings-back"]').count(), 0);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="quality"]').click();
        assert.equal(await tv.page.locator('.settings-modal [data-focus]').first().getAttribute("data-focus"), "reset");
        assert.equal(await tv.focused(), "reset");
        await tv.remote(10009);
        await tv.page.locator('[data-focus="server"]').click();
        await tv.page.locator('[data-focus="privacy"]').click();
        assert.equal(await tv.page.getByRole("dialog").count(), 1);
        assert.equal(await tv.focused(), "back", "Privacy Done keeps initial focus inside the text column");
        assert.equal(await tv.page.locator('.settings-privacy-copy [data-focus="back"]').count(), 1);
        const hand = await tv.page.locator('.settings-privacy-copy > svg path').evaluate(node => {
            const bounds = (node as SVGGraphicsElement).getBBox();
            return { y: bounds.y, height: bounds.height };
        });
        assert.ok(hand.y >= 0 && hand.y + hand.height <= 24, "the hand stays inside its icon viewBox");
        assert.equal(await tv.page.getByText("Scan this code with your phone or tablet to read Silo's privacy policy.", { exact: true }).count(), 1);
        await tv.remote(10009);
        assert.equal(await tv.focused(), "privacy");
        await tv.page.locator('[data-focus="subtitles"]').click();
        await tv.page.getByRole("button", { name: /Text Opacity/ }).click();
        const selected = tv.page.getByRole("radio", { name: "100%", exact: true });
        const inList = async (): Promise<boolean> => selected.evaluate(node => {
            const list = node.closest(".settings-modal-options");
            if (list === null) return false;
            const bounds = node.getBoundingClientRect();
            const viewport = list.getBoundingClientRect();
            return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
        });
        await tv.jump(250);
        assert.equal(await inList(), true, "selected option opens inside its scroll viewport");
        for (let index = 0; index < 19; index++) await tv.remote(38);
        for (let index = 0; index < 19; index++) await tv.remote(40);
        await tv.jump(250);
        assert.equal(await tv.focused(), "choice:100");
        assert.equal(await inList(), true, "remote movement reveals the last option");
    } finally { await tv.page.context().close(); }
});

test("a settling poster save preserves navigation after leaving its picker", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    const held = tv.fake.hold("/settings/values/ui.card_presentation", true);
    try {
        await openSettings(tv);
        await tv.page.getByRole("button", { name: /Poster Size/ }).click();
        await tv.page.getByRole("radio", { name: "Large", exact: true }).click();
        await tv.eventually(async () => tv.fake.requests.some(request => request.method === "PUT" && request.path.includes("ui.card_presentation")), "poster save waiting");
        await tv.remote(10009);
        await tv.page.locator('[data-focus="server"]').click();
        await tv.page.locator('[data-focus="privacy"]').focus();
        const pane = await tv.page.locator(".settings-pane").elementHandle();
        held.release();
        await tv.eventually(async () => settings.device("p-owner", "client:tv").has("ui.card_presentation"), "poster save settled");
        await tv.page.getByRole("status").waitFor({ state: "detached" });
        await tv.page.waitForFunction(node => node !== null && !node.isConnected, pane);
        await tv.jump(0);
        assert.equal(await tv.focused(), "privacy");
    } finally { held.release(); await tv.page.context().close(); }
});

test("appearance edits reject an intervening change instead of replacing unrelated fields", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    settings.profile().set("playback.subtitle_appearance", { fontSize: "small" });
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="subtitles"]').click();
        await tv.page.getByRole("button", { name: /Font Color/ }).click();
        settings.profile().set("playback.subtitle_appearance", { fontSize: "large" });
        await tv.page.getByRole("radio", { name: "Red", exact: true }).click();
        await tv.page.getByRole("alert").filter({ hasText: "The setting changed on another device." }).waitFor();
        assert.deepEqual(settings.profile().get("playback.subtitle_appearance"), { fontSize: "large" });
        assert.equal(tv.fake.requests.filter(request => request.method === "PUT" && request.path.includes("subtitle_appearance")).length, 0);
    } finally { await tv.page.context().close(); }
});

test("poster controls are omitted when the server cannot resolve the TV client family", async () => {
    for (const missing of ["family", "batch", "shortcuts"] as const) {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    if (missing === "family") settings.clientFamilies = [];
    if (missing === "batch") settings.supportsBatchedEffective = false;
    if (missing === "shortcuts") settings.supportsAtomicShortcuts = false;
    try {
        await openSettings(tv);
        assert.equal(await tv.page.locator('[data-focus="poster-size"]').count(), 0);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="quality"]').waitFor();
    } finally { await tv.page.context().close(); }
    }
});

test("Show Advisory Age controls the detail badge when the server supplies an age", async () => {
    for (const enabled of [false, true]) {
        const { tv, settings } = await setup();
        settings.profile().set("catalog.show_advisory_age", enabled);
        await tv.page.route("**/catalog/items/movie%3Am0001*", async route => { await route.fulfill({ status: 200, json: { ...fixture("get_catalog_item_ok"), content_id: "movie:m0001", advisory_age: 13 } }); });
        try {
            await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').focus();
            await tv.page.keyboard.press("Enter");
            await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
            const chip = tv.page.locator(".details-editorial [data-advisory-age]");
            if (enabled) {
                await chip.waitFor();
                assert.equal(await chip.textContent(), "13+");
                assert.equal(await tv.page.locator(".details-editorial .browse-meta").count(), 1);
            } else {
                await tv.page.locator(".details-editorial .browse-meta").waitFor();
                assert.equal(await chip.count(), 0);
            }
        } finally { await tv.page.context().close(); }
    }
});

test("Use Synced TV Settings removes only the older poster device override", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    const deviceId = tv.fake.requests.find(request => request.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
    assert.ok(deviceId);
    settings.device("p-owner", deviceId).set("ui.card_presentation", { poster_size: "compact", caption: "title_metadata" });
    settings.device("p-owner", "client:tv").set("ui.card_presentation", { poster_size: "large", caption: "title_metadata" });
    try {
        await openSettings(tv);
        assert.equal(await tv.page.locator('[data-focus="poster-size"]').getAttribute("aria-disabled"), "true");
        await tv.page.getByRole("button", { name: "Use Synced TV Settings", exact: true }).click();
        await tv.eventually(async () => !settings.device("p-owner", deviceId).has("ui.card_presentation"), "older device override cleared");
        assert.equal(settings.device("p-owner", "client:tv").has("ui.card_presentation"), true);
        assert.equal(await tv.page.getByRole("button", { name: "Use Profile Default", exact: true }).count(), 1);
        await tv.page.getByRole("button", { name: "Use Profile Default", exact: true }).click();
        await tv.eventually(async () => !settings.device("p-owner", "client:tv").has("ui.card_presentation"), "TV-family override cleared");
    } finally { await tv.page.context().close(); }
});

test("profile subtitle editors read and compare profile values while narrower overrides remain active", async () => {
    const { tv, settings } = await setup();
    settings.profileSubtitles = true;
    settings.profile().set(SUBTITLE_LANGUAGE_KEY, "en");
    settings.profile().set(SUBTITLE_MODE_KEY, "always");
    settings.profile().set(SHOW_FORCED_KEY, false);
    settings.overrides.set(SUBTITLE_LANGUAGE_KEY, "fr");
    settings.overrides.set(SUBTITLE_MODE_KEY, "off");
    settings.overrides.set(SHOW_FORCED_KEY, true);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="subtitles"]').click();
        assert.equal(await tv.page.locator('[data-focus="subtitle-language"] .settings-row-value').textContent(), "en");
        assert.equal(await tv.page.locator('[data-focus="subtitle-mode"] .settings-row-value').textContent(), "Always");
        assert.equal(await tv.page.locator('[data-focus="subtitle-forced"]').getAttribute("aria-checked"), "false");
        await tv.page.locator('[data-focus="subtitle-language"]').click();
        assert.equal(await tv.page.getByRole("radio", { name: "en", exact: true }).getAttribute("aria-checked"), "true");
        await tv.page.getByRole("radio", { name: "fr", exact: true }).click();
        await tv.page.locator('[data-focus="subtitle-language"]').waitFor();
        assert.equal(settings.profile().get(SUBTITLE_LANGUAGE_KEY), "fr", "a value equal to the override still updates the profile");
        await tv.page.locator('[data-focus="subtitle-mode"]').click();
        await tv.page.getByRole("radio", { name: "Off", exact: true }).click();
        await tv.page.locator('[data-focus="subtitle-mode"]').waitFor();
        assert.equal(settings.profile().get(SUBTITLE_MODE_KEY), "off");
        await tv.page.locator('[data-focus="subtitle-forced"]').click();
        await tv.eventually(async () => settings.profile().get(SHOW_FORCED_KEY) === true, "toggle the profile value");
        assert.equal(settings.overrides.get(SUBTITLE_LANGUAGE_KEY), "fr");
        assert.equal(settings.overrides.get(SUBTITLE_MODE_KEY), "off");
        assert.equal(settings.overrides.get(SHOW_FORCED_KEY), true);
        await tv.page.getByText(/Override active/).waitFor();
    } finally { await tv.page.context().close(); }
});

test("Profile Selection caption follows the chosen launch behavior", async () => {
    const { tv } = await setup();
    const captions = {
        "Every Time": "Show Who's Watching whenever you return to Silo.",
        "After 1 Hour": "Show Who's Watching when you've been away from Silo for 1 hour.",
        "After 12 Hours": "Show Who's Watching when you've been away from Silo for 12 hours.",
        Automatic: "Use the profile selected for the current TV user. A protected profile can reopen without asking for its PIN.",
    } as const;
    try {
        await openSettings(tv);
        const caption = async (): Promise<string | null> => tv.page.locator('[data-focus="remember-profile"] + .settings-value').textContent();
        assert.equal(await caption(), captions["Every Time"]);
        for (const [name, text] of Object.entries(captions)) {
            if (name === "Every Time") continue;
            await tv.page.locator('[data-focus="remember-profile"]').click();
            if (name === "Automatic") {
                assert.equal(await tv.page.getByRole("dialog").locator(".settings-option-detail").nth(0).textContent(), text);
            }
            await tv.page.getByRole("radio", { name, exact: true }).click();
            await tv.eventually(async () => await caption() === text, `${name} caption`);
        }
    } finally { await tv.page.context().close(); }
});

test("Settings pane spacing matches Apple's section gaps", async () => {
    const { tv, settings } = await setup();
    settings.profileSubtitles = true;
    try {
        await openSettings(tv);
        const general = await tv.page.evaluate(() => {
            const header = document.querySelector(".settings-pane-header");
            const user = document.querySelector(".settings-pane > .settings-section-header");
            const paired = document.querySelector('[data-focus="paired-profile"]');
            const footer = document.querySelector('[data-focus="paired-profile"] + .settings-value');
            const launch = [...document.querySelectorAll(".settings-pane > .settings-section-header")].find(node => node.textContent === "PROFILE AT LAUNCH");
            const titleArt = document.querySelector('[data-focus="title-art"]');
            const titleArtAll = document.querySelector('[data-focus="title-art-all"]');
            if (!header || !user || !paired || !footer || !launch || !titleArt || !titleArtAll) return null;
            const userStyle = getComputedStyle(user);
            const footerStyle = getComputedStyle(footer);
            const launchStyle = getComputedStyle(launch);
            const box = (node: Element) => node.getBoundingClientRect();
            const textTop = (node: Element): number => node.getBoundingClientRect().top + parseFloat(getComputedStyle(node).paddingTop);
            const labels = [...document.querySelectorAll(".settings-pane > .settings-section-header")];
            const captionHeight = box(footer).height - parseFloat(footerStyle.paddingTop) - parseFloat(footerStyle.paddingBottom);
            return {
                headerToSectionText: box(user).top + parseFloat(userStyle.paddingTop) - box(header).bottom,
                sectionPaddingTop: userStyle.paddingTop,
                sectionPaddingBottom: userStyle.paddingBottom,
                sectionToRow: box(paired).top - box(user).bottom,
                rowToFooterText: box(footer).top + parseFloat(footerStyle.paddingTop) - box(paired).bottom,
                footerPaddingTop: footerStyle.paddingTop,
                footerLineHeight: footerStyle.lineHeight,
                footerToNextSectionText: box(launch).top + parseFloat(launchStyle.paddingTop) - box(footer).bottom,
                rowPitch: box(titleArtAll).top - box(titleArt).bottom,
                sectionText: labels.slice(0, 3).map(textTop),
                firstRow: box(paired).top,
                captionHeight,
            };
        });
        assert.deepEqual(general, {
            headerToSectionText: 52,
            sectionPaddingTop: "26px",
            sectionPaddingBottom: "6px",
            sectionToRow: 8,
            rowToFooterText: 12,
            footerPaddingTop: "4px",
            footerLineHeight: "23px",
            footerToNextSectionText: 34,
            rowPitch: 8,
            sectionText: [240, 458, 630],
            firstRow: 277,
            captionHeight: 69,
        });
        await tv.page.locator('[data-focus="playback"]').click();
        const playback = await tv.page.evaluate(() => {
            const header = document.querySelector(".settings-pane > .settings-section-header");
            const row = document.querySelector('[data-focus="quality"]');
            if (!header || !row) return null;
            return { gap: row.getBoundingClientRect().top - header.getBoundingClientRect().bottom, row: row.getBoundingClientRect().top };
        });
        assert.deepEqual(playback, { gap: 8, row: 277 });
        await tv.page.locator('[data-focus="subtitles"]').click();
        const subtitles = await tv.page.evaluate(() => document.querySelector('[data-focus="subtitle-language"]')?.getBoundingClientRect().top ?? null);
        assert.equal(subtitles, 277);
    } finally { await tv.page.context().close(); }
});

test("Settings rows use Apple's regular label and resting stroke", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        const row = await tv.page.locator('[data-focus="title-art"]').evaluate(node => {
            const style = getComputedStyle(node);
            const on = getComputedStyle(node.querySelector(".settings-row-value")!);
            const off = getComputedStyle(document.querySelector('[data-focus="title-art-all"] .settings-row-value')!);
            const offRow = document.querySelector('[data-focus="title-art-all"]')!;
            return { weight: style.fontWeight, border: style.borderTopWidth, borderColor: style.borderTopColor, on: on.fontWeight, off: off.fontWeight, onOpacity: on.opacity, offOpacity: off.opacity, fill: style.backgroundColor, offFill: getComputedStyle(offRow).backgroundColor };
        });
        // Colors.swift:70 siloChromeRestingFill, and TVSettingsToggleRow's opacity for each state.
        assert.deepEqual(row, { weight: "400", border: "1px", borderColor: "rgba(255, 255, 255, 0.09)", on: "600", off: "400", onOpacity: "0.9", offOpacity: "0.55", fill: "rgba(255, 255, 255, 0.07)", offFill: "rgba(255, 255, 255, 0.07)" });
    } finally { await tv.page.context().close(); }
});

test("Title Art caption uses Apple's sentence for the current scope", async () => {
    const { tv } = await setup();
    const device = "Use logo artwork as the title when available. Only affects this TV. Your other devices keep their own setting.";
    const every = (state: "on" | "off"): string => `Title art is ${state} on every device signed into this profile. Changing it here changes it everywhere. Turn off Apply to All Devices to choose for this TV only.`;
    try {
        await openSettings(tv);
        const caption = async (): Promise<string | null> => tv.page.locator('[data-focus="title-art-all"] + .settings-value').textContent();
        assert.equal(await caption(), device);
        await tv.page.getByRole("switch", { name: "Apply to All Devices", exact: true }).click();
        await tv.eventually(async () => await caption() === every("on"), "profile title art caption");
        await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).click();
        await tv.eventually(async () => await caption() === every("off"), "title art off caption");
    } finally { await tv.page.context().close(); }
});

test("Paired Silo Profile shows the profile this TV reopens and opens the profile picker", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        assert.equal(await tv.page.locator(".settings-section-header").first().textContent(), "TV USER");
        assert.equal(await tv.page.locator('[data-focus="paired-profile"] .settings-row-value').textContent(), "Not paired");
        await tv.page.getByText("This TV user context is not set to keep separate app preferences. Silo uses the profile pairing available to the current app context, and you can change it here at any time. Ask Every Time is on, so Silo will still show Who's Watching at launch.", { exact: true }).waitFor();
        await tv.page.locator('[data-focus="remember-profile"]').click();
        await tv.page.getByRole("radio", { name: "Automatic", exact: true }).click();
        await tv.eventually(async () => await tv.page.locator('[data-focus="paired-profile"] .settings-row-value').textContent() === "Laura", "remembered profile name");
        assert.equal(await tv.page.getByText(/Ask Every Time is on/).count(), 0);
        await tv.page.locator('[data-focus="paired-profile"]').click();
        assert.equal(await tv.page.evaluate(() => window.browseHarness.chooseProfileCalls.length), 1);
        assert.equal(await tv.page.locator(".settings").count(), 0);
    } finally { await tv.page.context().close(); }
});

test("Subtitles, the profile account line and sign-out confirmation follow Apple TV", async () => {
    const { tv, settings } = await setup();
    settings.profileSubtitles = true;
    try {
        await openSettings(tv);
        assert.deepEqual(await tv.page.locator(".settings-categories [data-focus]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["settings-profile", "general", "playback", "subtitles", "server", "settings-signout"]);
        const profile = tv.page.locator('[data-focus="settings-profile"]');
        assert.equal(await profile.locator(".settings-profile-name").textContent(), "Laura");
        assert.equal(await profile.locator(".settings-profile-account").textContent(), "laura");
        assert.equal(await tv.page.locator(".settings-version").textContent(), "Silo 0.0.1");
        assert.equal(await tv.page.getByRole("button", { name: /Diagnostics/ }).count(), 0);
        assert.equal(await tv.page.locator('[data-focus="subtitles"] .settings-category-detail').textContent(), "Language and appearance");
        await tv.page.locator('[data-focus="subtitles"]').click();
        assert.equal(await tv.page.locator(".settings-blurb").textContent(), "Language, behavior, and on-screen appearance.");
        assert.equal(await tv.page.locator('[data-focus="subtitle-language"] .settings-row-value').textContent(), "None");
        assert.equal(await tv.page.locator('[data-focus="subtitle-mode"] .settings-row-value').textContent(), "Auto");
        assert.equal(await tv.page.locator('[data-focus="subtitle-forced"]').getAttribute("aria-checked"), "true");
        await tv.page.getByText("Used to pick a matching track when one is available. Forced subtitles cover foreign-language dialogue even when subtitles are off or set to auto.", { exact: true }).waitFor();
        await tv.page.locator('[data-focus="subtitle-language"]').click();
        await tv.page.getByRole("radio", { name: "en", exact: true }).click();
        await tv.page.locator('[data-focus="subtitle-language"]').waitFor();
        assert.equal(settings.profile().get(SUBTITLE_LANGUAGE_KEY), "en");
        assert.equal(await tv.page.locator('[data-focus="subtitle-language"] .settings-row-value').textContent(), "en");
        await tv.page.locator('[data-focus="subtitle-mode"]').click();
        assert.deepEqual(await tv.page.getByRole("radio").allTextContents(), ["Auto", "Always", "Off"]);
        await tv.page.getByRole("radio", { name: "Always", exact: true }).click();
        await tv.page.locator('[data-focus="subtitle-mode"]').waitFor();
        assert.equal(settings.profile().get(SUBTITLE_MODE_KEY), "always");
        await tv.page.locator('[data-focus="subtitle-forced"]').click();
        await tv.eventually(async () => settings.profile().get(SHOW_FORCED_KEY) === false, "forced subtitles off");
        assert.equal(tv.fake.requests.filter(request => request.method === "PUT" && request.path.startsWith(`/settings/values/${SHOW_FORCED_KEY}?scope=profile`)).length, 1);
        await tv.page.locator('[data-focus="settings-signout"]').click();
        await tv.page.getByRole("heading", { name: "Sign out of laura on this server?" }).waitFor();
        await tv.page.getByText("This account's profiles and settings leave this TV, and this server will be removed from it.", { exact: true }).waitFor();
        assert.equal(await tv.focused(), "cancel-signout");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Apple Settings rail enters the first row, shows separate values and restores modal focus", async () => {
    const { tv } = await setup(true);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').focus();
        await tv.remote(39);
        assert.equal(await tv.page.locator(":focus").getAttribute("data-focus"), "quality");
        assert.equal(await tv.page.locator('[data-focus="quality"] .settings-row-title').textContent(), "Resolution");
        assert.equal(await tv.page.locator('[data-focus="quality"] .settings-row-value').textContent(), "Auto");
        await tv.page.locator('[data-focus="bitrate"]').click();
        await tv.page.getByRole("radio", { name: "6 Mbps", exact: true }).click();
        await tv.page.locator('[data-focus="bitrate"]').waitFor();
        assert.equal(await tv.page.locator(":focus").getAttribute("data-focus"), "bitrate");
        assert.equal(await tv.page.locator('[data-focus="bitrate"] .settings-row-value').textContent(), "6 Mbps");
        await tv.remote(37);
        await tv.remote(39);
        assert.equal(await tv.page.locator(":focus").getAttribute("data-focus"), "quality");
        await tv.page.locator('[data-focus="settings-signout"]').click();
        await tv.page.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(await tv.page.locator(":focus").getAttribute("data-focus"), "settings-signout");
        assert.equal(await tv.page.getByText(/Silo 0\.0\.1/).count(), 1);
        assert.equal(await tv.page.getByRole("button", { name: /nav.*menu|synced.*menu/i }).count(), 0);
    } finally { await tv.page.context().close(); }
});

test("Settings profile and confirmed sign out use the existing browse callbacks", async () => {
    const first = await setup();
    try {
        await openSettings(first.tv);
        await first.tv.page.locator('[data-focus="settings-profile"]').click();
        assert.equal(await first.tv.page.evaluate(() => window.browseHarness.chooseProfileCalls.length), 1);
        assert.equal(await first.tv.page.locator(".settings").count(), 0);
    } finally { await first.tv.page.context().close(); }
    const second = await setup();
    try {
        await openSettings(second.tv);
        await second.tv.page.locator('[data-focus="settings-signout"]').click();
        assert.equal(await second.tv.focused(), "cancel-signout");
        await second.tv.page.keyboard.press("ArrowUp");
        assert.equal(await second.tv.focused(), "cancel-signout");
        await second.tv.page.locator('[data-focus="confirm-signout"]').click();
        assert.equal(await second.tv.page.evaluate(() => window.browseHarness.signOutCalls), 1);
        assert.equal(await second.tv.page.locator(".settings").count(), 0);
    } finally { await second.tv.page.context().close(); }
});

test("device pickers preserve profile, show inheritance, retain legacy audio null and survive Back/reentry", async () => {
    const { tv, settings } = await setup(true);
    try {
        const deviceId = tv.fake.requests.find(r => r.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
        assert.ok(deviceId);
        const device = settings.device("p-owner", deviceId);
        settings.profile().set(AUDIO_KEY, "fr");
        settings.profile().set(QUALITY_KEY, "1080p");
        settings.profile().set(BITRATE_KEY, 6000);
        device.set(AUDIO_KEY, "yue-Hant-HK");
        device.set(QUALITY_KEY, "480p");
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="audio"]').click();
        assert.equal(await tv.page.locator('[data-focus="audio:yue-Hant-HK"]').getAttribute("aria-checked"), "true");
        assert.equal(await tv.page.locator('[data-focus="audio:null"]').count(), 0);
        await tv.page.getByRole("radio", { name: "Use Profile Setting", exact: true }).click();
        await tv.page.locator('[data-focus="audio"]').waitFor();
        assert.equal(device.has(AUDIO_KEY), false);
        assert.equal(settings.profile().get(AUDIO_KEY), "fr");
        await tv.page.locator('[data-focus="quality"]').click();
        await tv.page.getByRole("radio", { name: "720p", exact: true }).click();
        await tv.page.locator('[data-focus="quality"]').waitFor();
        assert.equal(device.get(QUALITY_KEY), "720p");
        assert.equal(settings.profile().get(QUALITY_KEY), "1080p");
        await tv.page.locator('[data-focus="bitrate"]').click();
        await tv.page.getByRole("button", { name: "No limit", exact: true }).click();
        await tv.page.locator('[data-focus="bitrate"]').waitFor();
        assert.equal(device.has(BITRATE_KEY), true);
        assert.equal(device.get(BITRATE_KEY), null);
        await tv.page.locator('[data-focus="bitrate"]').click();
        await tv.page.getByRole("radio", { name: "Use Profile Setting", exact: true }).click();
        await tv.page.locator('[data-focus="bitrate"]').waitFor();
        assert.equal(device.has(BITRATE_KEY), false);
        assert.equal(settings.profile().get(BITRATE_KEY), 6000);
        await tv.remote(10009);
        await tv.remote(10009);
        device.set(AUDIO_KEY, null);
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="audio"]').click();
        assert.equal(await tv.page.locator('[data-focus="audio:null"]').getAttribute("aria-checked"), "true");
        await tv.page.locator('[data-focus="audio:null"]').click();
        await tv.page.locator('[data-focus="audio"]').waitFor();
        assert.equal(device.has(AUDIO_KEY), true);
        assert.equal(device.get(AUDIO_KEY), null);
        await tv.page.locator('[data-focus="quality"]').click();
        assert.equal(await tv.page.locator('[data-focus="quality:720p"]').getAttribute("aria-checked"), "true");
        await tv.page.getByRole("radio", { name: "Use Profile Setting", exact: true }).click();
        await tv.page.locator('[data-focus="quality"]').waitFor();
        assert.equal(await tv.page.locator('[data-focus="quality"] .settings-row-value').textContent(), "1080p");
        assert.equal(device.has(QUALITY_KEY), false);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("quality footer and bitrate labels follow Apple TV", async () => {
    const { tv, settings } = await setup();
    settings.profile().set(QUALITY_KEY, "2160p");
    settings.profile().set(BITRATE_KEY, 999);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        const footer = "Plays the original file up to 4K. Larger files are converted. Files above this bitrate are converted to fit.";
        await tv.page.getByText(footer, { exact: true }).waitFor();
        assert.equal(await tv.page.locator('[data-focus="bitrate"] .settings-row-value').textContent(), "999 kbps");
        assert.equal(await tv.page.locator('[data-focus="quality"] .settings-row-value').textContent(), "4K");
        const order = await tv.page.evaluate(() => {
            const bitrate = document.querySelector('[data-focus="bitrate"]');
            const note = document.querySelector(".settings-quality-footer");
            const streaming = [...document.querySelectorAll(".settings-section-header")].find(node => node.textContent === "STREAMING");
            if (bitrate === null || note === null || streaming === undefined) return false;
            return Boolean(bitrate.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING)
                && Boolean(note.compareDocumentPosition(streaming) & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        assert.equal(order, true);
        await tv.page.locator('[data-focus="bitrate"]').click();
        const dialog = tv.page.getByRole("dialog", { name: "Maximum Bitrate" });
        await dialog.waitFor();
        const choices = await dialog.locator('.settings-modal-options [data-focus^="bitrate:"], .settings-modal-options [data-focus="no-limit"]').allTextContents();
        assert.deepEqual(choices, ["No limit", "200 Mbps", "100 Mbps", "60 Mbps", "40 Mbps", "20 Mbps", "15 Mbps", "10 Mbps", "6 Mbps", "4 Mbps", "2 Mbps", "1.5 Mbps", "999 kbps"]);
        assert.equal(await dialog.locator('[data-focus="bitrate:999"]').getAttribute("aria-checked"), "true");
        assert.equal(await dialog.getByRole("textbox").count(), 0);
        assert.equal(await dialog.getByRole("button", { name: "Save", exact: true }).count(), 0);
    } finally { await tv.page.context().close(); }
});

test("Playback restores video skip intervals after episodes and focus moves do not write settings", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        assert.equal(await tv.page.locator('[data-focus="seek-back"], [data-focus="seek-forward"]').count(), 2);
        assert.deepEqual(await tv.page.locator(".settings-section-header").allTextContents(), ["QUALITY", "STREAMING", "EPISODES", "SPOILERS", "VIDEO"]);
        const requests = tv.fake.requests.length;
        await tv.page.locator('[data-focus="quality"]').focus();
        await tv.remote(40); await tv.remote(40);
        assert.equal(tv.fake.requests.length, requests);
        assert.equal(tv.fake.requests.filter(r => r.method === "PUT" || r.method === "DELETE").length, 0);
    } finally { await tv.page.context().close(); }
});

test("Settings uses the measured Apple pane margins and borderless sign out", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        const geometry = await readLive(tv, () => {
            const rail = document.querySelector('[data-focus="general"]');
            const row = document.querySelector('[data-focus="title-art"]');
            const header = document.querySelector('.settings-pane-header');
            const signout = document.querySelector('[data-focus="settings-signout"]');
            if (!rail?.isConnected || !row?.isConnected || !header?.isConnected || !signout?.isConnected) return null;
            const signoutBox = signout.getBoundingClientRect();
            return { rail: rail.getBoundingClientRect().x, row: row.getBoundingClientRect().x, width: row.getBoundingClientRect().width, header: header.getBoundingClientRect().y, signoutX: signoutBox.x, signoutY: signoutBox.y, signoutWidth: signoutBox.width, signoutHeight: signoutBox.height, border: getComputedStyle(signout).borderWidth };
        }, null, () => true, "live Settings geometry");
        assert.deepEqual(geometry, { rail: 164, row: 728, width: 1006, header: 108, signoutX: 192, signoutY: 842, signoutWidth: 150, signoutHeight: 33, border: "0px" });
    } finally { await tv.page.context().close(); }
});

test("Settings rail rows are unframed at rest and on focus", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        const focused = await readLive(tv, () => {
            const row = document.querySelector<HTMLElement>('[data-focus="general"]');
            if (row === null || document.activeElement !== row) return null;
            const style = getComputedStyle(row);
            return { border: style.borderTopWidth, background: style.backgroundColor, color: style.color, width: row.getBoundingClientRect().width, height: row.getBoundingClientRect().height };
        }, null, () => true, "focused rail row");
        assert.deepEqual(focused, { border: "0px", background: "rgb(237, 237, 237)", color: "rgb(0, 0, 0)", width: 490, height: 82 });
        const resting = await tv.page.locator('[data-focus="server"]').evaluate(node => {
            const style = getComputedStyle(node);
            return { border: style.borderTopWidth, background: style.backgroundColor };
        });
        assert.deepEqual(resting, { border: "0px", background: "rgba(0, 0, 0, 0)" });
        await tv.page.keyboard.press("ArrowRight");
        const selected = await tv.page.locator('[data-focus="general"]').evaluate(node => {
            const style = getComputedStyle(node);
            return { border: style.borderTopWidth, background: style.backgroundColor, current: node.getAttribute("aria-current") };
        });
        assert.deepEqual(selected, { border: "0px", background: "rgba(255, 255, 255, 0.14)", current: "page" });
    } finally { await tv.page.context().close(); }
});

test("Playback reset is red with an icon at rest and while focused", async () => {
    const { tv, settings } = await setup(true);
    const deviceId = tv.fake.requests.find(request => request.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
    assert.ok(deviceId);
    settings.device("p-owner", deviceId).set(QUALITY_KEY, "1080p");
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        const reset = tv.page.locator('[data-focus="reset-playback"]');
        await reset.waitFor();
        const resting = await reset.evaluate(node => {
            const style = getComputedStyle(node);
            return { color: style.color, icon: node.querySelector("svg") !== null, name: node.textContent };
        });
        assert.deepEqual(resting, { color: "rgb(176, 0, 32)", icon: true, name: "Use Profile Settings" });
        await focusPaneRow(tv, "reset-playback");
        const focused = await readLive(tv, () => {
            const row = document.querySelector<HTMLElement>('[data-focus="reset-playback"]');
            if (row === null || document.activeElement !== row) return null;
            const style = getComputedStyle(row);
            return { color: style.color, background: style.backgroundColor };
        }, null, () => true, "focused playback reset");
        assert.deepEqual(focused, { color: "rgb(210, 47, 63)", background: "rgb(237, 237, 237)" });
    } finally { await tv.page.context().close(); }
});

test("Administrator is shown for an admin role and a missing role stays the account name", async () => {
    const admin = await setup(false, "admin");
    try {
        await openSettings(admin.tv);
        assert.equal(await admin.tv.page.locator(".settings-profile-name").textContent(), "Laura");
        assert.equal(await admin.tv.page.locator(".settings-profile-account").textContent(), "Administrator");
    } finally { await admin.tv.page.context().close(); }
    const missing = await setup(false, null);
    try {
        await openSettings(missing.tv);
        assert.equal(await missing.tv.page.locator(".settings-profile-name").textContent(), "Laura");
        assert.equal(await missing.tv.page.locator(".settings-profile-account").textContent(), "laura");
    } finally { await missing.tv.page.context().close(); }
});

async function focusPaneRow(tv: Tv, key: string): Promise<void> {
    await tv.page.keyboard.press("ArrowRight");
    for (let step = 0; step < 40 && await tv.focused() !== key; step += 1) await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), key);
    await tv.jump(400);
}

test("Subtitles keeps its descriptive footer visible below Reset", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="subtitles"]').click();
        await focusPaneRow(tv, "reset-appearance");
        const visible = await readLive(tv, () => {
            const footer = document.querySelector('.settings-appearance-footer');
            const pane = document.querySelector<HTMLElement>('.settings-pane');
            if (!footer?.isConnected || !pane?.isConnected) return null;
            return { bottom: footer.getBoundingClientRect().bottom, paneBottom: pane.getBoundingClientRect().bottom, scrollTop: pane.scrollTop, max: pane.scrollHeight - pane.clientHeight };
        }, null, value => value.bottom <= value.paneBottom + 0.5, 'subtitle footer geometry');
        assert.ok(visible.bottom <= visible.paneBottom, JSON.stringify(visible));
        assert.ok(visible.max - visible.scrollTop < 96, JSON.stringify(visible));
        assert.equal(await tv.page.locator('[data-focus="appearance-device"] .settings-row-value').textContent(), 'Off');
        assert.equal(await tv.page.locator('.settings-nested-group [data-focus="appearance-textOutline"][role="switch"]').count(), 1);
        await tv.page.locator('[data-focus="playback"]').click();
        const playbackLast = await tv.page.locator('.settings-pane [data-focus]').last().getAttribute('data-focus');
        assert.ok(playbackLast);
        await focusPaneRow(tv, playbackLast);
        const playback = await readLive(tv, () => {
            const pane = document.querySelector<HTMLElement>('.settings-pane');
            const footer = pane?.querySelector('.settings-value:last-of-type');
            if (!footer?.isConnected || !pane?.isConnected) return null;
            return { bottom: footer.getBoundingClientRect().bottom, paneBottom: pane.getBoundingClientRect().bottom, scrollTop: pane.scrollTop, max: pane.scrollHeight - pane.clientHeight };
        }, null, value => value.bottom <= value.paneBottom + 0.5, 'playback footer geometry');
        assert.ok(playback.bottom <= playback.paneBottom, JSON.stringify(playback));
        assert.ok(playback.max - playback.scrollTop < 96, JSON.stringify(playback));
    } finally { await tv.page.context().close(); }
});

test("Settings uses category, row and picker Back focus with no requests on focus", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        assert.equal(await tv.focused(), "general");
        const requests = tv.fake.requests.length;
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "playback");
        await tv.page.keyboard.press("ArrowRight");
        assert.equal(await tv.focused(), "quality");
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("heading", { name: "Resolution" }).waitFor();
        await tv.remote(10009);
        assert.equal(await tv.focused(), "quality");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "playback");
        assert.equal(tv.fake.requests.length, requests);
        await tv.remote(10009);
        assert.equal(await tv.focused(), "home");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("legacy hidden libraries can be cleared without a hidden-library editor", async () => {
    const { tv, settings } = await setup();
    settings.profile().set(HIDDEN_KEY, [15, 999]);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="server"]').click();
        assert.equal(await tv.page.locator('[data-focus="hidden"]').count(), 0);
        await tv.page.locator('[data-focus="restore-libraries"]').click();
        await tv.eventually(async () => JSON.stringify(settings.profile().get(HIDDEN_KEY)) === "[]", "restored library visibility");
        await tv.page.locator('[data-focus="restore-libraries"]').waitFor({ state: "detached" });
        await tv.remote(10009);
        await tv.eventually(async () => tv.fake.requests.filter(r => r.path === "/user/libraries").length === 2, "catalog refreshed");
        assert.equal(await tv.focused(), "home", "catalog invalidation returns to the refreshed Home route");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("audio picker preserves unfamiliar explicit tags, null and inherited reset with narrower override", async () => {
    const { tv, settings } = await setup();
    try {
        settings.profile().set(AUDIO_KEY, "en-AU");
        settings.overrides.set(AUDIO_KEY, "fr");
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="audio"]').click();
        assert.equal(await tv.page.locator('[data-focus="audio:en-AU"][aria-checked="true"]').count(), 1);
        await tv.page.locator('[data-focus="audio:null"]').click();
        await tv.page.locator('[data-focus="audio"]').waitFor();
        assert.equal(settings.profile().get(AUDIO_KEY), null);
        assert.equal(await tv.page.locator('[data-focus="audio"] .settings-row-value').textContent(), "fr");
        await tv.page.locator('[data-focus="audio"]').click();
        await tv.page.locator('[data-focus="reset"]').click();
        await tv.page.locator('[data-focus="audio"]').waitFor();
        assert.equal(settings.profile().has(AUDIO_KEY), false);
        assert.equal(settings.overrides.get(AUDIO_KEY), "fr");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("settings refusal is retryable by reload, and a late answer cannot outlive profile authority", async () => {
    const { tv } = await setup();
    try {
        tv.fake.script("/settings/contract/capabilities", problem(403, "permission_denied", "Denied"));
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.getByRole("alert").waitFor();
        const hold = tv.fake.hold("/settings/contract/capabilities", true);
        await tv.page.getByRole("button", { name: "Reload settings" }).click();
        await tv.page.getByRole("status").waitFor();
        assert.ok(await tv.page.locator('[data-focus="general"]').isVisible());
        await tv.page.evaluate(() => window.browseHarness.clearProfile());
        hold.release();
        await tv.page.locator("#successor").waitFor();
        assert.equal(await tv.page.locator(".settings").count(), 0);
        assert.equal(tv.fake.requests.filter(request => request.method === "PUT" || request.method === "DELETE").length, 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("library visibility recovery keeps authority and offers Retry after refusal", async () => {
    const { tv, settings } = await setup();
    settings.profile().set(HIDDEN_KEY, [12]);
    try {
        await openSettings(tv); await tv.page.locator('[data-focus="server"]').click();
        tv.fake.script("/settings/values/" + HIDDEN_KEY + "?scope=profile", problem(403, "permission_denied", "Denied"));
        await tv.page.locator('[data-focus="restore-libraries"]').click();
        await tv.page.getByRole("alert").waitFor();
        assert.deepEqual(settings.profile().get(HIDDEN_KEY), [12]);
        assert.equal(await tv.focused(), "restore-libraries");
        await tv.page.getByRole("button", { name: "Reload settings", exact: true }).click();
        await tv.page.locator('[data-focus="restore-libraries"]').click();
        await tv.eventually(async () => JSON.stringify(settings.profile().get(HIDDEN_KEY)) === "[]", "recovery retry");
    } finally { await tv.page.context().close(); }
});

test("no hidden value leaves no recovery action or mutation", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv); await tv.page.locator('[data-focus="server"]').click();
        assert.equal(await tv.page.locator('[data-focus="hidden"], [data-focus="restore-libraries"]').count(), 0);
        assert.equal(tv.fake.requests.filter(r => r.method === "PUT" || r.method === "DELETE").length, 0);
    } finally { await tv.page.context().close(); }
});

test("quality picker uses server labels, keeps legacy current values honest and preserves overrides", async () => {
    const { tv, settings } = await setup();
    try {
        settings.profile().set(QUALITY_KEY, "original");
        settings.overrides.set(QUALITY_KEY, "480p");
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="quality"]').click();
        await tv.page.getByText("Current profile value: Original quality · Not offered", { exact: true }).waitFor();
        assert.equal(await tv.page.locator('[data-focus="quality:original"]').count(), 0);
        assert.deepEqual(await tv.page.getByRole("radio").allTextContents(), ["Auto", "4K", "1080p", "720p", "480p"]);
        assert.equal(tv.fake.requests.filter(r => r.method === "PUT").length, 0);
        await tv.page.getByRole("radio", { name: "4K", exact: true }).click();
        await tv.page.locator('[data-focus="quality"]').waitFor();
        assert.equal(await tv.focused(), "quality");
        assert.equal(settings.profile().get(QUALITY_KEY), "2160p");
        assert.equal(settings.overrides.get(QUALITY_KEY), "480p");
        assert.equal(await tv.page.locator('[data-focus="quality"] .settings-row-value').textContent(), "480p");
        assert.equal(await tv.page.getByText("Saved", { exact: true }).count(), 0);
        await tv.page.locator('[data-focus="quality"]').click();
        await tv.page.locator('[data-focus="reset"]').click();
        await tv.page.locator('[data-focus="quality"]').waitFor();
        assert.equal(settings.profile().has(QUALITY_KEY), false);
        assert.equal(settings.overrides.get(QUALITY_KEY), "480p");
        settings.profile().set(QUALITY_KEY, "future-quality");
        await tv.remote(10009);
        await tv.remote(10009);
        await tv.remote(10009);
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="quality"]').click();
        await tv.page.getByText("Current profile value: future-quality · Not offered", { exact: true }).waitFor();
        assert.equal(await tv.page.locator('[data-focus="quality:future-quality"]').count(), 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("bitrate No limit stays distinct from inherited reset and the picker has no custom field", async () => {
    const { tv, settings } = await setup();
    try {
        settings.profile().set(BITRATE_KEY, 6000);
        settings.overrides.set(BITRATE_KEY, 1500);
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="bitrate"]').click();
        const dialog = tv.page.getByRole("dialog", { name: "Maximum Bitrate" });
        await dialog.waitFor();
        assert.equal(await dialog.getByRole("textbox").count(), 0);
        assert.equal(await dialog.getByRole("button", { name: "Save", exact: true }).count(), 0);
        const choices = await dialog.locator('.settings-modal-options [data-focus^="bitrate:"], .settings-modal-options [data-focus="no-limit"]').allTextContents();
        assert.deepEqual(choices, ["No limit", "200 Mbps", "100 Mbps", "60 Mbps", "40 Mbps", "20 Mbps", "15 Mbps", "10 Mbps", "6 Mbps", "4 Mbps", "2 Mbps", "1.5 Mbps"]);
        await tv.page.getByRole("button", { name: "No limit", exact: true }).click();
        await tv.page.locator('[data-focus="bitrate"]').waitFor();
        assert.equal(settings.profile().get(BITRATE_KEY), null);
        await tv.page.locator('[data-focus="bitrate"]').click();
        await tv.page.getByRole("button", { name: "Use inherited default", exact: true }).click();
        await tv.page.locator('[data-focus="bitrate"]').waitFor();
        assert.equal(settings.profile().has(BITRATE_KEY), false);
        assert.equal(settings.overrides.get(BITRATE_KEY), 1500);
        assert.equal(await tv.page.locator('[data-focus="bitrate"] .settings-row-value').textContent(), "1.5 Mbps");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("quality controls remain absent for unsupported manifests and empty Playback keeps Back reachable", async () => {
    const { tv } = await setup();
    try {
        const contract = fixture("settings_contract_ok");
        contract.definitions = [];
        const requests = tv.fake.requests.length;
        tv.fake.script("/settings/contract", { status: 200, body: contract });
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.locator('[data-focus="remember-profile"]').waitFor();
        await tv.page.locator('[data-focus="playback"]').click();
        // Playback is no longer empty on a revision-24 server: the spoiler switches come from capabilities, not the emptied contract. The old assertion expected "No supported settings in this category."
        await tv.page.locator('[data-focus="spoiler-images"]').waitFor();
        assert.equal(await tv.page.getByText("No supported settings in this category.", { exact: true }).count(), 0);
        assert.equal(await tv.page.locator('[data-focus="quality"], [data-focus="bitrate"]').count(), 0);
        assert.equal(await tv.page.locator('[data-focus="settings-back"]').count(), 0);
        assert.equal(tv.fake.requests.slice(requests).filter(r => r.path.startsWith("/settings/values")).length, 0);
        await tv.page.locator('[data-focus="spoiler-images"]').focus();
        await tv.remote(10009);
        assert.equal(await tv.focused(), "playback");
    } finally { await tv.page.context().close(); }
});

test("Playback shows HDR after the Streaming rows and never shows or writes Dolby Vision", async () => {
    const { tv, settings } = await setup();
    settings.hdrRows = true;
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        const order = await tv.page.locator(".settings-pane [data-focus]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
        const audio = order.indexOf("audio");
        const hdr = order.indexOf("hdr");
        assert.equal(order.includes("dolby-vision"), false, order.join(","));
        assert.equal(await tv.page.getByRole("switch", { name: "Dolby Vision", exact: true }).count(), 0);
        assert.ok(audio >= 0 && audio < hdr && order[hdr + 1] === "spoiler-images", order.join(","));
        assert.deepEqual(await tv.page.locator(".settings-section-header").allTextContents(), ["QUALITY", "STREAMING", "EPISODES", "SPOILERS", "VIDEO", "RESET"]);
        assert.equal(await tv.page.locator('[data-focus="hdr"] .settings-row-value').innerText(), "On");
        assert.equal(await tv.page.getByRole("switch", { name: "HDR", exact: true }).getAttribute("aria-checked"), "true");
        // TVPlaybackSettingsView.swift:248-258, after the STREAMING rows. The first sentence of
        // SettingsViewModel.swift:136-143, without "without Dolby Vision". The original-file sentence is omitted.
        assert.equal(await tv.page.locator(".settings-hdr-footer").innerText(), "With HDR off, videos the server converts for this device are sent in SDR.");
        const place = await tv.page.evaluate(() => {
            const streaming = [...document.querySelectorAll(".settings-section-header")].find(node => node.textContent === "STREAMING");
            const hdrRow = document.querySelector('[data-focus="hdr"]');
            const note = document.querySelector(".settings-hdr-footer");
            const episodes = [...document.querySelectorAll(".settings-section-header")].find(node => node.textContent === "EPISODES");
            if (streaming === undefined || hdrRow === null || note === null || episodes === undefined) return false;
            return Boolean(streaming.compareDocumentPosition(hdrRow) & Node.DOCUMENT_POSITION_FOLLOWING)
                && Boolean(hdrRow.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING)
                && Boolean(note.compareDocumentPosition(episodes) & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        assert.equal(place, true);
        const deviceId = tv.fake.requests.find(request => request.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
        assert.ok(deviceId);
        const device = settings.device("p-owner", deviceId);
        await tv.page.getByRole("switch", { name: "HDR", exact: true }).click();
        await tv.eventually(async () => device.get(HDR_KEY) === false, "hdr write");
        assert.equal(device.has(HDR_KEY), true);
        assert.equal(settings.profile().has(HDR_KEY), false);
        assert.equal([...device.keys()].join(" ").includes(DOLBY_VISION_KEY), false);
        assert.equal(tv.fake.requests.some(request => request.method !== "GET" && request.path.includes(DOLBY_VISION_KEY)), false);
        assert.equal(tv.fake.requests.some(request => request.path.includes(DOLBY_VISION_KEY)), false);
        await tv.page.locator('[data-focus="hdr"]').focus();
        await tv.remote(40);
        assert.equal(await tv.focused(), "spoiler-images");
    } finally { await tv.page.context().close(); }
});

test("Server settings open Acknowledgements with TMDB's logo and required notice, and Back returns to the row", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="server"]').click();
        assert.deepEqual(await tv.page.locator(".settings-section-header").allTextContents(), ["ACTIVE SERVER", "ABOUT", "EXTRA FEATURES"]);
        await tv.page.getByRole("button", { name: "Acknowledgements", exact: true }).click();
        const credits = tv.page.locator(".acknowledgements-document");
        await credits.waitFor();
        const count = tv.fake.requests.length;
        assert.equal(await tv.focused(), "document", "the document is the first focus stop, as Apple's overlay");
        assert.equal(await tv.page.locator(".acknowledgements-eyebrow").innerText(), "CREDITS");
        const logo = credits.locator("img.acknowledgements-logo");
        assert.equal(await logo.getAttribute("alt"), "TMDB");
        await tv.eventually(async () => await logo.evaluate(image => (image as HTMLImageElement).naturalWidth > 0), "TMDB logo");
        await credits.getByText("This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.", { exact: true }).waitFor();
        await credits.getByText("Profile avatars", { exact: true }).waitFor();
        assert.match(await credits.textContent() ?? "", /Davis Uche.*creativecommons\.org\/licenses\/by\/4\.0/);
        await credits.getByText("These names and logos belong to their owners. Silo is not affiliated with or endorsed by them.", { exact: true }).waitFor();
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), "done", "Up from the top of the document reaches Done");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "document");
        await tv.remote(10009);
        await tv.page.getByRole("button", { name: "Acknowledgements", exact: true }).waitFor();
        assert.equal(await tv.focused(), "acknowledgements", "Back returns to the row that opened it");
        assert.equal(tv.fake.requests.length, count, "credits are local and read nothing");
    } finally { await tv.page.context().close(); }
});
