// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { extension_prompt_roles, getRequestHeaders, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { sendOpenAIRequest } from '../../openai.js';
import { escapeHtml, getStringHash } from '../../utils.js';
import { newWorldInfoEntryTemplate, world_info_position } from '../../world-info.js';
import { getChatCompletionConnectionProfiles, resolveChatCompletionRequestProfile } from '../connection-manager/profile-resolver.js';
import {
    TOOL_PROTOCOL_STYLE,
    extractAllFunctionCalls,
    getResponseMessageContent,
    validateParsedToolCalls,
} from '../function-call-runtime.js';

const MODULE_NAME = 'search_tools';
const UI_BLOCK_ID = 'search_tools_settings';
const STATUS_ID = 'search_tools_status';
const CHAT_LOREBOOK_METADATA_KEY = 'world_info';
const MANAGED_COMMENT_PREFIX = 'SEARCH_TOOLS';
const ALLOWED_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe', 'impersonate']);
const TOOL_NAMES = Object.freeze({
    SEARCH: 'luker_web_search',
    VISIT: 'luker_web_visit',
    AGENT_SEARCH: 'luker_search_agent_search',
    AGENT_VISIT: 'luker_search_agent_visit',
    AGENT_UPSERT: 'luker_search_agent_upsert_lorebook_entry',
    AGENT_DELETE: 'luker_search_agent_delete_lorebook_entry',
    AGENT_FINALIZE: 'luker_search_agent_finalize',
});

const DEFAULT_AGENT_SYSTEM_PROMPT = [
    'You are a pre-request web research agent for roleplay generation.',
    'Your job is to decide whether any search-backed lorebook update is necessary before the main generation request continues.',
    'You may finish immediately without searching if active world info, character information, and managed search entries already cover the need.',
    'Avoid duplicates. If information would repeat existing active world info, character card facts, or existing managed search entries, do not add it.',
    'Search and visit are optional. You may use existing managed search entries as your own database.',
    'If information is uncertain, highly time-sensitive, or search snippets are insufficient, prefer search plus visit before writing.',
    'Only delete entries that are explicitly listed as deletable.',
    'For lorebook writes, provide only the needed persistent content, activation keywords, and whether it should always inject.',
    'Do not move or redesign lorebook layout. Runtime preserves existing position/depth/order fields for updates.',
    'Use function calls only. Do not output plain prose outside tool calls.',
    `Always finish by calling ${TOOL_NAMES.AGENT_FINALIZE}.`,
].join('\n');

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    preRequestEnabled: false,
    provider: 'ddg',
    defaultMaxResults: 8,
    defaultVisitMaxChars: 4000,
    safeSearch: 'moderate',
    agentApiPresetName: '',
    agentPresetName: '',
    agentSystemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
    agentMaxRounds: 3,
    toolCallRetryMax: 1,
    lorebookDepth: 4,
    lorebookRole: extension_prompt_roles.SYSTEM,
    lorebookEntryOrder: 9800,
});

let activeAgentRunToken = 0;
let activeAgentRunInfoToast = null;
let activeAgentAbortController = null;

function i18n(text) {
    return translate(String(text || ''));
}

function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
}

function normalizeProvider(value) {
    const provider = String(value || '').trim().toLowerCase();
    return provider === 'ddg' ? 'ddg' : 'ddg';
}

function normalizeSafeSearch(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['off', 'moderate', 'strict'].includes(normalized) ? normalized : DEFAULT_SETTINGS.safeSearch;
}

function normalizeLorebookRole(value) {
    const numeric = Number(value);
    if ([extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT].includes(numeric)) {
        return numeric;
    }
    return DEFAULT_SETTINGS.lorebookRole;
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }
    const settings = extension_settings[MODULE_NAME];
    settings.enabled = Boolean(settings.enabled ?? DEFAULT_SETTINGS.enabled);
    settings.preRequestEnabled = Boolean(settings.preRequestEnabled ?? DEFAULT_SETTINGS.preRequestEnabled);
    settings.provider = normalizeProvider(settings.provider ?? DEFAULT_SETTINGS.provider);
    settings.defaultMaxResults = clampInteger(
        settings.defaultMaxResults ?? DEFAULT_SETTINGS.defaultMaxResults,
        1,
        20,
        DEFAULT_SETTINGS.defaultMaxResults,
    );
    settings.defaultVisitMaxChars = clampInteger(
        settings.defaultVisitMaxChars ?? DEFAULT_SETTINGS.defaultVisitMaxChars,
        0,
        50000,
        DEFAULT_SETTINGS.defaultVisitMaxChars,
    );
    settings.safeSearch = normalizeSafeSearch(settings.safeSearch ?? DEFAULT_SETTINGS.safeSearch);
    settings.agentApiPresetName = String(settings.agentApiPresetName ?? DEFAULT_SETTINGS.agentApiPresetName).trim();
    settings.agentPresetName = String(settings.agentPresetName ?? DEFAULT_SETTINGS.agentPresetName).trim();
    settings.agentSystemPrompt = String(settings.agentSystemPrompt ?? DEFAULT_SETTINGS.agentSystemPrompt).trim() || DEFAULT_SETTINGS.agentSystemPrompt;
    settings.agentMaxRounds = clampInteger(
        settings.agentMaxRounds ?? DEFAULT_SETTINGS.agentMaxRounds,
        1,
        8,
        DEFAULT_SETTINGS.agentMaxRounds,
    );
    settings.toolCallRetryMax = clampInteger(
        settings.toolCallRetryMax ?? DEFAULT_SETTINGS.toolCallRetryMax,
        0,
        5,
        DEFAULT_SETTINGS.toolCallRetryMax,
    );
    settings.lorebookDepth = clampInteger(
        settings.lorebookDepth ?? DEFAULT_SETTINGS.lorebookDepth,
        0,
        100,
        DEFAULT_SETTINGS.lorebookDepth,
    );
    settings.lorebookRole = normalizeLorebookRole(settings.lorebookRole ?? DEFAULT_SETTINGS.lorebookRole);
    settings.lorebookEntryOrder = clampInteger(
        settings.lorebookEntryOrder ?? DEFAULT_SETTINGS.lorebookEntryOrder,
        0,
        20000,
        DEFAULT_SETTINGS.lorebookEntryOrder,
    );
}

function getSettings() {
    ensureSettings();
    return extension_settings[MODULE_NAME];
}

function isToolEnabled() {
    return Boolean(getSettings().enabled);
}

function normalizeWhitespace(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeMultilineText(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizePreviewText(text, maxChars = 240) {
    const normalized = normalizeWhitespace(text);
    if (normalized.length <= maxChars) {
        return normalized;
    }
    return `${normalized.slice(0, maxChars - 1).trim()}...`;
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
    const options = [`<option value="">${escapeHtml(i18n('(Current preset)'))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function renderConnectionProfileOptions(selectedName = '') {
    const selected = String(selectedName || '').trim();
    const names = getChatCompletionConnectionProfiles()
        .map(profile => String(profile?.name || '').trim())
        .filter(Boolean);
    const options = [`<option value="">${escapeHtml(i18n('(Current API config)'))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function refreshAgentPresetSelectors(root, context, settings) {
    const selectorValues = [
        ['#search_tools_agent_api_preset_name', settings.agentApiPresetName],
        ['#search_tools_agent_preset_name', settings.agentPresetName],
    ];

    for (const [selector, value] of selectorValues) {
        const select = root.find(selector);
        if (!select.length) {
            continue;
        }
        const isConnectionSelector = selector.endsWith('_api_preset_name');
        select.html(isConnectionSelector ? renderConnectionProfileOptions(value) : renderOpenAIPresetOptions(context, value));
        select.val(String(value || '').trim());
    }
}

function fallbackStripHtml(html) {
    return normalizeWhitespace(String(html || '').replace(/<[^>]*>/g, ' '));
}

function htmlToReadableText(html) {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(String(html || ''), 'text/html');
        doc.querySelectorAll('script, style, noscript, svg, canvas, iframe').forEach(node => node.remove());
        const title = normalizeWhitespace(doc.querySelector('title')?.textContent || '');
        const text = normalizeMultilineText(doc.body?.innerText || '');
        return { title, text };
    } catch {
        return { title: '', text: fallbackStripHtml(html) };
    }
}

function normalizeSearchRows(rawRows = [], source = 'ddg') {
    if (!Array.isArray(rawRows)) {
        return [];
    }
    return rawRows
        .map(item => ({
            title: normalizeWhitespace(item?.title || ''),
            url: normalizeWhitespace(item?.url || ''),
            snippet: normalizeWhitespace(item?.snippet || item?.content || ''),
            text_excerpt: normalizeWhitespace(item?.text_excerpt || ''),
            source,
        }))
        .filter(item => item.title && item.url);
}

async function runDdgSearch({
    query,
    maxResults,
    safeSearch,
    timeRange,
    region,
    abortSignal = null,
}) {
    const response = await fetch('/api/search/ddg', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: isAbortSignalLike(abortSignal) ? abortSignal : null,
        body: JSON.stringify({
            query,
            max_results: maxResults,
            safe_search: safeSearch,
            time_range: timeRange || '',
            region: region || '',
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`DDG search request failed (${response.status}): ${text || response.statusText}`);
    }

    const payload = await response.json();
    const results = normalizeSearchRows(payload?.results || [], 'ddg');
    return {
        provider: 'ddg',
        query: String(payload?.query || query || ''),
        result_count: Number(payload?.result_count || results.length),
        results,
    };
}

async function runSearchProvider(provider, options) {
    const normalizedProvider = normalizeProvider(provider);
    if (normalizedProvider !== 'ddg') {
        console.warn(`[${MODULE_NAME}] Unsupported provider '${provider}'. Falling back to ddg.`);
    }
    return await runDdgSearch(options);
}

async function searchWeb(args = {}, { abortSignal = null } = {}) {
    const settings = getSettings();
    const query = normalizeWhitespace(args?.query || '');
    if (!query) {
        throw new Error('query is required.');
    }

    const maxResults = clampInteger(
        args?.max_results ?? settings.defaultMaxResults,
        1,
        20,
        settings.defaultMaxResults,
    );
    const safeSearch = normalizeSafeSearch(args?.safe_search || settings.safeSearch);
    const timeRange = String(args?.time_range || '').trim().toLowerCase();
    const region = normalizeWhitespace(args?.region || '');

    return await runSearchProvider(settings.provider, {
        query,
        maxResults,
        safeSearch,
        timeRange,
        region,
        abortSignal,
    });
}

async function visitWebPage(args = {}, { abortSignal = null } = {}) {
    const settings = getSettings();
    const url = normalizeWhitespace(args?.url || '');
    if (!url) {
        throw new Error('url is required.');
    }

    const rawMaxChars = args?.max_chars ?? settings.defaultVisitMaxChars;
    const normalizedMaxChars = Number.isFinite(Number(rawMaxChars))
        ? Math.floor(Number(rawMaxChars))
        : settings.defaultVisitMaxChars;
    const maxChars = normalizedMaxChars > 0
        ? clampInteger(normalizedMaxChars, 1, 50000, settings.defaultVisitMaxChars)
        : 0;

    const response = await fetch('/api/search/visit', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: isAbortSignalLike(abortSignal) ? abortSignal : null,
        body: JSON.stringify({ url, html: true }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Visit request failed (${response.status}): ${text || response.statusText}`);
    }

    const html = await response.text();
    const parsed = htmlToReadableText(html);
    const fullText = normalizeMultilineText(parsed.text || fallbackStripHtml(html));
    const excerpt = maxChars > 0 ? fullText.slice(0, maxChars) : fullText;

    return {
        url,
        title: parsed.title || '',
        text: excerpt,
        text_excerpt: excerpt,
        source: 'visit',
        total_chars: fullText.length,
        truncated: maxChars > 0 ? (fullText.length > excerpt.length) : false,
    };
}

function installGlobalApi() {
    const root = globalThis;
    if (!root.Luker || typeof root.Luker !== 'object') {
        root.Luker = {};
    }
    root.Luker.searchTools = {
        search: searchWeb,
        visit: visitWebPage,
        getSettings: () => {
            const settings = getSettings();
            return {
                enabled: Boolean(settings.enabled),
                preRequestEnabled: Boolean(settings.preRequestEnabled),
                provider: String(settings.provider || 'ddg'),
                defaultMaxResults: Number(settings.defaultMaxResults || DEFAULT_SETTINGS.defaultMaxResults),
                defaultVisitMaxChars: Number(settings.defaultVisitMaxChars || DEFAULT_SETTINGS.defaultVisitMaxChars),
                safeSearch: String(settings.safeSearch || DEFAULT_SETTINGS.safeSearch),
                agentApiPresetName: String(settings.agentApiPresetName || ''),
                agentPresetName: String(settings.agentPresetName || ''),
                agentMaxRounds: Number(settings.agentMaxRounds || DEFAULT_SETTINGS.agentMaxRounds),
                lorebookDepth: Number(settings.lorebookDepth || DEFAULT_SETTINGS.lorebookDepth),
                lorebookRole: Number(settings.lorebookRole || DEFAULT_SETTINGS.lorebookRole),
                lorebookEntryOrder: Number(settings.lorebookEntryOrder || DEFAULT_SETTINGS.lorebookEntryOrder),
            };
        },
    };
}

function registerTools(context) {
    Object.values(TOOL_NAMES).forEach(name => context.unregisterFunctionTool(name));

    context.registerFunctionTool({
        name: TOOL_NAMES.SEARCH,
        displayName: 'Web Search',
        description: 'Search the web for up-to-date information. Provider is configured by the plugin settings.',
        shouldRegister: async () => isToolEnabled(),
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query text.' },
                max_results: { type: 'integer', description: 'Maximum number of search results (1-20).' },
                safe_search: { type: 'string', enum: ['off', 'moderate', 'strict'] },
                time_range: { type: 'string', enum: ['', 'day', 'week', 'month', 'year'] },
                region: { type: 'string', description: 'Optional DuckDuckGo region code (kl), e.g. us-en.' },
            },
            required: ['query'],
            additionalProperties: false,
        },
        action: async (args) => await searchWeb(args),
        formatMessage: () => 'Searching web...',
    });

    context.registerFunctionTool({
        name: TOOL_NAMES.VISIT,
        displayName: 'Visit Web Page',
        description: 'Fetch one webpage and return readable text excerpt.',
        shouldRegister: async () => isToolEnabled(),
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'HTTP/HTTPS page URL.' },
                max_chars: { type: 'integer', description: 'Maximum output characters (0-50000). 0 means no truncation.' },
            },
            required: ['url'],
            additionalProperties: false,
        },
        action: async (args) => await visitWebPage(args),
        formatMessage: () => 'Fetching webpage...',
    });
}

function normalizeWorldInfoResolverMessages(messages = []) {
    if (!Array.isArray(messages)) {
        return [];
    }
    return messages.map((message) => {
        if (!message || typeof message !== 'object') {
            return message;
        }
        const next = { ...message };
        const rawRole = String(next.role || '').trim().toLowerCase();
        if (rawRole === 'system' || rawRole === 'user' || rawRole === 'assistant') {
            next.role = rawRole;
        } else if (next.is_system) {
            next.role = 'system';
        } else if (next.is_user) {
            next.role = 'user';
        } else {
            next.role = 'assistant';
        }
        if (next.content === undefined && Object.hasOwn(next, 'mes')) {
            next.content = String(next.mes ?? '');
        }
        return next;
    });
}

function rewriteDepthWorldInfoToAfter(payload = {}) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }
    const depthEntries = Array.isArray(payload.worldInfoDepth) ? payload.worldInfoDepth : [];
    if (depthEntries.length === 0) {
        return payload;
    }

    const blocks = [];
    for (const entry of depthEntries) {
        const lines = Array.isArray(entry?.entries) ? entry.entries : [];
        for (const line of lines) {
            const content = String(line ?? '').trim();
            if (content) {
                blocks.push(content);
            }
        }
    }

    payload.worldInfoDepth = [];
    if (blocks.length === 0) {
        return payload;
    }

    const mergedDepthText = blocks.join('\n\n').trim();
    payload.worldInfoAfter = [String(payload.worldInfoAfter || '').trim(), mergedDepthText]
        .filter(Boolean)
        .join('\n\n')
        .trim();
    return payload;
}

function normalizeRuntimeWorldInfo(runtimeWorldInfo = null) {
    const source = runtimeWorldInfo && typeof runtimeWorldInfo === 'object' ? runtimeWorldInfo : {};
    return {
        worldInfoBefore: String(source.worldInfoBefore || ''),
        worldInfoAfter: String(source.worldInfoAfter || ''),
        worldInfoDepth: Array.isArray(source.worldInfoDepth) ? source.worldInfoDepth : [],
        outletEntries: source.outletEntries && typeof source.outletEntries === 'object' ? source.outletEntries : {},
        worldInfoExamples: Array.isArray(source.worldInfoExamples) ? source.worldInfoExamples : [],
        anBefore: Array.isArray(source.anBefore) ? source.anBefore : [],
        anAfter: Array.isArray(source.anAfter) ? source.anAfter : [],
    };
}

function hasEffectiveRuntimeWorldInfo(runtimeWorldInfo = null) {
    const normalized = normalizeRuntimeWorldInfo(runtimeWorldInfo);
    if (normalized.worldInfoBefore || normalized.worldInfoAfter) {
        return true;
    }
    if (normalized.worldInfoDepth.length > 0 || normalized.worldInfoExamples.length > 0) {
        return true;
    }
    if (normalized.anBefore.length > 0 || normalized.anAfter.length > 0) {
        return true;
    }
    return Object.keys(normalized.outletEntries).length > 0;
}

function buildRuntimeWorldInfoFromPayload(payload = null) {
    const candidate = normalizeRuntimeWorldInfo({
        worldInfoBefore: String(payload?.worldInfoBefore || ''),
        worldInfoAfter: String(payload?.worldInfoAfter || ''),
        worldInfoDepth: Array.isArray(payload?.worldInfoDepth) ? payload.worldInfoDepth : [],
        outletEntries: payload?.outletEntries && typeof payload?.outletEntries === 'object' ? payload.outletEntries : {},
        worldInfoExamples: Array.isArray(payload?.worldInfoExamples) ? payload.worldInfoExamples : [],
        anBefore: Array.isArray(payload?.anBefore) ? payload.anBefore : [],
        anAfter: Array.isArray(payload?.anAfter) ? payload.anAfter : [],
    });
    return hasEffectiveRuntimeWorldInfo(candidate) ? candidate : null;
}

async function buildPresetAwareMessages(context, settings, systemPrompt, userPrompt, {
    api = '',
    promptPresetName = '',
    worldInfoMessages = null,
    runtimeWorldInfo = null,
    forceWorldInfoResimulate = false,
    worldInfoType = 'quiet',
} = {}) {
    const systemText = String(systemPrompt || '').trim() || 'Use tool calls only.';
    const userText = String(userPrompt || '').trim() || 'Use tool calls only.';
    const selectedPromptPresetName = String(promptPresetName || '').trim();
    const envelopeApi = selectedPromptPresetName ? 'openai' : (api || context.mainApi || 'openai');
    let resolvedRuntimeWorldInfo = (!forceWorldInfoResimulate && hasEffectiveRuntimeWorldInfo(runtimeWorldInfo))
        ? normalizeRuntimeWorldInfo(runtimeWorldInfo)
        : null;
    const resolverMessages = normalizeWorldInfoResolverMessages(worldInfoMessages);
    if (!resolvedRuntimeWorldInfo && typeof context?.resolveWorldInfoForMessages === 'function' && resolverMessages.length > 0) {
        resolvedRuntimeWorldInfo = await context.resolveWorldInfoForMessages(resolverMessages, {
            type: String(worldInfoType || 'quiet'),
            fallbackToCurrentChat: false,
            postActivationHook: rewriteDepthWorldInfoToAfter,
        });
    } else if (resolvedRuntimeWorldInfo) {
        resolvedRuntimeWorldInfo = normalizeRuntimeWorldInfo(rewriteDepthWorldInfoToAfter({
            ...resolvedRuntimeWorldInfo,
            worldInfoDepth: Array.isArray(resolvedRuntimeWorldInfo.worldInfoDepth)
                ? resolvedRuntimeWorldInfo.worldInfoDepth.map(entry => ({
                    ...entry,
                    entries: Array.isArray(entry?.entries) ? entry.entries.slice() : [],
                }))
                : [],
        }));
    }

    return context.buildPresetAwarePromptMessages({
        messages: [
            { role: 'system', content: systemText },
            { role: 'user', content: userText },
        ],
        envelopeOptions: {
            includeCharacterCard: true,
            api: envelopeApi,
            promptPresetName: selectedPromptPresetName,
        },
        promptPresetName: selectedPromptPresetName,
        runtimeWorldInfo: resolvedRuntimeWorldInfo,
    });
}

function isAbortSignalLike(signal) {
    return Boolean(signal && typeof signal === 'object' && typeof signal.aborted === 'boolean');
}

function isAbortError(error, signal = null) {
    if (error?.name === 'AbortError') {
        return true;
    }
    return Boolean(signal?.aborted);
}

function linkAbortSignals(...signals) {
    const validSignals = signals.filter(isAbortSignalLike);
    if (validSignals.length === 0) {
        return { signal: null, cleanup: () => {} };
    }
    if (validSignals.length === 1) {
        return { signal: validSignals[0], cleanup: () => {} };
    }

    const controller = new AbortController();
    const onAbort = () => {
        if (!controller.signal.aborted) {
            controller.abort();
        }
    };

    for (const signal of validSignals) {
        if (signal.aborted) {
            onAbort();
            break;
        }
        signal.addEventListener('abort', onAbort, { once: true });
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            for (const signal of validSignals) {
                signal.removeEventListener('abort', onAbort);
            }
        },
    };
}

async function requestToolCallsWithRetry(settings, promptMessages, {
    tools = [],
    allowedNames = null,
    llmPresetName = '',
    apiSettingsOverride = null,
    retriesOverride = null,
    abortSignal = null,
} = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error('Tools are required.');
    }

    const retriesSource = retriesOverride === null || retriesOverride === undefined
        ? Number(settings?.toolCallRetryMax)
        : Number(retriesOverride);
    const retries = Math.max(0, Math.min(10, Math.floor(retriesSource || 0)));
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const responseData = await sendOpenAIRequest('quiet', promptMessages, isAbortSignalLike(abortSignal) ? abortSignal : null, {
                tools,
                toolChoice: 'auto',
                replaceTools: true,
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
                requestScope: 'extension_internal',
                functionCallOptions: {
                    strictTwoPart: true,
                    protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
                },
            });
            const assistantText = getResponseMessageContent(responseData);
            const calls = extractAllFunctionCalls(responseData, allowedNames);
            const validationError = validateParsedToolCalls(calls, tools);
            if (validationError) {
                throw new Error(validationError);
            }
            return {
                toolCalls: calls,
                assistantText,
            };
        } catch (error) {
            if (isAbortError(error, abortSignal)) {
                throw error;
            }
            lastError = error;
            if (attempt >= retries) {
                throw error;
            }
            console.warn(`[${MODULE_NAME}] Multi tool call request failed. Retrying (${attempt + 1}/${retries})...`, error);
        }
    }

    throw lastError || new Error('Multi tool call request failed.');
}

function makeRuntimeToolCallId() {
    return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function serializeToolResultContent(result) {
    if (typeof result === 'string') {
        return result;
    }
    if (result === null || result === undefined) {
        return '';
    }
    try {
        return JSON.stringify(result, null, 2);
    } catch {
        return String(result);
    }
}

function appendStandardToolRoundMessages(targetMessages, executedCalls, assistantText = '') {
    if (!Array.isArray(targetMessages) || !Array.isArray(executedCalls) || executedCalls.length === 0) {
        return;
    }

    const toolCalls = executedCalls.map((call) => {
        const id = String(call?.id || '').trim() || makeRuntimeToolCallId();
        const name = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        return {
            id,
            type: 'function',
            function: {
                name,
                arguments: JSON.stringify(args),
            },
            _result: call?.result,
        };
    }).filter(call => call.function.name);

    if (toolCalls.length === 0) {
        return;
    }

    targetMessages.push({
        role: 'assistant',
        content: String(assistantText || ''),
        tool_calls: toolCalls.map(({ _result, ...toolCall }) => toolCall),
    });

    for (const toolCall of toolCalls) {
        targetMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: serializeToolResultContent(toolCall._result),
        });
    }
}

function sanitizeEntryId(value) {
    const normalized = String(value || '')
        .trim()
        .replace(/[^a-z0-9._-]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    return normalized;
}

function normalizeKeywordDisplayList(rawKeywords = []) {
    if (!Array.isArray(rawKeywords)) {
        return [];
    }
    const seen = new Set();
    const output = [];
    for (const item of rawKeywords) {
        const text = normalizeWhitespace(item);
        const signature = text.toLowerCase();
        if (!signature || seen.has(signature)) {
            continue;
        }
        seen.add(signature);
        output.push(text);
    }
    return output;
}

function getKeywordSignature(rawKeywords = []) {
    const normalized = normalizeKeywordDisplayList(rawKeywords)
        .map(item => item.toLowerCase())
        .sort((a, b) => a.localeCompare(b));
    return normalized.join(' || ');
}

function buildManagedComment(entryId, title = '') {
    const safeId = sanitizeEntryId(entryId) || 'entry';
    const safeTitle = normalizeWhitespace(title).replace(/::/g, ' - ').slice(0, 120);
    return `${MANAGED_COMMENT_PREFIX}::${safeId}::${safeTitle || safeId}`;
}

function parseManagedComment(comment = '') {
    const text = String(comment || '');
    const prefix = `${MANAGED_COMMENT_PREFIX}::`;
    if (!text.startsWith(prefix)) {
        return null;
    }
    const rest = text.slice(prefix.length);
    const splitIndex = rest.indexOf('::');
    if (splitIndex < 0) {
        const entryIdOnly = sanitizeEntryId(rest);
        return entryIdOnly ? { entryId: entryIdOnly, title: entryIdOnly } : null;
    }
    const entryId = sanitizeEntryId(rest.slice(0, splitIndex));
    const title = normalizeWhitespace(rest.slice(splitIndex + 2));
    if (!entryId) {
        return null;
    }
    return { entryId, title: title || entryId };
}

function deriveManagedEntryTitle(entryId, title, keywords, content) {
    const normalizedTitle = normalizeWhitespace(title);
    if (normalizedTitle) {
        return normalizedTitle;
    }
    if (Array.isArray(keywords) && keywords.length > 0) {
        return normalizeWhitespace(keywords[0]);
    }
    if (entryId) {
        return sanitizeEntryId(entryId);
    }
    const contentTitle = normalizePreviewText(content, 48);
    return contentTitle || 'Search Note';
}

function listManagedEntries(data) {
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
        return [];
    }
    return Object.entries(data.entries)
        .map(([uid, entry]) => {
            const parsed = parseManagedComment(entry?.comment || '');
            if (!parsed) {
                return null;
            }
            const keywords = normalizeKeywordDisplayList(Array.isArray(entry?.key) ? entry.key : []);
            const title = deriveManagedEntryTitle(parsed.entryId, parsed.title, keywords, entry?.content || '');
            return {
                uid: String(uid || ''),
                entryId: parsed.entryId,
                title,
                keywords,
                keywordSignature: getKeywordSignature(keywords),
                content: normalizeMultilineText(entry?.content || ''),
                alwaysInject: Boolean(entry?.constant),
                position: entry?.position,
                depth: entry?.depth,
                role: entry?.role,
                order: entry?.order,
                disable: Boolean(entry?.disable),
            };
        })
        .filter(Boolean)
        .sort((a, b) => String(a.entryId || '').localeCompare(String(b.entryId || '')));
}

function getNextLorebookUid(entries = {}) {
    return Object.keys(entries || {})
        .map(uid => Number(uid))
        .filter(Number.isFinite)
        .reduce((max, value) => Math.max(max, value), -1) + 1;
}

function buildChatLorebookName(context) {
    const chatId = String(context.chatId || context.getCurrentChatId?.() || '').trim();
    const suffix = chatId || `${context.groupId ? 'group' : 'chat'}_${Date.now()}`;
    return `Luker Search ${suffix}`.replace(/[^a-z0-9 _-]/gi, '_');
}

async function ensureChatLorebook(context, allowCreate = true) {
    const metadata = context.chatMetadata && typeof context.chatMetadata === 'object' ? context.chatMetadata : {};
    const existingName = String(metadata?.[CHAT_LOREBOOK_METADATA_KEY] || '').trim();
    if (existingName) {
        const loaded = await context.loadWorldInfo(existingName);
        if (loaded && typeof loaded === 'object') {
            return { bookName: existingName, data: loaded, created: false };
        }
    }

    if (!allowCreate) {
        return { bookName: existingName, data: null, created: false };
    }

    const newName = buildChatLorebookName(context);
    await context.saveWorldInfo(newName, { entries: {} }, true);
    if (typeof context.updateWorldInfoList === 'function') {
        await context.updateWorldInfoList();
    }
    context.updateChatMetadata({ [CHAT_LOREBOOK_METADATA_KEY]: newName });
    await context.saveMetadata();
    const loaded = await context.loadWorldInfo(newName);
    return {
        bookName: newName,
        data: loaded && typeof loaded === 'object' ? loaded : { entries: {} },
        created: true,
    };
}

function createManagedLorebookEntry(uid, spec, settings, existingEntry = null) {
    const entry = existingEntry && typeof existingEntry === 'object'
        ? structuredClone(existingEntry)
        : { uid, ...structuredClone(newWorldInfoEntryTemplate) };

    entry.uid = uid;
    entry.comment = buildManagedComment(spec.entryId, spec.title);
    entry.key = Array.isArray(spec.keywords) ? spec.keywords.slice() : [];
    entry.content = normalizeMultilineText(spec.content);
    entry.constant = Boolean(spec.alwaysInject);
    entry.selective = false;

    if (!existingEntry) {
        entry.disable = false;
        entry.position = world_info_position.atDepth;
        entry.depth = Number(settings.lorebookDepth);
        entry.role = Number(settings.lorebookRole);
        entry.order = Number(settings.lorebookEntryOrder);
        entry.useProbability = false;
        entry.probability = 100;
        entry.preventRecursion = true;
        entry.excludeRecursion = true;
    } else {
        if (!Array.isArray(entry.key)) {
            entry.key = Array.isArray(spec.keywords) ? spec.keywords.slice() : [];
        }
    }

    return entry;
}

function findManagedEntryById(data, entryId) {
    const targetId = sanitizeEntryId(entryId);
    if (!targetId) {
        return null;
    }
    return listManagedEntries(data).find(entry => entry.entryId === targetId) || null;
}

function findManagedEntryByKeywordSignature(data, keywordSignature) {
    const signature = String(keywordSignature || '').trim();
    if (!signature) {
        return null;
    }
    return listManagedEntries(data).find(entry => entry.keywordSignature === signature) || null;
}

function buildGeneratedEntryId(title, keywords, content) {
    const base = sanitizeEntryId(title || keywords?.[0] || '') || 'search_entry';
    const hashSource = `${base}\n${getKeywordSignature(keywords)}\n${normalizeMultilineText(content)}`;
    const hash = Math.abs(getStringHash(hashSource)).toString(36);
    return sanitizeEntryId(`${base}_${hash.slice(0, 8)}`) || `search_entry_${hash.slice(0, 8)}`;
}

function collectUpsertSpec(args = {}, existingEntry = null) {
    const hasKeywords = Object.hasOwn(args, 'keywords');
    const inputKeywords = hasKeywords ? normalizeKeywordDisplayList(args?.keywords || []) : null;
    const alwaysInject = Object.hasOwn(args, 'always_inject')
        ? Boolean(args?.always_inject)
        : Boolean(existingEntry?.alwaysInject);
    const keywords = inputKeywords ?? (Array.isArray(existingEntry?.keywords) ? existingEntry.keywords.slice() : []);
    const content = normalizeMultilineText(args?.content || '');
    const explicitEntryId = sanitizeEntryId(args?.entry_id || '');
    const title = deriveManagedEntryTitle(
        explicitEntryId || existingEntry?.entryId || '',
        args?.title || existingEntry?.title || '',
        keywords,
        content,
    );

    return {
        entryId: explicitEntryId,
        title,
        keywords,
        keywordSignature: getKeywordSignature(keywords),
        content,
        alwaysInject,
    };
}

function upsertManagedEntry(data, settings, args = {}) {
    if (!data || typeof data !== 'object') {
        throw new Error('Lorebook data is required.');
    }
    if (!data.entries || typeof data.entries !== 'object') {
        data.entries = {};
    }

    const requestedEntryId = sanitizeEntryId(args?.entry_id || '');
    const hasExplicitEntryId = Boolean(requestedEntryId);
    const explicitEntry = hasExplicitEntryId ? findManagedEntryById(data, requestedEntryId) : null;
    const normalized = collectUpsertSpec(args, explicitEntry);
    if (!normalized.content) {
        throw new Error('content is required.');
    }
    if (!normalized.alwaysInject && normalized.keywords.length === 0) {
        throw new Error('keywords are required when always_inject is false.');
    }

    let target = explicitEntry;
    let matchedBy = explicitEntry ? 'entry_id' : '';
    if (!target && !hasExplicitEntryId && normalized.keywordSignature) {
        target = findManagedEntryByKeywordSignature(data, normalized.keywordSignature);
        if (target) {
            matchedBy = 'keywords';
        }
    }

    const finalEntryId = target?.entryId
        || requestedEntryId
        || buildGeneratedEntryId(normalized.title, normalized.keywords, normalized.content);
    const finalTitle = deriveManagedEntryTitle(finalEntryId, normalized.title, normalized.keywords, normalized.content);
    const existingRaw = target ? data.entries[target.uid] : null;
    const uid = target ? Number(target.uid) : getNextLorebookUid(data.entries);
    const nextEntry = createManagedLorebookEntry(uid, {
        entryId: finalEntryId,
        title: finalTitle,
        keywords: normalized.keywords,
        content: normalized.content,
        alwaysInject: normalized.alwaysInject,
    }, settings, existingRaw);

    const previousSerialized = existingRaw ? JSON.stringify(existingRaw) : '';
    const nextSerialized = JSON.stringify(nextEntry);
    const changed = previousSerialized !== nextSerialized;
    data.entries[uid] = nextEntry;

    return {
        changed,
        action: target ? 'updated' : 'created',
        matchedBy: matchedBy || (target ? 'unknown' : 'new'),
        uid: String(uid),
        entryId: finalEntryId,
        title: finalTitle,
        keywords: normalized.keywords,
        alwaysInject: normalized.alwaysInject,
    };
}

function deleteManagedEntries(data, entryIds = []) {
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
        return { changed: false, deleted: [], skipped: [] };
    }
    const deleted = [];
    const skipped = [];
    for (const rawId of Array.isArray(entryIds) ? entryIds : []) {
        const entryId = sanitizeEntryId(rawId);
        if (!entryId) {
            continue;
        }
        const target = findManagedEntryById(data, entryId);
        if (!target) {
            skipped.push(entryId);
            continue;
        }
        delete data.entries[target.uid];
        deleted.push(entryId);
    }
    return {
        changed: deleted.length > 0,
        deleted,
        skipped,
    };
}

function buildRecentChatText(messages = [], limit = 12) {
    const normalized = Array.isArray(messages) ? messages : [];
    const sliced = normalized.slice(Math.max(0, normalized.length - limit));
    const lines = sliced.map((message) => {
        const role = message?.is_user ? 'User' : (message?.is_system ? 'System' : (message?.name || 'Assistant'));
        const content = normalizeMultilineText(message?.mes || message?.content || '');
        return content ? `${role}: ${content}` : '';
    }).filter(Boolean);
    return lines.length > 0 ? lines.join('\n\n') : '(No recent chat messages available)';
}

function buildManagedEntryCatalog(entries = []) {
    const normalized = Array.isArray(entries) ? entries : [];
    if (normalized.length === 0) {
        return '[]';
    }
    return JSON.stringify(normalized.map(entry => ({
        entry_id: entry.entryId,
        title: entry.title,
        keywords: entry.keywords,
        always_inject: entry.alwaysInject,
        disabled: entry.disable,
        preview: normalizePreviewText(entry.content, 800),
    })), null, 2);
}

function buildSearchAgentUserPrompt(payload, {
    roundIndex,
    maxRounds,
    bookName,
    managedEntries,
} = {}) {
    const recentChat = buildRecentChatText(payload?.coreChat || []);
    const lastUserMessage = Array.isArray(payload?.coreChat)
        ? [...payload.coreChat].reverse().find(message => message?.is_user)
        : null;
    const userText = normalizeMultilineText(lastUserMessage?.mes || '');

    return [
        '# Search Agent Task',
        `Round ${roundIndex} of ${maxRounds}.`,
        `Generation type: ${String(payload?.type || 'unknown')}.`,
        `Chat lorebook: ${bookName || '(not bound yet)'}.`,
        '',
        'Decide whether persistent search-backed lorebook updates are needed before the main generation continues.',
        'If there is no meaningful gap, or the information would repeat active world info / character info / existing managed search entries, call finalize immediately.',
        'You may use existing managed search entries as your own database without searching or visiting.',
        'Search and visit are optional. Visit is recommended when snippets are weak or the topic is time-sensitive.',
        'Only delete entry_ids from the managed entry list below.',
        'For non-always_inject entries, provide activation keywords.',
        '',
        '## Latest user message',
        userText || '(No user message found)',
        '',
        '## Recent chat',
        recentChat,
        '',
        '## Managed search entries (deletable / updatable)',
        buildManagedEntryCatalog(managedEntries),
        '',
        '## Output contract',
        `- Use only these function tools: ${Object.values(TOOL_NAMES).filter(name => name.startsWith('luker_search_agent_')).join(', ')}`,
        `- End with ${TOOL_NAMES.AGENT_FINALIZE}.`,
        '- Do not output plain prose.',
    ].join('\n');
}

function buildAgentTools() {
    return [
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.AGENT_SEARCH,
                description: 'Search the web for current information. Provider is fixed by plugin settings.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                        max_results: { type: 'integer' },
                        safe_search: { type: 'string', enum: ['off', 'moderate', 'strict'] },
                        time_range: { type: 'string', enum: ['', 'day', 'week', 'month', 'year'] },
                        region: { type: 'string' },
                    },
                    required: ['query'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.AGENT_VISIT,
                description: 'Visit one web page and read its text.',
                parameters: {
                    type: 'object',
                    properties: {
                        url: { type: 'string' },
                        max_chars: { type: 'integer' },
                    },
                    required: ['url'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.AGENT_UPSERT,
                description: 'Create or update one managed search lorebook entry. Explicit entry_id matches first; otherwise exact normalized keyword match updates an existing managed entry.',
                parameters: {
                    type: 'object',
                    properties: {
                        entry_id: { type: 'string' },
                        title: { type: 'string' },
                        keywords: {
                            type: 'array',
                            items: { type: 'string' },
                        },
                        content: { type: 'string' },
                        always_inject: { type: 'boolean' },
                    },
                    required: ['content'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.AGENT_DELETE,
                description: 'Delete one or more managed search lorebook entries by entry_id.',
                parameters: {
                    type: 'object',
                    properties: {
                        entry_ids: {
                            type: 'array',
                            items: { type: 'string' },
                        },
                    },
                    required: ['entry_ids'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.AGENT_FINALIZE,
                description: 'Finish the current search-agent run.',
                parameters: {
                    type: 'object',
                    properties: {
                        summary: { type: 'string' },
                    },
                    additionalProperties: false,
                },
            },
        },
    ];
}

function updatePayloadWorldInfoFromResolution(payload, resolution) {
    if (!payload || typeof payload !== 'object' || !resolution || typeof resolution !== 'object') {
        return;
    }
    payload.worldInfoBefore = String(resolution.worldInfoBefore || '');
    payload.worldInfoAfter = String(resolution.worldInfoAfter || '');
    payload.worldInfoDepth = Array.isArray(resolution.worldInfoDepth) ? resolution.worldInfoDepth : [];
    payload.outletEntries = resolution.outletEntries && typeof resolution.outletEntries === 'object' ? resolution.outletEntries : {};
    payload.worldInfoExamples = Array.isArray(resolution.worldInfoExamples) ? resolution.worldInfoExamples : [];
    payload.anBefore = Array.isArray(resolution.anBefore) ? resolution.anBefore : [];
    payload.anAfter = Array.isArray(resolution.anAfter) ? resolution.anAfter : [];
    if (Array.isArray(resolution.chatForWI)) {
        payload.chatForWI = resolution.chatForWI;
    }
    if (Number.isFinite(Number(resolution.maxContext)) && Number(resolution.maxContext) > 0) {
        payload.maxContext = Number(resolution.maxContext);
    }
    if (resolution.globalScanData && typeof resolution.globalScanData === 'object') {
        payload.globalScanData = resolution.globalScanData;
    }
    payload.worldInfoResolution = resolution;
}

async function flushLorebookChanges(context, payload, bookName, data) {
    await context.saveWorldInfo(bookName, data, true);
    payload.requestRescan = true;
    if (typeof payload?.simulateWorldInfo === 'function') {
        const resolution = await payload.simulateWorldInfo();
        updatePayloadWorldInfoFromResolution(payload, resolution);
        return buildRuntimeWorldInfoFromPayload(resolution);
    }
    return buildRuntimeWorldInfoFromPayload(payload);
}

async function runPreRequestSearchAgent(context, settings, payload) {
    const resolvedApiPresetName = String(settings.agentApiPresetName || '').trim();
    const profileResolution = resolveChatCompletionRequestProfile({
        profileName: resolvedApiPresetName,
        defaultApi: String(context?.mainApi || 'openai').trim() || 'openai',
        defaultSource: String(context?.chatCompletionSettings?.chat_completion_source || ''),
    });
    const requestApi = profileResolution.requestApi;
    const apiSettingsOverride = profileResolution.apiSettingsOverride;
    const tools = buildAgentTools();
    const allowedNames = tools.map(tool => tool?.function?.name).filter(Boolean);
    const toolHistoryMessages = [];
    let internalRuntimeWorldInfo = buildRuntimeWorldInfoFromPayload(payload);
    let mutationCount = 0;
    let roundStoppedByFinalize = false;
    let lastSummary = '';
    let lorebookBookName = '';
    let lorebookData = null;

    for (let roundIndex = 1; roundIndex <= Number(settings.agentMaxRounds); roundIndex += 1) {
        if (payload?.signal?.aborted) {
            throw Object.assign(new Error('Search agent aborted.'), { name: 'AbortError' });
        }

        if (!lorebookData && !lorebookBookName) {
            const lorebook = await ensureChatLorebook(context, false);
            lorebookBookName = lorebook.bookName;
            lorebookData = lorebook.data && typeof lorebook.data === 'object' ? lorebook.data : null;
        }
        const managedEntries = listManagedEntries(lorebookData);
        const promptMessages = await buildPresetAwareMessages(
            context,
            settings,
            settings.agentSystemPrompt,
            buildSearchAgentUserPrompt(payload, {
                roundIndex,
                maxRounds: settings.agentMaxRounds,
                bookName: lorebookBookName,
                managedEntries,
            }),
            {
                api: requestApi,
                promptPresetName: String(settings.agentPresetName || '').trim(),
                worldInfoMessages: Array.isArray(payload?.coreChat) ? payload.coreChat : [],
                runtimeWorldInfo: internalRuntimeWorldInfo,
                forceWorldInfoResimulate: false,
                worldInfoType: 'quiet',
            },
        );
        const requestMessages = [...promptMessages, ...toolHistoryMessages];
        const response = await requestToolCallsWithRetry(settings, requestMessages, {
            tools,
            allowedNames,
            llmPresetName: String(settings.agentPresetName || '').trim(),
            apiSettingsOverride,
            abortSignal: payload?.signal || null,
        });

        const executedCalls = [];
        let lorebookDirty = false;
        let shouldFinalize = false;

        for (const call of Array.isArray(response.toolCalls) ? response.toolCalls : []) {
            const callName = String(call?.name || '').trim();
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            let result = null;

            if (callName === TOOL_NAMES.AGENT_SEARCH) {
                result = await searchWeb(args, { abortSignal: payload?.signal || null });
            } else if (callName === TOOL_NAMES.AGENT_VISIT) {
                result = await visitWebPage(args, { abortSignal: payload?.signal || null });
            } else if (callName === TOOL_NAMES.AGENT_UPSERT) {
                if (!lorebookData) {
                    const createdLorebook = await ensureChatLorebook(context, true);
                    lorebookBookName = createdLorebook.bookName;
                    lorebookData = createdLorebook.data && typeof createdLorebook.data === 'object'
                        ? createdLorebook.data
                        : { entries: {} };
                }
                result = upsertManagedEntry(lorebookData, settings, args);
                lorebookDirty = lorebookDirty || Boolean(result?.changed);
                if (result?.changed) {
                    mutationCount += 1;
                }
            } else if (callName === TOOL_NAMES.AGENT_DELETE) {
                result = deleteManagedEntries(lorebookData, args?.entry_ids || []);
                lorebookDirty = lorebookDirty || Boolean(result?.changed);
                if (result?.changed) {
                    mutationCount += Number(result.deleted?.length || 0);
                }
            } else if (callName === TOOL_NAMES.AGENT_FINALIZE) {
                lastSummary = normalizeWhitespace(args?.summary || '');
                result = {
                    done: true,
                    summary: lastSummary,
                };
                shouldFinalize = true;
            }

            executedCalls.push({
                ...call,
                result,
            });
        }

        if (lorebookDirty && lorebookBookName && lorebookData) {
            internalRuntimeWorldInfo = await flushLorebookChanges(context, payload, lorebookBookName, lorebookData);
        }

        appendStandardToolRoundMessages(toolHistoryMessages, executedCalls, response.assistantText || '');

        if (shouldFinalize) {
            roundStoppedByFinalize = true;
            break;
        }
    }

    const finalLorebook = lorebookData
        ? { bookName: lorebookBookName, data: lorebookData }
        : await ensureChatLorebook(context, false);
    const finalManagedEntries = finalLorebook?.data ? listManagedEntries(finalLorebook.data) : [];
    return {
        mutationCount,
        finalized: roundStoppedByFinalize,
        summary: lastSummary,
        bookName: finalLorebook?.bookName || '',
        managedEntryCount: finalManagedEntries.length,
    };
}

async function maybeRunPreRequestSearchAgent(payload) {
    const context = getContext();
    const settings = getSettings();
    if (!settings.preRequestEnabled) {
        return;
    }
    if (!payload || typeof payload !== 'object' || payload.dryRun) {
        return;
    }
    if (!ALLOWED_GENERATION_TYPES.has(String(payload.type || '').trim())) {
        return;
    }
    if (!Array.isArray(payload.coreChat) || payload.coreChat.length === 0) {
        return;
    }
    if (payload?.signal?.aborted) {
        return;
    }

    if (activeAgentAbortController && !activeAgentAbortController.signal.aborted) {
        activeAgentAbortController.abort();
    }

    const runToken = ++activeAgentRunToken;
    const pluginAbortController = new AbortController();
    activeAgentAbortController = pluginAbortController;
    const linkedAbort = linkAbortSignals(payload?.signal, pluginAbortController.signal);
    const effectivePayload = linkedAbort.signal && linkedAbort.signal !== payload?.signal
        ? { ...payload, signal: linkedAbort.signal }
        : payload;

    updateUiStatus(i18n('Search agent running...'));
    showAgentRunInfoToast(i18n('Search agent running...'), {
        stopLabel: i18n('Stop'),
        onStop: () => {
            if (!pluginAbortController.signal.aborted) {
                pluginAbortController.abort();
            }
        },
    });

    try {
        const result = await runPreRequestSearchAgent(context, settings, effectivePayload);
        if (runToken !== activeAgentRunToken) {
            return;
        }
        const summary = result?.summary ? ` ${result.summary}` : '';
        updateUiStatus(
            result?.mutationCount
                ? i18n(`Search agent updated lorebook (${result.mutationCount} changes, ${result.managedEntryCount} managed entries).${summary}`)
                : i18n(`Search agent finished with no lorebook changes (${result.managedEntryCount} managed entries).${summary}`),
        );
    } catch (error) {
        if (runToken !== activeAgentRunToken) {
            return;
        }
        if (isAbortError(error, effectivePayload?.signal || null)) {
            updateUiStatus(i18n('Search agent aborted.'));
            return;
        }
        console.warn(`[${MODULE_NAME}] Pre-request search agent failed`, error);
        updateUiStatus(i18n('Search agent failed. Check console for details.'));
    } finally {
        linkedAbort.cleanup();
        if (activeAgentAbortController === pluginAbortController) {
            activeAgentAbortController = null;
        }
        if (runToken === activeAgentRunToken) {
            clearAgentRunInfoToast();
        }
    }
}

function renderSettingsBlock() {
    return `
<div id="${UI_BLOCK_ID}" class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>${escapeHtml(i18n('Search Tools'))}</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
        <label class="checkbox_label">
            <input id="search_tools_enabled" type="checkbox" />
            ${escapeHtml(i18n('Expose tools to main model'))}
        </label>
        <label class="checkbox_label">
            <input id="search_tools_pre_request_enabled" type="checkbox" />
            ${escapeHtml(i18n('Run pre-request search agent'))}
        </label>
        <label for="search_tools_provider">${escapeHtml(i18n('Search provider'))}</label>
        <select id="search_tools_provider" class="text_pole">
            <option value="ddg">${escapeHtml(i18n('DuckDuckGo (no login)'))}</option>
        </select>
        <label for="search_tools_default_max_results">${escapeHtml(i18n('Default max search results'))}</label>
        <input id="search_tools_default_max_results" class="text_pole" type="number" min="1" max="20" step="1" />
        <label for="search_tools_safe_search">${escapeHtml(i18n('Default safe search'))}</label>
        <select id="search_tools_safe_search" class="text_pole">
            <option value="off">${escapeHtml(i18n('Off'))}</option>
            <option value="moderate">${escapeHtml(i18n('Moderate'))}</option>
            <option value="strict">${escapeHtml(i18n('Strict'))}</option>
        </select>
        <label for="search_tools_default_visit_max_chars">${escapeHtml(i18n('Default page excerpt max chars (0 = no truncation)'))}</label>
        <input id="search_tools_default_visit_max_chars" class="text_pole" type="number" min="0" max="50000" step="100" />
        <label for="search_tools_agent_api_preset_name">${escapeHtml(i18n('Agent API preset (Connection profile, empty = current)'))}</label>
        <select id="search_tools_agent_api_preset_name" class="text_pole"></select>
        <label for="search_tools_agent_preset_name">${escapeHtml(i18n('Agent preset (params + prompt, empty = current)'))}</label>
        <select id="search_tools_agent_preset_name" class="text_pole"></select>
        <label for="search_tools_agent_max_rounds">${escapeHtml(i18n('Agent max rounds'))}</label>
        <input id="search_tools_agent_max_rounds" class="text_pole" type="number" min="1" max="8" step="1" />
        <label for="search_tools_tool_call_retry_max">${escapeHtml(i18n('Tool call retry count'))}</label>
        <input id="search_tools_tool_call_retry_max" class="text_pole" type="number" min="0" max="5" step="1" />
        <label for="search_tools_lorebook_depth">${escapeHtml(i18n('New entry default depth'))}</label>
        <input id="search_tools_lorebook_depth" class="text_pole" type="number" min="0" max="100" step="1" />
        <label for="search_tools_lorebook_role">${escapeHtml(i18n('New entry default role'))}</label>
        <select id="search_tools_lorebook_role" class="text_pole">
            <option value="${extension_prompt_roles.SYSTEM}">${escapeHtml(i18n('System'))}</option>
            <option value="${extension_prompt_roles.USER}">${escapeHtml(i18n('User'))}</option>
            <option value="${extension_prompt_roles.ASSISTANT}">${escapeHtml(i18n('Assistant'))}</option>
        </select>
        <label for="search_tools_lorebook_entry_order">${escapeHtml(i18n('New entry default order'))}</label>
        <input id="search_tools_lorebook_entry_order" class="text_pole" type="number" min="0" max="20000" step="1" />
        <label for="search_tools_agent_system_prompt">${escapeHtml(i18n('Search agent system prompt'))}</label>
        <textarea id="search_tools_agent_system_prompt" class="text_pole" rows="12"></textarea>
        <div id="${STATUS_ID}" class="wide100p text_muted" style="margin-top: 8px;"></div>
    </div>
</div>`;
}

function updateUiStatus(text) {
    const element = jQuery(`#${STATUS_ID}`);
    if (!element.length) {
        return;
    }
    element.text(String(text || ''));
}

function showAgentRunInfoToast(message, { stopLabel = '', onStop = null } = {}) {
    if (typeof toastr === 'undefined') {
        return;
    }
    if (activeAgentRunInfoToast) {
        toastr.clear(activeAgentRunInfoToast);
        activeAgentRunInfoToast = null;
    }
    activeAgentRunInfoToast = toastr.info(String(message || ''), '', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        progressBar: false,
    });
    if (activeAgentRunInfoToast && typeof onStop === 'function') {
        const toastBody = activeAgentRunInfoToast.find('.toast-message');
        if (toastBody.length > 0) {
            const button = jQuery('<button type="button" class="menu_button menu_button_small luker-toast-stop-button"></button>');
            button.text(String(stopLabel || i18n('Stop')));
            button.on('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                button.prop('disabled', true);
                const toastElement = button.closest('.toast');
                clearAgentRunInfoToast();
                if (toastElement && toastElement.length > 0) {
                    toastElement.remove();
                }
                onStop();
            });
            toastBody.append(button);
        }
    }
}

function clearAgentRunInfoToast() {
    if (typeof toastr === 'undefined' || !activeAgentRunInfoToast) {
        return;
    }
    toastr.clear(activeAgentRunInfoToast);
    activeAgentRunInfoToast = null;
}

async function refreshUiStatusForCurrentChat() {
    const context = getContext();
    if (!context?.chatId && !context?.getCurrentChatId?.()) {
        updateUiStatus(i18n('No active chat.'));
        return;
    }
    try {
        const lorebook = await ensureChatLorebook(context, false);
        const entryCount = lorebook?.data ? listManagedEntries(lorebook.data).length : 0;
        if (!lorebook?.bookName) {
            updateUiStatus(i18n('No chat-bound lorebook yet.'));
            return;
        }
        updateUiStatus(i18n(`Chat lorebook: ${lorebook.bookName} | Managed search entries: ${entryCount}`));
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to refresh UI status`, error);
        updateUiStatus(i18n('Failed to inspect chat lorebook.'));
    }
}

function bindSettingsUi() {
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    const context = getContext();
    const settings = getSettings();
    refreshAgentPresetSelectors(root, context, settings);
    root.find('#search_tools_enabled').prop('checked', Boolean(settings.enabled));
    root.find('#search_tools_pre_request_enabled').prop('checked', Boolean(settings.preRequestEnabled));
    root.find('#search_tools_provider').val(String(settings.provider || 'ddg'));
    root.find('#search_tools_default_max_results').val(String(settings.defaultMaxResults));
    root.find('#search_tools_default_visit_max_chars').val(String(settings.defaultVisitMaxChars));
    root.find('#search_tools_safe_search').val(String(settings.safeSearch || DEFAULT_SETTINGS.safeSearch));
    root.find('#search_tools_agent_api_preset_name').val(String(settings.agentApiPresetName || ''));
    root.find('#search_tools_agent_preset_name').val(String(settings.agentPresetName || ''));
    root.find('#search_tools_agent_max_rounds').val(String(settings.agentMaxRounds));
    root.find('#search_tools_tool_call_retry_max').val(String(settings.toolCallRetryMax));
    root.find('#search_tools_lorebook_depth').val(String(settings.lorebookDepth));
    root.find('#search_tools_lorebook_role').val(String(settings.lorebookRole));
    root.find('#search_tools_lorebook_entry_order').val(String(settings.lorebookEntryOrder));
    root.find('#search_tools_agent_system_prompt').val(String(settings.agentSystemPrompt || DEFAULT_SETTINGS.agentSystemPrompt));

    root.off('.searchTools');
    root.on('input.searchTools', '#search_tools_enabled', function () {
        settings.enabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });
    root.on('input.searchTools', '#search_tools_pre_request_enabled', function () {
        settings.preRequestEnabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_provider', function () {
        settings.provider = normalizeProvider(jQuery(this).val());
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_default_max_results', function () {
        settings.defaultMaxResults = clampInteger(jQuery(this).val(), 1, 20, DEFAULT_SETTINGS.defaultMaxResults);
        jQuery(this).val(String(settings.defaultMaxResults));
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_default_visit_max_chars', function () {
        settings.defaultVisitMaxChars = clampInteger(jQuery(this).val(), 0, 50000, DEFAULT_SETTINGS.defaultVisitMaxChars);
        jQuery(this).val(String(settings.defaultVisitMaxChars));
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_safe_search', function () {
        settings.safeSearch = normalizeSafeSearch(jQuery(this).val());
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_agent_api_preset_name', function () {
        settings.agentApiPresetName = normalizeWhitespace(jQuery(this).val());
        jQuery(this).val(settings.agentApiPresetName);
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_agent_preset_name', function () {
        settings.agentPresetName = normalizeWhitespace(jQuery(this).val());
        jQuery(this).val(settings.agentPresetName);
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_agent_max_rounds', function () {
        settings.agentMaxRounds = clampInteger(jQuery(this).val(), 1, 8, DEFAULT_SETTINGS.agentMaxRounds);
        jQuery(this).val(String(settings.agentMaxRounds));
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_tool_call_retry_max', function () {
        settings.toolCallRetryMax = clampInteger(jQuery(this).val(), 0, 5, DEFAULT_SETTINGS.toolCallRetryMax);
        jQuery(this).val(String(settings.toolCallRetryMax));
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_lorebook_depth', function () {
        settings.lorebookDepth = clampInteger(jQuery(this).val(), 0, 100, DEFAULT_SETTINGS.lorebookDepth);
        jQuery(this).val(String(settings.lorebookDepth));
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_lorebook_role', function () {
        settings.lorebookRole = normalizeLorebookRole(jQuery(this).val());
        jQuery(this).val(String(settings.lorebookRole));
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_lorebook_entry_order', function () {
        settings.lorebookEntryOrder = clampInteger(jQuery(this).val(), 0, 20000, DEFAULT_SETTINGS.lorebookEntryOrder);
        jQuery(this).val(String(settings.lorebookEntryOrder));
        saveSettingsDebounced();
    });
    root.on('change.searchTools input.searchTools', '#search_tools_agent_system_prompt', function () {
        settings.agentSystemPrompt = String(jQuery(this).val() || '').trim() || DEFAULT_SETTINGS.agentSystemPrompt;
        saveSettingsDebounced();
    });
}

function ensureUi() {
    const host = jQuery('#extensions_settings2');
    if (!host.length) {
        return;
    }

    if (!jQuery(`#${UI_BLOCK_ID}`).length) {
        host.append(renderSettingsBlock());
    }
    bindSettingsUi();
    void refreshUiStatusForCurrentChat();
}

function registerLocaleData() {
    addLocaleData('zh-cn', {
        'Search Tools': '搜索工具',
        'Expose tools to main model': '暴露工具给主模型',
        'Run pre-request search agent': '请求前运行搜索 Agent',
        'Search provider': '搜索提供方',
        'DuckDuckGo (no login)': 'DuckDuckGo（无需登录）',
        'Default max search results': '默认搜索结果上限',
        'Default safe search': '默认安全搜索',
        'Off': '关闭',
        'Moderate': '中等',
        'Strict': '严格',
        'Default page excerpt max chars (0 = no truncation)': '默认网页摘录最大字符数（0=不截断）',
        'Agent API preset (Connection profile, empty = current)': 'Agent API 预设（连接配置，留空=当前）',
        'Agent preset (params + prompt, empty = current)': 'Agent 预设（参数+提示词，留空=当前）',
        'Agent max rounds': 'Agent 最大轮数',
        'Tool call retry count': '工具调用重试次数',
        'New entry default depth': '新条目默认深度',
        'New entry default role': '新条目默认角色',
        'New entry default order': '新条目默认顺序',
        'Search agent system prompt': '搜索 Agent 系统提示词',
        'System': '系统',
        'User': '用户',
        'Assistant': '助手',
        'Stop': '终止',
        'Search agent running...': '搜索 Agent 运行中...',
        'Search agent aborted.': '搜索 Agent 已中止。',
        'Search agent failed. Check console for details.': '搜索 Agent 失败，请查看控制台。',
        'No active chat.': '当前没有激活聊天。',
        'No chat-bound lorebook yet.': '当前聊天还没有绑定世界书。',
        'Failed to inspect chat lorebook.': '检查聊天世界书失败。',
        '(Current preset)': '（当前预设）',
        '(Current API config)': '（当前 API 配置）',
        '(missing)': '（缺失）',
    });

    addLocaleData('zh-tw', {
        'Search Tools': '搜尋工具',
        'Expose tools to main model': '將工具暴露給主模型',
        'Run pre-request search agent': '在請求前執行搜尋 Agent',
        'Search provider': '搜尋提供方',
        'DuckDuckGo (no login)': 'DuckDuckGo（無需登入）',
        'Default max search results': '預設搜尋結果上限',
        'Default safe search': '預設安全搜尋',
        'Off': '關閉',
        'Moderate': '中等',
        'Strict': '嚴格',
        'Default page excerpt max chars (0 = no truncation)': '預設網頁摘錄最大字元數（0=不截斷）',
        'Agent API preset (Connection profile, empty = current)': 'Agent API 預設（連線設定，留空=目前）',
        'Agent preset (params + prompt, empty = current)': 'Agent 預設（參數+提示詞，留空=目前）',
        'Agent max rounds': 'Agent 最大輪數',
        'Tool call retry count': '工具呼叫重試次數',
        'New entry default depth': '新條目預設深度',
        'New entry default role': '新條目預設角色',
        'New entry default order': '新條目預設順序',
        'Search agent system prompt': '搜尋 Agent 系統提示詞',
        'System': '系統',
        'User': '使用者',
        'Assistant': '助手',
        'Stop': '終止',
        'Search agent running...': '搜尋 Agent 執行中...',
        'Search agent aborted.': '搜尋 Agent 已中止。',
        'Search agent failed. Check console for details.': '搜尋 Agent 失敗，請查看主控台。',
        'No active chat.': '目前沒有啟用聊天。',
        'No chat-bound lorebook yet.': '目前聊天尚未綁定世界書。',
        'Failed to inspect chat lorebook.': '檢查聊天世界書失敗。',
        '(Current preset)': '（目前預設）',
        '(Current API config)': '（目前 API 設定）',
        '(missing)': '（缺失）',
    });
}

jQuery(() => {
    ensureSettings();
    registerLocaleData();
    installGlobalApi();

    const context = getContext();
    registerTools(context);
    ensureUi();

    const wiAfterEvent = context?.eventTypes?.GENERATION_AFTER_WORLD_INFO_SCAN;
    if (wiAfterEvent) {
        context.eventSource.on(wiAfterEvent, async (payload) => {
            await maybeRunPreRequestSearchAgent(payload);
        });
    }

    if (context?.eventTypes?.CHAT_CHANGED) {
        context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
            void refreshUiStatusForCurrentChat();
        });
    }

    if (context?.eventTypes?.PRESET_CHANGED) {
        context.eventSource.on(context.eventTypes.PRESET_CHANGED, (event) => {
            if (String(event?.apiId || '') === 'openai') {
                ensureUi();
            }
        });
    }

    const connectionProfileEvents = [
        context?.eventTypes?.CONNECTION_PROFILE_LOADED,
        context?.eventTypes?.CONNECTION_PROFILE_CREATED,
        context?.eventTypes?.CONNECTION_PROFILE_DELETED,
        context?.eventTypes?.CONNECTION_PROFILE_UPDATED,
    ].filter(Boolean);
    for (const eventName of connectionProfileEvents) {
        context.eventSource.on(eventName, () => ensureUi());
    }
});
