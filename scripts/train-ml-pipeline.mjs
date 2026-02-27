/**
 * Full ML Pipeline Training Script
 * Trains all 8 phases of the ML overhaul.
 */
import { initializeDatabase } from '../services/database.js';
import { trainModel } from '../services/mlPredictionService.js';
import { setFlag } from '../services/systemConfig.js';

console.log('=== FULL ML PIPELINE TRAINING ===');
initializeDatabase();

// Check sample count and label distribution
import Database from 'better-sqlite3';
const db = new Database('data/trading.db', { readonly: true });
const count = db.prepare('SELECT COUNT(*) as cnt FROM ml_features WHERE label IS NOT NULL').get();
const labels = db.prepare('SELECT label, COUNT(*) as cnt FROM ml_features GROUP BY label').all();
console.log(`Labeled samples: ${count.cnt}`);
console.log('Label distribution:', labels);
db.close();

// Reduce hyperparam search for faster training (10 configs instead of 40)
// The existing config will be used, we just want to see the full pipeline work
console.log('\n--- Starting ML Pipeline Training ---');
console.time('Total Pipeline Training');

const result = await trainModel();

console.timeEnd('Total Pipeline Training');
console.log('\n=== Training Result:', result ? 'SUCCESS' : 'FAILED', '===');

// Check final state of all phases
try {
  const { tfEngine } = await import('../services/tfEngine.js');
  const tfStatus = tfEngine.getStatus();
  console.log('\n--- Phase 1: TF.js LSTM ---');
  console.log('  Trained:', tfStatus.lstm.trained);
  if (tfStatus.lstm.trained) {
    console.log('  Accuracy:', tfStatus.lstm.accuracy?.toFixed(4));
    console.log('  Epochs:', tfStatus.lstm.epochs);
  }

  console.log('\n--- Phase 2: TFT Transformer ---');
  console.log('  Trained:', tfStatus.tft.trained);
  if (tfStatus.tft.trained) {
    console.log('  Accuracy:', tfStatus.tft.accuracy?.toFixed(4));
  }
} catch(e) { console.log('TF.js unavailable:', e.message); }

try {
  const { rlAgent } = await import('../services/rlAgent.js');
  console.log('\n--- Phase 3: RL Agent ---');
  const rlStatus = rlAgent.getStatus();
  console.log('  Trained:', rlStatus.trained);
  console.log('  Total Steps:', rlStatus.totalSteps);
} catch(e) { console.log('RL Agent unavailable:', e.message); }

try {
  const { warRoom } = await import('../services/multiAgentSystem.js');
  console.log('\n--- Phase 4: War Room ---');
  const stats = warRoom.getStats();
  console.log('  Agent Weights:', JSON.stringify(stats.metaWeights));
  for (const [name, agent] of Object.entries(stats.agentStats)) {
    console.log(`  ${name}: accuracy=${agent.emaAccuracy?.toFixed(3)}, decisions=${agent.totalDecisions}`);
  }
} catch(e) { console.log('War Room unavailable:', e.message); }

try {
  const { onlineLearner } = await import('../services/onlineLearner.js');
  console.log('\n--- Phase 6: Online Learner ---');
  const stats = onlineLearner.getStats();
  console.log('  Thompson Weights:', JSON.stringify(stats.thompsonWeights));
  console.log('  Snapshots:', stats.snapshots.snapshotCount);
} catch(e) { console.log('Online Learner unavailable:', e.message); }

process.exit(0);
