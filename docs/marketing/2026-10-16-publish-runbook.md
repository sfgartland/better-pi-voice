# Publish runbook — `@sfgartland/better-pi-voice` 0.1.0

**Date:** 2026-10-16
**State:** **published.** This file is now a record, not a to-do.

| Item | Status |
|---|---|
| npm | `@sfgartland/better-pi-voice@0.1.0` live — <https://www.npmjs.com/package/@sfgartland/better-pi-voice> |
| GitHub | live — <https://github.com/sfgartland/better-pi-voice> |
| `BubblePtr/awesome-pi` | **PR #60** open (`README.md` + `README.en.md`) |
| `thevibeworks/awesome-pi-agent` | **PR #16** open |
| `piindex.dev` | mirrors `awesome-pi`, so PR #60 covers it |
| `shaftoe/awesome-pi-coding-agent` | auto-crawl from npm — picks it up on the next daily run |
| `pi.dev/packages/@sfgartland/better-pi-voice` | not indexed yet; the gallery runs on a schedule |
| social preview image | set by hand in repo settings (no CLI) |
| `v0.1.0` tag | created locally; **pushing it + the GitHub Release are the blocked steps** |
| demo video (`pi.video`) | `media/demo.mp4` committed; reaches the gallery only on the next publish |
| blog post | drafted at [`docs/blog/`](../blog/2026-10-16-what-claude-codes-dictation-does-differently.md); not posted |
| launch announcements | drafted at [`2026-10-16-launch-announcements.md`](2026-10-16-launch-announcements.md); not posted |

## Cutting the release (blocked — going public)

The changelog is committed and `v0.1.0` is tagged locally. To publish the tag and the
GitHub Release:

```bash
git push origin v0.1.0
gh release create v0.1.0 --title "v0.1.0" --notes-from-tag
```

Then the posts. Do them in this order, once the gallery page resolves:

1. pi Discord — the short message in `2026-10-16-launch-announcements.md`.
2. pi GitHub Discussions — `General` is the only category the pi repo has right now.
3. Blog post — publish to dev.to or a personal blog, then link it from the repo.
4. Optional HN / Reddit — ang per the announcements file; HN framed as accuracy, not
   as "a pi extension".

A `patch` release (0.1.1) is needed before the gallery can autoplay the video, because
the gallery reads `pi.video` from the published manifest, not from `main`:

```bash
npm version patch && git push --follow-tags && npm publish --access public
```

Verified:

```
npm view      → @sfgartland/better-pi-voice@0.1.0
npm run check → 303 pass, tsc clean, biome clean
npm pack      → 65 kB tarball, 24 files (tests excluded)
```

The npm account has 2FA, so publishing opens the web-auth flow. For the next release:

```bash
npm version patch && git push --follow-tags && npm publish --access public
```

## GitHub — done

The repo is live at <https://github.com/sfgartland/better-pi-voice> (public), pushed
from this working tree, with topics applied and the homepage pointed at the gallery
page:

```bash
gh repo edit sfgartland/better-pi-voice \
  --homepage "https://pi.dev/packages/@sfgartland/better-pi-voice"
```

Set the **social preview** by hand (GitHub has no CLI for it): repo → Settings →
Social preview → upload `media/screenshot.png`.

## After publishing — verify, in this order

1. `pi install npm:@sfgartland/better-pi-voice` from a clean shell, then `/voice setup`.
2. Gallery page appears: <https://pi.dev/packages/@sfgartland/better-pi-voice> (shows
   the README, the `pi install` line, download counts, and the `pi.image` preview).
3. It shows up in the auto-discovered list on the next daily run:
   <https://github.com/shaftoe/awesome-pi-coding-agent> (also
   <https://awesome-pi.site>).
4. `piindex.dev` mirrors `BubblePtr/awesome-pi`, so getting into that list gets you
   into the Pi Index too.

---

## Aggregate lists — what to submit

| List | How | Action |
|---|---|---|
| `shaftoe/awesome-pi-coding-agent` | auto-discovered from npm, rebuilt daily | none — just publish |
| `piindex.dev` | curates from `BubblePtr/awesome-pi` | via the awesome-pi entry below |
| `BubblePtr/awesome-pi` (139★, English README too) | pull request or "Suggest a resource" issue | **entry below** |
| `thevibeworks/awesome-pi-agent` | pull request, alphabetical in section | **entry below** |
| `bradAGI/awesome-cli-coding-agents` (1362★) | whole agents/harnesses, not pi extensions | not a good fit — skip |

> Do the list PRs **after** the npm publish, so the `pi install` line in the entry
> actually resolves. A reviewer who clicks through to a 404 closes the PR.

### Entry for `BubblePtr/awesome-pi` — `README.md` (Chinese, section `### UI Enhancement`)

Insert next to the existing `@juicesharp/rpiv-voice` line:

```markdown
- [@sfgartland/better-pi-voice](https://github.com/sfgartland/better-pi-voice) - 流式语音输入，云端 Deepgram 或本地 Parakeet 皆可；从仓库、会话与开发者术语中挖掘 keyterm 来偏置识别结果，并带回放与抢救式恢复，断线也不丢句子。`pi install npm:@sfgartland/better-pi-voice`
```

### Same list — `README.en.md` (English, section `### UI Enhancement`)

```markdown
- [@sfgartland/better-pi-voice](https://github.com/sfgartland/better-pi-voice) - Streaming dictation with Deepgram or local Parakeet, biased by keyterms mined from your repo and session, with replay/salvage recovery so a dropped socket never loses a sentence. `pi install npm:@sfgartland/better-pi-voice`
```

### Entry for `thevibeworks/awesome-pi-agent` — section `## UI & Interaction` (alphabetical)

```markdown
- [better-pi-voice](https://github.com/sfgartland/better-pi-voice) — Streaming voice input biased with your repository's vocabulary; Deepgram or local Parakeet, with replay/salvage recovery.
```

### Opening the PRs

```bash
gh repo fork BubblePtr/awesome-pi --clone=false
git clone https://github.com/sfgartland/awesome-pi /tmp/awesome-pi && cd /tmp/awesome-pi
git checkout -b add-better-pi-voice
# add the two lines above to README.md and README.en.md
git commit -am "Add @sfgartland/better-pi-voice (voice dictation for pi)"
git push -u origin add-better-pi-voice
gh pr create --repo BubblePtr/awesome-pi \
  --title "Add @sfgartland/better-pi-voice" \
  --body "Streaming voice input for pi, biased with repository keyterms; Deepgram or local Parakeet, with replay/salvage recovery. npm: https://www.npmjs.com/package/@sfgartland/better-pi-voice"
```

Repeat for `thevibeworks/awesome-pi-agent` (same fork/clone/branch/PR shape).

---

## Optional, but high-leverage

- **A demo video** (`pi.video`): the gallery autoplays it. A 10-second clip of the
  before/after text is enough; `media/screenshot.svg` is the storyboard.
- **A landing page**: GitHub Pages with the image, the before/after, and the install
  line. Every list links out to the repo; the repo is where the pitch has to land.
