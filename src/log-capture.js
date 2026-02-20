import util from 'node:util';

const WRAPPED_ORIGINAL = Symbol('luker.log.capture.original');
const LOG_LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
const DEFAULT_CAPACITY = 2000;

/** @type {{ id: number; timestamp: number; level: string; message: string }[]} */
const entries = [];

let nextId = 1;
const capacity = DEFAULT_CAPACITY;

function toSafeString(value) {
    if (typeof value === 'string') {
        return value;
    }

    return util.inspect(value, {
        depth: 8,
        maxArrayLength: null,
        maxStringLength: null,
        breakLength: 140,
        compact: 2,
    });
}

function appendEntry(level, args) {
    const message = args.map(toSafeString).join(' ');
    entries.push({
        id: nextId++,
        timestamp: Date.now(),
        level,
        message,
    });

    if (entries.length > capacity) {
        entries.splice(0, entries.length - capacity);
    }
}

function getBaseMethod(method) {
    if (typeof method !== 'function') {
        return () => { };
    }

    if (Object.prototype.hasOwnProperty.call(method, WRAPPED_ORIGINAL)) {
        return method[WRAPPED_ORIGINAL];
    }

    return method.bind(globalThis.console);
}

/**
 * Installs console method wrappers so logs can be queried from the frontend.
 * Calling this more than once is safe and will not double-capture logs.
 */
export function installLogCapture() {
    for (const level of LOG_LEVELS) {
        const current = globalThis.console[level];
        const base = getBaseMethod(current);

        /** @type {(...args: any[]) => void} */
        const wrapped = (...args) => {
            appendEntry(level, args);
            base(...args);
        };

        wrapped[WRAPPED_ORIGINAL] = base;
        globalThis.console[level] = wrapped;
    }
}

/**
 * Clears all captured entries.
 */
export function clearCapturedLogs() {
    entries.length = 0;
}

/**
 * Gets captured logs.
 * @param {{ sinceId?: number; limit?: number; levels?: string[] }} [options]
 * @returns {{ entries: { id: number; timestamp: number; level: string; message: string }[]; latestId: number }}
 */
export function getCapturedLogs(options = {}) {
    const sinceId = Number.isFinite(Number(options.sinceId)) ? Math.max(0, Math.floor(Number(options.sinceId))) : 0;
    const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.floor(Number(options.limit))) : 500;
    const normalizedLevels = Array.isArray(options.levels)
        ? new Set(options.levels.map(level => String(level || '').toLowerCase()).filter(level => LOG_LEVELS.includes(level)))
        : null;

    let filtered = entries;
    if (sinceId > 0) {
        filtered = filtered.filter(entry => entry.id > sinceId);
    }

    if (normalizedLevels && normalizedLevels.size > 0) {
        filtered = filtered.filter(entry => normalizedLevels.has(entry.level));
    }

    if (filtered.length > limit) {
        filtered = filtered.slice(filtered.length - limit);
    }

    return {
        entries: filtered.map(entry => ({ ...entry })),
        latestId: entries.length > 0 ? entries[entries.length - 1].id : 0,
    };
}
