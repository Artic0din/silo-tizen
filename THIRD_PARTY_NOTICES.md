# Third-Party Notices

Silo Tizen is licensed under `AGPL-3.0-or-later`. Third-party dependencies keep their original licenses.
The packaged app carries their full license texts in [`app/THIRD-PARTY-NOTICES.txt`](app/THIRD-PARTY-NOTICES.txt), and Settings > Server > Acknowledgements lists the code libraries on the TV.

## uqr

QR codes for device-code sign-in use [`uqr` 0.1.3](https://github.com/unjs/uqr), distributed under the MIT license.

## unicode-segmenter

Person initials use [`unicode-segmenter` 0.17.3](https://github.com/cometkim/unicode-segmenter) for grapheme boundaries, distributed under the MIT license.
Chromium 108's own `Intl.Segmenter` lacks the Unicode 15.1 Indic conjunct rule.

## ThumbHash

`src/ui/thumbhash.ts` is the ThumbHash decoder from [evanw/thumbhash](https://github.com/evanw/thumbhash) by Evan Wallace, distributed under the MIT license; its notice is kept in the file.

## TMDB Logo

`app/third-party/tmdb-logo.svg` is TMDB's approved "Alt short (blue)" logo from <https://www.themoviedb.org/about/logos-attribution>, shipped unmodified.
It is a trademark of TMDB and is not covered by this repository's license.
Silo shows it next to TMDB scores and in Acknowledgements; keep it unmodified and less prominent than Silo's own branding.
See [`app/third-party/README.md`](app/third-party/README.md).

## Fonts

The app bundles [Inter](https://github.com/rsms/inter) 4.1 (`app/fonts/InterVariable.woff2`), distributed under the SIL Open Font License 1.1.
It also bundles [Roboto Mono](https://github.com/googlefonts/robotomono) (`app/fonts/RobotoMono-Variable.ttf`), distributed under the SIL Open Font License 1.1.
See [`app/fonts/README.md`](app/fonts/README.md).

## Samsung Platform Libraries

The app runs on Samsung's Tizen web platform and uses the TV's own `webapis` and AVPlay libraries, which are not part of this repository.
[PLATFORM-EXCEPTION.md](PLATFORM-EXCEPTION.md) covers combining with them.

## Build Tools

TypeScript, esbuild and Playwright are development dependencies only and are not shipped in the package; they keep their own licenses.
