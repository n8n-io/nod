---
name: n8n
description: Use when building, changing, testing, debugging, publishing or explaining n8n workflows or n8n Agents in the user's connected n8n instance.
---

# n8n

Work through the connected n8n MCP server. Its tools are named mcp__n8n__<tool>, and its own guide in your context lists the build steps; follow it. Load the tools you need with one tool_search with limit 20, for example "workflow sdk reference best practices search nodes node types explore resources validate create update details pin data test execution publish". For an n8n Agent also search "agent builder reference discover assets create mutate validate call integration publish".

## n8n's official skills

This guide bundles n8n's official skills for agents that use its MCP server (github.com/n8n-io/skills, Apache-2.0). They are n8n's own rules. Trust them over memory, and trust get_node_types over both. Read one with skills read {name: "n8n", file: "official/<skill>/SKILL.md"}, and a reference it names with file "official/<skill>/references/<FILE>.md". Where they say to invoke a skill with the Skill tool, read it this way. Their notes about Claude Code hooks, plugins, CLAUDE.md and harness memory do not apply here.

Read the ones the work needs before you act, and again when the work turns to something new:

| When                                                                      | Read                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Before writing or changing a workflow                                     | n8n-workflow-lifecycle-official, n8n-node-configuration-official, n8n-expressions-official |
| Webhook, API-style or production workflows                                | n8n-error-handling-official                                                                |
| Lists, batching, pagination, "for each"                                   | n8n-loops-official                                                                         |
| AI inside a workflow: AI Agent node, chains, classifiers, extraction, RAG | n8n-ai-nodes-official                                                                      |
| The user wants an agent, assistant or bot, or any Agent tool              | n8n-agents-official                                                                        |
| Credentials, API keys, HTTP Request auth                                  | n8n-credentials-and-security-official                                                      |
| Files, images, attachments                                                | n8n-binary-and-data-official                                                               |
| Data tables, deduplication, state between runs                            | n8n-data-tables-official                                                                   |
| Before adding a Code node                                                 | n8n-code-nodes-official                                                                    |
| Reuse or sub-workflows                                                    | n8n-subworkflows-official                                                                  |
| A failed execution or a wrong result                                      | n8n-debugging-official                                                                     |
| Before testing                                                            | n8n-workflow-lifecycle-official references/TESTING.md                                      |
| Before publishing                                                         | n8n-workflow-lifecycle-official references/VALIDATION_CHECKLIST.md                         |

## Decide what to build

- When the user names an existing workflow or Agent, find it first (search_workflows, get_workflow_details) and change it instead of building another.
- Ask before building only when a missing choice changes what you build: where the data comes from, where the result goes, what starts it, or which content, fields or categories it produces. Ask once, all together, and propose a default for each so a yes is enough. Otherwise build at once and say which defaults you chose.
- Never ask for setup values such as recipients, channel or sheet IDs or credential names. Use the user's exact values. Never ask again for something the user answered, skipped or left to you, and keep every earlier requirement when the user adds or changes one.

## Build loop

1. Read the official skills above, the get_workflow_sdk_reference sections you need and get_workflow_best_practices for each technique. Batch search_nodes queries, then call get_node_types once with every node you will use, including its resource, operation and mode.
2. Write the SDK code to a workspace file such as `n8n/<short-name>.workflow.ts`. Change it with edit; never paste the whole code into a tool call or chat.
3. Validate and create from the file in one codemode script, so the code is never typed twice:

   ```js
   const code = await tools.read({ path: 'n8n/order-alerts.workflow.ts' });
   const check = JSON.parse(await tools.mcp__n8n__validate_workflow({ code }));
   if (!check.valid || check.errors?.length || check.warnings?.length) return check;
   return await tools.mcp__n8n__create_workflow_from_code({
     code,
     name: 'Order alerts',
     description: 'Posts large orders to Slack.',
   });
   ```

   validate_workflow can say valid: true while its warnings name real errors. Fix every error and every warning that is not clearly informational, then validate again.

4. After each create or update, read get_workflow_details and check the saved graph against the request: every IF and Switch branch wired to the right target, Merge inputs in order, AI sub-nodes attached, nothing dropped.
5. Test as TESTING.md says, with pin data shaped like each node's real output from prepare_workflow_pin_data, not like what your next node expects. Run once per meaningful path, such as both sides of an IF, an empty result and an error branch.
6. A pinned node does not run, so the test does not show what it would have sent. Read get_workflow_execution with includeData and, for every pinned node that sends, writes or calls a service, check the items it received: each field its parameters use is there and not empty, and the number of items is what the user asked for.
7. Fix with update_workflow and test again with the same pin data. Change a node in place with updateNodeParameters or setNodeParameter; never remove and re-add it, because that detaches its sub-nodes. Pin a node rather than disable it; if you disabled one, enable it again. After two failed fixes of the same kind, rethink the design.

## Pitfalls the tools do not catch

- A picker (resource locator) the user gave no ID for stays in list mode with an empty value, for the user to choose. Use id mode only for an ID the user gave or you looked up with explore_node_resources; a name such as primary or Sheet1 is not an ID.
- A node that outputs nothing stops everything after it. When the user still expects a result, such as a digest on a quiet day, set alwaysOutputData on that node and handle the empty item.
- A response that wraps its records, such as { data: [...] }, arrives as one item. Split it out before steps that work per record.
- When one failing item should not stop the others, such as several channels, accounts or URLs, set onError to continue on that node and report the failures.
- A polling or scheduled workflow marks or stores what it handled, after handling it, so the next run skips it.
- Choose AI models from a lookup in this conversation: the node's model list through explore_node_resources, or discover_agent_assets for an Agent. Never type a model ID from memory.
- Give every loop that goes back, such as a retry or a revision round, an exit: a counter or a maximum number of rounds. Never test it with pinned data that keeps it looping, because a test runs until it ends.

## Publishing and live triggers

- A built workflow or Agent is a draft. Publish only when the user asks for it to be live.
- After changing a published workflow, publish it again before telling the user to use it, or say plainly that the change is not live yet. Rebuilding a trigger can change its URL; check it again.
- Share the production address from get_workflow_details triggerInfo: webhooks use /webhook/<path>, forms /form/<path>. A non-public chat trigger is tested with the editor's Open chat button.

## Report

Show the saved workflow as a canvas: in codemode, write the workflow from get_workflow_details, with the url create_workflow_from_code returned, to `n8n/<short-name>.n8n.json`, then attach that file with share_file.

```js
const { workflow } = JSON.parse(await tools.mcp__n8n__get_workflow_details({ workflowId }));
await tools.write({
  path: 'n8n/order-alerts.n8n.json',
  content: JSON.stringify({ ...workflow, url }),
});
```

End with one short message: what you built or changed, with its url; what you tested, with which data and paths, each run's result separately and which nodes were pinned; what you could not verify and why; and what the user still has to do, such as creating credentials or publishing. Say a workflow is tested, working or fixed only when an execution exercised that path. If a test or run left data in the user's own systems, say where and offer to remove it.
