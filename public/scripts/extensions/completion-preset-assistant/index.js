// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups

import { DOMPurify, DiffMatchPatch, lodash } from '../../../lib.js';
import { saveSettingsDebounced } from '../../../script.js';
import { sendOpenAIRequest } from '../../openai.js';
import { extension_settings, getContext } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { Popup, POPUP_TYPE } from '../../popup.js';
import { escapeHtml, uuidv4 } from '../../utils.js';
import { getChatCompletionConnectionProfiles, resolveChatCompletionRequestProfile } from '../connection-manager/profile-resolver.js';
import {
    TOOL_PROTOCOL_STYLE,
    extractAllFunctionCalls,
    getResponseMessageContent,
    validateParsedToolCalls,
} from '../function-call-runtime.js';
import { create as createDiffPatcher } from '../../vendor/diffpatch/index.js';
import DiffpatchHtmlFormatter from '../../vendor/diffpatch/formatters/html.js';

const MODULE_NAME = 'completion_preset_assistant';
const UI_BLOCK_ID = 'completion_preset_assistant_settings';
const OPEN_BUTTON_ID = 'completion_preset_assistant_open';
const OPENAI_BUTTON_ID = 'completion_preset_assistant_openai_button';
const SESSION_NAMESPACE = 'completion_preset_assistant_session';
const SESSION_VERSION = 1;
const TOOL_CALL_RETRY_MAX = 10;
const SESSION_MESSAGE_LIMIT_MIN = 8;
const SESSION_MESSAGE_LIMIT_MAX = 48;
const JSON_TEXTDIFF_MIN_LENGTH = 80;
const MODEL_TOOLS = Object.freeze({
    SET_FIELD: 'preset_set_field',
    REMOVE_FIELD: 'preset_remove_field',
    COPY_FROM_REFERENCE: 'preset_copy_from_reference',
});
const PROMPT_PREVIEW_FIELDS = Object.freeze([
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
]);
const defaultSettings = {
    requestLlmPresetName: '',
    requestApiProfileName: '',
    toolCallRetryMax: 2,
    sessionMessageLimit: 24,
};

let activeDialogState = null;

const diffPatcher = createDiffPatcher({
    arrays: {
        detectMove: true,
        includeValueOnMove: false,
    },
    textDiff: {
        minLength: JSON_TEXTDIFF_MIN_LENGTH,
        diffMatchPatch: DiffMatchPatch,
    },
    cloneDiffValues: true,
});
const diffFormatter = new DiffpatchHtmlFormatter();

function clone(value, fallback = {}) {
    try {
        return structuredClone(value);
    } catch {
        return fallback;
    }
}

function i18n(text) {
    return translate(String(text || ''));
}

function i18nFormat(text, ...values) {
    return i18n(text).replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function limitText(value, max = 240) {
    const text = String(value ?? '').trim();
    if (!text) {
        return '';
    }
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function toInteger(value, fallback = 0) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return fallback;
    }
    return Math.floor(num);
}

function buildJson(value) {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return '{}';
    }
}

function areJsonEqual(left, right) {
    return buildJson(left) === buildJson(right);
}

function isAbortError(error, signal = null) {
    return error?.name === 'AbortError' || Boolean(signal?.aborted);
}

function throwIfAborted(signal, message = 'Operation aborted.') {
    if (!signal?.aborted) {
        return;
    }

    try {
        throw new DOMException(String(message || 'Operation aborted.'), 'AbortError');
    } catch {
        const error = new Error(String(message || 'Operation aborted.'));
        error.name = 'AbortError';
        throw error;
    }
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = clone(defaultSettings);
    }

    const settings = extension_settings[MODULE_NAME];
    settings.requestLlmPresetName = String(settings.requestLlmPresetName || '').trim();
    settings.requestApiProfileName = String(settings.requestApiProfileName || '').trim();
    settings.toolCallRetryMax = Math.max(0, Math.min(TOOL_CALL_RETRY_MAX, toInteger(settings.toolCallRetryMax, defaultSettings.toolCallRetryMax)));
    settings.sessionMessageLimit = Math.max(
        SESSION_MESSAGE_LIMIT_MIN,
        Math.min(SESSION_MESSAGE_LIMIT_MAX, toInteger(settings.sessionMessageLimit, defaultSettings.sessionMessageLimit)),
    );
}

function getSettings() {
    ensureSettings();
    return extension_settings[MODULE_NAME];
}

function registerLocaleData() {
    addLocaleData('zh-cn', {
        'Completion Preset Assistant': '聊天补全预设助手',
        'Open Assistant': '打开助手',
        'Works on saved Chat Completion presets. Character-bound runtime presets are read-only for this MVP.': '当前 MVP 只支持已保存的聊天补全预设。角色卡绑定的运行时预设暂不支持直接编辑。',
        'Model request LLM preset name': '模型请求提示词预设',
        'Model request API profile': '模型请求 API 配置档',
        'Tool-call retries on invalid/missing tool call (N)': '工具调用重试次数（无效/缺失时）',
        'Stored session messages per preset': '每个预设保留的会话消息数',
        'Current preset is not a stored chat completion preset. Please select a saved preset first.': '当前不是已保存的聊天补全预设，请先选择一个已保存预设。',
        'Chat Completion preset assistant': '聊天补全预设助手',
        'Target': '目标预设',
        'Reference preset': '参考预设',
        '(none)': '（无）',
        'Refresh live preset': '刷新当前 live 预设',
        'Reference diff': '参考预设 diff',
        'Discard draft': '丢弃草稿',
        'Clear history': '清空历史',
        'Conversation': '会话',
        'Draft diff': '草稿 diff',
        'No conversation yet.': '暂无会话内容。',
        'No draft yet. Ask the assistant to propose changes first.': '还没有草稿，请先让助手提出修改建议。',
        'No reference preset selected.': '未选择参考预设。',
        'Draft ready': '草稿已生成',
        'No changes proposed': '未提出变更',
        'Apply draft': '应用草稿',
        'Send': '发送',
        'Stop': '终止',
        'Type what to change in this preset...': '输入你想如何修改这个预设...',
        'Applied draft to preset.': '已将草稿应用到预设。',
        'Draft discarded.': '草稿已丢弃。',
        'Session history cleared.': '会话历史已清空。',
        'No reference diff available.': '没有可显示的参考 diff。',
        'No diff to display.': '没有可显示的 diff。',
        'Reference diff: ${0} -> ${1}': '参考 diff：${0} -> ${1}',
        'AI request failed: ${0}': '模型请求失败：${0}',
        'Save failed.': '保存失败。',
        'Reference preset copied': '已复制参考预设内容',
        'Please enter a request first.': '请先输入请求。',
        'Applying draft...': '正在应用草稿...',
        'Assistant is thinking...': '模型思考中...',
        'Refreshing live preset will discard the current draft. Continue?': '刷新 live 预设会丢弃当前草稿。要继续吗？',
        'Clear this preset assistant history and draft?': '要清空这个预设助手的历史和草稿吗？',
        'Discard current draft?': '要丢弃当前草稿吗？',
        'Change summary': '变更摘要',
        'Proposed edits: ${0}': '拟议变更：${0}',
        'Applied': '已应用',
        'Reference summary': '参考预设摘要',
        'Current live preset': '当前 live 预设',
        'No meaningful changes detected.': '未检测到有效变更。',
        'Select reference preset': '选择参考预设',
        'Prompt preset paths use lodash syntax like prompts[0].content or new_chat_prompt.': '预设路径使用 lodash 语法，例如 prompts[0].content 或 new_chat_prompt。',
        'Current request profile': '当前请求配置',
        'Live snapshot refreshed.': '已刷新 live 快照。',
        'Request stopped.': '请求已终止。',
        'Selected preset changed outside the assistant. Reopen the assistant on the desired preset.': '助手打开后当前选中的预设已被切换。请在目标预设上重新打开助手。',
        'Current live preset changed since this draft was created. Refresh live and request a new draft.': '当前 live 预设在草稿生成后已发生变化。请先刷新 live 预设，再重新生成草稿。',
        'User': '用户',
        'Assistant': '助手',
        'System': '系统',
        'LLM preset': 'LLM 预设',
    });
    addLocaleData('zh-tw', {
        'Completion Preset Assistant': '聊天補全預設助手',
        'Open Assistant': '開啟助手',
        'Works on saved Chat Completion presets. Character-bound runtime presets are read-only for this MVP.': '目前 MVP 只支援已儲存的聊天補全預設。角色卡綁定的執行時預設暫不支援直接編輯。',
        'Model request LLM preset name': '模型請求提示詞預設',
        'Model request API profile': '模型請求 API 設定檔',
        'Tool-call retries on invalid/missing tool call (N)': '工具調用重試次數（無效/缺失時）',
        'Stored session messages per preset': '每個預設保留的會話訊息數',
        'Current preset is not a stored chat completion preset. Please select a saved preset first.': '目前不是已儲存的聊天補全預設，請先選擇一個已儲存預設。',
        'Chat Completion preset assistant': '聊天補全預設助手',
        'Target': '目標預設',
        'Reference preset': '參考預設',
        '(none)': '（無）',
        'Refresh live preset': '重新整理目前 live 預設',
        'Reference diff': '參考預設 diff',
        'Discard draft': '捨棄草稿',
        'Clear history': '清空歷史',
        'Conversation': '會話',
        'Draft diff': '草稿 diff',
        'No conversation yet.': '暫無會話內容。',
        'No draft yet. Ask the assistant to propose changes first.': '尚未產生草稿，請先讓助手提出修改建議。',
        'No reference preset selected.': '未選擇參考預設。',
        'Draft ready': '草稿已產生',
        'No changes proposed': '未提出變更',
        'Apply draft': '套用草稿',
        'Send': '發送',
        'Stop': '終止',
        'Type what to change in this preset...': '輸入你想如何修改這個預設...',
        'Applied draft to preset.': '已將草稿套用到預設。',
        'Draft discarded.': '草稿已捨棄。',
        'Session history cleared.': '會話歷史已清空。',
        'No reference diff available.': '沒有可顯示的參考 diff。',
        'No diff to display.': '沒有可顯示的 diff。',
        'Reference diff: ${0} -> ${1}': '參考 diff：${0} -> ${1}',
        'AI request failed: ${0}': '模型請求失敗：${0}',
        'Save failed.': '儲存失敗。',
        'Reference preset copied': '已複製參考預設內容',
        'Please enter a request first.': '請先輸入請求。',
        'Applying draft...': '正在套用草稿...',
        'Assistant is thinking...': '模型思考中...',
        'Refreshing live preset will discard the current draft. Continue?': '重新整理 live 預設會捨棄目前草稿。要繼續嗎？',
        'Clear this preset assistant history and draft?': '要清空這個預設助手的歷史與草稿嗎？',
        'Discard current draft?': '要捨棄目前草稿嗎？',
        'Change summary': '變更摘要',
        'Proposed edits: ${0}': '擬議變更：${0}',
        'Applied': '已套用',
        'Reference summary': '參考預設摘要',
        'Current live preset': '目前 live 預設',
        'No meaningful changes detected.': '未檢測到有效變更。',
        'Select reference preset': '選擇參考預設',
        'Prompt preset paths use lodash syntax like prompts[0].content or new_chat_prompt.': '預設路徑使用 lodash 語法，例如 prompts[0].content 或 new_chat_prompt。',
        'Current request profile': '目前請求設定',
        'Live snapshot refreshed.': '已重新整理 live 快照。',
        'Request stopped.': '請求已終止。',
        'Selected preset changed outside the assistant. Reopen the assistant on the desired preset.': '助手開啟後目前選中的預設已被切換。請在目標預設上重新開啟助手。',
        'Current live preset changed since this draft was created. Refresh live and request a new draft.': '目前 live 預設在草稿產生後已發生變化。請先重新整理 live 預設，再重新產生草稿。',
        'User': '使用者',
        'Assistant': '助手',
        'System': '系統',
        'LLM preset': 'LLM 預設',
    });
}

function getConnectionProfileNames() {
    return getChatCompletionConnectionProfiles()
        .map(profile => String(profile?.name || '').trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
}

function getOpenAIPresetNames(context = getContext()) {
    const refs = Array.isArray(context?.presets?.list?.('openai')) ? context.presets.list('openai') : [];
    return refs
        .map(ref => String(ref?.name || '').trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
}

function renderSelectOptions(names, selectedName = '', includeBlank = true) {
    const options = [];
    if (includeBlank) {
        options.push(`<option value="">${escapeHtml(i18n('(none)'))}</option>`);
    }

    for (const name of names) {
        const selected = String(name || '') === String(selectedName || '') ? ' selected' : '';
        options.push(`<option value="${escapeHtml(String(name || ''))}"${selected}>${escapeHtml(String(name || ''))}</option>`);
    }

    return options.join('');
}

function getCurrentTargetRef(context = getContext()) {
    const ref = context?.presets?.getSelected?.('openai');
    return ref && typeof ref === 'object' ? clone(ref, null) : null;
}

function getCurrentLiveSnapshot(context = getContext()) {
    const snapshot = context?.presets?.getLive?.('openai');
    return snapshot && typeof snapshot === 'object' ? clone(snapshot, null) : null;
}

function createEmptySession() {
    return {
        version: SESSION_VERSION,
        referencePresetName: '',
        messages: [],
        draft: null,
        updatedAt: Date.now(),
    };
}

function sanitizeMessage(rawMessage) {
    const message = rawMessage && typeof rawMessage === 'object' ? rawMessage : {};
    const role = ['user', 'assistant', 'system'].includes(String(message.role || '').trim().toLowerCase())
        ? String(message.role).trim().toLowerCase()
        : 'system';
    return {
        id: String(message.id || uuidv4()),
        role,
        text: String(message.text || '').trim(),
        createdAt: Number(message.createdAt || Date.now()),
        summary: String(message.summary || '').trim(),
        editCount: Math.max(0, toInteger(message.editCount, 0)),
    };
}

function sanitizeDraft(rawDraft) {
    const draft = rawDraft && typeof rawDraft === 'object' ? rawDraft : null;
    if (!draft) {
        return null;
    }

    return {
        summary: String(draft.summary || '').trim(),
        assistantText: String(draft.assistantText || '').trim(),
        edits: Array.isArray(draft.edits) ? draft.edits.map(item => sanitizeEdit(item)).filter(Boolean) : [],
        draftBody: isPlainObject(draft.draftBody) ? clone(draft.draftBody, {}) : {},
        createdAt: Number(draft.createdAt || Date.now()),
        referencePresetName: String(draft.referencePresetName || '').trim(),
    };
}

function sanitizeSession(rawSession) {
    const session = rawSession && typeof rawSession === 'object' ? rawSession : {};
    const settings = getSettings();
    const next = createEmptySession();
    next.referencePresetName = String(session.referencePresetName || '').trim();
    next.messages = Array.isArray(session.messages)
        ? session.messages.map(item => sanitizeMessage(item)).slice(-settings.sessionMessageLimit)
        : [];
    next.draft = sanitizeDraft(session.draft);
    next.updatedAt = Number(session.updatedAt || Date.now());
    return next;
}

function sanitizeEdit(rawEdit) {
    const edit = rawEdit && typeof rawEdit === 'object' ? rawEdit : null;
    if (!edit) {
        return null;
    }

    const kind = String(edit.kind || '').trim();
    if (!['set', 'remove', 'copy'].includes(kind)) {
        return null;
    }

    return {
        kind,
        path: String(edit.path || '').trim(),
        fromPath: String(edit.fromPath || '').trim(),
        reason: String(edit.reason || '').trim(),
        value: kind === 'set' ? clone(edit.value, edit.value) : undefined,
    };
}

async function loadSession(context, targetRef) {
    try {
        const raw = await context.presets.state.get(SESSION_NAMESPACE, { target: targetRef });
        return sanitizeSession(raw);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to load preset session`, error);
        return createEmptySession();
    }
}

async function saveSession(context, targetRef, session) {
    const nextSession = sanitizeSession({
        ...session,
        updatedAt: Date.now(),
    });
    const result = await context.presets.state.update(
        SESSION_NAMESPACE,
        () => nextSession,
        {
            target: targetRef,
            asyncDiff: false,
        },
    );
    if (!result?.ok) {
        console.warn(`[${MODULE_NAME}] Failed to persist preset session`, result);
    }
    return nextSession;
}

function buildPromptPreview(body = {}) {
    const safeBody = isPlainObject(body) ? body : {};
    const preview = {
        keys: Object.keys(safeBody),
    };

    for (const key of PROMPT_PREVIEW_FIELDS) {
        if (typeof safeBody[key] === 'string' && safeBody[key].trim()) {
            preview[key] = limitText(safeBody[key], 240);
        }
    }

    if (Array.isArray(safeBody.prompts) && safeBody.prompts.length > 0) {
        preview.prompts = safeBody.prompts.slice(0, 10).map((item) => ({
            identifier: String(item?.identifier || item?.id || item?.name || '').trim(),
            role: String(item?.role || '').trim(),
            content: limitText(item?.content, 220),
        }));
    }

    if (Array.isArray(safeBody.prompt_order) && safeBody.prompt_order.length > 0) {
        preview.prompt_order = safeBody.prompt_order.slice(0, 16);
    }

    for (const key of ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'max_tokens']) {
        if (Object.hasOwn(safeBody, key)) {
            preview[key] = safeBody[key];
        }
    }

    return preview;
}

function getChangedTopLevelKeys(before, after) {
    const safeBefore = isPlainObject(before) ? before : {};
    const safeAfter = isPlainObject(after) ? after : {};
    const keys = [...new Set([...Object.keys(safeBefore), ...Object.keys(safeAfter)])];
    return keys.filter((key) => !areJsonEqual(safeBefore[key], safeAfter[key])).slice(0, 40);
}

function buildReferencePromptPayload(referenceSnapshot, liveSnapshot) {
    if (!referenceSnapshot || !isPlainObject(referenceSnapshot.body)) {
        return {
            selected: false,
        };
    }

    return {
        selected: true,
        name: String(referenceSnapshot?.ref?.name || '').trim(),
        changedTopLevelKeys: getChangedTopLevelKeys(liveSnapshot?.body, referenceSnapshot.body),
        preview: buildPromptPreview(referenceSnapshot.body),
    };
}

function buildDialogMetaItems(dialogState) {
    const settings = getSettings();
    const requestProfileLabel = settings.requestApiProfileName || i18n('(none)');
    const llmPresetLabel = settings.requestLlmPresetName || i18n('(none)');
    return [
        `${i18n('Target')}: ${dialogState.targetRef?.name || ''}`,
        `${i18n('Current request profile')}: ${requestProfileLabel}`,
        `${i18n('LLM preset')}: ${llmPresetLabel}`,
        i18n('Prompt preset paths use lodash syntax like prompts[0].content or new_chat_prompt.'),
    ];
}

function buildModelSystemPrompt() {
    return [
        'You are editing one Luker chat completion preset.',
        'Edit preset content only.',
        'Do not modify API connection, provider routing, endpoint selection, proxy settings, transport settings, or credential fields.',
        'Chat completion presets and API profiles are decoupled.',
        'Use tool calls when proposing actual preset changes.',
        'Prefer minimal edits over broad rewrites unless the user explicitly asks for a rewrite.',
        'Use lodash-style paths like new_chat_prompt or prompts[0].content.',
        'For preset_set_field, value_json must be valid JSON text.',
        'Use preset_copy_from_reference only when a selected reference preset exists and already contains the desired content.',
        'If no changes are needed, reply briefly without tool calls.',
    ].join('\n');
}

function buildConversationHistoryMessages(session) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    return messages
        .filter(item => item && typeof item === 'object' && ['user', 'assistant'].includes(String(item.role || '').trim().toLowerCase()))
        .slice(-8)
        .map((item) => ({
            role: String(item.role || 'assistant').trim().toLowerCase(),
            content: String(item.text || item.summary || '').trim(),
        }))
        .filter(item => item.content);
}

function buildUserPrompt(dialogState, userText) {
    const referencePayload = buildReferencePromptPayload(dialogState.referenceSnapshot, dialogState.liveSnapshot);
    const referenceSection = referencePayload.selected
        ? [
            `Selected reference preset: ${referencePayload.name}`,
            'Reference summary JSON:',
            '```json',
            buildJson(referencePayload),
            '```',
        ].join('\n')
        : 'Selected reference preset: none.';

    return [
        'Target preset collection: openai',
        `Target preset name: ${dialogState.targetRef?.name || ''}`,
        '',
        'Current live preset JSON:',
        '```json',
        buildJson(dialogState.liveSnapshot?.body || {}),
        '```',
        '',
        referenceSection,
        '',
        'User request:',
        String(userText || '').trim(),
    ].join('\n');
}

function buildPresetAwareMessages(context, systemPrompt, userPrompt, {
    llmPresetName = '',
    requestApi = '',
    historyMessages = null,
} = {}) {
    const messages = [
        ...(Array.isArray(historyMessages) ? historyMessages.map(item => ({ ...item })) : []),
        { role: 'system', content: String(systemPrompt || '').trim() },
        { role: 'user', content: String(userPrompt || '').trim() },
    ].filter(item => item && typeof item === 'object' && item.content);

    const selectedPromptPresetName = String(llmPresetName || '').trim();
    const envelopeApi = selectedPromptPresetName ? 'openai' : (String(requestApi || context?.mainApi || 'openai').trim() || 'openai');

    try {
        const built = context.buildPresetAwarePromptMessages({
            messages,
            envelopeOptions: {
                includeCharacterCard: true,
                api: envelopeApi,
                promptPresetName: selectedPromptPresetName,
            },
            promptPresetName: selectedPromptPresetName,
            runtimeWorldInfo: {},
        });
        if (Array.isArray(built) && built.length > 0) {
            return built;
        }
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to build preset-aware messages`, error);
    }

    return messages;
}

function getRequestPresetOptions(context = getContext()) {
    const settings = getSettings();
    const profileResolution = resolveChatCompletionRequestProfile({
        profileName: String(settings.requestApiProfileName || '').trim(),
        defaultApi: String(context?.mainApi || 'openai').trim() || 'openai',
        defaultSource: String(context?.chatCompletionSettings?.chat_completion_source || '').trim(),
    });
    return {
        llmPresetName: String(settings.requestLlmPresetName || '').trim(),
        requestApi: String(profileResolution?.requestApi || context?.mainApi || 'openai').trim() || 'openai',
        apiSettingsOverride: profileResolution?.apiSettingsOverride && typeof profileResolution.apiSettingsOverride === 'object'
            ? profileResolution.apiSettingsOverride
            : null,
    };
}

function buildAssistantTools(hasReference = false) {
    const tools = [
        {
            type: 'function',
            function: {
                name: MODEL_TOOLS.SET_FIELD,
                description: 'Set or replace one preset field using a lodash-style path. value_json must be valid JSON text.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        value_json: { type: 'string' },
                        reason: { type: 'string' },
                    },
                    required: ['path', 'value_json'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: MODEL_TOOLS.REMOVE_FIELD,
                description: 'Remove one preset field using a lodash-style path.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        reason: { type: 'string' },
                    },
                    required: ['path'],
                    additionalProperties: false,
                },
            },
        },
    ];

    if (hasReference) {
        tools.push({
            type: 'function',
            function: {
                name: MODEL_TOOLS.COPY_FROM_REFERENCE,
                description: 'Copy one field from the selected reference preset. Use from_path when source and target paths differ.',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        from_path: { type: 'string' },
                        reason: { type: 'string' },
                    },
                    required: ['path'],
                    additionalProperties: false,
                },
            },
        });
    }

    return tools;
}

async function requestToolCallsWithRetry(settings, promptMessages, {
    tools = [],
    abortSignal = null,
    llmPresetName = '',
    apiSettingsOverride = null,
} = {}) {
    const retries = Math.max(0, Math.min(TOOL_CALL_RETRY_MAX, toInteger(settings?.toolCallRetryMax, defaultSettings.toolCallRetryMax)));
    const allowedNames = new Set(tools.map(item => String(item?.function?.name || '').trim()).filter(Boolean));
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            throwIfAborted(abortSignal, 'Preset assistant request aborted.');
            const responseData = await sendOpenAIRequest('quiet', promptMessages, abortSignal, {
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
            throwIfAborted(abortSignal, 'Preset assistant request aborted.');
            const assistantText = getResponseMessageContent(responseData);
            const toolCalls = extractAllFunctionCalls(responseData, allowedNames);
            const validationError = validateParsedToolCalls(toolCalls, tools);
            if (validationError) {
                throw new Error(validationError);
            }
            return {
                assistantText,
                toolCalls,
            };
        } catch (error) {
            if (isAbortError(error, abortSignal)) {
                throw error;
            }
            lastError = error;
            if (attempt >= retries) {
                throw error;
            }
            console.warn(`[${MODULE_NAME}] Preset tool call request failed. Retrying (${attempt + 1}/${retries})...`, error);
        }
    }

    if (lastError) {
        throw lastError;
    }

    return {
        assistantText: '',
        toolCalls: [],
    };
}

function normalizeEditPath(path) {
    return String(path || '').trim();
}

function normalizeToolCallToEdit(call) {
    const name = String(call?.name || '').trim();
    const args = call?.args && typeof call.args === 'object' ? call.args : {};
    const path = normalizeEditPath(args.path);
    const reason = String(args.reason || '').trim();

    if (!path) {
        return null;
    }

    if (name === MODEL_TOOLS.SET_FIELD) {
        const rawJson = String(args.value_json || '').trim();
        if (!rawJson) {
            throw new Error(`Missing value_json for ${path}`);
        }
        let value;
        try {
            value = JSON.parse(rawJson);
        } catch (error) {
            throw new Error(`Invalid JSON for ${path}: ${error?.message || error}`);
        }
        return { kind: 'set', path, value, reason };
    }

    if (name === MODEL_TOOLS.REMOVE_FIELD) {
        return { kind: 'remove', path, fromPath: '', reason };
    }

    if (name === MODEL_TOOLS.COPY_FROM_REFERENCE) {
        return {
            kind: 'copy',
            path,
            fromPath: normalizeEditPath(args.from_path) || path,
            reason,
        };
    }

    return null;
}

function applyEditsToPreset(baseBody, edits, referenceBody = null) {
    const draftBody = clone(isPlainObject(baseBody) ? baseBody : {}, {});
    const safeReferenceBody = isPlainObject(referenceBody) ? referenceBody : null;

    for (const rawEdit of edits) {
        const edit = sanitizeEdit(rawEdit);
        if (!edit) {
            continue;
        }

        if (edit.kind === 'set') {
            lodash.set(draftBody, edit.path, clone(edit.value, edit.value));
            continue;
        }

        if (edit.kind === 'remove') {
            lodash.unset(draftBody, edit.path);
            continue;
        }

        if (edit.kind === 'copy') {
            if (!safeReferenceBody) {
                throw new Error('Reference preset is required for copy operations.');
            }
            const sourceValue = lodash.get(safeReferenceBody, edit.fromPath || edit.path);
            if (sourceValue === undefined) {
                throw new Error(`Reference path not found: ${edit.fromPath || edit.path}`);
            }
            lodash.set(draftBody, edit.path, clone(sourceValue, sourceValue));
        }
    }

    return draftBody;
}

function renderDeltaHtml(before, after) {
    const delta = diffPatcher.diff(clone(before, {}), clone(after, {}));
    if (!delta) {
        return '';
    }

    try {
        const html = diffFormatter.format(delta, clone(before, {}));
        return DOMPurify.sanitize(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ''));
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to render preset diff`, error);
        return '';
    }
}

function describeEdit(edit) {
    const safeEdit = sanitizeEdit(edit);
    if (!safeEdit) {
        return '';
    }

    if (safeEdit.kind === 'set') {
        return `${safeEdit.path} <- set`;
    }

    if (safeEdit.kind === 'remove') {
        return `${safeEdit.path} <- remove`;
    }

    return `${safeEdit.path} <- copy ${safeEdit.fromPath || safeEdit.path}`;
}

function buildDraftFromResponse(dialogState, assistantText, toolCalls) {
    const edits = toolCalls
        .map(call => normalizeToolCallToEdit(call))
        .filter(Boolean);
    if (edits.length === 0) {
        return null;
    }

    const draftBody = applyEditsToPreset(
        dialogState.liveSnapshot?.body || {},
        edits,
        dialogState.referenceSnapshot?.body || null,
    );
    if (areJsonEqual(dialogState.liveSnapshot?.body || {}, draftBody)) {
        return null;
    }

    return {
        summary: String(assistantText || '').trim() || i18nFormat('Proposed edits: ${0}', edits.length),
        assistantText: String(assistantText || '').trim(),
        edits,
        draftBody,
        createdAt: Date.now(),
        referencePresetName: String(dialogState.session?.referencePresetName || '').trim(),
    };
}

function renderMessageHtml(message) {
    const safeMessage = sanitizeMessage(message);
    const roleLabel = safeMessage.role === 'user'
        ? i18n('User')
        : (safeMessage.role === 'assistant' ? i18n('Assistant') : i18n('System'));
    const note = safeMessage.summary
        ? `<div class="cpa_message_note">${escapeHtml(safeMessage.summary)}</div>`
        : (safeMessage.editCount > 0 ? `<div class="cpa_message_note">${escapeHtml(i18nFormat('Proposed edits: ${0}', safeMessage.editCount))}</div>` : '');

    return `
<div class="cpa_message ${escapeHtml(safeMessage.role)}">
    <div class="cpa_message_meta">
        <span>${escapeHtml(roleLabel)}</span>
        <span>${escapeHtml(new Date(safeMessage.createdAt).toLocaleString())}</span>
    </div>
    <div class="cpa_message_body">${escapeHtml(safeMessage.text || safeMessage.summary || '')}</div>
    ${note}
</div>`;
}

function renderConversationHtml(session) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    if (messages.length === 0) {
        return `<div class="cpa_empty">${escapeHtml(i18n('No conversation yet.'))}</div>`;
    }
    return messages.map(item => renderMessageHtml(item)).join('');
}

function renderDraftHtml(dialogState) {
    const draft = sanitizeDraft(dialogState.session?.draft);
    if (!draft) {
        return `
<div class="cpa_empty">${escapeHtml(i18n('No draft yet. Ask the assistant to propose changes first.'))}</div>`;
    }

    const diffHtml = renderDeltaHtml(dialogState.liveSnapshot?.body || {}, draft.draftBody || {});
    const editItems = draft.edits.map((edit) => `<li>${escapeHtml(describeEdit(edit))}</li>`).join('');
    return `
<div class="cpa_draft_summary">
    <div class="cpa_draft_summary_badge">${escapeHtml(i18n('Draft ready'))}</div>
    <div class="cpa_draft_summary_badge">${escapeHtml(i18nFormat('Proposed edits: ${0}', draft.edits.length))}</div>
</div>
<div>${escapeHtml(draft.summary || i18n('Change summary'))}</div>
<div class="cpa_draft_actions">
    <div class="menu_button menu_button_small" data-cpa-action="apply-draft">${escapeHtml(i18n('Apply draft'))}</div>
    <div class="menu_button menu_button_small" data-cpa-action="discard-draft">${escapeHtml(i18n('Discard draft'))}</div>
</div>
<div class="cpa_diff_panel">${diffHtml || `<div class="cpa_empty">${escapeHtml(i18n('No diff to display.'))}</div>`}</div>
<details>
    <summary>${escapeHtml(i18n('Change summary'))}</summary>
    <ul>${editItems || `<li>${escapeHtml(i18n('No meaningful changes detected.'))}</li>`}</ul>
</details>`;
}

function renderDialogHtml(dialogState) {
    const referenceNames = getOpenAIPresetNames(dialogState.context)
        .filter(name => name && name !== dialogState.targetRef?.name);
    const metaItems = buildDialogMetaItems(dialogState);
    const settings = getSettings();
    const isBusy = Boolean(dialogState.busy);

    return `
<div class="cpa_dialog">
    <div class="cpa_dialog_meta">
        ${metaItems.map(item => `<div class="cpa_dialog_meta_item">${escapeHtml(item)}</div>`).join('')}
    </div>
    <div class="cpa_dialog_toolbar">
        <label for="cpa_reference_preset">${escapeHtml(i18n('Reference preset'))}</label>
        <select id="cpa_reference_preset" class="text_pole" title="${escapeHtml(i18n('Select reference preset'))}">
            ${renderSelectOptions(referenceNames, dialogState.session?.referencePresetName || '', true)}
        </select>
        <div class="menu_button menu_button_small" data-cpa-action="show-reference-diff">${escapeHtml(i18n('Reference diff'))}</div>
        <div class="menu_button menu_button_small" data-cpa-action="refresh-live">${escapeHtml(i18n('Refresh live preset'))}</div>
        <div class="menu_button menu_button_small" data-cpa-action="clear-history">${escapeHtml(i18n('Clear history'))}</div>
    </div>
    <div class="cpa_dialog_columns">
        <div class="cpa_conversation_panel">
            <div class="cpa_panel_title">${escapeHtml(i18n('Conversation'))}</div>
            <div class="cpa_conversation_list">${renderConversationHtml(dialogState.session)}</div>
        </div>
        <div class="cpa_draft_panel">
            <div class="cpa_panel_title">${escapeHtml(i18n('Draft diff'))}</div>
            ${renderDraftHtml(dialogState)}
        </div>
    </div>
    <div class="cpa_dialog_footer">
        <textarea id="cpa_dialog_input" class="text_pole" placeholder="${escapeHtml(i18n('Type what to change in this preset...'))}">${escapeHtml(dialogState.inputText || '')}</textarea>
        <div class="cpa_dialog_footer_actions">
            <div class="cpa_hint">${escapeHtml(dialogState.status || '')}</div>
            <div class="cpa_hint">${escapeHtml(`LLM: ${settings.requestLlmPresetName || i18n('(none)')}`)}</div>
            <div class="menu_button" data-cpa-action="send-or-stop">${escapeHtml(isBusy ? i18n('Stop') : i18n('Send'))}</div>
        </div>
    </div>
</div>`;
}

function appendSessionMessage(session, message) {
    const settings = getSettings();
    const messages = Array.isArray(session?.messages) ? session.messages.slice() : [];
    messages.push(sanitizeMessage(message));
    return {
        ...session,
        messages: messages.slice(-settings.sessionMessageLimit),
    };
}

async function rerenderDialog(dialogState) {
    if (!dialogState?.root) {
        return;
    }
    dialogState.root.html(renderDialogHtml(dialogState));
}

async function refreshReferenceSnapshot(dialogState) {
    const referenceName = String(dialogState.session?.referencePresetName || '').trim();
    if (!referenceName) {
        dialogState.referenceSnapshot = null;
        return;
    }

    const snapshot = dialogState.context.presets.getStored({
        collection: 'openai',
        name: referenceName,
    });
    dialogState.referenceSnapshot = snapshot && typeof snapshot === 'object' ? clone(snapshot, null) : null;
}

function getPresetSelectionDriftMessage() {
    return i18n('Selected preset changed outside the assistant. Reopen the assistant on the desired preset.');
}

function getPresetEventCollection(event = null) {
    return String(event?.collection || event?.apiId || '').trim();
}

async function readValidatedLiveSnapshot(dialogState) {
    const currentTargetRef = getCurrentTargetRef(dialogState.context);
    const currentLiveSnapshot = getCurrentLiveSnapshot(dialogState.context);
    if (!currentTargetRef || !currentLiveSnapshot?.stored) {
        throw new Error(i18n('Current preset is not a stored chat completion preset. Please select a saved preset first.'));
    }
    if (
        currentTargetRef.collection !== dialogState.targetRef?.collection
        || currentTargetRef.name !== dialogState.targetRef?.name
    ) {
        throw new Error(getPresetSelectionDriftMessage());
    }
    return clone(currentLiveSnapshot, null);
}

async function refreshLiveSnapshot(dialogState) {
    dialogState.liveSnapshot = await readValidatedLiveSnapshot(dialogState);
    return dialogState.liveSnapshot;
}

async function persistDialogSession(dialogState) {
    dialogState.session = await saveSession(dialogState.context, dialogState.targetRef, dialogState.session);
}

async function handleReferenceChange(dialogState, selectValue) {
    dialogState.session.referencePresetName = String(selectValue || '').trim();
    await refreshReferenceSnapshot(dialogState);
    await persistDialogSession(dialogState);
    await rerenderDialog(dialogState);
}

async function showDiffPopup(title, beforeLabel, afterLabel, beforeBody, afterBody) {
    const diffHtml = renderDeltaHtml(beforeBody, afterBody);
    const content = `
<div class="cpa_dialog">
    <div class="cpa_dialog_meta">
        <div class="cpa_dialog_meta_item">${escapeHtml(beforeLabel)}</div>
        <div class="cpa_dialog_meta_item">${escapeHtml(afterLabel)}</div>
    </div>
    <div class="cpa_diff_panel">${diffHtml || `<div class="cpa_empty">${escapeHtml(i18n('No diff to display.'))}</div>`}</div>
</div>`;
    const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: 'Close',
        wider: true,
        large: true,
        allowVerticalScrolling: true,
    });
    await popup.show();
}

async function handleReferenceDiff(dialogState) {
    if (!dialogState.referenceSnapshot) {
        toastr.info(i18n('No reference diff available.'));
        return;
    }
    await showDiffPopup(
        i18nFormat('Reference diff: ${0} -> ${1}', dialogState.targetRef.name, dialogState.referenceSnapshot.ref.name),
        dialogState.targetRef.name,
        dialogState.referenceSnapshot.ref.name,
        dialogState.liveSnapshot?.body || {},
        dialogState.referenceSnapshot.body || {},
    );
}

async function handleDiscardDraft(dialogState, { silent = false } = {}) {
    if (!dialogState.session?.draft) {
        return;
    }
    if (!silent) {
        const confirmed = await Popup.show.confirm(i18n('Discard current draft?'), '');
        if (!confirmed) {
            return;
        }
    }
    dialogState.session.draft = null;
    dialogState.status = i18n('Draft discarded.');
    await persistDialogSession(dialogState);
    await rerenderDialog(dialogState);
}

async function handleClearHistory(dialogState) {
    const confirmed = await Popup.show.confirm(i18n('Clear this preset assistant history and draft?'), '');
    if (!confirmed) {
        return;
    }
    dialogState.session = createEmptySession();
    dialogState.referenceSnapshot = null;
    dialogState.status = i18n('Session history cleared.');
    await persistDialogSession(dialogState);
    await rerenderDialog(dialogState);
}

async function handleRefreshLive(dialogState) {
    if (dialogState.session?.draft) {
        const confirmed = await Popup.show.confirm(i18n('Refreshing live preset will discard the current draft. Continue?'), '');
        if (!confirmed) {
            return;
        }
        dialogState.session.draft = null;
    }
    await refreshLiveSnapshot(dialogState);
    dialogState.status = i18n('Live snapshot refreshed.');
    await refreshReferenceSnapshot(dialogState);
    await persistDialogSession(dialogState);
    await rerenderDialog(dialogState);
}

async function handleApplyDraft(dialogState) {
    const draft = sanitizeDraft(dialogState.session?.draft);
    if (!draft) {
        return;
    }
    dialogState.busy = true;
    dialogState.status = i18n('Applying draft...');
    await rerenderDialog(dialogState);
    try {
        const currentLiveSnapshot = await readValidatedLiveSnapshot(dialogState);
        if (!areJsonEqual(currentLiveSnapshot.body || {}, dialogState.liveSnapshot?.body || {})) {
            throw new Error(i18n('Current live preset changed since this draft was created. Refresh live and request a new draft.'));
        }
        const result = await dialogState.context.presets.save(
            { collection: 'openai', name: dialogState.targetRef.name },
            draft.draftBody,
            { select: true },
        );
        if (!result?.ok) {
            throw new Error(i18n('Save failed.'));
        }
        await refreshLiveSnapshot(dialogState);
        dialogState.session = appendSessionMessage(dialogState.session, {
            role: 'system',
            text: i18n('Applied draft to preset.'),
            summary: i18n('Applied'),
        });
        dialogState.session.draft = null;
        dialogState.status = i18n('Applied draft to preset.');
        await persistDialogSession(dialogState);
    } catch (error) {
        dialogState.status = i18nFormat('AI request failed: ${0}', error?.message || error);
        console.error(`[${MODULE_NAME}] Failed to apply preset draft`, error);
    } finally {
        dialogState.busy = false;
        await rerenderDialog(dialogState);
    }
}

async function handleSend(dialogState) {
    if (dialogState.busy) {
        dialogState.abortController?.abort?.();
        return;
    }

    const inputText = String(dialogState.inputText || '').trim();
    if (!inputText) {
        toastr.warning(i18n('Please enter a request first.'));
        return;
    }

    let historyMessages = [];
    try {
        await refreshLiveSnapshot(dialogState);
        await refreshReferenceSnapshot(dialogState);
        historyMessages = buildConversationHistoryMessages(dialogState.session);
    } catch (error) {
        dialogState.status = String(error?.message || error || '');
        console.warn(`[${MODULE_NAME}] Preset assistant send preflight failed`, error);
        await rerenderDialog(dialogState);
        return;
    }

    dialogState.session = appendSessionMessage(dialogState.session, {
        role: 'user',
        text: inputText,
    });
    dialogState.inputText = '';
    dialogState.busy = true;
    dialogState.status = i18n('Assistant is thinking...');
    dialogState.abortController = new AbortController();
    await persistDialogSession(dialogState);
    await rerenderDialog(dialogState);

    try {
        const requestOptions = getRequestPresetOptions(dialogState.context);
        const tools = buildAssistantTools(Boolean(dialogState.referenceSnapshot));
        const promptMessages = buildPresetAwareMessages(
            dialogState.context,
            buildModelSystemPrompt(),
            buildUserPrompt(dialogState, inputText),
            {
                llmPresetName: requestOptions.llmPresetName,
                requestApi: requestOptions.requestApi,
                historyMessages,
            },
        );
        const response = await requestToolCallsWithRetry(getSettings(), promptMessages, {
            tools,
            abortSignal: dialogState.abortController.signal,
            llmPresetName: requestOptions.llmPresetName,
            apiSettingsOverride: requestOptions.apiSettingsOverride,
        });
        const draft = buildDraftFromResponse(dialogState, response.assistantText, response.toolCalls);
        dialogState.session = appendSessionMessage(dialogState.session, {
            role: 'assistant',
            text: String(response.assistantText || '').trim() || (draft ? i18n('Draft ready') : i18n('No changes proposed')),
            summary: draft?.summary || '',
            editCount: draft?.edits?.length || 0,
        });
        dialogState.session.draft = draft;
        dialogState.status = draft
            ? i18nFormat('Proposed edits: ${0}', draft.edits.length)
            : i18n('No meaningful changes detected.');
        await persistDialogSession(dialogState);
    } catch (error) {
        if (isAbortError(error, dialogState.abortController?.signal)) {
            dialogState.status = i18n('Request stopped.');
        } else {
            console.error(`[${MODULE_NAME}] Preset assistant request failed`, error);
            dialogState.session = appendSessionMessage(dialogState.session, {
                role: 'system',
                text: i18nFormat('AI request failed: ${0}', error?.message || error),
            });
            dialogState.status = i18nFormat('AI request failed: ${0}', error?.message || error);
            await persistDialogSession(dialogState);
        }
    } finally {
        dialogState.busy = false;
        dialogState.abortController = null;
        await rerenderDialog(dialogState);
    }
}

function bindDialogEvents(dialogState) {
    if (!dialogState?.root) {
        return;
    }

    dialogState.root.off('.cpaDialog');
    dialogState.root.on('input.cpaDialog', '#cpa_dialog_input', function () {
        dialogState.inputText = String(jQuery(this).val() || '');
    });
    dialogState.root.on('change.cpaDialog', '#cpa_reference_preset', async function () {
        await handleReferenceChange(dialogState, jQuery(this).val());
    });
    dialogState.root.on('click.cpaDialog', '[data-cpa-action="send-or-stop"]', async function () {
        await handleSend(dialogState);
    });
    dialogState.root.on('click.cpaDialog', '[data-cpa-action="apply-draft"]', async function () {
        await handleApplyDraft(dialogState);
    });
    dialogState.root.on('click.cpaDialog', '[data-cpa-action="discard-draft"]', async function () {
        await handleDiscardDraft(dialogState);
    });
    dialogState.root.on('click.cpaDialog', '[data-cpa-action="show-reference-diff"]', async function () {
        await handleReferenceDiff(dialogState);
    });
    dialogState.root.on('click.cpaDialog', '[data-cpa-action="refresh-live"]', async function () {
        await handleRefreshLive(dialogState);
    });
    dialogState.root.on('click.cpaDialog', '[data-cpa-action="clear-history"]', async function () {
        await handleClearHistory(dialogState);
    });
}

async function openAssistantPopup() {
    const context = getContext();
    const targetRef = getCurrentTargetRef(context);
    const liveSnapshot = getCurrentLiveSnapshot(context);

    if (!targetRef || !liveSnapshot?.stored) {
        toastr.warning(i18n('Current preset is not a stored chat completion preset. Please select a saved preset first.'));
        return;
    }

    if (activeDialogState?.popup) {
        activeDialogState.popup.dlg?.focus?.();
        return;
    }

    const session = await loadSession(context, targetRef);
    const dialogState = {
        context,
        popup: null,
        root: null,
        targetRef,
        liveSnapshot,
        session,
        referenceSnapshot: null,
        busy: false,
        status: '',
        inputText: '',
        abortController: null,
    };

    await refreshReferenceSnapshot(dialogState);

    const popup = new Popup('<div id="completion_preset_assistant_dialog_root"></div>', POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: 'Close',
        wider: true,
        large: true,
        allowVerticalScrolling: true,
        onOpen: async (instance) => {
            dialogState.popup = instance;
            dialogState.root = jQuery(instance.dlg).find('#completion_preset_assistant_dialog_root');
            bindDialogEvents(dialogState);
            await rerenderDialog(dialogState);
        },
        onClose: () => {
            dialogState.abortController?.abort?.();
            if (activeDialogState === dialogState) {
                activeDialogState = null;
            }
        },
    });

    activeDialogState = dialogState;
    dialogState.popup = popup;
    void popup.show();
}

function ensureOpenAiToolbarButton() {
    const toolbar = jQuery('#openai_api-presets .flex-container.marginLeft5.gap3px').first();
    if (!toolbar.length || toolbar.find(`#${OPENAI_BUTTON_ID}`).length) {
        return;
    }

    toolbar.append(`
<div id="${OPENAI_BUTTON_ID}" class="menu_button menu_button_icon completion-preset-assistant-open" title="${escapeHtml(i18n('Open Assistant'))}">
    <i class="fa-fw fa-solid fa-wand-magic-sparkles"></i>
</div>`);
}

function refreshUiState(context = getContext()) {
    ensureSettings();
    ensureOpenAiToolbarButton();
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    const settings = getSettings();
    root.find('#cpa_request_llm_preset').html(renderSelectOptions(getOpenAIPresetNames(context), settings.requestLlmPresetName, true));
    root.find('#cpa_request_api_profile').html(renderSelectOptions(getConnectionProfileNames(), settings.requestApiProfileName, true));
    root.find('#cpa_tool_retries').val(String(settings.toolCallRetryMax));
    root.find('#cpa_session_message_limit').val(String(settings.sessionMessageLimit));
}

function bindUi() {
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    root.off('.cpa');
    jQuery(document).off('.cpaOpen');

    root.on('click.cpa', `#${OPEN_BUTTON_ID}`, async function () {
        await openAssistantPopup();
    });
    root.on('change.cpa', '#cpa_request_llm_preset', function () {
        getSettings().requestLlmPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });
    root.on('change.cpa', '#cpa_request_api_profile', function () {
        getSettings().requestApiProfileName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });
    root.on('change.cpa', '#cpa_tool_retries', function () {
        getSettings().toolCallRetryMax = Math.max(0, Math.min(TOOL_CALL_RETRY_MAX, toInteger(jQuery(this).val(), defaultSettings.toolCallRetryMax)));
        saveSettingsDebounced();
        refreshUiState();
    });
    root.on('change.cpa', '#cpa_session_message_limit', function () {
        getSettings().sessionMessageLimit = Math.max(
            SESSION_MESSAGE_LIMIT_MIN,
            Math.min(SESSION_MESSAGE_LIMIT_MAX, toInteger(jQuery(this).val(), defaultSettings.sessionMessageLimit)),
        );
        saveSettingsDebounced();
        refreshUiState();
    });

    jQuery(document).on('click.cpaOpen', `#${OPENAI_BUTTON_ID}`, async function () {
        await openAssistantPopup();
    });
}

function ensureUi() {
    const host = jQuery('#extensions_settings2');
    if (!host.length) {
        return;
    }

    ensureOpenAiToolbarButton();
    if (jQuery(`#${UI_BLOCK_ID}`).length) {
        bindUi();
        refreshUiState();
        return;
    }

    host.append(`
<div id="${UI_BLOCK_ID}" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${escapeHtml(i18n('Completion Preset Assistant'))}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="cpa_row">
                <div id="${OPEN_BUTTON_ID}" class="menu_button">${escapeHtml(i18n('Open Assistant'))}</div>
            </div>
            <div class="cpa_hint">${escapeHtml(i18n('Works on saved Chat Completion presets. Character-bound runtime presets are read-only for this MVP.'))}</div>
            <label for="cpa_request_llm_preset">${escapeHtml(i18n('Model request LLM preset name'))}</label>
            <select id="cpa_request_llm_preset" class="text_pole"></select>
            <label for="cpa_request_api_profile">${escapeHtml(i18n('Model request API profile'))}</label>
            <select id="cpa_request_api_profile" class="text_pole"></select>
            <label for="cpa_tool_retries">${escapeHtml(i18n('Tool-call retries on invalid/missing tool call (N)'))}</label>
            <input id="cpa_tool_retries" class="text_pole" type="number" min="0" max="${TOOL_CALL_RETRY_MAX}" step="1"/>
            <label for="cpa_session_message_limit">${escapeHtml(i18n('Stored session messages per preset'))}</label>
            <input id="cpa_session_message_limit" class="text_pole" type="number" min="${SESSION_MESSAGE_LIMIT_MIN}" max="${SESSION_MESSAGE_LIMIT_MAX}" step="1"/>
        </div>
    </div>
</div>`);

    bindUi();
    refreshUiState();
}

jQuery(async () => {
    registerLocaleData();
    ensureSettings();
    ensureUi();
    const context = getContext();
    context.eventSource.on(context.eventTypes.PRESET_CHANGED, (event) => {
        if (getPresetEventCollection(event) === 'openai') {
            refreshUiState();
        }
    });
    context.eventSource.on(context.eventTypes.PRESET_RENAMED, (event) => {
        if (getPresetEventCollection(event) === 'openai') {
            refreshUiState();
        }
    });
    context.eventSource.on(context.eventTypes.PRESET_DELETED, (event) => {
        if (getPresetEventCollection(event) === 'openai') {
            refreshUiState();
        }
    });
    const connectionProfileEvents = [
        context.eventTypes.CONNECTION_PROFILE_LOADED,
        context.eventTypes.CONNECTION_PROFILE_CREATED,
        context.eventTypes.CONNECTION_PROFILE_DELETED,
        context.eventTypes.CONNECTION_PROFILE_UPDATED,
    ].filter(Boolean);
    for (const eventName of connectionProfileEvents) {
        context.eventSource.on(eventName, () => refreshUiState());
    }
});
