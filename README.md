# MyTube Standalone

Standalone MyTube website with:

- JSON-backed users, videos, sessions, reports, likes, history, and subscriptions
- Cookie-based auth with `HttpOnly` sessions
- Password hashing with `scrypt`
- Streamed video and thumbnail uploads to `/uploads`
- Byte-range video playback for browser streaming
- Live camera broadcasting snapshots
- Admin moderation panel
- Delayed live stock quotes
- Security headers, origin checks, and basic auth rate limiting

## Run locally

```bash
npm start
```

Or:

```bash
node server.js
```

The app serves from `http://localhost:3000` by default.

## Environment

Copy `.env.example` values into your hosting environment if needed.

- `PORT`: HTTP port
- `SESSION_TTL_MS`: session lifetime in milliseconds
- `MAX_REQUEST_BYTES`: max request body size
- `MAX_UPLOAD_BYTES`: max upload size per file

## Deploying

This app is easiest to deploy on a simple Node host such as:

- Render
- Railway
- Fly.io
- a VPS with Node and a reverse proxy

Recommended production setup:

1. Run the app behind HTTPS.
2. Mount persistent storage for `data/` and `uploads/`.
3. Keep regular backups of `data/mytube-data.json`, `data/users.json`, `data/videos.json`, and `uploads/`.
4. Put the app behind a reverse proxy like Nginx or Caddy.
5. Set a stricter upload limit if you expect large traffic spikes.
6. Set `NODE_ENV=production` so secure cookies and HSTS are enabled.

## Important notes

- Existing JSON users/videos are imported into the main JSON datastore automatically the first time the new server boots.
- Existing hashed passwords from `data/users.json` are preserved during migration.
- Uploaded files are stored on disk in `uploads/`.
- Sessions are stored in JSON, so they survive server restarts until they expire.

## Still recommended before a large public launch

- Move uploads into object storage or a dedicated media service
- Add email verification and password reset
- Add stronger distributed rate limiting per IP/account
- Add account lockouts, audit logs, and 2FA for admins
- Add real streaming infrastructure for low-latency live video
- Consider Postgres if you need multi-instance scaling
