# Noosphere Integration

Noosphere is vendor-neutral. Any agent that can make an HTTP request can read
shared project memory and submit actions.

## Discover the API

```sh
curl http://localhost:3001/.well-known/noosphere.json
curl http://localhost:3001/openapi.json
```

The OpenAPI document can be imported by tool-calling runtimes and agent
frameworks without a custom SDK.

## Read project memory

Prompt-ready plain text:

```sh
curl -H 'Accept: text/plain' \
  http://localhost:3001/v1/projects/noosphere/context
```

JSON with both formatted context and raw actions:

```sh
curl http://localhost:3001/v1/projects/noosphere/context
```

## Submit an action

`agent_id` is free-form. The optional `provider`, `model`, `client`, and
`metadata` fields preserve provenance without coupling the API to a vendor.

```sh
curl -X POST http://localhost:3001/v1/actions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: session-42-action-7' \
  -d '{
    "project_id": "noosphere",
    "agent_id": "my-agent",
    "provider": "any-provider",
    "model": "any-model",
    "client": "my-runtime",
    "genome_object_id": "demo-genome-my-agent",
    "action_type": "decision",
    "content": "Selected the shared schema for cross-agent memory.",
    "session_id": "session-42",
    "metadata": {
      "tool": "code-editor",
      "task": "architecture"
    }
  }'
```

Existing `/action`, `/context/:project_id`, and `/agents/:project_id` routes
remain supported for backward compatibility.
