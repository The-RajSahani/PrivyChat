# PrivyChat

Private conversations. Simple rooms.

A room-based real-time chat. **The Room Code identifies the room. The username and password identify the individual member. Every member has their own password; there is no shared room password.**

**Stack:** HTML/CSS/vanilla JS · Node.js + Express · Supabase PostgreSQL + Realtime · bcryptjs · Vercel

```text
PrivyChat/
├── index.js             Vercel Express entry point
├── lib/app.js           Express app, API routes and security middleware
├── server.js            local dev entry (app.listen)
├── public/
│   ├── index.html       frontend entry page
│   ├── css/style.css    styles
│   └── js/app.js        browser app
├── supabase/schema.sql   tables, indexes, RLS, Realtime
├── vercel.json
├── package.json
└── .env.example
```

## How security works

| Concern | Approach |
|---|---|
| Passwords | bcrypt (cost 12), one hash per member. `password_hash` is never returned by any endpoint. |
| Sessions | Signed JWT in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. The JWT only carries a session id; the session row lives in Postgres, so **logout revokes access immediately**. |
| Authorization | The server loads member and room from the session. `room_id` / `member_id` from the browser are never trusted. |
| Browser database access | Browsers hold the public anon key plus a 1-hour token that names only their room. RLS allows `SELECT` on `messages` for that room and nothing else. `members` (hashes) is unreadable to browsers. |
| Service role key | Used only in `lib/app.js`. Never sent to the browser. |
| Hardening | Helmet + CSP, CORS off by default, same-origin check on writes, input validation, rate limits, generic server errors. |
| Login errors | Wrong room, unknown user and wrong password all return the same message, and bcrypt always runs, so attackers cannot discover which usernames exist. |

## 1. Supabase setup

1. Create a project at <https://supabase.com>.
2. Open **SQL Editor → New query**, paste all of `supabase/schema.sql`, click **Run**. This creates `rooms`, `members`, `messages`, `sessions`, their foreign keys, unique constraints and indexes, enables Row Level Security, and adds `messages` to the `supabase_realtime` publication. If you already set up PrivyChat, run the file again to add the message edit/delete columns and trigger.
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

For the closest match to production, you can also use `vercel dev` after linking the Vercel project.

Generate `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 3. Deploy to Vercel

Vercel now supports Express with zero-configuration detection. The project therefore uses a single root `index.js` Express entry point and does **not** rewrite `/api/*` to another serverless function.

1. Push the project to GitHub.
2. In Vercel, **Add New → Project → Import** the repository.
3. Keep the project root at the folder containing `index.js` and `package.json`. Do not set a custom output directory.
4. Add these environment variables for Production, Preview and Development:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
| `SUPABASE_JWT_SECRET` | JWT secret |
| `SESSION_SECRET` | random string, 32+ characters |

5. Deploy. Vercel sends `/api/*` requests to the Express app, where routes such as `POST /api/rooms` are handled directly.

After deployment, open `/api/health`. You should see:

```json
{"ok":true,"service":"PrivyChat API"}
```

If `/api/health` works but room creation returns a server error, check the Supabase environment variables and Supabase SQL schema. The frontend's **Not found** error shown previously was caused by the old Vercel rewrite changing `/api/...` into `/api/index` before Express routing.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | – | Deployment/API health check |
| POST | `/api/rooms` | – | Create room + first member |
| GET | `/api/rooms/:roomCode` | – | Check a room exists |
| POST | `/api/auth/join` | – | New member joins a room |
| POST | `/api/auth/login` | – | Returning member login |
| POST | `/api/auth/logout` | – | Revoke session |
| GET | `/api/auth/me` | ✔ | Current member and room |
| GET | `/api/members` | ✔ | Members of your room |
| GET | `/api/messages?before=&limit=` | ✔ | Message history |
| POST | `/api/messages` | ✔ | Send a message |
| PATCH | `/api/messages/:id` | ✔ | Edit your own message |
| DELETE | `/api/messages/:id` | ✔ | Delete your own message for the room |
| GET | `/api/realtime-token` | ✔ | Short-lived Realtime token |
| GET | `/api/config` | – | Public Supabase URL + anon key |

## Notes and limits

- **Rate limiting** uses in-memory counters, which are per serverless instance on Vercel. This blunts brute force but is not a global limit. For stricter guarantees, back it with a shared store such as Upstash Redis.
- **Passwords** are 8–72 characters (bcrypt ignores bytes beyond 72). There is no password reset, because members have no email. A forgotten password means joining the room again under a new username.
- **Usernames** are 3–24 characters (letters, numbers, `.`, `-`, `_`), unique per room, case-insensitive.
- **Message edits and deletes** are limited to the signed-in author's messages. Deleting replaces the stored text with a tombstone so every room member sees that the message was deleted.
- **CSP** allows `*.supabase.co`. If you use a custom Supabase domain, add it to `vercel.json`.
- **CORS** is off because the site and API share an origin. `ALLOWED_ORIGINS` is optional; note the cookie is `SameSite=Strict`, so cross-site frontends would need that changed.
- If Realtime shows "Reconnecting", check that `SUPABASE_JWT_SECRET` matches the project's JWT secret and that `messages` is in the Realtime publication. History and sending still work without it.
