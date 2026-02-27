/**
 * Transfer training ML samples to the live ml_features table
 * so the full ML pipeline has enough data to train all models.
 */
import Database from 'better-sqlite3';

const db = new Database('data/trading.db');

const insert = db.prepare(`
  INSERT OR IGNORE INTO ml_features (ticker, timestamp, features_json, label, label_value, labeled_at, created_at, regime)
  VALUES (@ticker, @timestamp, @features_json, @label, @label_value, @labeled_at, @created_at, @regime)
`);

const samples = db.prepare(`
  SELECT ticker, time, features_json, label, label_value, strategy, regime
  FROM training_ml_samples
  WHERE label IS NOT NULL
  ORDER BY time DESC
  LIMIT 5000
`).all();

console.log('Transferring', samples.length, 'samples from training_ml_samples to ml_features...');

const tx = db.transaction(() => {
  let inserted = 0;
  for (const s of samples) {
    try {
      insert.run({
        ticker: s.ticker,
        timestamp: s.time,
        features_json: s.features_json,
        label: s.label,
        label_value: s.label_value || 0,
        labeled_at: Date.now(),
        created_at: s.time,
        regime: s.regime
      });
      inserted++;
    } catch(e) {
      // Skip duplicates or errors
    }
  }
  return inserted;
});

const count = tx();
console.log('Inserted', count, 'new samples');

const total = db.prepare('SELECT COUNT(*) as cnt FROM ml_features WHERE label IS NOT NULL').get();
console.log('Total ml_features now:', total.cnt);

db.close();
