# Running your own account server (no Supabase/Firebase)

Accounts (sign up / log in / saved trades) are now powered by a small Node server you run
yourself, in the `server/` folder. No third-party backend account needed - it's your own code,
your own data, stored as plain files on your machine. Two things need to run at the same time:
the server (handles accounts + saves trading state) and the usual frontend (`npm run dev`).

## 1. Set up the server (one-time)

```powershell
cd server
npm install
copy .env.example .env
```

Open `server/.env` and set `JWT_SECRET` to any long random string (this is what signs login
sessions - treat it like a password). You can generate one with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the output in as `JWT_SECRET=...`. Everything else in `.env` can stay as-is for local use.

### Optional: the signup confirmation email

By default the server skips sending the "you've signed up" email and just logs a note - signup
still works fine either way. To actually send that email, fill in the `SMTP_*` fields in
`server/.env`. The comments in that file show an example using a Gmail account with an
[app password](https://myaccount.google.com/apppasswords). Any SMTP provider works the same way
(Gmail, Outlook, SendGrid, Mailgun, etc.) - just fill in its host/port/username/password.

## 2. Run both pieces

Two terminals, both left running:

**Terminal 1 - the server:**
```powershell
cd server
npm start
```
You should see `Trading bot auth/storage server listening on http://localhost:4000`.

**Terminal 2 - the app itself** (from the project's root folder, not `server/`):
```powershell
npm install
npm run dev
```

Open the URL it prints (usually `http://localhost:5173`). You'll land on a sign up / log in
screen - create an account, and you're in. Your balance, positions, and trade history are saved
to the server (as a file per account under `server/data/`) and will be there next time you log in
on this or any other device that can reach this server.

## Notes

- This is a local dev setup: the server only listens on your machine by default. If you want
  friends/other devices to reach it, you'd deploy `server/` somewhere (Railway, Render, a VPS,
  etc.) and point the frontend at it by setting `VITE_API_URL` (copy `.env.example` in the
  project root to `.env`) to that server's public URL.
- Passwords are hashed (bcrypt) before being stored - never saved in plain text.
- There's no "forgot password" flow yet - if someone forgets their password, you'd need to delete
  their entry from `server/users.json` and have them sign up again (that also resets their saved
  trades for that account).
