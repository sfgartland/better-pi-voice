# Launch announcements — ready to post

**Status:** drafts. Nothing here has been posted. Post in the order below, and only
after the `pi.dev` gallery page appears, so every link resolves.

---

## 1. pi Discord — `#showcase` / general

Keep it short and lead with the artifact, not a feature list. One message:

> **better-pi-voice** — dictation for pi that spells your code right.
>
> Generic dictation turns `tsconfig` into "T's config", because the recogniser has
> never seen your project. This one mines keyterms from your repo + session and biases
> Deepgram with them; locally it runs Parakeet and repairs the obvious splits. It also
> borrows Claude Code's recovery layer so a dropped socket doesn't eat your sentence.
>
> Same sentence, without and with keyterms:
> ```
> without: … so the sub agent can use the Worktree T's config, then check the Marginalia OAuth webhook.
> with:    … so the subagent can use the worktree tsconfig, then check the marginalia OAuth webhook.
> ```
> `pi install npm:@sfgartland/better-pi-voice` · demo: <https://github.com/sfgartland/better-pi-voice> · MIT
>
> Curious whether keyterm biasing helps on your repo — tell me what it still gets wrong.

The last line matters: it gives people something to reply with and hands you a corpus
of real failure cases.

---

## 2. pi GitHub Discussions — `General` category

**Title:** `better-pi-voice — dictation biased with your repository's vocabulary`

**Body:**

> I dictate prompts to pi more than I type them, and the failure mode was never the
> writing — it was the words. "sub agent" instead of `subagent`, "T's config" instead
> of `tsconfig`. Valid English, wrong code, and a filename is the one thing you can't
> afford paraphrased.
>
> `better-pi-voice` fixes that the way Claude Code's dictation appears to: it mines
> keyterms from the project name, the git repo, touched file paths and the session, and
> sends them to Deepgram as native `keyterm` prompts. Same sentence, before and after:
>
> ```
> without keyterms   … so the sub agent can use the Worktree T's config, then check the Marginalia OAuth webhook.
> with keyterms      … so the subagent can use the worktree tsconfig, then check the marginalia OAuth webhook.
> ```
>
> The other half is recovery, which dictation tools usually skip: one early retry when
> a socket errors before the first transcript, replay of the retained audio when a
> stream dies unconfirmed, salvage of the partial transcript when it dies late,
> promotion of an unreported interim, and a circuit breaker. The audio buffer is memory
> only, never written to disk.
>
> **Backends.** Deepgram `nova-3` (best accuracy, needs a key) or local Parakeet via
> `transcribe-cpp` (fully offline). Local can't be vocabulary-biased — I checked by
> loading the model and `supports("vocabulary")` is `false` — so it uses a small
> deterministic correction pass instead. Batch is the local default, and cuts are made
> at real pauses while you're still speaking.
>
> ```bash
> pi install npm:@sfgartland/better-pi-voice
> ```
>
> Repo: <https://github.com/sfgartland/better-pi-voice> · npm:
> <https://www.npmjs.com/package/@sfgartland/better-pi-voice> · MIT
>
> I'd especially like mis-transcriptions from your own repos — they go straight into
> the keyterm tests.

**Discussions etiquette:** the pi repo only has a `General` category right now, so post
there. Don't cross-post the same text to both Discord and Discussions; post in Discord
first, and add the Discussions thread if there's interest.

---

## 3. Optional, later — Hacker News (not "a pi extension")

The pi framing scored 1–4 points for other extensions. For HN, lead with the accuracy
story, and link the repo (not a landing page):

> **Show HN: Dictation that spells code correctly, by biasing the recogniser with your repo**
>
> Generic speech-to-text writes "sub agent" and "worktree T's config", because the model
> has never seen your codebase. This is a dictation tool (for the pi coding agent)
> that mines keyterms from the repository and the session and feeds them to the
> recogniser, plus a recovery layer borrowed from Claude Code's dictation so a dropped
> socket never loses a sentence. Cloud via Deepgram or fully local with Parakeet. The
> README has the same sentence transcribed with and without biasing.

Post Tue–Thu morning US time, answer every comment for the first few hours, never ask
for upvotes.

## 4. Optional, later — Reddit, one angle per room

- **r/LocalLLaMA** — the offline Parakeet path and the honest benchmark table.
- **r/commandline** — hold a key, speak, and your filenames come out spelled right.
- **r/ClaudeAI** and coding-agent subs — the Claude Code reverse-engineering story,
  linking the [blog post](../blog/2026-10-16-what-claude-codes-dictation-does-differently.md).

Don't paste the same copy across all of them; each audience cares about a different
paragraph.

---

## Checklist before posting

- [ ] `pi.dev/packages/@sfgartland/better-pi-voice` resolves
- [ ] `pi install npm:@sfgartland/better-pi-voice` works from a clean shell
- [ ] the demo video is in the gallery (`pi.video`) and the README
- [ ] `BubblePtr/awesome-pi` PR #60 and `thevibeworks/awesome-pi-agent` PR #16 merged
- [ ] the blog post is live somewhere linkable, with the repo linked at the end
