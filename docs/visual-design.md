# Otto visual design

This pass changes the appearance of the app. It preserves routes, actions,
keyboard commands, account settings, and all assistant capabilities.

## Direction

Otto is a personal assistant with one persistent conversation. The conversation
is the main work area. Goals, schedules, apps, channels, and the Vault support it.
The interface must make these areas easy to find without adding visual noise.

Use the pink actions and plum surfaces from
[the earlier Otto](https://github.com/n8n-io/otto-grokbot-experiment).
Use the clear surface hierarchy and compact controls of
[Orca](https://github.com/stablyai/orca) and
[Linear](https://linear.app). The n8n editor also uses Inter. Serve that font
from Otto so the interface does not need an external font request. The normal
and italic variable font files come from the n8n design system. Their SIL Open
Font License is in `public/fonts/Inter-LICENSE.txt`.

The earlier Otto defines `#ff91ac` for primary actions and `#44001b` for text
on those actions. Its light accent text is `#bc3666`. These colors are the
base for this pass. The public
[n8n brand guide](https://n8n.io/brandguidelines/) lists `#ea4b71` for the logo.
The earlier Otto palette is the closer reference for this app.

## Color and contrast

| Role           | Light     | Dark      |
| -------------- | --------- | --------- |
| Canvas         | `#fdfcfe` | `#1e1b21` |
| Sidebar        | `#f5f3f7` | `#19161c` |
| Surface        | `#ffffff` | `#28242c` |
| Main text      | `#211c28` | `#f5f1f6` |
| Accent text    | `#ae2956` | `#ff91ac` |
| Primary action | `#ff91ac` | `#ff91ac` |

Define colors by their use in `src/web/theme.css`. Page styles use these
variables. Theme preview tiles use the same base values as the app.

Keep body text at a contrast ratio of at least 7:1. Keep secondary text,
placeholder text, links, and status text at least 4.5:1 on their surfaces.
Keep focus indicators and essential control boundaries at least 3:1.
Use softer borders for section dividers. A divider does not identify a control.

Use pink for primary actions, selection, and focus. Success, warning, error,
and information each have a separate text color and surface color. Preserve
their text and icon cues. Do not use color as the only state indicator.

## Type and spacing

Use Inter for the interface. Use the existing system monospace stack for code.
Use 13 px for controls, 14 px for list titles, 15 px for conversation text,
and 26 px for page titles. Use a line height of 1.6 for conversation text.
Keep the existing larger input text on touch devices.

Use a 4 px spacing scale: 4, 8, 12, 16, 20, 24, 32, and 40 px.
Use 8 px control corners, 12 px content corners, and 16 px dialog corners.
Use shadows for overlays and the composer. Lists use borders and spacing.

## Conversation

Keep chat bubbles for both sides. Place Otto's messages on the left and the
user's messages on the right. Use a neutral surface for Otto. Use solid dark
plum with white text for sent messages in the light theme. Use solid pink with
dark plum text for sent messages in the dark theme. This makes sent and received
messages easy to distinguish. Use no outline on bubbles. Round all four corners
equally. Use the same neutral surface for Otto's typing indicator.

The conversation should feel like text messages. Short progress messages keep
the user informed while Otto does the work. Each update should state a useful
step, result, or blocker. Group consecutive messages from the same sender with
a smaller gap. Keep full answers, tables, files, and task results readable.
Do not cut off content to make a message fit its bubble.

Include the sign-in approval change in this pass. When a website needs approval
on another device, Otto gives the instructions and watches the page. Use the same
page watch for other steps that need user action outside Otto's browser. Continue
after the page confirms completion. Ask the user only when Otto cannot read the
result or the wait ends. Do not watch or resume while the user controls Otto's
browser; wait until they hand it back. This keeps the user informed without
requiring a reply for a result that Otto can observe.

## Layout

The desktop sidebar uses an icon rail by default. Keep tooltips and accessible
names on the navigation icons. The user can expand the rail to see labels, and
the app keeps that choice. Navigation starts below the brand. The account and
utility actions stay at the bottom. Place one icon to collapse or expand the
sidebar at the top, beside the brand when there is room. Keep its accessible
name, tooltip, and keyboard shortcut. The selected route has a pink surface and
a clear icon. Use no border between the sidebar and the main workspace, or below
the chat header. The Inspector remains a separate column with its existing width
and resize control.

This diagram shows the expanded sidebar.

```text
+----------------+--------------------------------+------------------+
| Otto           | Conversation or page           | Inspector        |
|                |                                |                  |
| Chat           | Readable content width         | Tabs             |
| Goals          |                                |                  |
| Schedule       |                                | Current state    |
| Apps           |                                |                  |
| Channels       |                                | Details          |
| Vault          |                                |                  |
|                |                                |                  |
| Utilities      | Composer                       |                  |
| Account        |                                |                  |
+----------------+--------------------------------+------------------+
```

Secondary pages share one title size, content width, heading gap, and action
alignment. Apps retain their grid. Goals and schedules retain their lists and
tabs. The Vault retains its list and detail layout.

On phones, preserve the existing top bar and navigation sheet. Keep controls
large enough for touch, preserve safe area spacing, and avoid horizontal page
scroll. The Inspector keeps its existing phone presentation.

## Surface inventory

| Surface                    | Visual work                                    | Behavior to preserve                             |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| Shell                      | Brand, sidebar, route selection, account menu  | Collapse, shortcuts, navigation                  |
| Chat                       | Message surfaces, text, date markers, composer | Reply, reactions, files, formatting, voice, stop |
| Chat states                | Welcome, loading, working, reconnecting        | Existing status and recovery actions             |
| Goals and schedules        | Titles, tabs, rows, controls                   | Create, edit, pause, delete, history             |
| Apps and channels          | Cards, status, account details                 | Connect, manage, disconnect, setup               |
| Vault                      | Search, selection, details, fields             | Secure forms, reveal, edit, delete               |
| Inspector                  | Heading, tabs, surfaces, code details          | Resize, browser, tools, prompts, usage           |
| Account settings           | Navigation, fields, theme samples              | Profile, theme, notifications, locale            |
| Sign in and onboarding     | Brand, type, surfaces, controls                | Authentication and connection flow               |
| Credentials and approvals  | Form and action hierarchy                      | Origin, expiry, and action confirmation          |
| Files and links            | Borders, captions, toolbars                    | Preview, zoom, download, open                    |
| Privacy and connected page | Type, colors, surfaces                         | Existing links and completion state              |
| Menus and dialogs          | Common corners, shadow, focus                  | Keyboard access, dismissal, return focus         |

## Motion

Use short color and border transitions for user actions. Remove decorative icon
rotation and staggered page entrances. Keep working indicators and state
transitions. Respect the existing reduced motion setting.

## Checks

Review synthetic screens in light and dark themes at desktop and phone sizes.
Review populated and empty pages, long text, open menus, dialogs, selected tabs,
focus, disabled controls, and errors. Measure text contrast against the actual
surface color. Check page overflow and access to existing controls.

Run `npm run check`, `npm run test:integration`, and `npm run build`.
Report fixture checks, UI checks, and live checks separately.
