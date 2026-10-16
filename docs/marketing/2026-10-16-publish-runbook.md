# Publish runbook — `@sfgartland/better-pi-voice` 0.1.0

**Date:** 2026-10-16
**State:** everything that can be done without credentials is done. The package is
clean, tested, and packaged. One step needs an account login — marked **[BLOCKED]**.

Verified now:

```
npm run check          → 303 pass, tsc clean, biome clean
npm pack               → 65 kB tarball, 24 files (tests excluded)
npm publish --dry-run  → @sfgartland/better-pi-voice@0.1.0, public access
```

---

## Blocker — npm is not logged in

```
$ npm whoami
npm error code ENEEDAUTH
```

There is no `~/.npmrc`, so nothing is authenticated. Fix, then publish:

```bash
npm login          # log in as: sfgartland
npm whoami         # should print: sfgartland
npm publish --access public
npm view @sfgartland/better-pi-voice version
```

`@sfgartland` is a **user scope**: npm lets an account publish `@<its-username>/…`
without creating an organization first. If npm asks for an org, create one named
`sfgartland` (free for public packages).

## GitHub — already unblocked

`gh` is authenticated as **`sfgartland`**, which is the account that will own the
repo, so there is nothing to switch. Create it and push:

```bash
gh repo create sfgartland/better-pi-voice --public --source=. --remote=origin --push \
  --description "Accurate voice dictation for the pi coding agent — Deepgram or local Parakeet, biased with your repo's vocabulary."
```

Then set topics and homepage (the gallery and search use these):

```bash
gh repo edit sfgartland/better-pi-voice \
  --add-topic pi-package,pi-extension,dictation,speech-to-text,deepgram,parakeet,coding-agent,cli,linux,offline \
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
