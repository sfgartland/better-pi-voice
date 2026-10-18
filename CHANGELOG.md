# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-10-18

### Fixed

- **`dispose()` could throw while a recording was still starting (arming).** `endSession`
  cleared the active session before it was stored, so the shutdown drain aborted: finished
  text could be lost and the backend was never freed. The active session is now captured
  before it is ended.
- **A stream opened while a recording was cancelled leaked.** If the session was abandoned
  during `backend.start()`, the stream (and, for the local backend, the session refcount)
  was never released, so the model could never unload again. Abandoned streams are now
  closed, including on the replay and retry paths.
- **The local model could be unloaded under a session that was still starting.** Parakeet
  now pins the model for the whole `start()` window and releases it on every early return
  or throw.

## [0.2.0] - 2026-10-18

### Added

- **Non-destructive recording queue.** Starting a recording while earlier ones are still
  transcribing no longer drops the new utterance: each recording is queued, transcribed
  exactly once, and its text is inserted in **recording-start order**, even when calls
  finish out of order. When the queue is full (4 jobs, or 8 MiB of buffered audio) a new
  capture is refused with a notice instead of silently discarding audio, and the status
  line reports the queue depth.
- **Silero VAD** for batch cuts, behind a new `PauseDetector` interface, with the existing
  RMS level heuristic as the fallback when the VAD model is unavailable.
- **Eager batch cuts:** beginning a new recording asks the previous batch tail to transcribe
  immediately instead of waiting for the chunk target.
- A `pi-package` contract guard (`src/packaging.test.ts`) plus install/discoverability notes,
  so the manifest cannot silently drop out of the pi package gallery.

### Changed

- **Sequence-aware transcription plumbing.** `EditorSink` rebuilds `prefix + finals in
  order + live interim`, suppresses interims while jobs are pending, and submits once per
  drained queue; `submitOnStop` no longer fires once per final.
- **Resident local model window** raised to 60 s (`idleUnloadMs` 0 -> 60000), so
  back-to-back recordings stop reloading the model.
- **Batch chunk length** settled at 15 s (`chunkSeconds` 30 -> 15), matching
  `DEFAULT_CHUNK_SECONDS`.
- **Keyterm budget is per backend:** Deepgram 100 (its cap), local correction 60.
- `dispose()` is now async and drains stored text on shutdown.

### Fixed

- A recording started during transcription was **silently dropped** (the microphone was
  never opened and the utterance was lost with no notification). This was the bug the
  queue replaces.
- Parakeet sessions are refcounted and `model.transcribe` is serialized, so an
  unload/dispose can never free the model under a queued job.
- Failed, empty or hung jobs always free their queue slot via a reap timeout, so one bad
  job cannot deadlock the queue.
- Stale Parakeet header comments and the README "not implemented yet" line are corrected.
- The fresh-install test now polls for the setup file instead of racing a fixed delay.

## [0.1.1] - 2026-10-16

### Added

- A `media/demo.mp4` storyboard of the before/after transcription, wired into the
  package manifest as `pi.video` so the [pi package gallery](https://pi.dev/packages)
  can preview it.

### Fixed

- **A skill file no longer becomes the keyterm `SKILL`.** Keyterms are mined from the
  basenames of files the session touches, so reading `…/skills/<name>/SKILL.md` mined
  the generic document stem `SKILL`. The local backend's correction pass then rewrote
  ordinary words one edit away from it — `still`, `spill`, `skull` and `swill` all came
  back as `SKILL`. Generic document names (`SKILL`, `README`, `INDEX`, `LICENSE`,
  `CHANGELOG`, …) now mine their parent directory instead, which carries the name that
  actually matters, and a mined term that collides with the seed jargon is no longer
  eligible for fuzzy repair.

## [0.1.0] - 2026-10-16

First release.

### Added

- Streaming voice input for pi, one shortcut away (`ctrl+alt+z` by default), with
  hold-to-talk and tap modes and a hard cap so a stuck key cannot leave the microphone
  open.
- **Two interchangeable backends**: Deepgram `nova-3` streaming, or local Parakeet via
  `transcribe-cpp`.
- **Repository-aware vocabulary biasing.** Keyterms are mined from the project name,
  the git repository, file paths touched by the session, paths mentioned in messages,
  a developer-jargon seed list and your own list, then sent to Deepgram as repeated
  `keyterm` parameters (native biasing) and updatable live with a `Configure` message.
  The local backend, which cannot be vocabulary-biased (`supports("vocabulary")` is
  `false` for the Parakeet GGUFs), gets a deterministic correction pass instead:
  re-joining identifiers the recogniser split, and repairing one misheard token within
  a small edit distance of a keyterm.
- **A recovery layer that never loses a sentence**: one early retry before the first
  transcript, replay of the retained audio when a stream dies unconfirmed, salvage of a
  partial transcript when the socket dies late, promotion of an unreported interim, and
  a circuit breaker after repeated fast failures. Audio is buffered in memory only and
  never written to disk.
- **Local batch mode with pause-aware chunking**: audio is cut at real (silence-checked)
  pauses while you speak and transcribed in the background, so only the tail is left at
  finalize. The pause threshold is derived per recording, and a chunk is only cut where
  the signal is genuinely quiet, so a chunk never starts mid-word.
- **Guided setup** (`/voice setup`, or the first shortcut press with no settings):
  backend, key or model (with checksum-verified, resumable model downloads), run mode,
  and shortcut, ending in an overview of the result.
- Commands: `/voice`, `/voice setup`, `/voice backend`, `/voice model`, `/voice key`,
  `/voice set`, and `/voice-keyterms add|remove|list`.
- Diagnostics that name the cause rather than the symptom — a failed connection
  distinguishes a rejected key, an unreachable host, and an HTTP error.
- A `media/screenshot.png` before/after card, exposed to the gallery as `pi.image`.

[Unreleased]: https://github.com/sfgartland/better-pi-voice/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/sfgartland/better-pi-voice/releases/tag/v0.1.1
[0.1.0]: https://github.com/sfgartland/better-pi-voice/releases/tag/v0.1.0
