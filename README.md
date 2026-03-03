# nanofleet-news

A [NanoFleet](https://github.com/NanoFleet/nanofleet) plugin that generates a daily PDF newspaper from RSS feeds and delivers it to your connected channel every morning.

## Features

- Organise news by categories with configurable RSS feeds
- Categories without feeds are filled automatically via agent web search
- Configurable max articles per feed per category
- Scheduled delivery via cron (any timezone)
- PDF generated with `pdf-lib` — no native dependencies
- Manual generation from the UI or via MCP tool
- History of all generated digests accessible from the UI

## MCP Tools

<details>
<summary><code>generate_digest</code> — Trigger digest generation and delivery</summary>

**Input:** none

**Response:**
```json
{ "ok": true, "message": "Digest generated and delivered." }
```

</details>

<details>
<summary><code>list_digests</code> — List previously generated digests</summary>

**Input:** none

**Response:**
```json
{ "digests": [{ "id": "...", "filename": "journal-2025-01-01.pdf", "generated_at": 1735689600000 }] }
```

</details>

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/config` | Get current configuration |
| `PUT` | `/config` | Update configuration `{ agent_id, cron_expression, timezone, enabled }` |
| `GET` | `/agents` | List running agents (proxy to NanoFleet) |
| `GET` | `/categories` | List categories |
| `POST` | `/categories` | Create category `{ name, max_articles? }` |
| `PUT` | `/categories/:id` | Update category `{ name?, position?, max_articles? }` |
| `DELETE` | `/categories/:id` | Delete category (cascades to feeds) |
| `GET` | `/feeds` | List all feeds |
| `POST` | `/feeds` | Create feed `{ category_id, url, name }` |
| `PUT` | `/feeds/:id` | Update feed `{ url?, name?, category_id? }` |
| `DELETE` | `/feeds/:id` | Delete feed |
| `GET` | `/digests` | List generated digests |
| `GET` | `/digests/:filename` | Serve a PDF digest |
| `POST` | `/digests/generate` | Trigger generation (fire-and-forget) |

## Ports

| Port | Service |
|------|---------|
| `8830` | REST API + Web UI |
| `8831` | MCP server |

## Installation

Install via the NanoFleet Plugins page using the manifest URL:

```
https://raw.githubusercontent.com/NanoFleet/nanofleet-news/main/manifest.json
```
