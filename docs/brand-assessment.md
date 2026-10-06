# Otto brand assessment

Review date: 6 October 2026.

## Reference and scope

The reference is the [new n8n brand system](https://guidelines.n8n.design/).
The site supplies [n8ndesign.md, version 3](https://guidelines.n8n.design/downloads/n8ndesign.md),
updated on 5 October 2026. The color and logo pages are available. Several
other site sections are still marked as coming soon. The download supplies
additional type, spacing, and layout rules.

This work applies the reference to Otto's existing application. It changes
appearance and the sign-in introduction. Assistant behavior, account access,
approvals, and storage remain outside this change.

## Main findings

| Priority | Before                                                                | Change                                                            | Result                                                           |
| -------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| High     | Almost every surface had a plum tint.                                 | Use the guide's neutral gray palette.                             | Pink actions and selection have a clearer role.                  |
| High     | Primary action text used dark plum.                                   | Use core black on main pink.                                      | The action contrast reaches 8.29:1.                              |
| High     | Type sizes varied between pages and small controls.                   | Use shared 14 px control, 16 px body, and 32 px title values.     | Supporting text is easier to read.                               |
| High     | The old document referred to earlier Otto branding.                   | Replace it with the new source and product rules.                 | Future changes have one current reference.                       |
| Medium   | Many gaps used values outside the spacing scale.                      | Use 8 px layout steps and 4 px or 12 px detail steps.             | Cards, headings, dialogs, and fields align more consistently.    |
| Medium   | Theme samples used separate, old color values.                        | Use the same palette variables as the app.                        | The samples show the delivered themes.                           |
| Medium   | Sign-in used a raised card and a broad promise about completed work.  | Use a dot grid, an inset panel, and concrete capability text.     | The entry screen has a clear brand device and more precise copy. |
| Medium   | Native setup, favicon, and connection completion kept the old colors. | Apply the same neutral palette.                                   | These surfaces match the main app.                               |
| Medium   | The guide's Baumer fonts are proprietary.                             | Use Baumer after the owner confirmed web and desktop font rights. | The interface uses the new brand typefaces.                      |
| Low      | The interface had no new brand device.                                | Add a dot grid to sign-in and empty chat only.                    | The brand is visible without texture behind active work.         |

## Preview

The [preview image](branding-preview.png) shows synthetic data in Chat,
Tasks, and sign-in.

## Icon assessment

The guide shows an [outline icon reference](https://guidelines.n8n.design/assets/brand-system/overview/light/15-icon-set.png).
It does not supply a product SVG package. Otto keeps Lucide for controls, with
a consistent 2 px stroke and 16 px or 24 px sizes. Navigation and page title
symbols use 24 px. Large empty-state symbols use the spacing scale. The
reference informs size, weight, and color; these are not the official n8n
symbol files.

The favicon and touch icon keep Otto's existing geometry and use the new
colors. Connected-service logos keep their own colors.

## Design decision

The conversation stays the main work area. The compact sidebar, message
bubbles, and separate Inspector already support that purpose. Rebuilding them
would add change without a clear benefit.

The visual emphasis is the pink action on a quiet gray interface. The entry
screen carries the dot grid and inset panel. Active screens use space,
alignment, and type to show structure. The same design serves light and dark
themes.

## Product choices

The guide covers brand layouts as well as product examples. Some rules need
an explicit product choice:

- Use deep pink for links and focus on light surfaces. Main pink text fails
  the guide's own text contrast threshold there.
- Use solid gray secondary text instead of the guide's 50% black. Small
  interface text needs sufficient contrast on every surface.
- Keep separate success, warning, error, and information colors. They carry
  useful state information in setup and safety flows.
- Keep code, URLs, passwords, and user content in their original case. The
  uppercase mono rule is for brand capsules, not runnable code.
- Keep conversation line height at 1.6. Dense replies and tables need more
  reading space than short brand layouts.
- Keep continuous reading areas free of graphic devices. Dot grids and inset
  effects belong on the entry screen, not behind conversation text.
- Keep Otto's existing mark. Do not substitute or redraw the n8n logo. Use
  the [official logo files](https://guidelines.n8n.design/logo) if an n8n
  identity element is added later.
- Keep the existing motion and reduced-motion behavior. The guide does not
  yet supply product motion rules.

The result follows the palette, typefaces, action states, spacing, corner
sizes, type scale, text wrapping, and selected graphic devices. The owner confirmed the Baumer font license for both apps.

## Function preservation

The PR starts from the current `main` branch. The newer Tasks page, feedback
flow, model account controls, sign-in cancellation, callback form, and
analytics attributes are retained. The appearance changes do not remove
routes, API calls, action handlers, or safety checks.

The access changes include visible text in control names, restore focus to
the correct account or phone control, and make conversation tables reachable
with the keyboard. Dialog positions use a length value when the desktop
title bar is absent, so feedback stays visible in the web app.
The existing Vault safety test uses a stable field
selector after its accessible name changes.

## Contrast

These values were calculated from the delivered palette. Text checks use the
actual surface color, not the canvas alone.

| Text or boundary         | Surface              | Ratio   |
| ------------------------ | -------------------- | ------- |
| Core black               | Light canvas         | 16.84:1 |
| Gray 70 supporting text  | Light canvas         | 5.42:1  |
| Gray 70 supporting text  | Gray 15 surface      | 5.01:1  |
| Core white               | Dark surface         | 14.87:1 |
| Gray 40 supporting text  | Gray 85 overlay      | 6.67:1  |
| Core black               | Main pink action     | 8.29:1  |
| Pink 70 link or focus    | Light canvas         | 9.60:1  |
| Main pink link or focus  | Dark surface         | 7.32:1  |
| Core white               | Pink 80 sent message | 13.75:1 |
| Gray 70 input boundary   | Gray 15 surface      | 5.01:1  |
| Gray 60 control boundary | Gray 85 control      | 3.37:1  |

## Validation record

The UI review uses a local preview with synthetic messages, apps, tasks,
schedules, Vault records, models, and account details. Its API handlers do not
load the real server, database, providers, connected accounts, or recipients.

The review checks desktop and phone layouts in both themes. It includes chat
with a table and a long draft, Apps, Tasks, Schedule, Vault, Channels,
sign-in, onboarding, and empty chat. Open dialogs, account settings, menus,
and keyboard focus receive separate checks.

The preview and screenshots are local review artifacts. They are not automated
regression tests. No test of CSS values, copy, or configuration was added.

The current branch passes `npm run check` and `npm run build`. The integration
suite passes all 629 tests. Desktop tests pass 131 tests; the Linux firewall
case is skipped on this Mac. The browser review covers 36 page layouts in
both themes. Dialog and interaction checks are recorded separately with the
local review artifacts. Live model and connected-account checks are
not needed for this appearance change and were not run.
