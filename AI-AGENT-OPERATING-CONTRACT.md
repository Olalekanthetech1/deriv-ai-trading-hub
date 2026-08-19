# AI Agent Operating Contract

## Purpose

This document is the repository-wide, platform-neutral companion to `AGENTS.md`. It establishes the persistent operating contract for **every AI coding agent or AI-assisted development environment** working on this repository, regardless of vendor, IDE, platform, runtime, or future tooling.

Examples include, but are not limited to, AI Studio, Replit, Claude, Gemini, GitHub Copilot, Cursor, Codex, IDE agents, autonomous coding agents, CI automation, and future AI platforms.

`AGENTS.md` remains the primary engineering authority. This contract is the common cross-platform enforcement layer and must not be interpreted as belonging to any single AI provider.

## Mandatory Authority Rule

Every AI agent operating on this repository MUST read the current `AGENTS.md` before performing implementation, debugging, refactoring, configuration, database, infrastructure, AI/ML, trading, testing, deployment, or documentation work.

The rules in `AGENTS.md` remain applicable across future tasks, sessions, tools, platforms, and conversations. A user request such as `proceed`, `continue`, `fix it`, `rewrite it`, `optimize it`, or `make it work` does not override those rules.

If another instruction conflicts with `AGENTS.md`, the agent MUST preserve the repository's safety, security, data-integrity, verification, and change-discipline requirements and must not use the conflict as justification to bypass them.

No platform-specific instruction file may replace, weaken, or supersede this contract or `AGENTS.md`.

## Mandatory Pre-Task Procedure

Before modifying the repository, every AI agent MUST:

1. Read `AGENTS.md`.
2. Read this operating contract.
3. Inspect the current Git branch and workspace state.
4. Inspect existing changes before touching files.
5. Identify the exact subsystem affected by the request.
6. Search for existing implementations before creating new ones.
7. Identify dependencies, side effects, data-flow boundaries, and security implications.
8. Determine the smallest safe implementation that satisfies the request.

The agent MUST NOT guess the existence, behavior, ownership, schema, API contract, configuration, or runtime state of any project component.

## Dynamic-Only Rule

The repository requires production-ready dynamic implementations.

AI agents MUST NOT introduce:

- hard-coded runtime data;
- fabricated market data;
- fabricated ML results;
- synthetic production state presented as real state;
- placeholder implementations;
- dummy APIs;
- fake datasets;
- client-side replicas of authoritative server state;
- silent fallback values for execution-critical trading or ML decisions.

If authoritative data is unavailable, the system MUST expose an explicit unavailable, pending, blocked, or failed state instead of inventing a value.

## Security and Trading Safety

AI agents MUST preserve server-side authorization, input validation, secret isolation, trading safeguards, model lifecycle gates, and production isolation.

No agent may:

- expose secrets;
- bypass authentication or authorization;
- weaken risk controls;
- bypass model validation or promotion gates;
- fabricate broker capabilities;
- represent cached, simulated, fallback, or synthetic market data as live data;
- enable live trading merely to make a test pass.

## Targeted Change Discipline

Every modification MUST have a direct relationship to the requested task or its proven root cause.

Agents MUST NOT perform speculative refactors, unrelated cleanup, dependency upgrades, framework changes, destructive database operations, or architecture replacements while solving an isolated issue.

When a new structurally unrelated failure appears during verification, the agent MUST stop at the subsystem boundary and report it rather than chasing the tangent.

## Verification Is Mandatory

No task may be declared complete without concrete verification appropriate to the change.

The agent MUST report:

- what was changed;
- what was actually verified;
- the commands/tests/checks used;
- the result of each relevant verification;
- remaining failures or limitations;
- what is verified versus merely reasoned about.

The agent MUST NOT claim `fixed`, `working`, `complete`, `verified`, `production-ready`, or `deployed` without evidence.

## Git Integrity

Existing user work is protected.

Agents MUST NOT discard, reset, stash, revert, overwrite, force-push, or rewrite pre-existing work without explicit authorization.

Before commit or push operations, the complete diff and scope MUST be reviewed. No unrelated changes may be included.

## Model Lifecycle Integrity

AI/ML lifecycle stages remain authoritative:

`Training → Evaluation → Validation → Candidate → Promotion → Production`

Training completion is not validation. Missing validation evidence is not success. Agents MUST NOT fabricate metrics, alter lifecycle state merely to satisfy a UI, or bypass promotion gates.

## Cross-Platform Instruction Rule

The repository may contain optional platform-specific bridge files so individual tools can discover this contract. Those bridge files are adapters only.

They MUST:

- point back to `AGENTS.md` and this contract;
- preserve the same engineering rules;
- never contain weaker substitute rules;
- never create platform-specific exceptions;
- never become the project's source of truth.

If the project is moved from one platform to another, the repository's engineering behavior MUST remain unchanged because `AGENTS.md` and this contract travel with the repository.

Future platforms that do not recognize a platform-specific bridge MUST still be governed by `AGENTS.md` and this contract when they inspect repository instructions.

## Scope and Ambiguity

If the agent lacks sufficient context to make a change dynamically and safely, it MUST inspect further or ask for clarification rather than implementing a simplified workaround.

## Future-Project Portability

This contract is intentionally reusable across domains and development platforms. Universal engineering requirements remain applicable while domain-specific requirements in `AGENTS.md` govern the current application.

## Final Rule

The objective is not merely to make code compile. Every AI agent must preserve the repository's architecture, security, data integrity, dynamic behavior, observability, maintainability, and verification discipline while making the smallest justified change.
