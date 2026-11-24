---
name: antigravity
description: Use whenever the user mentions Antigravity, or asks to perform coding, research, web search, YouTube video analysis/timestamps, skill setup, file editing, shell commands, or git management in Antigravity.
---

# Google Antigravity Full Integration Guide

Use the connected Antigravity MCP server to delegate ANY task to Google Antigravity: full autonomous software engineering, YouTube video analysis and scene timestamps, live web searches, shell commands, file read/write/edits, skill setups, and git operations.

## Available Tools

The tools are exposed as `mcp__antigravity__<tool>` or `mcp__gemini__<tool>`. Load the ones you need with `nod_tool_search`:

### 1. General & Multimodal Intelligence
- `mcp__antigravity__agent`: Universal autonomous agent. Executes complete missions (coding, bug fixes, refactors, database models) and commits to git.
- `mcp__antigravity__ask`: General AI assistant for asking questions, analyzing content, or reasoning without touching files.
- `mcp__antigravity__youtube_analyze`: Watches YouTube videos or Shorts, extracts transcripts, metadata, and provides scene-by-scene timestamps.
- `mcp__antigravity__web_search`: Live web search with real-time snippets and URLs.
- `mcp__antigravity__fetch_url`: Fetches and extracts readable text or JSON from any webpage, API, or documentation.

### 2. Codebase & Terminal Control
- `mcp__antigravity__run_command`: Executes terminal commands (e.g. `npm test`, `git log`, `pnpm build`, `cargo`, `python`) in projects or workspace.
- `mcp__antigravity__read_file`: Reads files with optional line slicing (`start_line`, `end_line`).
- `mcp__antigravity__write_file`: Writes or overwrites files, creating parent directories automatically.
- `mcp__antigravity__edit_file`: Performs exact surgical find-and-replace edits on existing code.
- `mcp__antigravity__list_files`: Explores directory file trees, ignoring `node_modules` and `.git`.

### 3. Git & Project Lifecycle
- `mcp__antigravity__git_status`: Inspects branch, modified files, untracked changes, and recent commit history.
- `mcp__antigravity__git_commit`: Stages files and creates clean semantic git commits.
- `mcp__antigravity__list_projects`: Lists all projects and their git branches.
- `mcp__antigravity__create_project`: Bootstraps new project workspaces with git initialization.

### 4. Skill & Capability Management
- `mcp__antigravity__list_skills`: Lists all installed Antigravity skills (Shopify, n8n, Gemini API, database, automations, etc.).
- `mcp__antigravity__setup_skill`: Injects and configures a skill (e.g. `shopify`, `database`, `gemini-api`) into a project.

## How to Route User Prompts

- **When the user asks to watch or analyze a video:** Call `antigravity_youtube_analyze` or `antigravity_ask` with the video URL.
- **When the user asks to search the web or find docs:** Call `antigravity_web_search` or `antigravity_fetch_url`.
- **When the user asks to build, fix, or add features:** Call `antigravity_agent` with the task description.
- **When the user asks to run commands, check tests, or inspect files:** Call `antigravity_run_command`, `antigravity_read_file`, or `antigravity_list_files`.
- **When the user asks to configure a skill (e.g. Shopify, database):** Call `antigravity_setup_skill`.
