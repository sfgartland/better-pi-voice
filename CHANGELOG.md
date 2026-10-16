# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A `media/demo.mp4` storyboard of the before/after transcription, wired into the
  package manifest as `pi.video` so the [pi package gallery](https://pi.dev/packages)
  can preview it. This needs a release to take effect (the gallery reads the published
  manifest).

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

[Unreleased]: https://github.com/sfgartland/better-pi-voice/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sfgartland/better-pi-voice/releases/tag/v0.1.0
