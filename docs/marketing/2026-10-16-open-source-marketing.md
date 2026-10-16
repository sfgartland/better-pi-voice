# Marketing `better-pi-voice` as an open-source project

**Date:** 2026-10-16
**Question:** how do comparable open-source dictation projects reach an audience, and
which of their moves are worth copying here?

Every number below was pulled on 2026-10-16 from the GitHub API and the Hacker News
Algolia API; nothing is remembered. Star counts age, the *patterns* do not.

---

## TL;DR — the five moves that matter

1. **Position as "the accurate dictation for coding agents", with the commercial
   alternative named.** The single best-performing framing in this space is
   *"a free, open-source alternative to Wispr Flow / Superwhisper / Claude Code
   dictation."* The highest-scoring launch we found did exactly that (277 points).
   `better-pi-voice` has a sharper version of the claim: it is the only one that
   biases the recogniser with the repository's vocabulary.
2. **Lead with the before/after transcription, as a visual.** The project already owns
   the most persuasive asset in this category: the same sentence transcribed *with* and
   *without* keyterms (`sub agent` → `subagent`, `Worktree T's config` → `worktree
   tsconfig`). Today it is a code block; it should be a 10-second GIF at the top of the
   README, because that is the thing people screenshot and repost.
3. **Make installation one line, in every ecosystem pi uses.** `pi install
   npm:@sfgartland/better-pi-voice` is already that line. Mirror that exact string
   everywhere (README, landing page, launch post) so it is copy-pasteable.
4. **Land in the pi community first, then go broad.** The pi ecosystem is small and
   reachable (the extension's own packages sit at ~300 stars). Win the friends-of-pi
   audience via the pi Discord / package lists, then launch to the wider
   speech-to-text crowd on Hacker News and Reddit with the alternative framing.
5. **Keep a landing page, not just a README.** Every project that sustained momentum
   after a launch had a website: handy.computer, tryvoiceink.com,
   freeflow.zachlatta.com, thewh1teagle.github.io/vibe. A GitHub Pages page with the
   demo GIF, the compared-transcription, and the install line is enough.

---

## What the comparables actually did

| Project | Stars (2026-10-16) | Age | Positioning | Channels that showed up | Notable tactics |
|---|---:|---|---|---|---|
| [`cjpais/Handy`](https://github.com/cjpais/Handy) | 33,923 | ~20 mo | "free, open source, and extensible speech-to-text that works completely offline" | Discord, handy.computer, Homebrew, winget, `.deb` | Value bullets (Free / Open / Private / Simple); advertised as **Parakeet** as well as Whisper; four install paths |
| [`braden-w/whispering`](https://github.com/braden-w/whispering) | (moved to Epicenter) | — | large ecosystem, redirected repo | — | Moved the repo and left a redirect; a reminder that distribution can outgrow the repo |
| [`thewh1teagle/vibe`](https://github.com/thewh1teagle/vibe) | 7,803 | ~34 mo | "Transcribe on your own!" | GitHub Pages, screenshots, translate/summarise extras | Big screenshot, emoji feature list, "Give it a Star ⭐" CTA |
| [`Beingpax/VoiceInk`](https://github.com/Beingpax/VoiceInk) | 6,825 | ~24 mo | **"the best open-source alternative to Superwhisper & Wispr Flow … no subscription"** | tryvoiceink.com, YouTube, Discord, Homebrew | Named competitors in the one-line description; open source + **paid license** to fund it |
| [`zachlatta/freeflow`](https://github.com/zachlatta/freeflow) | 2,916 | ~8 mo | "Free & fast alternative to Wispr Flow" | **HN front page**, website, `.dmg` | One huge **Show HN: Free alternative to Wispr Flow, Superwhisper, and Monologue — 277 points / 132 comments**, demo GIF, custom-vocabulary feature |
| [`ideasman42/nerd-dictation`](https://github.com/ideasman42/nerd-dictation) | 1,935 | ~5 yr | "simple, hackable offline speech to text" | word of mouth, distro packages | The "hackable" niche; no homepage, no topics, still durable |
| [`earendil-works/pi-voice`](https://github.com/earendil-works/pi-voice) | 301 | ~2 mo | "transcription in pi" | shipped inside pi's own ecosystem | Bootstrap distribution: the official extension. No topics, no homepage, no discussions |
| [`cgarrot/pi-voice-stt`](https://github.com/cgarrot/pi-voice-stt) | 10 | ~5 mo | "provider-agnostic speech-to-text dictation extension for the Pi TUI" | npm | Clear technical description, but no discoverability surface at all |

### The Hacker News evidence

Searches over 2022–2026 (points / comments):

| Date | Title | Result |
|---|---|---|
| 2026-02-16 | Show HN: Free alternative to Wispr Flow, Superwhisper, and Monologue | **277 / 132** |
| 2026-06-28 | Yap — free offline voice dictation for Mac/Windows/Linux (Wispr Flow alt) | 30 / 14 |
| 2026-09-22 | Ask HN: anyone using a Wispr Flow alternative that is non-cloud? | 24 / 19 |
| 2023-08-21 | Show HN: superwhisper — AI powered offline voice to text for macOS | 43 / 48 |
| 2023-01-23 | Whisper.cpp running fully in the browser | 199 / 38 |
| 2026-06-20 | "Talking to My Terminal with Local Speech-to-Text and Pi Coding Agent" | article, dev audience |
| 2026-09-03 | Show HN: Wordmate — local speech-to-text for macOS | 5 / 0 |
| 2025-06-17 | Show HN: Handy — Free open-source speech-to-text app written in Rust | 3 / 1 |
| 2026-03-29 | Show HN: local-first dictation for macOS — Parakeet TDT, zero cloud calls | 1 / 0 |

Three lessons fall out of this:

- **The alternative framing is the headline that works.** The 277-point post is a
  free-alternative post; the pure "here is my app" posts scored single digits.
- **The pi angle is timely.** "Talking to My Terminal with Local Speech-to-Text and Pi
  Coding Agent" was published in October 2026, and pi Show HN posts ("Pi pod", 121
  points) are landing. There is a live conversation to join.
- **A launch is a seed, not a harvest.** Handy's own Show HN got 3 points and today it
  is the biggest project in the table; repo hygiene, installers, and word of mouth did
  the work.

---

## What to change in the repo first

These are prerequisites, not marketing.

1. **A social preview image** (GitHub repo → Settings → Social preview). Right now a
   shared link shows a generic card. Use the before/after transcription.
2. **Repo description and topics.** The description should be the positioning line;
   topics are free search surface. `pi-voice` and `pi-voice-stt` have **none** — easy
   advantage. Suggested:
   - Description: `Accurate voice dictation for the pi coding agent — Deepgram or local Parakeet, biased with your repo's vocabulary.`
   - Topics: `pi-package`, `pi-extension`, `dictation`, `speech-to-text`,
     `deepgram`, `parakeet`, `coding-agents`, `cli`, `linux`, `offline`
3. **A demo GIF at the top of the README** showing the exact failing sentence being
   dictated correctly. This is the one asset worth spending an afternoon on.
4. **Badges**: npm version, license, tests, "pi-package". They signal liveness and they
   are what people expect from a 2026 npm README.
5. **A compare table that names the alternatives** (already added). Keep it factual and
   link to both other projects; generosity reads as confidence and gets shared.
6. **Releases with notes.** Tag a v0.1.0 and use GitHub Releases; the release feed is a
   free recurring notification to watchers.
7. **Discussions + a couple of `good first issue`s** so the community has a door.

---

## Distribution: where this should live

| Channel | Why | Concrete action |
|---|---|---|
| npm (`@sfgartland/better-pi-voice`) | canonical install | `npm publish`; keep `pi install npm:@sfgartland/better-pi-voice` in every post |
| pi's own ecosystem | highest-intent users | list it in pi's package/extension lists if they exist; post in the pi Discord/community |
| GitHub topics + description | search discovery | fill in as above |
| Hacker News | one-shot spike, best framing | **Show HN**, title drafted below |
| r/LocalLLaMA | the offline/Parakeet audience | post the before/after + the local fallback story |
| r/selfhosted, r/commandline, r/linux | the "no cloud" audience | lead with local mode + privacy, not accuracy |
| r/ClaudeAI, coding-agent communities | the pain is dictating code | lead with the Claude Code extraction story |
| dev.to / personal blog | long tail, SEO | "How I made speech-to-text spell my code correctly" |
| YouTube / X | visual proof | 20-second before/after clip |

### Draft Show HN

> **Show HN: Accurate voice dictation for coding agents, biased with your repo's vocabulary**
>
> Generic dictation writes `sub agent` and `worktree T's config`; the recogniser has
> never seen your project. `better-pi-voice` mines keyterms from the repo, the session
> and a developer-jargon seed list and feeds them to Deepgram (or runs fully locally
> with Parakeet). It also borrows Claude Code's recovery layer so a dropped socket
> never loses a sentence. One-line install for the pi coding agent; the README has the
> same sentence transcribed with and without biasing. MIT.

Rules of the game: post Tue–Thu morning US time, answer every comment for the first
three hours, never ask for upvotes, and link the repo (not a marketing page) as the
submission URL.

### Reddit angle per subreddit

- **r/LocalLLaMA**: "Local Parakeet dictation for a terminal agent, with repo-aware
  correction and no audio to disk." Focus on the offline path and the honest benchmark
  table.
- **r/commandline / r/linux**: "Hold a key, talk, and your filenames come out spelled
  right." Focus on the arecord capture and the `/voice` commands.
- **Coding-agent subs**: the Claude Code reverse-engineering write-up is the hook.

---

## The launch sequence

**T−7 — assets and hygiene**
- demo GIF; social preview; new description + topics; badges; v0.1.0 release.
- landing page (GitHub Pages) with: one-sentence pitch, GIF, before/after, install
  line, comparison table, link to the design doc.
- a 1,000-word blog post: *"What Claude Code's dictation does that yours doesn't."*
  Publish it a day or two before the launch so the HN post can link the repo and the
  post can link the repo.

**T−0 — launch**
- Show HN with the draft above; r/LocalLLaMA cross-post; pi community post.
- Pin an issue: "Feedback from the launch — post your mis-transcriptions here." It
  gives commenters a place to be useful and gives you a corpus of real failure modes.

**T+1 → T+30 — the part that compounds**
- Ship a fix or feature a week and write a short release note; each one is a small
  re-notification to watchers.
- Turn every "it misheard X" from the launch into a keyterm-correction test case and a
  changelog line. That *is* the product's moat, visible.
- Submit to curated lists (`awesome-pi`, `awesome-cli`, `awesome-speech-recognition`
  if they exist); ask pi-voice and pi-voice-stt maintainers whether they want a
  cross-link.
- Record a 30-second demo clip; put it on the landing page and X.

---

## Metrics to watch

| Metric | Why | Where |
|---|---|---|
| `npm install` count of the scoped package | real adoption vs. star tourism | npm downloads |
| GitHub stars over the launch week | one-off reach | star history |
| HN position + comment tone | whether the *claim* landed | the thread |
| `pi install npm:@sfgartland/better-pi-voice` mentions | install intent | issue count / analytics |
| Issue quality | whether users are staying | GitHub issues |
| Conversion: landing page → install line copy | whether the page works | page analytics |

Stars are vanity; **npm downloads and repeat issue reports** are the signal that people
actually dictate with it.

---

## Anti-patterns (from watching these projects)

- **Don't lead with benchmarks alone.** The benchmark report in `docs/reports/` is
  excellent, but "0.9× real-time" loses to a GIF of the right words appearing.
- **Don't claim accuracy you cannot demo.** The category is full of "99% accurate"
  claims; the before/after is stronger precisely because it is specific and falsifiable.
- **Don't post the same copy to five subreddits.** Tailor the angle; the local,
  terminal and coding-agent audiences each care about a different paragraph.
- **Don't name it and hide it.** "better-pi-voice" is honest but describes a
  relationship, not a benefit. Keep the package name for continuity, but consider a
  short brand for the landing page and the Show HN title (e.g. something that says
  *accurate* + *for coders*). If a rename happens, do it before the launch, not after.
- **Don't forget the non-Linux story.** The extension documents macOS/Windows as a
  degraded path. Say so plainly; a promising-but-untested claim is what turns a launch
  thread hostile.

---

## One-paragraph summary for a landing page

> Dictation that knows your code. `better-pi-voice` is a voice input extension for the
> [pi coding agent](https://github.com/earendil-works/pi): hold a key, talk, and your
> words land in the editor with `tsconfig`, `subagent` and `worktree` spelled right,
> because the recogniser is biased with your repository's vocabulary. Use Deepgram
> for the best accuracy, or run fully offline with Parakeet — nothing is written to
> disk either way. Free and MIT. `pi install npm:@sfgartland/better-pi-voice`
