# Page layouts

Each layout uses the base and classes from [pages.md](pages.md). Keep the section order. Drop a section that has no real content instead of filling it.

## Specification

For a product spec, feature brief, proposal or design document.

1. Header: eyebrow with the document kind, title, a `.meta` row with a status `.pill` (Draft, In review or Approved), owner and date.
2. Summary as a `.lede` of three sentences: what changes, for whom, and why now.
3. Problem: one paragraph. Add a quotation only when the owner supplied one, in a `.note` with its speaker.
4. Goals and non-goals: `.cols` with two lists. Non-goals name things a reader might expect.
5. Success measures: a table of measure, current value, target and how it is measured.
6. Requirements or user stories: one `<ol>`, each item testable. The list numbers are how a reply cites one, so add no second label.
7. Design: the approach, with the decision and the alternatives that were rejected and why. Use a table when three or more options are compared.
8. Rollout: a table of phase, scope, date and exit condition.
9. Risks: a table of risk, likelihood, effect and mitigation.
10. Open questions: a numbered list, each with the person who answers it.

State an unknown as an open question. Do not turn it into a decision.

## Runbook

For operating a service, a recurring procedure or an incident response.

1. Header: eyebrow, the service or procedure name, a `.meta` row with owner, severity tier and the date last checked.
2. Summary as a `.lede`: what the service does and what breaks when it is down. Then a list of what it depends on.
3. Alerts: a table of alert, severity, meaning and first response.
4. Procedures: one `h3` per procedure, then numbered steps. Each command sits in its own `pre` exactly as it is typed, with the expected result in the sentence after it. Mark a step that cannot be undone with a `.pill.bad` reading Irreversible.
5. Verification: how to confirm the service is healthy again.
6. Escalation: a table of role, person and how to reach them.
7. References: dashboards and documents, each with its address as visible text.

Take commands from the owner's material or a checked source. A command that was not checked is marked as unverified in the step that uses it.

## Reference page

For documentation, a guide, a tutorial or an API reference.

Replace `<main class="page">` with a two-column shell and add these rules to the base:

```html
<style>
  .shell {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 220px;
    gap: 56px;
    max-width: 1080px;
    margin: 0 auto;
    padding: 56px 24px 96px;
  }
  .toc {
    position: sticky;
    top: 32px;
    align-self: start;
    font-size: 14px;
  }
  .toc button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 4px 0;
    border: 0;
    background: none;
    color: var(--muted);
  }
  .toc button:hover {
    color: var(--fg);
  }
  h2,
  h3 {
    scroll-margin-top: 24px;
  }
  @media (max-width: 900px) {
    .shell {
      grid-template-columns: minmax(0, 1fr);
      padding: 32px 16px 64px;
    }
    .toc {
      display: none;
    }
  }
  @media print {
    .toc {
      display: none;
    }
    .shell {
      display: block;
      padding: 0;
    }
  }
</style>
<main class="shell">
  <article>
    <p class="eyebrow">Guide</p>
    <h1>Title</h1>
    <p class="lede">What the reader can do after this page.</p>
    <h2 id="install">Install</h2>
  </article>
  <nav class="toc" aria-label="On this page">
    <p class="eyebrow">On this page</p>
    <button type="button" data-goto="install">Install</button>
  </nav>
</main>
<script>
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-goto]');
    if (b)
      window.scrollTo({
        top:
          document.getElementById(b.dataset.goto).getBoundingClientRect().top + window.scrollY - 24,
        behavior: 'smooth',
      });
  });
</script>
```

- Every `h2` has an `id`, and the contents list has one `data-goto` button for each. Never use an `<a href="#...">` link.
- The file holds one page. Do not add a navigation list for pages that do not exist.
- Order the body as: what it is, prerequisites, the steps or the reference tables, then errors and their fixes.
- Each code sample is complete enough to run, sits in `pre`, and is five to fifteen lines. Describe parameters in a table of name, type, default and meaning.
- Use a `.note` for a warning, with a first word in `strong` that names its kind.

## Weekly update

For progress over a week or a sprint, sent to a team or a manager.

1. Header: eyebrow with the team or project, a title that names the period, a `.meta` row with the author and date.
2. Headline as a `.lede`: one sentence on where things stand, with the one number that matters.
3. Overall status: one `.pill` reading On track, At risk or Off track, with the reason in a sentence.
4. Blocked: each blocker with what is needed, from whom and by when, in the `.note.warn` block. Leave the section out when nothing is blocked.
5. Done: a list of three to five results, each stated as what changed for the reader.
6. In progress: a table of item, owner and expected date.
7. Numbers: a short table or `.bars`, only for measures the owner supplied.
8. Next week: a list of what is planned, each with an owner.

State a result, not an activity: write what shipped or was decided, not that work continued.

## Meeting notes

For a record of a meeting that people will act on.

1. Header: the meeting title, a `.meta` row with date, time and place, then the attendees.
2. Outcome as a `.lede`: what the meeting settled, in one or two sentences.
3. Decisions: a numbered list, each one a full sentence that stands on its own, with who decided when that matters.
4. Actions: a table of action, owner, due date and a status `.pill`. Every action has one named owner. Where no owner or date was given, write "Not assigned" or "No date".
5. Discussion: one `h3` for each topic, with the points made and who made them. Keep it shorter than the decisions and actions.
6. Open questions: a list, each with who will answer it.
7. Next meeting: date and purpose, when one was set.

Keep what was decided apart from what was only discussed. Attribute a statement to a person only when the notes do.
