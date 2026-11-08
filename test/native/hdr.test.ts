import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_CAPABILITIES, clientCapabilities, hdrDetails, playbackContext, probeHdrPanel, type HdrReport } from "../../src/player/capabilities.ts";

const OFF: HdrReport = { panel: { hdr10: false, hlg: false, dolbyVision: false }, preference: { hdrEnabled: false } };

test("a missing or throwing HDR probe is SDR and never reports Dolby Vision", () => {
    assert.deepEqual(probeHdrPanel({}), { hdr10: false, hlg: false, dolbyVision: false });
    assert.deepEqual(probeHdrPanel({ webapis: {} }), { hdr10: false, hlg: false, dolbyVision: false });
    assert.deepEqual(probeHdrPanel({ webapis: { avinfo: {} } }), { hdr10: false, hlg: false, dolbyVision: false });
    assert.deepEqual(probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => false } } }), { hdr10: false, hlg: false, dolbyVision: false });
    assert.deepEqual(probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => "true" } } }), { hdr10: false, hlg: false, dolbyVision: false });
    assert.deepEqual(probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => { throw new Error("NotSupportedError"); } } } }), { hdr10: false, hlg: false, dolbyVision: false });
    assert.deepEqual(probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => true } } }), { hdr10: true, hlg: true, dolbyVision: false });
});

test("off or an unsupported panel matches the SDR capability profile exactly", () => {
    const supporting = probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => true } } });
    for (const report of [
        OFF,
        { panel: supporting, preference: { hdrEnabled: false } },
        { panel: { hdr10: false, hlg: false, dolbyVision: false }, preference: { hdrEnabled: true } },
    ]) {
        assert.equal(hdrDetails(report), undefined);
        assert.equal(clientCapabilities(report), CLIENT_CAPABILITIES);
        assert.deepEqual(playbackContext("S95C", "0.1.0", report), playbackContext("S95C", "0.1.0"));
    }
});

test("HDR off omits HDR on the output and on every delivery", () => {
    const supporting = probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => true } } });
    const report: HdrReport = { panel: supporting, preference: { hdrEnabled: false } };
    const capabilities = clientCapabilities(report);
    const context = playbackContext("S95C", "0.1.0", report);
    assert.equal(capabilities.hdr, false);
    assert.equal(capabilities.hdr_details, undefined);
    assert.equal(context.output.hdr_details, undefined);
    assert.deepEqual(Object.keys(context.deliveries).sort(), ["hls", "original_http"]);
    for (const kind of ["original_http", "hls"]) {
        const delivery = context.deliveries[kind];
        assert.ok(delivery, kind);
        assert.equal(delivery.enabled, true);
        assert.equal(delivery.hdr_details, undefined, kind);
        assert.equal(delivery.validated_claims.includes("client_managed_dynamic_range_v1"), false, kind);
    }
});

test("HDR on claims HDR10, HDR10+ and HLG from one probe, and Dolby Vision profiles stay empty", () => {
    const claimed = { hdr10: true, hdr10_plus: true, hlg: true, dolby_vision_profiles: [] as readonly number[] };
    const supporting = probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => true } } });
    const report: HdrReport = { panel: supporting, preference: { hdrEnabled: true } };
    assert.deepEqual(hdrDetails(report), claimed);
    const vision: HdrReport = { panel: { ...supporting, dolbyVision: true }, preference: { hdrEnabled: true } };
    assert.deepEqual(hdrDetails(vision), claimed);
    const profileOnly: HdrReport = { panel: { hdr10: false, hlg: false, dolbyVision: true }, preference: { hdrEnabled: true } };
    assert.equal(hdrDetails(profileOnly), undefined);
    assert.equal(clientCapabilities(profileOnly).hdr_details, undefined);
    assert.equal(clientCapabilities(profileOnly).hdr, false);
    const hdr10Only = { hdr10: true, hdr10_plus: true, hlg: false, dolby_vision_profiles: [] as readonly number[] };
    const context = playbackContext("S95C", "0.1.0", { panel: { hdr10: true, hlg: false, dolbyVision: false }, preference: { hdrEnabled: true } });
    assert.deepEqual(context.output.hdr_details, hdr10Only);
    assert.deepEqual(context.deliveries.original_http?.hdr_details, hdr10Only);
    assert.deepEqual(context.deliveries.hls?.hdr_details, hdr10Only);
    const probed = playbackContext("S95C", "0.1.0", report);
    assert.deepEqual(probed.output.hdr_details, claimed);
    assert.deepEqual(probed.deliveries.original_http?.hdr_details, claimed);
    assert.deepEqual(probed.deliveries.hls?.hdr_details, claimed);
});
