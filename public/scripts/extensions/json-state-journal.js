// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { DiffMatchPatch } from '../../lib.js';
import { create as createDiffPatcher } from '../vendor/diffpatch/index.js';

export const DEFAULT_JSON_STATE_TEXTDIFF_MIN_LENGTH = 80;

export function cloneJsonValue(value, fallback = {}) {
    try {
        return structuredClone(value);
    } catch {
        return fallback;
    }
}

export function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createJsonStateDiffPatcher({
    textDiffMinLength = DEFAULT_JSON_STATE_TEXTDIFF_MIN_LENGTH,
    objectHash = null,
    propertyFilter = null,
} = {}) {
    return createDiffPatcher({
        objectHash: typeof objectHash === 'function' ? objectHash : undefined,
        propertyFilter: typeof propertyFilter === 'function' ? propertyFilter : undefined,
        arrays: {
            detectMove: true,
            includeValueOnMove: false,
        },
        textDiff: {
            minLength: Number.isFinite(Number(textDiffMinLength)) ? Number(textDiffMinLength) : DEFAULT_JSON_STATE_TEXTDIFF_MIN_LENGTH,
            diffMatchPatch: DiffMatchPatch,
        },
        cloneDiffValues: true,
    });
}

export function buildJsonStateDelta(diffPatcher, before, after) {
    const safeBefore = cloneJsonValue(before, {});
    const safeAfter = cloneJsonValue(after, {});
    const delta = diffPatcher.diff(safeBefore, safeAfter);
    return delta ? cloneJsonValue(delta, delta) : null;
}

export function reverseJsonStateDelta(diffPatcher, delta) {
    if (!delta || typeof delta !== 'object') {
        return null;
    }
    const reversed = diffPatcher.reverse(cloneJsonValue(delta, delta));
    return reversed ? cloneJsonValue(reversed, reversed) : null;
}

export function applyJsonStateDelta(diffPatcher, snapshot, delta) {
    const safeSnapshot = cloneJsonValue(snapshot, {});
    if (!delta || typeof delta !== 'object') {
        return safeSnapshot;
    }
    const nextSnapshot = diffPatcher.patch(safeSnapshot, cloneJsonValue(delta, delta));
    return cloneJsonValue(nextSnapshot, nextSnapshot);
}

export function replayJsonStateJournal(diffPatcher, baseSnapshot, entries, {
    includeEntry = null,
} = {}) {
    const list = Array.isArray(entries) ? entries : [];
    let snapshot = cloneJsonValue(baseSnapshot, {});
    for (const entry of list) {
        if (typeof includeEntry === 'function' && !includeEntry(entry)) {
            continue;
        }
        if (!entry?.delta || typeof entry.delta !== 'object') {
            continue;
        }
        snapshot = applyJsonStateDelta(diffPatcher, snapshot, entry.delta);
    }
    return snapshot;
}

export function extractJsonStateTouchedPaths(delta) {
    const touched = new Set();

    function addPath(segments) {
        if (!Array.isArray(segments) || segments.length === 0) {
            return;
        }
        touched.add(formatJsonPath(segments));
    }

    function visit(node, segments) {
        if (node === null || node === undefined) {
            addPath(segments);
            return;
        }

        if (Array.isArray(node)) {
            addPath(segments);
            return;
        }

        if (typeof node !== 'object') {
            addPath(segments);
            return;
        }

        if (node._t === 'a') {
            // Array deltas are conservative: mark the full array path as touched,
            // then keep descending so nested object updates still show specific paths.
            addPath(segments);
            for (const [key, value] of Object.entries(node)) {
                if (key === '_t') {
                    continue;
                }
                visit(value, [...segments, normalizeArrayDeltaKey(key)]);
            }
            return;
        }

        const keys = Object.keys(node).filter(key => key !== '_t');
        if (keys.length === 0) {
            addPath(segments);
            return;
        }

        for (const key of keys) {
            visit(node[key], [...segments, key]);
        }
    }

    visit(delta, []);
    return [...touched].sort((left, right) => left.localeCompare(right));
}

export function jsonStatePathsOverlap(leftPath, rightPath) {
    const leftSegments = tokenizeJsonPath(leftPath);
    const rightSegments = tokenizeJsonPath(rightPath);
    if (leftSegments.length === 0 || rightSegments.length === 0) {
        return false;
    }
    const minLength = Math.min(leftSegments.length, rightSegments.length);
    for (let index = 0; index < minLength; index += 1) {
        if (leftSegments[index] !== rightSegments[index]) {
            return false;
        }
    }
    return true;
}

export function hasJsonStatePathConflict(leftPaths, rightPaths) {
    const leftList = Array.isArray(leftPaths) ? leftPaths.filter(Boolean) : [];
    const rightList = Array.isArray(rightPaths) ? rightPaths.filter(Boolean) : [];
    for (const leftPath of leftList) {
        for (const rightPath of rightList) {
            if (jsonStatePathsOverlap(leftPath, rightPath)) {
                return true;
            }
        }
    }
    return false;
}

export function formatJsonPath(segments) {
    return (Array.isArray(segments) ? segments : []).map((segment, index) => {
        if (typeof segment === 'number') {
            return `[${segment}]`;
        }
        const text = String(segment ?? '');
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) {
            return index === 0 ? text : `.${text}`;
        }
        return `[${JSON.stringify(text)}]`;
    }).join('');
}

export function tokenizeJsonPath(path) {
    const text = String(path || '').trim();
    const tokens = [];
    const regex = /([A-Za-z_$][A-Za-z0-9_$]*)|\[(\d+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\]/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        if (match[1]) {
            tokens.push(match[1]);
            continue;
        }
        const rawBracketValue = String(match[2] || '');
        if (/^\d+$/.test(rawBracketValue)) {
            tokens.push(Number(rawBracketValue));
            continue;
        }
        try {
            tokens.push(JSON.parse(rawBracketValue.replace(/^'/, '"').replace(/'$/, '"')));
        } catch {
            tokens.push(rawBracketValue.replace(/^["']|["']$/g, ''));
        }
    }
    return tokens;
}

function normalizeArrayDeltaKey(key) {
    const text = String(key || '').trim();
    if (!text) {
        return 0;
    }
    const normalized = text.startsWith('_') ? text.slice(1) : text;
    const numeric = Number(normalized);
    return Number.isInteger(numeric) ? numeric : normalized;
}
