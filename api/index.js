const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB Connection
const MONGODB_URI = 'mongodb+srv://kimiClaw:Y7sKUHDBSwmafaRm@cluster3.7mxgj4n.mongodb.net/kimiclaw';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// Score Schema
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

const Score = mongoose.model('AngryBirdsScore', scoreSchema);

// API Routes

// Get leaderboard
app.get('/api/scores', async (req, res) => {
  try {
    const scores = await Score.find()
      .sort({ score: -1 })
      .limit(10)
      .select('playerName score birdsUsed pigsDestroyed maxVelocity createdAt');
    res.json({ success: true, scores });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save new score
app.post('/api/scores', async (req, res) => {
  try {
    const score = new Score(req.body);
    await score.save();
    res.json({ success: true, id: score._id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get player stats
app.get('/api/stats/:playerName', async (req, res) => {
  try {
    const stats = await Score.aggregate([
      { $match: { playerName: req.params.playerName } },
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
    res.json({ success: true, stats: stats[0] || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
