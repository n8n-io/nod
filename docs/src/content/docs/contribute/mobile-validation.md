---
title: Validate mobile workflows
description: Run isolated HTTP workflow checks on the host and an iOS simulator without models, accounts, or a database.
sidebar:
  order: 16
---

Use the synthetic fixture to check mobile navigation, addressed replies, and recovery without connecting real services.

:::caution[Fixture coverage, not server safety proof]
These checks use `HttpNodRepository` and `NodClientApp`, but synthetic application routes. They don't prove the full server's Trust decisions, owner-scoped SQL, Vault encryption, or provider dispatch.
:::

## Run host checks

Follow [Try the Flutter client](/contribute/mobile-evaluation/) to install the pinned SDK and dependencies. From the repo root, run:

```sh title="Host-only checks"
results="$(mktemp -d /tmp/nod-parity-host.XXXXXX)"
(
  cd clients/flutter &&
    flutter analyze integration_test &&
    flutter test integration_test/recovery_validation_test.dart \
      -d flutter-tester --reporter expanded
) > "$results/host.log" 2>&1
printf 'Host log: %s/host.log\n' "$results"
```

The host tests create fresh temporary fixture directories, start loopback Node subprocesses, and remove their state on completion. No Docker, normal database, real account, model, or recipient is used. The recorder channel is replaced on the host; this isn't native plugin evidence.

The workflow test uses a 430 × 932 phone viewport. Check compact desktop layouts separately; a passing phone scenario doesn't prove desktop navigation fits.

## Run the native scenario

Serialize native builds: run only one Xcode or Flutter native check at a time. Use an iOS simulator, not a physical phone. The native test uses real plugins and in-memory credentials.

In Terminal A, from the repo root, start the fixture. Port 18765 must be free. Never stop another installation to free it.

```sh title="Terminal A: fresh synthetic fixture"
(
  fixture_dir="$(mktemp -d /tmp/nod-native-parity.XXXXXX)" || exit 1
  trap 'rm -rf "$fixture_dir"' EXIT
  NOD_VALIDATION_PORT=18765 \
  NOD_VALIDATION_TOKEN=synthetic-native-token \
  NOD_VALIDATION_CONTROL_TOKEN=synthetic-native-control \
  NOD_VALIDATION_DATA="$fixture_dir/state.json" \
    node node_modules/tsx/dist/cli.mjs clients/flutter/tool/validation_server.ts
)
```

Wait for `{"ready":true}`. In Terminal B, replace `<simulator-id>` with an ID from `flutter devices`, then run:

```sh title="Terminal B: serialized iOS check"
results="$(mktemp -d /tmp/nod-native-parity-results.XXXXXX)"
(
  cd clients/flutter &&
    env -u SDKROOT flutter test integration_test/native_recovery_test.dart \
      -d <simulator-id> --reporter expanded \
      --dart-define=NOD_SYNTHETIC_ONLY=true \
      --dart-define=NOD_SYNTHETIC_URL=http://127.0.0.1:18765 \
      --dart-define=NOD_SYNTHETIC_TOKEN=synthetic-native-token \
      --dart-define=NOD_SYNTHETIC_CONTROL_TOKEN=synthetic-native-control
) > "$results/native.log" 2>&1
printf 'Native log: %s/native.log\n' "$results"
```

The tokens above are fixed public test values, not credentials. Never substitute an owner token. The test requires those exact values, loopback HTTP, and the fixture marker `nod-synthetic-validation-v1`.

Stop Terminal A with Ctrl-C after the run. Start it again with a fresh directory before every rerun. If you change the port, change both terminals. Never reuse a Dart build directory from another checkout.

Host checks supply an empty incoming-link source because `flutter-tester` has no platform plugins. The native scenario uses the registered platform link plugin. Its default run does not send operating-system URL events.

For an additional foreground URL-delivery check, add `--dart-define=NOD_SYNTHETIC_LINK_CHECK=true` to the native command. After the integrated workflows, the fixture's control-only `/fixture/parity/inspect` response reports `linkReady: true`. Within one minute, send exactly one URL from the host:

```sh
xcrun simctl openurl 8104BA83-DDBD-494B-95FE-D85292C0A12B nod://open/tasks
```

If iOS asks **Open in “Nod”?**, select **Open** in the simulator. A successful `simctl` command alone only proves that the operating system accepted the URL request, not that Nod received it. An unattended run held at this prompt is not a delivery pass.

The scenario waits for the authenticated synthetic task list and fails if the operating-system event does not reach it. This optional check requires an interactive simulator plus a host watcher or another terminal; it never dispatches an outside action. It covers foreground custom-scheme delivery only, not a cold start, background delivery, physical devices, or verified HTTPS links.

When editing a composer again after unfocusing it, the shared workflow driver taps the field and waits for actual focus before entering text. The pinned Flutter native integration binding can retain its previous editable-state reference after the platform text connection closes. Calling `enterText` alone again can silently send to no current client. The driver then waits for an enabled, stable send control, taps once, and waits for the server dispatch count. It never retries a send to make a test pass.

## What the scenario checks

The native scenario first connects through the connection form, sends once, streams, stops, and recovers history after an interrupted SSE connection. It opens Scheduled and Usage before running the shared workflow driver.

| Workflow            | Observable check                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending choice      | The visible choice sends its exact option ID and message target. Repeating its client ID doesn't dispatch twice.                                                                       |
| Stale question      | New replies to answered and replaced questions receive conflicts without another dispatch.                                                                                             |
| Older task question | Tasks → detail → Show in chat loads the older question through the context endpoint. The next send targets that question and task turn, not the latest chat message.                   |
| Prepared detail     | Removing its synthetic source makes Refresh clear the old draft and source list.                                                                                                       |
| Private entry       | Selecting a synthetic sign-in method submits through the private route. Reopening an expired request exposes no submit control and adds no chat message.                               |
| Settings            | Opening Privacy writes nothing. Canceling usage-sharing consent writes nothing. Confirming writes once; traces remain off. Selecting dark appearance updates the server and app theme. |
| Navigation          | Vault loads its empty state. Apps opens account and channel management.                                                                                                                |

Private entry uses a method choice, not a saved password, verification code, card, payment, or actual website submission. This doesn't validate secret entry, browser handoff frames, or payment settlement.

## Inspect fixture counts

While Terminal A is running, you can read bounded synthetic counters without printing message bodies:

```sh title="Host fixture counters"
curl --fail --silent --show-error -X POST \
  -H 'x-fixture-control: synthetic-native-control' \
  http://127.0.0.1:18765/fixture/parity/inspect
```

The completed native run expects marker `synthetic-parity-v1`, `dispatches: 1`, `taskDispatches: 1`, `refusals: 2`, `privateSubmissions: 1`, and `accountWrites: 2`. It expects three chat sends, `aroundReads` of at least one, `source: false`, `privateStatus: "expired"`, `theme: "dark"`, `usageData: true`, and `traces: false`. The host workflow starts without the native baseline send, so it expects two chat sends.

Counters describe this fixture's state transitions, not real outside actions. Keep run logs and validation artifacts outside the repository. A host pass isn't a native pass; a simulator pass isn't physical-device, Android, live-account, or release-readiness evidence.

## Related resources

- [Try the Flutter client](/contribute/mobile-evaluation/)
- [Checks and tests](/contribute/checks-and-tests/)
- [Trust and Vault](/trust/)
