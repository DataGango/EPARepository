# Print Desk

A dependency-free, local-first print job planner with an assistant, a persistent queue and manual status tracking. Built with Node.js 24 and vanilla HTML/CSS/JavaScript.

**This MVP does not upload documents, connect to printers or print anything.** A document name is only a description. All status changes are made by you.

## Run

Install Node.js 24 or newer, then:

```sh
npm start
```

Open **http://127.0.0.1:3000**. No dependency installation or build is needed.

```sh
npm run check
npm test
```

Tests use isolated disposable directories inside the repository and clean them up. They exercise the API, persistence, validation, security, local parser and mocked provider requests without calling OpenAI.

## Using the app

1. Fill in the manual form, or ask the assistant for an editable draft.
2. Review the document name, copies, pages per copy, color, paper and sides.
3. Explicitly choose **Add to queue** to create the job.
4. Start processing a queued job, then mark it completed; cancel queued or processing jobs when needed.

The queue includes status filters, counts and a refresh button. Completed and cancelled jobs are terminal: they cannot be edited, reopened or moved to another status.

### Assistant modes

**Local rules (default): not an LLM.** No prompt leaves this server. The deterministic parser recognizes a double-quoted document name, numeric `3 copies` / `12 pages`, `mono` / `monochrome` / `black and white` / `color`, `A4` / `Letter`, and `duplex` / `double-sided` / `single-sided`. For example:

```text
Print "Quarterly report", 3 copies, 12 pages, color, Letter, duplex
```

Omitted settings use **1 copy, 1 page, monochrome, A4, single-sided**, with visible warnings. Without a quoted name, a placeholder is used. Contradictory recognized settings or out-of-range numeric values are rejected. Local rules do not understand arbitrary language, page ranges, word-number quantities, layout, finishing or complex negations; always inspect the draft.

**OpenAI (optional): genuine server-side provider request.** Export an API key before starting:

```sh
export OPENAI_API_KEY='your-key'
export OPENAI_MODEL='gpt-4o-mini' # optional
npm start
```

Keys are never returned to the browser or logged. Each submitted assistant prompt is sent to OpenAI only when a key is configured; job history is not sent. Do not include confidential information. The configured model must support Chat Completions structured JSON schema output. Requests time out after 15 seconds, only one provider request runs at a time, and returned drafts are strictly validated. Invalid output, refusals, timeouts and provider errors produce an explicit error, **not a silent local fallback**. No job is created until you submit the reviewed form.

## Configuration

Environment variables are read at startup; `.env.example` is a reference, not an automatically loaded file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listening address |
| `PORT` | `3000` | Listening port (1–65535) |
| `DATA_DIR` | `./data` | Storage directory, relative to your working directory or absolute |
| `OPENAI_API_KEY` | unset | Enables OpenAI instead of local rules |
| `OPENAI_MODEL` | `gpt-4o-mini` | Structured-output-capable OpenAI model |

Jobs are stored in `DATA_DIR/jobs.json`. Each successful mutation writes a new private file and atomically renames it over the previous JSON store before acknowledging success. A failed write does not update the in-memory queue. Invalid existing storage prevents startup rather than overwriting your data. The default data directory and environment files are ignored by Git; if you choose a different directory, keep it outside version control.

**Use one server process per data directory.** There is no multi-process locking. Back up `jobs.json` while the server is stopped. A maximum of 1,000 jobs (including terminal jobs) is retained; there is no automatic deletion or archive UI.

## Local API

All writes require `Content-Type: application/json` and a maximum 8 KiB body. Browser writes must be same-origin; a command-line request without an Origin header is permitted for local automation.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `GET` | `/api/config` | Assistant mode and `printingEnabled: false`; no credentials |
| `GET` | `/api/jobs` | Newest-first jobs, optional `?status=queued\|processing\|completed\|cancelled` |
| `POST` | `/api/jobs` | Create a queued job; returns `201` and `{ "job": ... }` |
| `PATCH` | `/api/jobs/:id/status` | Body `{ "status": "processing" }`; returns updated job |
| `POST` | `/api/assistant` | Body `{ "prompt": "..." }`; returns `{ "mode", "draft", "warnings" }`, never creates jobs |

Job creation accepts **exactly** these fields:

```json
{
  "name": "Quarterly report",
  "copies": 3,
  "pages": 12,
  "color": "mono",
  "paper": "A4",
  "duplex": true
}
```

Names are 1–120 trimmed characters without control characters; copies/pages are integers 1–999; color is `mono` or `color`; paper is `A4` or `Letter`; duplex is a boolean. Prompts are 1–2,000 characters. Unknown fields and incorrect types are rejected. Status transitions: `queued → processing/cancelled`, `processing → completed/cancelled`; terminal changes return `409`.

Errors use `{ "error": "safe message" }`: `400` validation, `403` origin/host restrictions, `404` unknown resource, `405` method, `413` oversized body, `415` content type, `409` transition/capacity conflict, `429` assistant busy, `502` provider failure, `500` storage/internal failure.

## Security and MVP boundaries

- **No authentication, user isolation, TLS or production deployment support.** This is a trusted single-user local tool. Keep the loopback default; do not expose it on a LAN or public network or put it behind a public proxy.
- Same-origin checks, restricted Host values, strict validation, security headers and a fixed static-asset allowlist reduce browser attack surface. User content is rendered as text, never HTML.
- No upload, PDF/page detection, cost calculation, physical printer discovery, driver/spooler integration, automatic progress tracking or real-time cross-tab updates. Counts and statuses describe planned work, not a printer's state.
- Future physical-printer integration should use a separate explicit spooler adapter with device discovery, file handling, real lifecycle events and appropriate authentication. It is intentionally not simulated as actual printing here.
