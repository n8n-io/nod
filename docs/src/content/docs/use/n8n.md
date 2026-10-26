---
title: Build with n8n
description: Ask Nod to build, test, fix and publish n8n workflows and n8n Agents in your own n8n.
sidebar:
  order: 9
---

Connect your n8n once, then ask for it by name in chat, such as "build an n8n workflow that…". Follow-ups on a workflow already in the conversation, such as "Publish it", count too. Without n8n in the request, Nod uses its own [tasks and schedules](/use/tasks/). Nod builds the workflow in your n8n, tests it with sample data and shows you the result.

## Connect

Open **Apps** and select **Connect** on n8n. If n8n responds at `http://localhost:5678` from Nod's server, the address is already filled in. Otherwise enter an address that server can reach, such as `https://you.app.n8n.cloud`, then approve Nod on n8n's own consent page. See [Connect n8n](/connect/mcp-api-cli/#n8n) for access tokens and self-hosted addresses.

## What to ask

| You say                                                                  | Nod                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| "Every weekday at 8, post Berlin's weather to Slack if rain is expected" | Builds the workflow, tests both paths and leaves it as a draft                       |
| "Why did my invoice workflow fail last night?"                           | Reads the failed execution, finds the step that caused it and fixes that step        |
| "Add a Telegram alert to my order workflow"                              | Changes the existing workflow in place and tests the new path                        |
| "Export last month's form answers to a sheet, once"                      | Builds a one-off workflow and, when you say yes, runs it and reads back what changed |
| "Make me a support assistant that answers from our help center"          | Builds an n8n Agent with the tools and channel you name                              |
| "Publish it"                                                             | Publishes the workflow and gives you its live address                                |

Nod asks first only when a choice changes what it builds, such as where the result should go. It never asks for IDs or credential names: it uses what you said and leaves the rest for setup in n8n.

## How Nod builds and tests

1. Nod follows n8n's own guide for its MCP tools and reads the node definitions from your n8n.
2. It writes the workflow as code in its workspace, checks it with n8n and creates it in your n8n.
3. It tests the workflow with sample data. n8n replaces the steps that call another service, such as Slack or an HTTP request, with that sample data, and runs the rest, so Nod checks what each replaced step would have sent. A test or run you didn't ask for goes through the [trust check](/trust/approvals/) first.

The reply shows the workflow as a canvas you can open in the side panel, with **Open in n8n** to jump to the editor. On Telegram, which can't show the canvas, Nod sends a picture of the workflow instead. Nod says which paths it tested and which it could not, and what you still need to do, such as adding credentials.

## Before it runs for real

A built workflow is a draft until you ask Nod to publish it. Nod never creates or reads credentials: n8n asks you for them during setup. Each action in n8n goes through the [trust check](/trust/approvals/), so Nod asks you first before anything you didn't ask for, such as a live run.
