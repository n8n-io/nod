# Empty-key onboarding fixture

Frozen at 2026-10-02 00:21:30 UTC. Case `U03H.v1`: isolated empty-key onboarding, with OpenAI as the base and Anthropic as the held-out provider. The application source is not changed for this evaluation.

Status: historical and stale for the current release. The recorded hashes bind an earlier uncommitted two-step onboarding snapshot, not the current PR. Keep its original score and inputs as history; the current guided wizard has a different sequence and is evaluated under [U03.v3](guided-onboarding.md#u03v3--detected-defaults-and-a-return-notification) and the committed renderer regressions. No current-release acceptance is inferred from this PASS.

## Method and fixed inputs

Run the actual `desktop/ui/index.html` and `desktop/ui/setup.js` in a disposable JSDOM renderer, connected to the actual native settings store on a temporary disk path. Encryption uses the existing synthetic AES-GCM adapter; provider validation performs no network request. The prepare bridge records calls and reads the committed store, without starting an engine or model.

| Variant | Provider  | User-input key                       | Launch at login | Notifications |
| ------- | --------- | ------------------------------------ | --------------- | ------------- |
| Base    | OpenAI    | `synthetic-onboarding-openai-key`    | true            | false         |
| Holdout | Anthropic | `synthetic-onboarding-anthropic-key` | false           | true          |

For each variant, submit first with an empty key and then with whitespace only. Enter the synthetic key through the correct provider input, continue to preferences, select the stated choices, trigger an unrelated native theme update, use Back, return to preferences, and complete onboarding. Expected answers remain in the evaluator assertions; the renderer receives only normal bridge data and simulated user input.

## Frozen checks

- C1: Empty and whitespace-only key submissions do not save, advance, or call prepare.
- C2: A synthetic key reaches the store under the selected provider's field, advances to preferences, and does not start the engine early.
- C3: Login and notification choices survive a native theme update and Back navigation.
- C4: Completion persists both choices and `onboardingCompleted` before exactly one prepare call.
- C5: A separately reopened store retains the selected provider and key; the other provider remains empty and the key is encrypted on disk.

Each variant is bounded to ten seconds. No UI wording or CSS assertions, live provider call, model request, real key, normal profile, native window, or OS keychain is involved. This fixture cannot pass the installed native replay or Keychain acceptance gates.

## Result

PASS for both frozen variants and all five checks, without application-source changes or revised answers. OpenAI completed in 638.864666 ms and Anthropic in 35.105042 ms; Node reported 990.399167 ms overall. The timestamps below bound the log-producing invocation.

```json
{
  "result": "PASS",
  "variants": "2/2",
  "checks": {
    "base": {
      "C1": "pass",
      "C2": "pass",
      "C3": "pass",
      "C4": "pass",
      "C5": "pass"
    },
    "holdout": {
      "C1": "pass",
      "C2": "pass",
      "C3": "pass",
      "C4": "pass",
      "C5": "pass"
    }
  },
  "logCreatedAt": "2026-10-02T00:22:40.532Z",
  "logCompletedAt": "2026-10-02T00:22:41.822Z",
  "inputSha256": "71425942db4c34a67e9f178572d63566ea7ac923e859a67e72a15f6aa72ff58f",
  "testBlockSha256": "dfad8575b4a075e59703e1b51f34879a5d6150ee1cf95ecac801220874e96a4e",
  "sourceSha256": {
    "desktop/ui/index.html": "c627b01677346ed34493e69e136265b4ae5665699b61945426de8bf5f2257c5a",
    "desktop/ui/setup.js": "cc23f494cbc70fb541204b6a1ef3c8b36ba5cc04eabab45a7aad45c34bbe0aaf",
    "desktop/main/settings.mjs": "ff31bd1e70e87ab45a5ec2fc59c1c5570626780874936933bf6f7572394dfa94",
    "desktop/test/settings.test.mjs": "5c27bb017d69d929075dff49ed3ce0589bb80975010d0c9e00c2f103efefc5fa"
  },
  "logSha256": "1a4cd06f33af62dec0a5532df5e6368b2ee317a5dea38fce84435d3b0c648178",
  "relatedLogSha256": "bf74c47752f1dc60264d6dc58cbdd122a12069b97ca6226b8f30fec3ebe70bf5",
  "modelCalls": 0,
  "networkCalls": 0
}
```

Base/holdout log: `/tmp/otto-onboarding-fixture-20261002.log`. Related renderer regressions: `/tmp/otto-onboarding-regressions-20261002.log`. Input hash covers compact JSON in base/holdout order with the fields shown above; test-block hash covers the exact formatted declaration through the end of the test file.

This is controlled renderer/store contract evidence. Installed native replay, macOS Keychain approval, OS notifications, and live model/provider access are not established by it.
