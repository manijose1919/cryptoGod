/**
 * Property-Based Correctness Tests
 * 
 * Validates system properties as specified in the gemini-spec-formatted.txt
 */

import * as CapitalTierManager from '../services/capitalTierManager.js';

console.log('--- STARTING CORRECTNESS TESTS ---');

/**
 * Property 1: Capital Tier Classification Consistency
 */
function testProperty1() {
    console.log('[Property 1] Testing Capital Tier Classification Consistency');
    const testCases = [
        { amount: 50, expected: 'MICRO' },
        { amount: 500, expected: 'SMALL' },
        { amount: 5000, expected: 'MEDIUM' },
        { amount: 50000, expected: 'LARGE' }
    ];

    testCases.forEach(tc => {
        const tier = CapitalTierManager.getTier(tc.amount);
        if (tier.name === tc.expected) {
            console.log(`  ✅ $${tc.amount} correctly mapped to ${tier.name}`);
        } else {
            console.error(`  ❌ $${tc.amount} mapped to ${tier.name}, expected ${tc.expected}`);
        }
    });
}

/**
 * Property 6: Risk Limits Enforcement by Capital Tier
 */
function testProperty6() {
    console.log('[Property 6] Testing Risk Limits Enforcement');
    
    // MEDIUM tier limit is 25% max position size
    const mediumCapital = 5000; 
    const requestedSize = 2000; // 40% - should be reduced
    const recommended = CapitalTierManager.getRecommendedPositionSize(mediumCapital, requestedSize);
    const maxAllowed = mediumCapital * 0.25;

    if (recommended <= maxAllowed) {
        console.log(`  ✅ MEDIUM tier: Requested $${requestedSize} (40%) reduced to $${recommended} (<= 25%)`);
    } else {
        console.error(`  ❌ MEDIUM tier: Limit not enforced. Got $${recommended}, max $${maxAllowed}`);
    }

    // MICRO tier limit is 100%
    const microCapital = 50;
    const microRequested = 50;
    const microRecommended = CapitalTierManager.getRecommendedPositionSize(microCapital, microRequested);
    if (microRecommended === 50) {
        console.log(`  ✅ MICRO tier: Requested 100% allowed: $${microRecommended}`);
    }
}

/**
 * Property 7: Concurrent Strategy Limits
 */
function testProperty7() {
    console.log('[Property 7] Testing Concurrent Strategy Limits');
    const microTier = CapitalTierManager.getTier(50);
    const largeTier = CapitalTierManager.getTier(50000);

    console.log(`  MICRO tier max concurrent: ${microTier.maxConcurrentTrades}`);
    console.log(`  LARGE tier max concurrent: ${largeTier.maxConcurrentTrades}`);

    if (largeTier.maxConcurrentTrades > microTier.maxConcurrentTrades) {
        console.log('  ✅ Concurrent trade limits scale with tier');
    } else {
        console.error('  ❌ Concurrent trade limits do not scale correctly');
    }
}

try {
    testProperty1();
    testProperty6();
    testProperty7();
    console.log('--- CORRECTNESS TESTS COMPLETE ---');
} catch (e) {
    console.error('--- TESTS FAILED ---');
    console.error(e);
}
