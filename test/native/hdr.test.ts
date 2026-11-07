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
    assert.deepEqual(probeHdrPanel({ webapis: { avinfo: { isHdrTvSupport: () => true } } }), { hdr10: true, hlg: false, dolbyVision: false });
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

test("HDR on claims only the ranges the panel reported, and Dolby Vision profiles stay empty", () => {
    const hdr10 = { hdr10: true, hdr10_plus: false, hlg: false, dolby_vision_profiles: [] as readonly number[] };
    const report: HdrReport = { panel: { hdr10: true, hlg: true, dolbyVision: true }, preference: { hdrEnabled: true } };
    assert.deepEqual(hdrDetails(report), { ...hdr10, hlg: true });
    const vision: HdrReport = { panel: report.panel, preference: { hdrEnabled: true } };
    assert.deepEqual(hdrDetails(vision), { hdr10: true, hdr10_plus: false, hlg: true, dolby_vision_profiles: [] });
    const profileOnly: HdrReport = { panel: { hdr10: false, hlg: false, dolbyVision: true }, preference: { hdrEnabled: true } };
    assert.equal(hdrDetails(profileOnly), undefined);
    assert.equal(clientCapabilities(profileOnly).hdr_details, undefined);
    assert.equal(clientCapabilities(profileOnly).hdr, false);
    const context = playbackContext("S95C", "0.1.0", { panel: { hdr10: true, hlg: false, dolbyVision: false }, preference: { hdrEnabled: true } });
    assert.deepEqual(context.output.hdr_details, hdr10);
    assert.deepEqual(context.deliveries.original_http?.hdr_details, hdr10);
    assert.deepEqual(context.deliveries.hls?.hdr_details, hdr10);
});
