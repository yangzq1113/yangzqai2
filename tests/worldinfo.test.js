import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, test, expect, afterEach } from '@jest/globals';
import {
    findMatchingWorldInfoFilename,
    readWorldInfoFile,
    resolveWorldInfoFilename,
    sanitizeImportedWorldInfoFilename,
} from '../src/endpoints/worldinfo.js';

const tempDirs = [];

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function createTempWorldDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-worldinfo-'));
    tempDirs.push(dir);
    return dir;
}

describe('world info filename resolution', () => {
    test('should resolve the raw filename when the basename has trailing whitespace', () => {
        const directory = createTempWorldDir();
        const filename = 'Example Book .json';
        fs.writeFileSync(path.join(directory, filename), JSON.stringify({ entries: { '0': { key: ['x'] } } }));

        expect(findMatchingWorldInfoFilename([filename], 'Example Book')).toBe(filename);
        expect(resolveWorldInfoFilename(directory, 'Example Book')).toBe(filename);
        expect(readWorldInfoFile({ worlds: directory }, 'Example Book', false)).toEqual({ entries: { '0': { key: ['x'] } } });
    });

    test('should keep tolerant emoji matching while returning the exact stored filename', () => {
        const directory = createTempWorldDir();
        const filename = '❤️World.json';
        fs.writeFileSync(path.join(directory, filename), JSON.stringify({ entries: {} }));

        expect(resolveWorldInfoFilename(directory, '❤World')).toBe(filename);
    });
});

describe('world info import filename sanitization', () => {
    test('should trim whitespace before the json extension for imported files', () => {
        expect(sanitizeImportedWorldInfoFilename('Example Book .json')).toBe('Example Book.json');
        expect(sanitizeImportedWorldInfoFilename('v1.2 .json')).toBe('v1.2.json');
    });
});
