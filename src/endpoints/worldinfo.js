import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { tryParse } from '../util.js';
import { applyPatch as applyJsonPatch } from '../../public/scripts/util/fast-json-patch.js';

/**
 * Reads a World Info file and returns its contents
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} worldInfoName Name of the World Info file
 * @param {boolean} allowDummy If true, returns an empty object if the file doesn't exist
 * @returns {object} World Info file contents
 */
export function readWorldInfoFile(directories, worldInfoName, allowDummy) {
    const dummyObject = allowDummy ? { entries: {} } : null;

    if (!worldInfoName) {
        return dummyObject;
    }

    const filename = sanitize(`${worldInfoName}.json`);
    const pathToWorldInfo = path.join(directories.worlds, filename);

    if (!fs.existsSync(pathToWorldInfo)) {
        console.error(`World info file ${filename} doesn't exist.`);
        return dummyObject;
    }

    const worldInfoText = fs.readFileSync(pathToWorldInfo, 'utf8');
    const worldInfo = JSON.parse(worldInfoText);
    return worldInfo;
}

export const router = express.Router();

/**
 * Applies RFC6902 patch operations to world info payload.
 * @param {object} state Current world info object.
 * @param {object[]} operations Patch operations.
 * @returns {{applied:number,state:object}}
 */
function applyWorldInfoPatch(state, operations) {
    const root = _.isObjectLike(state) && !Array.isArray(state) ? state : { entries: {} };
    const patchResult = applyJsonPatch(root, operations, true, false);
    const patched = patchResult.newDocument;
    if (!_.isObjectLike(patched) || Array.isArray(patched)) {
        throw new Error('World info patch must produce an object root.');
    }
    if (!('entries' in patched) || !_.isObjectLike(patched.entries) || Array.isArray(patched.entries)) {
        throw new Error('World info patch must keep a valid entries object.');
    }
    return { applied: operations.length, state: patched };
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

router.post('/list', async (request, response) => {
    try {
        const data = [];
        const jsonFiles = (await fs.promises.readdir(request.user.directories.worlds, { withFileTypes: true }))
            .filter((file) => file.isFile() && path.extname(file.name).toLowerCase() === '.json')
            .sort((a, b) => a.name.localeCompare(b.name));

        for (const file of jsonFiles) {
            try {
                const filePath = path.join(request.user.directories.worlds, file.name);
                const fileContents = await fs.promises.readFile(filePath, 'utf8');
                const fileContentsParsed = tryParse(fileContents) || {};
                const fileExtensions = fileContentsParsed?.extensions || {};
                const fileNameWithoutExt = path.parse(file.name).name;
                const fileData = {
                    file_id: fileNameWithoutExt,
                    name: fileContentsParsed?.name || fileNameWithoutExt,
                    extensions: _.isObjectLike(fileExtensions) ? fileExtensions : {},
                };
                data.push(fileData);
            } catch (err) {
                console.warn(`Error reading or parsing World Info file ${file.name}:`, err);
            }
        }

        return response.send(data);
    } catch (err) {
        console.error('Error reading World Info directory:', err);
        return response.sendStatus(500);
    }
});

router.post('/get', (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const file = readWorldInfoFile(request.user.directories, request.body.name, true);

    return response.send(file);
});

router.post('/delete', (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const worldInfoName = request.body.name;
    const filename = sanitize(`${worldInfoName}.json`);
    const pathToWorldInfo = path.join(request.user.directories.worlds, filename);

    if (!fs.existsSync(pathToWorldInfo)) {
        throw new Error(`World info file ${filename} doesn't exist.`);
    }

    fs.unlinkSync(pathToWorldInfo);

    return response.sendStatus(200);
});

router.post('/import', (request, response) => {
    if (!request.file) return response.sendStatus(400);

    const filename = `${path.parse(sanitize(request.file.originalname)).name}.json`;

    let fileContents = null;

    if (request.body.convertedData) {
        fileContents = request.body.convertedData;
    } else {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        fileContents = fs.readFileSync(pathToUpload, 'utf8');
        fs.unlinkSync(pathToUpload);
    }

    try {
        const worldContent = JSON.parse(fileContents);
        if (!('entries' in worldContent)) {
            throw new Error('File must contain a world info entries list');
        }
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }

    const pathToNewFile = path.join(request.user.directories.worlds, filename);
    const worldName = path.parse(pathToNewFile).name;

    if (!worldName) {
        return response.status(400).send('World file must have a name');
    }

    writeFileAtomicSync(pathToNewFile, fileContents);
    return response.send({ name: worldName });
});

router.post('/edit', (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    if (!request.body.name) {
        return response.status(400).send('World file must have a name');
    }

    try {
        if (!('entries' in request.body.data)) {
            throw new Error('World info must contain an entries list');
        }
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }

    const filename = sanitize(`${request.body.name}.json`);
    const pathToFile = path.join(request.user.directories.worlds, filename);

    writeFileAtomicSync(pathToFile, JSON.stringify(request.body.data, null, 4));

    return response.send({ ok: true });
});

router.post('/patch', (request, response) => {
    try {
        const worldInfoName = String(request.body?.name || '').trim();
        if (!worldInfoName) {
            return response.status(400).send({ error: 'World file must have a name' });
        }

        const operations = Array.isArray(request.body?.operations)
            ? request.body.operations
            : (_.isObjectLike(request.body?.operations)
                ? [request.body.operations]
                : (_.isObjectLike(request.body?.operation) ? [request.body.operation] : []));

        if (operations.length === 0) {
            return response.status(400).send({ error: 'No world info patch operations found. Expected body.operations or body.operation.' });
        }

        const filename = sanitize(`${worldInfoName}.json`);
        const pathToFile = path.join(request.user.directories.worlds, filename);
        let current = { entries: {} };
        if (fs.existsSync(pathToFile)) {
            const raw = fs.readFileSync(pathToFile, 'utf8');
            const parsed = JSON.parse(raw);
            current = _.isObjectLike(parsed) && !Array.isArray(parsed) ? parsed : { entries: {} };
        }

        const { applied, state } = applyWorldInfoPatch(current, operations);
        writeFileAtomicSync(pathToFile, JSON.stringify(state, null, 4), 'utf8');
        return response.send({ ok: true, applied });
    } catch (error) {
        if (isJsonPatchConflictError(error)) {
            return response.status(409).send({ error: 'World info patch test conflict.', code: 'patch_test_failed', details: String(error?.message || '') });
        }
        if (isJsonPatchValidationError(error)) {
            return response.status(400).send({ error: 'Invalid world info patch payload.', code: 'patch_payload_invalid', details: String(error?.message || '') });
        }
        console.error('Error patching world info:', error);
        return response.status(500).send({ error: 'Failed to patch world info.' });
    }
});
