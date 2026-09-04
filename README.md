# Live Vote

A live audience + judges voting site with a real-time admin panel, built
around two rounds: **Talent** (round 1) and **Catent** (round 2, the
final). Built with Node.js, Express, and Socket.io — every phone updates
instantly, no manual refresh.

## 1. Install

You need [Node.js](https://nodejs.org) installed (v18 or newer is fine).
Open a terminal in this folder and run:

```
npm install
```

## 2. Set up Supabase (so you never lose data on restart)

This app stores everything in [Supabase](https://supabase.com) (a free
hosted Postgres database) instead of only a local file, so contestant
names, scores, and in-progress votes all survive a server restart,
redeploy, or crash — not just an admin's own browser session.

1. Create a free project at [supabase.com](https://supabase.com).
2. In your project, go to **SQL Editor → New query**, paste in the
   contents of [`supabase/schema.sql`](./supabase/schema.sql) from this
   folder, and run it. This creates the `contestants`, `app_state`,
   `votes`, and `judge_votes` tables. Safe to re-run if you already had
   an older version of this schema.
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
Judges:    http://localhost:3000/?judge=1  (…2, 3, 4)
Admin:     http://localhost:3000/?admin=1
```

Open the **Admin** link yourself. Share the **Audience** link with the
crowd, and give each of the four **Judge** links to one judge each.

**Do not open the HTML file directly by double-clicking it, and don't use
a separate static file server (like VS Code Live Server).** This app needs
its own Node server running (`npm start`) because that's what keeps
everyone's phones in sync in real time.

## 4. Get it onto phones

Everyone's phone (audience and judges) needs to be able to reach the
computer running `npm start`.

**Easiest — same Wi-Fi (works for most events):**
1. Keep `npm start` running on your laptop.
2. Find your laptop's local network IP address:
   - Windows: open Command Prompt, run `ipconfig`, look for "IPv4 Address" (something like `192.168.1.24`)
   - Mac: System Settings → Wi-Fi → Details, or run `ipconfig getifaddr en0` in Terminal
3. Make sure your laptop and every phone are on the **same Wi-Fi network**.
4. Audience opens: `http://192.168.1.24:3000` (use your real IP)
5. Judges open: `http://192.168.1.24:3000/?judge=1`, `...?judge=2`, `...?judge=3`, `...?judge=4`
6. You open: `http://192.168.1.24:3000/?admin=1`

**If people are not on the same network** (e.g. a public link anyone can
open from mobile data), you'll need to deploy this to a real host instead
of running it on your laptop. Any Node.js host works — Render, Railway,
Fly.io, and similar all have free/cheap tiers and let you upload this
folder and run `npm start` automatically. That's beyond what I can set up
for you here, but the app itself doesn't need any changes to be deployed
that way.

## How it works

- **Two rounds:** Round 1 is **Talent**, round 2 is **Catent**. The admin
  page has a tab for each. Whichever round is currently in progress is
  the "live" tab, with full controls; the other tab shows either a locked
  placeholder (Catent, before Talent finishes) or an archived read-only
  scoreboard (Talent, once Catent has begun).
- **Two vote sources, scored separately:**
  - **Audience** votes from the plain link (no query string), one mark
    (1–10) per device per contestant.
  - **Judges** vote from their own personal link (`?judge=1` through
    `?judge=4`) — same ballot design as the audience, but each judge's
    mark is tracked as its own slot, so reloading or switching devices
    just overwrites that judge's own mark instead of adding an extra
    vote.
- **Averages, all automatic.** "Close & Score" averages every audience
  mark into **Audience**, every judge mark into **Judges**, and averages
  those two into **Final** — the number contestants are ranked on. Every
  average rounds to the closest 0.5, with an exact tie (like 8.25)
  rounding **down** — so 8.1 → 8, 8.4 → 8.5, 8.25 → 8. If only one side
  has voted so far, Final just shows that side.
- **Talent results:** ranked by Final, highest first, with the top 50%
  (ties included) marked **Advances**.
- **Transfer to Catent:** from the Talent results screen, **Transfer Top
  50% → Catent** moves every qualifier into a fresh, randomly shuffled
  Catent lineup with scores cleared — no retyping names. Talent's full
  standings are frozen and stay viewable under the Talent tab.
  Eliminated contestants aren't deleted, just hidden from the live
  lineup (kept in Supabase for history).
- **Catent results:** ranked by Final the same way; the **top 3** are
  tagged 🏆 **Winner**.
- **Start Over:** brings back every contestant ever added (including
  anyone eliminated going into Catent), clears every score, and resets
  back to the very first Talent lineup. Available any time voting isn't
  in progress.
- Dummy contestants are pre-loaded — rename, remove, or add real names
  any time from the admin page.
- **Reorder the lineup:** drag a contestant's `⠿` handle up or down to
  move them to a new position. Works on both mouse and touch.

## Data persistence — restarts and internet loss

There are two layers, so a restart or a dropped connection never loses a
contestant's name, score, or a vote:

1. **Supabase (primary).** Every add/rename/delete of a contestant, every
   change to who's currently being voted on, **every single audience and
   judge vote** (the moment it's cast, not just the final average), and
   the round/Talent-results snapshot are all written to Supabase. If the
   server is redeployed, restarted, or its disk is wiped, it reloads
   everything from Supabase on boot — including re-fetching any votes
   already cast for a round that was still open when it went down.
2. **`local-cache.json` (backup).** The same data is also written to a
   file in this folder on every change, instantly and without needing
   the internet. If Supabase is temporarily unreachable, the app keeps
   running off this local cache instead of crashing, and a restart
   during that outage still restores from it.

Nothing about how the admin, audience, or judges use the app changes —
this is all invisible plumbing underneath the same UI.
