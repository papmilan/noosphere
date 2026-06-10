# Noosphere universal agent protocol

This protocol is vendor-neutral. It works through files, commands, HTTP, or
MCP. An agent does not need a Noosphere-specific SDK.

## Start

1. Read `.noosphere/context.md`.
2. Read `.noosphere/journal.md`.
3. Inspect the current working tree.

## During work

After a material finding, decision, failed approach, or plan change, append a
concise entry to `.noosphere/journal.md`:

- conclusion;
- evidence or affected files;
- what was attempted;
- next step or verification needed.

Do not reveal or request hidden chain-of-thought. Store a brief public
rationale that another engineer can verify.

## Before stopping

Append a handoff entry with completed work, unresolved issues, tests, and the
next recommended action.

## Universal interfaces

- File context: `.noosphere/context.md`
- Work journal: `.noosphere/journal.md`
- CLI context: `noosphere context`
- CLI recall: `noosphere recall "query"`
- CLI remember: `printf '%s' "note" | noosphere remember --agent my-agent`
- CLI journal: `noosphere journal --agent my-agent "finding"`
- HTTP bootstrap: `GET /v1/projects/noosphere/bootstrap`
- HTTP remember: `POST /v1/actions`
- HTTP recall: `POST /v1/projects/noosphere/recall`
- MCP namespace: `noosphere-noosphere`
