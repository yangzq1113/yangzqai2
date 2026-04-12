import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import mime from 'mime-types';
import sanitize from 'sanitize-filename';
import { resolvePathWithinParent } from '../util.js';

export const router = express.Router();

router.get('/:charId/*', (request, response) => {
    try {
        const charId = sanitize(request.params.charId);
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
