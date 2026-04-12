import path from 'node:path';
import fs from 'node:fs';

import mime from 'mime-types';
import express from 'express';
import sanitize from 'sanitize-filename';

import { resolvePathWithinParent } from '../util.js';

export const router = express.Router();

/**
 * List all files in a CardApp directory (recursive).
 * GET /api/card-app/:charId/files
 */
router.get('/:charId/files', (request, response) => {
    try {
        const charId = sanitize(String(request.params.charId));
        if (!charId) {
            return response.sendStatus(400);
        }

        const charDir = path.join(request.user.directories.cardApps, charId);
        if (!fs.existsSync(charDir)) {
            return response.json({ files: [] });
        }

        const files = [];
        function walk(dir, prefix = '') {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    files.push({ path: relativePath, type: 'directory' });
                    walk(fullPath, relativePath);
                } else if (entry.isFile()) {
                    const stat = fs.statSync(fullPath);
                    files.push({ path: relativePath, type: 'file', size: stat.size });
                }
            }
        }
        walk(charDir);
        return response.json({ files });
    } catch (err) {
        console.error('[card-app] Error listing files:', err);
        return response.sendStatus(500);
    }
});

/**
 * Write (create or overwrite) a CardApp file.
 * PUT /api/card-app/:charId/*
 */
router.put('/:charId/*', express.json({ limit: '5mb' }), (request, response) => {
    try {
        const charId = sanitize(String(request.params.charId));
        const filePath = decodeURIComponent(request.params[0]);

        if (!charId || !filePath) {
            return response.sendStatus(400);
        }

        const charDir = path.join(request.user.directories.cardApps, charId);
        const fullPath = resolvePathWithinParent(charDir, filePath);

        if (!fullPath) {
            return response.status(400).json({ error: 'Invalid file path' });
        }

        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const content = request.body?.content;
        if (typeof content !== 'string') {
            return response.status(400).json({ error: 'Missing content field' });
        }

        fs.writeFileSync(fullPath, content, 'utf8');
        return response.json({ ok: true });
    } catch (err) {
        console.error('[card-app] Error writing file:', err);
        return response.sendStatus(500);
    }
});

/**
 * Delete a CardApp file.
 * DELETE /api/card-app/:charId/*
 */
router.delete('/:charId/*', (request, response) => {
    try {
        const charId = sanitize(String(request.params.charId));
        const filePath = decodeURIComponent(request.params[0]);

        if (!charId || !filePath) {
            return response.sendStatus(400);
        }

        const charDir = path.join(request.user.directories.cardApps, charId);
        const fullPath = resolvePathWithinParent(charDir, filePath);

        if (!fullPath || !fs.existsSync(fullPath)) {
            return response.sendStatus(404);
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(fullPath);
        }
        return response.json({ ok: true });
    } catch (err) {
        console.error('[card-app] Error deleting file:', err);
        return response.sendStatus(500);
    }
});

/**
 * Rename/move a CardApp file.
 * POST /api/card-app/:charId/rename
 */
router.post('/:charId/rename', express.json(), (request, response) => {
    try {
        const charId = sanitize(String(request.params.charId));
        const fromPath = String(request.body?.from || '').trim();
        const toPath = String(request.body?.to || '').trim();

        if (!charId || !fromPath || !toPath) {
            return response.status(400).json({ error: 'Missing charId, from, or to' });
        }

        const charDir = path.join(request.user.directories.cardApps, charId);
        const fullFrom = resolvePathWithinParent(charDir, fromPath);
        const fullTo = resolvePathWithinParent(charDir, toPath);

        if (!fullFrom || !fullTo) {
            return response.status(400).json({ error: 'Invalid file path' });
        }

        if (!fs.existsSync(fullFrom)) {
            return response.sendStatus(404);
        }

        const toDir = path.dirname(fullTo);
        if (!fs.existsSync(toDir)) {
            fs.mkdirSync(toDir, { recursive: true });
        }

        fs.renameSync(fullFrom, fullTo);
        return response.json({ ok: true });
    } catch (err) {
        console.error('[card-app] Error renaming file:', err);
        return response.sendStatus(500);
    }
});

/**
 * Create a directory in a CardApp.
 * POST /api/card-app/:charId/mkdir
 */
router.post('/:charId/mkdir', express.json(), (request, response) => {
    try {
        const charId = sanitize(String(request.params.charId));
        const dirPath = String(request.body?.path || '').trim();

        if (!charId || !dirPath) {
            return response.status(400).json({ error: 'Missing charId or path' });
        }

        const charDir = path.join(request.user.directories.cardApps, charId);
        const fullPath = resolvePathWithinParent(charDir, dirPath);

        if (!fullPath) {
            return response.status(400).json({ error: 'Invalid directory path' });
        }

        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
        }
        return response.json({ ok: true });
    } catch (err) {
        console.error('[card-app] Error creating directory:', err);
        return response.sendStatus(500);
    }
});

/**
 * Serve CardApp files for a character.
 * GET /api/card-app/:charId/*
 */
router.get('/:charId/*', (request, response) => {
    try {
        const charId = sanitize(String(request.params.charId));
        const filePath = decodeURIComponent(request.params[0]);

        if (!charId || !filePath) {
            return response.sendStatus(400);
        }

        const charDir = path.join(request.user.directories.cardApps, charId);
        const fullPath = resolvePathWithinParent(charDir, filePath);

        if (!fullPath || !fs.existsSync(fullPath)) {
            return response.sendStatus(404);
        }

        const contentType = mime.lookup(fullPath) || 'application/octet-stream';
        response.setHeader('Content-Type', contentType);
        return response.sendFile(fullPath);
    } catch (err) {
        console.error('[card-app] Error serving file:', err);
        return response.sendStatus(500);
    }
});

/**
 * Extract card_app.files from character data to the card-apps directory.
 * Removes the files content from the character data object (mutates it).
 * @param {object} charData - The character data object (parsed JSON)
 * @param {string} charId - The character ID (avatar name without .png)
 * @param {string} cardAppsDir - The card-apps base directory path
 * @returns {boolean} Whether any files were extracted
 */
export function extractCardAppFiles(charData, charId, cardAppsDir) {
    const cardApp = charData?.data?.extensions?.card_app;
    if (!cardApp?.files || typeof cardApp.files !== 'object') {
        return false;
    }

    const files = cardApp.files;
    const entries = Object.entries(files);
    if (entries.length === 0) {
        return false;
    }

    const charAppDir = path.join(cardAppsDir, sanitize(charId));

    for (const [filePath, content] of entries) {
        const sanitizedPath = filePath.split('/').map(segment => sanitize(segment)).join('/');
        const fullPath = path.join(charAppDir, sanitizedPath);

        // Security: ensure path is within the character's card-app directory
        const resolved = resolvePathWithinParent(charAppDir, sanitizedPath);
        if (!resolved) {
            console.warn(`[card-app] Skipping file with invalid path: ${filePath}`);
            continue;
        }

        // Create parent directories
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Write file content
        if (typeof content === 'string') {
            // Check if it's base64-encoded binary data
            if (content.startsWith('data:')) {
                // Data URL format: data:mime/type;base64,CONTENT
                const base64Match = content.match(/^data:[^;]+;base64,(.+)$/);
                if (base64Match) {
                    fs.writeFileSync(fullPath, Buffer.from(base64Match[1], 'base64'));
                } else {
                    fs.writeFileSync(fullPath, content, 'utf8');
                }
            } else {
                fs.writeFileSync(fullPath, content, 'utf8');
            }
        }
    }

    // Remove files content from character data to keep PNG small
    delete cardApp.files;
    console.info(`[card-app] Extracted ${entries.length} files for character: ${charId}`);
    return true;
}

/**
 * Pack card-app files back into character data for export.
 * @param {object} charData - The character data object (parsed JSON, will be mutated)
 * @param {string} charId - The character ID (avatar name without .png)
 * @param {string} cardAppsDir - The card-apps base directory path
 * @returns {boolean} Whether any files were packed
 */
export function packCardAppFiles(charData, charId, cardAppsDir) {
    const cardApp = charData?.data?.extensions?.card_app;
    if (!cardApp?.enabled) {
        return false;
    }

    const charAppDir = path.join(cardAppsDir, sanitize(charId));
    if (!fs.existsSync(charAppDir)) {
        return false;
    }

    const files = {};
    const textExtensions = new Set(['.js', '.css', '.html', '.htm', '.json', '.txt', '.md', '.svg', '.xml']);

    function walkDir(dir, prefix = '') {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walkDir(fullPath, relativePath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (textExtensions.has(ext)) {
                    files[relativePath] = fs.readFileSync(fullPath, 'utf8');
                } else {
                    // Binary files as data URLs
                    const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
                    const base64 = fs.readFileSync(fullPath).toString('base64');
                    files[relativePath] = `data:${mimeType};base64,${base64}`;
                }
            }
        }
    }

    walkDir(charAppDir);

    if (Object.keys(files).length === 0) {
        return false;
    }

    cardApp.files = files;
    console.info(`[card-app] Packed ${Object.keys(files).length} files for character: ${charId}`);
    return true;
}

/**
 * Delete card-app files for a character.
 * @param {string} charId - The character ID (avatar name without .png)
 * @param {string} cardAppsDir - The card-apps base directory path
 */
export function deleteCardAppFiles(charId, cardAppsDir) {
    const charAppDir = path.join(cardAppsDir, sanitize(charId));
    if (fs.existsSync(charAppDir)) {
        fs.rmSync(charAppDir, { recursive: true, force: true });
        console.info(`[card-app] Deleted files for character: ${charId}`);
    }
}
