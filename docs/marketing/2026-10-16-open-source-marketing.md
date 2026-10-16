# Marketing `better-pi-voice` as a pi extension

**Date:** 2026-10-16
**Question:** how do extensions in the **pi** ecosystem actually get found and adopted?

All numbers were pulled on 2026-10-16 from the GitHub API, the npm registry/downloads
API, and `pi.dev`. Star and download counts age; the *mechanics* do not.

> **Note on scope:** the first draft of this doc leaned on standalone dictation apps
> (Handy, VoiceInk, freeflow). That playbook mostly does **not** transfer — those are
> GUI apps with a download page, a "free alternative to Wispr Flow" story, and often an
> LLM cleanup pass. A pi extension is distributed through npm and discovered in the pi
> ecosystem, and this extension deliberately has **no post-LLM cleanup**. So the
> strategies below are the ones that work for pi extensions.

---

## TL;DR — the six moves

1. **Publish to npm. This is the blocker and everything else depends on it.**
   `@sfgartland/better-pi-voice` is not on npm today (`npm view` → 404). Until it is, it
   cannot appear in the [pi package gallery](https://pi.dev/packages) or any of the
   auto-discovered directories.
2. **Make the gallery entry good.** The `pi-package` keyword already qualifies it, but
   the manifest has no `pi.image` / `pi.video`, so the gallery would show a text-only
   card. Two of the closest competitors ship a preview image; it is a cheap edge.
3. **Lead with the wedge, not "voice".** `pi-voicekit` already does *"Deepgram
   streaming or 21 offline models"*. What nobody else in the pi ecosystem does is
   **bias the recogniser with the repository's vocabulary**, and **never drop a
   sentence**. That is the headline.
4. **Use the one framing that reliably works for pi extensions: "Claude Code's X, for
   pi."** The top pi extensions all do it (`pi-subagents`: "Claude Code like
   Sub-Agents"; `pi-tasks`: "Claude Code-style task tracking"; `pi-automode`: "Think
   Claude Code's auto mode but for pi"). This extension literally reverse-engineered
   Claude Code's dictation, so the claim is true, not borrowed.
5. **Get listed in the directories — most are automatic.** Publish on npm and
   `shaftoe/awesome-pi-coding-agent` (14k+ resources, updated daily, ranked by npm
   downloads) picks it up. Then PR the curated lists (`bubbleptr/awesome-pi`,
   `thevibeworks/awesome-pi-agent`) and post in pi's Discussions/Discord.
6. **Treat it as a plumbing problem, not a launch.** Hacker News barely moves pi
   extensions (individual Show HNs land at 1–4 points). The compounding channels are
   the gallery, the npm download count, and the awesome lists.

---

## How pi extensions are distributed (with evidence)

| Surface | What it is | Evidence / how to get in |
|---|---|---|
| **npm** | the actual install source: `pi install npm:@sfgartland/better-pi-voice` | `@sfgartland/better-pi-voice` → **404 today** |
| **Pi package gallery** — `pi.dev/packages` | official catalog, server-rendered, searchable, sortable by recency | requires the `pi-package` keyword on an npm package ([pi docs: packages](https://pi.dev/docs/latest/packages)) |
| **Auto-discovery directories** | `shaftoe/awesome-pi-coding-agent`: **14,641 resources**, 12,569 extensions, rebuilt daily by CI, also a searchable site at `awesome-pi.site` | discovered from npm; ranked with public npm download counts |
| **Curated awesome lists** | `bubbleptr/awesome-pi` (139★, has a voice section), `bradAGI/awesome-cli-coding-agents` (1362★), `thevibeworks/awesome-pi-agent` | pull request; `qualisero/awesome-pi-agent` (1100★) is retiring itself, deprioritise it |
| **pi Discussions** | the main repo has Discussions enabled (115k★, 14.7k forks) | post in the relevant category |
| **pi Discord / X** | linked from the pi.dev nav | share the demo clip |
| **Hacker News** | weak for pi extensions | individual pi-extension Show HNs found scored **1–4 pts** |

### What a gallery entry looks like

`pi.dev/packages/pi-subagents` renders, in one page:

```
$ pi install npm:pi-subagents          [copy button]
Version 0.78.0 · Published Oct 13, 2026
Downloads 609K/mo · 112.3K/wk        ← public social proof
Author … · License MIT · Types extension, skill, prompt · Size 11.4 MB
Pi manifest JSON { … }
Security note …
README (rendered inline, images and all)
```

Two things follow. First, **the README is the gallery listing** — everything in it is
marketing copy that a pi user reads without leaving the catalog. Second, **download
counts are shown and used to rank the directories**, so early adoption compounds.

---

## The actual competition (the "voice" slot is not empty)

Monthly npm downloads, 2026-10-16:

| Package | Version | Downloads/mo | What it is | Has gallery image? |
|---|---|---:|---|---|
| `@agimon-ai/doompi-voice` | 0.0.1-alpha.129 | ~9,000 | client audio capture + host transcription for Pi agents | no |
| `@juicesharp/rpiv-voice` | 2.13.8 | ~3,800 | local on-device Whisper (sherpa-onnx), `/voice`, no cloud, no API key | **yes** (`pi.image`) |
| `pi-voicekit` | 0.4.2 | ~2,800 | hold-to-talk STT, **Deepgram streaming or 21 offline models**, plus TTS | no |
| `@earendil-works/pi-voice` | 0.2.0 | ~1,722 | the official local transcription extension | no |
| `pi-voice-stt` | 0.8.0 | ~919 | provider-agnostic (Mistral/OpenAI/Deepgram/…), file transcription | **yes** (`pi.image`) |
| **`@sfgartland/better-pi-voice`** | — | **not published** | — | — |

For comparison, the `@sfgartland` family itself does 1.1k–4.5k/mo (`pi-core-subagent` 4,512;
`pi-add-mode` 1,832; `pi-senja` 1,316). So a realistic good outcome is a few thousand
downloads a month — and the voice niche's ceiling is in the high thousands.

### The wedge (say this, not "voice input")

`pi-voicekit` already offers Deepgram **or** offline models, so that combination is not
a differentiator. Three things are:

1. **Repo-aware vocabulary biasing.** Keyterms mined from the project name, the git
   repo, touched file paths and the session, sent to Deepgram as native `keyterm`
   prompts, plus a deterministic correction pass on the local backend. The README's
   before/after (`sub agent` → `subagent`, `Worktree T's config` → `worktree tsconfig`)
   is the proof. **No other pi voice extension advertises this.**
2. **The never-lose-a-sentence recovery layer** borrowed from Claude Code: one retry,
   silent-drop replay, partial salvage, interim promotion, circuit breaker. Also unique
   in this ecosystem.
3. **Honest, measured local chunking** (pause-derived thresholds, mid-word-safe cuts)
   with the benchmark report to back it, instead of a vague "fast and accurate" claim.

### And the "no post-LLM cleanup" choice is a feature — frame it that way

Losing an LLM cleanup pass is only a downside against GUI dictation apps that paste
into arbitrary text fields. In pi, the agent already cleans up what you send, so a
second LLM pass is cost and latency for nothing. Say plainly:

- **Deterministic.** What you say is what lands; no model rewrites your words.
- **No extra tokens, no extra round-trip.** The audio path ends at the recogniser.
- **Private by construction** with the local backend, and the correction is a rule
  engine, not a model.

Put this in the README as a short "Why no LLM cleanup?" note so it reads as a decision
rather than a missing feature.

---

## Package-level checklist (do these before any announcement)

1. **Publish**: `npm publish` from the repo (it already has `publishConfig.access:
   public` and the `files` whitelist). Confirm `pi install npm:@sfgartland/better-pi-voice`
   works from a clean machine.
2. **Add gallery previews** to the `pi` key in `package.json`:
   ```jsonc
   "pi": {
     "extensions": ["./index.ts"],
     "image": "https://raw.githubusercontent.com/sfgartland/better-pi-voice/main/media/screenshot.png",
     "video": "https://raw.githubusercontent.com/sfgartland/better-pi-voice/main/media/demo.mp4"
   }
   ```
   A still of the status line + audio meter is enough for the image; a 15-second
   clip of the before/after is enough for the video.
3. **Keywords**: keep `pi-package` and `pi-extension`, and add the niche terms people
   search: `dictation`, `speech-to-text`, `deepgram`, `parakeet`, `hold-to-talk`,
   `keyterms`, `coding-agent`. (`pi-voicekit` carries ~24 keywords for exactly this
   reason.)
4. **npm description** is already well-positioned:
   *"Streaming voice input for pi: Deepgram (nova-3, repo-aware keyterms) or local
   Parakeet, with Claude-Code-style recovery so speech is never lost."* Keep the
   `Claude-Code-style` phrase — it is the pattern that works here.
5. **README**: demo GIF / before-after card at the top, the one-line install, the
   comparison table to the other pi voice extensions, and the "no LLM cleanup"
   rationale. (The comparison table was added in `8f78b33`.)
6. **Version cadence.** The leaders ship often (`rpiv-voice` 2.13.8, `pi-subagents`
   0.78.0). Small, frequent releases keep the package "recent" in a gallery that can
   sort by recency, and each release re-surfaces it.

---

## Launch sequence for a pi extension

**Stage 1 — become discoverable (no announcement)**
- `npm publish`; verify the gallery page appears at `pi.dev/packages/@sfgartland/better-pi-voice`.
- Confirm `shaftoe/awesome-pi-coding-agent` picks it up on its next daily run (or open
  the corresponding entry if the pipeline needs a hint).
- Add `pi.image`/`pi.video`; re-check the gallery card.

**Stage 2 — seed the pi community (week 1)**
- PR into `bubbleptr/awesome-pi` (voice section) and `thevibeworks/awesome-pi-agent`.
- Post in pi Discussions and the pi Discord: show the before/after, ask which backend
  people want, link the repo. Lead with the *accuracy* problem, not the feature list.
- Ask the maintainers of `pi-voice`, `pi-voice-stt` and `pi-voicekit` whether they want
  a cross-link — mutual links lift all of them and cost nothing.

**Stage 3 — go wider (week 2–3), only once the gallery card is good**
- A dev-facing article: *"What Claude Code's dictation does that yours doesn't"* —
  the reverse-engineering story is the hook, and it links the extension at the end.
- r/LocalLLaMA and r/commandline with the *offline* angle; the coding-agent subs with
  the *code vocabulary* angle.
- Optional Show HN **only** framed as the accuracy story for coding agents, not as
  "a pi extension" (pi-extension Show HNs scored 1–4 points). It is a bonus, not a plan.

**Stage 4 — compound (ongoing)**
- One release a week with a short changelog; turn every real mis-transcription from
  users into a keyterm-correction test case and a release-note line.
- Keep the npm description and README first paragraph stable; they are the copy that
  every directory reprints.

---

## Metrics

| Metric | Why | Where |
|---|---|---|
| **npm downloads/mo** | the currency of the gallery + directory rankings | npm downloads API |
| gallery page live + has image/video | the entry point most pi users see | `pi.dev/packages/@sfgartland/better-pi-voice` |
| presence in `awesome-pi-coding-agent` / `awesome-pi` | long-tail discovery | the lists |
| Downloads vs. the voice niche | context: 900–9,000/mo | this doc's table |
| Issue quality / repeat users | whether people actually dictate with it | GitHub issues |

Stars matter far less here than npm downloads; the directories literally sort by the
latter.

---

## Anti-patterns

- **Don't launch before publishing.** A Show HN or Reddit post that leads to a 404 on
  npm is worse than no post.
- **Don't lead with "Deepgram or local".** `pi-voicekit` owns that line. Lead with
  repo-aware biasing and the recovery layer.
- **Don't apologise for having no LLM cleanup.** Explain it as determinism and saved
  tokens, in pi's context.
- **Don't pitch to Hacker News as "a pi extension".** The pi angle is for the pi
  community; for outsiders the story is code-vocabulary accuracy.
- **Don't skip the preview image.** It is one `package.json` field and the two closest
  competitors already have one.
- **Don't rename the package after launch.** `better-pi-voice` is descriptive and the
  npm name is the identity; rebranding resets every directory link.
