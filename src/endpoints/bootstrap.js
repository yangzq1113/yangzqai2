import express from 'express';

import { getImages } from '../util.js';
import { getCharactersSnapshot } from './characters.js';
import { getGroupsSnapshot } from './groups.js';
import { readSecretState } from './secrets.js';
import { buildSettingsResponse } from './settings.js';

export const router = express.Router();

router.post('/bootstrap', async (request, response) => {
    try {
        const directories = request.user.directories;
        const charactersPromise = getCharactersSnapshot(directories);
        const groups = getGroupsSnapshot(directories);
        const settings = buildSettingsResponse(request, {
            includePresetContents: false,
            includeQuickReplyPresets: false,
        });
        const avatars = getImages(directories.avatars);
        const secret_state = readSecretState(directories);
        const characters = await charactersPromise;

        return response.send({
            settings,
            characters,
            groups,
            avatars,
            secret_state,
        });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
