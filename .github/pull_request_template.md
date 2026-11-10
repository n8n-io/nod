## Summary

<!-- What changes and why. Add screenshots or a short video for UI changes. -->

## How to test

<!-- Steps a reviewer can follow, with synthetic data. Say which checks you ran. -->

## Related issues

<!-- Link the GitHub issue or Linear ticket. Use "Fixes #123" to close an issue on merge. -->

## Checklist

- [ ] The PR title uses `type: description` or `type(scope): description`, such as `fix(backend): handle a missing session`. The scope is optional. Add `!` before the colon for a breaking change.
- [ ] I reviewed this change and take responsibility for it.
- [ ] I ran checks that match the changed files and behavior, and listed the results above. Documentation and media changes do not need application tests or builds.
- [ ] New tests would catch a real regression ([test policy](https://github.com/n8n-io/nod/blob/main/AGENTS.md#tests)), or none are needed.
- [ ] No keys, credentials, real accounts, private conversations or other people's data in code, tests, fixtures, logs or screenshots.
- [ ] Docs are updated where setup or behaviour changed.
- [ ] Changes to approvals, the trust check, Vault, sign-in, the sandbox or owner isolation are called out in the summary.
