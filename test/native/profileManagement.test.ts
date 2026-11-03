import assert from "node:assert/strict";
import { test } from "node:test";
import { connected, signIn, type Harness } from "./support/harness.ts";
import { ProfileManagement } from "../../src/session/profileManagement.ts";

const activeId = (h: Harness): string | undefined => h.core.session.activeProfile?.id;

async function household() {
    const h = await connected();
    await signIn(h);
    const profiles = await h.core.profiles.list();
    const primary = profiles.find(profile => profile.isPrimary);
    const kid = profiles.find(profile => profile.id === "p-kid");
    assert.ok(primary && kid);
    return { h, profiles, primary, kid };
}

test("management borrows primary authority and releases only its own generation", async () => {
    const { h, profiles, primary, kid } = await household();
    const management = new ProfileManagement(h.core);
    assert.equal(management.begin(profiles), "ready");
    assert.equal(activeId(h), primary.id);
    h.core.profiles.select({ ...kid, hasPin: false });
    management.close();
    assert.equal(activeId(h), kid.id);
});

test("management clears borrowed primary but preserves an already acting primary", async () => {
    const { h, profiles, primary } = await household();
    const borrowed = new ProfileManagement(h.core);
    assert.equal(borrowed.begin(profiles), "ready");
    borrowed.close();
    assert.equal(activeId(h), undefined);
    h.core.profiles.select(primary);
    const existing = new ProfileManagement(h.core);
    assert.equal(existing.begin(profiles), "ready");
    existing.close();
    assert.equal(activeId(h), primary.id);
});

test("management cleanup cannot clear a successor selecting the same primary", async () => {
    const { h, profiles, primary } = await household();
    const management = new ProfileManagement(h.core);
    assert.equal(management.begin(profiles), "ready");
    h.core.profiles.clear();
    h.core.profiles.select(primary);
    const successor = h.core.session.authorityGeneration;
    management.close();
    assert.equal(h.core.session.authorityGeneration, successor);
    assert.equal(activeId(h), primary.id);
});

test("an empty household can bootstrap and a nonempty household needs primary", async () => {
    const { h, kid } = await household();
    const empty = new ProfileManagement(h.core);
    assert.equal(empty.begin([]), "ready");
    empty.close();
    assert.equal(new ProfileManagement(h.core).begin([kid]), "primary_missing");
    assert.equal(activeId(h), undefined);
});

test("management PIN continuation uses the existing verification and clears its borrowed context", async () => {
    const { h, kid } = await household();
    const management = new ProfileManagement(h.core);
    assert.equal(management.begin([{ ...kid, isPrimary: true }]), "pin_required");
    const signal = new AbortController().signal;
    assert.equal((await management.verifyPin("0000", signal)).status, "wrong_pin");
    assert.equal(activeId(h), undefined);
    assert.equal((await management.verifyPin("2468", signal)).status, "verified");
    assert.equal(activeId(h), kid.id);
    management.close();
    assert.equal(activeId(h), undefined);
});

test("a successor during management PIN verification keeps its authority", async () => {
    const { h, primary, kid } = await household();
    const management = new ProfileManagement(h.core);
    assert.equal(management.begin([{ ...kid, isPrimary: true }]), "pin_required");
    const pending = management.verifyPin("2468", new AbortController().signal);
    h.core.profiles.select(primary);
    const generation = h.core.session.authorityGeneration;
    assert.notEqual((await pending).status, "verified");
    management.close();
    assert.equal(h.core.session.authorityGeneration, generation);
    assert.equal(activeId(h), primary.id);
});

test("a synchronous successor during primary selection is never borrowed or cleared", async () => {
    const { h, profiles, primary } = await household();
    let replace = true;
    const stop = h.core.session.onAuthorityChange(change => {
        if (change.reason !== "profile_selected" || !replace) return;
        replace = false;
        h.core.profiles.clear();
        h.core.profiles.select(primary);
    });
    const management = new ProfileManagement(h.core);
    assert.equal(management.begin(profiles), "ended");
    const successor = h.core.session.authorityGeneration;
    management.close();
    assert.equal(h.core.session.authorityGeneration, successor);
    assert.equal(activeId(h), primary.id);
    stop();
});

test("creation uses the borrowed profile and closing prevents another submission", async () => {
    const { h, profiles, primary } = await household();
    h.fake.catalog = { route: (method, path, profile) => {
        if (method !== "POST" || path !== "/profiles") return undefined;
        assert.equal(profile, primary.id);
        return { status: 201, body: { id: "guest", name: "Guest", has_pin: false, is_primary: false, is_child: false } };
    } };
    const management = new ProfileManagement(h.core);
    assert.equal(management.begin(profiles), "ready");
    const created = await management.create({ name: "Guest" }, new AbortController().signal);
    assert.equal(created.id, "guest");
    const requests = () => h.fake.requests.filter(request => request.method === "POST" && request.path === "/profiles");
    assert.equal(requests().length, 1);
    management.close();
    await assert.rejects(() => management.create({ name: "Another" }, new AbortController().signal), /context changed/);
    assert.equal(requests().length, 1);
});
