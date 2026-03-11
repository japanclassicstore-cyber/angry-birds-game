# angry-birds-game

Classic Angry Birds game with canvas physics, sound effects, a leaderboard API, and local or MongoDB-backed score storage.

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env`.
3. Start the app with `npm run dev`.
4. Open `http://localhost:3000`.

## Environment

`MONGODB_URI` is optional. If it is not set, scores are stored in a local JSON file during development and fall back to in-memory storage if the filesystem is unavailable.

`SCORE_STORE_FILE` can be used to override the local score file path.
