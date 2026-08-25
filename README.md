# Live Vote

A live audience-voting site with a real-time admin panel. Built with
Node.js, Express, and Socket.io — every phone updates instantly, no
manual refresh.

## 1. Install

You need [Node.js](https://nodejs.org) installed (v18 or newer is fine).
Open a terminal in this folder and run:

```
npm install
```

## 2. Set up Supabase (so you never lose data on restart)

This app now stores everything in [Supabase](https://supabase.com) (a free
hosted Postgres database) instead of only a local file, so contestant
names, scores, and in-progress audience votes all survive a server
restart, redeploy, or crash — not just an admin's own browser session.

1. Create a free project at [supabase.com](https://supabase.com).
2. In your project, go to **SQL Editor → New query**, paste in the
   contents of [`supabase/schema.sql`](./supabase/schema.sql) from this
   folder, and run it. This creates the `contestants`, `app_state`, and
   `votes` tables.
3. Go to **Project Settings → API** and copy:
   - **Project URL**
   - **service_role** key (not the `anon` key — the service role key is
     needed so the server can write, and it must never be put in the
     browser/frontend)
4. In this folder, copy `.env.example` to `.env`:
   ```
   cp .env.example .env
   ```
   and fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

If you skip this step, the app still runs fine using only the local
cache file described below — you just lose the "survives a full
redeploy / wiped disk" guarantee.

## 3. Run it

```
npm start
```

You'll see:

```
Live Vote is running
Audience:  http://localhost:3000
Admin:     http://localhost:3000/?admin=1
```

Open the **Admin** link yourself, and open the **Audience** link (or share
it) with everyone else.

**Do not open the HTML file directly by double-clicking it, and don't use
a separate static file server (like VS Code Live Server).** This app needs
its own Node server running (`npm start`) because that's what keeps
everyone's phones in sync in real time.

## 4. Get it onto audience phones

The audience's phones need to be able to reach the computer running
`npm start`.

**Easiest — same Wi-Fi (works for most events):**
1. Keep `npm start` running on your laptop.
2. Find your laptop's local network IP address:
   - Windows: open Command Prompt, run `ipconfig`, look for "IPv4 Address" (something like `192.168.1.24`)
   - Mac: System Settings → Wi-Fi → Details, or run `ipconfig getifaddr en0` in Terminal
3. Make sure your laptop and every audience phone are on the **same Wi-Fi network**.
4. Audience opens: `http://192.168.1.24:3000` (use your real IP)
5. You open: `http://192.168.1.24:3000/?admin=1`

**If audience members are not on the same network** (e.g. a public link
anyone can open from mobile data), you'll need to deploy this to a real
host instead of running it on your laptop. Any Node.js host works —
Render, Railway, Fly.io, and similar all have free/cheap tiers and let you
upload this folder and run `npm start` automatically. That's beyond what
I can set up for you here, but the app itself doesn't need any changes to
be deployed that way.

## How it works

- The admin controls one "Open Voting" button per contestant. Opening
  voting for a contestant is the *only* thing that puts the marking
  screen in front of the audience — otherwise everyone sees a "Welcome /
  Thank You" holding screen.
- Audience marks are whole numbers, 1–10, one per device per round.
- "Close & Score" instantly averages every mark received and rounds it
  to the nearest 0.5, with exact ties (like an average of 8.25) rounding
  **down** — so 8.1 → 8, 8.4 → 8.5, 8.25 → 8.
- Dummy contestants are pre-loaded — rename, remove, or add real names
  any time from the admin page.

## Data persistence — restarts and internet loss

There are two layers, so a restart or a dropped connection never loses a
contestant's name, score, or an audience member's vote:

1. **Supabase (primary).** Every add/rename/delete of a contestant, every
   change to who's currently being voted on, and **every single audience
   vote** (the moment it's cast, not just the final average) is written
   to Supabase. If the server is redeployed, restarted, or its disk is
   wiped, it reloads everything from Supabase on boot — including
   re-fetching any votes already cast for a round that was still open
   when it went down.
2. **`local-cache.json` (backup).** The same data is also written to a
   file in this folder on every change, instantly and without needing
   the internet. If Supabase is temporarily unreachable (e.g. the
   server's own internet connection drops), the app keeps running off
   this local cache instead of crashing, and a restart during that
   outage still restores from it.

Nothing about how the admin or audience use the app changes — this is
all invisible plumbing underneath the same UI.
