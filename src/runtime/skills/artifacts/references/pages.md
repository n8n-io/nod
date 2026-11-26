# HTML pages

An HTML page opens inside Nod as a preview next to the chat, and as a downloaded file in a chat app. Write one self-contained `.html` file.

## What the viewer allows

- The page makes no network request. Fonts, stylesheets, scripts, images and `fetch` from any address are blocked. Put all CSS in one `<style>` and all JavaScript inline.
- Images are inline SVG or `data:` URIs.
- Use the installed-font stacks in the base below. Never link a web font.
- `localStorage`, `sessionStorage` and cookies throw. Keep state in script variables.
- The page must never navigate. A `location` change or a second load closes the preview, and a form does not submit. Use `<button type="button">` for every control. An `<a href="#section">` link is not reliable inside the preview, so jump within the page with a button and `window.scrollTo`, as the reference page layout does. Never call `scrollIntoView`: it can scroll the app around the preview.
- Links to websites do not open from the preview. Print the address as visible text next to its label so the owner can copy it.
- Thumbnails render with scripts off. Every section and table must be readable before any script runs. Scripts add sorting, filtering, tabs and navigation; they never build the content.

## Base

Start every page from this document. It has a light and a dark theme, and the page follows the owner's theme in Nod. Change the colour tokens only when the owner gives a brand or a mood, and change both themes together.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Title</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #fafafa;
        --surface: #fff;
        --fg: #151515;
        --muted: #636363;
        --border: #e3e3e3;
        --control: #8a8a8a;
        --print-bg: #fff;
        --print-fg: #000;
        --accent: #2459c9;
        --good: #16713a;
        --warn: #855d00;
        --bad: #b92323;
        --sans: 'Inter', 'Segoe UI', 'Helvetica Neue', system-ui, sans-serif;
        --mono: ui-monospace, 'SF Mono', 'Menlo', 'Consolas', monospace;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #111;
          --surface: #1a1a1a;
          --fg: #ededed;
          --muted: #a3a3a3;
          --border: #ffffff1f;
          --control: #8a8a8a;
          --accent: #8fb2ff;
          --good: #62cf8c;
          --warn: #e3b84f;
          --bad: #ff8f8f;
        }
      }
      *,
      *::before,
      *::after {
        box-sizing: border-box;
      }
      strong,
      b {
        font-weight: 600;
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--fg);
        font: 16px/1.55 var(--sans);
        -webkit-font-smoothing: antialiased;
      }
      .page {
        max-width: 860px;
        margin: 0 auto;
        padding: 48px 24px 96px;
      }
      h1,
      h2,
      h3 {
        line-height: 1.2;
        text-wrap: balance;
        margin: 0;
      }
      h1 {
        font-size: 34px;
        font-weight: 600;
        letter-spacing: -0.02em;
      }
      h2 {
        font-size: 21px;
        font-weight: 600;
        letter-spacing: -0.01em;
        margin-top: 48px;
        padding-top: 24px;
        border-top: 1px solid var(--border);
      }
      h3 {
        font-size: 16px;
        font-weight: 600;
        margin-top: 24px;
      }
      p,
      ul,
      ol {
        max-width: 68ch;
        margin: 12px 0 0;
        text-wrap: pretty;
      }
      li + li {
        margin-top: 8px;
      }
      a {
        color: inherit;
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      .eyebrow {
        font: 500 12px/1.4 var(--mono);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
        margin: 0 0 12px;
      }
      .lede {
        font-size: 19px;
        line-height: 1.5;
        color: var(--muted);
        margin-top: 16px;
      }
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 24px;
        margin-top: 24px;
        font-size: 14px;
        color: var(--muted);
      }
      .pill {
        display: inline-block;
        padding: 2px 10px;
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0.02em;
        white-space: nowrap;
      }
      .pill.good {
        color: var(--good);
        background: color-mix(in srgb, var(--good) 12%, transparent);
        border-color: transparent;
      }
      .pill.warn {
        color: var(--warn);
        background: color-mix(in srgb, var(--warn) 14%, transparent);
        border-color: transparent;
      }
      .pill.bad {
        color: var(--bad);
        background: color-mix(in srgb, var(--bad) 12%, transparent);
        border-color: transparent;
      }
      .page.wide {
        max-width: 1080px;
      }
      .note.warn {
        background: color-mix(in srgb, var(--warn) 10%, var(--surface));
        border-color: color-mix(in srgb, var(--warn) 35%, var(--border));
      }
      .cols {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 24px;
        margin-top: 16px;
      }
      .card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 24px;
      }
      .card > :first-child {
        margin-top: 0;
      }
      .figure {
        font-size: 32px;
        font-weight: 600;
        letter-spacing: -0.02em;
        font-variant-numeric: tabular-nums;
      }
      .note {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px 16px;
        margin-top: 16px;
        max-width: 68ch;
      }
      .note strong:first-child {
        display: block;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.02em;
        color: var(--muted);
      }
      .scroll {
        overflow-x: auto;
        margin-top: 16px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 15px;
        font-variant-numeric: tabular-nums;
      }
      th {
        text-align: left;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0.02em;
        color: var(--muted);
      }
      th,
      td {
        padding: 12px 24px 12px 0;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      th:last-child,
      td:last-child {
        padding-right: 0;
      }
      td.num,
      th.num {
        text-align: right;
      }
      code,
      pre {
        font-family: var(--mono);
        font-size: 14px;
      }
      code {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 1px 5px;
      }
      pre {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 16px;
        overflow-x: auto;
        line-height: 1.5;
        margin: 16px 0 0;
      }
      pre code {
        background: none;
        border: 0;
        padding: 0;
      }
      button,
      input,
      select {
        font: inherit;
        color: inherit;
        background: var(--surface);
        border: 1px solid var(--control);
        border-radius: 8px;
        padding: 8px 12px;
      }
      button {
        cursor: pointer;
      }
      figure {
        margin: 16px 0 0;
      }
      figcaption {
        font-size: 14px;
        color: var(--muted);
        margin-top: 8px;
        max-width: 68ch;
      }
      .bars {
        display: grid;
        grid-template-columns: max-content minmax(0, 1fr) max-content;
        gap: 8px 12px;
        align-items: center;
        margin-top: 16px;
        font-size: 15px;
        font-variant-numeric: tabular-nums;
      }
      .bars .track {
        background: var(--border);
        border-radius: 2px;
      }
      .bars .bar {
        display: block;
        height: 10px;
        min-width: 2px;
        background: var(--fg);
        border-radius: 2px;
      }
      .bars .bar.hi {
        background: var(--accent);
      }
      .delta {
        font-size: 14px;
        color: var(--muted);
      }
      :focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      @media (max-width: 640px) {
        .page {
          padding: 32px 16px 64px;
        }
        h1 {
          font-size: 28px;
        }
      }
      @media print {
        body {
          background: var(--print-bg);
          color: var(--print-fg);
        }
        .page {
          max-width: none;
          padding: 0;
        }
        .no-print {
          display: none;
        }
        h2,
        h3 {
          break-after: avoid;
        }
        p {
          orphans: 2;
          widows: 2;
        }
        tr,
        figure,
        .card {
          break-inside: avoid;
        }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <p class="eyebrow">Kind of document</p>
      <h1>Title</h1>
      <p class="lede">What this is and what the reader should take from it.</p>
    </main>
  </body>
</html>
```

## Type

- Use at most six sizes on a page and three weights: 400 for reading, 500 for labels, 600 for headings. Skip 700 and above.
- Each screen has one dominant element and at most three visible levels. Neighbouring levels differ by a clear step in size or weight.
- Keep prose lines at 50 to 75 characters. Tables and code may run wider.
- Bold at most two phrases in 400 words of prose, and never to label a section.
- Text in capitals needs `letter-spacing` of 0.06em to 0.1em. Latin headings of 32px or more take -0.01em to -0.02em.
- Chinese, Japanese and Korean text takes no negative letter-spacing, heading line-height of 1.3 to 1.4 and body line-height of 1.7 to 1.8. Set these on the element that holds that script, and set `lang` on `<html>`.
- Never justify text. Write headings in sentence case.
- Join a number to its unit with `&nbsp;`, and give compared numbers the same count of decimals.

## Colour

- Neutral tokens carry almost the whole page. Use `--accent` in at most two places a screen, such as the active item and one figure. Links stay the text colour with an underline.
- `--good`, `--warn` and `--bad` mark a state and always sit beside a word that names it.
- Write every colour as a token. A hex value outside `:root` is a mistake, and so is a second accent.
- Body text needs a contrast of 4.5 to 1 with its background. Text of 24px, or 18.5px in bold, and control borders need 3 to 1; the base uses `--control` for those and keeps `--border` for hairlines between sections. Check a changed token in both themes.
- No gradients, glows or shadows as decoration. A hairline border or space separates sections.

## Layout

- Lead with the answer: title, a one-line summary, then status, owner and date. A reader who stops after the first screen still has the point.
- When one thing needs the reader's action, such as a blocker or an overdue item, it comes straight after the summary in a `.note.warn`. Use that block at most once on a page.
- A page with wide tables uses `<main class="page wide">`. Prose pages keep the narrow column.
- Use one `h1`, never skip a heading level, and mark regions with `<header>`, `<main>`, `<nav>` and `<footer>`.
- Space shows grouping: 8 to 12px inside a group and 32 to 48px between groups. Take spacing between and inside sections from 4, 8, 12, 16, 24, 32, 48, 64 and 96px.
- Separate with space first and a border second. A card sets one thing apart; when every section is a card, none stands out. Do not put a card inside a card, and do not give a card a coloured stripe on one side.
- Structure carries meaning. Number items only when their order matters, and add a label, divider or eyebrow only where it tells the reader something.
- Shape a section to its content: dated phases as a row of dated steps, a few headline numbers as a short list of label and value pairs, comparable values as a table.
- Put comparable values in a table, with numbers right-aligned in `td.num` and the unit in the header. Wrap every table in `.scroll`.
- Check the page at 375px wide in the source: grids collapse to one column and nothing sets a fixed width above that.
- A `<details>` element hides secondary material without a script.
- Before finishing, remove one decorative element. Keep one memorable choice and leave the rest quiet.

## Figures

- A headline figure in `.figure` also appears in a table on the page, so the reader can see where it comes from.
- State a change with its direction, its amount and the period it is compared with, in `.delta` beside the figure.
- Compare a few values with `.bars`: a label, a `.track` holding a `.bar` whose `style="width: N%"` is the value's share of the largest value, then the number. Mark at most one bar `hi`.
- Do not draw a chart in a page. Show a comparison with `.bars` and the numbers in a table.

## Content

- Every number, name, date and quotation comes from the owner or a checked source. Leave out a section that has no real content. Never add sample text, an invented metric or a placeholder image. A sentence that joins supplied facts adds no cause, consequence or condition of its own. When you write requirements or explanations the owner did not supply, say which in the message that shares the page.
- Write a date as the owner or the source gave it. Never add a year, a weekday or a time that was not given, even when you can work it out.
- Where a value is missing, write what is missing in the cell, such as "Not stated". Never leave a blank cell or a dash.
- No emoji as icons. Use a word, or an inline SVG line icon drawn with `currentColor`.
- Write the page in the owner's language.

## Check before sharing

Run `rg -n -i "https?://[^\"' <]+\.(css|js|woff2?|png|jpe?g|gif|svg|webp)|<link |<script[^>]+src=|<form|href=\"#|localStorage|sessionStorage|scrollIntoView|linear-gradient|border-left:[^;]*solid|transition: *all|lorem ipsum|#6366f1|#4f46e5|#8b5cf6|#7c3aed|#a855f7" FILE`. Any match is a defect except an address printed as visible text. Then read the file once as the reader would: the title, the summary and every table header make sense without the chat. The message that shares the page says what it is in one or two sentences. After that, add at most three notes of one short sentence each, and only for something you assumed, reworded or left out that changes how the owner should read the page. Do not list every missing field: the page already marks them. Never restate what the page says, list its sections or offer further changes. The workspace has no browser, so say that you checked the source and did not see the rendered page when the owner asks whether it looks right.

For a specification, a runbook, a reference page, a weekly update or meeting notes, read [page-layouts.md](page-layouts.md).
