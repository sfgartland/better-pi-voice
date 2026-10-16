# Future: Silero-VAD pause detection (steal the `pi-voice` chunking trick)

**Status:** not implemented — recorded 2026-10-16
**Source studied:** `@earendil-works/pi-voice` 0.2.0 (`src/vad.ts`, `src/chunking.ts`),
published 2026-10-16, MIT.

## What `pi-voice` does

`@earendil-works/pi-voice` cuts long local clips at pauses using a **real Silero VAD
model**, not an audio-level heuristic:

- It bundles `models/silero-vad-v6.2-F32.gguf` (1.24 MB) and loads it as a *separate*
  transcribe-cpp model (`loadModel` → `createVadSession({ nThreads: 1 })`). It is not a
  role of the ASR model.
- Live, it feeds each **512-sample (32 ms) frame** to the VAD session (`streamFeed`) and
  gets one speech probability back; a `SmoothedVad` (borrowed from
  `cjpais/Handy`, MIT) smooths the stream.
- `speechSegments(probs, samples)` reimplements Silero's `get_speech_timestamps`
  (threshold 0.5, 250 ms min speech, 100 ms min silence, 30 ms padding) to turn the
  probabilities into speech segments.
- `cutCandidates` + `planCuts` then greedily pick one cut per pause, preferring long
  pauses near a 30 s target, never leaving under 5 s, hard-cutting at 40 s only when
  there is no pause at all. It cuts **live while you speak** (`ChunkedDictationStream`).
- Whole clips are scored with `session.run(pcm).probs` when only a batch pass is needed.

## Why it is better than what we have

Our `ParakeetBatchStream.pauseThreshold()` (in `src/backends/parakeet.ts`) infers a
pause from RMS levels: the second-lowest chunk level is the floor, the 75th percentile
is speech, and anything in the lowest 30 % of that range is a pause. It needs no extra
model, but it is a heuristic and it is fragile in exactly the cases VAD exists for:
steady background noise, music, and rooms where speech and noise overlap in level. A
real VAD separates "is this frame speech" from "is this frame loud", which is what the
cut decision actually depends on.

## Can we adopt it? Yes

Our installed `transcribe-cpp` (0.4.0) exposes the VAD role directly:

```ts
// from transcribe-cpp/dist/types.d.ts
model.vadInfo                       // { frameSamples: 512, … } for a "vad" model
const vad = model.createVadSession({ nThreads: 1 });
const { firstFrame, probs } = await vad.streamFeed(frame); // live, one prob per frame
const tail = await vad.streamFlush();
const { segments, probs } = await vad.run(pcm, { threshold: 0.5 }); // whole clip
```

So the port is: add a VAD model to the download catalog (or bundle the 1.24 MB GGUF),
open one `VadSession` per recording, feed it the same PCM the batch stream already
receives, and replace `pauseThreshold()` + the level scan in `cutIfReady()` with
`speechSegments` + `planCuts`.

## Suggested shape

Keep the level heuristic as a fallback, behind one interface:

```ts
interface PauseDetector {
  /** Cut offsets (in bytes) available so far, best first. */
  cuts(capturedBytes: number): number[];
  push(pcm: Buffer): void;
}
// VadPauseDetector   — when a VAD model is loaded
// LevelPauseDetector — current amplitude logic, used when VAD is unavailable
```

`ParakeetBatchStream` chooses `VadPauseDetector` when a VAD model is present and falls
back to `LevelPauseDetector` otherwise, so the extension still works on a machine that
has only the ASR GGUF. The audio meter keeps using `levelFromS16le` regardless.

## Caveats to plan for

- **Extra model + CPU.** +1.24 MB on disk, and VAD scoring runs on every frame at
  `nThreads: 1`. It is cheap, but it is not free, and it must be released with the ASR
  model (see `idleUnloadMs`).
- **Async scoring.** `streamFeed` is async, so probabilities arrive a frame or two
  behind the audio; the cut logic must tolerate probs lagging the buffer. `pi-voice`
  handles this with a `LOOKAHEAD` before a live cut is final; copy that.
- **Licensing.** Both `pi-voice` and Handy are MIT, so porting is fine, but attribute
  the `SmoothedVad` idea and the segmentation rules in a comment. The Silero VAD model
  itself is MIT (snakers4/silero-vad); record its provenance in
  `docs/reports` or a `models/README.md`.
- **Tests.** The segmentation/planning functions are pure and easy to test from
  synthetic probability arrays — far easier than testing the amplitude heuristic.
  Port `speechSegments`/`cutCandidates`/`planCuts` behind tests first.
- **Pin `transcribe-cpp`.** `package.json` currently floats (`"*"`); a VAD-role
  dependency should pin a minor for reproducibility.

## Checked: the recommended Parakeet does *not* support vocabulary

The `src/backends/parakeet.ts` header says *"Parakeet cannot be vocabulary-biased.
transcribe-cpp's `StreamOptions` carries no prompt field…"*. The *reason* is now
outdated — transcribe-cpp 0.4.0 adds `vocabulary?: readonly string[]` and
`prompt?: string` to both `TranscribeOptions` and `StreamOptions`, gated by
`model.supports("vocabulary")` / `model.supports("context_prompt")` — but the
*conclusion* holds for the model we ship. Measured by loading
`parakeet-tdt_ctc-110m-Q8_0.gguf` with transcribe-cpp 0.4.0:

```
capabilities: { nativeSampleRate: 16000, languages: ["en"], maxTimestampKind: "token",
                supportsStreaming: false, maxAudioMs: 0, … }
vadInfo:      model does not serve the requested role (status 20)
supports(vocabulary)     = false
supports(context_prompt) = false
supports(initial_prompt) = false
supports(cancellation)   = true
```

So for this model the deterministic `correctTranscript` pass is still the only local
biasing we have, and VAD must come from a **separate Silero model** — the ASR model
cannot score itself. The `supports(...)` check is cheap; run it for any new catalog
model before assuming a family is unbiasable. Fix the stale "stream options carry no
prompt field" wording in the header comments when touching that file.
