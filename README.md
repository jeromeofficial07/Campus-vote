# Campus Vote — College Election Polling

Real-time election polling app. **Single Flask server** serves both the API and the frontend on one port — no npm, no build step. Frontend is plain HTML/CSS/JS with React loaded via CDN (JSX compiled live in the browser by Babel).

## 1. MySQL setup

```sql
CREATE DATABASE campus_poll CHARACTER SET utf8mb4;
```

Tables are created automatically by SQLAlchemy on first run.

## 2. Backend + frontend setup (one server, one port)

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

copy .env.example .env          # Windows. On Mac/Linux: cp .env.example .env
# then edit .env with your real MySQL username/password

python app.py
```

Open your browser at **http://localhost:5000** — that's it. The frontend (`backend/static/index.html`, `style.css`, `app.js`) and the API (`/api/...`) are served from the exact same Flask process and port. No second terminal, no Vite, no CORS.

On first run, a default admin is seeded:
- email: `admin@campus.edu`
- password: `Admin@123`

**Change this password** — there's no admin-signup route by design; promote/demote roles directly in the `users` table.

## 3. How the frontend works (no build step)

- `backend/static/index.html` loads React, ReactDOM, React Router, and Socket.IO straight from CDN links (`<script src="https://unpkg.com/...">`), plus Babel Standalone.
- `backend/static/app.js` is written in plain JSX. The `<script type="text/babel" src="/app.js">` tag tells Babel Standalone to compile it to regular JS **in the browser**, on page load — so you write real JSX/React without npm, webpack, or Vite.
- Routing uses `HashRouter` (URLs look like `http://localhost:5000/#/polls/1`) instead of `BrowserRouter`, specifically so Flask never has to handle arbitrary client-side paths — it only ever serves `index.html` at `/`, and React Router takes over from the `#` onward entirely in the browser.
- This trade-off (in-browser Babel compilation) is fine for development and learning, but is slower than a pre-built bundle — for a production deployment you'd eventually want a real build step. For this project's purpose it keeps everything to genuinely one HTML file, one CSS file, one JS file, and React.

## 4. How real-time works

- `app.js` opens one Socket.IO connection to the same origin (`io(undefined, ...)`) for the whole app.
- On a poll's page, the client emits `join_poll` to join a room `poll_<id>`, and re-joins automatically any time the socket reconnects (handles idle disconnects gracefully).
- When anyone votes (`POST /api/polls/<id>/vote`), the backend commits the vote, then emits `results_update` with the fresh tally to that room only.
- Every browser tab currently viewing that poll receives the update instantly and the bar chart re-renders — no polling, no refresh.

## 5. Flow

1. Register a student account (or log in as the seeded admin).
2. As admin, go to **Create Poll**, add a title + at least 2 candidates.
3. Students open the poll, select a candidate, and cast their vote (one vote per user per poll — enforced by a DB unique constraint on `poll_id + user_id`).
4. After voting, the page flips to a live results view. Open the same poll in another tab/browser to watch the bars move in real time as votes come in.

## Production note

For production, run behind gunicorn instead of the dev server:
```bash
gunicorn -k eventlet -w 1 app:app
```
(`-w 1` matters — Flask-SocketIO with eventlet needs a single worker unless you add a message queue like Redis for multi-worker pub/sub.)
