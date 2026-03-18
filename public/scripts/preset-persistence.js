import {
    buildObjectPatchOperationsAsync,
    getRequestHeaders,
} from '../script.js';

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function shouldUsePresetPatch(operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
        return false;
    }

    return !(operations.length === 1
        && operations[0]?.op === 'replace'
        && operations[0]?.path === '');
}

/**
 * Saves a preset via JSON Patch when the delta is small enough, with a full-save fallback.
 *
 * @param {object} options
 * @param {string} options.apiId
 * @param {string} options.name
 * @param {object} options.preset
 * @param {object|null} [options.existingPreset]
 * @param {number} [options.maxOperations=4000]
 * @returns {Promise<{ ok: boolean, response: Response, data: any, mode: 'patch' | 'full' | 'noop', operations: object[] }>}
 */
export async function persistPreset(options) {
    const apiId = String(options?.apiId || '').trim();
    const name = String(options?.name || '').trim();
    const preset = isPlainObject(options?.preset) ? options.preset : {};
    const existingPreset = isPlainObject(options?.existingPreset) ? options.existingPreset : null;
    const maxOperations = Number.isInteger(options?.maxOperations) && options.maxOperations > 0
        ? options.maxOperations
        : 4000;

    if (existingPreset) {
        try {
            const operations = await buildObjectPatchOperationsAsync(existingPreset, preset, { maxOperations });

            if (operations.length === 0) {
                return {
                    ok: true,
                    response: null,
                    data: { name },
                    mode: 'noop',
                    operations,
                };
            }

            if (shouldUsePresetPatch(operations)) {
                const patchResponse = await fetch('/api/presets/patch', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ apiId, name, operations }),
                });

                if (patchResponse.ok) {
                    const data = await patchResponse.json();
                    return {
                        ok: true,
                        response: patchResponse,
                        data,
                        mode: 'patch',
                        operations,
                    };
                }

                console.warn('Preset patch save failed, falling back to full save.', {
                    apiId,
                    name,
                    status: patchResponse.status,
                    statusText: patchResponse.statusText,
                });
            }
        } catch (error) {
            console.warn('Failed to build preset patch, falling back to full save.', { apiId, name, error });
        }
    }

    const response = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ apiId, name, preset }),
    });

    const data = response.ok ? await response.json() : null;
    return {
        ok: response.ok,
        response,
        data,
        mode: 'full',
        operations: [],
    };
}
