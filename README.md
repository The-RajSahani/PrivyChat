# PrivyChat

Private conversations. Simple rooms.

A room-based real-time chat. **The Room Code identifies the room. The username and password identify the individual member. Every member has their own password; there is no shared room password.**

**Stack:** HTML/CSS/vanilla JS · Node.js + Express · Supabase PostgreSQL + Realtime · bcryptjs · Vercel

```
PrivyChat/
├── api/index.js          Express app, exported for Vercel serverless
├── server.js             local dev entry (app.listen) - not used on Vercel
├── public/               index.html, css/style.css, js/app.js
├── supabase/schema.sql   tables, indexes, RLS, Realtime
├── vercel.json  package.json  .env.example
```

## How security works

| Concern | Approach |
|---|---|
| Passwords | bcrypt (cost 12), one hash per member. `password_hash` is never returned by any endpoint. |
| Sessions | Signed JWT in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. The JWT only carries a session id; the session row lives in Postgres, so **logout revokes access immediately**. |
| Authorization | The server loads member and room from the session. `room_id` / `member_id` from the browser are never trusted. |
| Browser database access | Browsers hold the public anon key plus a 1-hour token that names only their room. RLS allows `SELECT` on `messages` for that room and nothing else. `members` (hashes) is unreadable to browsers. |
| Service role key | Used only in `api/index.js`. Never sent to the browser. |
| Hardening | Helmet + CSP, CORS off by default, same-origin check on writes, input validation, rate limits, generic server errors. |
| Login errors | Wrong room, unknown user and wrong password all return the same message, and bcrypt always runs, so attackers cannot discover which usernames exist. |

## 1. Supabase setup

1. Create a project at <https://supabase.com>.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, click **Run**. This creates `rooms`, `members`, `messages`, `sessions`, their foreign keys, unique constraints and indexes, enables Row Level Security, and adds `messages` to the `supabase_realtime` publication.
3. Check **Database → Replication** (or **Realtime**): `messages` should be enabled.
4. Collect keys in **Project Settings → API**:
   - **Project URL** → `SUPABASE_URL`
   - **anon public key** → `SUPABASE_ANON_KEY`
   - **service_role key** → `SUPABASE_SERVICE_ROLE_KEY` (secret)
   - **JWT secret** → `SUPABASE_JWT_SECRET` (secret; under *JWT Settings*, or "Legacy JWT Secret" in newer dashboards)

> Why two more variables than the brief listed? Supabase Realtime must be subscribed to from the browser, which needs the public anon key. To keep rooms private, the server signs a short-lived token (using the JWT secret) that RLS checks. Without it, either everyone could read every room or Realtime could not work.

## 2. Local setup

```bash
npm install
cp .env.example .env      # then fill in the values
npm run dev               # http://localhost:3000
```

Generate `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 3. Deploy to Vercel

```
GitHub → Vercel → Import Repository → Add Environment Variables → Deploy → PrivyChat live
```

1. Push this folder to a GitHub repository.
2. In Vercel: **Add New → Project → import the repository**. Leave the framework as *Other*; no build command is needed.
3. Add these environment variables (Production, Preview, Development):

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
| `SUPABASE_JWT_SECRET` | JWT secret |
| `SESSION_SECRET` | random string, 32+ characters |

4. Click **Deploy**.

`vercel.json` rewrites `/api/*` to the Express app in `api/index.js` (exported, no `listen`), and `public/` is served as static files.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/rooms` | – | Create room + first member |
| GET | `/api/rooms/:roomCode` | – | Check a room exists |
| POST | `/api/auth/join` | – | New member joins a room |
| POST | `/api/auth/login` | – | Returning member login |
| POST | `/api/auth/logout` | – | Revoke session |
| GET | `/api/auth/me` | ✔ | Current member and room |
| GET | `/api/members` | ✔ | Members of your room |
| GET | `/api/messages?before=&limit=` | ✔ | Message history |
| POST | `/api/messages` | ✔ | Send a message |
| GET | `/api/realtime-token` | ✔ | Short-lived Realtime token |
| GET | `/api/config` | – | Public Supabase URL + anon key |

## Notes and limits

- **Rate limiting** uses in-memory counters, which are per serverless instance on Vercel. This blunts brute force but is not a global limit. For stricter guarantees, back it with a shared store such as Upstash Redis.
- **Passwords** are 8–72 characters (bcrypt ignores bytes beyond 72). There is no password reset, because members have no email. A forgotten password means joining the room again under a new username.
- **Usernames** are 3–24 characters (letters, numbers, `.`, `-`, `_`), unique per room, case-insensitive.
- **CSP** allows `*.supabase.co`. If you use a custom Supabase domain, add it to `vercel.json`.
- **CORS** is off because the site and API share an origin. `ALLOWED_ORIGINS` is optional; note the cookie is `SameSite=Strict`, so cross-site frontends would need that changed.
- If Realtime shows "Reconnecting", check that `SUPABASE_JWT_SECRET` matches the project's JWT secret and that `messages` is in the Realtime publication. History and sending still work without it.


### Online/offline presence
PrivyChat uses Supabase Realtime Presence on private room channels. After running `supabase/schema.sql`, in Supabase Dashboard open Realtime settings and disable **Allow public access to channels** if you want to enforce private-only Realtime channels.
