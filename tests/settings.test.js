import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from '@jest/globals';

import { buildSettingsResponse } from '../src/endpoints/settings.js';

const tempRoots = [];

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function createDirectories(root) {
    const directories = {
        root,
        novelAI_Settings: path.join(root, 'NovelAI Settings'),
        openAI_Settings: path.join(root, 'OpenAI Settings'),
        textGen_Settings: path.join(root, 'TextGen Settings'),
        koboldAI_Settings: path.join(root, 'KoboldAI Settings'),
        worlds: path.join(root, 'Worlds'),
        themes: path.join(root, 'themes'),
        movingUI: path.join(root, 'moving-ui'),
        quickreplies: path.join(root, 'QuickReplies'),
        instruct: path.join(root, 'instruct'),
        context: path.join(root, 'context'),
        sysprompt: path.join(root, 'sysprompt'),
        reasoning: path.join(root, 'reasoning'),
    };

    for (const directoryPath of Object.values(directories)) {
        fs.mkdirSync(directoryPath, { recursive: true });
    }

    return directories;
}

function createRequestFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luker-settings-test-'));
    tempRoots.push(root);
    const directories = createDirectories(root);

    writeJson(path.join(directories.root, 'settings.json'), {
        oai_settings: {
            preset_settings_openai: 'Default',
        },
    });

    return {
        user: {
            directories,
        },
    };
}

afterEach(() => {
    for (const root of tempRoots.splice(0, tempRoots.length)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe('buildSettingsResponse', () => {
    test('excludes preset state sidecars from preset collections', () => {
        const request = createRequestFixture();
        const { directories } = request.user;

        writeJson(path.join(directories.openAI_Settings, 'Default.json'), { temperature: 0.7 });
        writeJson(
            path.join(directories.openAI_Settings, 'Default.luker-state.completion_preset_assistant_session.json'),
            { version: 1 },
        );
        writeJson(
            path.join(directories.openAI_Settings, 'Default.luker-state.completion_preset_assistant_journal.json'),
            { version: 1 },
        );

        writeJson(path.join(directories.instruct, 'Guide.json'), { name: 'Guide', system_prompt: 'Test prompt' });
        writeJson(
            path.join(directories.instruct, 'Guide.luker-state.completion_preset_assistant_session.json'),
            { version: 1 },
        );

        const response = buildSettingsResponse(request);

        expect(response.openai_setting_names).toEqual(['Default']);
        expect(response.openai_settings).toHaveLength(1);
        expect(response.instruct).toHaveLength(1);
        expect(response.instruct[0]?.name).toBe('Guide');
    });
});
