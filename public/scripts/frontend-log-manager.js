const FRONTEND_LOG_LIMIT = 3000;
const ALWAYS_VISIBLE_LEVELS = new Set(['error']);
const WRAPPED_CONSOLE_LEVELS = Object.freeze(['trace', 'debug', 'log', 'info', 'warn', 'error']);

const frontendLogBuffer = [];
const baseConsoleMethods = new Map();

let frontendLogNextId = 1;
let frontendLogCaptureInstalled = false;
let frontendConsoleDebugLoggingEnabled = false;

function normalizeLevel(level) {
    const normalized = String(level || 'log').toLowerCase();
    return WRAPPED_CONSOLE_LEVELS.includes(normalized) ? normalized : 'log';
}

function shouldEmitConsoleLevel(level) {
    return ALWAYS_VISIBLE_LEVELS.has(level) || frontendConsoleDebugLoggingEnabled;
}

function serializeFrontendLogValue(value) {
    if (value instanceof Error) {
        return value.stack || `${value.name}: ${value.message}`;
    }

    if (typeof value === 'string') {
        return value;
    }

    if (value === undefined) {
        return 'undefined';
    }

    if (value === null) {
        return 'null';
    }

    if (typeof value === 'function') {
        return `[Function ${value.name || 'anonymous'}]`;
    }

    try {
        return JSON.stringify(value, (_, nestedValue) => {
            if (nestedValue instanceof Error) {
                return nestedValue.stack || `${nestedValue.name}: ${nestedValue.message}`;
            }
            if (typeof nestedValue === 'bigint') {
                return `${nestedValue}n`;
            }
            return nestedValue;
        });
    } catch {
        return String(value);
    }
}

function getBaseConsoleMethod(level) {
    const normalizedLevel = normalizeLevel(level);

    if (!baseConsoleMethods.has(normalizedLevel)) {
        const current = globalThis.console?.[normalizedLevel];
        baseConsoleMethods.set(
            normalizedLevel,
            typeof current === 'function'
                ? current.bind(globalThis.console)
                : () => { },
        );
    }

    return baseConsoleMethods.get(normalizedLevel);
}

function pushFrontendLog(level, values, source = 'console') {
    const normalizedLevel = normalizeLevel(level);
    const normalizedSource = String(source || 'console');

    if (normalizedSource === 'console' && !shouldEmitConsoleLevel(normalizedLevel)) {
        return false;
    }

    const message = Array.isArray(values)
        ? values.map(serializeFrontendLogValue).join(' ')
        : serializeFrontendLogValue(values);

    frontendLogBuffer.push({
        id: frontendLogNextId++,
        timestamp: Date.now(),
        level: normalizedLevel,
        source: normalizedSource,
        message: String(message || ''),
    });

    if (frontendLogBuffer.length > FRONTEND_LOG_LIMIT) {
        frontendLogBuffer.splice(0, frontendLogBuffer.length - FRONTEND_LOG_LIMIT);
    }

    return true;
}

function emitConsoleToBase(level, args) {
    getBaseConsoleMethod(level)(...args);
}

function normalizeOptionalTimestamp(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? Math.max(0, Math.floor(numericValue)) : null;
}

export function installFrontendLogCapture() {
    if (frontendLogCaptureInstalled || typeof window === 'undefined') {
        return;
    }

    frontendLogCaptureInstalled = true;

    for (const level of WRAPPED_CONSOLE_LEVELS) {
        const normalizedLevel = normalizeLevel(level);
        getBaseConsoleMethod(normalizedLevel);

        console[normalizedLevel] = (...args) => {
            if (!pushFrontendLog(normalizedLevel, args, 'console')) {
                return;
            }

            emitConsoleToBase(normalizedLevel, args);
        };
    }

    window.addEventListener('error', (event) => {
        const details = [];
        if (event.message) {
            details.push(event.message);
        }
        if (event.filename) {
            details.push(`${event.filename}:${event.lineno || 0}:${event.colno || 0}`);
        }
        if (event.error) {
            details.push(event.error);
        }
        pushFrontendLog('error', details, 'window.onerror');
    });

    window.addEventListener('unhandledrejection', (event) => {
        pushFrontendLog('error', ['Unhandled promise rejection', event.reason], 'unhandledrejection');
    });
}

export function setFrontendConsoleDebugLoggingEnabled(enabled, options = {}) {
    const announce = options?.announce === true;
    const nextValue = Boolean(enabled);

    frontendConsoleDebugLoggingEnabled = nextValue;

    if (announce && nextValue) {
        const message = 'Frontend debug logging enabled.';
        pushFrontendLog('info', [message], 'system');
        emitConsoleToBase('info', [message]);
    }
}

export function isFrontendConsoleDebugLoggingEnabled() {
    return frontendConsoleDebugLoggingEnabled;
}

export function getFrontendLogsSnapshot(options = {}) {
    const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.floor(Number(options.limit))) : 300;
    const sinceId = Number.isFinite(Number(options.sinceId)) ? Math.max(0, Math.floor(Number(options.sinceId))) : 0;
    const startTime = normalizeOptionalTimestamp(options.startTime);
    const endTime = normalizeOptionalTimestamp(options.endTime);

    const entries = frontendLogBuffer
        .filter((entry) => Number(entry.id) > sinceId)
        .filter((entry) => startTime === null || Number(entry.timestamp) >= startTime)
        .filter((entry) => endTime === null || Number(entry.timestamp) <= endTime)
        .slice(-limit);
    const latestId = frontendLogBuffer.length ? Number(frontendLogBuffer[frontendLogBuffer.length - 1].id) : 0;

    return { entries, latestId };
}

export function clearFrontendLogs() {
    frontendLogBuffer.length = 0;
}
