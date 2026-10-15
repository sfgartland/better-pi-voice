# Handoff — `better-pi-voice` (streaming voice input for pi)

> **Update (later session):** the project has been extracted out of the
> `pi-extensions` monorepo into its own repository,
> `~/programing_linux/better-pi-voice`, package `@sfgartland/better-pi-voice`.
> The two items §3 left open — `/voice set` + `/voice model`, and first-run
> setup — are now implemented there with tests. §6's questions still need a
> microphone and are the same open questions.

**Date:** 2026-10-15 · **Written by:** the session that built it
**Package:** `packages/add/pi-add-better-pi-voice` in `~/programing_linux/pi-extensions`
**Read first:** [`docs/superpowers/specs/2026-10-15-pi-voice-input-design.md`](superpowers/specs/2026-10-15-pi-voice-input-design.md)
(the design, plus the reverse-engineering notes for Claude Code's voice input, which this
is modelled on) and [`docs/reports/2026-10-15-voice-model-benchmarks.md`](reports/2026-10-15-voice-model-benchmarks.md)
(what every model actually measures on this machine).

---

## 1. State right now — verified, not remembered

```
branch   feat/subagent-request-spawn-retries      (see gotcha G1)
status   clean, nothing uncommitted, nothing pushed
tests    216 pass  (bun test)
         tsc --noEmit clean · biome check clean
```

Latest commit `7112d55`. **Ten** commits are this work, from `5476c20` (the first)
through `7112d55`; the commit before them, `2d7377d`, is the pre-voice tip of the branch —
verified with `git log --oneline 2d7377d..HEAD`.

**How to verify** (all fast, no microphone or network needed):

```bash
cd ~/programing_linux/pi-extensions/packages/add/pi-add-better-pi-voice
bun test && bunx tsc --noEmit && bunx biome check .
```

Live checks, which do need the real thing:

```bash
# Deepgram, with and without keyterms
DEEPGRAM_API_KEY=$(grep '^deepgram_key=' ~/programing_linux/marginalia/.env | cut -d= -f2- | tr -d '"'"'"'') \
  bun scripts/deepgram-smoke.ts /tmp/vsmoke/speech.pcm subagent,worktree,tsconfig

# the local backend, one model, a raw PCM file
bun scripts/parakeet-smoke.ts /tmp/vsmoke/speech.pcm /path/to/model.gguf
```

`/tmp/vsmoke/` holds test audio (synthetic piper speech) and `/tmp/my-speech*.pcm` are the
human's real recordings. **`/tmp` is volatile** — copy anything you need.

## 2. What works

Two interchangeable backends behind one pipeline (`src/controller.ts` is the heart):

- **Deepgram** — `nova-3` streaming, biased with keyterms mined from the cwd, git repo,
  session file paths and a seed jargon list. This is the accuracy winner.
- **Local Parakeet** — via `transcribe-cpp`, now in **batch mode by default**.

Live config (`~/.pi/agent/better-pi-voice.json`) currently points at **local batch**:
`parakeet-tdt_ctc_110m`, `chunkSeconds: 30`, `silenceLevel: "auto"`, `idleUnloadMs: 0`.

Carried over from Claude Code's implementation, because these are what make it feel good:
one early retry, silent-drop replay from a retained in-memory buffer, partial-transcript
salvage, promotion of an unreported interim, a circuit breaker, and precise error taxonomy.
Plus repo-derived keyterm biasing, which is the single biggest accuracy lever.

### Non-obvious decisions, with the reason

Read these before changing anything — each one cost a bug to learn.

- **Batch is the default, not streaming.** Measured here: streaming decode runs at
  0.60–0.94× real-time (it *cannot* keep up), while batch runs 3.4–5.1× on the small
  models. The old default (streaming + `parakeet-unified-0.6b`) was the worst possible
  combination on this machine.
- **`parakeet-tdt_ctc-110m` is the default model** (135 MB, 4.22× real time). It is fastest,
  smallest, quickest to load, *and* the only small model verified to survive a chunk
  boundary — see the next point.
- **A chunk may only be cut where there is a genuine pause.** This is a correctness
  requirement, not tuning. `canary-180m-flash` returns an **empty transcript** for any clip
  that starts mid-utterance: slicing a 24 s clip at 4/6/8/10 s gave 0 characters every time,
  while `parakeet-tdt_ctc-110m` gave 292/253/215/192. A cut mid-word silently discards that
  chunk. If a model like canary is ever used, the cut rule must be far stricter.
- **The pause threshold is derived per recording** (`silenceLevel: "auto"`): the noise floor
  is the **second-lowest level** in the buffer, speech is the **75th percentile**, and a
  boundary is a pause below `floor + 0.3 × (speech − floor)`. A fixed threshold cannot work
  across rooms — of two real recordings, one never dropped below 0.05 (music playing) and the
  other paused around 0.3. The floor is a near-minimum rather than a low percentile because
  pauses are brief: two silent chunks in forty leave a 10th percentile reporting pure speech,
  so it found nothing.
- **`chunkSeconds` is a target, not a limit, and only its lower 70% matters.** The cut search
  starts at 70% of the target and **runs to the end of the captured buffer**, cutting at the
  first pause. An earlier version capped the search at the target and anchored it to the
  buffer start, so a pause falling outside that span meant *nothing was ever cut again* and
  the whole utterance arrived at the end. That was a live bug; there is a regression test
  named for it.
- **Deepgram auth is subprotocol-only**: `new WebSocket(url, ["token", key])`. Passing
  headers needs Bun's options object, which hangs in CONNECTING; headers *plus* an empty
  protocols array is rejected with "Expected 101 status code". Measured, not guessed.
- **The Deepgram key comes from a dotenv file** (`deepgram.apiKeyFile`) as well as the
  environment, because the key lived in another project's `.env` and exporting it in every
  shell is worse.
- **Never write microphone audio to disk.** The replay buffer is in memory by design. Do not
  change that casually — it is a privacy property, and it is also why no recording of the
  user exists for accuracy testing.

## 3. What is NOT done — the reason for this handoff

Two items were deliberately left. The previous session ran out of budget and had started
editing `index.ts` for item 1; **that edit was aborted cleanly and `index.ts` is untouched**,
so there is no half-finished code to hunt down.

### 3a. `/voice set` — configure everything from a command

**Problem.** `/voice backend` works, but every other setting needs hand-editing
`~/.pi/agent/better-pi-voice.json`. The user asked for this twice.

**Target surface** (in `index.ts`, extending the existing `pi.registerCommand("voice", …)`):

```
/voice                          status (already works)
/voice backend [name]           already works
/voice model [path]             picker over locally available GGUFs, or an explicit path
/voice set <key> <value>        any of: backend mode model language correction
                                       submitOnStop chunkSeconds silenceLevel shortcut
```

**Implementation notes:**

- Validate by **reusing the real parser**, so there is one source of truth:
  build the mutated settings object, run it through `parseSettings()`, and reject if a
  warning names the changed field. Do not hand-roll a second set of validators.
- The first argument to a command handler is typed `args: string` but is `undefined` for a
  bare invocation. **`(args ?? "")` is mandatory** — an unguarded `.trim()` crashed `/voice`
  in real use (commit `5e7b718`).
- After writing settings, `await ctx.reload()` so it takes effect. **Notify before the
  reload**: the reload replaces the runtime and nothing may touch it afterwards.
- For the model picker, scan what is already on disk rather than offering downloads:
  `~/.cache/huggingface/hub/models--*-gguf/snapshots/*/*.gguf`.
- Add tests to `index.test.ts`, which drives the real command handlers through
  `test-support/fake-pi.ts`. Extend the local `makeCtx()` if you need more of the UI surface
  (it already fakes `select`, `notify`, `reload`, `getEditorText`).

### 3b. First-run setup

**Problem.** With no settings file, nothing is configured and holding the key silently does
nothing. New installs should configure themselves.

**Sketch:** on `session_start`, if `settingsPath()` does not exist, pick a sensible backend
(Deepgram if `resolveDeepgramApiKey()` finds one, else the best locally available model),
write the settings, and tell the user what was chosen and which key to hold.

The `availableModels()` helper described in 3a is the piece both items need — write it once.

## 4. Gotchas that will bite you

- **G1 — pi loads this extension from the git *working tree*.** Its path is in pi's
  `packages` list, so **checking out a branch without these files silently breaks voice**.
  Do not switch branches while voice needs to work. (It also sits on
  `feat/subagent-request-spawn-retries`, which carries unrelated `pi-core-subagent` work —
  see §5.)
- **G2 — `/reload` after any settings change.** The runtime is built once at `session_start`
  and caches settings.
- **G3 — settings writes expand the whole file.** `writeSettings()` persists the merged
  object, so a hand-written minimal file becomes the full schema. Deliberate, but it is a
  visible change to the user's file.
- **G4 — `transcribe-cpp` is an optional dependency** and lives in pi's own package dir.
  `src/backends/parakeet.ts` resolves it by walking candidate roots and reading its
  `package.json` entry point; a plain `import("transcribe-cpp")` will not resolve.
- **G5 — the Vulkan errors on stderr are noise.** The runtime uses the Intel UHD iGPU. The
  `TU: error: …VULKAN…` line concerns a different render node; filter it, do not chase it.
- **G6 — two tests in `parakeet.test.ts` assert chunk *behaviour*, not implementation.** If
  you change the cut rule, expect to update them, and think about whether the new rule can
  still lose speech.
- **G7 — `index.ts` may look odd, but is clean.** `git status` should be empty; if it is not,
  somebody was mid-edit.

## 5. Two things about the repo, not the code

- **The branch.** This work shares `feat/subagent-request-spawn-retries` with an unrelated
  in-flight `pi-core-subagent` feature, because that is the branch that was checked out.
  Moving it is safe and non-destructive:
  ```bash
  cd ~/programing_linux/pi-extensions
  git branch feat/better-pi-voice HEAD
  git reset --hard HEAD~10         # rewind the shared branch past this work
                                   # HEAD~10 is 2d7377d, the pre-voice tip (verified)
  ```
  but see **G1** before switching anything.
- **Nothing is pushed.** There is also a commit in a *different* repo:
  `~/shared-configs` `cbcdec3`, which retired `npm:@earendil-works/pi-voice` and
  `npm:pi-voice-stt` from pi's `packages` and added this extension. `stt.json` was moved to
  `stt.json.retired`. A backup of the pre-change settings file sits beside it, and can be
  deleted now that the change is committed.

## 6. Open questions for the human

1. **Did chunking actually fire during a long live dictation?** The previous fix is verified
   by unit test and on a *doubled* recording, but never on a single live long utterance. This
   is the top thing to confirm.
2. **Is 30 s the right target?** Only their ear can say.
3. **`silenceLevel: "auto"` against real room tone.** Their first recording had music and
   never reached near-silence; the adaptive rule handles it in principle, but nobody has
   watched it work live.
4. **Accuracy was never compared on real speech.** All six candidate models transcribed the
   real recording correctly — the differences were capitalisation and punctuation. So the
   model was chosen on speed, size and chunk-safety, not accuracy. A harder passage would
   separate them.
