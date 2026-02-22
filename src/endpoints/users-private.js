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
const FULL_IMPORT_SELECTION = Object.freeze({
    ...Object.fromEntries(Object.keys(normalizeUserBackupSelection({})).map((key) => [key, true])),
    globalExtensions: false,
});
const BACKUP_CATEGORY_ORDER = Object.freeze(Object.keys(FULL_IMPORT_SELECTION));

function sanitizeBackupSelectionForUser(selection, isAdminUser) {
    const normalized = normalizeUserBackupSelection(selection);
    if (!isAdminUser) {
        normalized.globalExtensions = false;
    }
    return normalized;
}

function resolveAllowedRestorePath(normalizedEntryPath, rootPath, allowedFiles, allowedDirectories) {
    const parts = normalizedEntryPath.split('/').filter(Boolean);
    const candidates = [];

    for (let index = 0; index < parts.length; index++) {
        const candidate = parts.slice(index).join('/');
        if (candidate) {
            candidates.push(candidate);
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

function addRestoreReportSample(report, entry, reason) {
    if (!entry || !reason) {
        return;
    }

    if (!Array.isArray(report.sampleSkippedEntries)) {
        report.sampleSkippedEntries = [];
    }

    if (report.sampleSkippedEntries.length >= 30) {
        return;
    }

    report.sampleSkippedEntries.push({ entry, reason });
}

function buildRestoreCategoryTargets(directories, selection, options = {}) {
    const categories = [];
    for (const category of BACKUP_CATEGORY_ORDER) {
        if (!selection[category]) {
            continue;
        }

        const categorySelection = Object.fromEntries(BACKUP_CATEGORY_ORDER.map((key) => [key, key === category]));
        const categoryTargets = getUserBackupTargets(directories, categorySelection, options);
        categories.push({
            name: category,
            files: new Set(categoryTargets.files.map(file => path.resolve(file))),
            directories: categoryTargets.directories.map(directory => path.resolve(directory)),
        });
    }
    return categories;
}

function resolveRestoreCategoryByTargetPath(targetPath, categoryTargets) {
    for (const category of categoryTargets) {
        if (category.files.has(targetPath)) {
            return category.name;
        }

        for (const directory of category.directories) {
            if (targetPath.startsWith(directory + path.sep)) {
                return category.name;
            }
        }
    }

    return '';
}

async function analyzeRestoreArchive(uploadPath, targetRoot, targetFiles, targetDirectories, categoryTargets) {
    /** @type {Map<string, { targetPath: string, category: string }>} */
    const targetByNormalizedEntry = new Map();
    const categoryStats = Object.fromEntries(
        categoryTargets.map((category) => [
            category.name,
            { targetableEntries: 0, restoredEntries: 0, failedEntries: 0 },
        ]),
    );
    const report = {
        totalEntries: 0,
        fileEntries: 0,
        directoryEntries: 0,
        targetableEntries: 0,
        skippedEntries: 0,
        rejectedEntries: 0,
        categoryStats,
        sampleSkippedEntries: [],
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
                try {
                    report.totalEntries += 1;
                    const normalized = normalizeZipEntryPath(entry.fileName);
                    if (!normalized) {
                        report.rejectedEntries += 1;
                        addRestoreReportSample(report, String(entry.fileName || ''), 'invalid_path');
                        zipfile.readEntry();
                        return;
                    }

                    if (entry.fileName.endsWith('/')) {
                        report.directoryEntries += 1;
                        zipfile.readEntry();
                        return;
                    }

                    const unixFileType = (entry.externalFileAttributes >> 16) & 0o170000;
                    if (unixFileType === 0o120000) {
                        report.rejectedEntries += 1;
                        addRestoreReportSample(report, normalized, 'symlink_rejected');
                        zipfile.readEntry();
                        return;
                    }

                    report.fileEntries += 1;
                    const targetPath = resolveAllowedRestorePath(normalized, targetRoot, targetFiles, targetDirectories);
                    if (!targetPath) {
                        report.skippedEntries += 1;
                        addRestoreReportSample(report, normalized, 'path_not_in_selected_categories');
                        zipfile.readEntry();
                        return;
                    }

                    const category = resolveRestoreCategoryByTargetPath(targetPath, categoryTargets);
                    targetByNormalizedEntry.set(normalized, { targetPath, category });
                    report.targetableEntries += 1;
                    if (category && report.categoryStats[category]) {
                        report.categoryStats[category].targetableEntries += 1;
                    }
                    zipfile.readEntry();
                } catch (error) {
                    finish(error);
                }
            });

            zipfile.on('end', () => finish());
            zipfile.on('close', () => finish());
            zipfile.on('error', finish);
        });
    });

    return { targetByNormalizedEntry, report };
}

async function restoreUserBackupArchive(uploadPath, directories, selection, mode, options = {}) {
    const backupTargets = getUserBackupTargets(directories, selection, options);
    const targetRoot = path.resolve(directories.root);
    const targetDirectories = backupTargets.directories.map(dir => path.resolve(dir));
    const targetFiles = new Set(backupTargets.files.map(file => path.resolve(file)));

    if (targetDirectories.length === 0 && targetFiles.size === 0) {
        throw new Error('At least one restore category must be selected.');
    }

    const categoryTargets = buildRestoreCategoryTargets(directories, selection, options);
    const analysis = await analyzeRestoreArchive(uploadPath, targetRoot, targetFiles, targetDirectories, categoryTargets);

    if (mode === 'overwrite' && analysis.report.targetableEntries === 0) {
        throw new Error('Archive does not match selected restore categories. Overwrite was cancelled to protect existing data.');
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
        failedCount: 0,
        skippedCount: analysis.report.skippedEntries,
        rejectedCount: analysis.report.rejectedEntries,
        preflight: analysis.report,
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
                        zipfile.readEntry();
                        return;
                    }

                    if (entry.fileName.endsWith('/')) {
                        zipfile.readEntry();
                        return;
                    }

                    const unixFileType = (entry.externalFileAttributes >> 16) & 0o170000;
                    if (unixFileType === 0o120000) {
                        zipfile.readEntry();
                        return;
                    }

                    const targetMapping = analysis.targetByNormalizedEntry.get(normalized);
                    if (!targetMapping) {
                        zipfile.readEntry();
                        return;
                    }

                    const targetPath = targetMapping.targetPath;
                    ensureDirectory(path.dirname(targetPath));

                    zipfile.openReadStream(entry, async (streamError, readStream) => {
                        if (streamError) {
                            finish(streamError);
                            return;
                        }

                        try {
                            await pipeline(readStream, fs.createWriteStream(targetPath, { mode: 0o644 }));
                            const zipLastModified = typeof entry.getLastModDate === 'function'
                                ? entry.getLastModDate()
                                : null;
                            if (zipLastModified instanceof Date && !Number.isNaN(zipLastModified.getTime())) {
                                try {
                                    await fsPromises.utimes(targetPath, zipLastModified, zipLastModified);
                                } catch {
                                    // Non-fatal: keep restored content even if timestamp restore fails.
                                }
                            }
                            result.restoredCount += 1;
                            if (targetMapping.category && result.preflight.categoryStats[targetMapping.category]) {
                                result.preflight.categoryStats[targetMapping.category].restoredEntries += 1;
                            }
                            zipfile.readEntry();
                        } catch (error) {
                            result.failedCount += 1;
                            if (targetMapping.category && result.preflight.categoryStats[targetMapping.category]) {
                                result.preflight.categoryStats[targetMapping.category].failedEntries += 1;
                            }
                            addRestoreReportSample(result.preflight, normalized, `write_failed:${error instanceof Error ? error.message : String(error)}`);
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

    if (result.preflight.targetableEntries === 0 && mode !== 'overwrite') {
        addRestoreReportSample(result.preflight, '(archive)', 'no_restorable_entries_detected');
    }

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

        const isAdminUser = Boolean(request.user?.profile?.admin);
        const selection = sanitizeBackupSelectionForUser(request.body.selection, isAdminUser);
        if (!Object.values(selection).some(Boolean)) {
            return response.status(400).json({ error: 'At least one backup category must be selected.' });
        }

        await createBackupArchive(handle, response, selection, { includeGlobalExtensions: isAdminUser });
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

        const isAdminUser = Boolean(request.user?.profile?.admin);
        const selection = sanitizeBackupSelectionForUser(parsedSelection, isAdminUser);
        if (!Object.values(selection).some(Boolean)) {
            return response.status(400).json({ error: 'At least one restore category must be selected.' });
        }

        const directories = handle === request.user.profile.handle ? request.user.directories : getUserDirectories(handle);
        const restoreResult = await restoreUserBackupArchive(uploadPath, directories, selection, mode, { includeGlobalExtensions: isAdminUser });

        return response.json({
            mode,
            ...restoreResult,
        });
    } catch (error) {
        console.error('Restore failed', error);
        const message = error?.message || 'Restore failed';
        const statusCode = message.includes('Archive does not match selected restore categories') ? 400 : 500;
        return response.status(statusCode).json({ error: message });
    } finally {
        if (uploadPath) {
            await fsPromises.rm(uploadPath, { force: true });
        }
    }
});

router.post('/import/data-zip', async (request, response) => {
    let uploadPath = '';

    try {
        if (!request.file) {
            return response.status(400).json({ error: 'No backup file uploaded' });
        }

        const originalName = String(request.file.originalname || '');
        if (!originalName.toLowerCase().endsWith('.zip')) {
            return response.status(400).json({ error: 'Backup file must be a .zip archive' });
        }

        uploadPath = request.file.path;
        const mode = String(request.body.mode || 'merge').toLowerCase() === 'overwrite' ? 'overwrite' : 'merge';
        const restoreResult = await restoreUserBackupArchive(uploadPath, request.user.directories, FULL_IMPORT_SELECTION, mode, { includeGlobalExtensions: false });

        return response.json({
            mode,
            ...restoreResult,
        });
    } catch (error) {
        console.error('Data ZIP import failed', error);
        const message = error?.message || 'Data ZIP import failed';
        const statusCode = message.includes('Archive does not match selected restore categories') ? 400 : 500;
        return response.status(statusCode).json({ error: message });
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
