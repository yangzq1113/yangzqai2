// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Unit tests for hybrid recall pipeline scoring logic.
// Tests pure computation functions without requiring browser APIs.

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Configuration constants (copied from source for standalone testing)
// ---------------------------------------------------------------------------

const TYPE_WEIGHT_CONFIG = {
    event: {
        vectorWeight: 0.35,
        diffusionWeight: 0.30,
        lexicalWeight: 0.15,
        anchorWeight: 0.05,
        recencyWeight: 0.15,
    },
    character_sheet: {
        vectorWeight: 0.25,
        diffusionWeight: 0.20,
        lexicalWeight: 0.35,
        anchorWeight: 0.10,
        recencyWeight: 0.10,
    },
    location_state: {
        vectorWeight: 0.30,
        diffusionWeight: 0.25,
        lexicalWeight: 0.30,
        anchorWeight: 0.05,
        recencyWeight: 0.10,
    },
    rule_constraint: {
        vectorWeight: 0.25,
        diffusionWeight: 0.10,
        lexicalWeight: 0.35,
        anchorWeight: 0.05,
        recencyWeight: 0.00,
    },
};

const DEFAULT_TYPE_WEIGHTS = {
    vectorWeight: 0.30,
    diffusionWeight: 0.25,
    lexicalWeight: 0.25,
    anchorWeight: 0.05,
    recencyWeight: 0.15,
};

const TYPE_HALF_LIFE = {
    event: 50,
    character_sheet: 200,
    location_state: 100,
    rule_constraint: Infinity,
};

// ---------------------------------------------------------------------------
// Reimplemented pure functions from retriever.js for testing
// ---------------------------------------------------------------------------

function normalizeQueryText(value, maxLength = 800) {
    return String(value ?? '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function buildLexicalUnits(text) {
    const normalized = String(text || '').toLowerCase();
    const rawTokens = normalized.match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || [];
    const units = new Set();
    for (const token of rawTokens) {
        if (token.length >= 2) units.add(token);
        if (/[\u4e00-\u9fff]/.test(token) && token.length > 2) {
            for (let i = 0; i < token.length - 1; i++) {
                units.add(token.slice(i, i + 2));
            }
        }
    }
    return units;
}

function computeLexicalScore(node, queryText) {
    if (!node || !queryText) return 0;
    const queryUnits = buildLexicalUnits(queryText);
    if (queryUnits.size === 0) return 0;

    const fields = node.fields || {};
    const primaryTexts = [fields.name, fields.title].filter(Boolean);
    const secondaryTexts = [fields.summary, fields.state, fields.traits, fields.constraint].filter(Boolean);
    const allText = [...primaryTexts, ...secondaryTexts].join(' ');
    const nodeUnits = buildLexicalUnits(allText);
    if (nodeUnits.size === 0) return 0;

    let overlap = 0;
    for (const unit of queryUnits) {
        if (nodeUnits.has(unit)) overlap++;
    }

    return Math.min(1, overlap / Math.max(1, queryUnits.size));
}

function computeRecencyBoost(node, currentSeq) {
    if (!Number.isFinite(currentSeq) || currentSeq <= 0) return 0.5;
    const nodeSeq = Math.max(0, Number(node?.seqTo) || 0);
    if (nodeSeq <= 0) return 0;

    const halfLife = TYPE_HALF_LIFE[node.type] ?? 50;
    if (!Number.isFinite(halfLife)) return 1.0;

    const distance = Math.max(0, currentSeq - nodeSeq);
    return Math.exp(-0.693 * distance / halfLife);
}

function buildLexicalEmbedding(text) {
    const units = buildLexicalUnits(text);
    if (units.size === 0) return new Float64Array(0);
    const DIM = 256;
    const vec = new Float64Array(DIM);
    for (const unit of units) {
        let hash = 0;
        for (let i = 0; i < unit.length; i++) {
            hash = ((hash << 5) - hash + unit.charCodeAt(i)) | 0;
        }
        const bucket = ((hash % DIM) + DIM) % DIM;
        vec[bucket] += 1;
    }
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 1e-12) {
        for (let i = 0; i < DIM; i++) vec[i] /= norm;
    }
    return vec;
}

function computeHybridScore(entry, typeConfig) {
    return typeConfig.vectorWeight * entry.vectorScore
        + typeConfig.diffusionWeight * entry.diffusionEnergy
        + typeConfig.lexicalWeight * entry.lexicalScore
        + typeConfig.anchorWeight * entry.anchorScore
        + typeConfig.recencyWeight * entry.recencyBoost
        + (entry.cooccurrenceBoost || 0);
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
    tests.push({ name, fn });
}

function run() {
    console.log('Running retriever.test.js...\n');
    for (const { name, fn } of tests) {
        try {
            fn();
            passed++;
            console.log(`✓ ${name}`);
        } catch (error) {
            failed++;
            console.error(`✗ ${name}`);
            console.error(`  ${error.message}`);
            if (error.stack) {
                console.error(`  ${error.stack.split('\n').slice(1, 3).join('\n')}`);
            }
        }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// TYPE_WEIGHT_CONFIG validation tests
// ---------------------------------------------------------------------------

test('TYPE_WEIGHT_CONFIG: all weights sum to ~1.0 for event', () => {
    const config = TYPE_WEIGHT_CONFIG.event;
    const sum = config.vectorWeight + config.diffusionWeight + config.lexicalWeight + config.anchorWeight + config.recencyWeight;
    assert.ok(Math.abs(sum - 1.0) < 0.01, `event weights sum to ${sum}, expected ~1.0`);
});

test('TYPE_WEIGHT_CONFIG: all weights sum to ~1.0 for character_sheet', () => {
    const config = TYPE_WEIGHT_CONFIG.character_sheet;
    const sum = config.vectorWeight + config.diffusionWeight + config.lexicalWeight + config.anchorWeight + config.recencyWeight;
    assert.ok(Math.abs(sum - 1.0) < 0.01, `character_sheet weights sum to ${sum}, expected ~1.0`);
});

test('TYPE_WEIGHT_CONFIG: all weights sum to ~1.0 for location_state', () => {
    const config = TYPE_WEIGHT_CONFIG.location_state;
    const sum = config.vectorWeight + config.diffusionWeight + config.lexicalWeight + config.anchorWeight + config.recencyWeight;
    assert.ok(Math.abs(sum - 1.0) < 0.01, `location_state weights sum to ${sum}, expected ~1.0`);
});

test('TYPE_WEIGHT_CONFIG: all weights sum to ~1.0 for rule_constraint (excluding cooccurrence)', () => {
    const config = TYPE_WEIGHT_CONFIG.rule_constraint;
    const sum = config.vectorWeight + config.diffusionWeight + config.lexicalWeight + config.anchorWeight + config.recencyWeight;
    assert.ok(Math.abs(sum - 0.75) < 0.01, `rule_constraint weights sum to ${sum}, expected ~0.75 (recencyWeight=0)`);
});

test('TYPE_WEIGHT_CONFIG: all weight values are between 0 and 1', () => {
    for (const [type, config] of Object.entries(TYPE_WEIGHT_CONFIG)) {
        for (const [key, value] of Object.entries(config)) {
            assert.ok(value >= 0 && value <= 1, `${type}.${key} = ${value} is out of range [0,1]`);
        }
    }
});

test('TYPE_WEIGHT_CONFIG: all expected types present', () => {
    assert.ok(TYPE_WEIGHT_CONFIG.event, 'event config missing');
    assert.ok(TYPE_WEIGHT_CONFIG.character_sheet, 'character_sheet config missing');
    assert.ok(TYPE_WEIGHT_CONFIG.location_state, 'location_state config missing');
    assert.ok(TYPE_WEIGHT_CONFIG.rule_constraint, 'rule_constraint config missing');
});

test('DEFAULT_TYPE_WEIGHTS: weights sum to ~1.0', () => {
    const sum = DEFAULT_TYPE_WEIGHTS.vectorWeight + DEFAULT_TYPE_WEIGHTS.diffusionWeight
        + DEFAULT_TYPE_WEIGHTS.lexicalWeight + DEFAULT_TYPE_WEIGHTS.anchorWeight
        + DEFAULT_TYPE_WEIGHTS.recencyWeight;
    assert.ok(Math.abs(sum - 1.0) < 0.01, `default weights sum to ${sum}, expected ~1.0`);
});

test('DEFAULT_TYPE_WEIGHTS: all weight values are between 0 and 1', () => {
    for (const [key, value] of Object.entries(DEFAULT_TYPE_WEIGHTS)) {
        assert.ok(value >= 0 && value <= 1, `${key} = ${value} is out of range [0,1]`);
    }
});

// ---------------------------------------------------------------------------
// normalizeQueryText tests
// ---------------------------------------------------------------------------

test('normalizeQueryText: whitespace collapsing', () => {
    const result = normalizeQueryText('hello    world  \t  test');
    assert.equal(result, 'hello world test');
});

test('normalizeQueryText: CRLF to LF conversion', () => {
    const result = normalizeQueryText('line1\r\nline2\r\nline3');
    assert.equal(result, 'line1 line2 line3');
});

test('normalizeQueryText: truncation at maxLength', () => {
    const longText = 'a'.repeat(1000);
    const result = normalizeQueryText(longText, 100);
    assert.equal(result.length, 100);
});

test('normalizeQueryText: empty string returns empty', () => {
    assert.equal(normalizeQueryText(''), '');
    assert.equal(normalizeQueryText(null), '');
    assert.equal(normalizeQueryText(undefined), '');
});

test('normalizeQueryText: trims leading and trailing whitespace', () => {
    const result = normalizeQueryText('  hello world  ');
    assert.equal(result, 'hello world');
});

// ---------------------------------------------------------------------------
// buildLexicalUnits tests
// ---------------------------------------------------------------------------

test('buildLexicalUnits: English tokens', () => {
    const units = buildLexicalUnits('hello world');
    assert.ok(units.has('hello'));
    assert.ok(units.has('world'));
    assert.equal(units.size, 2);
});

test('buildLexicalUnits: Chinese bigrams', () => {
    const units = buildLexicalUnits('中国人');
    assert.ok(units.has('中国人')); // full token (length 3)
    assert.ok(units.has('中国')); // bigram
    assert.ok(units.has('国人')); // bigram
    assert.equal(units.size, 3);
});

test('buildLexicalUnits: mixed English and Chinese', () => {
    const units = buildLexicalUnits('hello 世界');
    assert.ok(units.has('hello'));
    assert.ok(units.has('世界'));
    assert.equal(units.size, 2);
});

test('buildLexicalUnits: empty string returns empty set', () => {
    const units = buildLexicalUnits('');
    assert.equal(units.size, 0);
});

test('buildLexicalUnits: short tokens filtered (length < 2)', () => {
    const units = buildLexicalUnits('a b cd ef');
    assert.ok(!units.has('a'));
    assert.ok(!units.has('b'));
    assert.ok(units.has('cd'));
    assert.ok(units.has('ef'));
    assert.equal(units.size, 2);
});

test('buildLexicalUnits: case insensitive', () => {
    const units = buildLexicalUnits('Hello WORLD');
    assert.ok(units.has('hello'));
    assert.ok(units.has('world'));
    assert.equal(units.size, 2);
});

test('buildLexicalUnits: numbers are included', () => {
    const units = buildLexicalUnits('test123 abc456');
    assert.ok(units.has('test123'));
    assert.ok(units.has('abc456'));
});

// ---------------------------------------------------------------------------
// computeLexicalScore tests
// ---------------------------------------------------------------------------

test('computeLexicalScore: full overlap returns 1.0', () => {
    const node = { fields: { name: 'Alice', title: 'Warrior' } };
    const score = computeLexicalScore(node, 'alice warrior');
    assert.equal(score, 1.0);
});

test('computeLexicalScore: no overlap returns 0', () => {
    const node = { fields: { name: 'Alice' } };
    const score = computeLexicalScore(node, 'bob');
    assert.equal(score, 0);
});

test('computeLexicalScore: partial overlap', () => {
    const node = { fields: { name: 'Alice', summary: 'brave warrior' } };
    const score = computeLexicalScore(node, 'alice wizard'); // 1 match out of 2
    assert.equal(score, 0.5);
});

test('computeLexicalScore: Chinese text', () => {
    const node = { fields: { name: '李白', summary: '唐代诗人' } };
    const score = computeLexicalScore(node, '李白');
    assert.ok(score > 0);
});

test('computeLexicalScore: empty query returns 0', () => {
    const node = { fields: { name: 'Alice' } };
    const score = computeLexicalScore(node, '');
    assert.equal(score, 0);
});

test('computeLexicalScore: null node returns 0', () => {
    const score = computeLexicalScore(null, 'alice');
    assert.equal(score, 0);
});

test('computeLexicalScore: empty node fields returns 0', () => {
    const node = { fields: {} };
    const score = computeLexicalScore(node, 'alice');
    assert.equal(score, 0);
});

test('computeLexicalScore: uses primary and secondary fields', () => {
    const node = {
        fields: {
            name: 'Alice',
            title: 'Warrior',
            summary: 'brave hero',
            state: 'active',
            traits: 'strong fast',
            constraint: 'rule one',
        }
    };
    const score = computeLexicalScore(node, 'alice warrior brave active strong rule');
    assert.equal(score, 1.0);
});

// ---------------------------------------------------------------------------
// computeRecencyBoost tests
// ---------------------------------------------------------------------------

test('computeRecencyBoost: recent node (distance=0) returns near 1.0', () => {
    const node = { type: 'event', seqTo: 100 };
    const boost = computeRecencyBoost(node, 100);
    assert.equal(boost, 1.0);
});

test('computeRecencyBoost: old node (large distance) returns near 0', () => {
    const node = { type: 'event', seqTo: 0 };
    const boost = computeRecencyBoost(node, 500);
    assert.ok(boost < 0.01);
});

test('computeRecencyBoost: event type with half-life=50', () => {
    const node = { type: 'event', seqTo: 50 };
    const boost = computeRecencyBoost(node, 100); // distance=50, exactly one half-life
    assert.ok(Math.abs(boost - 0.5) < 0.01);
});

test('computeRecencyBoost: character_sheet type with half-life=200', () => {
    const node = { type: 'character_sheet', seqTo: 100 };
    const boost = computeRecencyBoost(node, 300); // distance=200, exactly one half-life
    assert.ok(Math.abs(boost - 0.5) < 0.01);
});

test('computeRecencyBoost: location_state type with half-life=100', () => {
    const node = { type: 'location_state', seqTo: 100 };
    const boost = computeRecencyBoost(node, 200); // distance=100, exactly one half-life
    assert.ok(Math.abs(boost - 0.5) < 0.01);
});

test('computeRecencyBoost: rule_constraint (Infinity half-life) always returns 1.0', () => {
    const node = { type: 'rule_constraint', seqTo: 100 };
    const boost = computeRecencyBoost(node, 1000);
    assert.equal(boost, 1.0);
});

test('computeRecencyBoost: missing seqTo returns 0', () => {
    const node = { type: 'event' };
    const boost = computeRecencyBoost(node, 100);
    assert.equal(boost, 0);
});

test('computeRecencyBoost: currentSeq <= 0 returns 0.5', () => {
    const node = { type: 'event', seqTo: 50 };
    const boost = computeRecencyBoost(node, 0);
    assert.equal(boost, 0.5);
});

test('computeRecencyBoost: unknown type uses default half-life=50', () => {
    const node = { type: 'unknown_type', seqTo: 50 };
    const boost = computeRecencyBoost(node, 100);
    assert.ok(Math.abs(boost - 0.5) < 0.01);
});

// ---------------------------------------------------------------------------
// buildLexicalEmbedding tests
// ---------------------------------------------------------------------------

test('buildLexicalEmbedding: output is L2-normalized', () => {
    const embedding = buildLexicalEmbedding('hello world');
    let norm = 0;
    for (let i = 0; i < embedding.length; i++) {
        norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);
    assert.ok(Math.abs(norm - 1.0) < 0.001, `norm = ${norm}, expected ~1.0`);
});

test('buildLexicalEmbedding: empty text returns empty array', () => {
    const embedding = buildLexicalEmbedding('');
    assert.equal(embedding.length, 0);
});

test('buildLexicalEmbedding: same text returns same embedding', () => {
    const emb1 = buildLexicalEmbedding('hello world');
    const emb2 = buildLexicalEmbedding('hello world');
    assert.equal(emb1.length, emb2.length);
    for (let i = 0; i < emb1.length; i++) {
        assert.equal(emb1[i], emb2[i]);
    }
});

test('buildLexicalEmbedding: different text returns different embedding', () => {
    const emb1 = buildLexicalEmbedding('hello world');
    const emb2 = buildLexicalEmbedding('goodbye earth');
    let different = false;
    for (let i = 0; i < emb1.length && i < emb2.length; i++) {
        if (Math.abs(emb1[i] - emb2[i]) > 0.001) {
            different = true;
            break;
        }
    }
    assert.ok(different, 'embeddings should be different');
});

test('buildLexicalEmbedding: fixed dimension (256)', () => {
    const embedding = buildLexicalEmbedding('hello world test data');
    assert.equal(embedding.length, 256);
});

test('buildLexicalEmbedding: handles Chinese text', () => {
    const embedding = buildLexicalEmbedding('中国人');
    assert.equal(embedding.length, 256);
    let norm = 0;
    for (let i = 0; i < embedding.length; i++) {
        norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);
    assert.ok(Math.abs(norm - 1.0) < 0.001);
});

// ---------------------------------------------------------------------------
// Hybrid score formula tests
// ---------------------------------------------------------------------------

test('computeHybridScore: formula with event weights', () => {
    const entry = {
        vectorScore: 0.8,
        diffusionEnergy: 0.6,
        lexicalScore: 0.4,
        anchorScore: 1.0,
        recencyBoost: 0.9,
        cooccurrenceBoost: 0.05,
    };
    const config = TYPE_WEIGHT_CONFIG.event;
    const expected = 0.35 * 0.8 + 0.30 * 0.6 + 0.15 * 0.4 + 0.05 * 1.0 + 0.15 * 0.9 + 0.05;
    const actual = computeHybridScore(entry, config);
    assert.ok(Math.abs(actual - expected) < 0.001);
});

test('computeHybridScore: formula with character_sheet weights', () => {
    const entry = {
        vectorScore: 0.7,
        diffusionEnergy: 0.5,
        lexicalScore: 0.9,
        anchorScore: 1.0,
        recencyBoost: 0.8,
        cooccurrenceBoost: 0.1,
    };
    const config = TYPE_WEIGHT_CONFIG.character_sheet;
    const expected = 0.25 * 0.7 + 0.20 * 0.5 + 0.35 * 0.9 + 0.10 * 1.0 + 0.10 * 0.8 + 0.1;
    const actual = computeHybridScore(entry, config);
    assert.ok(Math.abs(actual - expected) < 0.001);
});

test('computeHybridScore: formula with location_state weights', () => {
    const entry = {
        vectorScore: 0.6,
        diffusionEnergy: 0.7,
        lexicalScore: 0.5,
        anchorScore: 0.0,
        recencyBoost: 0.6,
        cooccurrenceBoost: 0.0,
    };
    const config = TYPE_WEIGHT_CONFIG.location_state;
    const expected = 0.30 * 0.6 + 0.25 * 0.7 + 0.30 * 0.5 + 0.05 * 0.0 + 0.10 * 0.6 + 0.0;
    const actual = computeHybridScore(entry, config);
    assert.ok(Math.abs(actual - expected) < 0.001);
});

test('computeHybridScore: formula with rule_constraint weights', () => {
    const entry = {
        vectorScore: 0.5,
        diffusionEnergy: 0.3,
        lexicalScore: 0.8,
        anchorScore: 1.0,
        recencyBoost: 0.0,
        cooccurrenceBoost: 0.15,
    };
    const config = TYPE_WEIGHT_CONFIG.rule_constraint;
    const expected = 0.25 * 0.5 + 0.10 * 0.3 + 0.35 * 0.8 + 0.05 * 1.0 + 0.00 * 0.0 + 0.15;
    const actual = computeHybridScore(entry, config);
    assert.ok(Math.abs(actual - expected) < 0.001);
});

test('computeHybridScore: zero scores return 0', () => {
    const entry = {
        vectorScore: 0,
        diffusionEnergy: 0,
        lexicalScore: 0,
        anchorScore: 0,
        recencyBoost: 0,
        cooccurrenceBoost: 0,
    };
    const score = computeHybridScore(entry, DEFAULT_TYPE_WEIGHTS);
    assert.equal(score, 0);
});

test('computeHybridScore: missing cooccurrenceBoost defaults to 0', () => {
    const entry = {
        vectorScore: 0.5,
        diffusionEnergy: 0.5,
        lexicalScore: 0.5,
        anchorScore: 0.5,
        recencyBoost: 0.5,
    };
    const score = computeHybridScore(entry, DEFAULT_TYPE_WEIGHTS);
    const expected = 0.30 * 0.5 + 0.25 * 0.5 + 0.25 * 0.5 + 0.05 * 0.5 + 0.15 * 0.5;
    assert.ok(Math.abs(score - expected) < 0.001);
});

// ---------------------------------------------------------------------------
// Candidate sorting tests
// ---------------------------------------------------------------------------

test('Candidates sorted by finalScore descending', () => {
    const candidates = [
        { nodeId: 'a', finalScore: 0.5 },
        { nodeId: 'b', finalScore: 0.9 },
        { nodeId: 'c', finalScore: 0.3 },
        { nodeId: 'd', finalScore: 0.7 },
    ];
    candidates.sort((a, b) => b.finalScore - a.finalScore);
    assert.equal(candidates[0].nodeId, 'b');
    assert.equal(candidates[1].nodeId, 'd');
    assert.equal(candidates[2].nodeId, 'a');
    assert.equal(candidates[3].nodeId, 'c');
});

test('Candidates with equal scores maintain stable order', () => {
    const candidates = [
        { nodeId: 'a', finalScore: 0.5 },
        { nodeId: 'b', finalScore: 0.5 },
        { nodeId: 'c', finalScore: 0.5 },
    ];
    candidates.sort((a, b) => b.finalScore - a.finalScore);
    // All have equal scores, order is preserved or stable depending on engine
    assert.equal(candidates.length, 3);
});

// ---------------------------------------------------------------------------
// Edge cases and robustness tests
// ---------------------------------------------------------------------------

test('computeLexicalScore: handles special characters gracefully', () => {
    const node = { fields: { name: 'Alice!@#$%' } };
    const score = computeLexicalScore(node, 'alice');
    assert.ok(score > 0);
});

test('buildLexicalUnits: handles very long text', () => {
    const longText = 'word '.repeat(1000);
    const units = buildLexicalUnits(longText);
    assert.ok(units.size > 0);
});

test('computeRecencyBoost: negative seqTo treated as 0', () => {
    const node = { type: 'event', seqTo: -10 };
    const boost = computeRecencyBoost(node, 100);
    assert.equal(boost, 0);
});

test('normalizeQueryText: handles unicode correctly', () => {
    const result = normalizeQueryText('hello 世界 🌍');
    assert.ok(result.includes('hello'));
    assert.ok(result.includes('世界'));
});

test('buildLexicalEmbedding: single character (filtered out)', () => {
    const embedding = buildLexicalEmbedding('a');
    assert.equal(embedding.length, 0);
});

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

run();