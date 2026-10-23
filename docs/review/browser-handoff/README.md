# Browser handoff

The browser action `handoff` opens the page for the user and pauses its task. A link in a message does not control handoff.

These captures use the actual message and browser components. The website, task, frames, and API responses are synthetic. No account, model, or recipient was used.

| State                                     | Capture                              |
| ----------------------------------------- | ------------------------------------ |
| Main, with a recorded handoff and no link | [Before](before-light.png)           |
| Explicit handoff, desktop                 | [After](live-light.png)              |
| Desktop, dark theme                       | [Dark](live-dark.png)                |
| Phone width                               | [Narrow](live-narrow.png)            |
| Disconnected view                         | [Reconnect](disconnected-narrow.png) |
| Input failure                             | [Failure](input-failure.png)         |
| Input timeout                             | [Timeout](input-timeout.png)         |

The baseline source is `05d0ce92`. Both versions use the same task and message. The after captures use the source in this PR.

The Chrome check covers loading, live control, an enlarged view, return control, disconnection, input failure, and input timeout. It checks both themes and a 390-pixel viewport. No page errors or horizontal overflow occurred. A failed input ran once. Return control waited for pending input and sent one handback request. After an input timeout, the button became available again and the user could return control without repeating the input.

[Capture results](checks.json) record the viewports and checks. These captures do not prove a live website sign-in or an installed desktop app flow.

The runtime tests cover the explicit action, a missing page, page error details, a failed browser hold, session binding, and refusal for subagents. The browser test checks that an input timeout does not block handback or repeat input. Channel tests use the real Telegram and WhatsApp adapters with network fixtures. The thread test checks that handback keeps the session and original channel and runs once.
