# Quizbro

Make a quiz. Scan. Play.

Quizbro is an open-source quiz builder. Build a timed quiz in minutes, share a QR code, and everyone plays from their phone with no app and no sign-up. You get a second, private QR code that opens a live dashboard so you can watch every answer land.

## Features

- **Quiz builder** with five question types: multiple choice, select-all, true/false, typed answer, and poll
- Per-question **timer** (10-90s) and **points**; faster correct answers earn more
- Optional image per question, five colour themes, reorder / duplicate / delete questions, auto-saved drafts
- **Two QR codes** after publishing: a *player* link anyone can scan, and a *private host* link for the live dashboard
- **Phone-first play**: animated timer ring, answer feedback, streaks, confetti, leaderboard and an answer review
- **Live host dashboard**: leaderboard with progress, per-question answer distribution, typed answers, "show join QR" for the projector, CSV export
- Refreshing a phone mid-quiz resumes where the player left off, and the timer can't be reset

## Stack

Next.js (App Router) · React · Tailwind CSS 4 · Framer Motion · canvas-confetti · qrcode.react · Supabase (Postgres)

## Run it yourself

1. **Create a Supabase project** (the free plan is enough).
2. **Apply the schema.** Run the files in [`supabase/migrations`](supabase/migrations) in order, using the SQL editor or `supabase db push`.
3. **Configure the app.**

   ```bash
   cp .env.example .env.local
   # set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
   ```

4. **Start it.**

   ```bash
   npm install
   npm run dev
   ```

Open http://localhost:3000. To let phones join, deploy it (for example to Vercel with the same two environment variables) or use your machine's LAN address.

## How it works

- There are no accounts. Creating a quiz generates a random **host token** in your browser; only its SHA-256 hash is stored. The host link is `/host/<quiz id>#t=<token>`, and the token lives in the URL fragment so it is never sent to a server or logged. Anyone holding that link can see the answers, so treat it like a password.
- Players join with a short code (`/play/ABC123`) and a nickname. Their player id is kept in the browser's local storage.
- **Every table has row-level security with no policies and no grants for the browser.** All reads and writes go through a small set of `SECURITY DEFINER` Postgres functions (`create_quiz`, `join_quiz`, `next_question`, `submit_answer`, `get_results`, `host_get_dashboard`, `get_quiz_public`). Supabase's security advisor will flag these as "executable by anon"; that is the intended public API.
- Correct answers live in a separate table and are never sent to players until after they answer. Scoring and timing are computed **on the server**, so the browser can't fake a score or restart a timer.
- The host dashboard polls every 2 seconds while the tab is visible.

## Known limitations

- Anyone can join under any free nickname, and clearing site data lets a player start over under a new name.
- No rate limiting beyond Supabase's defaults, and no way to delete a quiz from the UI yet.
- Quizzes are self-paced: everyone moves through the questions at their own speed rather than the host advancing them.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` / `npm start` | Production build / server |
| `npm run lint` | ESLint |

## License

MIT. See [LICENSE](LICENSE).
