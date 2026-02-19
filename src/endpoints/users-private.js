import path from 'node:path';
import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import storage from 'node-persist';
import express from 'express';
import yauzl from 'yauzl';

import { getUserAvatar, toKey, getPasswordHash, getPasswordSalt, createBackupArchive, ensurePublicDirectoriesExist, toAvatarKey, getUserDirectories, getUserBackupTargets, normalizeUserBackupSelection } from '../users.js';
import { SETTINGS_FILE } from '../constants.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import { color, Cache, ensureDirectory, normalizeZipEntryPath } from '../util.js';

const RESET_CACHE = new Cache(5 * 60 * 1000);

function resolveAllowedRestorePath(normalizedEntryPath, rootPath, allowedFiles, allowedDirectories) {
    const candidates = [normalizedEntryPath];

    if (normalizedEntryPath.includes('/')) {
        const stripped = normalizedEntryPath.split('/').slice(1).join('/');
        if (stripped && stripped !== normalizedEntryPath) {
            candidates.push(stripped);
        }
    }

    for (const candidate of candidates) {
        if (!candidate || candidate === 'manifest.json') {
            continue;
        }

        const resolved = path.resolve(path.join(rootPath, candidate));
        if (!(resolved === rootPath || resolved.startsWith(rootPath + path.sep))) {
            continue;
        }

        if (allowedFiles.has(resolved)) {
            return resolved;
        }

        for (const directory of allowedDirectories) {
            if (resolved.startsWith(directory + path.sep)) {
                return resolved;
            }
        }
    }

    return '';
}

async function restoreUserBackupArchive(uploadPath, directories, selection, mode) {
    const backupTargets = getUserBackupTargets(directories, selection);
    const targetRoot = path.resolve(directories.root);
    const targetDirectories = backupTargets.directories.map(dir => path.resolve(dir));
    const targetFiles = new Set(backupTargets.files.map(file => path.resolve(file)));

    if (targetDirectories.length === 0 && targetFiles.size === 0) {
        throw new Error('At least one restore category must be selected.');
    }

    if (mode === 'overwrite') {
        for (const filePath of targetFiles) {
            await fsPromises.rm(filePath, { force: true });
        }

        for (const directoryPath of targetDirectories) {
            await fsPromises.rm(directoryPath, { recursive: true, force: true });
            ensureDirectory(directoryPath);
        }
    }

    const result = {
        restoredCount: 0,
        skippedCount: 0,
        rejectedCount: 0,
    };

    await new Promise((resolve, reject) => {
        yauzl.open(uploadPath, { lazyEntries: true, decodeStrings: true }, (openError, zipfile) => {
            if (openError) {
                reject(openError);
                return;
            }

            let finished = false;
            const finish = (error) => {
                if (finished) {
                    return;
                }
                finished = true;
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };

            zipfile.readEntry();

            zipfile.on('entry', (entry) => {
                (async () => {
                    const normalized = normalizeZipEntryPath(entry.fileName);
                    if (!normalized) {
                        result.rejectedCount += 1;
                        zipfile.readEntry();
                        return;
                    }

                    if (entry.fileName.endsWith('/')) {
                        zipfile.readEntry();
                        return;
                    }

                    const unixFileType = (entry.externalFileAttributes >> 16) & 0o170000;
                    if (unixFileType === 0o120000) {
                        result.rejectedCount += 1;
                        zipfile.readEntry();
                        return;
                    }

                    const targetPath = resolveAllowedRestorePath(normalized, targetRoot, targetFiles, targetDirectories);
                    if (!targetPath) {
                        result.skippedCount += 1;
                        zipfile.readEntry();
                        return;
                    }

                    ensureDirectory(path.dirname(targetPath));

                    zipfile.openReadStream(entry, async (streamError, readStream) => {
                        if (streamError) {
                            finish(streamError);
                            return;
                        }

                        try {
                            await pipeline(readStream, fs.createWriteStream(targetPath, { mode: 0o644 }));
                            result.restoredCount += 1;
                            zipfile.readEntry();
                        } catch (error) {
                            finish(error);
                        }
                    });
                })().catch(finish);
            });

            zipfile.on('end', () => finish());
            zipfile.on('close', () => finish());
            zipfile.on('error', finish);
        });
    });

    return result;
}

export const router = express.Router();

router.post('/logout', async (request, response) => {
    try {
        if (!request.session) {
            console.error('Session not available');
            return response.sendStatus(500);
        }

        request.session.handle = null;
        request.session.csrfToken = null;
        request.session = null;
        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.get('/me', async (request, response) => {
    try {
        if (!request.user) {
            return response.sendStatus(403);
        }

        const user = request.user.profile;
        const viewModel = {
            handle: user.handle,
            name: user.name,
            avatar: await getUserAvatar(user.handle),
            admin: user.admin,
            password: !!user.password,
            created: user.created,
        };

        return response.json(viewModel);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/change-avatar', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Change avatar failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change avatar failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        // Avatar is not a data URL or not an empty string
        if (!request.body.avatar.startsWith('data:image/') && request.body.avatar !== '') {
            console.warn('Change avatar failed: Invalid data URL');
            return response.status(400).json({ error: 'Invalid data URL' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Change avatar failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        await storage.setItem(toAvatarKey(request.body.handle), request.body.avatar);

        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/change-password', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Change password failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change password failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Change password failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        if (!user.enabled) {
            console.error('Change password failed: User is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        if (!request.user.profile.admin && user.password && user.password !== getPasswordHash(request.body.oldPassword, user.salt)) {
            console.error('Change password failed: Incorrect password');
            return response.status(403).json({ error: 'Incorrect password' });
        }

        if (request.body.newPassword) {
            const salt = getPasswordSalt();
            user.password = getPasswordHash(request.body.newPassword, salt);
            user.salt = salt;
        } else {
            user.password = '';
            user.salt = '';
        }

        await storage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/backup', async (request, response) => {
    try {
        const handle = request.body.handle;

        if (!handle) {
            console.warn('Backup failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Backup failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        const selection = normalizeUserBackupSelection(request.body.selection);
        if (!Object.values(selection).some(Boolean)) {
            return response.status(400).json({ error: 'At least one backup category must be selected.' });
        }

        await createBackupArchive(handle, response, selection);
    } catch (error) {
        console.error('Backup failed', error);
        return response.sendStatus(500);
    }
});

router.post('/restore-backup', async (request, response) => {
    let uploadPath = '';

    try {
        const handle = request.body.handle;
        if (!handle) {
            console.warn('Restore failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Restore failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        if (!request.file) {
            return response.status(400).json({ error: 'No backup file uploaded' });
        }

        const originalName = String(request.file.originalname || '');
        if (!originalName.toLowerCase().endsWith('.zip')) {
            return response.status(400).json({ error: 'Backup file must be a .zip archive' });
        }

        uploadPath = request.file.path;
        const mode = String(request.body.mode || 'merge').toLowerCase() === 'overwrite' ? 'overwrite' : 'merge';

        let parsedSelection = request.body.selection;
        if (typeof parsedSelection === 'string' && parsedSelection.trim()) {
            try {
                parsedSelection = JSON.parse(parsedSelection);
            } catch {
                parsedSelection = {};
            }
        }

        const selection = normalizeUserBackupSelection(parsedSelection);
        if (!Object.values(selection).some(Boolean)) {
            return response.status(400).json({ error: 'At least one restore category must be selected.' });
        }

        const directories = handle === request.user.profile.handle ? request.user.directories : getUserDirectories(handle);
        const restoreResult = await restoreUserBackupArchive(uploadPath, directories, selection, mode);

        return response.json({
            mode,
            ...restoreResult,
        });
    } catch (error) {
        console.error('Restore failed', error);
        return response.status(500).json({ error: error?.message || 'Restore failed' });
    } finally {
        if (uploadPath) {
            await fsPromises.rm(uploadPath, { force: true });
        }
    }
});

router.post('/reset-settings', async (request, response) => {
    try {
        const password = request.body.password;

        if (request.user.profile.password && request.user.profile.password !== getPasswordHash(password, request.user.profile.salt)) {
            console.warn('Reset settings failed: Incorrect password');
            return response.status(403).json({ error: 'Incorrect password' });
        }

        const pathToFile = path.join(request.user.directories.root, SETTINGS_FILE);
        await fsPromises.rm(pathToFile, { force: true });
        await checkForNewContent([request.user.directories], [CONTENT_TYPES.SETTINGS]);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Reset settings failed', error);
        return response.sendStatus(500);
    }
});

router.post('/change-name', async (request, response) => {
    try {
        if (!request.body.name || !request.body.handle) {
            console.warn('Change name failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle !== request.user.profile.handle && !request.user.profile.admin) {
            console.error('Change name failed: Unauthorized');
            return response.status(403).json({ error: 'Unauthorized' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.warn('Change name failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.name = request.body.name;
        await storage.setItem(toKey(request.body.handle), user);

        return response.sendStatus(204);
    } catch (error) {
        console.error('Change name failed', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step1', async (request, response) => {
    try {
        const resetCode = String(crypto.randomInt(1000, 9999));
        console.log();
        console.log(color.magenta(`${request.user.profile.name}, your account reset code is: `) + color.red(resetCode));
        console.log();
        RESET_CACHE.set(request.user.profile.handle, resetCode);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Recover step 1 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/reset-step2', async (request, response) => {
    try {
        if (!request.body.code) {
            console.warn('Recover step 2 failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.user.profile.password && request.user.profile.password !== getPasswordHash(request.body.password, request.user.profile.salt)) {
            console.warn('Recover step 2 failed: Incorrect password');
            return response.status(400).json({ error: 'Incorrect password' });
        }

        const code = RESET_CACHE.get(request.user.profile.handle);

        if (!code || code !== request.body.code) {
            console.warn('Recover step 2 failed: Incorrect code');
            return response.status(400).json({ error: 'Incorrect code' });
        }

        console.info('Resetting account data:', request.user.profile.handle);
        await fsPromises.rm(request.user.directories.root, { recursive: true, force: true });

        await ensurePublicDirectoriesExist();
        await checkForNewContent([request.user.directories]);

        RESET_CACHE.remove(request.user.profile.handle);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Recover step 2 failed:', error);
        return response.sendStatus(500);
    }
});
