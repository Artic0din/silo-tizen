# Fonts

| File | Font | Source | SHA-256 |
|---|---|---|---|
| `InterVariable.woff2` | Inter 4.1 variable, unmodified | rsms/inter v4.1, commit `e3a3d4c57d5ecc01453a575621882a384c1995a3`, `docs/font-files/InterVariable.woff2` | `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3` |
| `Inter-LICENSE.txt` | SIL Open Font License 1.1 | same commit, `LICENSE.txt` | `262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a` |
| `RobotoMono-Variable.ttf` | Roboto Mono variable (weights 100 to 700), unmodified | google/fonts commit `aa24661a5ba24c8f8a550a16fb13198719fc2c23`, `ofl/robotomono/RobotoMono[wght].ttf` | `66a80e79d17e4c7cabd162e2916578a4cc08fd19eef6e2a643305eae9c567b2b` |
| `RobotoMono-LICENSE.txt` | SIL Open Font License 1.1 | same commit, `ofl/robotomono/OFL.txt` | `50ab8dd54680d3473f649c9db86fece88434d097c7834475c1c72d2f8c429215` |

Inter is the app's one UI font (`--silo-font` in `src/theme.css`); codes and PINs keep the generic monospace.
Apple TV draws SF Pro, whose license does not allow embedding it here, so Inter is a substitution, not a match.
Roboto Mono (`--silo-mono`) stands in for SF Mono where Browse's letter rail and Sort panel need a monospaced face, because the TV has no monospaced system face.
Keep each font unmodified and beside its license.
