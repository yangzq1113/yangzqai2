import path from 'node:path';
import fs from 'node:fs';

import mime from 'mime-types';
import express from 'express';
import sanitize from 'sanitize-filename';

import { resolvePathWithinParent } from '../util.js';

export const router = express.Router();

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
