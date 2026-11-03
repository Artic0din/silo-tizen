#!/usr/bin/env python3

import importlib.util
from pathlib import Path
import unittest


SCRIPT_DIR = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("release_version", SCRIPT_DIR / "release-version.py")
assert spec is not None and spec.loader is not None
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class NextReleaseTest(unittest.TestCase):
    def test_first_release_needs_an_explicit_version(self):
        with self.assertRaisesRegex(release.ReleaseError, "Pass the version"):
            release.next_release([], "build")
        with self.assertRaisesRegex(release.ReleaseError, "explicit version"):
            release.next_release([], "minor")

    def test_first_tester_build(self):
        self.assertEqual(
            {"version": "1.0.0", "build": "1", "tag": "v1.0.0-beta.1", "previous_tag": ""},
            release.next_release([], "build", "1.0.0"),
        )

    def test_build_continues_the_unreleased_version(self):
        result = release.next_release(["v1.0.0-beta.1", "v1.0.0-beta.2"], "build")
        self.assertEqual("v1.0.0-beta.3", result["tag"])
        self.assertEqual("v1.0.0-beta.2", result["previous_tag"])

    def test_build_continues_the_newest_unreleased_version(self):
        tags = ["v1.0.0-beta.1", "v1.0.0", "v1.0.1-beta.2", "v1.1.0-beta.3"]
        self.assertEqual("v1.1.0-beta.4", release.next_release(tags, "build")["tag"])

    def test_build_continues_testing_after_a_hotfix_ships(self):
        tags = ["v1.0.0-beta.1", "v1.0.0", "v1.1.0-beta.2", "v1.0.1-beta.3", "v1.0.1"]
        self.assertEqual("v1.1.0-beta.4", release.next_release(tags, "build")["tag"])

    def test_a_draft_store_release_counts_as_released(self):
        tags = ["v1.0.0-beta.1", "v1.0.0-beta.2"]
        with self.assertRaisesRegex(release.ReleaseError, "bump=minor"):
            release.next_release(tags, "build", drafts=["v1.0.0"])
        self.assertEqual("v1.1.0-beta.3", release.next_release(tags, "minor", drafts=["v1.0.0"])["tag"])

    def test_minor_and_patch_bump_the_latest_release(self):
        tags = ["v1.0.0-beta.1", "v1.0.0"]
        self.assertEqual("v1.1.0-beta.2", release.next_release(tags, "minor")["tag"])
        self.assertEqual("v1.0.1-beta.2", release.next_release(tags, "patch")["tag"])

    def test_explicit_version_must_be_newer_than_the_latest_release(self):
        tags = ["v1.0.0-beta.1", "v1.0.0"]
        self.assertEqual("v1.3.0-beta.2", release.next_release(tags, "build", "1.3.0")["tag"])
        with self.assertRaisesRegex(release.ReleaseError, "not newer"):
            release.next_release(tags, "build", "1.0.0")
        with self.assertRaisesRegex(release.ReleaseError, "look like"):
            release.next_release(tags, "build", "1.3")

    def test_unrelated_tags_are_ignored(self):
        tags = ["v1.0.0-beta.1", "v1.0.0", "beta-latest", "wip/x", "v2"]
        self.assertEqual("v1.1.0-beta.2", release.next_release(tags, "minor")["tag"])

    def test_tizen_version_limits(self):
        self.assertEqual("255.255.65535", release.next_release([], "build", "255.255.65535")["version"])
        for version in ("256.0.0", "1.256.0", "1.0.65536"):
            with self.subTest(version), self.assertRaisesRegex(release.ReleaseError, "Tizen version"):
                release.next_release([], "build", version)

    def test_build_number_has_no_upper_limit(self):
        self.assertEqual("v1.1.0-beta.1000", release.next_release(["v1.0.0", "v1.1.0-beta.999"], "build")["tag"])


class BetaReleaseTest(unittest.TestCase):
    def test_beta_tag_resolves_to_its_store_release(self):
        self.assertEqual(
            {"version": "1.1.0", "build": "22", "tag": "v1.1.0-beta.22", "release_tag": "v1.1.0"},
            release.beta_release("v1.1.0-beta.22"),
        )

    def test_other_tags_are_rejected(self):
        for name in ("v1.1.0", "v1.0.0+21", "v1.0.1-rc.2+3", "beta.22", "beta-latest"):
            with self.subTest(name), self.assertRaises(release.ReleaseError):
                release.beta_release(name)


GENERATED = """## What's Changed
### 🚀 Features
* feat(requests): let viewers get notified about requests by @dev in https://github.com/Silo-Server/silo-tizen/pull/559
### 🐛 Fixes
* fix(tv)!: let Down leave the search field by @dev in https://github.com/Silo-Server/silo-tizen/pull/561
### Other changes
* ci: cache builds by @dev in https://github.com/Silo-Server/silo-tizen/pull/500
* feat(profiles): ask who's watching at launch by @dev in https://github.com/Silo-Server/silo-tizen/pull/543

## New Contributors
* @new made their first contribution in https://github.com/Silo-Server/silo-tizen/pull/501

**Full Changelog**: https://github.com/Silo-Server/silo-tizen/compare/v1.0.0...v1.1.0-beta.22
"""


class StoreNotesTest(unittest.TestCase):
    def test_keeps_features_and_fixes_as_plain_text(self):
        self.assertEqual(
            "• Let viewers get notified about requests\n• Let Down leave the search field\n"
            "• Ask who's watching at launch",
            release.store_notes(GENERATED, 500),
        )

    def test_only_a_leading_prefix_is_removed(self):
        notes = "### 🐛 Fixes\n* Fix crash when the server says: hello by @dev in https://x/1\n"
        self.assertEqual("• Fix crash when the server says: hello", release.store_notes(notes, 500))

    def test_without_user_facing_changes(self):
        self.assertEqual("Bug fixes and improvements.", release.store_notes("## What's Changed\n", 500))

    def test_fits_the_limit(self):
        many = "### 🐛 Fixes\n" + "\n".join(f"* fix: change number {n} by @dev in https://x/{n}" for n in range(100))
        notes = release.store_notes(many, 500)
        self.assertLessEqual(len(notes), 500)
        self.assertTrue(notes.endswith("• And more."))


if __name__ == "__main__":
    unittest.main()
