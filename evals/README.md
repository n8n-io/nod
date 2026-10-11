# Otto capability evals

Runs real tasks against the real Otto harness, with a real model and a fake outside world, and reports how often Otto gets them right. They call live models and cost money; unit tests never run them.

Read [Capability evals](https://n8n-io.github.io/otto/contribute/evals/) for how scoring works, the CI workflow, the verdict rules and the scenario list.

```sh
pnpm run eval:capability doctor --fix   # check Docker, images, database and keys
pnpm run eval:capability run --tier pr --repeat 1
pnpm run eval:capability help
```
