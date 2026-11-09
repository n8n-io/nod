---
title: Workspace and files
description: What Nod's own Linux computer can do, what it can't reach, and how files move between you and Nod.
sidebar:
  order: 4
---

Nod has its own Linux computer, called the workspace, where it runs commands and keeps files for your conversation.

The workspace is separate from your computer. Nod can write documents, convert files, run code and keep notes there without touching your own files.

## What Nod can use

| For                     | The workspace has                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Office files            | LibreOffice, to convert, render and recalculate documents and sheets                                  |
| PDFs                    | qpdf, Ghostscript and pypdf, to fill forms and repair files                                           |
| Text in any language    | Noto fonts for other scripts and emoji                                                                |
| Video from a link       | `save-video`, which saves a video as an MP4 of 50 MB or less to send, or the full video with `--full` |
| Anything else in Python | `pip install`, which adds libraries to `~/.local`                                                     |

`save-video` refuses live streams and videos too long to fit at a watchable quality. `save-video --full` keeps the whole video at full quality in the workspace instead, for example to transcribe or cut it.

## What the workspace can't reach

```mermaid
flowchart LR
  you([You]):::accent
  home[(Your home folder)]:::muted
  server[Nod server<br/>keys stay here]
  subgraph Nod ["Nod's computer"]
    ws[Workspace]
    br[Browser]
  end
  you -- attach files --> server
  server -- copies files in --> ws
  ws -- shared files --> server
  server -- attachments in chat --> you
  server -- drives --> br
```

- **Your files.** The workspace doesn't see your home folder. It only gets the files you attach or that Nod fetches.
- **Keys.** Model provider keys and Nod's access key never enter the workspace. If you connect a command-line tool, its token reaches only that tool, never code Nod writes.
- **The browser.** Nod's browser runs in its own container. The workspace can't read its saved sign-ins.

:::caution
The workspace can reach the internet. Code that Nod runs there can download files and call websites.
:::

## Give Nod files

- **Attach them in chat.** Each file can be 90 MB or smaller. Nod gets a copy in the workspace and sees images directly.
- **From your apps.** Files from a connected app, such as an email attachment, are saved privately in the workspace.
- **From the web.** Files that Nod downloads in its [browser](/use/browser/) go into the workspace.

## Get files from Nod

When Nod shares a file, it appears as an attachment in the Nod app, up to 90 MB. Select it to open a panel next to the chat. Press Left or Right to move through the conversation's files and visuals. Drag the panel's edge to resize it, and press **Escape** to close it. Arrow keys keep their usual behavior in inputs, media controls, selected text, or a zoomed preview. Select **Download** to save a file.

File actions appear over previews in chat and in the panel's toolbar. Videos play directly in chat when your browser supports the format, with a preview frame when available. Playback starts when you select Play and pauses when the video leaves view. Use the expand control to open the larger player.

The panel remembers reading state for up to eight recently viewed files, with a total retention limit of 90 MB. Use the filename selector to jump between files during this conversation visit.

- **Use in message** adds an existing file to your draft.
- **Copy image** copies raster image data where the clipboard supports it. **Download** keeps the original file format.
- In the desktop app, drag a file card, image, or preview file icon to a folder to copy the file. **Save to Downloads** shows **Open** and **Show in folder** after the save completes. The file menu uses the system menu.

Desktop file actions prepare private copies in the system temporary folder, up to eight files. They're removed when the cache needs room or the app quits. A forced stop can leave one behind. Saving creates a separate file in Downloads.

Native opening is limited to supported document and raster image types. Save other formats and open them from your file manager.

| File                                    | How it opens                                                       |
| --------------------------------------- | ------------------------------------------------------------------ |
| Images, video and audio                 | At full size. Select an image to zoom; audio shows its waveform    |
| PDF                                     | Every page, with zoom                                              |
| Word (`.docx`) and PowerPoint (`.pptx`) | As a page or slides. The layout is close to, not exactly, Office's |
| Excel, CSV and TSV                      | As a table with its sheets, up to the first 200 rows               |
| Markdown, HTML and SVG                  | Rendered, with a **Code** view                                     |
| n8n workflows (`.n8n.json`)             | As a canvas of nodes and connections, with a **Code** view         |
| Code, JSON and text                     | With syntax highlighting                                           |
| ZIP                                     | The list of files inside                                           |

HTML files run in a sandbox, apart from Nod. Their scripts work, but they can't reach Nod or your accounts, load anything from the internet, send forms or open windows. If a page navigates to a website, its preview closes. Other files open without running any code.

Previews have size limits: 4 MB for text, Markdown, HTML and spreadsheets, 25 MB for Word documents and 60 MB for presentations. Download larger files to open them.

When Nod puts a full workspace file path in a link or inline code in a reply, the server checks the file and attaches it. The link opens the attachment. A missing or unavailable file prevents that reply from being saved. File paths in code blocks remain examples.

Files Nod saves along the way stay private in the workspace until it shares them. Ask for one by name if you want it. Telegram and the WhatsApp QR connection receive shared files up to 50 MB each. With the WhatsApp Cloud API, open Nod to get files. See [Telegram and WhatsApp](/use/channels/).

## One workspace for all tasks

The main chat and all saved tasks use the same conversation workspace. Each task has a folder under `tasks/`, with `drafts/` for working files and `outputs/` for results. `shared/` holds common files.

A task can read files from another task's output folder. These folders organize work; they do not create separate computers or file access boundaries. Each task keeps its own saved conversation history. Sharing a file does not automatically add its content to every active task's context.

See [Task sessions](/how-it-works/task-sessions/#shared-information-separate-histories) for how files, memory and owner updates keep the work connected.

## How long files stay

Files stay in the workspace for the whole conversation. Nod can come back to them days later.

## Related resources

- [Chat with Nod](/use/chat/)
- [Nod's browser](/use/browser/)
- [Your data and privacy](/trust/privacy/)
- [Sandbox and browser](/how-it-works/sandbox-and-browser/)
