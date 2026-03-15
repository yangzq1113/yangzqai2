const PERF_ENABLED = (() => {
    try {
        const search = String(globalThis.location?.search || '');
        if (!search) {
            return false;
        }

        const params = new URLSearchParams(search);
        return params.get('lukerPerf') === '1' || params.get('luker_perf') === '1';
    } catch {
        return false;
    }
})();

function safePerfMark(name) {
    if (!PERF_ENABLED) {
        return;
    }

    try {
        performance?.mark?.(name);
    } catch {
        // Ignore unsupported mark calls.
    }
}

function safePerfMeasure(name, startMark, endMark) {
    if (!PERF_ENABLED) {
        return;
    }

    try {
        performance?.measure?.(name, startMark, endMark);
    } catch {
        // Ignore unsupported measure calls.
    }
}

async function initializeApplication() {
    safePerfMark('luker:init:start');

    try {
        safePerfMark('luker:init:import:lib:start');
        await import('./lib.js');
        safePerfMark('luker:init:import:lib:end');
        safePerfMeasure('luker:init:import:lib', 'luker:init:import:lib:start', 'luker:init:import:lib:end');

        safePerfMark('luker:init:import:app:start');
        await import('./script.js');
        safePerfMark('luker:init:import:app:end');
        safePerfMeasure('luker:init:import:app', 'luker:init:import:app:start', 'luker:init:import:app:end');
    } catch (error) {
        console.error('Failed to initialize Luker application:', error);
    } finally {
        safePerfMark('luker:init:end');
        safePerfMeasure('luker:init:total', 'luker:init:start', 'luker:init:end');
    }
}

initializeApplication();
