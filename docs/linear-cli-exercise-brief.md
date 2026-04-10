# Linear CLI Exercise Brief

> Status: Historical background. This brief describes the design exercise that produced the current document set; use the requirements, spec, Round 2 decisions, implementation handoff, and skill-suite documents as the implementation sources of truth.

## Problem statement

The current Linear MCP approach works, including with multiple accounts, but the preferred operating pattern is shifting toward local command line tools paired with explicit skills. Linear does not currently provide a first-party CLI with full API parity, so this exercise exists to design one.

## What the exercise must produce

The exercise must produce a document set that is good enough to hand to an implementation agent or engineer without requiring them to rediscover the key design decisions.

That document set must include:

- a definition of parity that is realistic for a GraphQL API
- a proposed CLI architecture and repo layout
- command taxonomy and UX rules
- auth and secret-handling guidance
- scripting and AI-agent usage guidance
- a skill suite proposal with triggers and examples
- a phased implementation plan

## Core design tension

The CLI should feel ergonomic and high-level for common operations, but it cannot afford to lose API coverage. The design therefore needs to resolve the tension between:

- discoverable, human-friendly commands
- reliable machine-usable JSON contracts
- durable parity with a changing GraphQL schema
- support for multiple accounts and auth modes
- compatibility with AI skill-driven workflows

## Suggested thesis to pressure-test

The strongest likely design is a hybrid model:

- hand-authored top-level command groups for common resources and workflows
- schema-driven generated subcommands or operation adapters for broad coverage
- a raw GraphQL escape hatch for immediate parity on day one
- shared output, auth, transport, retry, and pagination layers used by every command

This thesis should be challenged, not assumed.

## Minimum questions the exercise must answer

1. What does "full parity" mean when the upstream API is GraphQL and evolves continuously?
2. Should the CLI be generated from introspection at build time, at runtime, or partially both?
3. How should users select between multiple accounts, workspaces, or auth contexts?
4. What output contract should be considered stable for scripts and skills?
5. How should pagination and filtering be exposed without forcing users to write raw GraphQL for common tasks?
6. What is the smallest acceptable raw-query escape hatch?
7. How should uploads, signed URLs, and authenticated file downloads work?
8. How should the skills decide between using the purpose-built CLI commands versus the raw GraphQL fallback?
9. How should the system handle deprecations and schema drift without constant manual maintenance?
10. What must be implemented first to make the tool actually usable early?

## Expected reviewer stance for Claude

Claude should pressure-test:

- hidden parity gaps
- poor naming or leaky abstractions
- agent-unfriendly output formats
- unsafe auth defaults
- multi-account edge cases
- cases where the proposal silently depends on implementation heroics
- missing treatment of rate limits, retries, and deprecations

## Exercise constraints

- Prefer documents that can survive implementation handoff with minimal context loss.
- Prefer concrete interfaces and examples over vague recommendations.
- Distinguish required MVP capabilities from later nice-to-haves.
- Treat official Linear docs and schema behavior as the source of truth.
- Do not let the proposal depend on MCP access.
