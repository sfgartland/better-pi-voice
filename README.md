# @sfgartland/pi-add-better-pi-voice

Streaming voice input for pi. Hold a key, talk, and the words land in the editor —
in the right spelling, including the jargon and filenames generic speech
recognition gets wrong.

Two interchangeable backends behind one pipeline:

| | Backend | Biasing | Needs |
|---|---|---|---|
| Cloud | **Deepgram `nova-3`** streaming | `keyterm` prompting (native) | a Deepgram API key |
| Local | **Parakeet** via `transcribe-cpp` | post-hoc correction pass only | a Parakeet GGUF |

## Why this exists

Claude Code's dictation is unusually good, and it isn't the model. Reverse-engineering
it (`claude-code@2.1.295`) turned up three things worth stealing:

1. **Vocabulary biasing from the repository.** Before every session it pushes the
   project name, the paths already in play, and a hardcoded list of developer jargon
   (`subagent`, `worktree`, `OAuth`, `gRPC`…) to the recogniser. This is the single
   biggest accuracy lever and it costs nothing.
2. **Server-side endpointing** at 16 kHz mono, so finals land promptly instead of
   waiting for you to press stop.
3. **A recovery layer that never loses a sentence** — one retry before the first
   transcript, replaying buffered audio when a stream silently drops, salvaging a
   partial transcript when the socket dies, promoting an unreported interim to a
   final, and a circuit breaker so a broken microphone fails loudly.

All three are reproduced here. The design document with the full extraction notes is
at `docs/superpowers/specs/2026-10-15-pi-voice-input-design.md`.

## What it actually buys you

A fixed sentence containing five terms, transcribed twice through the live Deepgram
API — once with no keyterms, once with the repository's terms:

```
without keyterms   … so the sub agent can use the Worktree T's config, then check
                   the Marginalia OAuth webhook.
with keyterms      … so the subagent can use the worktree tsconfig, then check the
                   marginalia OAuth webhook.
```

`tsconfig` → "T's config" is the failure mode in miniature: correct English, wrong
words. Two of the five terms came back wrong without biasing and all five were right
with it.

## Install

```bash
pi install /path/to/pi-extensions/packages/add/pi-add-better-pi-voice
```

Then set a Deepgram key. Either export it:

```bash
export DEEPGRAM_API_KEY=...
```

or point at an existing dotenv file, which avoids having to export it in every shell:

```jsonc
// ~/.pi/agent/better-pi-voice.json
{ "deepgram": { "apiKeyFile": "/path/to/some/project/.env" } }
```

The key is never written into the settings file.

## Use

The default binding is `ctrl+alt+z`; **hold it while you speak and release**. The
status line shows what is happening and an audio-level meter appears above the editor.

| Mode | Start | Stop | Safety |
|---|---|---|---|
| `hold` (default) | press | release | falls back if the terminal never reports release |
| `tap` | press | press again | 15 s of silence, 120 s hard cap |

A hard cap applies in both modes so a stuck key cannot leave the microphone open.

Commands:

- `/voice` — backend, mode, shortcut, keyterm count, whether the key is visible, state
- `/voice-keyterms` — list custom terms
- `/voice-keyterms add <term>` / `remove <term>`

## Keyterms

Terms are gathered from four places, most specific first:

1. `keyterms.user` — your own list
2. a built-in seed list of developer jargon
3. the project directory name and the git repository name
4. files touched by `read`/`write`/`edit` tool calls and paths mentioned in your messages

They are normalised (camelCase split, separators split, 3–20 characters, printable
ASCII, deduplicated) and capped well inside Deepgram's documented 100-term / 500-token
limit. A comma-joined keyterm list is accepted by Deepgram and silently boosts
*nothing*, so terms are sent as repeated query parameters — there is a test for that.

## The local backend, honestly

**Parakeet cannot be vocabulary-biased.** `transcribe-cpp`'s stream options carry no
prompt field, and `initialPrompt` exists only in `WhisperRunOptions` — the whisper
family is a batch (run-slot) extension, not a streaming one. So locally you get live
interims *or* native biasing, not both.

This extension takes interims, and makes up the difference with a deliberately dumb
deterministic repair pass that runs on finals only. It does two things:

1. **Rejoin identifiers the recogniser split.** `tsconfig` comes back as "TS config".
   Two adjacent tokens are joined only when their concatenation is *exactly* a keyterm,
   they are separated by exactly one space, and the shorter one is an abbreviation
   (uppercase, or at most two characters). "TS config" qualifies; "back end" and
   "work tree" deliberately do not, because in the next sentence those are two words.
2. **Repair a single misheard token**, within one edit of a keyterm for words up to 7
   characters or two edits for longer ones, and never for tokens under 5 characters.
   Distance is Damerau, so an adjacent swap counts once — that is how ASR mangles a
   technical term most often (`subagent` → `subagnet`).

On the real output of the local backend for the test sentence, that turns
`the Worktree TS config` into `the Worktree tsconfig`. It does **not** rescue
`DRAM backend` from `deepgram backend` — too many edits, and below the length floor.

```jsonc
"correction": "safe"    // "off" | "safe" | "report"
```

`"report"` changes nothing and logs what it *would* change — use it to find out
whether the pass is earning its keep before trusting it.

If you want true local biasing instead, a whisper-family model with `initialPrompt`
plus a batch re-pass at finalize is the route; it is not implemented here.

**It is also slower than real time on this machine.** With the CPU fallback (the
bundled `linux-x64-cpu-vulkan` build cannot open this GPU — the driver reports
`VK_ERROR_INCOMPATIBLE_DRIVER`), 6.65 s of speech took ~12.5 s to transcribe, about
0.5× real time. Transcripts therefore arrive *after* you stop speaking rather than
while you speak. Treat the local backend as the private/offline option, not the fast
one, until it is running on a usable compute backend.

## Settings

`~/.pi/agent/better-pi-voice.json`. Every field is optional; anything missing or
malformed falls back to a default and warns rather than breaking the microphone.

```jsonc
{
  "backend": "deepgram",              // "deepgram" | "parakeet"
  "mode": "hold",                     // "hold" | "tap"
  "shortcut": "ctrl+alt+z",
  "language": "en",
  "deepgram": {
    "apiKeyEnv": "DEEPGRAM_API_KEY",
    "apiKeyFile": null,               // dotenv file, used when the env var is unset
    "model": "nova-3",
    "smartFormat": true,
    "endpointingMs": 300,             // silence before an utterance is finalised
    "utteranceEndMs": 1000
  },
  "parakeet": { "modelPath": null },  // null = read pi-voice's config if present
  "keyterms": {
    "enabled": true,
    "seed": true,
    "mineSessionFiles": true,
    "maxTerms": 60,
    "user": []
  },
  "correction": "safe",
  "submitOnStop": false               // false = leave the text in the editor
}
```

## Privacy

**Cloud mode sends your microphone audio to Deepgram.** It is billed per minute of
audio, it transcribes on their servers, and it is the default because it is the more
accurate of the two. Local mode sends nothing anywhere; use it for anything sensitive.
Buffered audio is held in memory only, is never written to disk, and is discarded when
the session ends.

## Requirements

- Linux with `arecord` (alsa-utils), or SoX's `rec` as a fallback. macOS/Windows use
  `rec` and are a degraded path — untested here.
- Hold-to-talk needs Kitty keyboard protocol flag 2 for key *release*. It is verified
  working on Kitty. Everywhere else it falls back to tap-to-toggle and says so once.
- The local backend needs `transcribe-cpp` and a Parakeet GGUF.

## Development

```bash
bun test          # 166 tests, no network or microphone required
bunx tsc --noEmit
bunx biome check .

# live check against Deepgram, with and without keyterms
DEEPGRAM_API_KEY=... bun scripts/deepgram-smoke.ts speech.pcm
DEEPGRAM_API_KEY=... bun scripts/deepgram-smoke.ts speech.pcm subagent,worktree,tsconfig

# live check of the local backend (loads the GGUF, so it is slow)
bun scripts/parakeet-smoke.ts speech.pcm
```

The pipeline is tested without a microphone, a network, or a model: capture, the
backend, and time are all injected seams, so every recovery rule has a test that runs
in milliseconds.
