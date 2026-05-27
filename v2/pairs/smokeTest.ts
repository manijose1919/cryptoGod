// Standalone smoke test for the pairs engine.
// Boots in paper-mode, runs one loop, dumps status, exits.
//
// Run: PAIRS_MODE=paper npx tsx v2/pairs/smokeTest.ts

// @ts-expect-error JS module without types
import { initializeDatabase } from '../../services/database.js';
import { initPairsEngine, startPairsEngine, stopPairsEngine, getPairsStatus } from './pairsEngine.ts';

async function main(): Promise<void> {
  process.env.PAIRS_MODE = 'paper';  // force paper-mode even if env not set
  initializeDatabase();

  console.log('--- initPairsEngine ---');
  initPairsEngine();

  console.log('\n--- startPairsEngine ---');
  startPairsEngine();

  // Wait a bit for first loop to fire (it's kicked off immediately by startPairsEngine).
  await new Promise<void>(resolve => setTimeout(resolve, 8000));

  console.log('\n--- status ---');
  const status = getPairsStatus();
  console.log(JSON.stringify(status, (_k, v) => (v === Infinity ? 'Infinity' : v), 2));

  console.log('\n--- stop ---');
  stopPairsEngine();
  process.exit(0);
}

main().catch(err => {
  console.error('smoke test failed:', err);
  process.exit(1);
});
