# AI subtitles

Issue [#65](https://github.com/Artic0din/silo-tizen/issues/65) stacks on `feat/64-subtitle-appearance` at `5dbb374720f9b1ceb6e9747b8377514f2c25fc0b`, as approved, because completed text tracks require that renderer.
No server changes are required.

The native OpenAPI pinned at `cc8514943289045e7b9f7ac8d36d4968bfe93926` exposes these profile-scoped operations:

| Operation | Path | Behavior |
| --- | --- | --- |
| `getSubtitleAIStatus` | `GET /subtitles/ai/status` | Require `state=available`, `allowed` and the individual translation/transcription flag. |
| `getSubtitleAIQuota` | `GET /subtitles/ai/quota` | Show remaining ASR quota and its period; block transcription when exhausted or unknown. |
| `createSubtitleAIJob` | `POST /subtitles/ai/translate` | Send once with file, kind, source index/language, target language and source position. |
| `getSubtitleAIJob` | `GET /subtitles/ai/jobs/{job_id}` | Poll pending/running jobs every two seconds; verify job, file, kind, source index and language identity. |

The selected text subtitle is the translation source; the selected audio track is the transcription source.
Translation targets come from the pinned settings contract's `playback_subtitle_languages` option set.
Text translation does not spend the ASR quota; transcription requires a known balance.
No live delivery is requested: a completed stored track becomes selectable when ready.
An unknown create outcome is not resent, including on repeated presses in the same playback attempt.
Lost polling or an unknown accepted job state also blocks new creation for that attempt, because the original work may still spend quota.
Provider errors, quota refusals, read failures and unknown states are shown in the subtitles panel without issuing player stop commands.
Leaving the attempt or losing profile authority cancels polling; it does not cancel work already accepted by the server.

Completion alone never replans or changes the selected track.
When the viewer selects an AI result, the player first uses any matching `sync_key=stored-{result_subtitle_id}` already in the plan inventory.
Otherwise it requests a fresh plan retaining the current tracks, then selects only the server-returned track with that sync identity.
The pinned `SubtitleInventoryItemV3` publishes `sync_key`; `internal/playback/subtitle_inventory_v3.go` sets it from the stored subtitle ID.
`listStoredSubtitles` can omit rows with unrecognized provider languages, so list positions are deliberately never converted into playback ordinals.
If the refreshed plan does not contain the result, playback continues with a visible reason.
Selection uses the existing track-change replans and may briefly reopen AVPlay, as other track changes do.
AI-translated and AI-transcribed labels remain on matching tracks for the playback attempt.

Apple reference: `APIv2Client+SubtitleAI.swift`, `APIv2SubtitleAIModels.swift`, `APIv2SubtitleModels.swift` and `SubtitleAIController.swift` at `1a7cceeaf3b2bfc4f889c00487d19b2c6f843940` confirm independent gates, ASR quota, non-retryable creation, opaque job identity and the stored-list ordinal limitation.
Native tests cover capability gates, quota exhaustion, one-shot creation, identity mismatches, polling, failures, authority cancellation and fresh inventory selection.
Desktop tests cover D-pad language selection, quota display, blocked transcription and result selection.
Live provider quota consumption, actual generated output, Samsung compositing, signed packaging and hardware remain unproven.
