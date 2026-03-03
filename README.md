# Dex to TickTick Sync

Automatically sync reminders from [Dex](https://getdex.com) (personal CRM) to [TickTick](https://ticktick.com) (to-do app) tasks.

## What it does

- Polls Dex for new reminders and creates corresponding TickTick tasks
- Enriches tasks with contact details (email, phone, LinkedIn, job title) from Dex
- Syncs completion status — completing a reminder in Dex marks the TickTick task done
- Detects removed reminders in Dex and marks them with a `#deleted` tag in TickTick
- Tracks all synced records in a local SQLite database

## Prerequisites

- [Node.js](https://nodejs.org) (v16+)
- A [Dex](https://getdex.com) account with an API key
- A [TickTick Developer](https://developer.ticktick.com) app (for OAuth credentials)

## Setup

1. **Clone the repo**

   ```bash
   git clone https://github.com/amargolis/dextoticktick.git
   cd dextoticktick
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment variables**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` and fill in your credentials:
   - `DEX_API_KEY` — your Dex API key
   - `TICKTICK_CLIENT_ID` — from your TickTick developer app
   - `TICKTICK_CLIENT_SECRET` — from your TickTick developer app

4. **Run the sync**

   ```bash
   npm start
   ```

   On the first run, a browser window will open for TickTick OAuth authorization. After authorizing, the token is saved locally and reused for future runs.

## How it works

The sync runs in a loop (default: every 60 seconds). Each cycle waits for the previous one to finish before starting the next.

1. Fetches all reminders from the Dex API (with pagination)
2. For each new reminder, fetches associated contact details
3. Creates a TickTick task with the reminder text, contact info, and due date
4. If a reminder was completed in Dex, completes the matching TickTick task
5. If a reminder was deleted in Dex, completes and tags the TickTick task with `#deleted`

The TickTick OAuth token is automatically refreshed when it expires.

All sync activity is logged in a local SQLite database (`job_search_data.db`).

## Project structure

```
src/
  index.js            Entry point, graceful shutdown
  config.js           Environment variable loading and validation
  database.js         SQLite database layer (better-sqlite3)
  dex-client.js       Dex API client with pagination
  ticktick-client.js  TickTick API client with OAuth and token refresh
  sync.js             Sync orchestration logic
```

## Configuration

Optional environment variables (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `TICKTICK_REDIRECT_URI` | `http://localhost:8080/callback` | OAuth redirect URI |
| `DATABASE_PATH` | `./job_search_data.db` | SQLite database file path |
| `SYNC_INTERVAL_SECONDS` | `60` | Seconds between sync cycles |
| `RATE_LIMIT_DELAY` | `1500` | Milliseconds between API calls |

## License

[MIT](LICENSE)
