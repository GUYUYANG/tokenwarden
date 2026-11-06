# Contributing

## Good contributions

- A host adapter with documented event mappings.
- A deterministic test for an audit finding.
- A smaller reproduction of a false positive.
- A privacy or installer hardening fix.
- Documentation that separates observed facts from inference.

## Fixtures

Never attach a real full transcript. Replace it with the smallest synthetic JSONL fixture that reproduces the behavior. Remove:

- names and personal paths;
- session identifiers;
- prompts and assistant text not required by the test;
- images;
- tokens, cookies, API keys, and account identifiers.

## Verification

Run:

```bash
npm run verify
```

For a user-visible change, describe:

- the exact action;
- the expected observable result;
- the automated evidence;
- any real runtime verification;
- any remaining uncertainty.

A passing unit test is not proof that an OS-level Hook lifecycle executed.

## Pull requests

Keep changes focused. State the failure mode, the evidence, the smallest fix, and the tests that would fail without it. Do not include private task history in commits, fixtures, issue text, or screenshots.
