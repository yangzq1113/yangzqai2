import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { applyPatch as applyJsonPatch } from '../../public/scripts/util/fast-json-patch.js';

import { getDefaultPresetFile, getDefaultPresets } from './content-manager.js';

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

    const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
    const filename = name + settings.extension;

    if (!settings.folder) {
        return response.sendStatus(400);
    }

    const fullpath = path.join(settings.folder, filename);
    writeFileAtomicSync(fullpath, JSON.stringify(request.body.preset, null, 4), 'utf-8');
    return response.send({ name });
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

        const settings = getPresetSettingsByAPI(request.body?.apiId, request.user.directories);
        if (!settings.folder) {
            return response.sendStatus(400);
        }

        const filename = name + settings.extension;
        const fullpath = path.join(settings.folder, filename);
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

    const settings = getPresetSettingsByAPI(request.body.apiId, request.user.directories);
    const filename = name + settings.extension;

    if (!settings.folder) {
        return response.sendStatus(400);
    }

    const fullpath = path.join(settings.folder, filename);

    if (fs.existsSync(fullpath)) {
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
