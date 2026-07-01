# Train Times

A self-contained, installable, offline-capable train timetable app covering
five routes, served entirely from GitHub Pages with no backend.

- **Schedule data**: refreshed weekly by a GitHub Action that queries the
  RealTimeTrains API and commits a small JSON file back into the repo.
- **Live platforms/delays**: fetched directly from your browser using your
  own free National Rail (Darwin) API key, stored only on your device.
- **Offline**: once visited online, every route works fully offline with
  scheduled times. Live data degrades gracefully to scheduled-only when
  there's no connection or no key configured.

---

## 1. Create the repo

1. Create a new **public** GitHub repository (Pages on a free account only
   serves public repos).
2. Upload every file from this folder, preserving the folder structure —
   in particular `.github/workflows/update-schedule.yml` must stay under
   `.github/workflows/`, and `scripts/` and `data/` must stay as folders.

## 2. Get an RTT API token (for the weekly schedule fetch)

1. Register a free account at **api-portal.rtt.io** (requires an RTT
   unified login, which you can create at realtimetrains.co.uk).
2. From your account page, copy your **Bearer token** — a long string used
   in the `Authorization` header.

## 3. Add a repo secret

In your new repo: **Settings → Secrets and variables → Actions → New
repository secret**. Add one secret:

| Name | Value |
|---|---|
| `RTT_TOKEN` | your RTT Bearer token |

This is only used by the scheduled Action, server-side. It never reaches
the browser or gets exposed to visitors.

## 4. Enable GitHub Pages

**Settings → Pages → Source**: select "Deploy from a branch", branch
`main`, folder `/ (root)`. Save. GitHub will give you a URL like
`https://yourusername.github.io/your-repo-name/`.

## 5. Run the Action for the first time

The schedule data ships with a placeholder (`data/schedule.json` —
currently empty arrays for every route) so the site works structurally
right away, but you'll want real data before using it.

Go to the **Actions** tab → "Update train schedule" → **Run workflow**.
This runs the same job that will otherwise fire automatically every Monday
at 04:00 UTC. It pulls roughly 90 days ahead for all five routes and
commits the result. Expect this first run to take a few minutes given the
number of API calls involved (roughly 1,000, well within RTT's free-tier
limits but throttled slightly to be polite to the API).

Check the Action's logs if anything looks wrong — each route prints a
line as it's fetched, and any failed day/station combination logs a
warning rather than failing the whole run.

## 6. Get a Darwin API key (for live platforms/delays — optional)

This is separate from the RTT account above and is entered by each person
viewing the site, not configured in the repo:

1. Register at **raildata.org.uk**.
2. In the product catalogue, search "LDBWS" and subscribe to **Live
   Departure Board** — approval is usually instant.
3. Open the subscribed product → **Specification** tab → copy the
   **consumer key** (not the consumer secret).
4. On the live site, tap the ⚙ icon in the header, paste the key, save.

Without a key, the app works identically except live overlay never
activates — every train just shows its scheduled time and (where
available) a planned platform.

## 7. Adding or changing routes later

Edit `routes.json` directly (GitHub's web editor works fine for this — no
local dev environment needed):

```json
{ "id": "new-route", "name": "A ↔ B", "from": "AAA", "to": "BBB", "change": null }
```

Add a `"change": "CCC"` and `"minConnectionMins": 5` for a route requiring
one change. Add any new station codes to `stations.json` too, so names
display properly instead of bare CRS codes. The next scheduled (or
manually triggered) Action run will pick up the new route automatically —
no other code changes needed.

## How it fits together

```
.github/workflows/update-schedule.yml   weekly trigger
scripts/fetch_schedule.py               queries RTT, writes data/schedule.json
data/schedule.json                      committed by the Action, served as a static file
routes.json / stations.json             your configuration — edit anytime
index.html / styles.css / app.js        the app itself — reads the JSON above
sw.js                                   offline caching (stale-while-revalidate)
```

Two separate credentials, two separate places: RTT's account lives in
GitHub Secrets and never reaches a browser. The Darwin key lives in each
visitor's own `localStorage` and never reaches the repo.
