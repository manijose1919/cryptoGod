/**
 * Genetic Strategy Evolution Engine — System B
 * Evolves populations of decision-tree genomes that generate trading signals.
 * Top-K genome signals become additional ML features.
 *
 * Genome: decision tree of indicator conditions
 *   Node: { indicator, operator, threshold, left, right }
 *   Leaf: { action: 'BUY'|'SKIP', confidence: 0-1 }
 *   Max depth: 4
 *
 * Fitness = winRate * sqrt(tradeCount) — rewards accuracy AND activity
 *
 * Hardcoded strategies always run in parallel — genomes supplement, never replace.
 */

import { getFlag } from './systemConfig.js';
import { insertGeneticGenome, getGeneticGenomes, insertGeneticEvolutionLog } from './database.js';

// Available indicators for genome nodes
const INDICATORS = [
  'tc', 'momentum', 'breakout', 'adaptive', 'whale', 'divergence',
  'rsi', 'macd_histogram', 'bollinger_b', 'volume_ratio', 'atr_norm', 'regime_score',
];

const OPERATORS = ['<', '>', '<=', '>='];

// Simple seeded RNG for reproducibility
class SimpleRNG {
  constructor(seed = 42) {
    this.seed = seed;
  }
  next() {
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }
  nextInt(min, max) {
    return Math.floor(this.next() * (max - min) + min);
  }
  choice(arr) {
    return arr[this.nextInt(0, arr.length)];
  }
}

let rng = new SimpleRNG(Date.now());

/**
 * Genome: a decision tree that evaluates indicator values and produces BUY/SKIP signals.
 */
class Genome {
  constructor(tree = null, id = null) {
    this.id = id || `genome_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.tree = tree;
    this.fitness = 0;
    this.winRate = 0;
    this.tradeCount = 0;
    this.generation = 0;
  }

  /**
   * Evaluate the genome against indicator values.
   * @param {object} indicators - { tc, momentum, breakout, adaptive, whale, divergence, rsi, macd_histogram, bollinger_b, volume_ratio, atr_norm, regime_score }
   * @returns {{ action: string, confidence: number }}
   */
  evaluate(indicators) {
    return evaluateNode(this.tree, indicators);
  }

  /**
   * Get the root indicator of this genome's tree
   */
  getRootIndicator() {
    if (this.tree && this.tree.indicator) return this.tree.indicator;
    return null;
  }

  /**
   * Serialize to JSON
   */
  serialize() {
    return JSON.stringify({
      id: this.id,
      tree: this.tree,
      fitness: this.fitness,
      winRate: this.winRate,
      tradeCount: this.tradeCount,
      generation: this.generation,
    });
  }

  /**
   * Deserialize from JSON
   */
  static deserialize(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const genome = new Genome(data.tree, data.id);
    genome.fitness = data.fitness || 0;
    genome.winRate = data.winRate || 0;
    genome.tradeCount = data.tradeCount || 0;
    genome.generation = data.generation || 0;
    return genome;
  }
}

/**
 * Evaluate a tree node recursively
 */
function evaluateNode(node, indicators) {
  if (!node) return { action: 'SKIP', confidence: 0 };

  // Leaf node
  if (node.action) {
    return { action: node.action, confidence: node.confidence || 0.5 };
  }

  // Decision node
  const value = indicators[node.indicator] || 0;
  const threshold = node.threshold || 50;
  let goLeft = false;

  switch (node.operator) {
    case '<':  goLeft = value < threshold; break;
    case '>':  goLeft = value > threshold; break;
    case '<=': goLeft = value <= threshold; break;
    case '>=': goLeft = value >= threshold; break;
    default:   goLeft = value < threshold;
  }

  return goLeft
    ? evaluateNode(node.left, indicators)
    : evaluateNode(node.right, indicators);
}

/**
 * Generate a random genome tree
 */
function randomTree(depth = 0, maxDepth = 4) {
  // Leaf probability increases with depth
  const leafProb = depth / maxDepth;
  if (depth >= maxDepth || rng.next() < leafProb) {
    return {
      action: rng.next() > 0.4 ? 'BUY' : 'SKIP', // Slight bias toward BUY for exploration
      confidence: Math.round(rng.next() * 100) / 100,
    };
  }

  return {
    indicator: rng.choice(INDICATORS),
    operator: rng.choice(OPERATORS),
    threshold: Math.round(rng.next() * 100), // 0-100 range
    left: randomTree(depth + 1, maxDepth),
    right: randomTree(depth + 1, maxDepth),
  };
}

/**
 * Crossover: swap subtrees between two parents
 */
function crossover(parent1, parent2) {
  const child1 = JSON.parse(JSON.stringify(parent1.tree));
  const child2 = JSON.parse(JSON.stringify(parent2.tree));

  // Pick random nodes to swap
  const node1 = getRandomNode(child1);
  const node2 = getRandomNode(child2);

  if (node1 && node2) {
    // Swap the subtrees
    const temp = { ...node1 };
    Object.assign(node1, node2);
    Object.assign(node2, temp);
  }

  return [
    new Genome(child1),
    new Genome(child2),
  ];
}

/**
 * Get a random node from the tree (for crossover/mutation)
 */
function getRandomNode(tree) {
  const nodes = [];
  collectNodes(tree, nodes);
  return nodes.length > 0 ? rng.choice(nodes) : tree;
}

function collectNodes(node, nodes) {
  if (!node) return;
  nodes.push(node);
  if (node.left) collectNodes(node.left, nodes);
  if (node.right) collectNodes(node.right, nodes);
}

/**
 * Mutate a genome tree
 */
function mutate(tree, mutationRate) {
  const clone = JSON.parse(JSON.stringify(tree));
  mutateNode(clone, mutationRate);
  return clone;
}

function mutateNode(node, rate) {
  if (!node) return;

  if (rng.next() < rate) {
    if (node.action) {
      // Leaf: flip action or adjust confidence
      if (rng.next() < 0.5) {
        node.action = node.action === 'BUY' ? 'SKIP' : 'BUY';
      } else {
        node.confidence = Math.max(0, Math.min(1, node.confidence + (rng.next() - 0.5) * 0.3));
      }
    } else {
      // Decision: change indicator, operator, or threshold
      const r = rng.next();
      if (r < 0.33) {
        node.indicator = rng.choice(INDICATORS);
      } else if (r < 0.66) {
        node.operator = rng.choice(OPERATORS);
      } else {
        node.threshold = Math.max(0, Math.min(100, node.threshold + (rng.next() - 0.5) * 20));
      }
    }
  }

  if (node.left) mutateNode(node.left, rate);
  if (node.right) mutateNode(node.right, rate);
}


/**
 * GeneticPopulation: manages a population of genomes
 */
class GeneticPopulation {
  constructor(config = {}) {
    this.size = config.size || getFlag('GENETIC_POPULATION_SIZE');
    this.maxDepth = config.maxDepth || getFlag('GENETIC_MAX_DEPTH');
    this.mutationRate = config.mutationRate || getFlag('GENETIC_MUTATION_RATE');
    this.elitismCount = config.elitismCount || getFlag('GENETIC_ELITISM_COUNT');
    this.genomes = [];
    this.generation = 0;
    this.totalEvolutions = 0;
  }

  /**
   * Initialize with random genomes
   */
  initialize(size = null) {
    const popSize = size || this.size;
    this.genomes = [];
    for (let i = 0; i < popSize; i++) {
      const genome = new Genome(randomTree(0, this.maxDepth));
      genome.generation = 0;
      this.genomes.push(genome);
    }
    this.generation = 0;
    console.log(`[GeneticEngine] Population initialized: ${this.genomes.length} genomes, max depth ${this.maxDepth}`);
  }

  /**
   * Evaluate all genomes against current indicators.
   * Returns all genome signals.
   *
   * @param {object} indicators - Current indicator values
   * @returns {Array<{genomeId, action, confidence}>}
   */
  evaluate(indicators) {
    return this.genomes.map(genome => ({
      genomeId: genome.id,
      ...genome.evaluate(indicators),
      fitness: genome.fitness,
    }));
  }

  /**
   * Get top-K genome signals for ML feature augmentation.
   * Returns normalized signal values suitable as ML features.
   *
   * @param {object} indicators - Current indicator values
   * @param {number} K - Number of top signals to return
   * @returns {number[]} Array of K signal values (0-1 range)
   */
  getTopSignals(indicators, K = null) {
    const topK = K || getFlag('GENETIC_TOP_K_SIGNALS');

    if (this.genomes.length === 0) {
      return new Array(topK).fill(0.5); // Neutral signals
    }

    // Sort by fitness, take top K
    const sorted = [...this.genomes].sort((a, b) => b.fitness - a.fitness);
    const topGenomes = sorted.slice(0, topK);

    // Diversity enforcement: max 3 genomes sharing same root indicator
    const rootCounts = {};
    const diverseTop = [];
    for (const genome of sorted) {
      const root = genome.getRootIndicator() || 'unknown';
      rootCounts[root] = (rootCounts[root] || 0) + 1;
      if (rootCounts[root] <= 3) {
        diverseTop.push(genome);
        if (diverseTop.length >= topK) break;
      }
    }

    // Evaluate diverse top genomes
    const signals = diverseTop.map(genome => {
      const result = genome.evaluate(indicators);
      // Encode: BUY with confidence → 0.5 + confidence/2, SKIP → 0.5 - confidence/2
      return result.action === 'BUY'
        ? 0.5 + result.confidence / 2
        : 0.5 - result.confidence / 2;
    });

    // Pad to K if needed
    while (signals.length < topK) signals.push(0.5);

    return signals;
  }

  /**
   * Evolve the population based on trade results.
   * Tournament selection, crossover, mutation, elitism.
   *
   * @param {Array<{genomeId, pnl, won}>} tradeResults - Results for genomes that signaled BUY
   * @returns {object} Evolution stats
   */
  evolve(tradeResults) {
    // Update fitness from trade results
    const resultMap = new Map();
    for (const result of tradeResults) {
      if (!resultMap.has(result.genomeId)) {
        resultMap.set(result.genomeId, { wins: 0, losses: 0, trades: 0 });
      }
      const stats = resultMap.get(result.genomeId);
      stats.trades++;
      if (result.won) stats.wins++;
      else stats.losses++;
    }

    for (const genome of this.genomes) {
      const stats = resultMap.get(genome.id);
      if (stats && stats.trades > 0) {
        genome.tradeCount += stats.trades;
        const wr = (genome.winRate * (genome.tradeCount - stats.trades) + stats.wins) / genome.tradeCount;
        genome.winRate = wr;
        genome.fitness = wr * Math.sqrt(genome.tradeCount);
      }
    }

    // Sort by fitness
    this.genomes.sort((a, b) => b.fitness - a.fitness);

    // Elitism: keep top N unchanged
    const elites = this.genomes.slice(0, this.elitismCount).map(g => {
      const clone = Genome.deserialize(g.serialize());
      clone.generation = this.generation + 1;
      return clone;
    });

    // Tournament selection + crossover + mutation for the rest
    const newPopulation = [...elites];
    let mutations = 0;
    let crossovers = 0;

    while (newPopulation.length < this.size) {
      // Tournament selection (size 3)
      const parent1 = tournamentSelect(this.genomes, 3);
      const parent2 = tournamentSelect(this.genomes, 3);

      if (rng.next() < 0.7 && parent1 !== parent2) {
        // Crossover
        const [child1, child2] = crossover(parent1, parent2);
        child1.generation = this.generation + 1;
        child2.generation = this.generation + 1;

        // Mutate children
        child1.tree = mutate(child1.tree, this.mutationRate);
        child2.tree = mutate(child2.tree, this.mutationRate);

        newPopulation.push(child1);
        if (newPopulation.length < this.size) newPopulation.push(child2);
        crossovers++;
      } else {
        // Mutation only
        const child = new Genome(mutate(parent1.tree, this.mutationRate * 2));
        child.generation = this.generation + 1;
        newPopulation.push(child);
        mutations++;
      }
    }

    // Trim to exact size
    this.genomes = newPopulation.slice(0, this.size);
    this.generation++;
    this.totalEvolutions++;

    const bestFitness = elites[0]?.fitness || 0;
    const avgFitness = this.genomes.reduce((s, g) => s + g.fitness, 0) / this.genomes.length;

    // Log evolution
    try {
      insertGeneticEvolutionLog({
        generation: this.generation,
        population_size: this.genomes.length,
        best_fitness: bestFitness,
        avg_fitness: avgFitness,
        best_genome_id: elites[0]?.id || '',
        mutations,
        crossovers,
      });
    } catch (e) {
      // Non-critical
    }

    console.log(`[GeneticEngine] Gen ${this.generation}: best=${bestFitness.toFixed(2)}, avg=${avgFitness.toFixed(2)}, mutations=${mutations}, crossovers=${crossovers}`);

    return {
      generation: this.generation,
      bestFitness,
      avgFitness,
      mutations,
      crossovers,
      eliteCount: elites.length,
    };
  }

  /**
   * Serialize population to DB
   */
  persist() {
    for (const genome of this.genomes) {
      try {
        insertGeneticGenome({
          genome_id: genome.id,
          generation: genome.generation,
          genome_json: genome.serialize(),
          fitness: genome.fitness,
          win_rate: genome.winRate,
          trade_count: genome.tradeCount,
          root_indicator: genome.getRootIndicator() || '',
        });
      } catch (e) {
        // Non-critical
      }
    }
  }

  /**
   * Restore population from DB
   */
  restore() {
    try {
      const stored = getGeneticGenomes(this.size);
      if (stored && stored.length > 0) {
        this.genomes = stored.map(row => {
          const genome = Genome.deserialize(row.genome_json);
          genome.fitness = row.fitness;
          genome.winRate = row.win_rate;
          genome.tradeCount = row.trade_count;
          return genome;
        });
        this.generation = Math.max(...this.genomes.map(g => g.generation), 0);
        console.log(`[GeneticEngine] Restored ${this.genomes.length} genomes, generation ${this.generation}`);
        return true;
      }
    } catch (e) {
      console.warn('[GeneticEngine] Could not restore:', e.message);
    }
    return false;
  }

  /**
   * Get population status
   */
  getStatus() {
    const sorted = [...this.genomes].sort((a, b) => b.fitness - a.fitness);
    return {
      enabled: getFlag('GENETIC_ENABLED'),
      generation: this.generation,
      populationSize: this.genomes.length,
      totalEvolutions: this.totalEvolutions,
      bestFitness: sorted[0]?.fitness || 0,
      avgFitness: this.genomes.reduce((s, g) => s + g.fitness, 0) / (this.genomes.length || 1),
      topGenomeId: sorted[0]?.id || null,
      rootIndicatorDistribution: this.getRootDistribution(),
    };
  }

  getRootDistribution() {
    const dist = {};
    for (const genome of this.genomes) {
      const root = genome.getRootIndicator() || 'unknown';
      dist[root] = (dist[root] || 0) + 1;
    }
    return dist;
  }
}

/**
 * Tournament selection
 */
function tournamentSelect(population, tournamentSize) {
  let best = null;
  for (let i = 0; i < tournamentSize; i++) {
    const candidate = population[rng.nextInt(0, population.length)];
    if (!best || candidate.fitness > best.fitness) {
      best = candidate;
    }
  }
  return best;
}

// Singleton population instance
let population = null;

/**
 * Get or create the singleton population
 */
export function getPopulation() {
  if (!population) {
    population = new GeneticPopulation();
    // Try to restore from DB first
    if (!population.restore()) {
      population.initialize();
    }
  }
  return population;
}

/**
 * Reset the population
 */
export function resetPopulation() {
  population = new GeneticPopulation();
  population.initialize();
  return population;
}

export { Genome, GeneticPopulation };
