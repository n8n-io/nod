# Nod capability evals

Runs real tasks against the real Nod harness, with a real model, fake apps and lookalike websites, and reports how often Nod gets them right. Pi's `web_search` and `fetch_content` tools run on the server and still reach the public web. The evals call live models and cost money; unit tests never run them.

Read [Capability evals](../docs/src/content/docs/contribute/evals.mdx) for how scoring works, the CI workflow, the verdict rules, the scenario list and how to write and calibrate a scenario.

```sh
pnpm run eval:capability doctor --fix   # check Docker, images, database and keys
pnpm run eval:capability run --tier pr --repeat 1
pnpm run eval:capability help
```
