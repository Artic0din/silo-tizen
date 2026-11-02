# Fonts

| File | Font | Source | SHA-256 |
|---|---|---|---|
| `InterVariable.woff2` | Inter 4.1 variable, unmodified | rsms/inter v4.1, commit `e3a3d4c57d5ecc01453a575621882a384c1995a3`, `docs/font-files/InterVariable.woff2` | `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3` |
| `Inter-LICENSE.txt` | SIL Open Font License 1.1 | same commit, `LICENSE.txt` | `262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a` |

Inter is the app's one UI font (`--silo-font` in `src/theme.css`); codes and PINs keep the generic monospace.
Apple TV draws SF Pro, whose license does not allow embedding it here, so Inter is a substitution, not a match.
Keep both files unmodified and together.
