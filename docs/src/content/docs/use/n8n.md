---
title: Build with n8n
description: Ask Otto to build, test, fix and publish n8n workflows and n8n Agents in your own n8n.
sidebar:
  order: 9
---

Connect your n8n once, then describe what you want in chat. Otto builds the workflow in your n8n, tests it with sample data and shows you the result.

## Connect

Open **Apps** and select **Connect** on n8n. If n8n runs on this computer, the address is already filled in. Otherwise enter yours, such as `https://you.app.n8n.cloud`, then approve Otto on n8n's own consent page. See [Connect n8n](/connect/mcp-api-cli/#n8n) for access tokens and self-hosted addresses.

## What to ask

| You say                                                                  | Otto                                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| "Every weekday at 8, post Berlin's weather to Slack if rain is expected" | Builds the workflow, tests both paths and leaves it as a draft                       |
| "Why did my invoice workflow fail last night?"                           | Reads the failed execution, finds the step that caused it and fixes that step        |
| "Add a Telegram alert to my order workflow"                              | Changes the existing workflow in place and tests the new path                        |
| "Export last month's form answers to a sheet, once"                      | Builds a one-off workflow and, when you say yes, runs it and reads back what changed |
| "Make me a support assistant that answers from our help center"          | Builds an n8n Agent with the tools and channel you name                              |
| "Publish it"                                                             | Publishes the workflow and gives you its live address                                |

Otto asks first only when a choice changes what it builds, such as where the result should go. It never asks for IDs or credential names: it uses what you said and leaves the rest for setup in n8n.

## How Otto builds and tests

1. Otto follows n8n's own guide for its MCP tools and reads the node definitions from your n8n.
2. It writes the workflow as code in its workspace, checks it with n8n and creates it in your n8n.
3. It tests the workflow with sample data. A test never runs the steps that send or write to another service, so Otto checks what each of those steps would have sent instead.

The reply shows the workflow as a canvas you can open in the side panel, with **Open in n8n** to jump to the editor. Otto says which paths it tested and which it could not, and what you still need to do, such as adding credentials.

## Before it runs for real

A built workflow is a draft until you ask Otto to publish it. Otto never creates or reads credentials: n8n asks you for them during setup. Each action in n8n goes through the [trust check](/trust/approvals/), so Otto asks you first before anything you didn't ask for, such as a live run.
