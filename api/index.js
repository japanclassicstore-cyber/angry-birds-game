require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const SCORE_FILE = process.env.SCORE_STORE_FILE || (process.env.VERCEL
  ? '/tmp/angry-birds-scores.json'
  : path.resolve(process.cwd(), '.data/angry-birds-scores.json'));

const STORE_KIND = {
  mongo: 'mongo',
  file: 'file',
  memory: 'memory'
};

let activeStore = STORE_KIND.file;
let memoryScores = [];

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const scoreSchema = new mongoose.Schema({
  playerName: { type: String, default: 'Anonymous' },
  score: { type: Number, required: true },
  birdsUsed: { type: Number, default: 0 },
  pigsDestroyed: { type: Number, default: 0 },
  maxVelocity: { type: Number, default: 0 },
  avgVelocity: { type: Number, default: 0 },
  shots: [{
    velocity: Number,
    angle: Number,
    damage: Number,
    timestamp: Date
  }],
  createdAt: { type: Date, default: Date.now }
});

const Score = mongoose.models.AngryBirdsScore || mongoose.model('AngryBirdsScore', scoreSchema);

function sanitizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeScorePayload(payload) {
  const score = Math.max(0, Math.floor(sanitizeNumber(payload && payload.score, NaN)));

  if (!Number.isFinite(score)) {
    return null;
  }

  const rawName = typeof (payload && payload.playerName) === 'string' ? payload.playerName.trim() : '';

  return {
    playerName: rawName ? rawName.slice(0, 20) : 'Anonymous',
    score,
    birdsUsed: Math.max(0, Math.floor(sanitizeNumber(payload && payload.birdsUsed))),
    pigsDestroyed: Math.max(0, Math.floor(sanitizeNumber(payload && payload.pigsDestroyed))),
    maxVelocity: Math.max(0, sanitizeNumber(payload && payload.maxVelocity)),
    avgVelocity: Math.max(0, sanitizeNumber(payload && payload.avgVelocity)),
    shots: Array.isArray(payload && payload.shots)
      ? payload.shots.slice(0, 10).map((shot) => ({
          velocity: Math.max(0, sanitizeNumber(shot && shot.velocity)),
          angle: sanitizeNumber(shot && shot.angle),
          damage: Math.max(0, sanitizeNumber(shot && shot.damage)),
          timestamp: shot && shot.timestamp ? new Date(shot.timestamp) : new Date()
        }))
      : [],
    createdAt: new Date()
  };
}

function ensureMongoConnection() {
  if (activeStore === STORE_KIND.mongo && mongoose.connection.readyState !== 1) {
    activeStore = STORE_KIND.file;
  }
}

function switchToMemoryStore() {
  if (activeStore !== STORE_KIND.memory) {
    console.warn('Score storage is unavailable on disk. Falling back to in-memory scores.');
  }

  activeStore = STORE_KIND.memory;
}

async function readFileScores() {
  if (activeStore === STORE_KIND.memory) {
    return memoryScores;
  }

  try {
    await fs.mkdir(path.dirname(SCORE_FILE), { recursive: true });
    const raw = await fs.readFile(SCORE_FILE, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') {
        return '[]';
      }

      throw error;
    });
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    switchToMemoryStore();
    return memoryScores;
  }
}

async function writeFileScores(scores) {
  if (activeStore === STORE_KIND.memory) {
    memoryScores = scores;
    return;
  }

  try {
    await fs.mkdir(path.dirname(SCORE_FILE), { recursive: true });
    await fs.writeFile(SCORE_FILE, JSON.stringify(scores, null, 2));
  } catch (error) {
    switchToMemoryStore();
    memoryScores = scores;
  }
}

function sortScores(scores) {
  return [...scores].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
}

function formatLeaderboardEntry(entry) {
  return {
    id: entry.id || String(entry._id || ''),
    playerName: entry.playerName,
    score: entry.score,
    birdsUsed: entry.birdsUsed,
    pigsDestroyed: entry.pigsDestroyed,
    maxVelocity: entry.maxVelocity,
    createdAt: entry.createdAt
  };
}

async function listTopScores(limit = 10) {
  ensureMongoConnection();

  if (activeStore === STORE_KIND.mongo) {
    const scores = await Score.find()
      .sort({ score: -1, createdAt: 1 })
      .limit(limit)
      .select('playerName score birdsUsed pigsDestroyed maxVelocity createdAt')
      .lean();

    return scores.map(formatLeaderboardEntry);
  }

  const scores = await readFileScores();
  return sortScores(scores).slice(0, limit).map(formatLeaderboardEntry);
}

async function createScore(payload) {
  ensureMongoConnection();

  const normalized = normalizeScorePayload(payload);

  if (!normalized) {
    const error = new Error('Invalid score payload.');
    error.statusCode = 400;
    throw error;
  }

  if (activeStore === STORE_KIND.mongo) {
    const score = new Score(normalized);
    await score.save();
    return String(score._id);
  }

  const scores = await readFileScores();
  const entry = {
    id: randomUUID(),
    ...normalized
  };

  scores.push(entry);
  await writeFileScores(scores);
  return entry.id;
}

async function getPlayerStats(playerName) {
  ensureMongoConnection();

  if (activeStore === STORE_KIND.mongo) {
    const stats = await Score.aggregate([
      { $match: { playerName } },
      {
        $group: {
          _id: '$playerName',
          totalGames: { $sum: 1 },
          highScore: { $max: '$score' },
          avgScore: { $avg: '$score' },
          totalPigs: { $sum: '$pigsDestroyed' }
        }
      }
    ]);

    return stats[0] || null;
  }

  const scores = (await readFileScores()).filter((entry) => entry.playerName === playerName);

  if (scores.length === 0) {
    return null;
  }

  const totalScore = scores.reduce((sum, entry) => sum + sanitizeNumber(entry.score), 0);
  const totalPigs = scores.reduce((sum, entry) => sum + sanitizeNumber(entry.pigsDestroyed), 0);

  return {
    _id: playerName,
    totalGames: scores.length,
    highScore: Math.max(...scores.map((entry) => sanitizeNumber(entry.score))),
    avgScore: totalScore / scores.length,
    totalPigs
  };
}

async function initializeStore() {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    activeStore = STORE_KIND.file;
    return;
  }

  try {
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    activeStore = STORE_KIND.mongo;
    console.log('MongoDB connected for score storage.');
  } catch (error) {
    activeStore = STORE_KIND.file;
    console.warn('MongoDB is unavailable. Using the local score store instead.');
  }
}

const storeReady = initializeStore();

app.get('/api/scores', async (req, res) => {
  try {
    await storeReady;
    const scores = await listTopScores();
    res.json({ success: true, scores, storage: activeStore });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Unable to load scores.' });
  }
});

app.post('/api/scores', async (req, res) => {
  try {
    await storeReady;
    const id = await createScore(req.body);
    res.json({ success: true, id, storage: activeStore });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      error: statusCode === 400 ? error.message : 'Unable to save score.'
    });
  }
});

app.get('/api/stats/:playerName', async (req, res) => {
  try {
    await storeReady;
    const playerName = req.params.playerName.trim();

    if (!playerName) {
      res.status(400).json({ success: false, error: 'Player name is required.' });
      return;
    }

    const stats = await getPlayerStats(playerName);
    res.json({ success: true, stats, storage: activeStore });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Unable to load player stats.' });
  }
});

app.get('/api/health', async (req, res) => {
  await storeReady;
  ensureMongoConnection();

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    storage: activeStore,
    db: activeStore === STORE_KIND.mongo ? 'connected' : 'disabled'
  });
});

app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

if (require.main === module) {
  storeReady.then(() => {
    app.listen(PORT, () => {
      console.log(`Angry Birds server running on port ${PORT}`);
    });
  });
}

module.exports = app;
