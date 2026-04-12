// cognitive.test.js — Unit tests for NMF / FISTA / DPP cognitive pipeline
import assert from 'node:assert/strict';
import {
    applyNMFRebalance,
    computeFISTAResidual,
    applyDPPSampling,
} from '../cognitive.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`\u2713 ${name}`);
        passed++;
    } catch (e) {
        console.log(`\u2717 ${name}`);
        console.log(`  ${e.message}`);
        failed++;
    }
}

console.log('Running cognitive.test.js...\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const V = {
    e1: [1, 0, 0, 0],
    e2: [0, 1, 0, 0],
    e3: [0, 0, 1, 0],
    e4: [0, 0, 0, 1],
    mix12: [1, 1, 0, 0],
    mix12b: [1, 1.1, 0, 0],
    mix34: [0, 0, 1, 1],
    all: [1, 1, 1, 1],
    zero: [0, 0, 0, 0],
};

function makeCandidates(specs) {
    return specs.map((s, i) => ({
        nodeId: s.nodeId || `n${i}`,
        finalScore: s.finalScore ?? 0.5,
        vector: s.vector || undefined,
    }));
}

// =========================================================================
// 1. applyNMFRebalance
// =========================================================================

test('NMF: returns candidates unchanged when too few vectors', () => {
    const cands = makeCandidates([
        { vector: V.e1 },
        { vector: V.e2 },
        { vector: V.e3 },
    ]);
    const origScores = cands.map(c => c.finalScore);
    applyNMFRebalance(cands, V.all);
    assert.deepStrictEqual(cands.map(c => c.finalScore), origScores);
});

test('NMF: returns candidates unchanged when no queryVector', () => {
    const cands = makeCandidates([
        { vector: V.e1 }, { vector: V.e2 }, { vector: V.e3 },
        { vector: V.e4 }, { vector: V.mix12 }, { vector: V.mix34 },
    ]);
    const origScores = cands.map(c => c.finalScore);
    applyNMFRebalance(cands, null);
    assert.deepStrictEqual(cands.map(c => c.finalScore), origScores);
});

test('NMF: returns candidates unchanged when queryVector is empty', () => {
    const cands = makeCandidates([
        { vector: V.e1 }, { vector: V.e2 }, { vector: V.e3 },
        { vector: V.e4 }, { vector: V.mix12 }, { vector: V.mix34 },
    ]);
    const origScores = cands.map(c => c.finalScore);
    applyNMFRebalance(cands, []);
    assert.deepStrictEqual(cands.map(c => c.finalScore), origScores);
});

test('NMF: adds nmfBoost property to candidates with vectors', () => {
    const cands = makeCandidates([
        { vector: V.e1 }, { vector: V.e2 }, { vector: V.e3 },
        { vector: V.e4 }, { vector: V.mix12 }, { vector: V.mix34 },
    ]);
    applyNMFRebalance(cands, V.all);
    for (const c of cands) {
        if (c.vector) {
            assert.ok(typeof c.nmfBoost === 'number', `nmfBoost should be a number, got ${typeof c.nmfBoost}`);
        }
    }
});

test('NMF: nmfBoost is non-negative and <= boostFactor', () => {
    const cands = makeCandidates([
        { vector: V.e1 }, { vector: V.e2 }, { vector: V.e3 },
        { vector: V.e4 }, { vector: V.mix12 }, { vector: V.mix34 },
    ]);
    const bf = 0.3;
    applyNMFRebalance(cands, V.all, { boostFactor: bf });
    for (const c of cands) {
        if (c.nmfBoost !== undefined) {
            assert.ok(c.nmfBoost >= 0, `nmfBoost should be >= 0, got ${c.nmfBoost}`);
            assert.ok(c.nmfBoost <= bf + 1e-9, `nmfBoost should be <= ${bf}, got ${c.nmfBoost}`);
        }
    }
});

test('NMF: candidates are re-sorted by finalScore descending', () => {
    const cands = makeCandidates([
        { vector: V.e1, finalScore: 0.1 },
        { vector: V.e2, finalScore: 0.9 },
        { vector: V.e3, finalScore: 0.5 },
        { vector: V.e4, finalScore: 0.3 },
        { vector: V.mix12, finalScore: 0.7 },
        { vector: V.mix34, finalScore: 0.2 },
    ]);
    applyNMFRebalance(cands, V.all);
    for (let i = 1; i < cands.length; i++) {
        assert.ok(cands[i - 1].finalScore >= cands[i].finalScore,
            `Not sorted: ${cands[i - 1].finalScore} < ${cands[i].finalScore} at index ${i}`);
    }
});

test('NMF: candidates without vectors are unaffected', () => {
    const cands = makeCandidates([
        { vector: V.e1 }, { vector: V.e2 }, { vector: V.e3 },
        { vector: V.e4 }, { vector: V.mix12 },
        { nodeId: 'noVec', finalScore: 0.42 },
    ]);
    applyNMFRebalance(cands, V.all);
    const noVec = cands.find(c => c.nodeId === 'noVec');
    assert.equal(noVec.finalScore, 0.42);
    assert.equal(noVec.nmfBoost, undefined);
});

test('NMF: custom numTopics=2 works with fewer candidates', () => {
    const cands = makeCandidates([
        { vector: V.e1 }, { vector: V.e2 }, { vector: V.e3 },
    ]);
    applyNMFRebalance(cands, V.all, { numTopics: 2 });
    const hasBoost = cands.some(c => c.nmfBoost !== undefined);
    assert.ok(hasBoost, 'NMF should have run with numTopics=2 and 3 candidates');
});

test('NMF: boostFactor=0 means no boost', () => {
    const cands = makeCandidates([
        { vector: V.e1, finalScore: 0.5 },
        { vector: V.e2, finalScore: 0.5 },
        { vector: V.e3, finalScore: 0.5 },
        { vector: V.e4, finalScore: 0.5 },
        { vector: V.mix12, finalScore: 0.5 },
    ]);
    applyNMFRebalance(cands, V.all, { boostFactor: 0 });
    for (const c of cands) {
        if (c.nmfBoost !== undefined) {
            assert.ok(Math.abs(c.nmfBoost) < 1e-9, `nmfBoost should be ~0 with boostFactor=0, got ${c.nmfBoost}`);
        }
    }
});

test('NMF: mutates finalScore in place', () => {
    const cands = makeCandidates([
        { vector: V.e1, finalScore: 0.1 },
        { vector: V.e2, finalScore: 0.1 },
        { vector: V.e3, finalScore: 0.1 },
        { vector: V.e4, finalScore: 0.1 },
        { vector: V.mix12, finalScore: 0.1 },
    ]);
    const result = applyNMFRebalance(cands, V.e1);
    assert.ok(result === cands, 'Should return same array reference');
    const anyChanged = cands.some(c => c.finalScore !== 0.1);
    assert.ok(anyChanged, 'At least some finalScores should have changed');
});

// =========================================================================
// 2. computeFISTAResidual
// =========================================================================

test('FISTA: returns empty result when no candidates have vectors', () => {
    const result = computeFISTAResidual(V.e1, [{ nodeId: 'a' }]);
    assert.deepStrictEqual(result.residualVector, []);
    assert.equal(result.residualNorm, 0);
    assert.deepStrictEqual(result.weights, []);
    assert.equal(result.shouldSupplementSearch, false);
});

test('FISTA: returns empty result when no queryVector', () => {
    const result = computeFISTAResidual(null, [{ nodeId: 'a', vector: V.e1 }]);
    assert.deepStrictEqual(result.residualVector, []);
    assert.equal(result.residualNorm, 0);
    assert.equal(result.shouldSupplementSearch, false);
});

test('FISTA: returns empty result when queryVector is empty', () => {
    const result = computeFISTAResidual([], [{ nodeId: 'a', vector: V.e1 }]);
    assert.deepStrictEqual(result.residualVector, []);
    assert.equal(result.residualNorm, 0);
});

test('FISTA: residualNorm is non-negative', () => {
    const cands = [{ nodeId: 'a', vector: V.e1 }, { nodeId: 'b', vector: V.e2 }];
    const result = computeFISTAResidual(V.mix12, cands);
    assert.ok(result.residualNorm >= 0, `residualNorm should be >= 0, got ${result.residualNorm}`);
});

test('FISTA: weights array length matches candidates with vectors', () => {
    const cands = [
        { nodeId: 'a', vector: V.e1 },
        { nodeId: 'b', vector: V.e2 },
        { nodeId: 'c' },
    ];
    const result = computeFISTAResidual(V.mix12, cands);
    assert.equal(result.weights.length, 2);
});

test('FISTA: residualVector has same dimension as queryVector', () => {
    const cands = [{ nodeId: 'a', vector: V.e1 }];
    const result = computeFISTAResidual(V.mix12, cands);
    assert.equal(result.residualVector.length, V.mix12.length);
});

test('FISTA: perfect coverage (query = candidate) gives small residual', () => {
    const q = [1, 0, 0, 0];
    const cands = [{ nodeId: 'a', vector: [1, 0, 0, 0] }];
    const result = computeFISTAResidual(q, cands, { lambda: 0.01, iterations: 50 });
    assert.ok(result.residualNorm < 0.15, `Expected small residual, got ${result.residualNorm}`);
    assert.equal(result.shouldSupplementSearch, false);
});

test('FISTA: orthogonal candidates give large residual', () => {
    const q = [0, 0, 1, 0];
    const cands = [
        { nodeId: 'a', vector: [1, 0, 0, 0] },
        { nodeId: 'b', vector: [0, 1, 0, 0] },
    ];
    const result = computeFISTAResidual(q, cands, { lambda: 0.01 });
    assert.ok(result.residualNorm > 0.5, `Expected large residual for orthogonal, got ${result.residualNorm}`);
    assert.equal(result.shouldSupplementSearch, true);
});

test('FISTA: shouldSupplementSearch respects custom threshold', () => {
    const q = [1, 1, 0, 0];
    const cands = [{ nodeId: 'a', vector: [1, 0, 0, 0] }];
    const result = computeFISTAResidual(q, cands, { residualThreshold: 0.01 });
    assert.equal(result.shouldSupplementSearch, result.residualNorm > 0.01);
});

test('FISTA: lambda=0 vs lambda=1 produces different weight sparsity', () => {
    const q = [1, 1, 1, 1];
    const cands = [
        { nodeId: 'a', vector: [1, 0, 0, 0] },
        { nodeId: 'b', vector: [0, 1, 0, 0] },
        { nodeId: 'c', vector: [0, 0, 1, 0] },
        { nodeId: 'd', vector: [0, 0, 0, 1] },
    ];
    const r0 = computeFISTAResidual(q, cands, { lambda: 0.001, iterations: 50 });
    const r1 = computeFISTAResidual(q, cands, { lambda: 1.0, iterations: 50 });
    const nonzero0 = r0.weights.filter(w => Math.abs(w) > 1e-6).length;
    const nonzero1 = r1.weights.filter(w => Math.abs(w) > 1e-6).length;
    assert.ok(nonzero1 <= nonzero0,
        `High lambda should produce sparser weights: nonzero(0.001)=${nonzero0}, nonzero(1)=${nonzero1}`);
});

test('FISTA: multi-candidate good coverage gives low residual', () => {
    const q = [1, 1, 1, 1];
    const cands = [
        { nodeId: 'a', vector: [1, 0, 0, 0] },
        { nodeId: 'b', vector: [0, 1, 0, 0] },
        { nodeId: 'c', vector: [0, 0, 1, 0] },
        { nodeId: 'd', vector: [0, 0, 0, 1] },
    ];
    const result = computeFISTAResidual(q, cands, { lambda: 0.01, iterations: 50 });
    assert.ok(result.residualNorm < 0.3, `Expected low residual with full basis, got ${result.residualNorm}`);
});

test('FISTA: single candidate partial coverage', () => {
    const q = [1, 1, 0, 0];
    const cands = [{ nodeId: 'a', vector: [1, 0, 0, 0] }];
    const result = computeFISTAResidual(q, cands, { lambda: 0.01 });
    assert.ok(result.residualNorm > 0, 'Should have non-zero residual');
    assert.ok(result.residualVector.length === 4);
});

// =========================================================================
// 3. applyDPPSampling
// =========================================================================

test('DPP: returns all candidates when count <= maxSelect', () => {
    const cands = makeCandidates([
        { vector: V.e1 }, { vector: V.e2 },
    ]);
    const result = applyDPPSampling(cands, 5);
    assert.equal(result.length, 2);
});

test('DPP: returns empty array for empty input', () => {
    const result = applyDPPSampling([], 5);
    assert.equal(result.length, 0);
});

test('DPP: selects maxSelect items when enough candidates', () => {
    const cands = makeCandidates([
        { vector: V.e1, finalScore: 0.8 },
        { vector: V.e2, finalScore: 0.7 },
        { vector: V.e3, finalScore: 0.6 },
        { vector: V.e4, finalScore: 0.5 },
    ]);
    const result = applyDPPSampling(cands, 2);
    assert.equal(result.length, 2);
});

test('DPP: selects diverse items over similar ones', () => {
    const cands = makeCandidates([
        { nodeId: 'a1', vector: [1, 0, 0, 0], finalScore: 0.9 },
        { nodeId: 'a2', vector: [0.99, 0.01, 0, 0], finalScore: 0.85 },
        { nodeId: 'b1', vector: [0, 1, 0, 0], finalScore: 0.8 },
        { nodeId: 'b2', vector: [0.01, 0.99, 0, 0], finalScore: 0.75 },
    ]);
    const result = applyDPPSampling(cands, 2);
    const ids = new Set(result.map(c => c.nodeId));
    const hasClusterA = ids.has('a1') || ids.has('a2');
    const hasClusterB = ids.has('b1') || ids.has('b2');
    assert.ok(hasClusterA && hasClusterB, `Should select from both clusters, got: ${[...ids]}`);
});

test('DPP: high-quality items preferred', () => {
    const cands = makeCandidates([
        { nodeId: 'high', vector: V.e1, finalScore: 10.0 },
        { nodeId: 'low1', vector: V.e2, finalScore: 0.01 },
        { nodeId: 'low2', vector: V.e3, finalScore: 0.01 },
        { nodeId: 'low3', vector: V.e4, finalScore: 0.01 },
    ]);
    const result = applyDPPSampling(cands, 1);
    assert.equal(result[0].nodeId, 'high');
});

test('DPP: preserves candidates without vectors (appended after)', () => {
    const cands = makeCandidates([
        { nodeId: 'v1', vector: V.e1, finalScore: 0.8 },
        { nodeId: 'v2', vector: V.e2, finalScore: 0.7 },
        { nodeId: 'v3', vector: V.e3, finalScore: 0.6 },
        { nodeId: 'v4', vector: V.e4, finalScore: 0.5 },
        { nodeId: 'noVec', finalScore: 0.9 },
    ]);
    const result = applyDPPSampling(cands, 3);
    assert.ok(result.length <= 3);
});

test('DPP: identical vectors degenerate case', () => {
    const cands = makeCandidates([
        { nodeId: 'a', vector: [1, 0, 0, 0], finalScore: 0.5 },
        { nodeId: 'b', vector: [1, 0, 0, 0], finalScore: 0.5 },
        { nodeId: 'c', vector: [1, 0, 0, 0], finalScore: 0.5 },
        { nodeId: 'd', vector: [1, 0, 0, 0], finalScore: 0.5 },
    ]);
    const result = applyDPPSampling(cands, 3);
    assert.ok(result.length >= 1, `Should select at least 1, got ${result.length}`);
});

test('DPP: orthogonal vectors should select all requested', () => {
    const cands = makeCandidates([
        { vector: V.e1, finalScore: 0.5 },
        { vector: V.e2, finalScore: 0.5 },
        { vector: V.e3, finalScore: 0.5 },
        { vector: V.e4, finalScore: 0.5 },
    ]);
    const result = applyDPPSampling(cands, 3);
    assert.equal(result.length, 3);
});

test('DPP: qualityExponent=0 makes all qualities equal', () => {
    const cands = makeCandidates([
        { nodeId: 'low', vector: V.e1, finalScore: 0.01 },
        { nodeId: 'high', vector: V.e2, finalScore: 10.0 },
        { nodeId: 'mid', vector: V.e3, finalScore: 1.0 },
        { nodeId: 'mid2', vector: V.e4, finalScore: 1.0 },
    ]);
    const result = applyDPPSampling(cands, 2, { qualityExponent: 0 });
    assert.equal(result.length, 2);
});

test('DPP: qualityExponent=2 amplifies quality differences', () => {
    const cands = makeCandidates([
        { nodeId: 'high', vector: V.e1, finalScore: 2.0 },
        { nodeId: 'low', vector: V.e2, finalScore: 0.5 },
        { nodeId: 'mid1', vector: V.e3, finalScore: 1.0 },
        { nodeId: 'mid2', vector: V.e4, finalScore: 1.0 },
    ]);
    const result = applyDPPSampling(cands, 1, { qualityExponent: 2 });
    assert.equal(result[0].nodeId, 'high');
});

test('DPP: zero finalScore candidates', () => {
    const cands = makeCandidates([
        { vector: V.e1, finalScore: 0 },
        { vector: V.e2, finalScore: 0 },
        { vector: V.e3, finalScore: 0 },
    ]);
    const result = applyDPPSampling(cands, 2);
    assert.ok(result.length === 0, `Expected 0 selections with zero scores, got ${result.length}`);
});

test('DPP: single candidate returns it', () => {
    const cands = makeCandidates([{ vector: V.e1, finalScore: 1.0 }]);
    const result = applyDPPSampling(cands, 1);
    assert.equal(result.length, 1);
});

test('DPP: maxSelect=0 returns empty', () => {
    const cands = makeCandidates([
        { vector: V.e1, finalScore: 1.0 },
        { vector: V.e2, finalScore: 1.0 },
    ]);
    const result = applyDPPSampling(cands, 0);
    assert.equal(result.length, 0);
});

// =========================================================================
// Summary
// =========================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
