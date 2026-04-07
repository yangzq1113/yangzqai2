// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
//
// Cognitive pipeline operators for memory-graph hybrid recall.
// Algorithms translated from PeroCore/TriviumDB (Apache-2.0) by YoKONCy.
//
// Three operators:
// 1. NMF  — Non-negative Matrix Factorization for topic rebalancing
// 2. FISTA — Fast Iterative Shrinkage-Thresholding for residual discovery
// 3. DPP  — Determinantal Point Process for diversity sampling

// ---------------------------------------------------------------------------
// Vector math helpers
// ---------------------------------------------------------------------------

function dotProduct(a, b) {
    let sum = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) sum += a[i] * b[i];
    return sum;
}

function vecNorm(v) {
    return Math.sqrt(dotProduct(v, v));
}

function vecScale(v, s) {
    return v.map(x => x * s);
}

function vecAdd(a, b) {
    return a.map((x, i) => x + (b[i] || 0));
}

function vecSub(a, b) {
    return a.map((x, i) => x - (b[i] || 0));
}

function cosineSimilarity(a, b) {
    const na = vecNorm(a);
    const nb = vecNorm(b);
    if (na === 0 || nb === 0) return 0;
    return dotProduct(a, b) / (na * nb);
}

function randomPositiveVector(dim) {
    const v = new Array(dim);
    for (let i = 0; i < dim; i++) v[i] = Math.random() * 0.5 + 0.01;
    return v;
}

// ---------------------------------------------------------------------------
// 1. NMF — Non-negative Matrix Factorization (Lee & Seung 1999)
// ---------------------------------------------------------------------------
//
// Decomposes candidate embeddings into K latent topics.
// Then checks if the query's topic distribution is well-covered.
// Under-represented topics get a score boost.

/**
 * Run NMF topic rebalancing on scored candidates.
 *
 * @param {Array<{nodeId: string, finalScore: number, vector?: number[]}>} candidates
 * @param {number[]} queryVector - The query embedding vector.
 * @param {object} [options]
 * @param {number} [options.numTopics=4] - Number of latent topics (K).
 * @param {number} [options.iterations=50] - NMF iteration count.
 * @param {number} [options.boostFactor=0.3] - Max score boost for under-represented topics.
 * @returns {Array} candidates with adjusted finalScore (mutated in place).
 */
export function applyNMFRebalance(candidates, queryVector, options = {}) {
    const { numTopics = 4, iterations = 50, boostFactor = 0.3 } = options;

    const withVectors = candidates.filter(c => Array.isArray(c.vector) && c.vector.length > 0);
    if (withVectors.length < numTopics + 1 || !queryVector?.length) return candidates;

    const dim = withVectors[0].vector.length;
    const n = withVectors.length;
    const k = Math.min(numTopics, Math.max(2, Math.floor(n / 2)));

    // V: n×dim matrix (each row is a candidate embedding)
    const V = withVectors.map(c => c.vector);

    // Initialize W (n×k) and H (k×dim) with random positive values
    let W = Array.from({ length: n }, () => randomPositiveVector(k));
    let H = Array.from({ length: k }, () => randomPositiveVector(dim));

    // Multiplicative update rules (Lee & Seung)
    for (let iter = 0; iter < iterations; iter++) {
        // Update H: H = H * (W^T V) / (W^T W H + eps)
        const WtV = matMul(transpose(W), V, k, n, dim);
        const WtW = matMul(transpose(W), W, k, n, k);
        const WtWH = matMul(WtW, H, k, k, dim);
        for (let i = 0; i < k; i++) {
            for (let j = 0; j < dim; j++) {
                H[i][j] = H[i][j] * (WtV[i][j] / (WtWH[i][j] + 1e-10));
            }
        }

        // Update W: W = W * (V H^T) / (W H H^T + eps)
        const VHt = matMul(V, transpose(H), n, dim, k);
        const HHt = matMul(H, transpose(H), k, dim, k);
        const WHHt = matMul(W, HHt, n, k, k);
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < k; j++) {
                W[i][j] = W[i][j] * (VHt[i][j] / (WHHt[i][j] + 1e-10));
            }
        }
    }

    // W[i] is the topic distribution for candidate i
    // Project query onto topic space: q_topics = query · H^T (pseudo)
    const qTopics = new Array(k);
    for (let t = 0; t < k; t++) {
        qTopics[t] = Math.max(0, dotProduct(queryVector, H[t]) / (vecNorm(H[t]) + 1e-10));
    }
    const qTopicSum = qTopics.reduce((a, b) => a + b, 0) || 1;
    const qTopicDist = qTopics.map(x => x / qTopicSum);

    // Compute current topic coverage from candidates (weighted by score)
    const coverageDist = new Array(k).fill(0);
    let totalWeight = 0;
    for (let i = 0; i < n; i++) {
        const w = withVectors[i].finalScore || 0;
        totalWeight += w;
        for (let t = 0; t < k; t++) {
            coverageDist[t] += W[i][t] * w;
        }
    }
    if (totalWeight > 0) {
        for (let t = 0; t < k; t++) coverageDist[t] /= totalWeight;
    }
    const coverageSum = coverageDist.reduce((a, b) => a + b, 0) || 1;
    for (let t = 0; t < k; t++) coverageDist[t] /= coverageSum;

    // Boost candidates whose dominant topic is under-represented
    for (let i = 0; i < n; i++) {
        const candidateTopics = W[i];
        const topicSum = candidateTopics.reduce((a, b) => a + b, 0) || 1;
        let boost = 0;
        for (let t = 0; t < k; t++) {
            const candidateTopicWeight = candidateTopics[t] / topicSum;
            const deficit = Math.max(0, qTopicDist[t] - coverageDist[t]);
            boost += candidateTopicWeight * deficit;
        }
        withVectors[i].nmfBoost = Math.min(boostFactor, boost * boostFactor * 2);
        withVectors[i].finalScore += withVectors[i].nmfBoost;
    }

    candidates.sort((a, b) => b.finalScore - a.finalScore);
    return candidates;
}

// Matrix multiplication helpers for NMF
function transpose(M) {
    if (!M.length) return [];
    const rows = M.length, cols = M[0].length;
    const T = Array.from({ length: cols }, () => new Array(rows));
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            T[j][i] = M[i][j];
        }
    }
    return T;
}

function matMul(A, B, aRows, aCols, bCols) {
    const C = Array.from({ length: aRows }, () => new Array(bCols).fill(0));
    for (let i = 0; i < aRows; i++) {
        for (let j = 0; j < bCols; j++) {
            let sum = 0;
            for (let p = 0; p < aCols; p++) {
                sum += (A[i]?.[p] || 0) * (B[p]?.[j] || 0);
            }
            C[i][j] = sum;
        }
    }
    return C;
}

// ---------------------------------------------------------------------------
// 2. FISTA — Fast Iterative Shrinkage-Thresholding (Beck & Teboulle 2009)
// ---------------------------------------------------------------------------
//
// Solves: min ||q - Σ(w_i * c_i)||² + λ * Σ|w_i|
// The residual r = q - Σ(w_i * c_i) points toward "missing semantics".
// If ||r|| is large, use r as a new query vector for supplementary retrieval.

/**
 * Compute the semantic residual of the query w.r.t. candidate embeddings.
 *
 * @param {number[]} queryVector - The query embedding.
 * @param {Array<{nodeId: string, vector?: number[]}>} candidates - Candidates with vectors.
 * @param {object} [options]
 * @param {number} [options.lambda=0.1] - L1 regularization strength.
 * @param {number} [options.iterations=30] - FISTA iteration count.
 * @param {number} [options.residualThreshold=0.3] - Trigger supplementary search if residual norm exceeds this.
 * @returns {{residualVector: number[], residualNorm: number, weights: number[], shouldSupplementSearch: boolean}}
 */
export function computeFISTAResidual(queryVector, candidates, options = {}) {
    const { lambda = 0.1, iterations = 30, residualThreshold = 0.3 } = options;

    const withVectors = candidates.filter(c => Array.isArray(c.vector) && c.vector.length > 0);
    if (withVectors.length === 0 || !queryVector?.length) {
        return { residualVector: [], residualNorm: 0, weights: [], shouldSupplementSearch: false };
    }

    const dim = queryVector.length;
    const n = withVectors.length;
    const C = withVectors.map(c => c.vector); // n×dim

    // FISTA: proximal gradient descent for L1-regularized least squares
    let w = new Array(n).fill(0);
    let wPrev = new Array(n).fill(0);
    let t = 1;

    // Compute step size: L = largest eigenvalue of C^T C (approximate with power iteration)
    const L = estimateLipschitz(C, dim, n);
    const stepSize = 1 / (L + 1e-10);

    for (let iter = 0; iter < iterations; iter++) {
        // Momentum (FISTA acceleration)
        const tNext = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
        const momentum = (t - 1) / tNext;
        const y = w.map((wi, i) => wi + momentum * (wi - wPrev[i]));

        // Gradient: ∇f(y) = C^T (C y - q)
        const Cy = matVecMul(C, y, dim);
        const residual = vecSub(Cy, queryVector);
        const grad = new Array(n);
        for (let i = 0; i < n; i++) {
            grad[i] = dotProduct(C[i], residual);
        }

        // Proximal step (soft thresholding for L1)
        wPrev = w.slice();
        w = y.map((yi, i) => {
            const stepped = yi - stepSize * grad[i];
            return softThreshold(stepped, lambda * stepSize);
        });

        t = tNext;
    }

    // Compute reconstruction and residual
    const reconstruction = matVecMul(C, w, dim);
    const residualVector = vecSub(queryVector, reconstruction);
    const residualNorm = vecNorm(residualVector) / (vecNorm(queryVector) + 1e-10);

    return {
        residualVector,
        residualNorm,
        weights: w,
        shouldSupplementSearch: residualNorm > residualThreshold,
    };
}

function softThreshold(x, threshold) {
    if (x > threshold) return x - threshold;
    if (x < -threshold) return x + threshold;
    return 0;
}

function matVecMul(C, w, dim) {
    const result = new Array(dim).fill(0);
    for (let i = 0; i < w.length; i++) {
        if (Math.abs(w[i]) < 1e-12) continue;
        for (let j = 0; j < dim; j++) {
            result[j] += w[i] * (C[i]?.[j] || 0);
        }
    }
    return result;
}

function estimateLipschitz(C, dim, n) {
    // Power iteration to estimate largest singular value of C
    let v = randomPositiveVector(dim);
    let vNorm = vecNorm(v);
    v = v.map(x => x / (vNorm + 1e-10));

    for (let iter = 0; iter < 10; iter++) {
        // u = C v
        const u = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
            u[i] = dotProduct(C[i], v);
        }
        // v_next = C^T u
        const vNext = new Array(dim).fill(0);
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < dim; j++) {
                vNext[j] += u[i] * (C[i]?.[j] || 0);
            }
        }
        vNorm = vecNorm(vNext);
        v = vNext.map(x => x / (vNorm + 1e-10));
    }

    return vNorm;
}

// ---------------------------------------------------------------------------
// 3. DPP — Determinantal Point Process (Kulesza & Taskar 2012)
// ---------------------------------------------------------------------------
//
// Greedy MAP inference: select a subset that maximizes det(L_S).
// L_ij = quality_i * similarity(i,j) * quality_j
// Ensures high quality AND diversity.

/**
 * Apply DPP diversity sampling to select a diverse, high-quality subset.
 *
 * @param {Array<{nodeId: string, finalScore: number, vector?: number[]}>} candidates
 * @param {number} maxSelect - Maximum number of items to select.
 * @param {object} [options]
 * @param {number} [options.qualityExponent=1.0] - Exponent for quality scores.
 * @param {number} [options.similarityFloor=0.0] - Minimum similarity to consider.
 * @returns {Array} Selected candidates (subset of input, preserving order).
 */
export function applyDPPSampling(candidates, maxSelect, options = {}) {
    const { qualityExponent = 1.0, similarityFloor = 0.0 } = options;

    const withVectors = candidates.filter(c => Array.isArray(c.vector) && c.vector.length > 0);
    if (withVectors.length <= maxSelect) return candidates.slice(0, maxSelect);

    const n = withVectors.length;
    const qualities = withVectors.map(c => Math.pow(Math.max(0, c.finalScore || 0), qualityExponent));

    // Build kernel matrix L: L_ij = q_i * sim(i,j) * q_j
    const L = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = i; j < n; j++) {
            const sim = cosineSimilarity(withVectors[i].vector, withVectors[j].vector);
            const effectiveSim = Math.max(similarityFloor, sim);
            const value = qualities[i] * effectiveSim * qualities[j];
            L[i][j] = value;
            L[j][i] = value;
        }
    }

    // Greedy MAP: iteratively select item with largest marginal gain
    const selected = [];
    const selectedSet = new Set();
    // Track Cholesky-like incremental det computation via marginal gains
    // Simplified: use the diagonal dominance heuristic
    const cInv = []; // Incremental inverse tracking (simplified)

    for (let round = 0; round < maxSelect; round++) {
        let bestIdx = -1;
        let bestGain = -Infinity;

        for (let i = 0; i < n; i++) {
            if (selectedSet.has(i)) continue;

            // Marginal gain = L_ii - sum of squared correlations with selected items
            let gain = L[i][i];
            for (const j of selected) {
                const corr = L[i][j] / (Math.sqrt(L[i][i] * L[j][j]) + 1e-10);
                gain -= corr * corr * L[j][j];
            }

            if (gain > bestGain) {
                bestGain = gain;
                bestIdx = i;
            }
        }

        if (bestIdx < 0 || bestGain <= 0) break;
        selected.push(bestIdx);
        selectedSet.add(bestIdx);
    }

    // Map back to original candidates
    const selectedNodeIds = new Set(selected.map(i => withVectors[i].nodeId));
    const result = candidates.filter(c => selectedNodeIds.has(c.nodeId));

    // Append non-vector candidates that didn't participate in DPP
    const withoutVectors = candidates.filter(c => !Array.isArray(c.vector) || c.vector.length === 0);
    const remaining = maxSelect - result.length;
    if (remaining > 0 && withoutVectors.length > 0) {
        result.push(...withoutVectors.slice(0, remaining));
    }

    return result;
}
