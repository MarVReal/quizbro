# Quizbro

Make a quiz. Scan. Play.

Quizbro is an open-source quiz builder. Build a timed quiz in minutes, share a QR code, and everyone plays from their phone with no app and no sign-up. You run the game from a private host screen: see who has joined, start it, reveal each answer and show the leaderboard.

## Features

- **Quiz builder** with five question types: multiple choice, select-all, true/false, typed answer, and poll
- Per-question **timer** (10-90s) and **points**; faster correct answers earn more
- Optional image per question, five colour themes, reorder / duplicate / delete questions, auto-saved drafts
- **Two QR codes** after publishing: a *player* link anyone can scan, and a *private host* link that controls the game
- **Lobby**: players wait on a waiting screen while you watch everyone who joins appear live
- **Host-paced rounds**: you press Start, every phone gets the question and a shared timer; the question closes at zero (or as soon as everyone has answered)
- **Reveal**: when the timer ends you tap *Reveal*; phones show right/wrong, points and a top-5 leaderboard, and your screen shows the answer bars. Tap *Next* to move on
- **Phone-first play**: animated timer ring, locked-in screen, streaks, confetti, final podium and an answer review
- **Host extras**: keyboard control (Space), "show join QR" for a projector, per-question answer breakdown, CSV export, *Play again* to reuse the quiz
- Refreshing a phone mid-game resumes where the player left off

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
- **Every table has row-level security with no policies and no grants for the browser.** All reads and writes go through a small set of `SECURITY DEFINER` Postgres functions (`create_quiz`, `get_quiz_public`, `join_quiz`, `get_play_state`, `submit_answer`, `host_get_dashboard`, `host_action`). Supabase's security advisor will flag these as "executable by anon"; that is the intended public API.
- Correct answers live in a separate table. Scoring and timing are computed **on the server**, so the browser can't fake a score or move the deadline.
- The game is a small state machine stored on the quiz row (`lobby` → `question` → `reveal` → … → `finished`). Phones and the host poll for it about once a second, and the server owns the clock, so everyone's timer ends together.
- Players don't learn whether they were right until the host reveals it: scores only include revealed questions, and the correct answer is never sent before the reveal.

## Known limitations

- Anyone can join under any free nickname, and clearing site data lets a player start over under a new name.
- No rate limiting beyond Supabase's defaults, and no way to delete a quiz from the UI yet.
- Updates are polled (about once a second) rather than pushed, so a very large room will generate a lot of requests.
- The host must keep their screen open to advance the game; there's no auto-advance mode yet.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` / `npm start` | Production build / server |
| `npm run lint` | ESLint |

## License

MIT. See [LICENSE](LICENSE).
