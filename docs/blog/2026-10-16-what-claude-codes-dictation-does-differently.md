# What Claude Code's dictation does that generic speech-to-text doesn't

I dictate to my coding agent more than I type to it. It is faster, and for prompts
("refactor this, keep the public API, add a test for the empty case") it is close to
frictionless. The problem was never the writing. It was the words the recogniser got
wrong:

> … so the **sub agent** can use the **Worktree T's config**, then check the
> **Marginalia** OAuth webhook.

Not one of those is a real speech error. Every word is valid English. They are the
wrong *words* — and when you are dictating into a coding agent, the wrong words are
the whole cost, because a filename or an identifier is the one thing you cannot
afford to have paraphrased.

Claude Code's dictation, for whatever reason, did not do this. It got `subagent`,
`worktree`, `tsconfig` and `Marginalia` right. So I went looking for why, and it
turned out not to be the model at all.

This is the story of what I found and what I rebuilt — a pi extension called
[`better-pi-voice`](https://github.com/sfgartland/better-pi-voice). Everything below
is verifiable from the source and the [design notes][design].

## It isn't the model

I unpacked `claude-code@2.1.295` and read its dictation path. Three decisions stood
out, none of which is about acoustic quality:

1. **It biases the recogniser with the repository's vocabulary.** Before a session it
   gathers the project name, the paths already in play, and a hardcoded list of
   developer jargon — `subagent`, `worktree`, `OAuth`, `gRPC` — and pushes them to the
   recogniser as *keyterms*. This is the single biggest accuracy lever, and it costs
   nothing.
2. **It endpoints server-side**, at 16 kHz mono, so a final transcript lands promptly
   instead of waiting for you to press stop.
3. **It has a recovery layer that never loses a sentence** — one retry before the first
   transcript, replaying buffered audio when a stream silently drops, salvaging a
   partial transcript when the socket dies, promoting an unreported interim to a final,
   and a circuit breaker so a broken microphone fails loudly.

The model was fine. The *context* was missing.

## The one that matters: vocabulary biasing

Deepgram's streaming API takes `keyterm` parameters — a list of words it should expect.
Claude Code was using the repository to fill that list. I copied the idea, mined a few
more sources, and measured it. Same sentence, same live API, transcription with and
without the repository's terms:

```text
without keyterms   … so the sub agent can use the Worktree T's config, then check the
                   Marginalia OAuth webhook.
with keyterms      … so the subagent can use the worktree tsconfig, then check the
                   marginalia OAuth webhook.
```

Two of the five terms came back wrong without biasing. All five were right with it.
`tsconfig` → "T's config" is the failure mode in miniature: correct English, wrong
code.

The terms come from four places, most specific first: your own list, a built-in seed
of developer jargon, the project and git repository names, and the file paths your
session has touched. They are normalised, deduplicated, and capped well inside
Deepgram's documented 100-term limit. One gotcha worth recording: a *comma-joined*
keyterm list is accepted by Deepgram and silently biases **nothing**. The terms have
to be sent as repeated query parameters, which is why there is a test asserting
exactly that.

## The recovery layer is the part people skip

Transcription is a network call, and network calls fail. Most dictation tools fail by
silently dropping the last sentence — the worst possible outcome, because you don't
notice until you have already sent the prompt.

The extension reimplements the whole recovery path:

- **One early retry** if the socket errors before any transcript arrives, since that
  is almost always a transient connect failure.
- **Audio replay**: the whole utterance is kept in memory, and if the stream dies
  *unconfirmed* before producing anything, it is replayed once on a fresh connection.
- **Salvage**: if the socket dies *after* some text exists, the last unreported interim
  is promoted to a final and the partial transcript is emitted before the error is
  reported. A dead socket at the end of a sentence no longer costs you the sentence.
- **A circuit breaker** after repeated fast failures, so a broken microphone fails
  loudly instead of pretending.

The audio buffer is in memory only and never written to disk — a privacy property as
much as a design one.

## Rebuilding it for pi

I packaged the result as a pi extension with two interchangeable backends behind one
pipeline:

| | Backend | Biasing | Needs |
|---|---|---|---|
| Cloud | Deepgram `nova-3` streaming | `keyterm` prompting (native) | a Deepgram API key |
| Local | Parakeet via `transcribe-cpp` | a deterministic correction pass | a Parakeet GGUF |

Cloud gets native keyterm biasing, and the term list can even be updated mid-session
with a `Configure` message instead of reconnecting.

Local is honestly worse on accuracy, and I want to be precise about why rather than
hand-wave it. I checked, by loading the model:

```text
parakeet-tdt_ctc-110m:
  supports(vocabulary)     = false
  supports(context_prompt) = false
  supportsStreaming        = false
```

`transcribe-cpp` 0.4.0 does expose `vocabulary` and `prompt` inputs, but only for
models that advertise the feature, and the Parakeet family does not. So locally there
is no prompt to bias. The extension makes up the difference with a deliberately dumb,
deterministic repair pass on finals only: it re-joins identifiers the recogniser split
(`TS config` → `tsconfig`) only when the concatenation is *exactly* a known term, and
it repairs a single misheard token within one or two edits of a keyterm. "back end" and
"work tree" are deliberately left alone, because in the next sentence those are two
words.

## The unglamorous part: batch, chunking, and pauses

The local model is the slow part, and streaming decode barely keeps up on a laptop CPU.
Batch transcription of the same audio is several times faster. So the local backend
defaults to batch and cuts the audio into pieces **at real pauses while you are still
speaking**, so only the tail is left when you release the key.

That "at real pauses" turned out to be a correctness requirement, not tuning. I tested
cutting a clip mid-utterance: `canary-180m-flash` returns an *empty transcript* for any
clip that starts mid-sentence. A cut at the merely *quietest* moment silently discards
an entire chunk. So a chunk is only cut where the signal is genuinely quiet, and the
threshold is derived per recording — the second-lowest level is the noise floor, the
75th percentile is speech — because a fixed threshold cannot span rooms. One of my test
recordings never dropped below 0.05 (music playing); another paused around 0.3.

The current pause detector is amplitude-based. The official pi voice extension now does
the same thing with a real Silero VAD model, which is more robust, and I've noted that
as the next thing to port. Being honest about which of those two is better is part of
the point.

## What I actually learned

- **Context beats model.** The jump from "T's config" to "tsconfig" came from telling
  the recogniser what my project is called, not from a better acoustic model.
- **Never lose a sentence.** Recovery is unglamorous and it is the difference between a
  demo and a tool. If your dictation can silently drop your last sentence, people stop
  trusting it.
- **Measure, and say what you measured.** Half the interesting decisions here were
  settled by numbers: which model survives a chunk boundary, how fast each mode runs,
  which model actually supports biasing. The [benchmark notes][benchmarks] are in the
  repo.

## Try it

```bash
pi install npm:@sfgartland/better-pi-voice
```

Hold a key, talk, and the words land in the editor with your project's vocabulary
spelled right. It is MIT, it works with Deepgram or fully locally, and the full
extraction notes for the Claude Code behaviour are in the repo.

- Repo: <https://github.com/sfgartland/better-pi-voice>
- npm: <https://www.npmjs.com/package/@sfgartland/better-pi-voice>

[design]: https://github.com/sfgartland/better-pi-voice/blob/main/docs/superpowers/specs/2026-10-15-pi-voice-input-design.md
[benchmarks]: https://github.com/sfgartland/better-pi-voice/blob/main/docs/reports/2026-10-15-voice-model-benchmarks.md
