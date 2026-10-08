# Otto visual design

Reviewed on 6 October 2026 against the
[n8n brand system](https://guidelines.n8n.design/) and its
[n8ndesign.md, version 3](https://guidelines.n8n.design/downloads/n8ndesign.md).
The [assessment](brand-assessment.md) records the gaps, changes, and checks.

## Purpose

Otto is a personal assistant with one conversation. Chat is the main work area.
Tasks, schedules, apps, channels, and the Vault support that conversation.
Keep navigation and task results clear. Keep decoration out of active work.

The n8n guide replaces the earlier Otto palette as the design reference.
Use neutral gray surfaces, pink primary actions, and clear text. Keep Otto's
existing symbol. It is a product mark, not a copy of the n8n logo. If an n8n
logo is needed later, use an official file from the brand portal.

## Color

Define the palette and its use in `src/web/theme.css`. Page styles use variables.
Theme samples use the same palette. Do not put page-specific colors in styles.

| Role                     | Light          | Dark           |
| ------------------------ | -------------- | -------------- |
| Canvas                   | `--white`      | `--black`      |
| Sidebar                  | `--gray-15`    | `--gray-90`    |
| Raised surface           | `--gray-0`     | `--gray-90`    |
| Inset surface            | `--gray-20`    | `--gray-85`    |
| Main text                | `--black`      | `--white`      |
| Secondary text           | `--gray-80`    | `--gray-30`    |
| Muted text               | `--gray-70`    | `--gray-40`    |
| Primary action           | `--brand-pink` | `--brand-pink` |
| Text on a primary action | `--black`      | `--black`      |
| Selected surface         | `--pink-10`    | `--pink-80`    |
| Link and focus           | `--pink-70`    | `--brand-pink` |
| Sent message             | `--pink-20`    | `--pink-80`    |
| Text on a sent message   | `--black`      | `--white`      |

Use black text on main pink. Main pink text does not have enough contrast on a
light surface. Use deep pink for light-theme links and keyboard focus.

Keep body text at least 7:1. Keep smaller text, placeholders, links, and status
text at least 4.5:1. Essential control boundaries and focus must reach 3:1.
Dividers can be softer because they do not identify a control.

Keep the existing success, warning, error, and information colors. These are
product states. Use an icon or text with each state. A brand color alone must
not carry a safety decision.

## Type

Use n8n Baumer Uniwidth for the interface and n8n Baumer Mono for code.
Use regular body text and medium headings. Serve both fonts locally. The owner
confirmed the font license for Otto's web and desktop apps on 6 October 2026.
Font sources are recorded in `public/fonts/Baumer-SOURCE.md`.

Use these sizes across the app:

| Use                         | Size                   | Line height            |
| --------------------------- | ---------------------- | ---------------------- |
| Page title                  | 32 px; 28 px on phones | 36 px; 32 px on phones |
| Sign-in story title         | 40 px                  | 42 px                  |
| Message and long text       | 16 px                  | 1.6                    |
| Control and supporting text | 14 px                  | At least 18 px         |
| Small graphic detail        | 10 px                  | At least 14 px         |

Use regular body text and medium headings. Enable standard ligatures.
Balance short headings. Use natural paragraph wrapping. Keep code, passwords,
URLs, and user content in their original case. Do not use the brand's uppercase
capsule rule on technical data.

## Spacing and shape

Use 8 px steps for layout. Use 4 px and 12 px for small controls and details.
Use 8 px control corners, 12 px content corners, and 16 px dialog corners.
Use the existing fully rounded shapes for dots, avatars, and switches.

Keep page content within 1184 px and chat within 880 px. These widths use the
8 px scale. Page padding changes with the available width. Keep a 16 px inset
on phones. Use a shared title size and align actions with the page heading.

Use borders and space for lists. Use shadows for menus, dialogs, and the
composer. The sign-in story uses the guide's medium inset shadow: the panel
has the same background as its surrounding surface.

## Brand devices

Use a 24 px dot grid on the sign-in story and the empty conversation. Align
it with the layout scale. Keep the dot grid out of messages, tables, forms,
app lists, and Settings.

Do not show a construction grid. Do not add marketing capsules to application
controls. A status, tab, or navigation item must stay a clear control.

## Icons

Use the existing Lucide symbols for product controls. The guide shows a bold
outline icon set, but it does not supply a product SVG package. This is a
product adaptation, not an import of the official n8n icon set.

Use a 2 px stroke in the 24 px view box. Use 16 px for inline controls and
status, 24 px for navigation and page titles, and 32 px or 48 px for large
empty-state symbols. Keep symbols aligned with the text. Use neutral color
by default and pink for selected navigation. Keep state colors on status
symbols. Keep connected-service logos in their official colors.

Otto uses its own existing mark in the app, favicon, and touch icon. Use the
new base colors for that mark. Keep its shape and proportions.

## Product surfaces

| Surface                         | Design rule                                                            |
| ------------------------------- | ---------------------------------------------------------------------- |
| Shell                           | Neutral sidebar; pink selection; quiet utility controls                |
| Chat                            | Neutral received bubbles; pink sent bubbles; readable tables and files |
| Composer                        | Clear boundary; visible focus; one primary send action                 |
| Tasks and schedules             | Shared title, tabs, row spacing, and action height                     |
| Apps and channels               | Neutral cards; visible connection state; consistent controls           |
| Vault                           | Clear selection, fields, and error states; preserve secure forms       |
| Trust                           | One summary line, one cost card, a quiet statement list                |
| Account settings                | Consistent fields and theme samples; preserve keyboard access          |
| Sign-in                         | Plain capability text; pink sign-in action; one inset story panel      |
| Onboarding                      | Clear connection steps; no decorative grid behind fields               |
| Credentials and approvals       | Clear action hierarchy; preserve origin and expiry                     |
| File previews                   | Clear captions and toolbars; preserve local scrolling                  |
| Native desktop setup            | Same palette and type scale as the web app                             |
| Icons and connection completion | Same base colors as the app                                            |

Keep existing routes, actions, shortcuts, sidebar choice, account settings,
browser controls, and assistant capabilities. Use the existing reduced-motion
behavior. The brand guide does not yet define motion for product interfaces.

## Checks

Use synthetic data. Check light and dark themes at desktop and phone sizes.
Check open menus, dialogs, selected tabs, keyboard focus, disabled controls,
long text, tables, and errors. Check empty and populated states. Confirm font
loading and text contrast. Check that the page does not scroll horizontally.

Run `npm run check`, `npm run test:integration`, and `npm run build`.
Report synthetic UI checks and live checks separately.
