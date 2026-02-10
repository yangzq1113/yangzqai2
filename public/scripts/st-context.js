import {
    activateSendButtons,
    addOneMessage,
    appendMediaToMessage,
    callPopup,
    characters,
    chat,
    chat_metadata,
    CONNECT_API_MAP,
    create_save,
    deactivateSendButtons,
    event_types,
    eventSource,
    extension_prompts,
    extractMessageFromData,
    Generate,
    generateQuietPrompt,
    getCharacters,
    getCurrentChatId,
    getRequestHeaders,
    getThumbnailUrl,
    main_api,
    max_context,
    menu_type,
    messageFormatting,
    name1,
    name2,
    online_status,
    openCharacterChat,
    reloadCurrentChat,
    renameChat,
    saveChatConditional,
    saveMetadata,
    saveReply,
    saveSettingsDebounced,
    selectCharacterById,
    sendGenerationRequest,
    sendStreamingRequest,
    sendSystemMessage,
    setExtensionPrompt,
    stopGeneration,
    streamingProcessor,
    substituteParams,
    substituteParamsExtended,
    this_chid,
    updateChatMetadata,
    updateMessageBlock,
    printMessages,
    clearChat,
    unshallowCharacter,
    deleteLastMessage,
    getCharacterCardFields,
    buildWorldInfoChatInput,
    buildWorldInfoGlobalScanData,
    simulateWorldInfoActivation,
    appendChatMessages,
    patchChatMessages,
    saveChatMetadata,
    getChatState,
    patchChatState,
    deleteChatState,
    swipe_right,
    swipe_left,
    generateRaw,
    showSwipeButtons,
    hideSwipeButtons,
    deleteMessage,
    refreshSwipeButtons,
    swipe,
    isSwipingAllowed,
    swipeState,
    ensureMessageMediaIsArray,
    getMediaDisplay,
    getMediaIndex,
    scrollChatToBottom,
    scrollOnMediaLoad,
    getOneCharacter,
} from '../script.js';
import {
    extension_settings,
    ModuleWorkerWrapper,
    openThirdPartyExtensionMenu,
    renderExtensionTemplate,
    renderExtensionTemplateAsync,
    saveMetadataDebounced,
    writeExtensionField,
} from './extensions.js';
import { groups, openGroupChat, selected_group, unshallowGroupMembers } from './group-chats.js';
import { addLocaleData, getCurrentLocale, t, translate } from './i18n.js';
import { hideLoader, showLoader } from './loader.js';
import { MacrosParser } from './macros.js';
import { getChatCompletionModel, oai_settings } from './openai.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { power_user, registerDebugFunction } from './power-user.js';
import { getPresetManager } from './preset-manager.js';
import { humanizedDateTime, isMobile, shouldSendOnEnter } from './RossAscends-mods.js';
import { ScraperManager } from './scrapers.js';
import { executeSlashCommands, executeSlashCommandsWithOptions, registerSlashCommand } from './slash-commands.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { tag_map, tags } from './tags.js';
import { getTextGenServer, textgenerationwebui_settings } from './textgen-settings.js';
import { tokenizers, getTextTokens, getTokenCount, getTokenCountAsync, getTokenizerModel } from './tokenizers.js';
import { ToolManager } from './tool-calling.js';
import { accountStorage } from './util/AccountStorage.js';
import { timestampToMoment, uuidv4 } from './utils.js';
import { addGlobalVariable, addLocalVariable, decrementGlobalVariable, decrementLocalVariable, deleteGlobalVariable, deleteLocalVariable, getGlobalVariable, getLocalVariable, incrementGlobalVariable, incrementLocalVariable, setGlobalVariable, setLocalVariable } from './variables.js';
import { convertCharacterBook, getWorldInfoPrompt, loadWorldInfo, reloadEditor, saveWorldInfo, updateWorldInfoList } from './world-info.js';
import { ChatCompletionService, TextCompletionService } from './custom-request.js';
import { ConnectionManagerRequestService } from './extensions/shared.js';
import { updateReasoningUI, parseReasoningFromString, getReasoningTemplateByName } from './reasoning.js';
import { IGNORE_SYMBOL } from './constants.js';
import { macros } from './macros/macro-system.js';

function safeClone(value, fallback = {}) {
    try {
        return structuredClone(value);
    } catch {
        return fallback;
    }
}

function truncateText(value, maxChars = 1200) {
    return String(value ?? '').trim().slice(0, Math.max(80, Number(maxChars) || 1200));
}

function normalizePresetApi(api) {
    if (api === 'koboldhorde') {
        return 'kobold';
    }
    return String(api || main_api || 'openai');
}

function isPresetAvailable(manager, presetName) {
    if (!manager || typeof manager.getAllPresets !== 'function') {
        return false;
    }
    const names = manager.getAllPresets();
    if (!Array.isArray(names)) {
        return false;
    }
    return names.some(name => String(name || '') === String(presetName || ''));
}

function getPresetSnapshot(apiId, presetName = '') {
    const api = normalizePresetApi(apiId);
    const manager = getPresetManager(api);
    const selectedName = manager?.getSelectedPresetName?.() || '';
    const requestedName = String(presetName || '').trim();
    const targetName = requestedName || String(selectedName || '');

    let settings = {};
    let resolvedName = targetName;

    if (requestedName && manager && isPresetAvailable(manager, requestedName)) {
        try {
            settings = safeClone(manager?.getCompletionPresetByName?.(requestedName) || {}, {});
            resolvedName = requestedName;
        } catch {
            settings = {};
        }
    }

    if (!settings || typeof settings !== 'object' || Object.keys(settings).length === 0) {
        try {
            settings = safeClone(manager?.getPresetSettings?.(targetName || selectedName) || {}, {});
            if (!resolvedName) {
                resolvedName = String(selectedName || '');
            }
        } catch {
            settings = {};
        }
    }

    return {
        apiId: api,
        name: String(resolvedName || selectedName || ''),
        settings,
    };
}

function pickPromptLikeFields(settings, maxChars = 1200) {
    const result = {};
    const source = settings && typeof settings === 'object' ? settings : {};
    const promptLikeRegex = /(prompt|story|sequence|suffix|prefix|format|separator|jailbreak|chat_start|example|system|scenario|personality|wi_|anchor)/i;

    for (const [key, value] of Object.entries(source)) {
        if (!promptLikeRegex.test(key)) {
            continue;
        }
        if (typeof value === 'string') {
            const trimmed = truncateText(value, maxChars);
            if (trimmed) {
                result[key] = trimmed;
            }
        } else if (Array.isArray(value) || (value && typeof value === 'object')) {
            result[key] = safeClone(value, {});
        } else if (typeof value === 'boolean' || typeof value === 'number') {
            result[key] = value;
        }
    }

    return result;
}

function getCompletionPromptCore(api, settings, maxChars = 1200) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const apiId = normalizePresetApi(api);

    if (apiId === 'openai') {
        const keys = [
            'use_sysprompt',
            'new_chat_prompt',
            'new_group_chat_prompt',
            'new_example_chat_prompt',
            'continue_nudge_prompt',
            'impersonation_prompt',
            'assistant_prefill',
            'continue_prefill',
            'continue_postfix',
            'scenario_format',
            'personality_format',
            'wi_format',
            'group_nudge_prompt',
            'squash_system_messages',
            'prompts',
            'prompt_order',
        ];
        const core = {};
        for (const key of keys) {
            if (!Object.hasOwn(source, key)) {
                continue;
            }
            const value = source[key];
            if (typeof value === 'string') {
                core[key] = truncateText(value, maxChars);
            } else if (Array.isArray(value) || (value && typeof value === 'object')) {
                core[key] = safeClone(value, {});
            } else {
                core[key] = value;
            }
        }
        return core;
    }

    return pickPromptLikeFields(source, maxChars);
}

function getContextPromptCore(settings, maxChars = 1200) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const keys = [
        'story_string',
        'chat_start',
        'example_separator',
        'chat_end',
        'name',
    ];
    const core = {};
    for (const key of keys) {
        if (!Object.hasOwn(source, key)) {
            continue;
        }
        core[key] = typeof source[key] === 'string'
            ? truncateText(source[key], maxChars)
            : safeClone(source[key], source[key]);
    }
    return core;
}

function getInstructPromptCore(settings, maxChars = 1200) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const keys = [
        'input_sequence',
        'output_sequence',
        'system_sequence',
        'system_suffix',
        'input_suffix',
        'output_suffix',
        'last_input_sequence',
        'last_output_sequence',
        'first_input_sequence',
        'first_output_sequence',
        'last_system_sequence',
        'user_alignment_message',
        'stop_sequence',
        'name',
        'enabled',
    ];
    const core = {};
    for (const key of keys) {
        if (!Object.hasOwn(source, key)) {
            continue;
        }
        core[key] = typeof source[key] === 'string'
            ? truncateText(source[key], maxChars)
            : safeClone(source[key], source[key]);
    }
    return core;
}

function getReasoningPromptCore(settings, maxChars = 1200) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const keys = ['prefix', 'suffix', 'separator', 'max_additions', 'name', 'enabled'];
    const core = {};
    for (const key of keys) {
        if (!Object.hasOwn(source, key)) {
            continue;
        }
        core[key] = typeof source[key] === 'string'
            ? truncateText(source[key], maxChars)
            : safeClone(source[key], source[key]);
    }
    return core;
}

function normalizeLayoutRole(role) {
    const value = String(role || 'system').trim().toLowerCase();
    if (['system', 'user', 'assistant'].includes(value)) {
        return value;
    }
    return 'system';
}

function normalizeLayoutPhase(phase) {
    const value = String(phase || 'any').trim().toLowerCase();
    if (['before', 'after', 'any', '*'].includes(value)) {
        return value === '*' ? 'any' : value;
    }
    return 'any';
}

function normalizePromptLayout(layout) {
    const list = Array.isArray(layout) ? layout : [];
    return list
        .filter(item => item && typeof item === 'object')
        .map((item, index) => ({
            id: String(item.id || `entry_${index + 1}`).trim(),
            enabled: item.enabled !== false,
            order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
            role: normalizeLayoutRole(item.role),
            phase: normalizeLayoutPhase(item.phase),
            source: String(item.source || 'literal').trim().toLowerCase(),
            content: String(item.content || '').trim(),
            path: String(item.path || '').trim(),
            promptIdentifier: String(item.promptIdentifier || item.prompt_identifier || '').trim(),
            tags: Array.isArray(item.tags)
                ? item.tags.map(tag => String(tag || '').trim().toLowerCase()).filter(Boolean)
                : [],
        }))
        .sort((a, b) => a.order - b.order);
}

function getPresetPromptLayout(completionPresetSettings) {
    const source = completionPresetSettings && typeof completionPresetSettings === 'object'
        ? completionPresetSettings
        : {};
    return normalizePromptLayout(source?.extensions?.luker?.prompt_layout);
}

function getPromptCatalog(completionPresetSettings, maxChars = 1200) {
    const source = completionPresetSettings && typeof completionPresetSettings === 'object'
        ? completionPresetSettings
        : {};
    const prompts = Array.isArray(source.prompts) ? source.prompts : [];
    const result = {};

    for (const prompt of prompts) {
        if (!prompt || typeof prompt !== 'object' || !prompt.identifier) {
            continue;
        }
        const identifier = String(prompt.identifier);
        result[identifier] = {
            identifier,
            name: String(prompt.name || ''),
            role: normalizeLayoutRole(prompt.role || 'system'),
            content: truncateText(prompt.content || '', maxChars),
            marker: Boolean(prompt.marker),
            systemPrompt: Boolean(prompt.system_prompt),
        };
    }

    return result;
}

function getActivePromptPresetEnvelope({
    includeCharacterCard = true,
    maxBlockChars = 1200,
    api = main_api,
    promptPresetName = '',
    completionPresetName = '',
    contextPresetName = '',
    instructPresetName = '',
    syspromptPresetName = '',
    reasoningPresetName = '',
} = {}) {
    const maxChars = Math.max(120, Number(maxBlockChars) || 1200);
    const completionApi = normalizePresetApi(api);
    const requestedCompletionPreset = String(promptPresetName || completionPresetName || '').trim();
    const completionPreset = getPresetSnapshot(completionApi, requestedCompletionPreset);
    const contextPreset = getPresetSnapshot('context', contextPresetName);
    const instructPreset = getPresetSnapshot('instruct', instructPresetName);
    const syspromptPreset = getPresetSnapshot('sysprompt', syspromptPresetName);
    const reasoningPreset = getPresetSnapshot('reasoning', reasoningPresetName);

    const fields = getCharacterCardFields({ chid: this_chid }) || {};
    const character = characters?.[this_chid];
    const syspromptRaw = truncateText(substituteParams(power_user?.sysprompt?.content || ''), maxChars);
    const postHistoryRaw = truncateText(substituteParams(power_user?.sysprompt?.post_history || ''), maxChars);
    const cardSystem = truncateText(fields?.system || '', maxChars);
    const cardPostHistory = truncateText(fields?.jailbreak || '', maxChars);

    const syspromptEnabled = Boolean(power_user?.sysprompt?.enabled);
    const activeSystemPrompt = syspromptEnabled ? (cardSystem || syspromptRaw) : '';
    const activePostHistory = syspromptEnabled ? (cardPostHistory || postHistoryRaw) : '';
    const promptLayout = getPresetPromptLayout(completionPreset.settings);

    const envelope = {
        version: 1,
        generatedAt: Date.now(),
        mainApi: normalizePresetApi(main_api),
        completionApi,
        presetRefs: {
            completion: completionPreset.name || '',
            context: contextPreset.name || '',
            instruct: instructPreset.name || '',
            sysprompt: syspromptPreset.name || '',
            reasoning: reasoningPreset.name || '',
        },
        promptCore: {
            sysprompt: {
                enabled: syspromptEnabled,
                activeSystemPrompt,
                activePostHistory,
                defaultSystemPrompt: syspromptRaw,
                defaultPostHistory: postHistoryRaw,
                cardSystemPrompt: cardSystem,
                cardPostHistory,
            },
            context: getContextPromptCore(contextPreset.settings, maxChars),
            instruct: getInstructPromptCore(instructPreset.settings, maxChars),
            reasoning: getReasoningPromptCore(reasoningPreset.settings, maxChars),
            completion: getCompletionPromptCore(completionApi, completionPreset.settings, maxChars),
        },
        promptLayout,
        promptCatalog: getPromptCatalog(completionPreset.settings, maxChars),
    };

    if (includeCharacterCard) {
        envelope.characterCard = {
            name: String(character?.name || ''),
            description: truncateText(fields?.description || '', maxChars),
            personality: truncateText(fields?.personality || '', maxChars),
            persona: truncateText(fields?.persona || '', maxChars),
            scenario: truncateText(fields?.scenario || '', maxChars),
            mesExamples: truncateText(fields?.mesExamples || '', maxChars),
            creatorNotes: truncateText(fields?.creatorNotes || '', maxChars),
            charDepthPrompt: truncateText(fields?.charDepthPrompt || '', maxChars),
        };
    }

    return envelope;
}

function getValueByPath(source, path) {
    if (!source || typeof source !== 'object') {
        return undefined;
    }
    const parts = String(path || '')
        .split('.')
        .map(part => part.trim())
        .filter(Boolean);
    if (parts.length === 0) {
        return undefined;
    }
    let cursor = source;
    for (const part of parts) {
        if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) {
            return undefined;
        }
        cursor = cursor[part];
    }
    return cursor;
}

function normalizePromptMessages(messages) {
    if (!Array.isArray(messages)) {
        return [];
    }
    const result = [];
    for (const message of messages) {
        if (!message || typeof message !== 'object') {
            continue;
        }
        const role = normalizeLayoutRole(message.role);
        const content = String(message.content || '').trim();
        if (!content) {
            continue;
        }
        result.push({ role, content });
    }
    return result;
}

function tagsMatch(entryTags, requestedTags) {
    if (!requestedTags || requestedTags.size === 0) {
        return true;
    }
    if (!Array.isArray(entryTags) || entryTags.length === 0) {
        return true;
    }
    if (entryTags.includes('shared')) {
        return true;
    }
    return entryTags.some(tag => requestedTags.has(tag));
}

function resolvePluginPromptOrderEntries(completionCore) {
    const promptOrder = Array.isArray(completionCore?.prompt_order) ? completionCore.prompt_order : [];
    const isEntry = entry => entry && typeof entry === 'object' && typeof entry.identifier === 'string';

    if (promptOrder.length === 0) {
        return [];
    }
    if (promptOrder.every(isEntry)) {
        return promptOrder;
    }

    const list = promptOrder.find(item => Array.isArray(item?.order) && item.order.some(isEntry));
    if (list && Array.isArray(list.order)) {
        return list.order.filter(isEntry);
    }

    return [];
}

function resolvePluginMarkerPromptContent(promptIdentifier, envelope) {
    const marker = String(promptIdentifier || '').trim();
    switch (marker) {
        case 'charDescription':
            return String(envelope?.characterCard?.description || '').trim();
        case 'charPersonality':
            return String(envelope?.characterCard?.personality || '').trim();
        case 'scenario':
            return String(envelope?.characterCard?.scenario || '').trim();
        case 'personaDescription':
            return String(envelope?.characterCard?.persona || '').trim();
        case 'dialogueExamples':
            return String(envelope?.characterCard?.mesExamples || '').trim();
        default:
            return '';
    }
}

function buildPluginMessagesFromPromptOrder(completionCore, envelope, normalizedMessages) {
    const prompts = Array.isArray(completionCore?.prompts) ? completionCore.prompts : [];
    const promptMap = new Map(prompts
        .filter(prompt => prompt && typeof prompt === 'object' && typeof prompt.identifier === 'string')
        .map(prompt => [String(prompt.identifier), prompt]));
    const orderEntries = resolvePluginPromptOrderEntries(completionCore);
    if (orderEntries.length === 0) {
        return null;
    }

    const result = [];
    let historyInjected = false;

    for (const entry of orderEntries) {
        if (!entry || entry.enabled === false) {
            continue;
        }

        const identifier = String(entry.identifier || '').trim();
        if (!identifier) {
            continue;
        }

        const prompt = promptMap.get(identifier);
        if (!prompt || prompt.plugin_extra === true) {
            continue;
        }

        if (identifier === 'chatHistory') {
            historyInjected = true;
            result.push(...normalizedMessages);
            continue;
        }

        let content = '';
        if (prompt.marker === true) {
            content = resolvePluginMarkerPromptContent(identifier, envelope);
        } else {
            content = String(substituteParams(prompt.content || '')).trim();
        }

        if (!content) {
            continue;
        }

        const role = normalizeLayoutRole(prompt.role || (prompt.system_prompt ? 'system' : 'user'));
        result.push({ role, content });
    }

    if (!historyInjected && normalizedMessages.length > 0) {
        result.push(...normalizedMessages);
    }

    return result;
}

function resolveLayoutEntryText(entry, env) {
    const source = String(entry.source || '').toLowerCase();
    if (source === 'task_system') {
        return env.taskSystemText;
    }
    if (source === 'task_user') {
        return env.taskUserText;
    }
    if (source === 'envelope_json') {
        return formatPromptPresetEnvelope(env.envelope, { maxChars: env.envelopeMaxChars });
    }
    if (source === 'envelope_field') {
        const value = getValueByPath(env.envelope, entry.path);
        if (value === undefined || value === null) {
            return '';
        }
        if (typeof value === 'string') {
            return value.trim();
        }
        return JSON.stringify(value);
    }
    if (source === 'prompt_ref') {
        const promptId = String(entry.promptIdentifier || '').trim();
        if (!promptId) {
            return '';
        }
        const row = env.promptCatalog?.[promptId];
        return String(row?.content || '').trim();
    }
    if (source === 'literal' || !source) {
        return entry.content;
    }
    return '';
}

function compactEnvelopeForPrompt(envelope, maxChars = 3200) {
    const targetChars = Math.max(1000, Number(maxChars) || 3200);
    const compact = safeClone(envelope, {});
    const size = () => JSON.stringify(compact).length;

    if (size() <= targetChars) {
        return compact;
    }

    if (compact.characterCard && typeof compact.characterCard === 'object') {
        compact.characterCard.description = truncateText(compact.characterCard.description, 360);
        compact.characterCard.personality = truncateText(compact.characterCard.personality, 240);
        compact.characterCard.scenario = truncateText(compact.characterCard.scenario, 240);
        compact.characterCard.creatorNotes = truncateText(compact.characterCard.creatorNotes, 220);
        compact.characterCard.charDepthPrompt = truncateText(compact.characterCard.charDepthPrompt, 220);
    }

    if (size() <= targetChars) {
        return compact;
    }

    if (compact.promptCore?.completion?.prompts) {
        compact.promptCore.completion.prompts = '[omitted: prompts too large]';
    }
    if (compact.promptCore?.completion?.prompt_order) {
        compact.promptCore.completion.prompt_order = '[omitted: prompt_order too large]';
    }

    if (size() <= targetChars) {
        return compact;
    }

    compact.truncated = true;
    compact.promptCore = {
        sysprompt: compact.promptCore?.sysprompt || {},
        context: {
            story_string: compact.promptCore?.context?.story_string || '',
            chat_start: compact.promptCore?.context?.chat_start || '',
            example_separator: compact.promptCore?.context?.example_separator || '',
        },
        instruct: {
            enabled: compact.promptCore?.instruct?.enabled ?? false,
            input_sequence: compact.promptCore?.instruct?.input_sequence || '',
            output_sequence: compact.promptCore?.instruct?.output_sequence || '',
            system_sequence: compact.promptCore?.instruct?.system_sequence || '',
        },
        reasoning: {
            enabled: compact.promptCore?.reasoning?.enabled ?? false,
            prefix: compact.promptCore?.reasoning?.prefix || '',
            suffix: compact.promptCore?.reasoning?.suffix || '',
            separator: compact.promptCore?.reasoning?.separator || '',
        },
        completion: {
            use_sysprompt: compact.promptCore?.completion?.use_sysprompt ?? false,
            new_chat_prompt: compact.promptCore?.completion?.new_chat_prompt || '',
            continue_nudge_prompt: compact.promptCore?.completion?.continue_nudge_prompt || '',
        },
    };

    return compact;
}

function formatPromptPresetEnvelope(envelope, { maxChars = 3200, label = 'LUKER_PRESET_ENVELOPE' } = {}) {
    const resolved = envelope && typeof envelope === 'object'
        ? envelope
        : getActivePromptPresetEnvelope();
    const compact = compactEnvelopeForPrompt(resolved, maxChars);
    return `[[${label}]]\n${JSON.stringify(compact)}`;
}

function getActivePromptLayout(options = {}) {
    const envelope = getActivePromptPresetEnvelope(options);
    return normalizePromptLayout(envelope?.promptLayout);
}

function buildPresetAwarePromptMessages({
    taskSystem = '',
    taskUser = '',
    messages = [],
    envelope = null,
    envelopeOptions = {},
    promptPresetName = '',
    envelopeMaxChars = 3200,
} = {}) {
    const normalizedMessages = normalizePromptMessages(messages);
    const resolvedEnvelopeOptions = envelopeOptions && typeof envelopeOptions === 'object'
        ? { ...envelopeOptions }
        : {};
    const selectedPromptPresetName = String(promptPresetName || '').trim();
    if (selectedPromptPresetName && !resolvedEnvelopeOptions.promptPresetName && !resolvedEnvelopeOptions.completionPresetName) {
        resolvedEnvelopeOptions.promptPresetName = selectedPromptPresetName;
    }
    const resolvedEnvelope = envelope && typeof envelope === 'object'
        ? envelope
        : getActivePromptPresetEnvelope(resolvedEnvelopeOptions);

    // Backward compatibility: convert taskSystem/taskUser to messages if caller still uses legacy fields.
    const taskSystemText = String(taskSystem || '').trim();
    const taskUserText = String(taskUser || '').trim();
    if (normalizedMessages.length === 0) {
        if (taskSystemText) {
            normalizedMessages.push({ role: 'system', content: taskSystemText });
        }
        if (taskUserText) {
            normalizedMessages.push({ role: 'user', content: taskUserText });
        }
    }

    const orderedMessages = buildPluginMessagesFromPromptOrder(
        resolvedEnvelope?.promptCore?.completion,
        resolvedEnvelope,
        normalizedMessages,
    );
    if (Array.isArray(orderedMessages)) {
        return orderedMessages;
    }

    // Fallback: no prompt order found.
    const result = [];
    const systemBlocks = [];
    if (taskSystemText) {
        systemBlocks.push(taskSystemText);
    }
    systemBlocks.push(formatPromptPresetEnvelope(resolvedEnvelope, { maxChars: envelopeMaxChars }));

    if (systemBlocks.length > 0) {
        result.push({ role: 'system', content: systemBlocks.join('\n\n') });
    }
    if (taskUserText) {
        result.push({ role: 'user', content: taskUserText });
    }
    result.push(...normalizedMessages);

    return result;
}

export function getContext() {
    return {
        accountStorage,
        chat,
        characters,
        groups,
        name1,
        name2,
        characterId: this_chid,
        groupId: selected_group,
        chatId: selected_group
            ? groups.find(x => x.id == selected_group)?.chat_id
            : (characters[this_chid]?.chat),
        getCurrentChatId,
        getRequestHeaders,
        reloadCurrentChat,
        renameChat,
        saveSettingsDebounced,
        onlineStatus: online_status,
        maxContext: Number(max_context),
        chatMetadata: chat_metadata,
        saveMetadataDebounced,
        streamingProcessor,
        eventSource,
        eventTypes: event_types,
        addOneMessage,
        deleteLastMessage,
        deleteMessage,
        generate: Generate,
        sendStreamingRequest,
        sendGenerationRequest,
        stopGeneration,
        tokenizers,
        getTextTokens,
        /** @deprecated Use getTokenCountAsync instead */
        getTokenCount,
        getTokenCountAsync,
        extensionPrompts: extension_prompts,
        setExtensionPrompt,
        updateChatMetadata,
        saveChat: saveChatConditional,
        appendChatMessages,
        patchChatMessages,
        saveChatMetadata,
        getChatState,
        patchChatState,
        deleteChatState,
        openCharacterChat,
        openGroupChat,
        saveMetadata,
        sendSystemMessage,
        activateSendButtons,
        deactivateSendButtons,
        saveReply,
        substituteParams,
        substituteParamsExtended,
        SlashCommandParser,
        SlashCommand,
        SlashCommandArgument,
        SlashCommandNamedArgument,
        ARGUMENT_TYPE,
        executeSlashCommandsWithOptions,
        /** @deprecated Use SlashCommandParser.addCommandObject() instead */
        registerSlashCommand,
        /** @deprecated Use executeSlashCommandWithOptions instead */
        executeSlashCommands,
        timestampToMoment,
        /** @deprecated Handlebars for extensions are no longer supported. */
        registerHelper: () => { },
        /** @deprecated Use `macros.register(name, { handler, description })` from scripts/macros/macro-system.js instead. */
        registerMacro: MacrosParser.registerMacro.bind(MacrosParser),
        /** @deprecated Use `macros.registry.unregisterMacro(name)` from scripts/macros/macro-system.js instead. */
        unregisterMacro: MacrosParser.unregisterMacro.bind(MacrosParser),
        registerFunctionTool: ToolManager.registerFunctionTool.bind(ToolManager),
        unregisterFunctionTool: ToolManager.unregisterFunctionTool.bind(ToolManager),
        isToolCallingSupported: ToolManager.isToolCallingSupported.bind(ToolManager),
        canPerformToolCalls: ToolManager.canPerformToolCalls.bind(ToolManager),
        ToolManager,
        registerDebugFunction,
        /** @deprecated Use renderExtensionTemplateAsync instead. */
        renderExtensionTemplate,
        renderExtensionTemplateAsync,
        registerDataBankScraper: ScraperManager.registerDataBankScraper.bind(ScraperManager),
        /** @deprecated Use callGenericPopup or Popup instead. */
        callPopup,
        callGenericPopup,
        showLoader,
        hideLoader,
        mainApi: main_api,
        extensionSettings: extension_settings,
        ModuleWorkerWrapper,
        getTokenizerModel,
        generateQuietPrompt,
        generateRaw,
        writeExtensionField,
        getThumbnailUrl,
        selectCharacterById,
        messageFormatting,
        shouldSendOnEnter,
        isMobile,
        t,
        translate,
        getCurrentLocale,
        addLocaleData,
        tags,
        tagMap: tag_map,
        menuType: menu_type,
        createCharacterData: create_save,
        /** @deprecated Legacy snake-case naming, compatibility with old extensions */
        event_types: event_types,
        Popup,
        POPUP_TYPE,
        POPUP_RESULT,
        chatCompletionSettings: oai_settings,
        textCompletionSettings: textgenerationwebui_settings,
        powerUserSettings: power_user,
        getCharacters,
        getOneCharacter,
        getCharacterCardFields,
        buildWorldInfoChatInput,
        buildWorldInfoGlobalScanData,
        simulateWorldInfoActivation,
        uuidv4,
        humanizedDateTime,
        updateMessageBlock,
        appendMediaToMessage,
        ensureMessageMediaIsArray,
        getMediaDisplay,
        getMediaIndex,
        scrollChatToBottom,
        scrollOnMediaLoad,
        macros,
        swipe: {
            left: swipe_left,
            right: swipe_right,
            to: swipe,
            show: showSwipeButtons,
            hide: hideSwipeButtons,
            refresh: refreshSwipeButtons,
            isAllowed: isSwipingAllowed,
            state: () => swipeState,
        },
        variables: {
            local: {
                get: getLocalVariable,
                set: setLocalVariable,
                del: deleteLocalVariable,
                add: addLocalVariable,
                inc: incrementLocalVariable,
                dec: decrementLocalVariable,
            },
            global: {
                get: getGlobalVariable,
                set: setGlobalVariable,
                del: deleteGlobalVariable,
                add: addGlobalVariable,
                inc: incrementGlobalVariable,
                dec: decrementGlobalVariable,
            },
        },
        loadWorldInfo,
        saveWorldInfo,
        reloadWorldInfoEditor: reloadEditor,
        updateWorldInfoList,
        convertCharacterBook,
        getWorldInfoPrompt,
        CONNECT_API_MAP,
        getTextGenServer,
        extractMessageFromData,
        getPresetManager,
        getActivePromptPresetEnvelope,
        getActivePromptLayout,
        formatPromptPresetEnvelope,
        buildPresetAwarePromptMessages,
        getChatCompletionModel,
        printMessages,
        clearChat,
        ChatCompletionService,
        TextCompletionService,
        ConnectionManagerRequestService,
        updateReasoningUI,
        parseReasoningFromString,
        getReasoningTemplateByName,
        unshallowCharacter,
        unshallowGroupMembers,
        openThirdPartyExtensionMenu,
        symbols: {
            ignore: IGNORE_SYMBOL,
        },
    };
}

export default getContext;
