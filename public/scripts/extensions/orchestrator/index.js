import { CONNECT_API_MAP, extension_prompt_roles, extension_prompt_types, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { chat_completion_sources, proxies, sendOpenAIRequest } from '../../openai.js';

const MODULE_NAME = 'orchestrator';
const CAPSULE_PROMPT_KEY = 'luker_orchestrator_capsule';
const LAST_CAPSULE_METADATA_KEY = 'luker_orchestrator_last_capsule';
const UI_BLOCK_ID = 'orchestrator_settings';
const MAX_FIELD_CHARS = 420;
const ALLOWED_TEMPLATE_VARS = ['recent_chat', 'last_user', 'previous_outputs', 'distiller', 'wi_summary'];
const ORCH_ALLOWED_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe', 'impersonate']);
const ORCH_AI_QUALITY_AXES = {
    user_intent: 'Analyze user intent, emotional expectation, and implicit goals.',
    character_traits: 'Use character traits and card constraints without restating full biographies in every node.',
    character_independence: 'Preserve multi-character independence and avoid voice/agency collapse.',
    anti_ooc: 'Detect and prevent OOC behavior and persona drift.',
    latent_behavior: 'Infer plausible latent behavior, motivations, and next-step actions.',
    human_realism: 'Increase human-like behavior through natural uncertainty, bounded knowledge, and believable pacing.',
    world_autonomy: 'Keep the world autonomous; events should not always orbit the user.',
};

const defaultSpec = {
    stages: [
        { id: 'distill', mode: 'serial', nodes: ['distiller'] },
        { id: 'plan', mode: 'parallel', nodes: ['director', 'critic'] },
    ],
};

const defaultPresets = {
    distiller: {
        systemPrompt: 'You are a narrative distiller. Extract key story state and user intent.',
        userPromptTemplate: 'Recent chat:\n{{recent_chat}}\n\nCurrent user message:\n{{last_user}}\n\nReturn JSON only.',
        responseLength: 240,
    },
    director: {
        systemPrompt: 'You are a roleplay director. Produce concise tactical guidance for the next assistant reply.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nRecent chat:\n{{recent_chat}}\n\nReturn JSON only.',
        responseLength: 280,
    },
    critic: {
        systemPrompt: 'You are an RP critic. Flag OOC, pacing, and consistency risks.',
        userPromptTemplate: 'Recent chat:\n{{recent_chat}}\n\nReturn JSON only.',
        responseLength: 240,
    },
};

const defaultSettings = {
    enabled: false,
    llmNodeApiPresetName: '',
    llmNodePresetName: '',
    llmNodeResponseLength: 280,
    toolCallRetryMax: 2,
    promptEnvelopeMaxChars: 2800,
    maxRecentMessages: 14,
    includeWorldInfoSummary: true,
    capsuleInjectPosition: extension_prompt_types.IN_CHAT,
    capsuleInjectDepth: 1,
    capsuleInjectRole: extension_prompt_roles.SYSTEM,
    saveTarget: 'global',
    orchestrationSpec: defaultSpec,
    presets: defaultPresets,
    chatOverrides: {},
    aiSuggestApiPresetName: '',
    aiSuggestPresetName: '',
    aiSuggestResponseLength: 600,
};

const CHAT_MODEL_SETTING_BY_SOURCE = {
    [chat_completion_sources.OPENAI]: 'openai_model',
    [chat_completion_sources.CLAUDE]: 'claude_model',
    [chat_completion_sources.OPENROUTER]: 'openrouter_model',
    [chat_completion_sources.AI21]: 'ai21_model',
    [chat_completion_sources.MAKERSUITE]: 'google_model',
    [chat_completion_sources.VERTEXAI]: 'vertexai_model',
    [chat_completion_sources.MISTRALAI]: 'mistralai_model',
    [chat_completion_sources.CUSTOM]: 'custom_model',
    [chat_completion_sources.COHERE]: 'cohere_model',
    [chat_completion_sources.PERPLEXITY]: 'perplexity_model',
    [chat_completion_sources.GROQ]: 'groq_model',
    [chat_completion_sources.ELECTRONHUB]: 'electronhub_model',
    [chat_completion_sources.CHUTES]: 'chutes_model',
    [chat_completion_sources.NANOGPT]: 'nanogpt_model',
    [chat_completion_sources.DEEPSEEK]: 'deepseek_model',
    [chat_completion_sources.AIMLAPI]: 'aimlapi_model',
    [chat_completion_sources.XAI]: 'xai_model',
    [chat_completion_sources.POLLINATIONS]: 'pollinations_model',
    [chat_completion_sources.MOONSHOT]: 'moonshot_model',
    [chat_completion_sources.FIREWORKS]: 'fireworks_model',
    [chat_completion_sources.COMETAPI]: 'cometapi_model',
    [chat_completion_sources.AZURE_OPENAI]: 'azure_openai_model',
    [chat_completion_sources.ZAI]: 'zai_model',
    [chat_completion_sources.SILICONFLOW]: 'siliconflow_model',
};

const API_ALIAS_TO_CHAT_SOURCE = {
    openai: chat_completion_sources.OPENAI,
    claude: chat_completion_sources.CLAUDE,
    openrouter: chat_completion_sources.OPENROUTER,
    ai21: chat_completion_sources.AI21,
    makersuite: chat_completion_sources.MAKERSUITE,
    vertexai: chat_completion_sources.VERTEXAI,
    mistralai: chat_completion_sources.MISTRALAI,
    custom: chat_completion_sources.CUSTOM,
    cohere: chat_completion_sources.COHERE,
    perplexity: chat_completion_sources.PERPLEXITY,
    groq: chat_completion_sources.GROQ,
    electronhub: chat_completion_sources.ELECTRONHUB,
    chutes: chat_completion_sources.CHUTES,
    nanogpt: chat_completion_sources.NANOGPT,
    deepseek: chat_completion_sources.DEEPSEEK,
    aimlapi: chat_completion_sources.AIMLAPI,
    xai: chat_completion_sources.XAI,
    pollinations: chat_completion_sources.POLLINATIONS,
    moonshot: chat_completion_sources.MOONSHOT,
    fireworks: chat_completion_sources.FIREWORKS,
    cometapi: chat_completion_sources.COMETAPI,
    azure_openai: chat_completion_sources.AZURE_OPENAI,
    zai: chat_completion_sources.ZAI,
    siliconflow: chat_completion_sources.SILICONFLOW,
};

const ORCH_STYLE_ID = 'orchestrator_styles';
const uiState = {
    selectedAvatar: '',
    aiGoal: '',
    globalEditor: null,
    characterEditor: null,
};
let orchInFlight = false;

function cloneDefault(value) {
    return Array.isArray(value) || typeof value === 'object' ? structuredClone(value) : value;
}

function sanitizeSpec(spec) {
    if (!spec || typeof spec !== 'object') {
        return structuredClone(defaultSpec);
    }

    const stages = Array.isArray(spec.stages) ? spec.stages : [];
    const normalizedStages = stages.map((stage, stageIndex) => {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const normalizedNodes = nodes
            .map(node => {
                if (typeof node === 'string') {
                    return node.trim();
                }
                if (node && typeof node === 'object') {
                    const compact = {
                        id: String(node.id || node.node || node.preset || '').trim(),
                        preset: String(node.preset || node.id || node.node || '').trim(),
                        userPromptTemplate: typeof node.userPromptTemplate === 'string' ? node.userPromptTemplate : undefined,
                        responseLength: Number.isFinite(Number(node.responseLength)) ? Number(node.responseLength) : undefined,
                    };
                    if (!compact.id && compact.preset) {
                        compact.id = compact.preset;
                    }
                    if (!compact.preset && compact.id) {
                        compact.preset = compact.id;
                    }
                    return compact.id ? compact : null;
                }
                return null;
            })
            .filter(Boolean);

        return {
            id: String(stage?.id || `stage_${stageIndex + 1}`),
            mode: String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
            nodes: normalizedNodes,
        };
    }).filter(stage => Array.isArray(stage.nodes) && stage.nodes.length > 0);

    return {
        stages: normalizedStages.length > 0 ? normalizedStages : structuredClone(defaultSpec.stages),
    };
}

function sanitizePresetMap(presets) {
    const base = structuredClone(defaultPresets);
    if (!presets || typeof presets !== 'object') {
        return base;
    }

    for (const [key, value] of Object.entries(presets)) {
        if (!value || typeof value !== 'object') {
            continue;
        }
        base[key] = {
            systemPrompt: String(value.systemPrompt || base[key]?.systemPrompt || '').trim(),
            userPromptTemplate: String(value.userPromptTemplate || base[key]?.userPromptTemplate || '').trim(),
            responseLength: Number.isFinite(Number(value.responseLength)) && Number(value.responseLength) > 0
                ? Number(value.responseLength)
                : Number(base[key]?.responseLength || 260),
        };
    }

    return base;
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = cloneDefault(value);
        }
    }

    extension_settings[MODULE_NAME].orchestrationSpec = sanitizeSpec(extension_settings[MODULE_NAME].orchestrationSpec);
    extension_settings[MODULE_NAME].presets = sanitizePresetMap(extension_settings[MODULE_NAME].presets);
    if (!String(extension_settings[MODULE_NAME].llmNodePresetName || '').trim()) {
        extension_settings[MODULE_NAME].llmNodePresetName = String(extension_settings[MODULE_NAME].llmNodePromptPresetName || '').trim();
    }
    if (!String(extension_settings[MODULE_NAME].aiSuggestPresetName || '').trim()) {
        extension_settings[MODULE_NAME].aiSuggestPresetName = String(extension_settings[MODULE_NAME].aiSuggestPromptPresetName || '').trim();
    }
    // Drop legacy API selector fields. API routing now comes from connection profile only.
    delete extension_settings[MODULE_NAME].llmNodeApi;
    delete extension_settings[MODULE_NAME].aiSuggestApi;
    delete extension_settings[MODULE_NAME].llmNodePromptPresetName;
    delete extension_settings[MODULE_NAME].aiSuggestPromptPresetName;
    delete extension_settings[MODULE_NAME].maxCapsuleChars;
    if (!['global', 'character'].includes(String(extension_settings[MODULE_NAME].saveTarget || '').trim())) {
        extension_settings[MODULE_NAME].saveTarget = 'global';
    }
    {
        const value = Number(extension_settings[MODULE_NAME].capsuleInjectPosition);
        const allowed = [extension_prompt_types.IN_PROMPT, extension_prompt_types.IN_CHAT, extension_prompt_types.BEFORE_PROMPT];
        extension_settings[MODULE_NAME].capsuleInjectPosition = allowed.includes(value)
            ? value
            : extension_prompt_types.IN_CHAT;
    }
    extension_settings[MODULE_NAME].capsuleInjectDepth = Math.max(
        0,
        Math.min(10000, Math.floor(Number(extension_settings[MODULE_NAME].capsuleInjectDepth) || 0)),
    );
    {
        const role = Number(extension_settings[MODULE_NAME].capsuleInjectRole);
        const allowedRoles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
        extension_settings[MODULE_NAME].capsuleInjectRole = allowedRoles.includes(role)
            ? role
            : extension_prompt_roles.SYSTEM;
    }
    extension_settings[MODULE_NAME].toolCallRetryMax = Math.max(
        0,
        Math.min(10, Math.floor(Number(extension_settings[MODULE_NAME].toolCallRetryMax) || 0)),
    );
    if (!extension_settings[MODULE_NAME].chatOverrides || typeof extension_settings[MODULE_NAME].chatOverrides !== 'object') {
        extension_settings[MODULE_NAME].chatOverrides = {};
    }
}

function clearCapsulePrompt(context) {
    context.setExtensionPrompt(
        CAPSULE_PROMPT_KEY,
        '',
        extension_prompt_types.NONE,
        0,
        true,
        extension_prompt_roles.SYSTEM,
    );
}

function saveLastCapsuleMetadata(context, capsuleText, payload, profile) {
    const capsule = String(capsuleText || '').trim();
    if (!capsule) {
        return;
    }

    context.updateChatMetadata({
        [LAST_CAPSULE_METADATA_KEY]: {
            updatedAt: new Date().toISOString(),
            trigger: String(payload?.type || 'normal'),
            profileSource: String(profile?.source || 'global'),
            profileKey: String(profile?.key || 'global'),
            capsule,
        },
    });
    context.saveMetadataDebounced();
}

function clearLastCapsuleMetadata(context) {
    const metadata = context.chatMetadata;
    if (!metadata || typeof metadata !== 'object' || !(LAST_CAPSULE_METADATA_KEY in metadata)) {
        return;
    }

    const nextMetadata = { ...metadata };
    delete nextMetadata[LAST_CAPSULE_METADATA_KEY];
    context.updateChatMetadata(nextMetadata, true);
    context.saveMetadataDebounced();
}

function shouldRunOrchestrationForPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    if (payload.dryRun === true) {
        return false;
    }
    const type = String(payload.type || '').trim().toLowerCase();
    if (!ORCH_ALLOWED_GENERATION_TYPES.has(type)) {
        return false;
    }
    return true;
}

function getCurrentAvatar(context) {
    return context.characters?.[context.characterId]?.avatar || '';
}

function getChatKey(context) {
    if (context.groupId) {
        return `group:${context.groupId}`;
    }

    const avatar = context.characters?.[context.characterId]?.avatar || 'unknown_avatar';
    const chatId = context.chatId || 'unknown_chat';
    return `char:${avatar}:${chatId}`;
}

function truncate(value, maxLength = MAX_FIELD_CHARS) {
    return String(value || '').trim().slice(0, maxLength);
}

function getCoreMessages(payload) {
    return Array.isArray(payload?.coreChat) ? payload.coreChat : [];
}

function getRecentMessages(messages, count) {
    return messages.slice(Math.max(0, messages.length - Math.max(1, count)));
}

function extractLastUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.is_user) {
            return { index: i, message: messages[i] };
        }
    }

    return { index: -1, message: null };
}

function getEffectiveProfile(context) {
    const settings = extension_settings[MODULE_NAME];
    const chatKey = getChatKey(context);
    const chatOverride = settings.chatOverrides?.[chatKey];
    if (chatOverride?.enabled && chatOverride?.spec) {
        return {
            source: 'chat',
            key: chatKey,
            spec: sanitizeSpec(chatOverride.spec),
            presets: sanitizePresetMap({
                ...settings.presets,
                ...(chatOverride.presetPatch || {}),
            }),
        };
    }

    const avatar = getCurrentAvatar(context);
    const characterOverride = getCharacterOverrideByAvatar(context, avatar);
    if (characterOverride?.enabled && characterOverride?.spec) {
        return {
            source: 'character',
            key: avatar,
            spec: sanitizeSpec(characterOverride.spec),
            presets: sanitizePresetMap({
                ...settings.presets,
                ...(characterOverride.presetPatch || {}),
            }),
        };
    }

    return {
        source: 'global',
        key: 'global',
        spec: sanitizeSpec(settings.orchestrationSpec),
        presets: sanitizePresetMap(settings.presets),
    };
}

function normalizeNodeSpec(node) {
    if (typeof node === 'string') {
        return {
            id: node,
            preset: node,
            userPromptTemplate: undefined,
            responseLength: undefined,
        };
    }

    const id = String(node?.id || node?.node || node?.preset || '').trim();
    const preset = String(node?.preset || id).trim();
    return {
        id: id || preset,
        preset,
        userPromptTemplate: typeof node?.userPromptTemplate === 'string' ? node.userPromptTemplate : undefined,
        responseLength: Number.isFinite(Number(node?.responseLength)) ? Number(node.responseLength) : undefined,
    };
}

function extractTemplateVariables(template) {
    const result = [];
    const text = String(template || '');
    const regex = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        result.push(String(match[1] || '').trim());
    }
    return [...new Set(result.filter(Boolean))];
}

function getUnsupportedTemplateVariables(template) {
    const used = extractTemplateVariables(template);
    return used.filter(name => !ALLOWED_TEMPLATE_VARS.includes(name));
}

function validateAiBuildTemplateVariables(spec, presetPatch) {
    const errors = [];
    const safeSpec = sanitizeSpec(spec);
    const safePatch = (presetPatch && typeof presetPatch === 'object') ? presetPatch : {};

    const stages = Array.isArray(safeSpec?.stages) ? safeSpec.stages : [];
    for (const stage of stages) {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        for (const rawNode of nodes) {
            const node = normalizeNodeSpec(rawNode);
            if (typeof node.userPromptTemplate !== 'string' || !node.userPromptTemplate.trim()) {
                continue;
            }
            const unsupported = getUnsupportedTemplateVariables(node.userPromptTemplate);
            if (unsupported.length > 0) {
                errors.push(`Node '${node.id}': ${unsupported.join(', ')}`);
            }
        }
    }

    for (const [presetId, preset] of Object.entries(safePatch)) {
        const template = String(preset?.userPromptTemplate || '');
        if (!template.trim()) {
            continue;
        }
        const unsupported = getUnsupportedTemplateVariables(template);
        if (unsupported.length > 0) {
            errors.push(`Preset '${presetId}': ${unsupported.join(', ')}`);
        }
    }

    if (errors.length > 0) {
        throw new Error(
            `Unsupported template variables found. Allowed: ${ALLOWED_TEMPLATE_VARS.join(', ')}. ` +
            `Invalid usage -> ${errors.join(' | ')}`,
        );
    }
}

function collectSpecNodeIds(spec) {
    const safeSpec = sanitizeSpec(spec);
    const ids = new Set();
    const stages = Array.isArray(safeSpec?.stages) ? safeSpec.stages : [];
    for (const stage of stages) {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        for (const rawNode of nodes) {
            const node = normalizeNodeSpec(rawNode);
            if (node?.id) {
                ids.add(String(node.id));
            }
            if (node?.preset) {
                ids.add(String(node.preset));
            }
        }
    }
    return ids;
}

function analyzeAiBuildCoverageChecklist(coverageChecklist, spec) {
    const validNodeRefs = collectSpecNodeIds(spec);
    const missing = [];
    const invalidNodeRefs = [];
    const normalized = {};

    for (const axis of Object.keys(ORCH_AI_QUALITY_AXES)) {
        const row = coverageChecklist?.[axis];
        const isLegacyString = typeof row === 'string';
        const node = String(isLegacyString ? '' : (row?.node || '')).trim();
        const strategy = String(isLegacyString ? row : (row?.strategy || '')).trim();
        normalized[axis] = { node, strategy };

        if (!strategy) {
            missing.push(axis);
            continue;
        }
        if (node && !validNodeRefs.has(node)) {
            invalidNodeRefs.push(`${axis}:${node}`);
        }
    }

    return {
        provided: Boolean(coverageChecklist && typeof coverageChecklist === 'object'),
        missing,
        invalidNodeRefs,
        normalized,
    };
}

function extractFunctionCallArguments(responseData, functionName) {
    const expectedName = String(functionName || '').trim();
    if (!expectedName) {
        throw new Error('Function name is required.');
    }

    const toolCalls = responseData?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        throw new Error('Model did not return any tool call.');
    }

    const matchedCall = toolCalls.find(call => String(call?.function?.name || '') === expectedName);
    if (!matchedCall) {
        throw new Error(`Model returned tool call, but not '${expectedName}'.`);
    }

    const argsText = matchedCall?.function?.arguments;
    if (typeof argsText !== 'string' || !argsText.trim()) {
        throw new Error('Tool call arguments are empty.');
    }

    try {
        return JSON.parse(argsText);
    } catch {
        throw new Error('Tool call arguments are not valid JSON.');
    }
}

function extractAllFunctionCalls(responseData, allowedNames = null) {
    const toolCalls = responseData?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        throw new Error('Model did not return any tool call.');
    }

    const allowSet = allowedNames instanceof Set
        ? allowedNames
        : Array.isArray(allowedNames)
            ? new Set(allowedNames.map(name => String(name || '').trim()).filter(Boolean))
            : null;
    const parsedCalls = [];
    for (const call of toolCalls) {
        const fnName = String(call?.function?.name || '').trim();
        if (!fnName) {
            continue;
        }
        if (allowSet && !allowSet.has(fnName)) {
            continue;
        }
        const argsText = call?.function?.arguments;
        if (typeof argsText !== 'string' || !argsText.trim()) {
            throw new Error(`Tool call '${fnName}' arguments are empty.`);
        }
        try {
            parsedCalls.push({
                id: String(call?.id || ''),
                name: fnName,
                arguments: JSON.parse(argsText),
            });
        } catch {
            throw new Error(`Tool call '${fnName}' arguments are not valid JSON.`);
        }
    }
    if (parsedCalls.length === 0) {
        throw new Error('Model returned tool calls, but none matched expected function names.');
    }
    return parsedCalls;
}

function isRetryableToolCallError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('tool call');
}

async function requestToolCallWithRetry(settings, promptMessages, {
    functionName = '',
    functionDescription = '',
    parameters = {},
    responseLength = 320,
    llmPresetName = '',
    apiSettingsOverride = null,
} = {}) {
    const fnName = String(functionName || '').trim();
    if (!fnName) {
        throw new Error('Function name is required.');
    }

    const retries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
    const tools = [{
        type: 'function',
        function: {
            name: fnName,
            description: String(functionDescription || `Function output for ${fnName}`),
            parameters: parameters && typeof parameters === 'object' ? parameters : { type: 'object', additionalProperties: true },
        },
    }];
    const toolChoice = {
        type: 'function',
        function: { name: fnName },
    };

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const responseData = await sendOpenAIRequest('quiet', promptMessages, null, {
                tools,
                toolChoice,
                replaceTools: true,
                responseLength: Number(responseLength || 320),
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
            });
            return extractFunctionCallArguments(responseData, fnName);
        } catch (error) {
            lastError = error;
            if (!isRetryableToolCallError(error) || attempt >= retries) {
                throw error;
            }
            console.warn(`[${MODULE_NAME}] Tool call '${fnName}' failed. Retrying (${attempt + 1}/${retries})...`, error);
        }
    }

    throw lastError || new Error(`Tool call '${fnName}' failed.`);
}

async function requestToolCallsWithRetry(settings, promptMessages, {
    tools = [],
    allowedNames = null,
    responseLength = 320,
    llmPresetName = '',
    apiSettingsOverride = null,
} = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error('Tools are required.');
    }

    const retries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const responseData = await sendOpenAIRequest('quiet', promptMessages, null, {
                tools,
                toolChoice: 'auto',
                replaceTools: true,
                responseLength: Number(responseLength || 320),
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
            });
            return extractAllFunctionCalls(responseData, allowedNames);
        } catch (error) {
            lastError = error;
            if (!isRetryableToolCallError(error) || attempt >= retries) {
                throw error;
            }
            console.warn(`[${MODULE_NAME}] Multi tool call request failed. Retrying (${attempt + 1}/${retries})...`, error);
        }
    }
    throw lastError || new Error('Multi tool call request failed.');
}

function renderTemplate(template, vars) {
    return String(template || '')
        .replaceAll('{{recent_chat}}', String(vars.recent_chat || ''))
        .replaceAll('{{last_user}}', String(vars.last_user || ''))
        .replaceAll('{{previous_outputs}}', String(vars.previous_outputs || ''))
        .replaceAll('{{distiller}}', String(vars.distiller || ''))
        .replaceAll('{{wi_summary}}', String(vars.wi_summary || ''));
}

function buildPresetAwareMessages(context, settings, systemPrompt, userPrompt, { api = '', promptPresetName = '' } = {}) {
    const systemText = String(systemPrompt || '').trim() || 'Return concise JSON guidance.';
    const userText = String(userPrompt || '').trim() || 'Return concise JSON guidance.';
    const selectedPromptPresetName = String(promptPresetName || '').trim();
    const envelopeApi = selectedPromptPresetName ? 'openai' : (api || context.mainApi || 'openai');

    return context.buildPresetAwarePromptMessages({
        messages: [
            { role: 'system', content: systemText },
            { role: 'user', content: userText },
        ],
        envelopeOptions: {
            includeCharacterCard: true,
            maxBlockChars: 1200,
            api: envelopeApi,
            promptPresetName: selectedPromptPresetName,
        },
        promptPresetName: selectedPromptPresetName,
        envelopeMaxChars: Number(settings.promptEnvelopeMaxChars || 2800),
    });
}

async function runLLMNode(context, payload, nodeSpec, preset, messages, previousNodeOutputs, wiHint = '') {
    const settings = extension_settings[MODULE_NAME];
    const recent = getRecentMessages(messages, settings.maxRecentMessages)
        .map(message => `${message?.is_user ? 'User' : (message?.name || 'Assistant')}: ${String(message?.mes || '')}`)
        .join('\n');
    const { message: lastUser } = extractLastUserMessage(messages);
    const previousOutputs = JSON.stringify(Object.fromEntries(previousNodeOutputs), null, 2).slice(0, 2200);
    const userPrompt = renderTemplate(nodeSpec.userPromptTemplate || preset.userPromptTemplate || '', {
        recent_chat: recent,
        last_user: String(lastUser?.mes || ''),
        previous_outputs: previousOutputs,
        distiller: JSON.stringify(previousNodeOutputs.get('distiller') || {}, null, 2),
        wi_summary: wiHint,
    });

    const llmPresetName = String(settings.llmNodePresetName || '').trim();
    const llmApiPresetName = String(settings.llmNodeApiPresetName || '').trim();
    const promptPresetName = llmPresetName;
    const api = resolveRequestApiFromConnectionProfileName(context, llmApiPresetName) || String(context.mainApi || 'openai');
    const apiSettingsOverride = buildApiSettingsOverrideFromConnectionProfileName(
        llmApiPresetName,
        String(context?.chatCompletionSettings?.chat_completion_source || ''),
    );
    const promptMessages = buildPresetAwareMessages(
        context,
        settings,
        String(preset.systemPrompt || '').trim(),
        userPrompt,
        { api, promptPresetName },
    );

    const nodeOutputSchema = {
        type: 'object',
        properties: {
            summary: { type: 'string' },
            directives: {
                type: 'array',
                items: { type: 'string' },
            },
            risks: {
                type: 'array',
                items: { type: 'string' },
            },
            patch_last_user: { type: 'string' },
            tags: {
                type: 'array',
                items: { type: 'string' },
            },
        },
        additionalProperties: true,
    };

    const responseLength = Number.isFinite(Number(nodeSpec.responseLength))
        ? Number(nodeSpec.responseLength)
        : Number.isFinite(Number(preset.responseLength))
            ? Number(preset.responseLength)
            : Number(settings.llmNodeResponseLength || 260);

    const toolOutput = await requestToolCallWithRetry(settings, promptMessages, {
        functionName: 'luker_orch_node_output',
        functionDescription: `Orchestrator node output for '${nodeSpec.id}'.`,
        parameters: nodeOutputSchema,
        responseLength,
        llmPresetName,
        apiSettingsOverride,
    });
    if (toolOutput && typeof toolOutput === 'object') {
        return toolOutput;
    }

    throw new Error(`Node '${nodeSpec.id}' returned invalid tool call payload.`);
}

async function executeNode(context, payload, nodeSpec, messages, previousNodeOutputs, presets, wiHint = '') {
    const preset = presets[nodeSpec.preset] || {};
    try {
        return await runLLMNode(context, payload, nodeSpec, preset, messages, previousNodeOutputs, wiHint);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] LLM node '${nodeSpec.id}' failed`, error);
        return {
            error: String(error?.message || error || 'Node request failed'),
            directives: [],
            risks: ['Node execution failed'],
        };
    }
}

async function runOrchestration(context, payload, messages, profile, wiHint = '') {
    const spec = sanitizeSpec(profile.spec);
    const stages = Array.isArray(spec?.stages) ? spec.stages : [];
    const stageOutputs = [];
    const previousNodeOutputs = new Map();

    for (const stage of stages) {
        const mode = String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const nodeOutputs = [];

        if (mode === 'parallel') {
            const outputs = await Promise.all(nodes.map(async (rawNode) => {
                const nodeSpec = normalizeNodeSpec(rawNode);
                return {
                    node: nodeSpec.id,
                    output: await executeNode(context, payload, nodeSpec, messages, previousNodeOutputs, profile.presets, wiHint),
                };
            }));
            nodeOutputs.push(...outputs);
        } else {
            for (const rawNode of nodes) {
                const nodeSpec = normalizeNodeSpec(rawNode);
                nodeOutputs.push({
                    node: nodeSpec.id,
                    output: await executeNode(context, payload, nodeSpec, messages, previousNodeOutputs, profile.presets, wiHint),
                });
            }
        }

        for (const item of nodeOutputs) {
            previousNodeOutputs.set(String(item.node), item.output);
        }

        stageOutputs.push({
            id: String(stage?.id || `stage_${stageOutputs.length + 1}`),
            mode,
            nodes: nodeOutputs,
        });
    }

    return { stageOutputs, previousNodeOutputs };
}

function compactStageOutputs(stageOutputs) {
    return stageOutputs.map(stage => ({
        id: stage.id,
        mode: stage.mode,
        nodes: stage.nodes.map(node => ({
            node: node.node,
            output: node.output,
        })),
    }));
}

function buildWISummary(payload) {
    return [
        truncate(payload?.worldInfoBefore || '', 160),
        truncate(payload?.worldInfoAfter || '', 160),
    ].filter(Boolean).join('\n');
}

function summarizeActivatedEntries(payload) {
    const result = [];
    const allActivated = payload?.worldInfoResolution?.allActivatedEntries;
    if (allActivated && typeof allActivated[Symbol.iterator] === 'function') {
        for (const entry of allActivated) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const label = String(entry.comment || entry.key || entry.content || '').trim();
            if (label) {
                result.push(truncate(label, 120));
            }
            if (result.length >= 10) {
                break;
            }
        }
    }

    if (result.length === 0 && Array.isArray(payload?.worldInfoDepth) && payload.worldInfoDepth.length > 0) {
        for (const depthEntry of payload.worldInfoDepth.slice(0, 4)) {
            const depth = Number(depthEntry?.depth);
            const text = Array.isArray(depthEntry?.entries) ? depthEntry.entries.join(' ') : '';
            if (text) {
                result.push(`depth:${Number.isFinite(depth) ? depth : 0} ${truncate(text, 100)}`);
            }
        }
    }

    return result;
}

function buildCapsule(payload, stageOutputs, profile, options = {}) {
    const capsule = {
        phase: options.phase || 'final',
        trigger: payload?.type || 'normal',
        profile_source: profile?.source || 'global',
        profile_key: profile?.key || 'global',
        stages: compactStageOutputs(stageOutputs),
    };

    if (extension_settings[MODULE_NAME].includeWorldInfoSummary && options.wiSummary) {
        capsule.wi_summary = truncate(options.wiSummary, 480);
    }
    if (Array.isArray(options.wiActivated) && options.wiActivated.length > 0) {
        capsule.wi_activated = options.wiActivated.slice(0, 10);
    }

    return `[[LUKER_ORCH_CAPSULE]]\n${JSON.stringify(capsule)}`;
}

function injectCapsule(context, text) {
    const settings = extension_settings[MODULE_NAME];
    const position = Number(settings.capsuleInjectPosition);
    const depth = Math.max(0, Math.min(10000, Math.floor(Number(settings.capsuleInjectDepth) || 0)));
    const role = Number(settings.capsuleInjectRole);
    context.setExtensionPrompt(
        CAPSULE_PROMPT_KEY,
        text,
        position,
        depth,
        true,
        role,
    );
}

async function onWorldInfoFinalized(payload) {
    const context = getContext();
    const settings = extension_settings[MODULE_NAME];

    if (!settings.enabled) {
        return;
    }
    if (!shouldRunOrchestrationForPayload(payload)) {
        return;
    }
    if (orchInFlight) {
        return;
    }
    orchInFlight = true;

    try {
        const profile = getEffectiveProfile(context);
        const messages = structuredClone(getCoreMessages(payload));
        if (messages.length === 0) {
            clearCapsulePrompt(context);
            clearLastCapsuleMetadata(context);
            return;
        }

        const wiSummary = buildWISummary(payload);
        const wiActivated = summarizeActivatedEntries(payload);
        const wiHint = wiActivated.slice(0, 5).join('; ');

        const finalRun = await runOrchestration(context, payload, messages, profile, wiHint);

        const capsuleText = buildCapsule(payload, finalRun.stageOutputs || [], profile, {
            phase: 'final',
            wiSummary,
            wiActivated,
        });
        injectCapsule(context, capsuleText);
        saveLastCapsuleMetadata(context, capsuleText, payload, profile);
    } finally {
        orchInFlight = false;
    }
}

function onMessageDeleted() {
    const context = getContext();
    clearCapsulePrompt(context);
    clearLastCapsuleMetadata(context);
}

function notifyInfo(message) {
    if (typeof toastr !== 'undefined') {
        toastr.info(String(message));
    }
}

function notifySuccess(message) {
    if (typeof toastr !== 'undefined') {
        toastr.success(String(message));
    }
}

function notifyError(message) {
    if (typeof toastr !== 'undefined') {
        toastr.error(String(message));
    }
}

function getSettings() {
    return extension_settings[MODULE_NAME];
}

function getCharacterDisplayName(context) {
    return getCharacterDisplayNameByAvatar(context, getCurrentAvatar(context)) || '(No character selected)';
}

function getCharacterDisplayNameByAvatar(context, avatar) {
    const target = String(avatar || '');
    if (!target) {
        return '';
    }
    const character = (context.characters || []).find(item => String(item?.avatar || '') === target);
    return String(character?.name || '').trim() || target;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function getOpenAIPresetNames(context) {
    const manager = context.getPresetManager?.('openai');
    if (!manager || typeof manager.getAllPresets !== 'function') {
        return [];
    }
    const names = manager.getAllPresets();
    if (!Array.isArray(names)) {
        return [];
    }
    return [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))];
}

function renderOpenAIPresetOptions(context, selectedName = '') {
    const selected = String(selectedName || '').trim();
    const names = getOpenAIPresetNames(context);
    const options = ['<option value="">(Current preset)</option>'];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (missing)</option>`);
    }
    return options.join('');
}

function getConnectionProfiles() {
    const profiles = extension_settings?.connectionManager?.profiles;
    if (!Array.isArray(profiles)) {
        return [];
    }
    return profiles
        .filter(profile => profile && typeof profile === 'object' && String(profile.mode || '') === 'cc')
        .map(profile => ({ ...profile, name: String(profile.name || '').trim() }))
        .filter(profile => profile.name)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function renderConnectionProfileOptions(selectedName = '') {
    const selected = String(selectedName || '').trim();
    const names = getConnectionProfiles().map(profile => profile.name);
    const options = ['<option value="">(Current API config)</option>'];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (missing)</option>`);
    }
    return options.join('');
}

function getConnectionProfileByName(name = '') {
    const target = String(name || '').trim();
    if (!target) {
        return null;
    }
    return getConnectionProfiles().find(profile => profile.name === target) || null;
}

function resolveRequestApiFromConnectionProfileName(context, profileName = '') {
    const fallbackApi = String(context?.mainApi || 'openai').trim() || 'openai';
    const profile = getConnectionProfileByName(profileName);
    if (!profile) {
        return fallbackApi;
    }

    const alias = String(profile.api || '').trim().toLowerCase();
    if (!alias) {
        return fallbackApi;
    }

    const mapEntry = CONNECT_API_MAP?.[alias];
    const selectedApi = String(mapEntry?.selected || '').trim();
    if (selectedApi) {
        return selectedApi;
    }

    if (alias === 'koboldhorde') {
        return 'kobold';
    }
    return fallbackApi;
}

function resolveChatSourceFromApiAlias(value, fallbackSource = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return String(fallbackSource || '').trim();
    }

    if (API_ALIAS_TO_CHAT_SOURCE[normalized]) {
        return API_ALIAS_TO_CHAT_SOURCE[normalized];
    }

    const mapEntry = Object.entries(CONNECT_API_MAP || {})
        .find(([alias]) => String(alias || '').toLowerCase() === normalized)?.[1];
    if (mapEntry?.selected === 'openai' && mapEntry?.source) {
        return String(mapEntry.source);
    }

    return String(fallbackSource || '').trim();
}

function buildApiSettingsOverrideFromConnectionProfileName(profileName, fallbackSource = '') {
    const profile = getConnectionProfileByName(profileName);
    if (!profile) {
        return null;
    }

    const overrides = {};
    const source = resolveChatSourceFromApiAlias(profile.api, fallbackSource);
    if (source) {
        overrides.chat_completion_source = source;
    }

    const resolvedSource = String(source || fallbackSource || '').trim();
    const modelField = CHAT_MODEL_SETTING_BY_SOURCE[resolvedSource];
    const modelValue = String(profile.model || '').trim();
    if (modelField && modelValue) {
        overrides[modelField] = modelValue;
    }

    const apiUrlValue = String(profile['api-url'] || '').trim();
    if (apiUrlValue) {
        if (resolvedSource === chat_completion_sources.CUSTOM) {
            overrides.custom_url = apiUrlValue;
        } else if (resolvedSource === chat_completion_sources.VERTEXAI) {
            overrides.vertexai_region = apiUrlValue;
        } else if (resolvedSource === chat_completion_sources.ZAI) {
            overrides.zai_endpoint = apiUrlValue;
        }
    }

    const promptPostProcessing = String(profile['prompt-post-processing'] || '').trim();
    if (promptPostProcessing) {
        overrides.custom_prompt_post_processing = promptPostProcessing;
    }

    const proxyName = String(profile.proxy || '').trim();
    if (proxyName && Array.isArray(proxies)) {
        const proxyPreset = proxies.find(item => String(item?.name || '') === proxyName);
        if (proxyPreset) {
            overrides.reverse_proxy = String(proxyPreset.url || '');
            overrides.proxy_password = String(proxyPreset.password || '');
        }
    }

    return Object.keys(overrides).length > 0 ? overrides : null;
}

function refreshOpenAIPresetSelectors(root, context, settings) {
    const selectorValues = [
        ['#luker_orch_llm_api_preset', settings.llmNodeApiPresetName],
        ['#luker_orch_llm_preset', settings.llmNodePresetName],
        ['#luker_orch_ai_suggest_api_preset', settings.aiSuggestApiPresetName],
        ['#luker_orch_ai_suggest_preset', settings.aiSuggestPresetName],
    ];

    for (const [selector, value] of selectorValues) {
        const select = root.find(selector);
        if (!select.length) {
            continue;
        }
        const isConnectionSelector = selector.endsWith('_api_preset');
        select.html(isConnectionSelector ? renderConnectionProfileOptions(value) : renderOpenAIPresetOptions(context, value));
        select.val(String(value || '').trim());
    }
}

function sanitizeIdentifierToken(value, fallback = '') {
    const normalized = String(value || '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_\-]/g, '_');
    return normalized || String(fallback || '');
}

function createPresetDraft(seed = {}) {
    const responseLength = Number(seed.responseLength);
    return {
        systemPrompt: String(seed.systemPrompt || '').trim(),
        userPromptTemplate: String(seed.userPromptTemplate || '').trim(),
        responseLength: Number.isFinite(responseLength) && responseLength > 0 ? responseLength : 260,
    };
}

function toEditablePresetMap(presets) {
    const normalized = {};
    const source = sanitizePresetMap(presets);
    for (const [key, value] of Object.entries(source)) {
        normalized[key] = createPresetDraft(value);
    }
    return normalized;
}

function toEditableSpec(spec, presets) {
    const sanitized = sanitizeSpec(spec);
    const presetIds = Object.keys(presets);
    const defaultPreset = presetIds[0] || 'distiller';

    const stages = (Array.isArray(sanitized.stages) ? sanitized.stages : [])
        .map((stage, stageIndex) => {
            const stageId = sanitizeIdentifierToken(stage?.id, `stage_${stageIndex + 1}`);
            const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
            const normalizedNodes = nodes.map((node, nodeIndex) => {
                const normalizedNode = normalizeNodeSpec(node);
                const preset = sanitizeIdentifierToken(normalizedNode.preset || normalizedNode.id, defaultPreset);
                if (!presets[preset]) {
                    presets[preset] = createPresetDraft();
                }
                return {
                    id: sanitizeIdentifierToken(normalizedNode.id || preset, `node_${nodeIndex + 1}`),
                    preset,
                    responseLength: Number.isFinite(Number(normalizedNode.responseLength)) && Number(normalizedNode.responseLength) > 0
                        ? Number(normalizedNode.responseLength)
                        : '',
                    userPromptTemplate: String(normalizedNode.userPromptTemplate || ''),
                };
            });
            return {
                id: stageId,
                mode: String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
                nodes: normalizedNodes.length > 0
                    ? normalizedNodes
                    : [{
                        id: defaultPreset,
                        preset: defaultPreset,
                        responseLength: '',
                        userPromptTemplate: '',
                    }],
            };
        })
        .filter(stage => stage.nodes.length > 0);

    if (stages.length > 0) {
        return { stages };
    }

    return {
        stages: [{
            id: 'distill',
            mode: 'serial',
            nodes: [{
                id: defaultPreset,
                preset: defaultPreset,
                responseLength: '',
                userPromptTemplate: '',
            }],
        }],
    };
}

function serializeEditorSpec(editorSpec) {
    const stages = Array.isArray(editorSpec?.stages) ? editorSpec.stages : [];
    return sanitizeSpec({
        stages: stages
            .map((stage, stageIndex) => ({
                id: sanitizeIdentifierToken(stage?.id, `stage_${stageIndex + 1}`),
                mode: String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
                nodes: (Array.isArray(stage?.nodes) ? stage.nodes : [])
                    .map((node, nodeIndex) => {
                        const id = sanitizeIdentifierToken(node?.id, `node_${nodeIndex + 1}`);
                        const preset = sanitizeIdentifierToken(node?.preset, id);
                        const responseLength = Number(node?.responseLength);
                        const userPromptTemplate = String(node?.userPromptTemplate || '').trim();

                        const serialized = { id, preset };
                        if (userPromptTemplate) {
                            serialized.userPromptTemplate = userPromptTemplate;
                        }
                        if (Number.isFinite(responseLength) && responseLength > 0) {
                            serialized.responseLength = responseLength;
                        }
                        return serialized;
                    })
                    .filter(Boolean),
            }))
            .filter(stage => Array.isArray(stage.nodes) && stage.nodes.length > 0),
    });
}

function serializeEditorPresetMap(editorPresets) {
    return sanitizePresetMap(editorPresets || {});
}

function buildPresetPatch(basePresets, editedPresets) {
    const patch = {};
    for (const [key, preset] of Object.entries(editedPresets || {})) {
        const base = basePresets?.[key];
        if (!base) {
            patch[key] = preset;
            continue;
        }

        const delta = {};
        if (String(preset.systemPrompt || '') !== String(base.systemPrompt || '')) {
            delta.systemPrompt = preset.systemPrompt;
        }
        if (String(preset.userPromptTemplate || '') !== String(base.userPromptTemplate || '')) {
            delta.userPromptTemplate = preset.userPromptTemplate;
        }
        if (Number(preset.responseLength || 0) !== Number(base.responseLength || 0)) {
            delta.responseLength = Number(preset.responseLength || 0);
        }

        if (Object.keys(delta).length > 0) {
            patch[key] = delta;
        }
    }
    return patch;
}

function getCharacterByAvatar(context, avatar) {
    const target = String(avatar || '');
    if (!target) {
        return null;
    }
    return (context.characters || []).find(char => String(char?.avatar || '') === target) || null;
}

function getCharacterIndexByAvatar(context, avatar) {
    const target = String(avatar || '');
    if (!target) {
        return -1;
    }
    return (context.characters || []).findIndex(char => String(char?.avatar || '') === target);
}

function getCharacterExtensionDataByAvatar(context, avatar) {
    const character = getCharacterByAvatar(context, avatar);
    const payload = character?.data?.extensions?.[MODULE_NAME];
    return payload && typeof payload === 'object' ? payload : {};
}

function getCharacterOverrideByAvatar(context, avatar) {
    const payload = getCharacterExtensionDataByAvatar(context, avatar);
    const override = payload?.override;
    return override && typeof override === 'object' ? override : null;
}

function getCharacterCardSnapshot(context, avatar) {
    const character = getCharacterByAvatar(context, avatar) || {};
    const fromCardFields = (avatar && avatar === getCurrentAvatar(context) && typeof context.getCharacterCardFields === 'function')
        ? (context.getCharacterCardFields() || {})
        : {};

    const readField = (field) => {
        const value = character?.[field]
            ?? character?.data?.[field]
            ?? fromCardFields?.[field];
        return String(value || '').trim();
    };

    return {
        avatar: String(avatar || ''),
        name: String(character?.name || fromCardFields?.name || '').trim(),
        description: readField('description'),
        personality: readField('personality'),
        scenario: readField('scenario'),
        system: readField('system'),
        first_mes: readField('first_mes'),
        mes_example: readField('mes_example'),
        creator_notes: readField('creator_notes'),
    };
}

function ensureEditorIntegrity(editor) {
    if (!editor || typeof editor !== 'object') {
        return;
    }
    if (!editor.presets || typeof editor.presets !== 'object' || Object.keys(editor.presets).length === 0) {
        editor.presets = toEditablePresetMap(defaultPresets);
    }
    editor.spec = toEditableSpec(editor.spec || defaultSpec, editor.presets);
}

function pickDefaultPreset(editor) {
    const keys = Object.keys(editor?.presets || {});
    if (keys.length === 0) {
        editor.presets = toEditablePresetMap(defaultPresets);
        return Object.keys(editor.presets)[0] || 'distiller';
    }
    return keys[0];
}

function createNewStage(editor) {
    const defaultPreset = pickDefaultPreset(editor);
    const index = (editor.spec?.stages?.length || 0) + 1;
    return {
        id: `stage_${index}`,
        mode: 'serial',
        nodes: [{
            id: defaultPreset,
            preset: defaultPreset,
            responseLength: '',
            userPromptTemplate: '',
        }],
    };
}

function loadGlobalEditorState() {
    const settings = getSettings();
    const presets = toEditablePresetMap(settings.presets);
    const spec = toEditableSpec(settings.orchestrationSpec, presets);
    return { spec, presets };
}

function loadCharacterEditorState(context, avatar) {
    const settings = getSettings();
    const safeAvatar = String(avatar || '');
    const override = getCharacterOverrideByAvatar(context, safeAvatar);
    const mergedPresets = sanitizePresetMap({
        ...settings.presets,
        ...(override?.presetPatch || {}),
    });
    const presets = toEditablePresetMap(mergedPresets);
    const spec = toEditableSpec(override?.spec || settings.orchestrationSpec, presets);
    return {
        avatar: safeAvatar,
        enabled: Boolean(override?.enabled),
        notes: String(override?.notes || ''),
        spec,
        presets,
    };
}

function initializeUiState(context) {
    uiState.selectedAvatar = String(getCurrentAvatar(context) || '').trim();
    uiState.globalEditor = loadGlobalEditorState();
    uiState.characterEditor = loadCharacterEditorState(context, uiState.selectedAvatar);
    ensureEditorIntegrity(uiState.globalEditor);
    ensureEditorIntegrity(uiState.characterEditor);
}

function syncCharacterEditorWithActiveAvatar(context) {
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (activeAvatar === uiState.selectedAvatar) {
        return;
    }
    uiState.selectedAvatar = activeAvatar;
    uiState.characterEditor = loadCharacterEditorState(context, activeAvatar);
    ensureEditorIntegrity(uiState.characterEditor);
}

function hasCharacterOverride(context, avatar) {
    return Boolean(getCharacterOverrideByAvatar(context, avatar));
}

function getDisplayedScope(context, settings) {
    void settings;
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    return hasCharacterOverride(context, activeAvatar) ? 'character' : 'global';
}

function getEditorByScope(scope) {
    return scope === 'character' ? uiState.characterEditor : uiState.globalEditor;
}

function renderPresetOptions(presets, selectedPreset) {
    const selected = String(selectedPreset || '');
    const ids = Object.keys(presets || {});
    const options = [];

    if (selected && !presets[selected]) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (missing)</option>`);
    }

    for (const presetId of ids) {
        options.push(`<option value="${escapeHtml(presetId)}"${presetId === selected ? ' selected' : ''}>${escapeHtml(presetId)}</option>`);
    }

    return options.join('');
}

function renderWorkflowBoard(scope, editor) {
    const stages = Array.isArray(editor?.spec?.stages) ? editor.spec.stages : [];
    if (stages.length === 0) {
        return '<div class="luker_orch_empty_hint">No stages yet. Add one stage to start orchestration.</div>';
    }

    return stages.map((stage, stageIndex) => {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const nodeCards = nodes.map((node, nodeIndex) => `
<div class="luker_orch_node_card">
    <div class="luker_orch_node_header">
        <b>Node ${nodeIndex + 1}</b>
        <div class="luker_orch_btnrow">
            <div class="menu_button menu_button_small" data-luker-action="node-move-up" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}">Up</div>
            <div class="menu_button menu_button_small" data-luker-action="node-move-down" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}">Down</div>
            <div class="menu_button menu_button_small" data-luker-action="node-delete" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}">Delete</div>
        </div>
    </div>
    <label>Node ID</label>
    <input class="text_pole" data-luker-field="node-id" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" value="${escapeHtml(node.id)}" />
    <label>Preset</label>
    <select class="text_pole" data-luker-field="node-preset" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}">
        ${renderPresetOptions(editor.presets, node.preset)}
    </select>
    <label>Response Length (optional)</label>
    <input class="text_pole" type="number" min="32" step="8" data-luker-field="node-response-length" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" value="${escapeHtml(node.responseLength)}" />
    <label>Node Prompt Template (optional)</label>
    <textarea class="text_pole textarea_compact" rows="4" data-luker-field="node-template" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" placeholder="Use {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}, {{wi_summary}}">${escapeHtml(node.userPromptTemplate)}</textarea>
</div>`).join('');

        return `
<div class="luker_orch_stage_card">
    <div class="luker_orch_stage_header">
        <div>
            <div class="luker_orch_stage_label">Stage ${stageIndex + 1}</div>
            <input class="text_pole" data-luker-field="stage-id" data-scope="${scope}" data-stage-index="${stageIndex}" value="${escapeHtml(stage.id)}" />
        </div>
        <div>
            <label>Execution</label>
            <select class="text_pole" data-luker-field="stage-mode" data-scope="${scope}" data-stage-index="${stageIndex}">
                <option value="serial"${stage.mode === 'serial' ? ' selected' : ''}>Serial</option>
                <option value="parallel"${stage.mode === 'parallel' ? ' selected' : ''}>Parallel</option>
            </select>
        </div>
        <div class="luker_orch_btnrow">
            <div class="menu_button menu_button_small" data-luker-action="stage-move-up" data-scope="${scope}" data-stage-index="${stageIndex}">Up</div>
            <div class="menu_button menu_button_small" data-luker-action="stage-move-down" data-scope="${scope}" data-stage-index="${stageIndex}">Down</div>
            <div class="menu_button menu_button_small" data-luker-action="stage-delete" data-scope="${scope}" data-stage-index="${stageIndex}">Delete</div>
        </div>
    </div>
    <div class="luker_orch_stage_meta">${stage.mode === 'parallel' ? 'Nodes run in parallel.' : 'Nodes run in serial order.'}</div>
    <div class="luker_orch_nodes_grid">${nodeCards}</div>
    <div class="menu_button menu_button_small" data-luker-action="node-add" data-scope="${scope}" data-stage-index="${stageIndex}">Add Node</div>
</div>`;
    }).join('<div class="luker_orch_stage_connector">Then</div>');
}

function renderPresetBoard(scope, editor) {
    const entries = Object.entries(editor?.presets || {}).sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) {
        return '<div class="luker_orch_empty_hint">No presets yet.</div>';
    }

    return entries.map(([presetId, preset]) => `
<div class="luker_orch_preset_card">
    <div class="luker_orch_preset_header">
        <b>${escapeHtml(presetId)}</b>
        <div class="menu_button menu_button_small" data-luker-action="preset-delete" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">Delete</div>
    </div>
    <label>Response Length</label>
    <input class="text_pole" type="number" min="32" step="8" data-luker-field="preset-response-length" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}" value="${escapeHtml(preset.responseLength)}" />
    <label>System Prompt</label>
    <textarea class="text_pole textarea_compact" rows="4" data-luker-field="preset-system-prompt" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">${escapeHtml(preset.systemPrompt)}</textarea>
    <label>User Prompt Template</label>
    <textarea class="text_pole textarea_compact" rows="5" data-luker-field="preset-user-template" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">${escapeHtml(preset.userPromptTemplate)}</textarea>
</div>`).join('');
}

function renderEditorWorkspace(scope, editor, title) {
    return `
<div class="luker_orch_workspace" data-luker-scope-root="${scope}">
    <h5 class="margin0">${escapeHtml(title)}</h5>
    <div class="luker_orch_workspace_grid">
        <div class="luker_orch_workspace_col">
            <div class="luker_orch_col_title">Workflow</div>
            <div class="luker_orch_flow">${renderWorkflowBoard(scope, editor)}</div>
            <div class="menu_button menu_button_small" data-luker-action="stage-add" data-scope="${scope}">Add Stage</div>
        </div>
        <div class="luker_orch_workspace_col">
            <div class="luker_orch_col_title">Agent Presets</div>
            <div class="luker_orch_presets">${renderPresetBoard(scope, editor)}</div>
            <div class="luker_orch_preset_add_row">
                <input class="text_pole" data-luker-new-preset="${scope}" placeholder="new_preset_id" />
                <div class="menu_button menu_button_small" data-luker-action="preset-add" data-scope="${scope}">Add Preset</div>
            </div>
        </div>
    </div>
</div>`;
}

function renderDynamicPanels(root, context) {
    const settings = getSettings();
    syncCharacterEditorWithActiveAvatar(context);
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    const override = activeAvatar ? getCharacterOverrideByAvatar(context, activeAvatar) : null;
    const scope = getDisplayedScope(context, settings);
    const editor = getEditorByScope(scope);
    const isCharacterScope = scope === 'character';
    const isOverrideEnabled = Boolean(override?.enabled);
    const profileTitle = isCharacterScope
        ? `Character Override: ${getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar}`
        : 'Global Orchestration Profile';

    root.find('#luker_orch_profile_target').text(
        activeAvatar
            ? (getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar)
            : '(No character card)',
    );
    root.find('#luker_orch_profile_mode').text(
        isCharacterScope
            ? (isOverrideEnabled ? 'Character override (enabled)' : 'Character override (configured, currently disabled)')
            : 'Global profile (no character override for current card)',
    );
    const saveTarget = String(settings.saveTarget || 'global');
    const saveTargetSelect = root.find('#luker_orch_save_target');
    saveTargetSelect.val(saveTarget);
    const charOption = saveTargetSelect.find('option[value="character"]');
    charOption.prop('disabled', !activeAvatar);
    if (!activeAvatar && saveTarget === 'character') {
        settings.saveTarget = 'global';
        saveSettingsDebounced();
        saveTargetSelect.val('global');
    }
    root.find('#luker_orch_effective_visual').html(renderEditorWorkspace(scope, editor, profileTitle));
    root.find('#luker_orch_clear_character_button').toggle(isCharacterScope);
    root.find('#luker_orch_ai_goal').val(String(uiState.aiGoal || ''));
}

function updateUiStatus(text) {
    jQuery('#luker_orch_status').text(String(text || ''));
}

function persistGlobalEditorFrom(settings, editor) {
    ensureEditorIntegrity(editor);
    settings.orchestrationSpec = serializeEditorSpec(editor.spec);
    settings.presets = serializeEditorPresetMap(editor.presets);
    saveSettingsDebounced();
}

async function persistCharacterEditor(context, settings, avatar, {
    editor = uiState.characterEditor,
    forceEnabled = null,
    notes = null,
} = {}) {
    const target = String(avatar || '');
    if (!target) {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }

    ensureEditorIntegrity(editor);
    const globalPresets = serializeEditorPresetMap(settings.presets);
    const characterPresets = serializeEditorPresetMap(editor.presets);
    const sourceEnabled = typeof editor?.enabled === 'boolean' ? editor.enabled : true;
    const sourceNotes = notes === null ? String(editor?.notes || '') : String(notes || '');
    const presetPatch = buildPresetPatch(globalPresets, characterPresets);
    const overridePayload = {
        enabled: forceEnabled === null ? Boolean(sourceEnabled) : Boolean(forceEnabled),
        spec: serializeEditorSpec(editor.spec),
        presetPatch,
        updatedAt: Date.now(),
        name: getCharacterDisplayNameByAvatar(context, target),
        notes: sourceNotes,
    };

    const previous = getCharacterExtensionDataByAvatar(context, target);
    const nextPayload = {
        ...previous,
        override: overridePayload,
    };
    await context.writeExtensionField(characterIndex, MODULE_NAME, nextPayload);
    return true;
}

function isPresetUsed(editor, presetId) {
    const stages = editor?.spec?.stages || [];
    return stages.some(stage => (stage.nodes || []).some(node => String(node.preset || '') === String(presetId || '')));
}

function buildAiProfileFromToolCalls(toolCalls) {
    const draftStages = [];
    const draftPresets = {};
    const draftCoverage = {};
    const notesParts = [];
    let finalizeCalled = false;
    let hasStageUpdate = false;

    const upsertStage = (rawStage) => {
        if (!rawStage || typeof rawStage !== 'object') {
            return;
        }
        const stageId = String(rawStage.id || '').trim();
        if (!stageId) {
            return;
        }
        const mode = String(rawStage.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
        const nodes = Array.isArray(rawStage.nodes) ? rawStage.nodes : [];
        const normalizedNodes = nodes
            .map(rawNode => normalizeNodeSpec(rawNode))
            .filter(node => Boolean(node?.id));
        if (normalizedNodes.length === 0) {
            return;
        }
        const nextStage = { id: stageId, mode, nodes: normalizedNodes };
        const existingIndex = draftStages.findIndex(stage => String(stage.id || '') === stageId);
        if (existingIndex >= 0) {
            draftStages[existingIndex] = nextStage;
        } else {
            draftStages.push(nextStage);
        }
        hasStageUpdate = true;
    };

    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const fnName = String(call?.name || '').trim();
        const args = call?.arguments && typeof call.arguments === 'object' ? call.arguments : {};
        if (!fnName) {
            continue;
        }
        if (fnName === 'luker_orch_append_stage') {
            upsertStage(args.stage);
            continue;
        }
        if (fnName === 'luker_orch_upsert_preset') {
            const presetId = String(args.preset_id || '').trim();
            if (!presetId) {
                continue;
            }
            draftPresets[presetId] = {
                systemPrompt: String(args.systemPrompt || '').trim(),
                userPromptTemplate: String(args.userPromptTemplate || '').trim(),
                responseLength: Number.isFinite(Number(args.responseLength)) && Number(args.responseLength) > 0
                    ? Number(args.responseLength)
                    : Number(defaultPresets[presetId]?.responseLength || 260),
            };
            continue;
        }
        if (fnName === 'luker_orch_set_coverage_axis') {
            const axis = String(args.axis || '').trim();
            if (!axis || !Object.hasOwn(ORCH_AI_QUALITY_AXES, axis)) {
                continue;
            }
            draftCoverage[axis] = {
                node: String(args.node || '').trim(),
                strategy: String(args.strategy || '').trim(),
            };
            continue;
        }
        if (fnName === 'luker_orch_set_notes') {
            const text = String(args.notes || '').trim();
            if (text) {
                notesParts.push(text);
            }
            continue;
        }
        if (fnName === 'luker_orch_finalize_profile') {
            finalizeCalled = true;
        }
    }

    const presetPatch = {};
    for (const [presetId, preset] of Object.entries(draftPresets)) {
        if (!preset || typeof preset !== 'object') {
            continue;
        }
        presetPatch[presetId] = {
            systemPrompt: String(preset.systemPrompt || '').trim(),
            userPromptTemplate: String(preset.userPromptTemplate || '').trim(),
            responseLength: Number.isFinite(Number(preset.responseLength)) && Number(preset.responseLength) > 0
                ? Number(preset.responseLength)
                : 260,
        };
    }

    return {
        orchestrationSpec: sanitizeSpec({ stages: draftStages }),
        presetPatch,
        coverageChecklist: draftCoverage,
        notes: notesParts.join('\n\n').trim(),
        finalizeCalled,
        hasStageUpdate,
    };
}

async function runAiCharacterProfileBuild(context, settings) {
    syncCharacterEditorWithActiveAvatar(context);
    const avatar = String(getCurrentAvatar(context) || '').trim();
    if (!avatar) {
        throw new Error('No character selected.');
    }

    const characterCard = getCharacterCardSnapshot(context, avatar);
    if (!characterCard.name) {
        throw new Error('Selected character card is invalid.');
    }

    const currentSpec = sanitizeSpec(settings.orchestrationSpec);
    const currentPresets = serializeEditorPresetMap(settings.presets);
    const suggestSystemPrompt = [
        'You design RP multi-agent orchestration profiles for a specific character card.',
        'Use tool calls only. Do not return plain JSON text.',
        'Call multiple functions in one response to build the profile incrementally.',
        'Keep stages concise, operational, and easy to run in a single request turn.',
        'Runtime context guarantee: both orchestration agents and final generation already see assembled preset context, character card context, and world-info activation context.',
        'Do NOT repeat full character biography in every node prompt. Prefer compact behavior policy and decision criteria.',
        'Each node must have a distinct role, concrete output focus, and minimal overlap.',
        'Prefer practical distiller/director/critic style agents and add custom presets only when necessary.',
        'Design for robust RP quality: user-intent understanding, character independence, anti-OOC, realism, and world autonomy.',
        `Allowed template placeholders ONLY: ${ALLOWED_TEMPLATE_VARS.map(x => `{{${x}}}`).join(', ')}.`,
        'Do not invent any other placeholder names.',
        'When designing prompts, encode checks and directives, not verbose restatements of the card.',
        'Call luker_orch_append_stage one stage per call.',
        'Call luker_orch_upsert_preset one preset per call.',
        'Call luker_orch_set_coverage_axis one axis per call.',
        'Call luker_orch_set_notes if needed.',
        'Call luker_orch_finalize_profile at the end.',
    ].join('\n');
    const suggestUserPrompt = JSON.stringify({
        character: characterCard,
        override_goal: String(uiState.aiGoal || ''),
        runtime_context_guarantees: {
            preset_assembly_is_applied: true,
            character_card_context_is_available: true,
            world_info_context_is_available: true,
            recent_messages_are_available: true,
            reminder: 'Do not duplicate static card data in every node; use behavior-focused checks.',
        },
        mandatory_quality_axes: ORCH_AI_QUALITY_AXES,
        global_orchestration_spec: currentSpec,
        global_presets: currentPresets,
        tool_protocol: {
            append_stage: {
                function: 'luker_orch_append_stage',
                shape: {
                    stage: {
                        id: 'string',
                        mode: 'serial|parallel',
                        nodes: [{ id: 'string', preset: 'string', userPromptTemplate: 'optional string', responseLength: 'optional number' }],
                    },
                },
            },
            upsert_preset: {
                function: 'luker_orch_upsert_preset',
                shape: {
                    preset_id: 'string',
                    systemPrompt: 'string',
                    userPromptTemplate: `Use only: ${ALLOWED_TEMPLATE_VARS.map(x => `{{${x}}}`).join(', ')}`,
                    responseLength: 320,
                },
            },
            coverage_axis: {
                function: 'luker_orch_set_coverage_axis',
                shape: {
                    axis: Object.keys(ORCH_AI_QUALITY_AXES),
                    node: 'node_or_preset_id',
                    strategy: 'how this node enforces the quality axis',
                },
            },
            notes: {
                function: 'luker_orch_set_notes',
                shape: { notes: 'string' },
            },
            finalize: {
                function: 'luker_orch_finalize_profile',
                shape: { ok: true, summary: 'optional string' },
            },
        },
    });

    const aiSuggestApiPresetName = String(settings.aiSuggestApiPresetName || '').trim();
    const suggestPresetName = String(settings.aiSuggestPresetName || '').trim();
    const promptMessages = buildPresetAwareMessages(
        context,
        settings,
        suggestSystemPrompt,
        suggestUserPrompt,
        {
            api: resolveRequestApiFromConnectionProfileName(context, aiSuggestApiPresetName),
            promptPresetName: suggestPresetName,
        },
    );

    const tools = [
        {
            type: 'function',
            function: {
                name: 'luker_orch_append_stage',
                description: 'Append or replace one orchestration stage.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                mode: { type: 'string', enum: ['serial', 'parallel'] },
                                nodes: {
                                    type: 'array',
                                    items: {
                                        anyOf: [
                                            { type: 'string' },
                                            {
                                                type: 'object',
                                                properties: {
                                                    id: { type: 'string' },
                                                    preset: { type: 'string' },
                                                    userPromptTemplate: { type: 'string' },
                                                    responseLength: { type: 'number' },
                                                },
                                                required: ['id', 'preset'],
                                                additionalProperties: false,
                                            },
                                        ],
                                    },
                                },
                            },
                            required: ['id', 'mode', 'nodes'],
                            additionalProperties: false,
                        },
                    },
                    required: ['stage'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_upsert_preset',
                description: 'Define or update one node preset.',
                parameters: {
                    type: 'object',
                    properties: {
                        preset_id: { type: 'string' },
                        systemPrompt: { type: 'string' },
                        userPromptTemplate: { type: 'string' },
                        responseLength: { type: 'number' },
                    },
                    required: ['preset_id', 'systemPrompt', 'userPromptTemplate'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_set_coverage_axis',
                description: 'Set one quality coverage axis mapping.',
                parameters: {
                    type: 'object',
                    properties: {
                        axis: { type: 'string', enum: Object.keys(ORCH_AI_QUALITY_AXES) },
                        node: { type: 'string' },
                        strategy: { type: 'string' },
                    },
                    required: ['axis', 'strategy'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_set_notes',
                description: 'Set profile-level notes.',
                parameters: {
                    type: 'object',
                    properties: {
                        notes: { type: 'string' },
                    },
                    required: ['notes'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_finalize_profile',
                description: 'Finalize the incremental profile construction.',
                parameters: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        summary: { type: 'string' },
                    },
                    additionalProperties: false,
                },
            },
        },
    ];
    const allowedNames = new Set(tools.map(tool => String(tool?.function?.name || '').trim()).filter(Boolean));
    const apiSettingsOverride = buildApiSettingsOverrideFromConnectionProfileName(
        aiSuggestApiPresetName,
        String(context?.chatCompletionSettings?.chat_completion_source || ''),
    );

    updateUiStatus(`Generating orchestration profile for ${characterCard.name}...`);
    const toolCalls = await requestToolCallsWithRetry(settings, promptMessages, {
        tools,
        allowedNames,
        responseLength: Number(settings.aiSuggestResponseLength || 600),
        llmPresetName: suggestPresetName,
        apiSettingsOverride,
    });
    const parsed = buildAiProfileFromToolCalls(toolCalls);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Function output is invalid.');
    }
    if (!parsed.hasStageUpdate) {
        throw new Error('AI build did not provide any stage tool calls.');
    }
    if (!parsed.finalizeCalled) {
        notifyInfo('AI build did not call finalize explicitly. Parsed output was used anyway.');
    }

    validateAiBuildTemplateVariables(parsed.orchestrationSpec, parsed.presetPatch);
    const coverageReport = analyzeAiBuildCoverageChecklist(parsed.coverageChecklist, parsed.orchestrationSpec);
    if (!coverageReport.provided) {
        notifyInfo('AI build returned no coverage checklist. Profile saved, but quality coverage is not explicitly mapped.');
    } else {
        if (coverageReport.missing.length > 0) {
            notifyInfo(`AI build checklist has missing strategy entries: ${coverageReport.missing.join(', ')}`);
        }
        if (coverageReport.invalidNodeRefs.length > 0) {
            notifyInfo(`AI build checklist references unknown nodes/presets: ${coverageReport.invalidNodeRefs.join(', ')}`);
        }
    }

    const suggestedSpec = sanitizeSpec(parsed.orchestrationSpec);
    const suggestedPatch = parsed.presetPatch && typeof parsed.presetPatch === 'object' ? parsed.presetPatch : {};
    const mergedPresets = sanitizePresetMap({
        ...serializeEditorPresetMap(settings.presets),
        ...suggestedPatch,
    });

    uiState.characterEditor.spec = toEditableSpec(suggestedSpec, mergedPresets);
    uiState.characterEditor.presets = toEditablePresetMap(mergedPresets);
    uiState.characterEditor.enabled = true;
    const checklistText = Object.entries(coverageReport.normalized || {})
        .map(([axis, value]) => {
            const node = String(value?.node || '').trim();
            const strategy = String(value?.strategy || '').trim();
            return { axis, node, strategy };
        })
        .filter(row => row.axis && row.strategy)
        .map(row => row.node ? `${row.axis} -> [${row.node}] ${row.strategy}` : `${row.axis} -> ${row.strategy}`)
        .join('\n');
    uiState.characterEditor.notes = [
        String(parsed.notes || '').trim(),
        checklistText ? `Coverage Checklist\n${checklistText}` : '',
    ].filter(Boolean).join('\n\n');

    await persistCharacterEditor(context, settings, avatar, { forceEnabled: true });
}

function bindUi() {
    const context = getContext();
    const settings = getSettings();

    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    initializeUiState(context);
    root.find('#luker_orch_enabled').prop('checked', Boolean(settings.enabled));
    root.find('#luker_orch_llm_api_preset').val(String(settings.llmNodeApiPresetName || ''));
    root.find('#luker_orch_llm_preset').val(String(settings.llmNodePresetName || ''));
    root.find('#luker_orch_ai_suggest_api_preset').val(String(settings.aiSuggestApiPresetName || ''));
    root.find('#luker_orch_ai_suggest_preset').val(String(settings.aiSuggestPresetName || ''));
    root.find('#luker_orch_preset_envelope_chars').val(String(settings.promptEnvelopeMaxChars || 2800));
    root.find('#luker_orch_max_recent_messages').val(String(settings.maxRecentMessages || 14));
    root.find('#luker_orch_tool_retries').val(String(settings.toolCallRetryMax ?? 2));
    root.find('#luker_orch_capsule_position').val(String(Number(settings.capsuleInjectPosition)));
    root.find('#luker_orch_capsule_depth').val(String(Number(settings.capsuleInjectDepth || 0)));
    root.find('#luker_orch_capsule_role').val(String(Number(settings.capsuleInjectRole)));
    root.find('#luker_orch_save_target').val(String(settings.saveTarget || 'global'));
    refreshOpenAIPresetSelectors(root, context, settings);
    renderDynamicPanels(root, context);

    root.off('.lukerOrch');

    root.on('input.lukerOrch', '#luker_orch_enabled', function () {
        settings.enabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_llm_api_preset', function () {
        settings.llmNodeApiPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_llm_preset', function () {
        settings.llmNodePresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_ai_suggest_api_preset', function () {
        settings.aiSuggestApiPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_ai_suggest_preset', function () {
        settings.aiSuggestPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_preset_envelope_chars', function () {
        settings.promptEnvelopeMaxChars = Math.max(1000, Number(jQuery(this).val()) || 2800);
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_max_recent_messages', function () {
        settings.maxRecentMessages = Math.max(1, Math.min(80, Number(jQuery(this).val()) || 14));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_tool_retries', function () {
        settings.toolCallRetryMax = Math.max(0, Math.min(10, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_capsule_position', function () {
        const value = Number(jQuery(this).val());
        const allowed = [extension_prompt_types.IN_PROMPT, extension_prompt_types.IN_CHAT, extension_prompt_types.BEFORE_PROMPT];
        settings.capsuleInjectPosition = allowed.includes(value) ? value : extension_prompt_types.IN_CHAT;
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_capsule_depth', function () {
        settings.capsuleInjectDepth = Math.max(0, Math.min(10000, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_capsule_role', function () {
        const value = Number(jQuery(this).val());
        const allowedRoles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
        settings.capsuleInjectRole = allowedRoles.includes(value) ? value : extension_prompt_roles.SYSTEM;
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_save_target', function () {
        const value = String(jQuery(this).val() || '').trim();
        settings.saveTarget = value === 'character' ? 'character' : 'global';
        saveSettingsDebounced();
        renderDynamicPanels(root, context);
    });

    root.on('input.lukerOrch', '#luker_orch_ai_goal', function () {
        uiState.aiGoal = String(jQuery(this).val() || '');
    });

    root.on('input.lukerOrch change.lukerOrch', '[data-luker-field]', function () {
        const field = String(jQuery(this).data('luker-field') || '');
        const scope = String(jQuery(this).data('scope') || 'global');
        const stageIndex = Number(jQuery(this).data('stage-index'));
        const nodeIndex = Number(jQuery(this).data('node-index'));
        const presetId = String(jQuery(this).data('preset-id') || '');
        const editor = getEditorByScope(scope);
        ensureEditorIntegrity(editor);

        if (field.startsWith('stage-') && Number.isInteger(stageIndex) && editor.spec.stages[stageIndex]) {
            if (field === 'stage-id') {
                editor.spec.stages[stageIndex].id = String(jQuery(this).val() || '');
            } else if (field === 'stage-mode') {
                editor.spec.stages[stageIndex].mode = String(jQuery(this).val() || 'serial') === 'parallel' ? 'parallel' : 'serial';
            }
            return;
        }

        if (field.startsWith('node-') && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex)) {
            const stage = editor.spec.stages[stageIndex];
            const node = stage?.nodes?.[nodeIndex];
            if (!node) {
                return;
            }
            if (field === 'node-id') {
                node.id = String(jQuery(this).val() || '');
            } else if (field === 'node-preset') {
                node.preset = sanitizeIdentifierToken(jQuery(this).val(), pickDefaultPreset(editor));
            } else if (field === 'node-response-length') {
                const value = String(jQuery(this).val() || '').trim();
                node.responseLength = value ? Math.max(32, Number(value) || 0) : '';
            } else if (field === 'node-template') {
                node.userPromptTemplate = String(jQuery(this).val() || '');
            }
            return;
        }

        if (field.startsWith('preset-') && presetId && editor.presets[presetId]) {
            const preset = editor.presets[presetId];
            if (field === 'preset-response-length') {
                preset.responseLength = Math.max(32, Number(jQuery(this).val()) || 260);
            } else if (field === 'preset-system-prompt') {
                preset.systemPrompt = String(jQuery(this).val() || '');
            } else if (field === 'preset-user-template') {
                preset.userPromptTemplate = String(jQuery(this).val() || '');
            }
        }
    });

    root.on('click.lukerOrch', '[data-luker-action]', async function () {
        const action = String(jQuery(this).data('luker-action') || '');
        const scope = String(jQuery(this).data('scope') || 'global');
        const stageIndex = Number(jQuery(this).data('stage-index'));
        const nodeIndex = Number(jQuery(this).data('node-index'));
        const presetId = String(jQuery(this).data('preset-id') || '');
        const editor = getEditorByScope(scope);
        ensureEditorIntegrity(editor);

        if (action === 'stage-add') {
            editor.spec.stages.push(createNewStage(editor));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'stage-delete' && Number.isInteger(stageIndex) && editor.spec.stages[stageIndex]) {
            editor.spec.stages.splice(stageIndex, 1);
            if (editor.spec.stages.length === 0) {
                editor.spec.stages.push(createNewStage(editor));
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'stage-move-up' && Number.isInteger(stageIndex) && stageIndex > 0) {
            const [stage] = editor.spec.stages.splice(stageIndex, 1);
            editor.spec.stages.splice(stageIndex - 1, 0, stage);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'stage-move-down' && Number.isInteger(stageIndex) && stageIndex >= 0 && stageIndex < editor.spec.stages.length - 1) {
            const [stage] = editor.spec.stages.splice(stageIndex, 1);
            editor.spec.stages.splice(stageIndex + 1, 0, stage);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-add' && Number.isInteger(stageIndex) && editor.spec.stages[stageIndex]) {
            const defaultPreset = pickDefaultPreset(editor);
            editor.spec.stages[stageIndex].nodes.push({
                id: defaultPreset,
                preset: defaultPreset,
                responseLength: '',
                userPromptTemplate: '',
            });
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-delete' && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex)) {
            const stage = editor.spec.stages[stageIndex];
            if (!stage?.nodes?.[nodeIndex]) {
                return;
            }
            stage.nodes.splice(nodeIndex, 1);
            if (stage.nodes.length === 0) {
                const defaultPreset = pickDefaultPreset(editor);
                stage.nodes.push({
                    id: defaultPreset,
                    preset: defaultPreset,
                    responseLength: '',
                    userPromptTemplate: '',
                });
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-move-up' && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex) && nodeIndex > 0) {
            const nodes = editor.spec.stages[stageIndex]?.nodes || [];
            const [node] = nodes.splice(nodeIndex, 1);
            nodes.splice(nodeIndex - 1, 0, node);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-move-down' && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex)) {
            const nodes = editor.spec.stages[stageIndex]?.nodes || [];
            if (nodeIndex < 0 || nodeIndex >= nodes.length - 1) {
                return;
            }
            const [node] = nodes.splice(nodeIndex, 1);
            nodes.splice(nodeIndex + 1, 0, node);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'preset-add') {
            const scopeRoot = jQuery(this).closest('[data-luker-scope-root]');
            const input = scopeRoot.find(`[data-luker-new-preset="${scope}"]`);
            const candidate = sanitizeIdentifierToken(input.val(), '');
            if (!candidate) {
                notifyError('Preset ID cannot be empty.');
                return;
            }
            if (editor.presets[candidate]) {
                notifyError(`Preset '${candidate}' already exists.`);
                return;
            }
            editor.presets[candidate] = createPresetDraft();
            input.val('');
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'preset-delete' && presetId) {
            if (!editor.presets[presetId]) {
                return;
            }
            if (isPresetUsed(editor, presetId)) {
                notifyError(`Preset '${presetId}' is still used by workflow nodes.`);
                return;
            }
            delete editor.presets[presetId];
            ensureEditorIntegrity(editor);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'reload-current') {
            syncCharacterEditorWithActiveAvatar(context);
            const activeAvatar = String(getCurrentAvatar(context) || '').trim();
            if (hasCharacterOverride(context, activeAvatar)) {
                uiState.characterEditor = loadCharacterEditorState(context, activeAvatar);
                ensureEditorIntegrity(uiState.characterEditor);
                updateUiStatus(`Reloaded character override for ${getCharacterDisplayNameByAvatar(context, activeAvatar) || 'N/A'}.`);
            } else {
                uiState.globalEditor = loadGlobalEditorState();
                ensureEditorIntegrity(uiState.globalEditor);
                updateUiStatus('Reloaded global profile from settings.');
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'save-current') {
            syncCharacterEditorWithActiveAvatar(context);
            const activeAvatar = String(getCurrentAvatar(context) || '').trim();
            const sourceScope = getDisplayedScope(context, settings);
            const sourceEditor = getEditorByScope(sourceScope);
            if (String(settings.saveTarget || 'global') === 'character') {
                if (!activeAvatar) {
                    notifyError('No character selected.');
                    return;
                }
                const ok = await persistCharacterEditor(context, settings, activeAvatar, {
                    editor: sourceEditor,
                    forceEnabled: sourceScope === 'character' ? null : true,
                });
                if (!ok) {
                    notifyError('No character selected.');
                    return;
                }
                uiState.characterEditor = loadCharacterEditorState(context, activeAvatar);
                ensureEditorIntegrity(uiState.characterEditor);
                notifySuccess('Character orchestration override saved.');
                updateUiStatus(`Saved to character override: ${getCharacterDisplayNameByAvatar(context, activeAvatar)}.`);
            } else {
                persistGlobalEditorFrom(settings, sourceEditor);
                uiState.globalEditor = loadGlobalEditorState();
                ensureEditorIntegrity(uiState.globalEditor);
                notifySuccess('Global orchestration profile saved.');
                updateUiStatus('Saved to global profile.');
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'clear-character') {
            syncCharacterEditorWithActiveAvatar(context);
            const avatar = String(getCurrentAvatar(context) || '').trim();
            if (!avatar) {
                notifyError('No character selected.');
                return;
            }
            const characterIndex = getCharacterIndexByAvatar(context, avatar);
            if (characterIndex < 0) {
                notifyError('No character selected.');
                return;
            }
            const previous = getCharacterExtensionDataByAvatar(context, avatar);
            const nextPayload = { ...previous };
            delete nextPayload.override;
            await context.writeExtensionField(characterIndex, MODULE_NAME, nextPayload);
            uiState.characterEditor = loadCharacterEditorState(context, avatar);
            ensureEditorIntegrity(uiState.characterEditor);
            renderDynamicPanels(root, context);
            notifyInfo('Character orchestration override removed.');
            updateUiStatus(`Removed character override for ${getCharacterDisplayNameByAvatar(context, avatar)}.`);
            return;
        }

        if (action === 'ai-suggest-character') {
            try {
                await runAiCharacterProfileBuild(context, settings);
                renderDynamicPanels(root, context);
                notifySuccess('Character orchestration profile generated by AI.');
                updateUiStatus(`AI profile generated for ${getCharacterDisplayNameByAvatar(context, getCurrentAvatar(context))}.`);
            } catch (error) {
                notifyError(`AI profile generation failed: ${error?.message || error}`);
                updateUiStatus('AI profile generation failed.');
            }
        }
    });
}

function ensureUi() {
    const host = jQuery('#extensions_settings2');
    if (!host.length) {
        return;
    }

    if (!jQuery(`#${ORCH_STYLE_ID}`).length) {
        jQuery('head').append(`
<style id="${ORCH_STYLE_ID}">
#${UI_BLOCK_ID} .luker_orch_board {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.5));
    border-radius: 10px;
    padding: 10px;
    background: linear-gradient(160deg, rgba(29,46,39,0.28), rgba(21,31,43,0.2));
}
#${UI_BLOCK_ID} .luker_orch_workspace_grid {
    display: grid;
    grid-template-columns: 1.2fr 1fr;
    gap: 10px;
}
#${UI_BLOCK_ID} .luker_orch_workspace_col {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.4));
    border-radius: 8px;
    padding: 8px;
    background: rgba(0,0,0,0.12);
}
#${UI_BLOCK_ID} .luker_orch_col_title {
    font-weight: 600;
    margin-bottom: 6px;
}
#${UI_BLOCK_ID} .luker_orch_stage_card,
#${UI_BLOCK_ID} .luker_orch_preset_card,
#${UI_BLOCK_ID} .luker_orch_node_card {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.4));
    border-radius: 8px;
    padding: 8px;
    margin-bottom: 8px;
    background: rgba(255,255,255,0.02);
}
#${UI_BLOCK_ID} .luker_orch_stage_header,
#${UI_BLOCK_ID} .luker_orch_node_header,
#${UI_BLOCK_ID} .luker_orch_preset_header {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: flex-start;
    margin-bottom: 6px;
}
#${UI_BLOCK_ID} .luker_orch_btnrow {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
}
#${UI_BLOCK_ID} .luker_orch_stage_label {
    font-size: 0.9em;
    opacity: 0.85;
    margin-bottom: 2px;
}
#${UI_BLOCK_ID} .luker_orch_stage_meta,
#${UI_BLOCK_ID} .luker_orch_stage_connector {
    font-size: 0.85em;
    opacity: 0.8;
    margin: 4px 0 8px;
}
#${UI_BLOCK_ID} .luker_orch_nodes_grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 8px;
}
#${UI_BLOCK_ID} .luker_orch_preset_add_row {
    display: flex;
    gap: 6px;
    align-items: center;
}
#${UI_BLOCK_ID} .luker_orch_empty_hint {
    opacity: 0.8;
    font-size: 0.9em;
    padding: 6px;
    border: 1px dashed var(--SmartThemeBorderColor, rgba(130,130,130,0.4));
    border-radius: 8px;
}
#${UI_BLOCK_ID} .luker_orch_character_row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    align-items: end;
    margin-bottom: 8px;
}
@media (max-width: 980px) {
    #${UI_BLOCK_ID} .luker_orch_workspace_grid {
        grid-template-columns: 1fr;
    }
    #${UI_BLOCK_ID} .luker_orch_character_row {
        grid-template-columns: 1fr;
    }
}
</style>`);
    }

    if (jQuery(`#${UI_BLOCK_ID}`).length) {
        bindUi();
        return;
    }

    const html = `
<div id="${UI_BLOCK_ID}" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Orchestrator</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input id="luker_orch_enabled" type="checkbox" /> Enabled</label>
            <label for="luker_orch_llm_api_preset">LLM node API preset (Connection profile, empty = current)</label>
            <select id="luker_orch_llm_api_preset" class="text_pole"></select>
            <label for="luker_orch_llm_preset">LLM node preset (params + prompt, empty = current)</label>
            <select id="luker_orch_llm_preset" class="text_pole"></select>
            <label for="luker_orch_ai_suggest_api_preset">AI build API preset (Connection profile, empty = current)</label>
            <select id="luker_orch_ai_suggest_api_preset" class="text_pole"></select>
            <label for="luker_orch_ai_suggest_preset">AI build preset (params + prompt, empty = current)</label>
            <select id="luker_orch_ai_suggest_preset" class="text_pole"></select>
            <label for="luker_orch_preset_envelope_chars">Preset envelope max chars</label>
            <input id="luker_orch_preset_envelope_chars" class="text_pole" type="number" min="1000" step="100" />
            <label for="luker_orch_max_recent_messages">Recent messages (N)</label>
            <input id="luker_orch_max_recent_messages" class="text_pole" type="number" min="1" max="80" step="1" />
            <label for="luker_orch_tool_retries">Tool-call retries on invalid/missing tool call (N)</label>
            <input id="luker_orch_tool_retries" class="text_pole" type="number" min="0" max="10" step="1" />
            <label for="luker_orch_capsule_position">Capsule injection position</label>
            <select id="luker_orch_capsule_position" class="text_pole">
                <option value="${extension_prompt_types.IN_CHAT}">In-Chat</option>
                <option value="${extension_prompt_types.IN_PROMPT}">In-Prompt (system block)</option>
                <option value="${extension_prompt_types.BEFORE_PROMPT}">Before-Prompt</option>
            </select>
            <label for="luker_orch_capsule_depth">Capsule depth (IN_CHAT only, recommended 1 = before latest message)</label>
            <input id="luker_orch_capsule_depth" class="text_pole" type="number" min="0" max="10000" step="1" />
            <label for="luker_orch_capsule_role">Capsule role (IN_CHAT only)</label>
            <select id="luker_orch_capsule_role" class="text_pole">
                <option value="${extension_prompt_roles.SYSTEM}">System</option>
                <option value="${extension_prompt_roles.USER}">User</option>
                <option value="${extension_prompt_roles.ASSISTANT}">Assistant</option>
            </select>

            <hr>
            <div class="luker_orch_board">
                <div class="luker_orch_character_row">
                    <div>
                        <small>Current card: <span id="luker_orch_profile_target">(No character card)</span></small><br />
                        <small>Editing: <span id="luker_orch_profile_mode">Global profile</span></small>
                    </div>
                    <div>
                        <label for="luker_orch_ai_goal">AI build goal (optional)</label>
                        <textarea id="luker_orch_ai_goal" class="text_pole textarea_compact" rows="2" placeholder="e.g. mystery thriller pacing, strict in-character tone"></textarea>
                    </div>
                </div>
                <div id="luker_orch_effective_visual"></div>
                <div class="flex-container">
                    <div class="menu_button" data-luker-action="reload-current">Reload Current</div>
                    <div class="menu_button" data-luker-action="save-current">Save Current</div>
                    <label for="luker_orch_save_target" class="margin0">Save Target</label>
                    <select id="luker_orch_save_target" class="text_pole" style="max-width: 220px;">
                        <option value="global">Global profile</option>
                        <option value="character">Current character override</option>
                    </select>
                    <div id="luker_orch_clear_character_button" class="menu_button" data-luker-action="clear-character">Clear Character Override</div>
                    <div class="menu_button" data-luker-action="ai-suggest-character">AI Build Character Override</div>
                </div>
            </div>

            <small id="luker_orch_status" style="opacity:0.8"></small>
        </div>
    </div>
</div>`;

    host.append(html);
    bindUi();
}

jQuery(() => {
    const context = getContext();
    ensureSettings();
    saveSettingsDebounced();
    clearCapsulePrompt(context);
    ensureUi();

    if (context.eventTypes.GENERATION_WORLD_INFO_FINALIZED) {
        context.eventSource.on(context.eventTypes.GENERATION_WORLD_INFO_FINALIZED, onWorldInfoFinalized);
    }
    if (context.eventTypes.MESSAGE_DELETED) {
        context.eventSource.on(context.eventTypes.MESSAGE_DELETED, onMessageDeleted);
    }
    if (context.eventTypes.PRESET_CHANGED) {
        context.eventSource.on(context.eventTypes.PRESET_CHANGED, (event) => {
            if (String(event?.apiId || '') === 'openai') {
                ensureUi();
            }
        });
    }
    const connectionProfileEvents = [
        context.eventTypes.CONNECTION_PROFILE_LOADED,
        context.eventTypes.CONNECTION_PROFILE_CREATED,
        context.eventTypes.CONNECTION_PROFILE_DELETED,
        context.eventTypes.CONNECTION_PROFILE_UPDATED,
    ].filter(Boolean);
    for (const eventName of connectionProfileEvents) {
        context.eventSource.on(eventName, () => ensureUi());
    }
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        clearCapsulePrompt(context);
        ensureUi();
    });
});
