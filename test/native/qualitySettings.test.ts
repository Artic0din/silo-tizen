import assert from "node:assert/strict";
import { test } from "node:test";
import { BUFFERING_QUALITY_DESCRIPTION, BUFFERING_QUALITY_TITLE, BUFFERING_QUALITY_MODES, bitrateLabel, qualityFooter } from "../../src/ui/qualitySettings.ts";

// SiloQualityPresets.bitrateLabel / ApplePlaybackQuality.formatBitrate and
// SettingsViewModel.qualityFooterText at silo-apple 2ef3a171.

test("bitrate labels match Apple's Maximum Bitrate picker", () => {
    assert.equal(bitrateLabel(null), "No limit");
    assert.equal(bitrateLabel(0), "No limit");
    assert.equal(bitrateLabel(999), "999 kbps");
    assert.equal(bitrateLabel(1000), "1 Mbps");
    assert.equal(bitrateLabel(1500), "1.5 Mbps");
    assert.equal(bitrateLabel(1999), "2.0 Mbps");
    assert.equal(bitrateLabel(6000), "6 Mbps");
    assert.equal(bitrateLabel(200000), "200 Mbps");
});

test("quality footer matches Apple for the effective resolution and bitrate cap", () => {
    assert.equal(qualityFooter("auto", null), "Plays the original file whenever your device and connection can handle it.");
    assert.equal(qualityFooter("original", null), "Plays the original file whenever your device and connection can handle it.");
    assert.equal(qualityFooter("1080p-high", null), "Plays the original file up to 1080p. Larger files are converted.");
    assert.equal(qualityFooter("2160p", null), "Plays the original file up to 4K. Larger files are converted.");
    assert.equal(qualityFooter("4k", 6000), "Plays the original file up to 4K. Larger files are converted. Files above this bitrate are converted to fit.");
    assert.equal(qualityFooter("720p", 0), "Plays the original file up to 720p. Larger files are converted.");
});

test("buffering rows use the settings manifest's title, description and option labels", () => {
    assert.equal(BUFFERING_QUALITY_TITLE, "Lower quality when buffering");
    assert.equal(BUFFERING_QUALITY_DESCRIPTION, "What Silo does on Auto when playback keeps buffering. Silo always asks before lowering a quality you picked.");
    assert.deepEqual(BUFFERING_QUALITY_MODES, [["never", "Never"], ["ask", "Ask first"], ["always", "Automatically"]]);
});

test("quality footer adds Apple's two buffering sentences only when the buffering row is shown", () => {
    assert.equal(qualityFooter("auto", null, true), "Plays the original file whenever your device and connection can handle it. What Silo does on Auto when playback keeps buffering. Silo always asks before lowering a quality you picked.");
    assert.equal(qualityFooter("720p", 6000, true), "Plays the original file up to 720p. Larger files are converted. Files above this bitrate are converted to fit. What Silo does on Auto when playback keeps buffering. Silo always asks before lowering a quality you picked.");
    assert.equal(qualityFooter("auto", null, false), "Plays the original file whenever your device and connection can handle it.");
});
