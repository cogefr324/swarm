# Deploy on Railway (one service: website + server, plus Postgres)

1. Put the project in a GitHub repo (the whole `memecoin-bot` folder; `.gitignore` node_modules, dist, server/.env, server/data).
2. railway.com -> New Project -> Deploy from GitHub repo -> pick it. It reads `railway.json` (builds the site, installs the server, starts `node server/server.js`).
3. In the same project: New -> Database -> Add PostgreSQL. Open your app service -> Variables -> add:
   - `DATABASE_URL`  = reference the Postgres service's `DATABASE_URL` (Add Reference)
   - `JWT_SECRET`    = a long random string
   - `HELIUS_API_KEY` = your Helius FREE key (optional, makes scans faster)
   - `CONYR_API_KEY` = optional
   - `SIGNUP_DISABLED` = `1` while you are testing (remove it when you want signups)
   - `CORS_ORIGIN`   = your Railway URL (or leave unset)
4. App service -> Settings -> Networking -> Generate Domain. Open that URL: that is your website AND API (same address).
5. Existing accounts from your computer: once, run  `DATABASE_URL=<public url> node server/migrate-to-postgres.js`  (optional).
Notes: the remembered-coins / bundle caches in `server/data` reset on each deploy (they rebuild on their own). Paid data/RPC plans come later when users arrive.
