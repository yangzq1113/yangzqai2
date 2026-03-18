// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import { eventSource, event_types, extension_prompt_roles, getRequestHeaders, saveSettings, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { sendOpenAIRequest } from '../../openai.js';
import { SECRET_KEYS, secret_state } from '../../secrets.js';
import { escapeHtml, getStringHash } from '../../utils.js';
import { newWorldInfoEntryTemplate, setGlobalWorldInfoSelection, world_info_position } from '../../world-info.js';
import { getChatCompletionConnectionProfiles, resolveChatCompletionRequestProfile } from '../connection-manager/profile-resolver.js';
import {
    TOOL_PROTOCOL_STYLE,
    extractAllFunctionCalls,
    getResponseMessageContent,
    validateParsedToolCalls,
} from '../function-call-runtime.js';

const MODULE_NAME = 'search_tools';
const UI_BLOCK_ID = 'search_tools_settings';
const STYLE_ID = 'search_tools_style';
const STATUS_ID = 'search_tools_status';
const CHAT_LOREBOOK_METADATA_KEY = 'world_info';
const SHARED_LOREBOOK_NAME = '__SEARCH_TOOLS__';
const MANAGED_COMMENT_PREFIX = 'SEARCH_TOOLS';
const SEARCH_CHAT_STATE_NAMESPACE = 'luker_search_tools_state';
const SEARCH_CHAT_STATE_VERSION = 3;
const SEARCH_CHAT_CONTENT_NAMESPACE_PREFIX = `${SEARCH_CHAT_STATE_NAMESPACE}_anchor_`;
const AGENT_TOOL_CHAIN_HARD_LIMIT = 12;
const ALLOWED_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe', 'impersonate']);
const REUSE_GENERATION_TYPES = new Set(['continue', 'regenerate', 'swipe']);
const TOOL_NAMES = Object.freeze({
    SEARCH: 'luker_web_search',
    VISIT: 'luker_web_visit',
    AGENT_SEARCH: 'luker_search_agent_search',
    AGENT_VISIT: 'luker_search_agent_visit',
    AGENT_UPSERT: 'luker_search_agent_upsert_lorebook_entry',
    AGENT_DELETE: 'luker_search_agent_delete_lorebook_entry',
    AGENT_FINALIZE: 'luker_search_agent_finalize',
});
const EXPORTED_TOOL_NAMES = Object.freeze({
    SEARCH: TOOL_NAMES.SEARCH,
    VISIT: TOOL_NAMES.VISIT,
});
const DEFAULT_LOREBOOK_CONTENT_TEMPLATE_GUIDANCE = [
    'When you write lorebook content, the content field must be exactly one fenced yaml code block.',
    'Treat the templates below as flexible reference skeletons, not a rigid schema.',
    'You may freely delete, rename, regroup, merge, or add sections when useful, as long as every included detail is directly supported by managed search entries, search results, or visited pages.',
    'Do not keep empty placeholders, filler headings, or sections with no informational value.',
    'Do not let the current chat context, roleplay direction, or likely next scene distort the entry. Keep it faithful to the gathered source material itself.',
    'Prefer clear, information-dense worldbook notes over a minimal one- or two-sentence summary when the source supports more detail.',
    'For character entries, source-backed roleplay-useful details such as mannerisms, speech style, and speech examples are allowed when the source explicitly supports them.',
    'Speech examples must only be included when directly evidenced by the source text or an explicit quoted line.',
    'Reference character template:',
    '```yaml',
    'name: "<Character Name>"',
    'aliases:',
    '  - "<Alias>"',
    'role: "<Identity or role>"',
    'overview: |',
    '  <Source-backed overview>',
    'identity:',
    '  species: "<Species or type>"',
    '  occupation:',
    '    - "<Occupation or function>"',
    '  affiliation:',
    '    - "<Group or faction>"',
    'appearance:',
    '  - "<Stable visual trait>"',
    'personality:',
    '  - "<Stable trait or behavioral tendency>"',
    'mannerisms:',
    '  - "<Habit or recognizable behavior>"',
    'speech:',
    '  style:',
    '    - "<Speaking style or register>"',
    '  examples:',
    '    - "<Source-backed line or phrasing pattern>"',
    'background:',
    '  - "<Relevant history>"',
    'relationships:',
    '  - target: "<Person or group>"',
    '    relation: "<Relationship>"',
    '    notes: "<Source-backed detail>"',
    'abilities:',
    '  - "<Ability, skill, or limitation>"',
    'items:',
    '  - "<Equipment or associated item>"',
    'notable_facts:',
    '  - "<Important fact>"',
    '```',
    'Reference event template:',
    '```yaml',
    'title: "<Event Name>"',
    'aliases:',
    '  - "<Alternate name>"',
    'time: "<Time or period>"',
    'location: "<Place>"',
    'overview: |',
    '  <Source-backed overview>',
    'background:',
    '  - "<Cause or prior condition>"',
    'participants:',
    '  - "<Participant>"',
    'sequence:',
    '  - stage: "<Stage or moment>"',
    '    details:',
    '      - "<What happened>"',
    'results:',
    '  - "<Outcome or consequence>"',
    'notable_details:',
    '  - "<Memorable detail>"',
    '```',
    'Reference location template:',
    '```yaml',
    'name: "<Location Name>"',
    'aliases:',
    '  - "<Alternate name>"',
    'type: "<City, building, region, site, ruin, venue>"',
    'overview: |',
    '  <Source-backed overview>',
    'environment:',
    '  - "<Environmental or atmospheric trait>"',
    'layout:',
    '  - "<Area, division, or structural feature>"',
    'inhabitants:',
    '  - "<Residents, caretakers, or controlling group>"',
    'rules_or_customs:',
    '  - "<Local rule, taboo, or custom>"',
    'notable_features:',
    '  - "<Landmark, danger, or resource>"',
    'history:',
    '  - "<Important historical fact>"',
    '```',
    'Reference organization template:',
    '```yaml',
    'name: "<Organization Name>"',
    'aliases:',
    '  - "<Alternate name>"',
    'type: "<Organization type>"',
    'overview: |',
    '  <Source-backed overview>',
    'purpose:',
    '  - "<Goal or mission>"',
    'structure:',
    '  - "<Hierarchy or operating model>"',
    'members:',
    '  - "<Key member or subgroup>"',
    'assets:',
    '  - "<Resources, territory, or influence>"',
    'methods:',
    '  - "<Typical methods or activities>"',
    'relations:',
    '  - target: "<Other party>"',
    '    status: "<Friendly, hostile, neutral, subordinate, allied>"',
    '    notes: "<Source-backed detail>"',
    'notable_facts:',
    '  - "<Important fact>"',
    '```',
    'Reference item / technology / concept / rule template:',
    '```yaml',
    'name: "<Name>"',
    'aliases:',
    '  - "<Alternate name>"',
    'type: "<Item, technology, concept, rule, power system>"',
    'overview: |',
    '  <Source-backed overview>',
    'properties:',
    '  - "<Property or defining trait>"',
    'usage:',
    '  - "<Use or application>"',
    'mechanics:',
    '  - "<How it works, including limits or costs>"',
    'owners_or_users:',
    '  - "<Associated person or group>"',
    'notable_facts:',
    '  - "<Important fact>"',
    '```',
].join('\n');
const DEFAULT_LOREBOOK_CONTENT_TASK_GUIDANCE = [
    '- In the AGENT_UPSERT content field, write exactly one fenced yaml code block.',
    '- Treat the YAML templates as flexible reference skeletons rather than a rigid schema. Delete irrelevant sections and add useful source-backed ones freely.',
    '- Character entries may include source-backed mannerisms, speech style, and speech examples when the evidence explicitly supports them.',
    '- Do not keep empty placeholders, and do not let current chat context distort the source-backed entry.',
].join('\n');

const DEFAULT_AGENT_SYSTEM_PROMPT = [
    'You are a pre-request web research agent for roleplay generation.',
    'Your job is to decide whether any search-backed lorebook update is necessary before the main generation request continues.',
    'You may finish immediately without searching if active world info, character information, and managed search entries already cover the need.',
    'Search-backed lorebook content must stay strictly faithful to the source text from managed search entries, search results, and visited pages.',
    'Every managed lorebook entry must read like an objective reference note, not like story direction, roleplay guidance, or character writing advice.',
    'Treat search output as source material only. Any story-driven adaptation, reinterpretation, dramatization, or extrapolation is out of scope.',
    'Do not rewrite source-backed facts to fit the current plot, scene mood, or roleplay direction.',
    'Do not infer or invent character emotions, cognition, motives, intentions, hidden thoughts, relationship shifts, future actions, or plot consequences unless the source explicitly states them.',
    'Do not write instructions, recommendations, likely reactions, behavioral coaching, tone guidance, scene framing, or any text that tells the main model how to portray a character or continue the story.',
    'If a source is ambiguous, keep wording neutral or do not write it.',
    'Avoid duplicates. If information would repeat existing active world info, character card facts, or existing managed search entries, do not add it.',
    'Search and visit are optional. You may use existing managed search entries as your own database.',
    'If information is uncertain, highly time-sensitive, or search snippets are insufficient, prefer search plus visit before writing.',
    `Keep each response focused. Prefer 1 to 3 new ${TOOL_NAMES.AGENT_SEARCH} calls per response, avoid exceeding 4 unless absolutely necessary, and never spray many near-duplicate searches in one response.`,
    `Call ${TOOL_NAMES.AGENT_FINALIZE} only when you are ready to end the run.`,
    `If you call ${TOOL_NAMES.AGENT_SEARCH} or ${TOOL_NAMES.AGENT_VISIT}, do not call ${TOOL_NAMES.AGENT_FINALIZE} in that same response. Wait for tool results first.`,
    'Only delete entries that are explicitly listed as deletable.',
    'Before any tool calls, output exactly one concise <thought>...</thought> block.',
    'In that thought block, ask yourself: What information gap matters for this turn, or is there no real gap left? Should you search or visit now, and what exactly should you look for? Which lorebook entries should be created or updated, and how should each one be configured? Should any existing managed entries be deleted? Can you finalize now, or do you still need more evidence?',
    'Use the thought block to decide the current step only.',
    `If fresh evidence is still needed, focus the thought block on whether to call ${TOOL_NAMES.AGENT_SEARCH} or ${TOOL_NAMES.AGENT_VISIT} and what to gather next. Do not fully plan or commit to concrete lorebook writes before the evidence arrives.`,
    'After new search or visit results arrive, think again from the updated evidence and only then decide concrete entry writes or deletions.',
    'For lorebook writes, provide only the needed persistent factual content, activation keywords, and whether it should always inject.',
    DEFAULT_LOREBOOK_CONTENT_TEMPLATE_GUIDANCE,
    'Use always-inject entries only for information that is important enough to stay visible in context continuously even without a trigger. Otherwise prefer keyword activation.',
    'Always-inject is usually appropriate for always-on rules, core worldbuilding, setting assumptions, power-system rules, social norms, or other global reference material the model should keep in view throughout the chat.',
    'If the user explicitly names a concrete character or other scene-bound target, that is usually a keyword-activation case rather than a constant-entry case.',
    'If the user asks for open-ended suggestions without naming the targets, such as asking for several characters but not specifying which ones, consider always-inject so the creative model can keep seeing the suggested candidates and their source-backed reference facts.',
    'For keyword-activated entries, choose precise trigger words that are likely to appear when that scenario is actually relevant.',
    'Do not mark an entry constant merely because it is relevant to the current turn. Constant entries are for always-on rules or ongoing creative reference material that must stay visible.',
    'Prefer concise declarative fact statements over narrative prose.',
    'When writing lorebook content, preserve source scope and uncertainty instead of upgrading it into stronger claims.',
    'Do not move or redesign lorebook layout. Runtime controls managed entry position/depth/role/order from current settings.',
    'Outside the single <thought>...</thought> block and tool calls, do not output plain prose.',
].join('\n');

const DEFAULT_AGENT_FINAL_STAGE_PROMPT = [
    'You are the final-stage web research agent for roleplay generation.',
    'This stage exists to finish the pre-request search pass using only evidence already gathered earlier in this run.',
    `Do not call ${TOOL_NAMES.AGENT_SEARCH} or ${TOOL_NAMES.AGENT_VISIT} in this stage.`,
    'Use only managed search entries, previous search results, and visited page text already available in the conversation.',
    'Search-backed lorebook content must stay strictly faithful to the source text from managed search entries, search results, and visited pages.',
    'Every managed lorebook entry must read like an objective reference note, not like story direction, roleplay guidance, or character writing advice.',
    'Treat search output as source material only. Any story-driven adaptation, reinterpretation, dramatization, or extrapolation is out of scope.',
    'Do not infer or invent character emotions, cognition, motives, intentions, hidden thoughts, relationship shifts, future actions, or plot consequences unless the source explicitly states them.',
    'Do not write instructions, recommendations, likely reactions, behavioral coaching, tone guidance, scene framing, or any text that tells the main model how to portray a character or continue the story.',
    'If a source is ambiguous, keep wording neutral or do not write it.',
    'Avoid duplicates. If information would repeat existing active world info, character card facts, or existing managed search entries, do not add it.',
    'Only delete entries that are explicitly listed as deletable.',
    'Delete any managed search entries that are no longer needed, outdated for the current chat branch, duplicated, or unsupported by the gathered evidence.',
    'Do not preserve stale managed search entries just because they already exist.',
    'Before any tool calls, output exactly one concise <thought>...</thought> block.',
    'In that thought block, ask yourself: Does any information gap still remain? Which managed entries should be created or updated, and how should each one be configured? Should any existing managed entries be deleted? Can you finalize now?',
    'Use the thought block to decide the current final-stage step only.',
    'No new evidence will arrive in this stage, so base writes, deletions, and finalization only on evidence already gathered.',
    'For lorebook writes, provide only the needed persistent factual content, activation keywords, and whether it should always inject.',
    DEFAULT_LOREBOOK_CONTENT_TEMPLATE_GUIDANCE,
    'Use always-inject entries only for information that is important enough to stay visible in context continuously even without a trigger. Otherwise prefer keyword activation.',
    'Always-inject is usually appropriate for always-on rules, core worldbuilding, setting assumptions, power-system rules, social norms, or other global reference material the model should keep in view throughout the chat.',
    'If the user explicitly names a concrete character or other scene-bound target, that is usually a keyword-activation case rather than a constant-entry case.',
    'If the user asks for open-ended suggestions without naming the targets, such as asking for several characters but not specifying which ones, consider always-inject so the creative model can keep seeing the suggested candidates and their source-backed reference facts.',
    'For keyword-activated entries, choose precise trigger words that are likely to appear when that scenario is actually relevant.',
    'Do not mark an entry constant merely because it is relevant to the current turn. Constant entries are for always-on rules or ongoing creative reference material that must stay visible.',
    'Prefer concise declarative fact statements over narrative prose.',
    'When writing lorebook content, preserve source scope and uncertainty instead of upgrading it into stronger claims.',
    'Outside the single <thought>...</thought> block and tool calls, do not output plain prose.',
    `If any lorebook change is still needed, do it now and also call ${TOOL_NAMES.AGENT_FINALIZE} in the same response.`,
    `If no lorebook change is needed, call ${TOOL_NAMES.AGENT_FINALIZE} immediately.`,
    `Always finish by calling ${TOOL_NAMES.AGENT_FINALIZE}.`,
].join('\n');

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    preRequestEnabled: false,
    provider: 'ddg',
    defaultMaxResults: 8,
    defaultVisitMaxChars: 4000,
    safeSearch: 'moderate',
    providers: Object.freeze({
        ddg: Object.freeze({
            safeSearch: 'moderate',
        }),
        searxng: Object.freeze({
            baseUrl: '',
            safeSearch: 'moderate',
        }),
        brave: Object.freeze({
            safeSearch: 'moderate',
        }),
    }),
    agentApiPresetName: '',
    agentPresetName: '',
    includeWorldInfoWithPreset: true,
    agentSystemPrompt: DEFAULT_AGENT_SYSTEM_PROMPT,
    agentFinalStagePrompt: DEFAULT_AGENT_FINAL_STAGE_PROMPT,
    agentMaxRounds: 3,
    toolCallRetryMax: 2,
    lorebookPosition: world_info_position.atDepth,
    lorebookDepth: 9999,
    lorebookRole: extension_prompt_roles.SYSTEM,
    lorebookEntryOrder: 9800,
});
const LOREBOOK_POSITION_SCHEMA_VERSION = 2;
const SUPPORTED_WORLD_INFO_POSITIONS = Object.freeze([
    world_info_position.before,
    world_info_position.after,
    world_info_position.ANTop,
    world_info_position.ANBottom,
    world_info_position.EMTop,
    world_info_position.EMBottom,
    world_info_position.atDepth,
]);

let activeAgentRunToken = 0;
let activeAgentRunInfoToast = null;
let activeAgentAbortController = null;
let latestSearchAgentSnapshot = null;
let latestSearchHistoryIndex = null;
let latestManagedEntries = [];
let loadedChatStateKey = '';

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

function normalizeAnchorPlayableFloor(value) {
    return Math.max(0, Math.floor(Number(value) || 0));
}

function getAvailableSearchProviders() {
    return [
        {
            id: 'ddg',
            label: 'DuckDuckGo (no login)',
        },
        {
            id: 'searxng',
            label: 'SearXNG (custom instance)',
        },
        {
            id: 'brave',
            label: 'Brave Search (API key)',
        },
    ];
}

function getDefaultSearchProviderId() {
    return getAvailableSearchProviders()[0]?.id || 'ddg';
}

function getSearchProviderDefinition(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return getAvailableSearchProviders().find(provider => provider.id === normalized) || getAvailableSearchProviders()[0];
}

function normalizeProvider(value) {
    return getSearchProviderDefinition(value)?.id || getDefaultSearchProviderId();
}

function normalizeSafeSearch(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['off', 'moderate', 'strict'].includes(normalized) ? normalized : DEFAULT_SETTINGS.safeSearch;
}

function normalizeDdgProviderSettings(raw = {}, legacySafeSearch = DEFAULT_SETTINGS.safeSearch) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        safeSearch: normalizeSafeSearch(source.safeSearch ?? legacySafeSearch),
    };
}

function normalizeSearxngProviderSettings(raw = {}, legacySafeSearch = DEFAULT_SETTINGS.safeSearch) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        baseUrl: normalizeWhitespace(source.baseUrl || ''),
        safeSearch: normalizeSafeSearch(source.safeSearch ?? legacySafeSearch),
    };
}

function normalizeBraveProviderSettings(raw = {}, legacySafeSearch = DEFAULT_SETTINGS.safeSearch) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        safeSearch: normalizeSafeSearch(source.safeSearch ?? legacySafeSearch),
    };
}

function normalizeProviderSettings(raw = {}, legacy = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        ddg: normalizeDdgProviderSettings(source.ddg, legacy.safeSearch),
        searxng: normalizeSearxngProviderSettings(source.searxng, legacy.safeSearch),
        brave: normalizeBraveProviderSettings(source.brave, legacy.safeSearch),
    };
}

function getProviderSettings(settings = getSettings(), providerId = '') {
    const normalizedProviderId = normalizeProvider(providerId || settings?.provider);
    const source = settings?.providers && typeof settings.providers === 'object' ? settings.providers : {};
    if (normalizedProviderId === 'ddg') {
        return normalizeDdgProviderSettings(source.ddg, settings?.safeSearch);
    }
    if (normalizedProviderId === 'searxng') {
        return normalizeSearxngProviderSettings(source.searxng, settings?.safeSearch);
    }
    if (normalizedProviderId === 'brave') {
        return normalizeBraveProviderSettings(source.brave, settings?.safeSearch);
    }
    return {};
}

function hasConfiguredSecret(key) {
    const secrets = secret_state?.[key];
    return Array.isArray(secrets) ? secrets.length > 0 : Boolean(secrets);
}

function normalizeLorebookRole(value) {
    const numeric = Number(value);
    if ([extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT].includes(numeric)) {
        return numeric;
    }
    return DEFAULT_SETTINGS.lorebookRole;
}

function normalizeLorebookPosition(value) {
    const numeric = Number(value);
    return SUPPORTED_WORLD_INFO_POSITIONS.includes(numeric) ? numeric : DEFAULT_SETTINGS.lorebookPosition;
}

function migrateLegacyPromptInjectionPosition(value) {
    switch (Number(value)) {
        case 2:
            return world_info_position.before;
        case 0:
            return world_info_position.after;
        case 1:
            return world_info_position.atDepth;
        default:
            return DEFAULT_SETTINGS.lorebookPosition;
    }
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }
    const settings = extension_settings[MODULE_NAME];
    settings.enabled = Boolean(settings.enabled ?? DEFAULT_SETTINGS.enabled);
    settings.preRequestEnabled = Boolean(settings.preRequestEnabled ?? DEFAULT_SETTINGS.preRequestEnabled);
    settings.provider = normalizeProvider(settings.provider ?? DEFAULT_SETTINGS.provider);
    settings.providers = normalizeProviderSettings(settings.providers, {
        safeSearch: settings.safeSearch ?? DEFAULT_SETTINGS.safeSearch,
    });
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
    settings.safeSearch = getProviderSettings(settings, 'ddg').safeSearch;
    settings.agentApiPresetName = String(settings.agentApiPresetName ?? DEFAULT_SETTINGS.agentApiPresetName).trim();
    settings.agentPresetName = String(settings.agentPresetName ?? DEFAULT_SETTINGS.agentPresetName).trim();
    settings.includeWorldInfoWithPreset = Boolean(settings.includeWorldInfoWithPreset ?? DEFAULT_SETTINGS.includeWorldInfoWithPreset);
    const normalizedAgentSystemPrompt = String(settings.agentSystemPrompt ?? DEFAULT_SETTINGS.agentSystemPrompt).trim();
    settings.agentSystemPrompt = normalizedAgentSystemPrompt || DEFAULT_SETTINGS.agentSystemPrompt;
    const normalizedAgentFinalStagePrompt = String(settings.agentFinalStagePrompt ?? DEFAULT_SETTINGS.agentFinalStagePrompt).trim();
    settings.agentFinalStagePrompt = normalizedAgentFinalStagePrompt || DEFAULT_SETTINGS.agentFinalStagePrompt;
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
    const hasLorebookPositionSchemaVersion = Object.prototype.hasOwnProperty.call(settings, 'lorebookPositionSchemaVersion');
    if (!hasLorebookPositionSchemaVersion) {
        settings.lorebookPosition = migrateLegacyPromptInjectionPosition(settings.lorebookPosition ?? DEFAULT_SETTINGS.lorebookPosition);
    }
    settings.lorebookPosition = normalizeLorebookPosition(settings.lorebookPosition ?? DEFAULT_SETTINGS.lorebookPosition);
    settings.lorebookPositionSchemaVersion = LOREBOOK_POSITION_SCHEMA_VERSION;
    settings.lorebookDepth = clampInteger(
        settings.lorebookDepth ?? DEFAULT_SETTINGS.lorebookDepth,
        0,
        9999,
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

function shouldActivateSharedLorebook(settings = getSettings()) {
    return Boolean(settings?.enabled || settings?.preRequestEnabled);
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

function normalizeSearchAgentSnapshot(raw) {
    const source = raw && typeof raw === 'object' ? raw : null;
    if (!source) {
        return null;
    }

    const chatKey = String(source.chatKey || '').trim();
    const anchorHash = String(source.anchorHash || '').trim();
    if (!chatKey || !anchorHash) {
        return null;
    }

    return {
        chatKey,
        anchorFloor: normalizeAnchorPlayableFloor(source.anchorFloor),
        anchorPlayableFloor: normalizeAnchorPlayableFloor(source.anchorPlayableFloor || source.anchorFloor),
        anchorHash,
        updatedAt: String(source.updatedAt || '').trim(),
        summary: normalizeWhitespace(source.summary || ''),
        mutationCount: Math.max(0, Math.floor(Number(source.mutationCount || 0))),
        managedEntryCount: Math.max(0, Math.floor(Number(source.managedEntryCount || 0))),
        bookName: normalizeWhitespace(source.bookName || ''),
    };
}

function normalizeStoredManagedEntries(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    const output = [];
    const seen = new Set();
    for (const item of raw) {
        const entryId = sanitizeEntryId(item?.entryId || item?.entry_id || '');
        const content = normalizeMultilineText(item?.content || '');
        if (!entryId || !content || seen.has(entryId)) {
            continue;
        }
        seen.add(entryId);
        output.push({
            entryId,
            title: deriveManagedEntryTitle(
                entryId,
                item?.title || '',
                Array.isArray(item?.keywords) ? item.keywords : [],
                content,
            ),
            keywords: normalizeKeywordDisplayList(Array.isArray(item?.keywords) ? item.keywords : []),
            content,
            alwaysInject: Boolean(item?.alwaysInject ?? item?.always_inject),
        });
    }

    return output.sort((a, b) => String(a.entryId || '').localeCompare(String(b.entryId || '')));
}

function normalizeSearchHistoryAnchors(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    const anchors = [];
    const seen = new Set();
    for (const value of raw) {
        const normalized = normalizeAnchorPlayableFloor(value);
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        anchors.push(normalized);
    }
    return anchors.sort((left, right) => left - right);
}

function equalNumberArrays(left = [], right = []) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (Number(left[index]) !== Number(right[index])) {
            return false;
        }
    }
    return true;
}

function normalizeStoredSearchAgentSnapshot(raw) {
    const source = raw && typeof raw === 'object' ? raw : null;
    if (!source) {
        return null;
    }

    const anchorHash = String(source.anchorHash || '').trim();
    if (!anchorHash) {
        return null;
    }

    const managedEntries = normalizeStoredManagedEntries(source.managedEntries);
    return {
        anchorHash,
        updatedAt: String(source.updatedAt || '').trim(),
        summary: normalizeWhitespace(source.summary || ''),
        mutationCount: Math.max(0, Math.floor(Number(source.mutationCount || 0))),
        managedEntryCount: Math.max(0, Math.floor(Number(source.managedEntryCount ?? managedEntries.length))),
        bookName: normalizeWhitespace(source.bookName || ''),
        managedEntries,
    };
}

function materializeSearchAgentSnapshot(chatKey, anchorPlayableFloor, snapshot) {
    const normalizedSnapshot = normalizeStoredSearchAgentSnapshot(snapshot);
    const normalizedChatKey = String(chatKey || '').trim();
    const normalizedAnchor = normalizeAnchorPlayableFloor(anchorPlayableFloor);
    if (!normalizedSnapshot || !normalizedChatKey || !normalizedAnchor) {
        return null;
    }

    const managedEntries = normalizeStoredManagedEntries(normalizedSnapshot.managedEntries);
    return {
        chatKey: normalizedChatKey,
        anchorFloor: normalizedAnchor,
        anchorPlayableFloor: normalizedAnchor,
        anchorHash: String(normalizedSnapshot.anchorHash || '').trim(),
        updatedAt: normalizedSnapshot.updatedAt,
        summary: normalizedSnapshot.summary,
        mutationCount: normalizedSnapshot.mutationCount,
        managedEntryCount: managedEntries.length,
        bookName: normalizedSnapshot.bookName,
        managedEntries,
    };
}

function normalizeSearchToolsChatState(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        version: Number(source.version || SEARCH_CHAT_STATE_VERSION),
        anchors: normalizeSearchHistoryAnchors(source.anchors),
        legacySnapshot: normalizeSearchAgentSnapshot(source.snapshot),
        managedEntries: normalizeStoredManagedEntries(source.managedEntries),
    };
}

function setLoadedSearchHistoryIndex(chatKey, anchors) {
    const normalizedChatKey = String(chatKey || '').trim();
    if (!normalizedChatKey) {
        latestSearchHistoryIndex = null;
        return;
    }
    latestSearchHistoryIndex = {
        chatKey: normalizedChatKey,
        anchors: normalizeSearchHistoryAnchors(anchors),
    };
}

function getLoadedSearchHistoryAnchors(context) {
    const chatKey = getChatKey(context);
    if (!latestSearchHistoryIndex || typeof latestSearchHistoryIndex !== 'object') {
        return [];
    }
    if (String(latestSearchHistoryIndex.chatKey || '') !== String(chatKey || '')) {
        return [];
    }
    return normalizeSearchHistoryAnchors(latestSearchHistoryIndex.anchors);
}

function getSearchAgentSnapshotNamespace(anchorPlayableFloor) {
    const normalized = normalizeAnchorPlayableFloor(anchorPlayableFloor);
    if (!normalized) {
        return '';
    }
    return `${SEARCH_CHAT_CONTENT_NAMESPACE_PREFIX}${normalized}`;
}

function getChatKey(context) {
    if (context.groupId) {
        return `group:${context.groupId}`;
    }

    const avatar = String(context.characters?.[context.characterId]?.avatar || '').trim();
    const chatId = String(context.chatId || context.getCurrentChatId?.() || '').trim();
    if (!avatar || !chatId) {
        return '';
    }
    return `char:${avatar}:${chatId}`;
}

function abortActiveSearchAgentRun() {
    if (activeAgentAbortController && !activeAgentAbortController.signal.aborted) {
        activeAgentAbortController.abort();
    }
    clearAgentRunInfoToast();
}

async function loadSearchToolsChatState(context, { force = false } = {}) {
    const chatKey = getChatKey(context);
    if (!chatKey) {
        latestSearchAgentSnapshot = null;
        latestSearchHistoryIndex = null;
        latestManagedEntries = [];
        loadedChatStateKey = '';
        return;
    }
    if (!force && loadedChatStateKey === chatKey) {
        return;
    }

    let payload = null;
    if (typeof context?.getChatState === 'function') {
        payload = await context.getChatState(SEARCH_CHAT_STATE_NAMESPACE, {});
    }
    const normalized = normalizeSearchToolsChatState(payload);
    loadedChatStateKey = chatKey;
    let nextAnchors = normalized.anchors.slice();
    let migratedLegacySnapshot = false;
    if (normalized.legacySnapshot) {
        const legacyAnchor = normalizeAnchorPlayableFloor(normalized.legacySnapshot.anchorPlayableFloor || normalized.legacySnapshot.anchorFloor);
        if (legacyAnchor) {
            await persistStoredSearchAgentSnapshot(context, legacyAnchor, {
                anchorHash: normalized.legacySnapshot.anchorHash,
                updatedAt: normalized.legacySnapshot.updatedAt,
                summary: normalized.legacySnapshot.summary,
                mutationCount: normalized.legacySnapshot.mutationCount,
                managedEntryCount: Math.max(normalized.legacySnapshot.managedEntryCount, normalized.managedEntries.length),
                bookName: normalized.legacySnapshot.bookName,
                managedEntries: normalized.managedEntries,
            });
            nextAnchors = normalizeSearchHistoryAnchors([...nextAnchors, legacyAnchor]);
            migratedLegacySnapshot = true;
        }
    }
    setLoadedSearchHistoryIndex(chatKey, nextAnchors);
    await selectLatestValidSearchAgentSnapshot(context, { persistCleanup: true });
    if (!latestSearchAgentSnapshot && nextAnchors.length === 0 && !normalized.legacySnapshot) {
        latestManagedEntries = normalized.managedEntries;
    }

    if (latestManagedEntries.length === 0) {
        const migratedEntries = await loadLegacyManagedEntries(context);
        if (migratedEntries.length > 0) {
            latestManagedEntries = migratedEntries;
            await persistSearchToolsChatState(context);
        }
    }
    if (migratedLegacySnapshot) {
        await persistSearchToolsChatState(context);
    }
}

async function persistSearchToolsChatState(context) {
    const chatKey = getChatKey(context);
    if (!chatKey) {
        return;
    }

    loadedChatStateKey = chatKey;
    const anchors = getLoadedSearchHistoryAnchors(context);
    const fallbackManagedEntries = anchors.length === 0 ? normalizeStoredManagedEntries(latestManagedEntries) : [];
    if (anchors.length === 0 && fallbackManagedEntries.length === 0 && typeof context?.deleteChatState === 'function') {
        await context.deleteChatState(SEARCH_CHAT_STATE_NAMESPACE, {});
        return;
    }
    if (typeof context?.updateChatState !== 'function') {
        return;
    }
    await context.updateChatState(SEARCH_CHAT_STATE_NAMESPACE, () => ({
        version: SEARCH_CHAT_STATE_VERSION,
        anchors,
        managedEntries: fallbackManagedEntries,
    }), { maxOperations: 2000, maxRetries: 1 });
}

async function loadStoredSearchAgentSnapshot(context, anchorPlayableFloor) {
    const namespace = getSearchAgentSnapshotNamespace(anchorPlayableFloor);
    if (!namespace || typeof context?.getChatState !== 'function') {
        return null;
    }
    const payload = await context.getChatState(namespace, {});
    return normalizeStoredSearchAgentSnapshot(payload);
}

async function persistStoredSearchAgentSnapshot(context, anchorPlayableFloor, snapshot) {
    const namespace = getSearchAgentSnapshotNamespace(anchorPlayableFloor);
    const normalized = normalizeStoredSearchAgentSnapshot(snapshot);
    if (!namespace || !normalized || typeof context?.updateChatState !== 'function') {
        return false;
    }
    const result = await context.updateChatState(namespace, () => ({
        anchorHash: String(normalized.anchorHash || '').trim(),
        updatedAt: normalized.updatedAt,
        summary: normalized.summary,
        mutationCount: normalized.mutationCount,
        managedEntryCount: normalized.managedEntries.length,
        bookName: normalized.bookName,
        managedEntries: normalizeStoredManagedEntries(normalized.managedEntries),
    }), { maxOperations: 2000, maxRetries: 1 });
    return Boolean(result?.ok);
}

async function deleteStoredSearchAgentSnapshot(context, anchorPlayableFloor) {
    const namespace = getSearchAgentSnapshotNamespace(anchorPlayableFloor);
    if (!namespace || typeof context?.deleteChatState !== 'function') {
        return false;
    }
    return Boolean(await context.deleteChatState(namespace, {}));
}

async function deleteStoredSearchAgentAnchors(context, anchors) {
    const normalizedAnchors = normalizeSearchHistoryAnchors(anchors);
    for (const anchorPlayableFloor of normalizedAnchors) {
        await deleteStoredSearchAgentSnapshot(context, anchorPlayableFloor);
    }
}

function getPlayableMessageAt(messages, playableFloor) {
    const source = Array.isArray(messages) ? messages : [];
    const targetPlayableFloor = normalizeAnchorPlayableFloor(playableFloor);
    if (!targetPlayableFloor) {
        return null;
    }
    let playableSeq = 0;
    for (let index = 0; index < source.length; index += 1) {
        const message = source[index];
        if (!message || message.is_system) {
            continue;
        }
        playableSeq += 1;
        if (playableSeq === targetPlayableFloor) {
            return { index, message };
        }
    }
    return null;
}

function isStoredSearchAgentSnapshotValidForMessages(anchorPlayableFloor, snapshot, messages) {
    const normalizedSnapshot = normalizeStoredSearchAgentSnapshot(snapshot);
    if (!normalizedSnapshot) {
        return false;
    }
    const target = getPlayableMessageAt(messages, anchorPlayableFloor);
    if (!target?.message || target.message.is_system || !target.message.is_user) {
        return false;
    }
    const storedHash = String(normalizedSnapshot.anchorHash || '').trim();
    if (!storedHash) {
        return false;
    }
    const currentHash = String(getStringHash(String(target.message.mes ?? '')));
    return currentHash === storedHash;
}

async function selectLatestValidSearchAgentSnapshot(context, { persistCleanup = false } = {}) {
    const chatKey = getChatKey(context);
    if (!chatKey) {
        latestSearchAgentSnapshot = null;
        latestSearchHistoryIndex = null;
        latestManagedEntries = [];
        return null;
    }

    const messages = Array.isArray(context?.chat) ? context.chat : [];
    const previousAnchors = getLoadedSearchHistoryAnchors(context);
    const nextAnchors = previousAnchors.slice();
    let nextSnapshot = null;

    for (let index = nextAnchors.length - 1; index >= 0; index -= 1) {
        const anchorPlayableFloor = nextAnchors[index];
        const snapshot = await loadStoredSearchAgentSnapshot(context, anchorPlayableFloor);
        if (!snapshot || !isStoredSearchAgentSnapshotValidForMessages(anchorPlayableFloor, snapshot, messages)) {
            nextAnchors.splice(index, 1);
            if (persistCleanup) {
                await deleteStoredSearchAgentSnapshot(context, anchorPlayableFloor);
            }
            continue;
        }
        nextSnapshot = materializeSearchAgentSnapshot(chatKey, anchorPlayableFloor, snapshot);
        break;
    }

    setLoadedSearchHistoryIndex(chatKey, nextAnchors);
    latestSearchAgentSnapshot = nextSnapshot;
    latestManagedEntries = nextSnapshot ? normalizeStoredManagedEntries(nextSnapshot.managedEntries) : [];
    if (persistCleanup && !equalNumberArrays(previousAnchors, nextAnchors)) {
        await persistSearchToolsChatState(context);
    }
    return nextSnapshot;
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

async function runSearxngSearch({
    query,
    maxResults,
    safeSearch,
    timeRange,
    providerSettings,
    abortSignal = null,
}) {
    const baseUrl = normalizeWhitespace(providerSettings?.baseUrl || '');
    if (!baseUrl) {
        throw new Error('SearXNG instance URL is required.');
    }

    const response = await fetch('/api/search/searxng', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: isAbortSignalLike(abortSignal) ? abortSignal : null,
        body: JSON.stringify({
            baseUrl,
            query,
            max_results: maxResults,
            safe_search: safeSearch,
            time_range: timeRange || '',
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`SearXNG search request failed (${response.status}): ${text || response.statusText}`);
    }

    const payload = await response.json();
    const results = normalizeSearchRows(payload?.results || [], 'searxng');
    return {
        provider: 'searxng',
        query: String(payload?.query || query || ''),
        result_count: Number(payload?.result_count || results.length),
        results,
    };
}

async function runBraveSearch({
    query,
    maxResults,
    safeSearch,
    timeRange,
    abortSignal = null,
}) {
    const response = await fetch('/api/search/brave', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: isAbortSignalLike(abortSignal) ? abortSignal : null,
        body: JSON.stringify({
            query,
            max_results: maxResults,
            safe_search: safeSearch,
            time_range: timeRange || '',
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Brave search request failed (${response.status}): ${text || response.statusText}`);
    }

    const payload = await response.json();
    const results = normalizeSearchRows(payload?.results || [], 'brave');
    return {
        provider: 'brave',
        query: String(payload?.query || query || ''),
        result_count: Number(payload?.result_count || results.length),
        results,
    };
}

async function runSearchProvider(provider, options) {
    const normalizedProvider = normalizeProvider(provider);
    if (normalizedProvider === 'ddg') {
        return await runDdgSearch(options);
    }
    if (normalizedProvider === 'searxng') {
        return await runSearxngSearch(options);
    }
    if (normalizedProvider === 'brave') {
        return await runBraveSearch(options);
    }

    console.warn(`[${MODULE_NAME}] Unsupported provider '${provider}'. Falling back to ${getDefaultSearchProviderId()}.`);
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
    const providerSettings = getProviderSettings(settings, settings.provider);
    const safeSearch = normalizeSafeSearch(args?.safe_search || providerSettings.safeSearch || settings.safeSearch);
    const timeRange = String(args?.time_range || '').trim().toLowerCase();
    const region = normalizeWhitespace(args?.region || '');

    return await runSearchProvider(settings.provider, {
        query,
        maxResults,
        safeSearch,
        timeRange,
        region,
        providerSettings,
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

function getSharedSearchToolSpecs() {
    return [
        {
            tool: {
                type: 'function',
                function: {
                    name: EXPORTED_TOOL_NAMES.SEARCH,
                    description: 'Search the web for up-to-date information. Provider is configured by the plugin settings.',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: 'Search query text.' },
                            max_results: { type: 'integer', description: 'Maximum number of search results (1-20).' },
                            safe_search: { type: 'string', enum: ['off', 'moderate', 'strict'] },
                            time_range: { type: 'string', enum: ['', 'day', 'week', 'month', 'year'] },
                            region: { type: 'string', description: 'Optional provider-specific locale or region hint.' },
                        },
                        required: ['query'],
                        additionalProperties: false,
                    },
                },
            },
            displayName: 'Web Search',
            formatMessage: 'Searching web...',
            action: searchWeb,
        },
        {
            tool: {
                type: 'function',
                function: {
                    name: EXPORTED_TOOL_NAMES.VISIT,
                    description: 'Fetch one webpage and return readable text excerpt.',
                    parameters: {
                        type: 'object',
                        properties: {
                            url: { type: 'string', description: 'HTTP/HTTPS page URL.' },
                            max_chars: { type: 'integer', description: 'Maximum output characters (0-50000). 0 means no truncation.' },
                        },
                        required: ['url'],
                        additionalProperties: false,
                    },
                },
            },
            displayName: 'Visit Web Page',
            formatMessage: 'Fetching webpage...',
            action: visitWebPage,
        },
    ];
}

function getSharedSearchToolDefs() {
    return getSharedSearchToolSpecs().map(spec => structuredClone(spec.tool));
}

function isSharedSearchToolName(name = '') {
    const normalizedName = String(name || '').trim();
    return normalizedName === EXPORTED_TOOL_NAMES.SEARCH || normalizedName === EXPORTED_TOOL_NAMES.VISIT;
}

async function invokeSharedSearchToolCall(call, { abortSignal = null } = {}) {
    const name = String(call?.name || '').trim();
    const args = call?.args && typeof call.args === 'object' ? call.args : {};

    if (name === EXPORTED_TOOL_NAMES.SEARCH) {
        return await searchWeb(args, { abortSignal });
    }

    if (name === EXPORTED_TOOL_NAMES.VISIT) {
        return await visitWebPage(args, { abortSignal });
    }

    throw new Error(`Unsupported search tool: ${name}`);
}

function installGlobalApi() {
    const root = globalThis;
    if (!root.Luker || typeof root.Luker !== 'object') {
        root.Luker = {};
    }
    root.Luker.searchTools = {
        toolNames: EXPORTED_TOOL_NAMES,
        getToolDefs: () => getSharedSearchToolDefs(),
        isToolName: (name) => isSharedSearchToolName(name),
        invoke: async (call, options = {}) => await invokeSharedSearchToolCall(call, options),
        search: searchWeb,
        visit: visitWebPage,
        getSettings: () => {
            const settings = getSettings();
            const activeProviderSettings = getProviderSettings(settings, settings.provider);
            return {
                enabled: Boolean(settings.enabled),
                preRequestEnabled: Boolean(settings.preRequestEnabled),
                provider: String(settings.provider || getDefaultSearchProviderId()),
                defaultMaxResults: Number(settings.defaultMaxResults || DEFAULT_SETTINGS.defaultMaxResults),
                defaultVisitMaxChars: Number(settings.defaultVisitMaxChars || DEFAULT_SETTINGS.defaultVisitMaxChars),
                safeSearch: String(activeProviderSettings.safeSearch || settings.safeSearch || DEFAULT_SETTINGS.safeSearch),
                providerSettings: structuredClone(settings.providers || {}),
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

    for (const spec of getSharedSearchToolSpecs()) {
        context.registerFunctionTool({
            name: spec.tool.function.name,
            displayName: spec.displayName,
            description: spec.tool.function.description,
            shouldRegister: async () => isToolEnabled(),
            parameters: structuredClone(spec.tool.function.parameters),
            action: async (args) => await spec.action(args),
            formatMessage: () => spec.formatMessage,
        });
    }
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
    /** @type {{ worldInfoDepth?: any[]; worldInfoAfter?: string }} */
    const target = payload;
    const depthEntries = Array.isArray(target.worldInfoDepth) ? target.worldInfoDepth : [];
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

    target.worldInfoDepth = [];
    if (blocks.length === 0) {
        return payload;
    }

    const mergedDepthText = blocks.join('\n\n').trim();
    target.worldInfoAfter = [String(target.worldInfoAfter || '').trim(), mergedDepthText]
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

function syncMutableGenerationPayloadState(target, source) {
    if (!target || typeof target !== 'object' || !source || typeof source !== 'object' || target === source) {
        return;
    }

    const mutableKeys = [
        'requestRescan',
        'worldInfoResolution',
        'worldInfoResolutionOverride',
        'worldInfoBefore',
        'worldInfoAfter',
        'worldInfoDepth',
        'worldInfoExamples',
        'anBefore',
        'anAfter',
        'outletEntries',
        'globalScanData',
        'chatForWI',
        'maxContext',
        'useCustomChatForWI',
    ];

    for (const key of mutableKeys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            target[key] = source[key];
        }
    }
}

async function buildPresetAwareMessages(context, settings, systemPrompt, userPrompt, {
    api = '',
    promptPresetName = '',
    historyMessages = null,
    worldInfoMessages = null,
    runtimeWorldInfo = null,
    forceWorldInfoResimulate = false,
    worldInfoType = 'quiet',
    abortSignal = null,
} = {}) {
    const systemText = String(systemPrompt || '').trim() || 'Use tool calls only.';
    const userText = String(userPrompt || '').trim() || 'Use tool calls only.';
    const selectedPromptPresetName = String(promptPresetName || '').trim();
    const envelopeApi = selectedPromptPresetName ? 'openai' : (api || context.mainApi || 'openai');
    const includeWorldInfoWithPreset = settings?.includeWorldInfoWithPreset !== false;
    throwIfAborted(abortSignal, 'Search agent aborted.');
    let resolvedRuntimeWorldInfo = includeWorldInfoWithPreset
        ? ((!forceWorldInfoResimulate && hasEffectiveRuntimeWorldInfo(runtimeWorldInfo))
            ? normalizeRuntimeWorldInfo(runtimeWorldInfo)
            : null)
        : {};
    const resolverMessages = normalizeWorldInfoResolverMessages(worldInfoMessages);
    if (includeWorldInfoWithPreset && !resolvedRuntimeWorldInfo && typeof context?.resolveWorldInfoForMessages === 'function' && resolverMessages.length > 0) {
        resolvedRuntimeWorldInfo = await context.resolveWorldInfoForMessages(resolverMessages, {
            type: String(worldInfoType || 'quiet'),
            fallbackToCurrentChat: false,
            postActivationHook: rewriteDepthWorldInfoToAfter,
        });
        throwIfAborted(abortSignal, 'Search agent aborted.');
    } else if (includeWorldInfoWithPreset && resolvedRuntimeWorldInfo) {
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

    throwIfAborted(abortSignal, 'Search agent aborted.');
    const normalizedHistoryMessages = Array.isArray(historyMessages)
        ? historyMessages.map(message => ({ ...message }))
        : [];
    return context.buildPresetAwarePromptMessages({
        messages: [
            ...normalizedHistoryMessages,
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

function createAbortError(message = 'Operation aborted.') {
    try {
        return new DOMException(String(message || 'Operation aborted.'), 'AbortError');
    } catch {
        const error = new Error(String(message || 'Operation aborted.'));
        error.name = 'AbortError';
        return error;
    }
}

function throwIfAborted(signal, message = 'Operation aborted.') {
    if (isAbortSignalLike(signal) && signal.aborted) {
        throw createAbortError(message);
    }
}

function buildRecoverableToolErrorResult(error, fallbackMessage = 'Tool call failed.') {
    const message = normalizeWhitespace(error?.message || error || fallbackMessage) || fallbackMessage;
    return {
        ok: false,
        error: message,
    };
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
            throwIfAborted(abortSignal, 'Search agent aborted.');
            const responseData = await sendOpenAIRequest('quiet', promptMessages, isAbortSignalLike(abortSignal) ? abortSignal : null, {
                tools,
                toolChoice: 'auto',
                replaceTools: true,
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
                requestScope: 'extension_internal',
                functionCallOptions: {
                    protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
                },
            });
            throwIfAborted(abortSignal, 'Search agent aborted.');
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

async function ensureSharedLorebook(context, allowCreate = true) {
    const loaded = await context.loadWorldInfo(SHARED_LOREBOOK_NAME);
    if (loaded && typeof loaded === 'object') {
        return { bookName: SHARED_LOREBOOK_NAME, data: loaded, created: false };
    }

    if (!allowCreate) {
        return { bookName: SHARED_LOREBOOK_NAME, data: null, created: false };
    }

    await context.saveWorldInfo(SHARED_LOREBOOK_NAME, { entries: {} }, true);
    if (typeof context.updateWorldInfoList === 'function') {
        await context.updateWorldInfoList();
    }
    const created = await context.loadWorldInfo(SHARED_LOREBOOK_NAME);
    return {
        bookName: SHARED_LOREBOOK_NAME,
        data: created && typeof created === 'object' ? created : { entries: {} },
        created: true,
    };
}

async function refreshSharedLorebookVisibilityAndSelection(context, selected) {
    if (typeof context?.updateWorldInfoList === 'function') {
        await context.updateWorldInfoList();
    }

    if (typeof selected === 'boolean') {
        const changed = await setGlobalWorldInfoSelection(SHARED_LOREBOOK_NAME, selected, {
            refreshList: true,
            save: false,
        });
        if (changed) {
            await saveSettings();
        }
    }
}

async function loadLegacyManagedEntries(context) {
    const metadata = context.chatMetadata && typeof context.chatMetadata === 'object' ? context.chatMetadata : {};
    const existingName = String(metadata?.[CHAT_LOREBOOK_METADATA_KEY] || '').trim();
    if (!existingName || existingName === SHARED_LOREBOOK_NAME) {
        return [];
    }

    const loaded = await context.loadWorldInfo(existingName);
    if (!loaded || typeof loaded !== 'object') {
        return [];
    }

    return normalizeStoredManagedEntries(listManagedEntries(loaded));
}

function applyManagedEntriesToLorebook(data, settings, managedEntries = []) {
    if (!data || typeof data !== 'object') {
        throw new Error('Lorebook data is required.');
    }

    if (!data.entries || typeof data.entries !== 'object') {
        data.entries = {};
    }

    const normalizedEntries = normalizeStoredManagedEntries(managedEntries);
    const existingManagedEntries = listManagedEntries(data);
    const existingById = new Map(existingManagedEntries.map(entry => [entry.entryId, entry]));
    const existingRawById = new Map(existingManagedEntries.map(entry => [entry.entryId, data.entries[entry.uid]]));
    for (const entry of existingManagedEntries) {
        delete data.entries[entry.uid];
    }

    let nextUid = getNextLorebookUid(data.entries);
    for (const spec of normalizedEntries) {
        const existing = existingById.get(spec.entryId) || null;
        const uid = existing ? Number(existing.uid) : nextUid;
        data.entries[uid] = createManagedLorebookEntry(uid, {
            entryId: spec.entryId,
            title: spec.title,
            keywords: spec.keywords,
            content: spec.content,
            alwaysInject: spec.alwaysInject,
        }, settings, existing ? existingRawById.get(spec.entryId) || null : null);
        if (!existing) {
            nextUid += 1;
        }
    }
}

async function syncSharedLorebookForCurrentChat(context = getContext()) {
    const settings = getSettings();
    if (!shouldActivateSharedLorebook(settings)) {
        await refreshSharedLorebookVisibilityAndSelection(context, false);
        return { changed: false, bookName: SHARED_LOREBOOK_NAME };
    }

    const lorebook = await ensureSharedLorebook(context, true);
    const data = lorebook.data && typeof lorebook.data === 'object' ? structuredClone(lorebook.data) : { entries: {} };
    applyManagedEntriesToLorebook(data, settings, latestManagedEntries);
    await context.saveWorldInfo(SHARED_LOREBOOK_NAME, data, true);
    await refreshSharedLorebookVisibilityAndSelection(context, true);
    return { changed: true, bookName: SHARED_LOREBOOK_NAME };
}

async function syncSharedLorebookForLoadedChat(context = getContext()) {
    await loadSearchToolsChatState(context, { force: false });
    return syncSharedLorebookForCurrentChat(context);
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

    entry.position = normalizeLorebookPosition(settings.lorebookPosition);
    entry.depth = Number(settings.lorebookDepth);
    entry.role = Number(settings.lorebookRole);
    entry.order = Number(settings.lorebookEntryOrder);

    if (!existingEntry) {
        entry.disable = false;
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

function extractLastUserMessage(messages) {
    const source = Array.isArray(messages) ? messages : [];
    for (let i = source.length - 1; i >= 0; i -= 1) {
        if (source[i]?.is_user) {
            return { index: i, message: source[i] };
        }
    }
    return { index: -1, message: null };
}

function buildLastUserAnchorFromMessages(messages) {
    const { index, message } = extractLastUserMessage(messages);
    if (index < 0 || !message) {
        return null;
    }

    const text = String(message.mes ?? '');
    const playableFloor = normalizeAnchorPlayableFloor(messages
        .slice(0, index + 1)
        .reduce((count, item) => count + (item && !item.is_system ? 1 : 0), 0));
    return {
        floor: index + 1,
        playableFloor,
        hash: String(getStringHash(text)),
    };
}

function buildLastUserAnchor(context, payloadMessages) {
    const contextMessages = Array.isArray(context?.chat) ? context.chat : [];
    const contextAnchor = buildLastUserAnchorFromMessages(contextMessages);
    if (contextAnchor) {
        return contextAnchor;
    }

    return buildLastUserAnchorFromMessages(payloadMessages);
}

function canReuseLatestSearchAgentSnapshot(chatKey, anchor) {
    if (!latestSearchAgentSnapshot || typeof latestSearchAgentSnapshot !== 'object') {
        return false;
    }
    if (!anchor || typeof anchor !== 'object') {
        return false;
    }
    if (String(latestSearchAgentSnapshot.chatKey || '') !== String(chatKey || '')) {
        return false;
    }

    const storedFloor = Number(latestSearchAgentSnapshot.anchorFloor);
    const incomingFloor = Number(anchor.floor);
    const storedPlayableFloor = Number(latestSearchAgentSnapshot.anchorPlayableFloor);
    const incomingPlayableFloor = Number(anchor.playableFloor);
    const floorMatched = Number.isFinite(storedPlayableFloor) && Number.isFinite(incomingPlayableFloor)
        ? storedPlayableFloor === incomingPlayableFloor
        : storedFloor === incomingFloor;
    return floorMatched
        && String(latestSearchAgentSnapshot.anchorHash || '') === String(anchor.hash || '');
}

function buildSearchAgentStatusText(result, { reused = false } = {}) {
    const summary = result?.summary ? ` ${result.summary}` : '';
    const mutationCount = Math.max(0, Number(result?.mutationCount || 0));
    const managedEntryCount = Math.max(0, Number(result?.managedEntryCount || 0));
    if (reused) {
        return mutationCount
            ? i18n(`Search agent reused cached lorebook update (${mutationCount} changes, ${managedEntryCount} managed entries).${summary}`)
            : i18n(`Search agent reused cached result with no lorebook changes (${managedEntryCount} managed entries).${summary}`);
    }

    return mutationCount
        ? i18n(`Search agent updated lorebook (${mutationCount} changes, ${managedEntryCount} managed entries).${summary}`)
        : i18n(`Search agent finished with no lorebook changes (${managedEntryCount} managed entries).${summary}`);
}

async function storeCompletedSearchAgentSnapshot(context, anchor, result) {
    const chatKey = getChatKey(context);
    const anchorPlayableFloor = normalizeAnchorPlayableFloor(anchor?.playableFloor);
    const anchorHash = String(anchor?.hash || '').trim();
    const managedEntries = normalizeStoredManagedEntries(result?.managedEntries);
    if (!chatKey || !anchorPlayableFloor || !anchorHash) {
        latestSearchAgentSnapshot = null;
        latestManagedEntries = managedEntries;
        await persistSearchToolsChatState(context);
        return null;
    }

    const nextSnapshot = {
        anchorHash,
        updatedAt: new Date().toISOString(),
        summary: normalizeWhitespace(result?.summary || ''),
        mutationCount: Math.max(0, Math.floor(Number(result?.mutationCount || 0))),
        managedEntryCount: managedEntries.length,
        bookName: normalizeWhitespace(result?.bookName || ''),
        managedEntries,
    };
    const previousAnchors = getLoadedSearchHistoryAnchors(context);
    const removedAnchors = previousAnchors.filter(existingAnchor => existingAnchor > anchorPlayableFloor);
    if (removedAnchors.length > 0) {
        await deleteStoredSearchAgentAnchors(context, removedAnchors);
    }
    const ok = await persistStoredSearchAgentSnapshot(context, anchorPlayableFloor, nextSnapshot);
    if (!ok) {
        throw new Error(i18n('Failed to persist search agent snapshot.'));
    }
    const nextAnchors = normalizeSearchHistoryAnchors([
        ...previousAnchors.filter(existingAnchor => existingAnchor <= anchorPlayableFloor),
        anchorPlayableFloor,
    ]);
    setLoadedSearchHistoryIndex(chatKey, nextAnchors);
    latestSearchAgentSnapshot = materializeSearchAgentSnapshot(chatKey, anchorPlayableFloor, nextSnapshot);
    latestManagedEntries = managedEntries;
    await persistSearchToolsChatState(context);
    return latestSearchAgentSnapshot;
}

function getLatestSearchAgentEntry(context) {
    const chatKey = getChatKey(context);
    if (!latestSearchAgentSnapshot || typeof latestSearchAgentSnapshot !== 'object') {
        return null;
    }
    if (String(latestSearchAgentSnapshot.chatKey || '') !== String(chatKey || '')) {
        return null;
    }
    return {
        anchorPlayableFloor: normalizeAnchorPlayableFloor(latestSearchAgentSnapshot.anchorPlayableFloor),
        managedEntryCount: normalizeStoredManagedEntries(latestManagedEntries).length,
    };
}

function updateSearchHistoryStatusAfterInvalidation(context) {
    const entry = getLatestSearchAgentEntry(context);
    if (entry?.anchorPlayableFloor) {
        updateUiStatus(i18n(`Search history invalidated. Rolled back to user turn ${entry.anchorPlayableFloor}.`));
        return;
    }
    updateUiStatus(i18n('Search history invalidated. No valid stored result remains.'));
}

async function invalidateStoredSearchAgentAnchors(context, thresholdPlayableFloor = 0, { inclusive = true } = {}) {
    const chatKey = getChatKey(context);
    if (!chatKey) {
        latestSearchAgentSnapshot = null;
        latestSearchHistoryIndex = null;
        latestManagedEntries = [];
        await syncSharedLorebookForCurrentChat(context);
        return false;
    }

    const currentAnchors = getLoadedSearchHistoryAnchors(context);
    const normalizedThreshold = normalizeAnchorPlayableFloor(thresholdPlayableFloor);
    const removedAnchors = normalizedThreshold > 0
        ? currentAnchors.filter(anchorPlayableFloor => inclusive ? anchorPlayableFloor >= normalizedThreshold : anchorPlayableFloor > normalizedThreshold)
        : currentAnchors.slice();
    if (removedAnchors.length === 0) {
        return false;
    }

    await deleteStoredSearchAgentAnchors(context, removedAnchors);
    const nextAnchors = currentAnchors.filter(anchorPlayableFloor => !removedAnchors.includes(anchorPlayableFloor));
    setLoadedSearchHistoryIndex(chatKey, nextAnchors);
    await persistSearchToolsChatState(context);
    await selectLatestValidSearchAgentSnapshot(context, { persistCleanup: true });
    await syncSharedLorebookForCurrentChat(context);
    updateSearchHistoryStatusAfterInvalidation(context);
    return true;
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

function buildSearchAgentSystemPrompt(basePrompt, finalStagePrompt, { isFinalStage = false } = {}) {
    const normalizedBasePrompt = String(basePrompt || DEFAULT_AGENT_SYSTEM_PROMPT).trim() || DEFAULT_AGENT_SYSTEM_PROMPT;
    const normalizedFinalStagePrompt = String(finalStagePrompt || DEFAULT_AGENT_FINAL_STAGE_PROMPT).trim() || DEFAULT_AGENT_FINAL_STAGE_PROMPT;
    return isFinalStage ? normalizedFinalStagePrompt : normalizedBasePrompt;
}

function buildSearchAgentUserPrompt(payload, {
    roundIndex,
    maxRounds,
    bookName,
    managedEntries,
    isFinalStage = false,
} = {}) {
    const recentChat = buildRecentChatText(payload?.coreChat || []);
    const lastUserMessage = Array.isArray(payload?.coreChat)
        ? [...payload.coreChat].reverse().find(message => message?.is_user)
        : null;
    const userText = normalizeMultilineText(lastUserMessage?.mes || '');
    const allToolNames = Object.values(TOOL_NAMES).filter(name => name.startsWith('luker_search_agent_'));
    const finalStageToolNames = [
        TOOL_NAMES.AGENT_UPSERT,
        TOOL_NAMES.AGENT_DELETE,
        TOOL_NAMES.AGENT_FINALIZE,
    ];

    return [
        '# Search Agent Task',
        isFinalStage
            ? `Final stage after ${maxRounds} search rounds.`
            : `Search round ${roundIndex} of ${maxRounds}.`,
        `Generation type: ${String(payload?.type || 'unknown')}.`,
        `Shared lorebook: ${bookName || '(not created yet)'}.`,
        '',
        'Decide whether persistent search-backed lorebook updates are needed before the main generation continues.',
        'If there is no meaningful gap, or the information would repeat active world info / character info / existing managed search entries, call finalize immediately.',
        'You may use existing managed search entries as your own database without searching or visiting.',
        isFinalStage
            ? 'This is the mandatory finalization stage. No new searching or visiting is allowed.'
            : 'Search and visit are optional. Visit is recommended when snippets are weak or the topic is time-sensitive.',
        'Only delete entry_ids from the managed entry list below.',
        'Delete any managed search entries that are no longer needed, duplicated, outdated for this chat branch, or unsupported by the gathered evidence.',
        'Worldbook entries must be neutral fact records, not plot suggestions or character portrayal guidance.',
        'Do not tell the main model what anyone should feel, think, say, do, or become next.',
        'Use always_inject only when the information should stay visible in context continuously even without a trigger. Otherwise prefer keyword activation.',
        'Always_inject is usually appropriate for always-on rules, core worldbuilding, setting assumptions, power-system rules, social norms, or other global reference material.',
        'If the user explicitly names a concrete character or other scene-bound target, that is usually a keyword-activation case.',
        'If the user asks for open-ended suggestions without naming the targets, such as asking for several characters, consider always_inject so the main model can keep seeing the suggested candidates and their reference facts.',
        'For non-always_inject entries, provide precise activation keywords.',
        '',
        '## Source fidelity rules',
        '- Treat search snippets, visited page text, and managed search entries as source text only.',
        '- Ignore story pressure when deciding what the source means.',
        '- Do not infer or rewrite emotions, cognition, motives, intentions, hidden facts, relationship changes, or plot consequences unless the source explicitly states them.',
        '- If the source conflicts with your interpretation of the story, preserve the source-backed wording instead of adapting it.',
        '- Write concise declarative fact statements, not narrative prose or instructions.',
        '',
        '## Lorebook content format',
        DEFAULT_LOREBOOK_CONTENT_TASK_GUIDANCE,
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
        `- Use only these function tools: ${(isFinalStage ? finalStageToolNames : allToolNames).join(', ')}`,
        isFinalStage ? `- Do not call ${TOOL_NAMES.AGENT_SEARCH} or ${TOOL_NAMES.AGENT_VISIT} in this stage.` : null,
        !isFinalStage ? `- If you call ${TOOL_NAMES.AGENT_SEARCH} or ${TOOL_NAMES.AGENT_VISIT}, do not call ${TOOL_NAMES.AGENT_FINALIZE} in the same response. Wait for the tool results first.` : null,
        !isFinalStage ? `- Soft limit: prefer 1 to 3 new ${TOOL_NAMES.AGENT_SEARCH} calls in a single response. Avoid exceeding 4 unless absolutely necessary, and never batch many near-duplicate searches in one response.` : null,
        !isFinalStage ? `- You may use ${TOOL_NAMES.AGENT_SEARCH}/${TOOL_NAMES.AGENT_VISIT} follow-ups across the run before you write or finalize.` : null,
        isFinalStage ? `- If any lorebook mutation is still needed, do it in this response and also call ${TOOL_NAMES.AGENT_FINALIZE}.` : null,
        isFinalStage ? `- If no mutation is needed, call ${TOOL_NAMES.AGENT_FINALIZE} immediately.` : null,
        isFinalStage ? `- Before finalizing, delete any managed search entries that are unnecessary, duplicated, stale for the current chat branch, or not supported by the gathered evidence.` : null,
        isFinalStage ? `- End with ${TOOL_NAMES.AGENT_FINALIZE}.` : `- Call ${TOOL_NAMES.AGENT_FINALIZE} only when you are done with this run.`,
        '- Outside the single <thought>...</thought> block and tool calls, do not output plain prose.',
    ].filter(Boolean).join('\n');
}

function buildAgentTools() {
    return [
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.AGENT_SEARCH,
                description: 'Search the web for current information. Treat returned snippets as source text only; do not infer beyond them.',
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
                description: 'Visit one web page and read its text as source material. Do not invent claims beyond the visited text.',
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
                description: 'Create or update one managed search lorebook entry using only facts explicitly supported by managed search entries, search snippets, or visited page text. Entries must read like neutral reference notes, not plot guidance, characterization advice, or instructions for how the roleplay should continue. Do not infer emotions, cognition, motives, intentions, hidden facts, or plot consequences unless the source explicitly states them. Use always_inject only when the entry should stay visible continuously even without a trigger, such as always-on rules, core worldbuilding, setting assumptions, power-system rules, or open-ended inspiration/reference lists. Otherwise prefer keyword activation, especially when the user explicitly names a concrete character or other scene-bound target. Explicit entry_id matches first; otherwise exact normalized keyword match updates an existing managed entry.',
                parameters: {
                    type: 'object',
                    properties: {
                        entry_id: { type: 'string' },
                        title: { type: 'string' },
                        keywords: {
                            type: 'array',
                            description: 'Use precise activation keywords when always_inject is false. This is the default for concrete named targets or scenario-bound information.',
                            items: { type: 'string' },
                        },
                        content: { type: 'string' },
                        always_inject: {
                            type: 'boolean',
                            description: 'Set true only when the entry should remain visible in context continuously without a trigger, such as always-on rules, core worldbuilding, setting assumptions, power-system rules, or open-ended inspiration/reference lists. Otherwise leave false and rely on keywords.',
                        },
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
                description: `Finish the current search-agent run. Rejected if called in the same response as ${TOOL_NAMES.AGENT_SEARCH} or ${TOOL_NAMES.AGENT_VISIT}.`,
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
    if (String(bookName || '').trim() === SHARED_LOREBOOK_NAME) {
        await refreshSharedLorebookVisibilityAndSelection(context, shouldActivateSharedLorebook(getSettings()));
    }
    payload.requestRescan = true;
    if (typeof payload?.simulateWorldInfo === 'function') {
        const resolution = await payload.simulateWorldInfo();
        updatePayloadWorldInfoFromResolution(payload, resolution);
        return buildRuntimeWorldInfoFromPayload(resolution);
    }
    return buildRuntimeWorldInfoFromPayload(payload);
}

async function runPreRequestSearchAgent(context, settings, payload) {
    throwIfAborted(payload?.signal, 'Search agent aborted.');
    const resolvedApiPresetName = String(settings.agentApiPresetName || '').trim();
    const profileResolution = resolveChatCompletionRequestProfile({
        profileName: resolvedApiPresetName,
        defaultApi: String(context?.mainApi || 'openai').trim() || 'openai',
        defaultSource: String(context?.chatCompletionSettings?.chat_completion_source || ''),
    });
    const requestApi = profileResolution.requestApi;
    const apiSettingsOverride = profileResolution.apiSettingsOverride;
    const tools = buildAgentTools();
    const searchRoundCount = Math.max(1, Number(settings.agentMaxRounds) || DEFAULT_SETTINGS.agentMaxRounds);
    const finalStageTools = tools.filter((tool) => {
        const name = String(tool?.function?.name || '');
        return name !== TOOL_NAMES.AGENT_SEARCH && name !== TOOL_NAMES.AGENT_VISIT;
    });
    const allowedNames = tools.map(tool => tool?.function?.name).filter(Boolean);
    const finalStageAllowedNames = finalStageTools.map(tool => tool?.function?.name).filter(Boolean);
    const toolHistoryMessages = [];
    let internalRuntimeWorldInfo = buildRuntimeWorldInfoFromPayload(payload);
    let mutationCount = 0;
    let roundStoppedByFinalize = false;
    let lastSummary = '';
    let lorebookBookName = '';
    let lorebookData = null;

    let helperOnlyChainSteps = 0;
    for (let phaseIndex = 1; phaseIndex <= searchRoundCount + 1;) {
        if (payload?.signal?.aborted) {
            throw Object.assign(new Error('Search agent aborted.'), { name: 'AbortError' });
        }
        const isFinalStage = phaseIndex > searchRoundCount;

        if (!lorebookData && !lorebookBookName) {
            const lorebook = await ensureSharedLorebook(context, true);
            throwIfAborted(payload?.signal, 'Search agent aborted.');
            lorebookBookName = lorebook.bookName;
            lorebookData = lorebook.data && typeof lorebook.data === 'object' ? lorebook.data : null;
        }
        const managedEntries = listManagedEntries(lorebookData);
        const promptMessages = await buildPresetAwareMessages(
            context,
            settings,
            buildSearchAgentSystemPrompt(settings.agentSystemPrompt, settings.agentFinalStagePrompt, { isFinalStage }),
            buildSearchAgentUserPrompt(payload, {
                roundIndex: phaseIndex,
                maxRounds: searchRoundCount,
                bookName: lorebookBookName,
                managedEntries,
                isFinalStage,
            }),
            {
                api: requestApi,
                promptPresetName: String(settings.agentPresetName || '').trim(),
                historyMessages: toolHistoryMessages,
                worldInfoMessages: Array.isArray(payload?.coreChat) ? payload.coreChat : [],
                runtimeWorldInfo: internalRuntimeWorldInfo,
                forceWorldInfoResimulate: false,
                worldInfoType: 'quiet',
                abortSignal: payload?.signal || null,
            },
        );
        throwIfAborted(payload?.signal, 'Search agent aborted.');
        const requestMessages = promptMessages;
        const response = await requestToolCallsWithRetry(settings, requestMessages, {
            tools: isFinalStage ? finalStageTools : tools,
            allowedNames: isFinalStage ? finalStageAllowedNames : allowedNames,
            llmPresetName: String(settings.agentPresetName || '').trim(),
            apiSettingsOverride,
            abortSignal: payload?.signal || null,
        });
        throwIfAborted(payload?.signal, 'Search agent aborted.');
        const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
        // Fresh source text is only visible to the model on the next round, so same-response finalization must be rejected.
        const responseHasFreshSourceCalls = !isFinalStage && toolCalls.some((call) => {
            const callName = String(call?.name || '').trim();
            return callName === TOOL_NAMES.AGENT_SEARCH || callName === TOOL_NAMES.AGENT_VISIT;
        });

        const executedCalls = [];
        let lorebookDirty = false;
        let shouldFinalize = false;
        let hasSourceGatheringCalls = false;
        let hasLorebookMutationCalls = false;

        for (const call of toolCalls) {
            throwIfAborted(payload?.signal, 'Search agent aborted.');
            const callName = String(call?.name || '').trim();
            const args = call?.args && typeof call.args === 'object' ? call.args : {};
            let result = null;

            if (callName === TOOL_NAMES.AGENT_SEARCH) {
                hasSourceGatheringCalls = true;
                try {
                    result = await searchWeb(args, { abortSignal: payload?.signal || null });
                    throwIfAborted(payload?.signal, 'Search agent aborted.');
                } catch (error) {
                    if (isAbortError(error, payload?.signal || null)) {
                        throw error;
                    }
                    result = buildRecoverableToolErrorResult(error, 'Search tool failed.');
                }
            } else if (callName === TOOL_NAMES.AGENT_VISIT) {
                hasSourceGatheringCalls = true;
                try {
                    result = await visitWebPage(args, { abortSignal: payload?.signal || null });
                    throwIfAborted(payload?.signal, 'Search agent aborted.');
                } catch (error) {
                    if (isAbortError(error, payload?.signal || null)) {
                        throw error;
                    }
                    result = buildRecoverableToolErrorResult(error, 'Visit tool failed.');
                }
            } else if (callName === TOOL_NAMES.AGENT_UPSERT) {
                hasLorebookMutationCalls = true;
                if (!lorebookData) {
                    const createdLorebook = await ensureSharedLorebook(context, true);
                    throwIfAborted(payload?.signal, 'Search agent aborted.');
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
                hasLorebookMutationCalls = true;
                result = deleteManagedEntries(lorebookData, args?.entry_ids || []);
                lorebookDirty = lorebookDirty || Boolean(result?.changed);
                if (result?.changed) {
                    mutationCount += Number(result.deleted?.length || 0);
                }
            } else if (callName === TOOL_NAMES.AGENT_FINALIZE) {
                if (responseHasFreshSourceCalls) {
                    result = buildRecoverableToolErrorResult(
                        new Error(`Cannot call ${TOOL_NAMES.AGENT_FINALIZE} in the same response as ${TOOL_NAMES.AGENT_SEARCH} or ${TOOL_NAMES.AGENT_VISIT}. Wait for those tool results first.`),
                        'Finalize rejected.',
                    );
                } else {
                    lastSummary = normalizeWhitespace(args?.summary || '');
                    result = {
                        done: true,
                        summary: lastSummary,
                    };
                    shouldFinalize = true;
                }
            }

            executedCalls.push({
                ...call,
                result,
            });
        }

        if (lorebookDirty && lorebookBookName && lorebookData) {
            throwIfAborted(payload?.signal, 'Search agent aborted.');
            internalRuntimeWorldInfo = await flushLorebookChanges(context, payload, lorebookBookName, lorebookData);
            throwIfAborted(payload?.signal, 'Search agent aborted.');
        }

        appendStandardToolRoundMessages(toolHistoryMessages, executedCalls, response.assistantText || '');

        if (shouldFinalize) {
            roundStoppedByFinalize = true;
            break;
        }

        if (!isFinalStage && hasSourceGatheringCalls && !hasLorebookMutationCalls) {
            helperOnlyChainSteps += 1;
            if (helperOnlyChainSteps >= AGENT_TOOL_CHAIN_HARD_LIMIT) {
                console.warn(`[${MODULE_NAME}] Search agent helper chain exceeded internal safety limit (${AGENT_TOOL_CHAIN_HARD_LIMIT}). Forcing final stage.`);
                phaseIndex = searchRoundCount + 1;
            }
            continue;
        }

        helperOnlyChainSteps = 0;
        phaseIndex += 1;
    }

    const finalLorebook = lorebookData
        ? { bookName: lorebookBookName, data: lorebookData }
        : await ensureSharedLorebook(context, true);
    throwIfAborted(payload?.signal, 'Search agent aborted.');
    const finalManagedEntries = finalLorebook?.data ? listManagedEntries(finalLorebook.data) : [];
    const normalizedManagedEntries = normalizeStoredManagedEntries(finalManagedEntries);
    latestManagedEntries = normalizedManagedEntries;
    return {
        mutationCount,
        finalized: roundStoppedByFinalize,
        summary: lastSummary,
        bookName: finalLorebook?.bookName || '',
        managedEntryCount: finalManagedEntries.length,
        managedEntries: normalizedManagedEntries,
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

    await loadSearchToolsChatState(context, { force: false });
    await syncSharedLorebookForCurrentChat(context);
    const chatKey = getChatKey(context);
    const generationType = String(payload?.type || '').trim().toLowerCase();
    const anchor = buildLastUserAnchor(context, payload.coreChat);
    if (REUSE_GENERATION_TYPES.has(generationType) && canReuseLatestSearchAgentSnapshot(chatKey, anchor)) {
        updateUiStatus(buildSearchAgentStatusText(latestSearchAgentSnapshot, { reused: true }));
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
    let stopRequestedByUser = false;
    let resolveStopRequest = null;
    const stopRequestPromise = new Promise((resolve) => {
        resolveStopRequest = () => {
            if (stopRequestedByUser) {
                return;
            }
            stopRequestedByUser = true;
            if (!pluginAbortController.signal.aborted) {
                pluginAbortController.abort();
            }
            resolve({ stopped: true });
        };
    });

    updateUiStatus(i18n('Search agent running...'));
    showAgentRunInfoToast(i18n('Search agent running...'), {
        stopLabel: i18n('Stop'),
        onStop: () => {
            resolveStopRequest?.();
        },
    });

    try {
        const agentTask = runPreRequestSearchAgent(context, settings, effectivePayload);
        void agentTask.catch((error) => {
            if (!stopRequestedByUser) {
                return;
            }
            if (!isAbortError(error, effectivePayload?.signal || null)) {
                console.warn(`[${MODULE_NAME}] Search agent finished after user stop`, error);
            }
        });
        const raced = await Promise.race([
            agentTask.then(result => ({ stopped: false, result })),
            stopRequestPromise,
        ]);
        if (raced?.stopped) {
            syncMutableGenerationPayloadState(payload, effectivePayload);
            updateUiStatus(i18n('Search agent aborted.'));
            return;
        }
        syncMutableGenerationPayloadState(payload, effectivePayload);
        const result = raced?.result;
        if (runToken !== activeAgentRunToken) {
            return;
        }
        await storeCompletedSearchAgentSnapshot(context, anchor, result);
        updateUiStatus(buildSearchAgentStatusText(result));
    } catch (error) {
        syncMutableGenerationPayloadState(payload, effectivePayload);
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

async function onMessageDeleted(_chatLength, details) {
    const context = getContext();
    await loadSearchToolsChatState(context, { force: false });
    const deletedPlayableFrom = normalizeAnchorPlayableFloor(details?.deletedPlayableSeqFrom);
    const deletedPlayableTo = normalizeAnchorPlayableFloor(details?.deletedPlayableSeqTo);
    const deletedAssistantFrom = Math.max(0, Math.floor(Number(details?.deletedAssistantSeqFrom) || 0));
    const deletedAssistantTo = Math.max(0, Math.floor(Number(details?.deletedAssistantSeqTo) || 0));
    const deletedPlayableCount = deletedPlayableFrom > 0 && deletedPlayableTo >= deletedPlayableFrom
        ? (deletedPlayableTo - deletedPlayableFrom + 1)
        : 0;
    const deletedAssistantCount = deletedAssistantFrom > 0 && deletedAssistantTo >= deletedAssistantFrom
        ? (deletedAssistantTo - deletedAssistantFrom + 1)
        : 0;
    const deletedUserCount = Math.max(deletedPlayableCount - deletedAssistantCount, 0);

    if (!deletedPlayableCount && !deletedAssistantCount) {
        await invalidateStoredSearchAgentAnchors(context, 0, { inclusive: true });
        return;
    }
    if (deletedUserCount > 0 && deletedPlayableFrom > 0) {
        await invalidateStoredSearchAgentAnchors(context, deletedPlayableFrom, { inclusive: true });
        return;
    }
    if (deletedPlayableTo > 0) {
        await invalidateStoredSearchAgentAnchors(context, deletedPlayableTo, { inclusive: false });
        return;
    }
}

function renderSearchProviderOptions(selectedProvider = '') {
    const selected = normalizeProvider(selectedProvider);
    return getAvailableSearchProviders()
        .map(provider => `<option value="${escapeHtml(provider.id)}"${provider.id === selected ? ' selected' : ''}>${escapeHtml(i18n(provider.label))}</option>`)
        .join('');
}

function renderSafeSearchOptions(selectedValue = '') {
    const selected = normalizeSafeSearch(selectedValue);
    const options = [
        ['off', 'Off'],
        ['moderate', 'Moderate'],
        ['strict', 'Strict'],
    ];
    return options
        .map(([value, label]) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(i18n(label))}</option>`)
        .join('');
}

function buildProviderSettingsPanelHtml(settings = getSettings()) {
    const providerId = normalizeProvider(settings.provider);
    if (providerId === 'ddg') {
        const providerSettings = getProviderSettings(settings, providerId);
        return `
        <label for="search_tools_ddg_safe_search">${escapeHtml(i18n('Default safe search'))}</label>
        <select id="search_tools_ddg_safe_search" class="text_pole">
            ${renderSafeSearchOptions(providerSettings.safeSearch)}
        </select>`;
    }
    if (providerId === 'searxng') {
        const providerSettings = getProviderSettings(settings, providerId);
        return `
        <label for="search_tools_searxng_base_url">${escapeHtml(i18n('SearXNG instance URL'))}</label>
        <input id="search_tools_searxng_base_url" class="text_pole" type="text" placeholder="https://your-searxng.example" value="${escapeHtml(providerSettings.baseUrl || '')}" />
        <label for="search_tools_searxng_safe_search">${escapeHtml(i18n('Default safe search'))}</label>
        <select id="search_tools_searxng_safe_search" class="text_pole">
            ${renderSafeSearchOptions(providerSettings.safeSearch)}
        </select>`;
    }
    if (providerId === 'brave') {
        const providerSettings = getProviderSettings(settings, providerId);
        const hasApiKey = hasConfiguredSecret(SECRET_KEYS.BRAVE_SEARCH);
        return `
        <label>${escapeHtml(i18n('Brave API key'))}</label>
        <div class="flex-container alignitemscenter">
            <span class="text_muted">${escapeHtml(i18n(hasApiKey ? 'Configured' : 'Not configured'))}</span>
            <div class="menu_button menu_button_small manage-api-keys" data-key="${escapeHtml(SECRET_KEYS.BRAVE_SEARCH)}">${escapeHtml(i18n('Manage API key'))}</div>
        </div>
        <label for="search_tools_brave_safe_search">${escapeHtml(i18n('Default safe search'))}</label>
        <select id="search_tools_brave_safe_search" class="text_pole">
            ${renderSafeSearchOptions(providerSettings.safeSearch)}
        </select>`;
    }

    return '';
}

function refreshProviderSettingsUi(root, settings = getSettings()) {
    root.find('#search_tools_provider').html(renderSearchProviderOptions(settings.provider));
    root.find('#search_tools_provider_settings').html(buildProviderSettingsPanelHtml(settings));
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
        <select id="search_tools_provider" class="text_pole"></select>
        <div id="search_tools_provider_settings"></div>
        <label for="search_tools_default_max_results">${escapeHtml(i18n('Default max search results'))}</label>
        <input id="search_tools_default_max_results" class="text_pole" type="number" min="1" max="20" step="1" />
        <label for="search_tools_default_visit_max_chars">${escapeHtml(i18n('Default page excerpt max chars (0 = no truncation)'))}</label>
        <input id="search_tools_default_visit_max_chars" class="text_pole" type="number" min="0" max="50000" step="100" />
        <label for="search_tools_agent_api_preset_name">${escapeHtml(i18n('Agent API preset (Connection profile, empty = current)'))}</label>
        <select id="search_tools_agent_api_preset_name" class="text_pole"></select>
        <label for="search_tools_agent_preset_name">${escapeHtml(i18n('Agent preset (params + prompt, empty = current)'))}</label>
        <select id="search_tools_agent_preset_name" class="text_pole"></select>
        <label class="checkbox_label">
            <input id="search_tools_include_world_info_with_preset" type="checkbox" />
            ${escapeHtml(i18n('Include world info'))}
        </label>
        <label for="search_tools_agent_max_rounds">${escapeHtml(i18n('Agent max rounds'))}</label>
        <input id="search_tools_agent_max_rounds" class="text_pole" type="number" min="1" max="8" step="1" />
        <label for="search_tools_tool_call_retry_max">${escapeHtml(i18n('Tool call retry count'))}</label>
        <input id="search_tools_tool_call_retry_max" class="text_pole" type="number" min="0" max="5" step="1" />
        <label for="search_tools_lorebook_position">${escapeHtml(i18n('Injection position'))}</label>
        <select id="search_tools_lorebook_position" class="text_pole">
            <option value="${world_info_position.before}">${escapeHtml(i18n('Before Character Definitions'))}</option>
            <option value="${world_info_position.after}">${escapeHtml(i18n('After Character Definitions'))}</option>
            <option value="${world_info_position.ANTop}">${escapeHtml(i18n("Before Author's Note"))}</option>
            <option value="${world_info_position.ANBottom}">${escapeHtml(i18n("After Author's Note"))}</option>
            <option value="${world_info_position.EMTop}">${escapeHtml(i18n('Before Example Messages'))}</option>
            <option value="${world_info_position.EMBottom}">${escapeHtml(i18n('After Example Messages'))}</option>
            <option value="${world_info_position.atDepth}">${escapeHtml(i18n('At Chat Depth'))}</option>
        </select>
        <label for="search_tools_lorebook_depth">${escapeHtml(i18n('Injection depth (At Chat Depth only)'))}</label>
        <input id="search_tools_lorebook_depth" class="text_pole" type="number" min="0" max="9999" step="1" />
        <label for="search_tools_lorebook_role">${escapeHtml(i18n('Injection role (At Chat Depth only)'))}</label>
        <select id="search_tools_lorebook_role" class="text_pole">
            <option value="${extension_prompt_roles.SYSTEM}">${escapeHtml(i18n('System'))}</option>
            <option value="${extension_prompt_roles.USER}">${escapeHtml(i18n('User'))}</option>
            <option value="${extension_prompt_roles.ASSISTANT}">${escapeHtml(i18n('Assistant'))}</option>
        </select>
        <label for="search_tools_lorebook_entry_order">${escapeHtml(i18n('Injection order'))}</label>
        <input id="search_tools_lorebook_entry_order" class="text_pole" type="number" min="0" max="20000" step="1" />
        <label for="search_tools_agent_system_prompt">${escapeHtml(i18n('Search-stage agent system prompt'))}</label>
        <textarea id="search_tools_agent_system_prompt" class="text_pole" rows="12"></textarea>
        <label for="search_tools_agent_final_stage_prompt">${escapeHtml(i18n('Final-stage agent system prompt'))}</label>
        <textarea id="search_tools_agent_final_stage_prompt" class="text_pole" rows="12"></textarea>
        <div class="flex-container">
            <div id="search_tools_reset_agent_prompt" class="menu_button menu_button_small">${escapeHtml(i18n('Reset search-stage agent prompt'))}</div>
            <div id="search_tools_reset_agent_final_stage_prompt" class="menu_button menu_button_small">${escapeHtml(i18n('Reset final-stage agent prompt'))}</div>
        </div>
        <div id="${STATUS_ID}" class="wide100p text_muted" style="margin-top: 8px;"></div>
    </div>
</div>`;
}

function ensureStyles() {
    if (jQuery(`#${STYLE_ID}`).length) {
        return;
    }

    jQuery('head').append(`
<style id="${STYLE_ID}">
#${UI_BLOCK_ID} .menu_button,
#${UI_BLOCK_ID} .menu_button_small {
    display: inline-flex;
    width: auto;
    min-width: max-content;
    white-space: nowrap;
    word-break: keep-all;
    writing-mode: horizontal-tb;
    text-orientation: mixed;
    align-items: center;
    justify-content: center;
}
</style>`);
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
        const lorebook = await ensureSharedLorebook(context, false);
        const entryCount = lorebook?.data ? listManagedEntries(lorebook.data).length : 0;
        if (!lorebook?.bookName) {
            updateUiStatus(i18n('No shared search lorebook yet.'));
            return;
        }
        updateUiStatus(i18n(`Shared lorebook: ${lorebook.bookName} | Managed search entries: ${entryCount}`));
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to refresh UI status`, error);
        updateUiStatus(i18n('Failed to inspect shared search lorebook.'));
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
    refreshProviderSettingsUi(root, settings);
    root.find('#search_tools_enabled').prop('checked', Boolean(settings.enabled));
    root.find('#search_tools_pre_request_enabled').prop('checked', Boolean(settings.preRequestEnabled));
    root.find('#search_tools_provider').val(String(settings.provider || 'ddg'));
    root.find('#search_tools_default_max_results').val(String(settings.defaultMaxResults));
    root.find('#search_tools_default_visit_max_chars').val(String(settings.defaultVisitMaxChars));
    root.find('#search_tools_agent_api_preset_name').val(String(settings.agentApiPresetName || ''));
    root.find('#search_tools_agent_preset_name').val(String(settings.agentPresetName || ''));
    root.find('#search_tools_include_world_info_with_preset').prop('checked', Boolean(settings.includeWorldInfoWithPreset));
    root.find('#search_tools_agent_max_rounds').val(String(settings.agentMaxRounds));
    root.find('#search_tools_tool_call_retry_max').val(String(settings.toolCallRetryMax));
    root.find('#search_tools_lorebook_position').val(String(settings.lorebookPosition));
    root.find('#search_tools_lorebook_depth').val(String(settings.lorebookDepth));
    root.find('#search_tools_lorebook_role').val(String(settings.lorebookRole));
    root.find('#search_tools_lorebook_entry_order').val(String(settings.lorebookEntryOrder));
    root.find('#search_tools_agent_system_prompt').val(String(settings.agentSystemPrompt || DEFAULT_SETTINGS.agentSystemPrompt));
    root.find('#search_tools_agent_final_stage_prompt').val(String(settings.agentFinalStagePrompt || DEFAULT_SETTINGS.agentFinalStagePrompt));

    root.off('.searchTools');
    root.on('input.searchTools', '#search_tools_enabled', function () {
        settings.enabled = Boolean(jQuery(this).prop('checked'));
        void syncSharedLorebookForCurrentChat(getContext());
        saveSettingsDebounced();
    });
    root.on('input.searchTools', '#search_tools_pre_request_enabled', function () {
        settings.preRequestEnabled = Boolean(jQuery(this).prop('checked'));
        void syncSharedLorebookForCurrentChat(getContext());
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_provider', function () {
        settings.provider = normalizeProvider(jQuery(this).val());
        refreshProviderSettingsUi(root, settings);
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
    root.on('change.searchTools', '#search_tools_ddg_safe_search', function () {
        settings.providers.ddg.safeSearch = normalizeSafeSearch(jQuery(this).val());
        settings.safeSearch = settings.providers.ddg.safeSearch;
        saveSettingsDebounced();
    });
    root.on('change.searchTools input.searchTools', '#search_tools_searxng_base_url', function () {
        settings.providers.searxng.baseUrl = normalizeWhitespace(jQuery(this).val());
        jQuery(this).val(settings.providers.searxng.baseUrl);
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_searxng_safe_search', function () {
        settings.providers.searxng.safeSearch = normalizeSafeSearch(jQuery(this).val());
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_brave_safe_search', function () {
        settings.providers.brave.safeSearch = normalizeSafeSearch(jQuery(this).val());
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
    root.on('input.searchTools', '#search_tools_include_world_info_with_preset', function () {
        settings.includeWorldInfoWithPreset = Boolean(jQuery(this).prop('checked'));
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
    root.on('change.searchTools', '#search_tools_lorebook_position', function () {
        settings.lorebookPosition = normalizeLorebookPosition(jQuery(this).val());
        jQuery(this).val(String(settings.lorebookPosition));
        void syncSharedLorebookForLoadedChat(getContext());
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_lorebook_depth', function () {
        settings.lorebookDepth = clampInteger(jQuery(this).val(), 0, 9999, DEFAULT_SETTINGS.lorebookDepth);
        jQuery(this).val(String(settings.lorebookDepth));
        void syncSharedLorebookForLoadedChat(getContext());
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_lorebook_role', function () {
        settings.lorebookRole = normalizeLorebookRole(jQuery(this).val());
        jQuery(this).val(String(settings.lorebookRole));
        void syncSharedLorebookForLoadedChat(getContext());
        saveSettingsDebounced();
    });
    root.on('change.searchTools', '#search_tools_lorebook_entry_order', function () {
        settings.lorebookEntryOrder = clampInteger(jQuery(this).val(), 0, 20000, DEFAULT_SETTINGS.lorebookEntryOrder);
        jQuery(this).val(String(settings.lorebookEntryOrder));
        void syncSharedLorebookForLoadedChat(getContext());
        saveSettingsDebounced();
    });
    root.on('change.searchTools input.searchTools', '#search_tools_agent_system_prompt', function () {
        settings.agentSystemPrompt = String(jQuery(this).val() || '').trim() || DEFAULT_SETTINGS.agentSystemPrompt;
        saveSettingsDebounced();
    });
    root.on('change.searchTools input.searchTools', '#search_tools_agent_final_stage_prompt', function () {
        settings.agentFinalStagePrompt = String(jQuery(this).val() || '').trim() || DEFAULT_SETTINGS.agentFinalStagePrompt;
        saveSettingsDebounced();
    });
    root.on('click.searchTools', '#search_tools_reset_agent_prompt', function () {
        if (!window.confirm(i18n('Reset search-stage agent prompt to default? This will overwrite the current search-stage system prompt.'))) {
            return;
        }
        settings.agentSystemPrompt = DEFAULT_SETTINGS.agentSystemPrompt;
        root.find('#search_tools_agent_system_prompt').val(settings.agentSystemPrompt);
        saveSettingsDebounced();
        if (typeof toastr !== 'undefined') {
            toastr.success(i18n('Reset search-stage agent prompt'));
        }
    });
    root.on('click.searchTools', '#search_tools_reset_agent_final_stage_prompt', function () {
        if (!window.confirm(i18n('Reset final-stage agent prompt to default? This will overwrite the current final-stage system prompt.'))) {
            return;
        }
        settings.agentFinalStagePrompt = DEFAULT_SETTINGS.agentFinalStagePrompt;
        root.find('#search_tools_agent_final_stage_prompt').val(settings.agentFinalStagePrompt);
        saveSettingsDebounced();
        if (typeof toastr !== 'undefined') {
            toastr.success(i18n('Reset final-stage agent prompt'));
        }
    });
}

function ensureUi() {
    const host = jQuery('#extensions_settings2');
    if (!host.length) {
        return;
    }

    ensureStyles();

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
        'SearXNG (custom instance)': 'SearXNG（自定义实例）',
        'Brave Search (API key)': 'Brave Search（API Key）',
        'SearXNG instance URL': 'SearXNG 实例地址',
        'Brave API key': 'Brave API Key',
        'Configured': '已配置',
        'Not configured': '未配置',
        'Manage API key': '管理 API Key',
        'Default max search results': '默认搜索结果上限',
        'Default safe search': '默认安全搜索',
        'Off': '关闭',
        'Moderate': '中等',
        'Strict': '严格',
        'Default page excerpt max chars (0 = no truncation)': '默认网页摘录最大字符数（0=不截断）',
        'Agent API preset (Connection profile, empty = current)': 'Agent API 预设（连接配置，留空=当前）',
        'Agent preset (params + prompt, empty = current)': 'Agent 预设（参数+提示词，留空=当前）',
        'Include world info': '包含世界书信息',
        'Agent max rounds': 'Agent 最大轮数',
        'Tool call retry count': '工具调用重试次数',
        'Injection position': '注入位置',
        'Before Character Definitions': '角色定义前',
        'After Character Definitions': '角色定义后',
        "Before Author's Note": '作者注释前',
        "After Author's Note": '作者注释后',
        'Before Example Messages': '示例消息前',
        'After Example Messages': '示例消息后',
        'At Chat Depth': '聊天深度',
        'Injection depth (At Chat Depth only)': '注入深度（仅聊天深度位置）',
        'Injection role (At Chat Depth only)': '注入角色（仅聊天深度位置）',
        'Injection order': '注入顺序',
        'Search-stage agent system prompt': '搜索阶段 Agent 系统提示词',
        'Final-stage agent system prompt': '最终阶段 Agent 系统提示词',
        'Reset search-stage agent prompt': '重置搜索阶段 Agent 提示词',
        'Reset final-stage agent prompt': '重置最终阶段 Agent 提示词',
        'Reset search-stage agent prompt to default? This will overwrite the current search-stage system prompt.': '确认重置搜索阶段 Agent 提示词为默认值？这会覆盖当前搜索阶段系统提示词。',
        'Reset final-stage agent prompt to default? This will overwrite the current final-stage system prompt.': '确认重置最终阶段 Agent 提示词为默认值？这会覆盖当前最终阶段系统提示词。',
        'System': '系统',
        'User': '用户',
        'Assistant': '助手',
        'Stop': '终止',
        'Search agent running...': '搜索 Agent 运行中...',
        'Search agent aborted.': '搜索 Agent 已中止。',
        'Search agent failed. Check console for details.': '搜索 Agent 失败，请查看控制台。',
        'No active chat.': '当前没有激活聊天。',
        'No shared search lorebook yet.': '当前还没有共享搜索世界书。',
        'Failed to inspect shared search lorebook.': '检查共享搜索世界书失败。',
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
        'SearXNG (custom instance)': 'SearXNG（自訂實例）',
        'Brave Search (API key)': 'Brave Search（API Key）',
        'SearXNG instance URL': 'SearXNG 實例網址',
        'Brave API key': 'Brave API Key',
        'Configured': '已設定',
        'Not configured': '未設定',
        'Manage API key': '管理 API Key',
        'Default max search results': '預設搜尋結果上限',
        'Default safe search': '預設安全搜尋',
        'Off': '關閉',
        'Moderate': '中等',
        'Strict': '嚴格',
        'Default page excerpt max chars (0 = no truncation)': '預設網頁摘錄最大字元數（0=不截斷）',
        'Agent API preset (Connection profile, empty = current)': 'Agent API 預設（連線設定，留空=目前）',
        'Agent preset (params + prompt, empty = current)': 'Agent 預設（參數+提示詞，留空=目前）',
        'Include world info': '包含世界書資訊',
        'Agent max rounds': 'Agent 最大輪數',
        'Tool call retry count': '工具呼叫重試次數',
        'Injection position': '注入位置',
        'Before Character Definitions': '角色定義前',
        'After Character Definitions': '角色定義後',
        "Before Author's Note": '作者註釋前',
        "After Author's Note": '作者註釋後',
        'Before Example Messages': '示例訊息前',
        'After Example Messages': '示例訊息後',
        'At Chat Depth': '聊天深度',
        'Injection depth (At Chat Depth only)': '注入深度（僅聊天深度位置）',
        'Injection role (At Chat Depth only)': '注入角色（僅聊天深度位置）',
        'Injection order': '注入順序',
        'Search-stage agent system prompt': '搜尋階段 Agent 系統提示詞',
        'Final-stage agent system prompt': '最終階段 Agent 系統提示詞',
        'Reset search-stage agent prompt': '重置搜尋階段 Agent 提示詞',
        'Reset final-stage agent prompt': '重置最終階段 Agent 提示詞',
        'Reset search-stage agent prompt to default? This will overwrite the current search-stage system prompt.': '確認重置搜尋階段 Agent 提示詞為預設值？這會覆蓋目前搜尋階段系統提示詞。',
        'Reset final-stage agent prompt to default? This will overwrite the current final-stage system prompt.': '確認重置最終階段 Agent 提示詞為預設值？這會覆蓋目前最終階段系統提示詞。',
        'System': '系統',
        'User': '使用者',
        'Assistant': '助手',
        'Stop': '終止',
        'Search agent running...': '搜尋 Agent 執行中...',
        'Search agent aborted.': '搜尋 Agent 已中止。',
        'Search agent failed. Check console for details.': '搜尋 Agent 失敗，請查看主控台。',
        'No active chat.': '目前沒有啟用聊天。',
        'No shared search lorebook yet.': '目前還沒有共享搜尋世界書。',
        'Failed to inspect shared search lorebook.': '檢查共享搜尋世界書失敗。',
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
    void loadSearchToolsChatState(context, { force: true })
        .then(() => syncSharedLorebookForCurrentChat(context))
        .finally(() => refreshUiStatusForCurrentChat());

    const wiAfterEvent = context?.eventTypes?.GENERATION_AFTER_WORLD_INFO_SCAN;
    if (wiAfterEvent) {
        context.eventSource.on(wiAfterEvent, async (payload) => {
            await maybeRunPreRequestSearchAgent(payload);
        });
    }

    if (context?.eventTypes?.MESSAGE_DELETED) {
        context.eventSource.on(context.eventTypes.MESSAGE_DELETED, onMessageDeleted);
    }

    if (context?.eventTypes?.CHAT_CHANGED) {
        context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
            abortActiveSearchAgentRun();
            loadedChatStateKey = '';
            latestSearchAgentSnapshot = null;
            latestSearchHistoryIndex = null;
            latestManagedEntries = [];
            const liveContext = getContext();
            void loadSearchToolsChatState(liveContext, { force: true })
                .then(() => syncSharedLorebookForCurrentChat(liveContext))
                .catch((error) => {
                    console.warn(`[${MODULE_NAME}] Failed to reload search chat state on chat change`, error);
                    return syncSharedLorebookForCurrentChat(liveContext);
                })
                .finally(() => refreshUiStatusForCurrentChat());
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

    const secretEvents = [
        event_types.SECRET_WRITTEN,
        event_types.SECRET_DELETED,
        event_types.SECRET_ROTATED,
    ];
    for (const eventName of secretEvents) {
        eventSource.on(eventName, (key) => {
            if (key === SECRET_KEYS.BRAVE_SEARCH) {
                ensureUi();
            }
        });
    }
});
