# Native startup investigation

Checked: 2026-10-02. Scope: one bounded, read-only check of official Lima GitHub/releases/documentation and Apple sources. No binary download, runtime change, VM reset, automatic retry, or packaged-app modification was made.

## Conclusion

**The cause is unknown. No directly matching upstream report or documented safe fix was found.** The exception occurred in the native VM startup path; that location does not establish whether the defect belongs to Lima, its bindings, Apple, or an interaction between them. One successful manual retry demonstrates recovery on this occasion, not reliable startup or a permanent fix.

Retain the pinned Lima 2.2.0 and current VM configuration for this preview. There is no source-backed reason from this check to replace it with a beta, change virtualization drivers, change entitlements, reset the VM, or alter the guest bootloader.

## Observed evidence

| Item             | Observation                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Host             | Apple Silicon, macOS 26.6.2 (25G83)                                                                                                    |
| Runtime          | Lima 2.2.0, VZ driver, aarch64 Ubuntu guest                                                                                            |
| Signed app       | CDHash `ce253f259f767ed768dc78be73c1138dfd569011`                                                                                      |
| Runtime release  | `5a81d8dada03b68ec197bbba1634c7d8341c016a31954191a60423afb16c0fbe`                                                                     |
| Failure          | 2026-10-02 00:15:24 UTC, before Linux boot                                                                                             |
| Native exception | `NSInvalidArgumentException`: `-[VZGenericPlatformConfiguration _bootLoaderForConfiguration:]: unrecognized selector sent to instance` |
| Recovery         | One user-triggered **Try again**; VZ entered running at 00:16:37 UTC and Lima completed its boot requirements at 00:16:46 UTC          |
| Following health | Private PostgreSQL, workspace, and corrected browser containers were running                                                           |

The new cache's Lima executable was byte-identical to the previously working cache: SHA-256 `f19a4fca3875e1017a5285672be4a62699c1e55918fb6a7afce86a14199e10d9`. Its code signature verified, and its `com.apple.security.virtualization` entitlement was present. The VM configuration retained its expected single read-only runtime-assets mount. These checks exclude the observed executable-content mismatch and missing-entitlement hypotheses; they do not prove the rest of the native integration correct.

The host log supplied the native exception. The later retry replaced that attempt's current log; the bounded exception and timestamps above preserve the observation. This incident is separate from the earlier browser-container packaging failure and the later macOS Keychain approval gate. None of these observations establish live model or assistant-task acceptance.

## Upstream check

| Official source                                                                                                   | Finding and applicability                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Lima 2.2.0 release](https://github.com/lima-vm/lima/releases/tag/v2.2.0)                                         | Marked Latest when checked. Its macOS/VZ notes do not document this selector exception or a corresponding fix.                                                                                                                     |
| [Lima 2.3.0-beta.0 release](https://github.com/lima-vm/lima/releases/tag/v2.3.0-beta.0)                           | Marked Pre-release. Its published notes do not identify a matching correction. This is insufficient evidence to upgrade the preview to it.                                                                                         |
| [Lima VZ documentation](https://lima-vm.io/docs/config/vmtype/vz/)                                                | VZ is supported on macOS 13+ and uses Apple's Virtualization framework. Listed caveats concern architecture, legacy BIOS, and serial kernel logging; no matching startup exception is described.                                   |
| [Lima FAQ](https://lima-vm.io/docs/faq/)                                                                          | The VZ-specific workaround concerns stalled Rosetta installation. It does not match this native exception. The general debugging guidance supports collecting startup and guest logs rather than applying an unrelated workaround. |
| [Lima issue/PR search: exact selector](https://github.com/lima-vm/lima/issues?q=%22bootLoaderForConfiguration%22) | GitHub returned HTTP 200, zero results, and `incomplete_results: false`.                                                                                                                                                           |
| [Lima issue/PR search: exception wording](https://github.com/lima-vm/lima/issues?q=%22unrecognized%20selector%22) | GitHub returned HTTP 200, zero results, and `incomplete_results: false`.                                                                                                                                                           |
| [Lima issue/PR search: class name](https://github.com/lima-vm/lima/issues?q=%22VZGenericPlatformConfiguration%22) | Two results: [#2824](https://github.com/lima-vm/lima/issues/2824) and [#22](https://github.com/lima-vm/lima/issues/22), both about nested virtualization. Their reported subject does not match this crash.                        |

Exact-selector searches restricted to Apple's developer site also produced no direct match. The [Apple Virtualization forum](https://developer.apple.com/forums/tags/virtualization) surfaced a different macOS-guest VM-limit report; its error and guest type differ, so it was not used to infer a fix. Search coverage is bounded and may omit unindexed, private, or differently worded reports. Absence from these results is not evidence that no upstream defect exists.

## Follow-up recommendation

Keep the failed startup in the evaluation record and keep manual **Try again** available. Do not add blind retries on the basis of one recovery. Before calling desktop startup dependable, run a separate lifecycle acceptance batch covering cold launch, ordinary quit/reopen, and sleep/wake; record every failure and preserve the original native log before another start overwrites it.

If the exception recurs, capture a sanitized crash report, exact macOS build, Lima version/hash, minimal VM configuration, and reproducibility steps. Use a disposable VM for subsequent comparative tests. Evaluate a release or configuration change only against a documented matching fix or a reproducible failing case, preserving the normal profile and its data. Opening an upstream issue would be a separate authorized action; none was sent here.
