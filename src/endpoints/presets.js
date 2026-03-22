import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { applyPatch as applyJsonPatch } from '../../public/scripts/util/fast-json-patch.js';

import { getDefaultPresetFile, getDefaultPresets } from './content-manager.js';

const PRESET_STATE_FILE_PREFIX = '.luker-state.';
const PRESET_STATE_FILE_SUFFIX = '.json';

/**
 * Gets the folder and extension for the preset settings based on the API source ID.
 * @param {string} apiId API source ID
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {{folder: string?, extension: string?}} Object containing the folder and extension for the preset settings
 */
function getPresetSettingsByAPI(apiId, directories) {
    switch (apiId) {
        case 'kobold':
        case 'koboldhorde':
            return { folder: directories.koboldAI_Settings, extension: '.json' };
        case 'novel':
            return { folder: directories.novelAI_Settings, extension: '.json' };
        case 'textgenerationwebui':
            return { folder: directories.textGen_Settings, extension: '.json' };
        case 'openai':
            return { folder: directories.openAI_Settings, extension: '.json' };
        case 'instruct':
            return { folder: directories.instruct, extension: '.json' };
        case 'context':
            return { folder: directories.context, extension: '.json' };
        case 'sysprompt':
            return { folder: directories.sysprompt, extension: '.json' };
        case 'reasoning':
            return { folder: directories.reasoning, extension: '.json' };
        default:
            return { folder: null, extension: null };
    }
}

export const router = express.Router();

function normalizePresetStateNamespace(namespace) {
    const raw = String(namespace || '').trim().toLowerCase();
    if (!raw) {
        return '';
    }
    return raw.replace(/[^a-z0-9._-]/g, '_').slice(0, 96);
}

function resolvePresetFilePath(apiId, directories, name) {
    const safeName = sanitize(String(name || '').trim());
    const settings = getPresetSettingsByAPI(apiId, directories);
    if (!safeName || !settings.folder || !settings.extension) {
        return null;
    }
    return path.join(settings.folder, `${safeName}${settings.extension}`);
}

function getPresetStateSidecarPath(presetFilePath, namespace) {
    const safeNamespace = normalizePresetStateNamespace(namespace);
    if (!safeNamespace) {
        return '';
    }
    const parsed = path.parse(presetFilePath);
    return path.join(parsed.dir, `${parsed.name}${PRESET_STATE_FILE_PREFIX}${safeNamespace}${PRESET_STATE_FILE_SUFFIX}`);
}

function getAllPresetStateSidecarPaths(presetFilePath) {
    const parsed = path.parse(presetFilePath);
    if (!fs.existsSync(parsed.dir)) {
        return [];
    }
    const prefix = `${parsed.name}${PRESET_STATE_FILE_PREFIX}`;
    const files = fs.readdirSync(parsed.dir, { withFileTypes: true });
    return files
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
        .filter(fileName => fileName.startsWith(prefix) && fileName.endsWith(PRESET_STATE_FILE_SUFFIX))
        .map(fileName => path.join(parsed.dir, fileName));
}

function readJsonObjectFile(filePath, label) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw) {
            return null;
        }

        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }

        console.warn(`Invalid ${label} JSON: ${filePath}`);
        return null;
    } catch (error) {
        console.warn(`Failed to read ${label}: ${filePath}`, error);
        return null;
    }
}

function readPresetStateData(presetFilePath, namespace) {
    const stateFilePath = getPresetStateSidecarPath(presetFilePath, namespace);
    if (!stateFilePath || !fs.existsSync(stateFilePath)) {
        return null;
    }

    return readJsonObjectFile(stateFilePath, 'preset state sidecar');
}

function deleteAllPresetStateSidecars(presetFilePath) {
    const sidecars = getAllPresetStateSidecarPaths(presetFilePath);
    let deleted = 0;
    for (const sidecarPath of sidecars) {
        try {
            fs.unlinkSync(sidecarPath);
            deleted += 1;
        } catch (error) {
            console.warn('Failed to delete preset state sidecar:', sidecarPath, error);
        }
    }
    return deleted;
}

function renameAllPresetStateSidecars(sourcePresetFilePath, targetPresetFilePath) {
    const sourceParsed = path.parse(sourcePresetFilePath);
    const targetParsed = path.parse(targetPresetFilePath);
    const sourcePrefix = `${sourceParsed.name}${PRESET_STATE_FILE_PREFIX}`;
    const targetPrefix = `${targetParsed.name}${PRESET_STATE_FILE_PREFIX}`;
    const sourceFiles = getAllPresetStateSidecarPaths(sourcePresetFilePath);
    if (sourceFiles.length === 0) {
        return 0;
    }

    let renamed = 0;
    for (const sourceFilePath of sourceFiles) {
        const sourceName = path.basename(sourceFilePath);
        const namespaceWithSuffix = sourceName.slice(sourcePrefix.length);
        const targetName = `${targetPrefix}${namespaceWithSuffix}`;
        const targetFilePath = path.join(targetParsed.dir, targetName);
        if (fs.existsSync(targetFilePath)) {
            const error = new Error(`Preset state sidecar rename collision: ${targetFilePath}`);
            error.code = 'preset_state_rename_collision';
            throw error;
        }
        fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
        fs.copyFileSync(sourceFilePath, targetFilePath);
        fs.unlinkSync(sourceFilePath);
        renamed += 1;
    }
    return renamed;
}

function isJsonPatchConflictError(error) {
    const message = String(error?.message || '');
    return message.includes('JSON Patch test failed')
        || message.includes('Invalid JSON Patch replace path.')
        || message.includes('Invalid JSON Patch remove path.')
        || message.includes('Array index out of bounds');
}

function isJsonPatchValidationError(error) {
    const message = String(error?.message || '');
    return message.includes('JSON Patch operation is missing op.')
        || message.includes('JSON Patch operation must be an object.')
        || message.includes('JSON Patch document must be an array.')
        || message.includes('JSON Patch add operation requires value.')
        || message.includes('JSON Patch replace operation requires value.')
        || message.includes('Invalid JSON Patch path.')
        || message.includes('Unsupported JSON Patch operation:');
}

router.post('/save', function (request, response) {
    const name = sanitize(request.body.name);
    if (!request.body.preset || !name) {
        return response.sendStatus(400);
    }

    const fullpath = resolvePresetFilePath(request.body.apiId, request.user.directories, name);
    if (!fullpath) {
        return response.sendStatus(400);
    }

    writeFileAtomicSync(fullpath, JSON.stringify(request.body.preset, null, 4), 'utf-8');
    return response.send({ name });
});

router.post('/state/get', function (request, response) {
    try {
        const presetFilePath = resolvePresetFilePath(request.body?.apiId, request.user.directories, request.body?.name);
        const namespace = normalizePresetStateNamespace(request.body?.namespace);
        if (!presetFilePath) {
            return response.status(400).send({ error: 'Invalid preset target payload.' });
        }
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }
        return response.send({ ok: true, data: readPresetStateData(presetFilePath, namespace) });
    } catch (error) {
        console.error('Error reading preset state sidecar:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/get-batch', function (request, response) {
    try {
        const presetFilePath = resolvePresetFilePath(request.body?.apiId, request.user.directories, request.body?.name);
        const namespaces = [...new Set((Array.isArray(request.body?.namespaces) ? request.body.namespaces : [])
            .map((namespace) => normalizePresetStateNamespace(namespace))
            .filter(Boolean))];
        if (!presetFilePath) {
            return response.status(400).send({ error: 'Invalid preset target payload.' });
        }
        if (!namespaces.length) {
            return response.status(400).send({ error: 'Expected body.namespaces array.' });
        }

        const data = {};
        for (const namespace of namespaces) {
            data[namespace] = readPresetStateData(presetFilePath, namespace);
        }

        return response.send({ ok: true, data });
    } catch (error) {
        console.error('Error reading preset state sidecars:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/patch', function (request, response) {
    try {
        const presetFilePath = resolvePresetFilePath(request.body?.apiId, request.user.directories, request.body?.name);
        const namespace = normalizePresetStateNamespace(request.body?.namespace);
        if (!presetFilePath) {
            return response.status(400).send({ error: 'Invalid preset target payload.' });
        }
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }
        const operations = Array.isArray(request.body?.operations)
            ? request.body.operations
            : (request.body?.operation && typeof request.body.operation === 'object' ? [request.body.operation] : []);
        if (operations.length === 0) {
            return response.status(400).send({ error: 'No preset state patch operations found. Expected body.operations or body.operation.' });
        }

        const stateFilePath = getPresetStateSidecarPath(presetFilePath, namespace);
        if (!stateFilePath) {
            return response.status(400).send({ error: 'Invalid namespace for preset state sidecar path.' });
        }

        let state = {};
        const existed = fs.existsSync(stateFilePath);
        if (existed) {
            const parsed = readJsonObjectFile(stateFilePath, 'preset state sidecar');
            if (parsed) {
                state = parsed;
            }
        }

        let patchResult;
        try {
            patchResult = applyJsonPatch(state, operations, true, false);
        } catch (error) {
            if (isJsonPatchConflictError(error)) {
                return response.status(409).send({ error: 'Preset state patch conflict.' });
            }
            if (isJsonPatchValidationError(error)) {
                return response.status(400).send({ error: 'Invalid preset state patch payload.' });
            }
            throw error;
        }

        fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
        writeFileAtomicSync(stateFilePath, JSON.stringify(patchResult.newDocument, null, 4), 'utf8');
        return response.send({
            ok: true,
            applied: operations.length,
            created: !existed,
        });
    } catch (error) {
        console.error('Error patching preset state sidecar:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/delete', function (request, response) {
    try {
        const presetFilePath = resolvePresetFilePath(request.body?.apiId, request.user.directories, request.body?.name);
        const namespace = normalizePresetStateNamespace(request.body?.namespace);
        if (!presetFilePath) {
            return response.status(400).send({ error: 'Invalid preset target payload.' });
        }
        if (!namespace) {
            return response.status(400).send({ error: 'Expected body.namespace string.' });
        }
        const stateFilePath = getPresetStateSidecarPath(presetFilePath, namespace);
        let deleted = false;
        if (stateFilePath && fs.existsSync(stateFilePath)) {
            fs.unlinkSync(stateFilePath);
            deleted = true;
        }
        return response.send({ ok: true, deleted });
    } catch (error) {
        console.error('Error deleting preset state sidecar:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/delete-all', function (request, response) {
    try {
        const presetFilePath = resolvePresetFilePath(request.body?.apiId, request.user.directories, request.body?.name);
        if (!presetFilePath) {
            return response.status(400).send({ error: 'Invalid preset target payload.' });
        }
        const deleted = deleteAllPresetStateSidecars(presetFilePath);
        return response.send({ ok: true, deleted });
    } catch (error) {
        console.error('Error deleting preset state sidecars:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/state/rename', function (request, response) {
    try {
        const apiId = request.body?.apiId;
        const sourcePresetFilePath = resolvePresetFilePath(apiId, request.user.directories, request.body?.oldName);
        const targetPresetFilePath = resolvePresetFilePath(apiId, request.user.directories, request.body?.newName);
        if (!sourcePresetFilePath || !targetPresetFilePath) {
            return response.status(400).send({ error: 'Invalid preset state rename payload.' });
        }
        if (sourcePresetFilePath === targetPresetFilePath) {
            return response.send({ ok: true, renamed: 0 });
        }

        const renamed = renameAllPresetStateSidecars(sourcePresetFilePath, targetPresetFilePath);
        return response.send({ ok: true, renamed });
    } catch (error) {
        if (String(error?.code || '') === 'preset_state_rename_collision') {
            return response.status(409).send({ error: 'Preset state rename collision.' });
        }
        console.error('Error renaming preset state sidecars:', error);
        return response.status(500).send({ error: true });
    }
});

router.post('/patch', function (request, response) {
    try {
        const name = sanitize(request.body?.name);
        const operations = Array.isArray(request.body?.operations)
            ? request.body.operations
            : (request.body?.operation ? [request.body.operation] : []);

        if (!name) {
            return response.status(400).send({ error: 'Preset name is required.' });
        }

        if (!Array.isArray(operations) || operations.length === 0) {
            return response.status(400).send({ error: 'No preset patch operations found. Expected body.operations or body.operation.' });
        }

        const fullpath = resolvePresetFilePath(request.body?.apiId, request.user.directories, name);
        if (!fullpath) {
            return response.sendStatus(400);
        }
        if (!fs.existsSync(fullpath)) {
            return response.status(404).send({ error: 'Preset file not found.' });
        }

        const raw = fs.readFileSync(fullpath, 'utf8');
        const parsed = JSON.parse(raw);
        const currentPreset = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        const patchResult = applyJsonPatch(currentPreset, operations, true, false);
        writeFileAtomicSync(fullpath, JSON.stringify(patchResult.newDocument, null, 4), 'utf-8');
        return response.send({ result: 'ok', applied: operations.length, name });
    } catch (error) {
        if (isJsonPatchConflictError(error)) {
            return response.status(409).send({ error: 'Preset patch test conflict.', code: 'patch_test_failed', details: String(error?.message || '') });
        }
        if (isJsonPatchValidationError(error)) {
            return response.status(400).send({ error: 'Invalid preset patch payload.', code: 'patch_payload_invalid', details: String(error?.message || '') });
        }
        console.error('Error patching preset:', error);
        return response.status(500).send({ error: 'Failed to patch preset.' });
    }
});

router.post('/delete', function (request, response) {
    const name = sanitize(request.body.name);
    if (!name) {
        return response.sendStatus(400);
    }

    const fullpath = resolvePresetFilePath(request.body.apiId, request.user.directories, name);
    if (!fullpath) {
        return response.sendStatus(400);
    }

    if (fs.existsSync(fullpath)) {
        deleteAllPresetStateSidecars(fullpath);
        fs.unlinkSync(fullpath);
        return response.sendStatus(200);
    } else {
        return response.sendStatus(404);
    }
});

router.post('/restore', function (request, response) {
    try {
        const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
        const name = sanitize(request.body.name);
        const defaultPresets = getDefaultPresets(request.user.directories);

        const defaultPreset = defaultPresets.find(p => p.name === name && p.folder === settings.folder);

        const result = { isDefault: false, preset: {} };

        if (defaultPreset) {
            result.isDefault = true;
            result.preset = getDefaultPresetFile(defaultPreset.filename) || {};
        }

        return response.send(result);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
