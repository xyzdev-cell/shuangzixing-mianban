# JimiHub

JimiHub is an OpenAI-compatible proxy for Gemini. It accepts OpenAI-style
`/v1/chat/completions` requests, rotates configured Gemini API keys, and forwards
the request to Google Gemini or Vertex AI.

The original upstream README has been moved to `README_legacy.md`.

## Current Stack

- Node.js 22.6+
- TypeScript
- Express
- SQLite
- Admin UI under `public/admin`

## Commands

```powershell
npm run check
npm run build
npm run test
npm start
```

`npm start` builds the project and runs `dist/src/index.js`.

## Configuration

Runtime configuration is stored in SQLite and managed from the admin UI.

Main admin areas:

- Gemini API key management
- Worker API key management
- Managed Gemini model list
- Pro and Flash quota settings
- Vertex AI configuration
- System settings for pseudo streaming, web search, retry count, and auto test

## Model Tags

Project-local model features use trailing parenthesized tags. These tags are
never sent to the upstream Gemini model URL.

Examples:

```text
gemini-2.5-flash(search)
gemini-2.5-flash(pseudo-stream)
gemini-2.5-flash(search)(pseudo-stream)
gemini-2.5-flash-preview-05-20(non-thinking)
```

Before calling Gemini, the proxy strips trailing `(...)` tags and sends only the
base model ID, for example:

```text
gemini-2.5-flash(search)(pseudo-stream)
-> gemini-2.5-flash
```

Supported tags:

- `(search)`: Adds Gemini `google_search` tool to the request body.
- `(pseudo-stream)`: Sends a non-streaming upstream request and wraps the final
  response as OpenAI SSE when the client requests `stream: true`.
- `(non-thinking)`: Forces `thinkingBudget: 0` for supported Gemini 2.5 Flash
  preview models.

## Search Models

When web search is enabled, the public `/v1/models` endpoint only exposes search
tag variants for models known to support Google Search on the intended tier.

Default search allowlist:

```text
gemini-2.5-flash
gemini-2.5-flash-lite
```

Override with:

```powershell
$env:GEMINI_SEARCH_MODEL_ALLOWLIST = "gemini-2.5-flash,gemini-2.5-flash-lite"
```

## API Surface

OpenAI-compatible endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`

Admin endpoints live under `/api/admin` and require admin authentication.

## Notes

Legacy deployment and usage notes are still available in `README_legacy.md`,
`README_zh.md`, and `doc/`, but this README describes the current TypeScript
code path.
