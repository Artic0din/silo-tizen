import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSettingValue } from "../../src/contracts/v2/settings.ts";
import { decodePrimaryMenu, PRIMARY_MENU_KEY } from "../../src/contracts/v2/navigation.ts";
import { navigationRoots } from "../../src/ui/navigation.ts";
import { NavigationSettings } from "../../src/ui/navigationSettings.ts";
import type { RequestSpec } from "../../src/api/http.ts";

const key = PRIMARY_MENU_KEY;
const home = { type: "builtin", destination: "home" };

test("navigation accepts its own document independently of poster settings", () => {
    const document = { items: [home, { type: "builtin", destination: "for_you" }, { type: "library", library_id: 7, label: "Films" }] };
    assert.deepEqual(decodeSettingValue(key, document), document);
    assert.equal(decodeSettingValue(key, null), null);
});

const libraries = [
    { id: "7", name: "Films", type: "movies" as const, sortOrder: 0 },
    { id: "8", name: "Television", type: "series" as const, sortOrder: 1 },
];
test("navigation uses Apple's default order and capability-owned Requests", () => {
    assert.deepEqual(navigationRoots(null, libraries, true).map(root => root.key), ["home", "movies", "series", "for_you", "calendar", "requests"]);
    assert.deepEqual(navigationRoots(null, [], false).map(root => root.key), ["home", "for_you", "calendar"]);
    assert.deepEqual(navigationRoots(null, [{ id: "9", name: "Mixed", type: "mixed", sortOrder: 0 }], false).map(root => root.key), ["home", "movies", "series", "for_you", "calendar"]);
});

test("navigation preserves authored order, omissions and supported library shortcuts", () => {
    const menu = decodePrimaryMenu({ items: [
        { type: "builtin", destination: "calendar" }, home,
        { type: "library", library_id: 8, label: "Shows" },
        { type: "library", library_id: 99, label: "Unavailable" },
        { type: "builtin", destination: "music" },
        { type: "section", library_id: 7, section_id: "latest", label: "Latest" },
        { type: "collection", collection_id: "1", label: "Collection" },
        { type: "builtin", destination: "series" },
    ] });
    const roots = navigationRoots(menu, libraries, false);
    assert.deepEqual(roots.map(root => root.key), ["calendar", "home", "library:8", "series"]);
    assert.equal(roots[2]?.title, "Shows");
});

test("navigation rejects malformed and semantically repeated destinations", () => {
    const bad = [
        [], {}, { items: [] }, { items: [home], extra: true },
        { items: [{ type: "builtin", destination: "for_you" }] },
        { items: [home, home] },
        ...[0, -1, 1.5, "7"].map(library_id => ({ items: [home, { type: "library", library_id, label: "Films" }] })),
        { items: [home, { type: "section", library_id: 7, label: "Missing target" }] },
        { items: [home, { type: "collection", collection_id: " ", label: "Blank target" }] },
        { items: [home, { type: "library", library_id: 7, label: "A" }, { type: "library", library_id: 7, label: "B" }] },
        { items: [home, { type: "builtin", destination: "search" }] },
        { items: [home, { type: "builtin", destination: ["movies"] }] },
        { items: [home, { type: "library", library_id: 7, label: " " }] },
        { items: [home, { type: "library", library_id: 7, label: "A", extra: true }] },
    ];
    for (const value of bad) assert.throws(() => decodeSettingValue(key, value), JSON.stringify(value));
});

const capability = { api_version: 1, revision: "r24", manifest_revision: 24, state: "available", allowed: true, scopes: ["profile_client", "profile_device"], supports_batched_effective: true, client_families: ["tv"] };
const menuAnswer = (items: unknown[]) => ({ revision: 24, items: [{ key, value: { items }, source: "profile_client", definition_revision: 5 }] });

test("navigation reads only the TV menu and retains a confirmed menu on failure", async () => {
    let fails = false;
    let changes = 0;
    const paths: string[] = [];
    const owner = new NavigationSettings(async <T>(spec: RequestSpec<T>) => {
        paths.push(spec.path);
        if (spec.path === "/settings/contract/capabilities") return spec.decode(capability);
        assert.equal(spec.clientFamily, "tv");
        if (fails) throw new Error("Offline");
        return spec.decode(menuAnswer([home, { type: "builtin", destination: "calendar" }]));
    }, () => changes++);
    await owner.reload();
    assert.deepEqual(owner.value?.items, [home, { type: "builtin", destination: "calendar" }]);
    assert.equal(changes, 1);
    fails = true;
    await owner.reload();
    assert.equal(changes, 1);
    assert.equal(owner.value?.items.length, 2);
    assert.ok(paths.filter(path => path.includes("effective")).every(path => path === "/settings/values/effective?keys=nav.primary_menu"));
    owner.destroy();
});

test("a replaced or destroyed navigation owner ignores a late menu answer", async () => {
    let release: (value: unknown) => void = () => assert.fail("Expected an in-flight read");
    let started: () => void = () => undefined;
    const pending = new Promise<void>(resolve => { started = resolve; });
    let hold = true;
    let changes = 0;
    const owner = new NavigationSettings(async <T>(spec: RequestSpec<T>) => {
        if (spec.path === "/settings/contract/capabilities") return spec.decode(capability);
        if (!hold) return spec.decode(menuAnswer([home]));
        const answer = new Promise<unknown>(resolve => { release = resolve; });
        started();
        return spec.decode(await answer);
    }, () => changes++);
    const old = owner.reload();
    await pending;
    hold = false;
    await owner.reload();
    release(menuAnswer([home, { type: "builtin", destination: "calendar" }]));
    await old;
    assert.deepEqual(owner.value?.items, [home]);
    assert.equal(changes, 1);
    hold = true;
    const abandoned = owner.reload();
    await Promise.resolve();
    owner.destroy();
    release(menuAnswer([home, { type: "builtin", destination: "series" }]));
    await abandoned;
    assert.equal(changes, 1);
});

test("older or unsupported settings capabilities keep the default without an effective read", async () => {
    for (const patch of [{ manifest_revision: 4 }, { allowed: false }, { supports_batched_effective: false }, { client_families: ["web"] }]) {
        let reads = 0;
        const owner = new NavigationSettings(async <T>(spec: RequestSpec<T>) => {
            reads++;
            return spec.decode({ ...capability, ...patch });
        }, () => assert.fail("No menu answer"));
        await owner.reload();
        assert.equal(owner.value, null);
        assert.equal(reads, 1);
        owner.destroy();
    }
});
