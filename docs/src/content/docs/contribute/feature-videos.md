---
title: Feature videos
description: Make a short video that shows a new feature in the real Nod interface, and attach it to your pull request.
sidebar:
  order: 9
---

This page explains how to make a short video of a feature you built, so reviewers and users can see it working.

A feature video is a 20 to 30 second square clip. It shows the real Nod interface with made-up data, a cursor that uses your feature once, and a short headline. Make one when your pull request adds or changes something a user can see. A bug fix doesn't need one.

## How it works

```mermaid
flowchart LR
  code[Your branch]:::accent --> capture[Capture the real screens<br/>with made-up data]
  capture --> page[Describe the beats<br/>headline, clicks, timing]
  page --> render[Render every frame<br/>and the music]:::go
  render --> pr[Attach the MP4<br/>to your pull request]:::muted
```

The video is built from your branch's own frontend. A script runs it without a server, a database or an account, answers its requests from a file of made-up data, clicks through your feature and takes screenshots. A second script animates over those screenshots and renders the video. Nothing is screen-recorded, so nothing private can end up in it.

## Before you start

You need:

- the repository set up as in [Contribute to Nod](/contribute/#set-up-a-development-copy), with dependencies installed;
- [ffmpeg](https://ffmpeg.org/download.html);
- Chrome or Chromium;
- zsh, which macOS includes;
- a network connection, because the video loads the n8n brand fonts.

## Make a video with a coding agent

The repository includes an agent skill, `feature-video`, in `.claude/skills/feature-video`. It holds the full instructions, the templates and the scripts.

1. Open the repository in Claude Code, on your feature branch.
2. Ask for the video, for example `/feature-video for the Run now button on schedules`.
3. Watch the result. Check that every screen is your feature as it ships, and that every claim is true.
4. Drag the MP4 into the **Summary** of your pull request description.

Other coding agents can follow the same instructions. Point yours at `.claude/skills/feature-video/SKILL.md`.

You don't have to remember to ask for a feature video. The repository's agent instructions tell a coding agent to offer one before it opens a pull request for a feature you can see. It makes that video only when you say yes. Individual fix, refactor, and docs PRs need no video.

The agent works in a temporary folder. Captures, pages and videos never go into the repository.

## What a good video shows

- **The real interface.** Screens come from your branch, at their real size. Nothing is redrawn.
- **One action per feature.** The click that explains it, and what Nod shows next.
- **Made-up data only.** No real accounts, emails, keys or private content. See [Pull requests](/contribute/pull-requests/#prepare-the-pull-request).
- **True claims.** Show Nod finishing a job only if you have seen it finish that job.
- **Limits that matter.** If the feature is a preview or needs something, say so in the video.

## Release videos

The coding agent tries to make a video for every desktop release. It uses the draft highlights and captures the exact source commit in `desktop/release.json`. A published release or tag is not needed. CI checks any saved video metadata and publishes the reviewed URL with the notes. CI does not run a model or create the video.

If the video does not meet the skill's quality standard, or cannot be made or uploaded, the release continues with text notes. The agent leaves `video: null` and explains the specific reason in the PR without private content. It removes a rejected video from the PR description. The quality standard stays the same, and a video failure does not delay the release.

A release that contains only fixes gets the same visual care. Its opening frame makes the improvements clear. It shows two or three concrete fixes and invites users to update. Real captures show visible corrections. Fixes without a useful screen use an animated text summary. The video must not claim new features or unsupported speed or safety improvements.

See [Make the release video](/contribute/desktop-releases/#make-the-release-video) for the full preparation and review steps. The agent attaches the MP4 to the authorized release PR. This does not authorize merging or publishing the release.

You can also ask for a video of a published release, such as `/feature-video for the v0.7.4 release`. That video uses its published highlights and tag.
