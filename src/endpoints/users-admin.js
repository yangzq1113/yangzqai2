import { promises as fsPromises } from 'node:fs';

import storage from 'node-persist';
import express from 'express';
import lodash from 'lodash';
import {
    getAdminSettings,
    saveAdminSettings,
    getEffectiveUserQuotaBytes,
    getDirectorySizeBytes,
} from '../admin-settings.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import {
    KEY_PREFIX,
    toKey,
    requireAdminMiddleware,
    getUserAvatar,
    getAllUserHandles,
    getPasswordSalt,
    getPasswordHash,
    getUserDirectories,
    ensurePublicDirectoriesExist,
} from '../users.js';
import { DEFAULT_USER } from '../constants.js';
import { clearCapturedLogs, getCapturedLogs } from '../log-capture.js';

export const router = express.Router();

router.post('/logs/get', requireAdminMiddleware, async (request, response) => {
    try {
        const parsedLimit = Number(request.body?.limit);
        const parsedSinceId = Number(request.body?.sinceId);
        const limit = Number.isFinite(parsedLimit) ? Math.min(5000, Math.max(1, Math.floor(parsedLimit))) : 800;
        const sinceId = Number.isFinite(parsedSinceId) ? Math.max(0, Math.floor(parsedSinceId)) : 0;
        const levels = Array.isArray(request.body?.levels) ? request.body.levels : undefined;

        const result = getCapturedLogs({ sinceId, limit, levels });
        return response.json(result);
    } catch (error) {
        console.error('Admin logs get failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/logs/clear', requireAdminMiddleware, async (_request, response) => {
    try {
        clearCapturedLogs();
        return response.sendStatus(204);
    } catch (error) {
        console.error('Admin logs clear failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/overview', requireAdminMiddleware, async (_request, response) => {
    try {
        const adminSettings = await getAdminSettings();

        /** @type {import('../users.js').User[]} */
        const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));

        const usersWithStats = await Promise.all(users.map(async user => {
            const directories = getUserDirectories(user.handle);
            const storageBytes = await getDirectorySizeBytes(directories.root);
            const effectiveQuotaBytes = getEffectiveUserQuotaBytes(user, adminSettings);

            return {
                handle: user.handle,
                name: user.name,
                admin: user.admin,
                enabled: user.enabled,
                password: Boolean(user.password),
                created: user.created,
                storageBytes: storageBytes,
                storageQuotaBytes: effectiveQuotaBytes,
                storageUsageRatio: effectiveQuotaBytes >= 0 ? storageBytes / Math.max(effectiveQuotaBytes, 1) : null,
            };
        }));

        usersWithStats.sort((x, y) => (x.created ?? 0) - (y.created ?? 0));

        const totals = {
            users: usersWithStats.length,
            enabledUsers: usersWithStats.filter(x => x.enabled).length,
            adminUsers: usersWithStats.filter(x => x.admin).length,
            protectedUsers: usersWithStats.filter(x => x.password).length,
            storageBytes: usersWithStats.reduce((acc, user) => acc + user.storageBytes, 0),
            overQuotaUsers: usersWithStats.filter(x => x.storageQuotaBytes >= 0 && x.storageBytes > x.storageQuotaBytes).length,
        };

        const security = {
            adminWithoutPassword: usersWithStats.filter(x => x.admin && !x.password).map(x => x.handle),
            disabledAdmins: usersWithStats.filter(x => x.admin && !x.enabled).map(x => x.handle),
            disabledUsers: usersWithStats.filter(x => !x.enabled).map(x => x.handle),
        };

        return response.json({
            server: {
                nodeVersion: process.version,
                platform: process.platform,
                uptimeSec: Math.floor(process.uptime()),
                now: Date.now(),
            },
            totals,
            settings: adminSettings,
            users: usersWithStats,
            security,
        });
    } catch (error) {
        console.error('Admin overview failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/settings/get', requireAdminMiddleware, async (_request, response) => {
    try {
        const settings = await getAdminSettings();
        return response.json(settings);
    } catch (error) {
        console.error('Admin settings get failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/settings/save', requireAdminMiddleware, async (request, response) => {
    try {
        const saved = await saveAdminSettings(request.body || {});
        return response.json(saved);
    } catch (error) {
        console.error('Admin settings save failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/set-quota', requireAdminMiddleware, async (request, response) => {
    try {
        const handle = String(request.body?.handle || '').trim();
        if (!handle) {
            return response.status(400).json({ error: 'Missing required fields' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(handle));
        if (!user) {
            return response.status(404).json({ error: 'User not found' });
        }

        const rawQuota = request.body?.storageQuotaBytes;
        const parsed = Number(rawQuota);
        if (rawQuota === null || rawQuota === '' || rawQuota === undefined || !Number.isFinite(parsed) || parsed < 0) {
            delete user.storageQuotaBytes;
        } else {
            user.storageQuotaBytes = Math.floor(parsed);
        }

        await storage.setItem(toKey(handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('Set user quota failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/get', requireAdminMiddleware, async (_request, response) => {
    try {
        /** @type {import('../users.js').User[]} */
        const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));

        /** @type {Promise<import('../users.js').UserViewModel>[]} */
        const viewModelPromises = users
            .map(user => new Promise(resolve => {
                getUserAvatar(user.handle).then(avatar =>
                    resolve({
                        handle: user.handle,
                        name: user.name,
                        avatar: avatar,
                        admin: user.admin,
                        enabled: user.enabled,
                        created: user.created,
                        password: !!user.password,
                        storageQuotaBytes: Number.isFinite(Number(user.storageQuotaBytes)) ? Number(user.storageQuotaBytes) : null,
                        oauthProviders: Object.keys(user.oauth || {}),
                    }),
                );
            }));

        const viewModels = await Promise.all(viewModelPromises);
        viewModels.sort((x, y) => (x.created ?? 0) - (y.created ?? 0));
        return response.json(viewModels);
    } catch (error) {
        console.error('User list failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/disable', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Disable user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle === request.user.profile.handle) {
            console.warn('Disable user failed: Cannot disable yourself');
            return response.status(400).json({ error: 'Cannot disable yourself' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Disable user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.enabled = false;
        await storage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User disable failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/enable', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Enable user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Enable user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.enabled = true;
        await storage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User enable failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/promote', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Promote user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Promote user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.admin = true;
        await storage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User promote failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/demote', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Demote user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle === request.user.profile.handle) {
            console.warn('Demote user failed: Cannot demote yourself');
            return response.status(400).json({ error: 'Cannot demote yourself' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Demote user failed: User not found');
            return response.status(404).json({ error: 'User not found' });
        }

        user.admin = false;
        await storage.setItem(toKey(request.body.handle), user);
        return response.sendStatus(204);
    } catch (error) {
        console.error('User demote failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/create', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle || !request.body.name) {
            console.warn('Create user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const handles = await getAllUserHandles();
        const handle = lodash.kebabCase(String(request.body.handle).toLowerCase().trim());

        if (!handle) {
            console.warn('Create user failed: Invalid handle');
            return response.status(400).json({ error: 'Invalid handle' });
        }

        if (handles.some(x => x === handle)) {
            console.warn('Create user failed: User with that handle already exists');
            return response.status(409).json({ error: 'User already exists' });
        }

        const salt = getPasswordSalt();
        const password = request.body.password ? getPasswordHash(request.body.password, salt) : '';
        const adminSettings = await getAdminSettings();
        const defaultQuotaBytes = Number(adminSettings?.storage?.defaultUserQuotaBytes);

        const newUser = {
            handle: handle,
            name: request.body.name || 'Anonymous',
            created: Date.now(),
            password: password,
            salt: salt,
            admin: !!request.body.admin,
            enabled: true,
            storageQuotaBytes: Number.isFinite(defaultQuotaBytes) && defaultQuotaBytes >= 0 ? Math.floor(defaultQuotaBytes) : undefined,
        };

        await storage.setItem(toKey(handle), newUser);

        // Create user directories
        console.info('Creating data directories for', newUser.handle);
        await ensurePublicDirectoriesExist();
        const directories = getUserDirectories(newUser.handle);
        await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);
        return response.json({ handle: newUser.handle });
    } catch (error) {
        console.error('User create failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/delete', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Delete user failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (request.body.handle === request.user.profile.handle) {
            console.warn('Delete user failed: Cannot delete yourself');
            return response.status(400).json({ error: 'Cannot delete yourself' });
        }

        if (request.body.handle === DEFAULT_USER.handle) {
            console.warn('Delete user failed: Cannot delete default user');
            return response.status(400).json({ error: 'Sorry, but the default user cannot be deleted. It is required as a fallback.' });
        }

        await storage.removeItem(toKey(request.body.handle));

        if (request.body.purge) {
            const directories = getUserDirectories(request.body.handle);
            console.info('Deleting data directories for', request.body.handle);
            await fsPromises.rm(directories.root, { recursive: true, force: true });
        }

        return response.sendStatus(204);
    } catch (error) {
        console.error('User delete failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/slugify', requireAdminMiddleware, async (request, response) => {
    try {
        if (!request.body.text) {
            console.warn('Slugify failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const text = lodash.kebabCase(String(request.body.text).toLowerCase().trim());

        return response.send(text);
    } catch (error) {
        console.error('Slugify failed:', error);
        return response.sendStatus(500);
    }
});
