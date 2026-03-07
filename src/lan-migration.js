import crypto from 'node:crypto';

import { Cache } from './util.js';

export const LAN_MIGRATION_PATH_PREFIX = '/api/users/transfer/backup/';
export const LAN_MIGRATION_OFFER_TTL_MS = 10 * 60 * 1000;

const OFFER_CACHE = new Cache(LAN_MIGRATION_OFFER_TTL_MS);
const TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

function normalizeToken(token) {
    const value = String(token || '').trim().toLowerCase();
    return TOKEN_PATTERN.test(value) ? value : '';
}

export function createLanMigrationOffer(payload) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + LAN_MIGRATION_OFFER_TTL_MS;
    OFFER_CACHE.set(token, {
        ...payload,
        createdAt: Date.now(),
        expiresAt,
    });
    return { token, expiresAt };
}

export function consumeLanMigrationOffer(token) {
    const normalized = normalizeToken(token);
    if (!normalized) {
        return null;
    }

    const offer = OFFER_CACHE.get(normalized);
    if (!offer) {
        return null;
    }

    OFFER_CACHE.remove(normalized);
    return offer;
}
