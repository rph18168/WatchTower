# Domain Docs

This repository uses a single-context layout:

- `GLOSSARY.md` at the repository root.
- `docs/adr/` for architecture decision records.

## Before exploring the codebase

Read the root `GLOSSARY.md` if it exists.
Read ADRs in `docs/adr/` that concern the area being explored.

If these files are absent, proceed silently.
The `/domain-modeling` skill creates them lazily as domain terms
or architecture decisions are resolved.

## Use the glossary's vocabulary

Use defined domain terms in issue titles, proposals, hypotheses,
and test names. Follow the glossary's guidance on avoided synonyms.

If a needed concept is missing, reconsider the term or note the gap
for `/domain-modeling`.

## Surface ADR conflicts

When a proposal contradicts an existing ADR, identify that ADR
and explain why reopening the decision is justified.
