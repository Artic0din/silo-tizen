# Contributing to Silo Tizen

> [!IMPORTANT]
> The most helpful way to contribute to Silo right now is a clear, accurate
> issue. Pull requests are welcome from contributors who've had one merged in a
> Silo repository, or when a maintainer asks for one. We close other pull
> requests without review.

## Why we're asking for issues

Pull requests now arrive faster than we can review them carefully. Reviewing a
change properly means reading every line, checking it against work already in
flight, re-running validation, and owning the result after it merges. Writing
the change ourselves from a precise issue takes less time, and it keeps every
change on one workflow with the same tests and the same review.

This is about review capacity, not the quality of anyone's work, and it applies
whether or not you used AI. We'll revisit it as Silo approaches 1.0. Thank you
for taking the time to write things up well.

## Write a useful issue

Open an [issue](https://github.com/Silo-Server/silo-tizen/issues) for problems
in the Samsung TV app. Server and API problems belong in
[`silo-server`](https://github.com/Silo-Server/silo-server/issues/new/choose).
Search first; if an issue already covers the problem, add what's new there.

Using Claude Code or Codex? The
[Silo troubleshooting skill](https://github.com/Silo-Server/silo-troubleshooting-skill)
helps you collect these details and drafts the issue, then has independent
reviewers check it against your evidence before you post it.

- One problem or proposal per issue.
- Describe what you observed before any theory about the cause.
- Give exact steps to reproduce, expected and actual behavior, the app version
  and build, your TV model and Tizen version, and the Silo server version.
- Paste raw logs rather than a summary. Redact credentials, tokens, personal
  data, and private media details, mark each redaction, and leave the rest
  untouched.
- For a feature, describe the problem it solves and who it affects.
- If you found the cause or have a fix in mind, add it under a Technical notes
  heading, apart from what you observed. Point to the files involved; a short
  code excerpt is fine. We may implement it differently.
- Disclose AI use, as described in the
  [Silo contribution guide](https://github.com/Silo-Server/.github/blob/main/CONTRIBUTING.md#ai-assisted-contributions).

Report security vulnerabilities privately with **Report a vulnerability** on
the repository's Security tab, not in a public issue.

## Pull requests

Pull requests are welcome from contributors who've had a pull request merged in
a Silo repository, and from anyone a maintainer has asked for one, usually in
an issue comment. The rest of this guide applies to those pull requests.

We close other pull requests without review. That isn't a judgment of the
work. If the problem still matters, open an issue for it and link the closed
pull request; we may use the code as a reference.

The [Silo contribution guide](https://github.com/Silo-Server/.github/blob/main/CONTRIBUTING.md)
covers project-wide coordination, focused changes, evidence, AI disclosure, and
pull request expectations. Those requirements apply here; this guide adds the
Tizen-specific workflow.

## Before you start

Open an [issue](https://github.com/Silo-Server/silo-tizen/issues) before
implementing a feature, navigation or behavior change, large refactor, or work
that changes the shared server contract. Documentation, narrow fixes, and
well-scoped parity corrections can go straight to a pull request.

This repository owns the Samsung TV (Tizen) client. Server/API work belongs in
[`silo-server`](https://github.com/Silo-Server/silo-server), and shared client
behavior should be checked against
[`silo-apple`](https://github.com/Silo-Server/silo-apple) and
[`silo-android`](https://github.com/Silo-Server/silo-android); the Apple TV app
is the reference for TV behavior.

## Development setup

Read [README.md](README.md) for prerequisites, signing setup, and build commands,
then read [AGENTS.md](AGENTS.md) for module ownership and the Tizen platform rules.

Build the app with Node.js 26 or later, and package it with the Tizen Studio Web
CLI and your own Certificate Manager security profile:

```sh
npm ci
npx playwright install chromium
npm run build
export TIZEN_SECURITY_PROFILE="YourProfileName"
./scripts/build-wgt.sh
```

A running Silo server is required for realistic authentication, browsing, and
playback validation. Do not commit certificates, security profiles, passwords,
DUIDs, generated build output, logs, or media fixtures.

## Validate your change

Run focused tests while iterating. Before opening a pull request, run the main
CI checks:

```sh
npm test
python3 scripts/test-release-version.py
```

`npm test` runs both type checks, the production build, the native tests and the
Playwright screen tests. Then package the `.wgt` and exercise visible changes on
a Samsung TV running it. Desktop Chromium and the Samsung TV simulator do not
prove TV rendering, AVPlay playback or remote behavior; see
[docs/simulator-evidence.md](docs/simulator-evidence.md).

## Show visible changes

A pull request that changes what a user sees must show the change in its
Evidence section, so reviewers can see it without building the branch. In this
repository that means the Samsung TV app. A change is visible when it
alters any of these:

- layout, styling, copy, navigation, focus, empty and error states;
- which items a screen shows, or in what order: search results, home sections,
  recommendations, library browsing, collections, sorting, or filtering;
- what an item shows: titles, artwork, descriptions, ratings, badges, episode
  grouping, or availability;
- playback behavior a user notices, such as default audio or subtitle tracks,
  markers, controls, or resume position.

Provide evidence that fits the change:

- **Changes to a screen:** before-and-after screenshots of the same screen with
  the same data, one pair per affected surface. Add a short recording when
  motion, timing, focus movement, or a multi-step flow matters.
- **A Samsung TV running the signed `.wgt`:** capture the TV itself. When you
  could not use a TV, say so and name the runtime you used instead (Tizen TV
  emulator or Samsung TV simulator).
- **Apple TV parity:** add the same-state Apple TV screenshot. The result must
  match it; list any difference under Risks.
- Name the TV model and Tizen version, and the build or commit, for each
  capture.

Capture against a test library or public-domain media where you can, and keep
passwords, tokens, API keys and DUIDs out of every capture. Attach the
screenshots or recordings under the pull request's Evidence heading. Everything
on GitHub is public, so crop or blur hostnames, URLs, account names, and
personal library contents.

The pull request's `Evidence` check asks for evidence when the change touches
`app/` or `src/` (see [`.github/evidence.yml`](.github/evidence.yml)), or when a
maintainer adds the `evidence-required` label; a maintainer adds
`evidence-not-needed` when nothing visible changed.
Changes users cannot see write `Evidence: none, no user-visible change`. If you
could not capture evidence, say why; the reviewer decides whether the pull
request can merge without it.

## Open the pull request

Use a Conventional Commit title, fill in the pull request template, explain
which surfaces are affected, paste the actual validation results, and call out
any server, Apple or Android coordination. Read
the [AI-assisted contribution policy](https://github.com/Silo-Server/silo-server/blob/main/docs/ai-contributions.md)
and include its disclosure block.

## Licensing of contributions

Silo Tizen is licensed under `AGPL-3.0-or-later` with the additional
permissions in [APPSTORE-EXCEPTION.md](APPSTORE-EXCEPTION.md) (app store
distribution) and [PLATFORM-EXCEPTION.md](PLATFORM-EXCEPTION.md) (platform
libraries).

By submitting a contribution, you agree that it is licensed under those
same terms, the AGPL *including* the additional permissions. If you cannot
agree to the additional permissions, say so in your pull request before it
is merged.

You retain copyright in your contribution; no assignment is requested.

## Instructions for coding agents

Coding agents must read [AGENTS.md](AGENTS.md) before changing the repository
(`CLAUDE.md` points to the same guidance). The organization-wide contribution
guide and AI-assisted contribution policy apply to agent and human authors
equally.
