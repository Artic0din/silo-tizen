#!/usr/bin/env python3

import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("parity_drift", Path(__file__).resolve().parent / "parity-drift.py")
assert spec is not None and spec.loader is not None
drift = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drift)

ANDROID = """# Silo Android — Feature List

## Playback

| Feature | Phone | TV | Notes |
|---|:---:|:---:|---|
| Direct Play | ✅ | ✅ | Progressive HTTP |
| Sleep timer | ✅ | 🟡 | |

## Reading (ebooks)

| Feature | Phone | TV | Notes |
|---|:---:|:---:|---|
| Reader | ✅ | ➖ | Phone only |

## Platform summary

Prose with a | pipe that is not a table.
"""


class ParseTest(unittest.TestCase):
    def test_reads_the_tv_column_per_section(self):
        self.assertEqual(
            {"Playback / Direct Play": "✅", "Playback / Sleep timer": "🟡", "Reading (ebooks) / Reader": "➖"},
            drift.parse_android_tv(ANDROID),
        )

    def test_a_document_without_tables_is_an_error(self):
        with self.assertRaises(drift.DriftError):
            drift.parse_android_tv("# Features\n\nNothing here.\n")

    def test_keeps_only_tvos_sources(self):
        tree = {"truncated": False, "tree": [
            {"type": "blob", "path": "iosApp/iosApp/Screens/Player/tvOS/HoldSeekIndicator.swift"},
            {"type": "blob", "path": "iosApp/iosApp/Onboarding/OnboardingTourPresentation+tvOS.swift"},
            {"type": "blob", "path": "iosApp/TopShelf/ContentProvider.swift"},
            {"type": "blob", "path": "iosApp/iosApp/Screens/iOS/HomeView.swift"},
            {"type": "blob", "path": "docs/tvos-player/README.md"},
            {"type": "tree", "path": "iosApp/iosApp/Screens/Player/tvOS"},
        ]}
        self.assertEqual([
            "iosApp/TopShelf/ContentProvider.swift",
            "iosApp/iosApp/Onboarding/OnboardingTourPresentation+tvOS.swift",
            "iosApp/iosApp/Screens/Player/tvOS/HoldSeekIndicator.swift",
        ], drift.tvos_files(json.dumps(tree)))

    def test_a_truncated_tree_is_an_error(self):
        with self.assertRaises(drift.DriftError):
            drift.tvos_files(json.dumps({"truncated": True, "tree": []}))


class ReportTest(unittest.TestCase):
    old = {"android_tv": {"Playback / Direct Play": "✅", "Playback / Sleep timer": "➖", "Playback / Gone": "✅"},
           "apple_tvos_files": ["a/tvOS/Old.swift", "a/tvOS/Kept.swift"]}

    def test_no_change_is_an_empty_report(self):
        self.assertEqual("", drift.drift_report(self.old, self.old))

    def test_lists_added_removed_and_changed_rows_and_files(self):
        new = {"android_tv": {"Playback / Direct Play": "✅", "Playback / Sleep timer": "🟡", "Playback / Chapters": "✅"},
               "apple_tvos_files": ["a/tvOS/Kept.swift", "a/tvOS/New.swift"]}
        report = drift.drift_report(self.old, new)
        for expected in ["- Added: Playback / Chapters (✅)", "- Removed: Playback / Gone",
                         "- Changed: Playback / Sleep timer (➖ → 🟡)",
                         "- Added: `a/tvOS/New.swift`", "- Removed: `a/tvOS/Old.swift`",
                         "python3 scripts/parity-drift.py update"]:
            self.assertIn(expected, report)
        self.assertNotIn("Direct Play", report)

    def test_a_missing_snapshot_reports_everything_as_added(self):
        report = drift.drift_report({}, self.old)
        self.assertIn("- Added: Playback / Gone (✅)", report)
        self.assertIn("- Added: `a/tvOS/Old.swift`", report)


if __name__ == "__main__":
    unittest.main()
