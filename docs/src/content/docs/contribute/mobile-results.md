---
title: Mobile results and files
description: Read structured results, reply with files or voice, react, and open safe file previews in the Flutter evaluation client.
---

The Flutter evaluation client shows structured results in chat and opens shared files without running their active content.

## Read a result

Chart results show a graphic and their exact series values, including negative values. Place results show names, coordinates, descriptions, and an **Open map** link.

Flights, bookings, seats, and diagrams show structured details. Booking status, operating carrier, time zones, connection risks, seat availability, coverage, and source links remain separate fields. These cards don't book or change anything. Flight and booking options aren't treated as confirmed purchases.

App suggestions offer **Connect in Apps**. A discovered service's setup link opens its authenticated native setup page. Private sign-in and payment links open the existing private request page, not an unauthenticated external browser. A focused task message also offers **Open task browser**, bound to that message's turn. This works when the task is outside the recent-state window. The server still checks whether its handoff is active; an ended handoff can't open a replacement task's browser.

## Reply and react

Select **Reply** below a stored message, then type, attach files, record a voice message, or combine them. The server receives the original message and conversation identifiers. A reply to a background question continues the session that asked.

The client preserves the same message identifier when you retry an unchanged uncertain send. It checks history after a failed file or voice send before offering a retry. Verification replies retain the existing secret-handling path and aren't added as local message previews.

Select **React** below an assistant message to choose a quick emoji. Select your current reaction again to remove it. Reactions use the server's feedback route and never answer a question or approve an action. **Copy message** copies the message's Markdown text.

## Open a file

Select an attachment or its file link in a reply. The client downloads it through the paired authenticated connection.

- Raster images open with zoom, where the platform image decoder supports the format.
- Text, code, Markdown, JSON, CSV, and TSV open as selectable source text. JSON is indented when it parses.
- HTML, SVG, and XML open only as literal source text, even when their MIME type or filename suggests another preview.
- Text previews stop at the first 4 MB. **Open or save** keeps the complete file.
- PDF, video, Office documents, slides, archives, and other unsupported formats use **Open or save** through the device's share sheet.

The installed Flutter dependencies don't include PDF, video, Office, or slide renderers. Those formats don't have an in-app player or page viewer. Place cards aren't an embedded map, diagrams aren't a graphical canvas, and travel cards aren't interactive booking or seat-selection tools.

No artifact opens in a WebView, privileged HTML document, or local blob URL. Active content can't execute or make network requests inside the preview. Opening or saving a file in another app is a deliberate action; that app controls its own handling.

Preview copies live in a separate temporary directory. Closing the preview removes its copy after any open share sheet returns. A forced process stop can leave temporary files behind.

## Binary feature transport

Native feature repositories can request bounded binary responses through `NodBinaryTransport.requestBytes`. This supports speech preview and Markdown memory export without giving feature widgets credentials.

The HTTP implementation accepts only relative `/api/` paths on the paired origin. It disables redirects, limits each response to 16 MB, applies the configured request deadline, and refuses a result from a disconnected or replaced connection. JSON responses have the same connection-generation fence. Multi-request repositories can capture and recheck the credential-free `NodConnectionScope.connectionGeneration` value. Artifact downloads keep their existing streamed file route and 90 MB limit.

## Evaluation limits

Synthetic HTTP fixtures and Flutter widget tests cover structured result data, addressed file and voice requests, private links, connection setup links, binary transport isolation, and literal active-content previews.

These checks don't prove native decoding, share-sheet behavior, microphone access, live providers, connected accounts, or physical-device readiness. Native runtime checks and the full docs build are coordinated separately.

## Related resources

- [Mobile client evaluation](/contribute/mobile-evaluation/)
- [Chat with Nod](/use/chat/)
- [Workspace and files](/use/workspace/)
- [Trust and Vault](/trust/)
