import { describe, expect, test } from '@jest/globals';

import basicAuthMiddleware, { isBasicAuthExemptRequest } from '../src/middleware/basicAuth.js';

function createResponseRecorder() {
    return {
        headers: {},
        statusCode: null,
        body: undefined,
        set(name, value) {
            this.headers[name] = value;
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        send(body) {
            this.body = body;
            return this;
        },
    };
}

describe('isBasicAuthExemptRequest', () => {
    test('matches the LAN migration transfer route for GET requests', () => {
        const request = {
            method: 'GET',
            path: `/api/users/transfer/backup/${'a'.repeat(64)}`,
        };

        expect(isBasicAuthExemptRequest(request)).toBe(true);
    });

    test('rejects non-GET methods and non-matching paths', () => {
        expect(isBasicAuthExemptRequest({
            method: 'POST',
            path: `/api/users/transfer/backup/${'a'.repeat(64)}`,
        })).toBe(false);

        expect(isBasicAuthExemptRequest({
            method: 'GET',
            path: '/api/users/transfer/backup/not-a-valid-token',
        })).toBe(false);

        expect(isBasicAuthExemptRequest({
            method: 'GET',
            path: '/api/users/login',
        })).toBe(false);
    });
});

describe('basicAuthMiddleware', () => {
    test('skips basic auth for the one-time LAN migration transfer route', async () => {
        const request = {
            method: 'GET',
            path: `/api/users/transfer/backup/${'b'.repeat(64)}`,
            headers: {},
        };
        const response = createResponseRecorder();
        let nextCalled = false;

        await basicAuthMiddleware(request, response, () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(true);
        expect(response.statusCode).toBeNull();
    });

    test('still rejects unrelated routes without basic auth credentials', async () => {
        const request = {
            method: 'GET',
            path: '/api/users/oauth/providers',
            headers: {},
        };
        const response = createResponseRecorder();
        let nextCalled = false;

        await basicAuthMiddleware(request, response, () => {
            nextCalled = true;
        });

        expect(nextCalled).toBe(false);
        expect(response.statusCode).toBe(401);
        expect(response.headers['WWW-Authenticate']).toBe('Basic realm="Luker", charset="UTF-8"');
    });
});
