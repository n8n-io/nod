---
name: n8n
description: Use when building, changing, testing, debugging, publishing or explaining n8n workflows or n8n Agents in the user's connected n8n instance.
---

# n8n

Work through the connected n8n MCP server. Its tools are named mcp__n8n__<tool>, and its own guide in your context lists the build steps; follow it. Load the tools you need with one tool_search with limit 20, for example "workflow sdk reference best practices search nodes node types explore resources validate create update details pin data test execution publish". For an n8n Agent also search "agent builder reference create mutate validate call publish".

## Decide what to build

- "Agent", "assistant" or "bot" means a first-class n8n Agent unless the user asks for a workflow or an AI Agent node. A fixed trigger followed by fixed steps is a workflow.
- When the user names an existing workflow or Agent, find it first (search_workflows, get_workflow_details) and change it instead of building another.
- Build as soon as the shape is clear. Ask before building only when a missing choice changes what the workflow is: which service receives the result, what starts it, or a feature that cannot work as asked. Then ask once, all together.
- Never ask for setup values such as recipients, channel or sheet IDs, credential names, folders or time zones. Use the user's exact values. When a credential exists, look IDs up with explore_node_resources. Otherwise use placeholder('what goes here'); never invent addresses, IDs or keys.
- Never ask again for something the user answered, skipped or left to you. Keep every earlier requirement when the user adds or changes one.

## Build loop

1. Read the get_workflow_sdk_reference sections you need, such as patterns, rules and expressions, and get_workflow_best_practices for each technique the request needs. Batch search_nodes queries, then call get_node_types once with every node you will use, including its resource, operation and mode. Use the parameter names and versions it returns, not memory.
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

   validate_workflow can say valid: true while its warnings name real errors, such as a wrong or missing parameter. Fix every error and every warning that is not clearly informational, then validate again. Passing validation is not proof the workflow is right.

4. After each create or update, read get_workflow_details and check the saved graph against the request: every IF and Switch branch wired to the right target, Merge inputs in order, AI sub-nodes attached, nothing dropped.
5. Test with test_workflow. Use prepare_workflow_pin_data for the shapes, and pin realistic data on the trigger and on every node that calls an outside service (credentials, HTTP Request, AI). Run once per meaningful path, such as both sides of an IF, a Switch fallback, an empty result and an error branch. Read get_workflow_execution with includeData and the nodeNames you need, and check that each node produced what the user asked for.
6. Fix with update_workflow and test again. Change a node in place with updateNodeParameters or setNodeParameter; never remove and re-add it, because that detaches its sub-nodes. Keep unrelated nodes, settings, credentials and positions. After two failed fixes of the same kind, rethink the design instead of patching again.

Unpinned nodes run for real in a test: Code, data tables, file and command nodes, sub-workflow calls. Pin any that would change something the user did not ask you to change, or say what you left untested.

## Design defaults

- Prefer dedicated nodes over HTTP Request, and expressions or Edit Fields over Code. Use Code only for logic the other nodes cannot express, and never to call APIs.
- n8n runs a node once per item. Use executeOnce or Aggregate where one call should cover all items, and Split Out or Loop Over Items only when needed.
- Normalize trigger payloads early: webhook data is under $json.body, form fields are top level.
- Keep secrets in credentials, never in parameters or code. Credentials are assigned automatically from the project; list_credentials shows them. When one is missing, keep newCredential('Service account') and tell the user which credential to create. You cannot create or test credentials yourself.
- Remember data across runs with data tables or workflow static data, not memory in a node.
- Give each node a name that says what it does, and group workflows with several stages.

## Publishing and live triggers

- A built workflow is a draft. Publish only when the user asks for it to be live.
- After changing a published workflow, publish it again before telling the user to use it, or say plainly that the change is not live yet. Rebuilding a trigger can change its URL; check it again.
- Share the production address from get_workflow_details triggerInfo: webhooks use /webhook/<path>, forms /form/<path>. A non-public chat trigger is tested with the editor's Open chat button.

## n8n Agents

Call get_agent_builder_reference first, then discover_agent_assets. Create the Agent, apply one mutate_agent change at a time with the latest configHash, and validate_agent. Change only what the user asked and keep the rest of its configuration. Test with one representative call_agent when the request covers running it, and publish only when the user asks.

## Report

Show the saved workflow as a canvas: in codemode, write the workflow from get_workflow_details, with the url create_workflow_from_code returned, to `n8n/<short-name>.n8n.json`, then attach that file with share_file.

```js
const { workflow } = JSON.parse(await tools.mcp__n8n__get_workflow_details({ workflowId }));
await tools.write({
  path: 'n8n/order-alerts.n8n.json',
  content: JSON.stringify({ ...workflow, url }),
});
```

End with one short message: what you built or changed, with the workflow's url; what you tested, with which data and paths; what you could not verify and why; and what the user still has to do, such as creating credentials or publishing. Say a workflow is tested, working or fixed only when an execution exercised that path.
