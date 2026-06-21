# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page World Cup 2026 match board (世界杯赛事看板). A static HTML page renders matches into three status columns — LIVE (进行中) / UPCOMING (即将开始) / FINAL (已结束) — with search, win-probability bars, and a live-clock for in-progress games. A Node script periodically fetches real data and a GitHub Actions workflow runs it on a schedule and deploys to GitHub Pages. There is no build step, no dependencies, and no test suite.

## Commands

```bash
# Run the data fetcher locally (Node 18+, uses built-in fetch — no npm install)
FOOTBALL_DATA_KEY=<token> node fetch-matches.mjs        # writes data/matches.json
FOOTBALL_DATA_KEY=<token> ODDS_API_KEY=<token> node fetch-matches.mjs   # also adds win probabilities

# View the page — must be served over http(s), NOT file://, or the data fetch is blocked
python3 -m http.server 8000     # then open http://localhost:8000/
```

Environment variables read by `fetch-matches.mjs`: `FOOTBALL_DATA_KEY` (required, football-data.org), `ODDS_API_KEY` (optional, the-odds-api.com — win probabilities are omitted without it), `FD_COMPETITION` (default `WC`), `DISPLAY_TZ` (default `America/Vancouver`), `ODDS_INTERVAL_MIN` (default `10` — minimum minutes between the-odds-api calls; the fetcher reuses the previous run's `wp` within this window), output is hardcoded to `data/matches.json`.

## Architecture & data flow

```
scripts/fetch-matches.mjs  --writes-->  data/matches.json  --polled by-->  index.html
        (CI, every 5m)                                        (browser, every 60s)
```

1. **`fetch-matches.mjs`** pulls the schedule/scores and the group standings from football-data.org, and (optionally) odds from the-odds-api.com, converts odds to vig-removed implied win probabilities, and emits `{ snapshot, oddsAt, games: [...], standings: [...] }`. The `game` shape it produces is the contract the page consumes: `{status, start, h, a, hn, an, local, hs?, as?, wp?}` where `h`/`a` are TLA codes (e.g. `BRA`), `hn`/`an` are display names, `hs`/`as` are scores (only when in-progress/final), and `wp` is `{h, d, a}` percentages (only when scheduled). `standings` is one entry per group: `{group, table:[{pos, tla, name, p, w, d, l, gf, ga, gd, pts}]}` (from the `/standings` endpoint, `type: TOTAL`, group stage only). The page renders these as per-group tables (`renderStandings`), top-2 marked as the qualification zone.
2. **`index.html`** is fully self-contained (inline CSS + JS). On load and every 60s it fetches `./data/matches.json`; **if that fails it silently falls back to the `GAMES` array hardcoded near the top of the `<script>`** (this is why the page still works opened directly or before any JSON exists). The live match-minute clock is computed client-side from `start` (`liveMinute`), independent of the data poll. `FLAGS` and `ZH` maps (keyed by TLA) provide emoji flags and Chinese names for rendering and search.
3. **`update-matches.yml`** is the GitHub Actions workflow: runs the fetcher on a 5-min cron (plus push/manual), commits `data/matches.json` if changed, then builds + deploys the whole repo root to GitHub Pages. Scores refresh every run; the odds call self-throttles inside the fetcher to ~every 10 min (`ODDS_INTERVAL_MIN`, default 10) — it reads the previous `data/matches.json` `oddsAt` timestamp and reuses the prior `wp` values when within the window, so bumping the cron frequency doesn't burn the-odds-api quota.

### Realtime layer for in-progress matches (`api/live.js`)
The static `matches.json` path tops out at ~5 min (GitHub cron floor + Pages deploy latency), too slow for live scores. `api/live.js` is a **Vercel Serverless Function** that calls football-data on demand and returns only `IN_PLAY`/`PAUSED` games (`{snapshot, games:[{status,start,h,a,hn,an,hs,as}]}`), with `Access-Control-Allow-Origin: *` and `Cache-Control: s-maxage=15` so the free-tier quota stays safe regardless of visitor count. It needs `FOOTBALL_DATA_KEY` set in the Vercel project env. The page polls it every 25s (`LIVE_POLL_MS`) **only when** a game is in-progress or past kickoff (`liveWorthPolling`), and **merges** live scores into existing cards by key `h|a|start` (`pollLive`) — it never replaces the board wholesale, so `wp` on scheduled cards and finished games from `matches.json` are preserved. Set `LIVE_URL` in `index.html` to the deployed function URL (absolute when the page is on Pages, or `/api/live` if the whole site is on Vercel); empty string disables it. A game transitioning to final is picked up by the next 5-min static refresh, not the live poll.

### Status mapping
football-data statuses collapse to three board states in `mapStatus`: `IN_PLAY`/`PAUSED` → `in_progress`, `FINISHED` → `final`, `SCHEDULED`/`TIMED` → `scheduled`; anything else (POSTPONED/CANCELLED/…) is dropped. The page's three columns key off these exact strings — keep them in sync if you touch either side.

## Repository layout

```
index.html                         # the page (Pages serves this at site root)
api/live.js                        # Vercel function: realtime in-progress scores proxy
scripts/fetch-matches.mjs          # data fetcher (workflow runs `node scripts/fetch-matches.mjs`)
.github/workflows/update-matches.yml  # cron fetch + Pages deploy
data/matches.json                  # generated by the fetcher; committed by CI (not in repo initially)
```

Pages deploys the whole repo root, so `index.html` and `data/matches.json` must stay at root.

## Conventions

- Comments and UI copy are in Chinese; keep that style when editing.
- Secrets come only from env vars / GitHub Actions secrets — never hardcode API keys.
- When changing the `game` object shape, update **both** the producer (`scripts/fetch-matches.mjs`) and the consumer (rendering functions + fallback `GAMES` array in `index.html`).
