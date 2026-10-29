import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverServer } from "../../src/api/discovery.ts";
import { ApiError } from "../../src/api/errors.ts";
import { NativeHttp } from "../../src/api/http.ts";
import { operations } from "../../src/api/operations.ts";
import { parseServerUrl } from "../../src/api/serverUrl.ts";
import { ManualClock } from "./support/clock.ts";
import { FakeSilo } from "./support/fakeSilo.ts";

const device = { id: "abababab", name: "Living room TV", platform: "tizen" };

function setup(): { clock: ManualClock; fake: FakeSilo; http: NativeHttp } {
    const clock = new ManualClock();
    const fake = new FakeSilo(clock);
    const parsed = parseServerUrl(fake.origin);
    assert.ok(parsed.ok);
    return { clock, fake, http: new NativeHttp(parsed.base, device, fake.fetch, clock) };
}

test("server addresses: HTTPS only, path prefix kept, no credentials, query or API path", () => {
    assert.deepEqual(parseServerUrl(" silo.example.test/media/ "), {
        ok: true,
        base: { origin: "https://silo.example.test", baseUrl: "https://silo.example.test/media", apiRoot: "https://silo.example.test/media/api/v2" },
    });
    assert.deepEqual(parseServerUrl("http://192.168.1.20:8096"), { ok: false, problem: "not_https" });
    assert.deepEqual(parseServerUrl("https://user:pw@silo.example.test"), { ok: false, problem: "has_credentials" });
    assert.deepEqual(parseServerUrl("https://silo.example.test/?a=1"), { ok: false, problem: "has_query_or_fragment" });
    assert.deepEqual(parseServerUrl("https://silo.example.test/api/v2"), { ok: false, problem: "has_api_path" });
    assert.deepEqual(parseServerUrl(""), { ok: false, problem: "empty" });
});

test("discovery checks api_major and request_origin before any credential is sent", async () => {
    const clock = new ManualClock();
    const fake = new FakeSilo(clock);
    const ok = await discoverServer(fake.origin, device, fake.fetch, clock);
    assert.equal(ok.status, "connected");
    if (ok.status === "connected") {
        assert.equal(ok.server.serverId, fake.serverId);
    }
    assert.deepEqual(fake.paths(), ["GET /system/info", "GET /system/identity"]);
    assert.ok(fake.requests.every((request) => request.headers.authorization === undefined));

    fake.script("/system/info", { status: 200, body: { server_version: "x", api_major: 2, contract_digest: "0", links: { openapi: "", capabilities: "", identity: "" }, request_origin: "https://elsewhere.example.test" } });
    assert.deepEqual(await discoverServer(fake.origin, device, fake.fetch, clock), { status: "origin_mismatch" });

    fake.script("/system/info", { status: 404, body: "not found", headers: { "Content-Type": "text/plain" } });
    assert.deepEqual(await discoverServer(fake.origin, device, fake.fetch, clock), { status: "not_silo_v2" });
});

test("every request carries device headers, refuses redirects, and sends JSON bodies", async () => {
    const { fake, http } = setup();
    await http.send(operations.startDeviceLogin("Living room TV", "tizen"));
    const request = fake.requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.headers["x-silo-device-id"], "abababab");
    assert.equal(request.headers["x-silo-device-name"], "Living room TV");
    assert.equal(request.headers["x-silo-device-platform"], "tizen");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.redirect, "error");
    assert.deepEqual(request.body, { device_name: "Living room TV", device_platform: "tizen" });
});

test("problem responses become typed errors with Retry-After", async () => {
    const { fake, http } = setup();
    fake.script("/auth/device/poll", { status: 429, headers: { "Content-Type": "application/problem+json", "Retry-After": "7" }, body: { type: "https://siloserver.org/docs/api/v2/problems/rate_limited", title: "Rate limited", status: 429, detail: "", instance: "urn:silo:request:1" } });
    await assert.rejects(http.send(operations.pollDeviceLogin("dev-x")), (error: unknown) => {
        return error instanceof ApiError && error.problemId === "rate_limited" && error.retryAfterSeconds === 7 && error.transient;
    });
});

test("safe reads retry once after a gateway failure; non-retryable operations never do", async () => {
    const { clock, fake, http } = setup();
    fake.script("/system/info", { status: 503, headers: { "Retry-After": "1" } });
    const read = http.send(operations.systemInfo());
    await clock.advance(1000);
    assert.equal((await read).apiMajor, 2);
    assert.equal(fake.paths().filter((path) => path === "GET /system/info").length, 2);

    const nonRetryable: [string, () => Promise<unknown>][] = [
        ["/auth/device/start", () => http.send(operations.startDeviceLogin("tv", "tizen"))],
        ["/auth/device/poll", () => http.send(operations.pollDeviceLogin("dev-x"))],
        ["/auth/refresh", () => http.send(operations.refreshSession("ref-x"))],
        ["/profiles/p-kid/verify-pin", () => http.send(operations.verifyProfilePin("p-kid", "1111"))],
    ];
    for (const [path, send] of nonRetryable) {
        fake.script(path, { status: 503 });
        const before = fake.requests.length;
        const sent = assert.rejects(send(), (error: unknown) => error instanceof ApiError && error.status === 503);
        await clock.advance(5000);
        await sent;
        assert.equal(fake.requests.length - before, 1, `${path} was sent once`);
    }
});

test("a request that outlives its timeout fails as timeout; a caller abort fails as aborted", async () => {
    const { clock, fake, http } = setup();
    fake.hold("/auth/device/poll");
    const timed = assert.rejects(
        http.send({ ...operations.pollDeviceLogin("dev-x"), timeoutMs: 2000 }),
        (error: unknown) => error instanceof ApiError && error.failure.kind === "timeout",
    );
    await clock.advance(2000);
    await timed;

    fake.hold("/auth/device/poll");
    const controller = new AbortController();
    const aborted = http.send({ ...operations.pollDeviceLogin("dev-x"), signal: controller.signal });
    controller.abort();
    await assert.rejects(aborted, (error: unknown) => error instanceof ApiError && error.aborted);
});
