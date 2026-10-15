## Summary

- Add model-based tests for legal and invalid restore workflow state transitions.
- Add versioned Soroban RPC response fixtures and compatibility tests.
- Add RPC fault-injection tests for timeouts, disconnects, server errors, retry limits, and recovery across RPC stages.
- Add a clean-fixture integration check for packed package exports, TypeScript declarations, and required peer dependencies; run it in CI after the package build.

## Validation

- All 206 issue-specific SDK tests passed.
- Syntax, lint, and formatting checks passed for the changed files.
- The local full package build is blocked by pre-existing SDK build errors, so the packed-export check could not be run locally. GitHub Actions must verify the CI workflows after the branch is pushed.

Closes #547
Closes #548
Closes #549
Closes #550
