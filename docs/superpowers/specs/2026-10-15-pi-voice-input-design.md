# Pi voice input — Deepgram + local, Claude Code's pipeline

**Status:** implemented — `packages/add/pi-add-better-pi-voice` · 2026-10-15
**Reference behaviour** reverse-engineered from `claude-code@2.1.295`

---

## 0. Outcome (added after implementation)

Built as designed, with these findings that came from doing it rather than specifying it:

- **Deepgram auth is subprotocol-only in practice.** `new WebSocket(url, ["token", key])`
  opens. Passing an options object with an `Authorization` header hangs in the CONNECTING
  state under Bun, and an empty protocols array plus headers is rejected with "Expected
  101 status code". Both were measured, not assumed.
- **Keyterm biasing earns its place, measured against the live API.** On a fixed sentence
  containing five terms: without keyterms `tsconfig` came back as **"T's config"** and
  `subagent` as "sub agent"; with the repository's keyterms both were correct, as were
  `marginalia` and `worktree`. This reproduced on every run, and it is the justification
  for the whole feature.
- **Transpositions need Damerau distance.** `subagnet` → `subagent` is an adjacent swap,
  which plain Levenshtein scores as 2 — outside the bound for short tokens. Scoring it as
  1 makes the repair work exactly where it matters most.
- **Focus mode was dropped** (see §7.6) and **an `apiKeyFile` setting was added**, because
  the key in this environment lives in another project's `.env` rather than the shell.
- A live smoke script (`scripts/deepgram-smoke.ts`) exists, because none of the above is
  provable offline.

## 1. Intent and why

Claude Code's voice input is unusually good. I reverse-engineered it (findings in
[Appendix A](#appendix-a--what-claude-code-actually-does)) and the quality does not come from a
magic model. It comes from three things stacked:

1. **Streaming ASR at 16 kHz mono** with server-side endpointing, so finals land in a few hundred ms.
2. **Repo-derived keyterm biasing** — the cwd name, project file names, and a hardcoded list of
   developer jargon (`MCP`, `worktree`, `subagent`, `OAuth`, `gRPC`…) are pushed to the recogniser
   before every session. This is the single biggest accuracy lever and it is cheap.
3. **A recovery layer that never loses text** — retry once before the first transcript, replay the
   buffered audio if the stream silently drops, salvage the partial transcript on a mid-stream
   error, promote an unreported interim to final when the socket dies, and a circuit breaker so a
   broken mic fails loudly instead of silently.

Pi already has two dictation paths and neither can be biased: `~/.pi/agent/stt.json` (`ctrl+r`,
OpenAI `gpt-4o-mini-transcribe`, batch) and `@earendil-works/pi-voice` (`ctrl+alt+z`, local
`transcribe-cpp` + `parakeet-unified-en-0.6b`, streaming). Both throw away the fact that a coding
agent knows exactly which words the user is about to say.

**This design builds one pi extension with two interchangeable backends — Deepgram (cloud, native
keyterms) and Parakeet (local, streaming) — sharing one pipeline: capture, keyterm mining, the
streaming session state machine, the recovery semantics, and the UI.**

## 2. Goals

| # | Goal |
|---|------|
| G1 | One extension, two backends behind one interface: **Deepgram** and **local Parakeet**. |
| G2 | **Shared keyterm mining** from the pi session (cwd, repo, files touched, user list, seed jargon) feeding both backends. |
| G3 | Claude Code's **recovery semantics**: interim→final commit discipline, one early retry, silent-drop replay, partial salvage, circuit breaker, precise error taxonomy. |
| G4 | Two **interaction modes** in v1 — hold-to-talk and tap-to-toggle — with the same timings as the reference. (Focus mode is deferred; see §7.6.) |
| G5 | **Live UX**: audio-level widget above the editor, interim text in the editor, status indicator, actionable errors. |
| G6 | Fit the `pi-extensions` house style: one package one problem, minimal config surface, biome + tsc clean, tested. |
| G7 | **Zero keystroke risk**: the raw-input handler must never swallow or reorder normal typing. |

## 3. Non-goals

- Not a replacement for pi-voice's model picker, onboarding, ratings, or visualizer catalog. Those
  stay in pi-voice if the user keeps it.
- Not TTS / audiobook (that is `speakd`, unchanged).
- Not replicating Anthropic's server-side `use_conversation_engine` — it is opaque and not reachable.
- No LLM post-editing of transcripts in v1 (no "clean up my dictation with a model" pass). It adds
  latency and a second dependency. Noted as a future extension.
- Not always-on / wake-word / VAD-triggered capture. Recording starts and stops on user action.

## 4. Anti-goals

What would make this a failure even if it technically works:

- **A1 — Latency.** Interim text lagging speech by more than ~1 s, or finals landing more than
  ~2 s after the user stops. Perceived speed *is* the feature.
- **A2 — Correction that corrupts.** A repair pass that "fixes" correct words is worse than no
  biasing at all. Conservative by default, observable, revertible.
- **A3 — Breaking normal typing.** A terminal input listener that swallows keys, eats escapes, or
  interferes with paste. Must be transparent when idle.
- **A4 — Surprise submission.** Never call `sendUserMessage` unless the user explicitly opted into
  auto-submit. Default: text lands in the editor for review.
- **A5 — Silent failure.** "Voice did nothing" with no message. Every failure path must explain
  itself (mic missing / no network / no speech / auth missing).
- **A6 — Cost surprise.** Cloud audio is billed by the minute. Long-held sessions must be bounded
  and the cost model must be stated in the README.
- **A7 — Colliding shortcuts.** Two extensions racing for `ctrl+alt+z` produces a confusing mess.

## 5. Constraints (decided by the requester)

- **Cloud backend is Deepgram.**
- **Local backend is Parakeet**, via the already-installed `transcribe-cpp` binding, reusing the
  same architecture "as far as possible" so the local path inherits the same benefits.
- Lives in the **pi-extensions monorepo** as a new workspace package.
- **Pi extension API only** — no patching pi or any `node_modules` package.
- **Linux-first** (the requester's machine) but must not regress macOS/Windows.

## 6. Reference behaviour (what we are recreating)

Full extraction notes in [Appendix A](#appendix-a--what-claude-code-actually-does). The load-bearing
semantics we adopt:

| Behaviour | Reference value | We adopt |
|---|---|---|
| Audio format | PCM s16le, 16 kHz, mono | yes |
| Audio level | RMS over 16-bit samples, `sqrt(min(rms/2000, 1))` | yes |
| Frame coalescing | ≤ 32 000 bytes (1 s) per send | yes |
| Keepalive | every 8 s (Deepgram requires ≤ 10 s) | yes (5 s for Deepgram) |
| Finalize timeouts | safety 5 s, no-data 1.5 s | yes |
| Interim handling | keep only the latest interim; promote to final on socket death | yes |
| Early-error retry | once, after 250 ms | yes |
| Circuit breaker | 3 early failures within 10 s → pause | yes |
| Silent-drop replay | on `no_data_timeout` + audio seen + connected + 0 chars + buffer present | yes |
| Hold-mode fallback | 600 ms no-auto-repeat → arm release timer; 200 ms release debounce | yes |
| Tap-mode timeouts | 15 s silence finish, 120 s max | yes |
| Focus-mode timeout | 5 s silence teardown | yes |
| Keyterm saver | ASCII only, deduped, camelCase-split, 3–20 chars | yes (limits widened for Deepgram) |

## 7. Architecture

```
packages/add/pi-add-voice/
├── index.ts                 # extension factory: shortcuts, commands, settings, lazy runtime
└── src/
    ├── runtime.ts           # wires pi API → controller; owns session-scoped resources
    ├── capture.ts           # microphone → PCM stream (platform strategies)
    ├── controller.ts        # the state machine + recovery semantics (the heart)
    ├── formats.ts           # s16le ↔ Float32, resample, level metering, frame coalescing
    ├── backends/
    │   ├── types.ts         # VoiceBackend / VoiceStream interface + capabilities
    │   ├── deepgram.ts      # wss://api.deepgram.com/v1/listen
    │   ├── parakeet.ts      # transcribe-cpp streaming session
    │   └── index.ts         # resolve backend from settings
    ├── keyterms/
    │   ├── seed.ts          # pi-flavoured jargon seed list
    │   ├── mine.ts          # cwd, git repo, session files → candidate terms
    │   ├── sanitize.ts      # normalise, dedupe, budget
    │   └── correct.ts       # conservative post-hoc repair for non-biasing backends
    ├── ui.ts                # level widget, status text, editor text, notices
    └── settings.ts          # read/validate ~/.pi/agent/voice-input.json, defaults
```

### 7.1 Backend interface

```ts
export type VoiceCapabilities = {
  streaming: boolean;                 // can emit interims
  biasing: "native" | "none";         // "native" = keyterms change decoding
  languages: string[];                // advisory; empty = server-decided
};

export type VoiceEvent =
  | { type: "interim"; text: string }   // tentative; may be superseded
  | { type: "final"; text: string }     // committed; never retracted
  | { type: "error"; message: string; fatal?: boolean; code?: string };

export type StartOptions = {
  language: string;
  keyterms: string[];                 // already sanitised
  signal: AbortSignal;
};

export type VoiceStream = {
  feed(pcm: Buffer): void | Promise<void>;  // never throws; may be async
  finalize(): Promise<FinalizeOutcome>;
  close(): void;
  isConnected(): boolean;
  updateKeyterms?(terms: string[]): void;  // Deepgram Configure, mid-session
};

/**
 * Backend-neutral. The reference implementation's Deepgram-shaped vocabulary
 * was deliberately not adopted here: the local backend has no such states.
 * Backends map their own outcome onto this, and the controller's recovery
 * rules key off it.
 */
export type FinalizeOutcome =
  | "complete"        // everything fed was accounted for (or nothing was spoken)
  | "closed_early"    // session died; audio fed late may never have been decoded
  | "timeout"         // no confirmation within the safety window
  | "already_closed";

export interface VoiceBackend {
  readonly id: string;
  readonly capabilities: VoiceCapabilities;
  readonly model: string;
  checkAvailability(): Promise<{ available: boolean; reason?: string }>;
  start(options: StartOptions, emit: (e: VoiceEvent) => void): Promise<VoiceStream | undefined>;
}
```

**Backpressure.** The controller coalesces to ≤ 32 000-byte frames and keeps a bounded send queue
per stream. `feed` is awaited when it returns a promise; if the queue exceeds its bound (≈ 10 s of
audio) the **oldest** frames are dropped with a warning, because stalling capture is worse than
dropping it. No defensive copy is needed: local conversion s16le → Float32 *is* the owner of the
buffer that `transcribe-cpp` borrows, and a socket write copies.

**Mapping per backend.** Deepgram maps `Results.is_final` → `final`, otherwise → `interim`, with
`Results.speech_final` / `UtteranceEnd` as finalize milestones. The local backend sets
`commitPolicy: "stable_prefix"` (with `stablePrefixAgreementN`) so `StreamText.committed` → `final`
and `StreamText.tentative` → `interim` — precisely the interim→final discipline the reference
hand-rolls, and which `transcribe-cpp` already exposes as a first-class knob.

### 7.2 Capture

Internal contract: **a stream of `Buffer` chunks of PCM s16le, 16 kHz, mono.** Everything else
converts at the edges.

- **Linux:** `arecord -f S16_LE -r 16000 -c 1 -t raw -q -`. Availability probe = the same command
  writing to `/dev/null` with a 150 ms timeout, plus a `/proc/asound/cards` read to distinguish
  "no microphone at all" from "arecord missing". Fallback: `rec -q --buffer 1024 -t raw -r 16000
  -e signed -b 16 -c 1 -` (SoX), with **no** silence arguments — endpointing is the server's job.
- **macOS/Windows:** v1 shells out to SoX `rec` with the same arguments; a native addon is out of
  scope. Explicitly documented as a degraded path.
- **Resampling:** if 16 kHz is not achievable (device reports 48 kHz only), capture at the device
  rate and downsample to 16 kHz in `formats.ts`. Note in the README that ALSA usually resamples for
  us. **Do not silently send 48 kHz audio labelled 16 kHz.**
- **Failure reasons** must be specific, mirroring the reference: microphone access denied, no audio
  device, recorder missing (with the exact install command for the detected package manager), and
  the WSL case (WSLg present vs not).

### 7.3 Controller (state machine)

States: `idle → arming → recording → processing → idle`, plus `paused` (circuit breaker open).

Recording lifecycle:

1. `arming` — load backend, `checkAvailability()`, resolve keyterms (cached per session + cwd), open
   the stream. Audio arriving before `ready` is **buffered in memory**, not dropped.
2. `ready` — flush the buffer coalesced into ≤ 32 000-byte frames, start the keepalive timer, start
   level metering.
3. `recording` — feed chunks; render the level widget; render interims into the editor.
4. `processing` — `finalize()`; on success, append the final text to the editor.
5. `idle` — clear timers, drop the audio buffer, close the socket.

Recovery rules, in the order they are checked:

- **Early error before any transcript** → retry the whole stream **once**, 250 ms later.
- **`finalize()` returns `no_data_timeout`** and audio was seen and the socket connected and no text
  arrived and the audio buffer is intact and we have not replayed yet → **replay the buffered audio
  on a fresh connection**, then take that result.
- **Mid-stream error** → salvage the accumulated final text via `onTranscript`, mark
  `partial_salvaged`, report the error, return to idle.
- **Socket closes with an unreported interim** → promote the interim to a final. Never lose words.
- **3 early failures within 10 s** → open the breaker, move to `paused`, message the user, and
  require one successful start to clear.

The raw audio buffer is **in memory only**, capped at the max session length, cleared on success and
on shutdown. It is never written to disk.

### 7.4 Keyterms

Mining sources, in priority order (all optional, all cheap):

1. `keyterms.user` from settings — verbatim, highest priority.
2. The **seed list** (pi-flavoured, replacing the reference's Claude-Code-flavoured one):
   `MCP, symlink, grep, regex, localhost, codebase, TypeScript, JSON, OAuth, webhook, gRPC,
   dotfiles, subagent, worktree, transcript, skill, extension, settings, backend, endpoint,
   fuzzy, patch, diff, commit, branch, rebase, stdin, stdout, stderr, regex, payload`.
   (Final list to be tuned; this is a starting point.)
3. **cwd basename** and the **git repo root name**.
4. **Session files** — file names from `Read`/`Edit`/`Write` tool calls in the current session
   branch, plus file paths mentioned in the last N turns. Basenames with the extension stripped,
   camelCase split, `[-_./\s]+` split.
5. `voice-keyterms add <term>` writes to the user list.

Sanitisation: strip non-printable/non-ASCII, split camelCase, split on `[-_./\s]+`, keep tokens of
length 3–20, dedupe case-insensitively, preserve original casing for proper nouns, then truncate to
a budget. Deepgram's hard limit is **100 keyterms / 500 tokens per request**; we default to a
**~80-term budget** and surface a warning when truncated (an over-limit update can silently kill a
Deepgram stream — see Appendix B).

### 7.5 The local-backend problem, and the honest answer

Parakeet cannot be biased. This is a real limitation, not a detail:

- `transcribe-cpp`'s `StreamOptions` carries no prompt/vocabulary field. Parakeet's stream tuning
  knobs are `attContextRight`, the `ParakeetBufferedStreamOptions` window (`leftMs`/`chunkMs`/
  `rightMs`), and the cross-family `commitPolicy`/`stablePrefixAgreementN` — none of which bias
  vocabulary.
- `initialPrompt` **does** exist in `transcribe-cpp` — but only in `WhisperRunOptions`, i.e. the
  *whisper family*, which is a **run-slot (batch) extension, not a stream-slot (streaming) one**.
  Whisper gives native biasing but no interims; Parakeet gives interims but no biasing.
- `capabilities.supportsStreaming` tells us which of the two we are holding.

Three ways to give the local path "the same benefit", in increasing cost:

| Option | Interims | Native biasing | Cost |
|---|---|---|---|
| **L1.** Parakeet streaming + conservative correction pass | yes | no (repaired) | cheapest, recommended default |
| **L2.** Whisper batch with `initialPrompt` | no | yes | one model, no live text |
| **L3.** Hybrid: Parakeet for interims, Whisper re-pass at finalize | yes | yes | two models resident |

**Recommendation: L1 as the default, L3 as an opt-in setting.** L1 keeps the live feel and fixes the
few words that actually matter; L3 is the true local analogue of keyterm prompting.

The correction pass (`correct.ts`) must be conservative and observable:

- Only single tokens are candidates. Never rewrite multi-word spans.
- A token is repaired only if a keyterm is within **edit distance ≤ 1** for length ≤ 7, or
  **≤ 2** for length ≥ 8.
- Never repair a token that is already an exact keyterm.
- Never repair a token shorter than 5 characters (too little information).
- Case-insensitive comparison; the keyterm's casing wins.
- Every change is logged with before/after at debug level, and the setting is `off | safe`
  (default `safe`). A `report` mode applies nothing and only logs what it *would* change, for
  tuning.

This is deliberately dumb and deterministic. Fuzzy repair is the kind of thing that quietly ruins
dictation, so it must be trivially auditable and trivially disabled.

### 7.6 Interaction modes

| Mode | Start | Stop | Safety timeouts |
|---|---|---|---|
| `hold` | key press | key release | 600 ms no-auto-repeat fallback, 200 ms release debounce |
| `tap` | key press | second press | 15 s silence auto-finish, 120 s hard cap |

**Focus mode is deferred to v2.** It cannot be built as specified: the extension API exposes no
editor-focus event, and pi's editor holds focus for the whole session, so "focused" would collapse
to "always on" — directly contradicting the not-always-on non-goal. A real focus mode needs the
editor wrapped via `setEditorComponent` to observe blur/focus, which is separate work. Left to §12.

**Hold-to-talk feasibility — confirmed.** `pi.registerShortcut` is discrete-press only, but
`ctx.ui.onTerminalInput(handler)` receives raw terminal input, and `@earendil-works/pi-tui` exports
`isKeyRelease(data)`, `isKeyRepeat(data)`, `isKittyProtocolActive()`, and
`KeyEventType = "press" | "repeat" | "release"`. Release events require the Kitty keyboard protocol
with **flag 2 (report event types)**, and pi requests `DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7`
(= 1|2|4) in `terminal.js` before falling back to `modifyOtherKeys`. Release events reach extension
`onTerminalInput` listeners ahead of the focused-component filter.

**This machine negotiates it:** `TERM=xterm-kitty`, `KITTY_WINDOW_ID` set, no tmux, no SSH. So hold
mode is the correct default here. It is *not* guaranteed elsewhere — a terminal or multiplexer that
does not honour the protocol gets `modifyOtherKeys` instead and releases never arrive. Hence: **hold
mode is enabled only once a release event has actually been observed on the configured key;
otherwise the extension falls back to tap mode and says so once.** Probing the terminal rather than
assuming is a hard requirement — do not ship a hold mode that silently never releases.

macOS native modifier polling (`isNativeModifierPressed`) exists but is **not exported from the
pi-tui package root** — only reachable by deep import. Do not depend on it; it is not public API.

**Shortcut collisions cannot be prevented.** pi-core permits two extensions to register the same
shortcut and silently lets the later-loaded one win, emitting only a diagnostic. So the extension
must *detect* a conflicting pi-voice binding at startup and warn, not assume it owns the key.
Default binding `ctrl+alt+z`, and `/voice-input` must not reuse pi-voice's `voice-settings`,
`voice-onboarding`, or `transcribe` command names.

### 7.7 UI

- **Level widget:** `ctx.ui.setWidget(key, factory, { placement: "aboveEditor" })`, rendering a
  rolling 16-sample level bar from `sqrt(min(rms/2000, 1))`. Must render at a low frame rate
  (≤ 20 fps) and stop entirely when idle — the TUI is on the hot path.
- **Status:** `ctx.ui.setStatus(key, text)` — `● rec 0:04`, `⋯ processing`, `⌛ paused`.
- **Editor text:** `ctx.ui.getEditorText()` / `setEditorText()` to append finals;
  `ctx.ui.pasteToEditor()` when the text is long. Interims must be written so they never corrupt
  what the user typed while dictating: capture the editor text at arming, render
  `prefix + interimTranscript`, and on final commit `prefix + finalText`.
- **Errors:** `ctx.ui.notify(message, "error")` with the specific cause.
- **Non-TUI modes:** guard everything behind `ctx.mode === "tui"`; the controller must run headless
  (a `voice-transcribe` tool is a natural later addition, not v1).

### 7.8 Settings

Own file, house style (minimal), `~/.pi/agent/voice-input.json`, every field optional:

```jsonc
{
  "backend": "deepgram",              // "deepgram" | "parakeet"
  "shortcut": "ctrl+alt+z",
  "mode": "hold",                     // "hold" | "tap"   ("focus" is v2)
  "language": "en",
  "deepgram": {
    "apiKeyEnv": "DEEPGRAM_API_KEY",
    "model": "nova-3",
    "smartFormat": true,
    "endpointingMs": 300,
    "utteranceEndMs": 1000
  },
  "parakeet": {
    "modelPath": null,                // null = read from pi-voice.json, then catalog default
    "whisperRepass": false            // L3
  },
  "keyterms": {
    "enabled": true,
    "seed": true,
    "mineSessionFiles": true,
    "maxTerms": 80,
    "user": []
  },
  "correction": "safe",               // "off" | "safe" | "report"
  "submitOnStop": false               // false = land in the editor for review
}
```

Secrets never go in this file. `DEEPGRAM_API_KEY` is read from the environment (or whatever
`apiKeyEnv` names), and a missing key produces one clear message naming the variable.

## 8. Testing

The pipeline must be testable without a microphone, a network, or a model:

- **A fake backend** implementing `VoiceBackend` with scripted event sequences, an injectable
  failure schedule, and a fake clock. Every recovery rule gets a test: early retry, silent-drop
  replay, partial salvage, interim promotion, circuit breaker trip and clear.
- **A fake capture** yielding synthetic PCM at a controllable rate, including silence, a loud
  signal, and a clipped signal, to exercise level metering and `hadAudioSignal`.
- **Formats:** round-trip s16le ↔ Float32, resample 48 k → 16 k, frame coalescing boundaries
  (including a chunk larger than the coalesce target).
- **Keyterms:** sanitisation edge cases (camelCase, unicode, non-ASCII, dupes, over budget,
  1–2 char tokens, punctuation-only), the token budget, and the correction pass's refusal cases.
- **Deepgram backend:** a local WS server that speaks the documented protocol — `Results` /
  `UtteranceEnd` / `Metadata` / `Error`, plus `KeepAlive` / `CloseStream` / `Configure` from the
  client. Assert the query string (including repeated `keyterm` params) and that we never send
  audio after `CloseStream`.
- **A scripted replay harness:** record a WAV once, replay it through the real pipeline into both
  backends, and diff the transcripts. This is how keyterm changes get evaluated.

Golden-path acceptance: hold a key, speak a sentence containing `subagent`, `worktree`, and a
project-specific file name, release; assert the editor text contains all three spelled correctly in
under a stated latency budget.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Terminal does not report key release | Runtime probe; degrade to tap mode with a one-time notice. Never fail silently. Confirmed working on the requester's Kitty. |
| Two extensions silently race for one shortcut | pi-core lets the later-loaded registration win with only a diagnostic. Detect pi-voice's binding at startup and warn. |
| `onTerminalInput` interferes with typing | Handler is a pure observer that returns `{ consume: false }` (or `undefined`) except for the exact configured key while idle-and-enabled. Tested against paste, arrows, and escape sequences. |
| Deepgram keyterm limits silently kill a stream | Hard client-side budget, warning on truncation, and a test asserting the count. |
| Cloud cost | Bounded session length, stated cost model, cheap local mode, and the mode/backend choice surfaced in `/voice-input`. |
| Privacy — cloud audio | README states plainly that cloud mode sends audio to Deepgram; local mode is the private path. Local backend is the documented default for anything sensitive. |
| Fuzzy correction corrupts text | Conservative rules, `off`/`report` modes, per-change debug logging. |
| Two extensions fighting over a shortcut | Configurable binding; README says to disable pi-voice's shortcut if keeping both. |
| Parakeet accuracy on jargon stays poor | L3 whisper re-pass available; `report` mode measures whether correction is even needed. |

## 10. Decisions I made (check these)

These are mine, not the requester's. Each is reversible.

1. **A new standalone package** rather than patching `@earendil-works/pi-voice` or contributing
   upstream. pi-voice is a third-party package consumed from `.pi/agent/npm`; its backend
   abstraction is parakeet/transcribe-cpp-specific, and patching `node_modules` breaks on update.
2. **The extension owns its own capture path** instead of importing pi-voice internals (same reason).
   It does read `~/.pi/agent/pi-voice.json` once for a default Parakeet model path.
3. **Default backend `deepgram`** (the requester asked for it first), with `parakeet` one setting away.
4. **Default mode `hold`**, degrading to `tap`. The reference's most-used mode is hold-to-talk.
5. **Default `correction: "safe"`** for the local backend and a no-op for Deepgram.
6. **`submitOnStop: false`** — text lands in the editor. Auto-submit is opt-in only (anti-goal A4).
7. **Deepgram `nova-3`**, not Flux. Flux is purpose-built for turn-taking voice agents; we control
   start/stop ourselves and want passive transcription with endpointing. Nova-3 also has the
   mid-stream `Configure` keyterm update on the global endpoint. *(Revisit if latency disappoints.)*
8. **Secrets from the environment**, never from a settings file.
9. Design doc lives at `docs/superpowers/specs/` in this repo (no existing docs convention to match).
10. **Focus mode deferred to v2** — unimplementable as specified (see §7.6). v1 ships `hold` + `tap`.
11. **`feed` may be async and the finalize vocabulary is backend-neutral** — `transcribe-cpp` borrows
    buffers and has no Deepgram states. The local backend adopts `commitPolicy: "stable_prefix"`
    rather than hand-rolling interim→final (see §7.1).
12. **v1 does not provision local models.** Resolution order: `parakeet.modelPath` in settings →
    `~/.pi/agent/pi-voice.json`'s configured model → a clear error telling the user to set one. No
    download and no catalog UI. `transcribe-cpp` ships as a dependency (its per-platform native
    prebuilds are already optional deps).
13. **Command namespace** `/voice-input` and `/voice-keyterms`, avoiding pi-voice's names.

## 11. Open questions for the requester

Carried to chat, most important first.

1. **Coexistence with pi-voice, and who owns `ctrl+alt+z`.** Keep both (disabling one binding) or
   retire pi-voice's dictation entirely? Decides the default binding, whether we must detect and
   neutralise a collision, and how much of pi-voice's setup UI we reproduce.
2. **Selection between the three local biasing options (L1/L2/L3)** — does the hybrid L3 justify a
   second resident model, or is L1's correction pass enough to start?
3. **Deepgram account and key** — is there an existing key, and is `DEEPGRAM_API_KEY` in the
   environment an acceptable contract?
4. **Latency budget** — what number counts as "as good as Claude Code" for the acceptance test, and
   must that test run offline (fake backend only) or against the live Deepgram API?
5. **Package name** — `better-pi-voice` as a standalone repo, or a name under `packages/add/`?

## 12. Left to the builder

- Exact seed-list wording and size.
- Editor-text composition details (cursor position, selection handling, undo behaviour).
- Whether interims are typed live at all in v1, or only finals (the reference gates live typing
  behind a flag — recommend gating it too).
- The precise frame rate and cell budget of the level widget.
- Whether `updateKeyterms` (Deepgram `Configure`) ships in v1 or v2. Recommendation: v1 sets
  keyterms at session start only; with a session cache so the expensive mining runs once.
- **The focus-mode trigger**, if v2 wants it: which editor-focus mechanism (`setEditorComponent`
  wrap, overlay/blur detection) and what "focused" should mean for a long-lived TUI editor.
- Error message wording.
- Test harness structure and fixture audio.

---

## Appendix A — What Claude Code actually does

Extracted from `claude-code@2.1.295`, a 256 MB Bun-compiled binary (BUILD_TIME
`2026-10-08T16:50:59Z`). Offsets below are byte offsets in a `strings -n 6` dump of that binary.
This is extracted code, not inference, except where marked.

### The transport

```
wss://<BASE_API_URL>/api/ws/speech_to_text/voice_stream
  ?encoding=linear16&sample_rate=16000&channels=1
  &endpointing_ms=300&utterance_end_ms=1000
  &language=<lang>&use_conversation_engine=true
  [&forward_interims=typed]

Headers: Authorization: Bearer <claude.ai OAuth access token>
         User-Agent, x-app: cli, anthropic-client-platform
         x-config-keyterms: <comma-joined ASCII terms, ≤1024 chars>
```

- Client→server: binary PCM s16le 16 kHz mono; `{"type":"KeepAlive"}` on open and every 8 s;
  `{"type":"CloseStream"}` to finalize.
- Server→client: `TranscriptInterim` / `TranscriptText` (`data`), `TranscriptEndpoint` (commits the
  pending interim as final), `TranscriptError` (`description`/`error_code`), `error` (`message`).
- Auth is Claude.ai OAuth, not an API key: *"Voice mode requires a Claude.ai account. Please run
  /login."* Cloudflare sits in front (`cf-mitigated`, `cf-ray` are inspected).
- **This is Anthropic-hosted ASR, not local.** The query-parameter names are verbatim Deepgram's
  streaming API; the message types are Anthropic's own. *Inference:* a Deepgram-shaped internal
  service, or a translation proxy in front of one. `use_conversation_engine=true` is not a Deepgram
  parameter and suggests a second, context-aware stage.

### Keyterm mining (offset 50231869)

```js
const seed = ["MCP","symlink","grep","regex","localhost","codebase","TypeScript",
              "JSON","OAuth","webhook","gRPC","dotfiles","subagent","worktree"];
```

Plus the cwd basename, tokens from an async project-file source, and any passed-in file paths.
Tokens: camelCase split → `[-_./\s]+` → length 3–20 → deduped → capped at 50 terms / 1024 chars.
That seed list is exactly the jargon generic ASR mangles. This is the biggest quality lever and it
is nearly free.

### Recovery layer (offset 50218701)

| Failure | Response |
|---|---|
| error before first transcript | retry once after 250 ms |
| `finalize()` → `no_data_timeout` with audio present | replay the buffered PCM on a fresh connection |
| mid-stream error | salvage partial text and inject it |
| socket closes with an unreported interim | promote the interim to final |

Plus a circuit breaker (3 early failures in 10 s → pause), differentiated errors
(`no_audio_signal` / `connection_failed` / `no_speech`), and a health probe against `/api/hello`
with `cf_mitigated_<status>` / `http_<status>` / `timeout` / `fetch_failed` classification.

### Capture (offset 50408000)

`arecord -f S16_LE -r 16000 -c 1 -t raw -q -` with a 150 ms probe and a `/proc/asound/cards`
"no soundcards" check; SoX `rec -q --buffer 1024 -t raw -r 16000 -e signed -b 16 -c 1 -` as
fallback; native N-API addon (`vendor/audio-capture/audio-capture.node`) on macOS/Windows; explicit
WSL guidance. Device capture is at 16 kHz directly; endpointing is server-side.

### Interaction

`hold` with auto-repeat detection (terminals do not always send keyup), `tap` with 15 s / 120 s
timeouts, `focus` mode with a 5 s silence teardown. Live 16-sample RMS level meter, interim text in
the input (optionally typed, ASCII-filtered), `TranscriptPreview`.

## Appendix B — Deepgram contract

Confirmed against `developers.deepgram.com` (`*.md` sources), 2026-10-15.

- **Auth:** `Authorization: Token <API_KEY>`, or — the form that actually works from a
  Bun/Node WebSocket, which cannot set request headers — the subprotocol
  `new WebSocket(url, ["token", API_KEY])`.
- **Endpoint:** `wss://api.deepgram.com/v1/listen?...`
- **Params:** `model=nova-3`, `encoding=linear16`, `sample_rate=16000`, `channels=1`,
  `interim_results=true`, `endpointing=300`, `utterance_end_ms=1000`, `smart_format=true`,
  `vad_events=true` (optional).
- **`keyterm`** — repeat the parameter per term (`keyterm=a&keyterm=b`). **Never comma-joined**: a
  comma-separated value is accepted and treated as one literal keyterm, silently boosting nothing.
  Multi-word phrases use `%20` or `+`. **Limit: 100 keyterms / 500 tokens.** Nova-3 and Flux only.
- **Mid-stream updates:** `{"type":"Configure","keyterms":[...]}` replaces the whole list; `[]`
  clears. Nova-3 `/v1/listen` on the global endpoint only. An over-limit update can stop
  transcription *without* an error and the server closes with `1011` after ~30 s — so check the size
  before sending.
- **Server messages:** `Results` (`is_final`, `speech_final`, `from_finalize`,
  `channel.alternatives[0].transcript`), `UtteranceEnd` (`last_word_end`), `SpeechStarted`
  (`timestamp`), `Metadata`, `Error`.
- **Client control:** `KeepAlive` (text frame, every 3–5 s; a 10 s gap closes with `NET-0001`),
  `CloseStream` (flush + `Metadata` + close), `Finalize`.
- **Model choice:** Nova-3 is recommended for meetings/captioning/multispeaker/far-field and has no
  turn detection; Flux is built for turn-taking voice agents. We want the former.
- **Errors/recovery:** the docs recommend buffering audio across reconnects (max 1.25× realtime
  stream rate) — the same strategy the reference implementation uses implicitly.
- **Not yet confirmed:** current per-minute pricing for streaming Nova-3. Confirm before publishing
  the README's cost section.
- **Measured live, 2026-10-15:** 6.65 s of 16 kHz mono PCM fed at real time produced
  interims roughly every second, an utterance final about 1.2 s after speech stopped, and
  `finalize()` returning `complete` in 3–1900 ms depending on how much audio was still
  unendpointed. Timings move with endpointing, so treat them as indicative rather than a
  benchmark.
