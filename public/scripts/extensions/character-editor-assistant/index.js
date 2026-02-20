// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

import {
    CONNECT_API_MAP,
    converter,
    saveSettingsDebounced,
    select_selected_character,
} from '../../../script.js';
import { DOMPurify } from '../../../lib.js';
import { chat_completion_sources, proxies, sendOpenAIRequest } from '../../openai.js';
import { extension_settings, getContext } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../popup.js';
import { convertCharacterBook, deleteWorldInfo, newWorldInfoEntryTemplate, reloadEditor, setWorldInfoButtonClass, updateWorldInfoList } from '../../world-info.js';

const MODULE_NAME = 'character_editor_assistant';
const UI_BLOCK_ID = 'character_editor_assistant_settings';
const STYLE_ID = 'character_editor_assistant_style';

const TOOL_NAMES = Object.freeze({
    UPDATE_FIELDS: 'luker_card_update_fields',
    SET_PRIMARY_BOOK: 'luker_card_set_primary_lorebook',
    UPSERT_ENTRY: 'luker_card_upsert_lorebook_entry',
    DELETE_ENTRY: 'luker_card_delete_lorebook_entry',
});

const defaultSettings = {
    replaceLorebookSyncEnabled: true,
    lorebookSyncLlmPresetName: '',
    lorebookSyncApiPresetName: '',
    plainTextFunctionCallMode: false,
    toolCallRetryMax: 2,
    maxJournalEntries: 120,
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

const stateCache = new Map();
const lorebookSnapshotCache = new Map();
const lorebookSyncDialogLocks = new Set();
const editorStudioDialogLocks = new Set();

function isPlainTextFunctionCallModeEnabled(settings = null) {
    const currentSettings = settings && typeof settings === 'object' ? settings : getSettings();
    return Boolean(currentSettings?.plainTextFunctionCallMode);
}

function i18n(text) {
    return translate(String(text || ''));
}

function i18nFormat(text, ...values) {
    return i18n(text).replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));
}

function registerLocaleData() {
    addLocaleData('zh-cn', {
        'Character Editor Assistant': '角色卡编辑助手',
        'Open Editor': '打开编辑器',
        'Character Editor': '角色编辑器',
        'Enable lorebook sync popup after Replace/Update': '替换/更新角色卡后启用世界书同步弹窗',
        'Model request LLM preset name': '模型请求 LLM 预设名',
        'Model request API preset name': '模型请求 API 预设名',
        'Plain-text function-call mode': '纯文本函数调用模式',
        'Tool-call retries on invalid/missing tool call (N)': '工具调用重试次数（无效/缺失时）',
        'Refresh': '刷新',
        'History': '修改历史',
        'Approve': '批准',
        'Reject': '拒绝',
        'View diff': '查看 diff',
        'Rollback': '回滚',
        'Delete': '删除',
        'Clear history': '清空历史',
        'No history yet.': '暂无历史记录。',
        'Character editor tools are ready.': '角色编辑工具已就绪。',
        'Current chat has no active character.': '当前聊天没有活动角色卡。',
        'Operation applied: ${0}': '操作已生效：${0}',
        'Rollback completed.': '回滚完成。',
        'Rollback failed: ${0}': '回滚失败：${0}',
        'Before': '修改前',
        'After': '修改后',
        'Line diff': '逐行差异',
        'Line diff (+${0} -${1})': '逐行差异（+${0} -${1}）',
        'Expand diff': '放大查看',
        'Close expanded diff': '关闭放大视图',
        '...(${0} more lines)': '...（还有 ${0} 行）',
        'No meaningful changes detected.': '未检测到可展示的变更。',
        'Target lorebook': '目标世界书',
        'Entry UID': '条目 UID',
        '(empty)': '（空）',
        '(deleted)': '（已删除）',
        '(missing lorebook)': '（世界书不存在）',
        'Old lorebook': '旧世界书',
        'New lorebook': '新世界书',
        'Candidate sync operations': '候选同步操作',
        'Lorebook sync result: applied ${0}, failed ${1}': '世界书同步结果：已生效 ${0}，失败 ${1}',
        'A lorebook sync dialog is already open for this character.': '该角色已有世界书同步弹窗正在处理中。',
        'An editor is already open for this character.': '该角色已有编辑器正在处理中。',
        'Save and update': '保存并更新',
        'Cancel and restore previous lorebook': '取消并恢复旧世界书',
        'Analyze then update': '模型分析后更新',
        'Direct replace': '直接替换',
        'Do not replace': '不替换',
        'Choose how to handle lorebook update': '请选择世界书更新方式',
        'No replacement applied. Restored previous lorebook binding: ${0}': '未执行替换，已恢复旧世界书绑定：${0}',
        'Review model analysis and optionally add requirements. Save will apply model edits; cancel will restore the previous lorebook.': '请查看模型分析并可补充要求。点“保存并更新”将应用模型修改；点“取消并恢复旧世界书”会恢复导入前绑定。',
        'Analyzing lorebook differences with model...': '正在用模型分析世界书差异...',
        'Model analysis failed: ${0}': '模型分析失败：${0}',
        'No analysis output.': '模型未返回分析内容。',
        'Model analysis is still running. Please wait or cancel to restore previous lorebook.': '模型分析仍在进行中。请等待或取消并恢复旧世界书。',
        'Finalize lorebook replacement: ${0} -> ${1}': '世界书替换完成：${0} -> ${1}',
        'Lorebook finalization skipped due failed operations.': '存在失败操作，已跳过世界书最终替换。',
        'Send': '发送',
        'Type your requirement to continue this conversation...': '输入你的要求继续对话...',
        'Assistant is thinking...': '模型思考中...',
        'Applying approved changes...': '正在应用已批准变更...',
        'Message cannot be empty.': '消息不能为空。',
        'Model reply failed: ${0}': '模型回复失败：${0}',
        'Round diff': '本轮差异',
        'Round diff (${0} operations)': '本轮差异（${0} 个操作）',
        'No draft operations proposed in this round.': '本轮没有拟议变更。',
        'Proposed ${0} operations in this round.': '本轮拟议 ${0} 个操作。',
        'Operation ${0}': '操作 ${0}',
        'Raw arguments': '原始参数',
        'Rollback to this round': '回退到本轮',
        'Rolled back to selected round.': '已回退到所选轮次。',
        'Pending review': '待审批',
        'Approved': '已通过',
        'Rejected': '已拒绝',
        'All final diffs must be reviewed before saving.': '保存前必须处理所有最终差异项（通过或拒绝）。',
        'No approved diff to apply. Finalizing without additional changes.': '没有已通过差异项，将直接完成同步且不追加修改。',
        'Please approve or reject pending changes first.': '请先批准或拒绝待审批变更。',
        'AI proposed changes are waiting for approval.': 'AI 提出的变更正在等待审批。',
        'Approve batch': '批准本批次',
        'Reject batch': '拒绝本批次',
        'Changes applied.': '变更已应用。',
        'Changes rejected.': '变更已拒绝。',
        'Apply failed: ${0}': '应用失败：${0}',
        'Delete this history record?': '删除这条历史记录？',
        'Clear all history records?': '清空所有历史记录？',
        'History record deleted.': '历史记录已删除。',
        'History cleared.': '历史记录已清空。',
        'Delete failed: ${0}': '删除失败：${0}',
        'Clear failed: ${0}': '清空失败：${0}',
        '(Current preset)': '（当前预设）',
        '(Current API config)': '（当前 API 配置）',
        '(missing)': '（缺失）',
    });
    addLocaleData('zh-tw', {
        'Character Editor Assistant': '角色卡編輯助手',
        'Open Editor': '開啟編輯器',
        'Character Editor': '角色編輯器',
        'Enable lorebook sync popup after Replace/Update': '替換/更新角色卡後啟用世界書同步彈窗',
        'Model request LLM preset name': '模型請求 LLM 預設名',
        'Model request API preset name': '模型請求 API 預設名',
        'Plain-text function-call mode': '純文本函數調用模式',
        'Tool-call retries on invalid/missing tool call (N)': '工具調用重試次數（無效/缺失時）',
        'Refresh': '刷新',
        'History': '修改歷史',
        'Approve': '批准',
        'Reject': '拒絕',
        'View diff': '查看 diff',
        'Rollback': '回滾',
        'Delete': '刪除',
        'Clear history': '清空歷史',
        'No history yet.': '暫無歷史記錄。',
        'Character editor tools are ready.': '角色編輯工具已就緒。',
        'Current chat has no active character.': '當前聊天沒有活動角色卡。',
        'Operation applied: ${0}': '操作已生效：${0}',
        'Rollback completed.': '回滾完成。',
        'Rollback failed: ${0}': '回滾失敗：${0}',
        'Before': '修改前',
        'After': '修改後',
        'Line diff': '逐行差異',
        'Line diff (+${0} -${1})': '逐行差異（+${0} -${1}）',
        'Expand diff': '放大查看',
        'Close expanded diff': '關閉放大視圖',
        '...(${0} more lines)': '...（還有 ${0} 行）',
        'No meaningful changes detected.': '未檢測到可展示的變更。',
        'Target lorebook': '目標世界書',
        'Entry UID': '條目 UID',
        '(empty)': '（空）',
        '(deleted)': '（已刪除）',
        '(missing lorebook)': '（世界書不存在）',
        'Old lorebook': '舊世界書',
        'New lorebook': '新世界書',
        'Candidate sync operations': '候選同步操作',
        'Lorebook sync result: applied ${0}, failed ${1}': '世界書同步結果：已生效 ${0}，失敗 ${1}',
        'A lorebook sync dialog is already open for this character.': '該角色已有世界書同步彈窗正在處理中。',
        'An editor is already open for this character.': '該角色已有編輯器正在處理中。',
        'Save and update': '儲存並更新',
        'Cancel and restore previous lorebook': '取消並恢復舊世界書',
        'Analyze then update': '模型分析後更新',
        'Direct replace': '直接替換',
        'Do not replace': '不替換',
        'Choose how to handle lorebook update': '請選擇世界書更新方式',
        'No replacement applied. Restored previous lorebook binding: ${0}': '未執行替換，已恢復舊世界書綁定：${0}',
        'Review model analysis and optionally add requirements. Save will apply model edits; cancel will restore the previous lorebook.': '請查看模型分析並可補充要求。按「儲存並更新」將套用模型修改；按「取消並恢復舊世界書」會恢復匯入前綁定。',
        'Analyzing lorebook differences with model...': '正在用模型分析世界書差異...',
        'Model analysis failed: ${0}': '模型分析失敗：${0}',
        'No analysis output.': '模型未回傳分析內容。',
        'Model analysis is still running. Please wait or cancel to restore previous lorebook.': '模型分析仍在進行中。請等待或取消並恢復舊世界書。',
        'Finalize lorebook replacement: ${0} -> ${1}': '世界書替換完成：${0} -> ${1}',
        'Lorebook finalization skipped due failed operations.': '存在失敗操作，已跳過世界書最終替換。',
        'Send': '發送',
        'Type your requirement to continue this conversation...': '輸入你的要求繼續對話...',
        'Assistant is thinking...': '模型思考中...',
        'Applying approved changes...': '正在套用已批准變更...',
        'Message cannot be empty.': '訊息不能為空。',
        'Model reply failed: ${0}': '模型回覆失敗：${0}',
        'Round diff': '本輪差異',
        'Round diff (${0} operations)': '本輪差異（${0} 個操作）',
        'No draft operations proposed in this round.': '本輪沒有擬議變更。',
        'Proposed ${0} operations in this round.': '本輪擬議 ${0} 個操作。',
        'Operation ${0}': '操作 ${0}',
        'Raw arguments': '原始參數',
        'Rollback to this round': '回退到本輪',
        'Rolled back to selected round.': '已回退到所選輪次。',
        'Pending review': '待審批',
        'Approved': '已通過',
        'Rejected': '已拒絕',
        'All final diffs must be reviewed before saving.': '儲存前必須處理所有最終差異項（通過或拒絕）。',
        'No approved diff to apply. Finalizing without additional changes.': '沒有已通過差異項，將直接完成同步且不追加修改。',
        'Please approve or reject pending changes first.': '請先批准或拒絕待審批變更。',
        'AI proposed changes are waiting for approval.': 'AI 提出的變更正在等待審批。',
        'Approve batch': '批准本批次',
        'Reject batch': '拒絕本批次',
        'Changes applied.': '變更已套用。',
        'Changes rejected.': '變更已拒絕。',
        'Apply failed: ${0}': '套用失敗：${0}',
        'Delete this history record?': '刪除這條歷史記錄？',
        'Clear all history records?': '清空所有歷史記錄？',
        'History record deleted.': '歷史記錄已刪除。',
        'History cleared.': '歷史記錄已清空。',
        'Delete failed: ${0}': '刪除失敗：${0}',
        'Clear failed: ${0}': '清空失敗：${0}',
        '(Current preset)': '（目前預設）',
        '(Current API config)': '（目前 API 配置）',
        '(missing)': '（缺失）',
    });
}

function clone(value) {
    if (value === undefined) {
        return undefined;
    }
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function notifySuccess(message) {
    if (typeof toastr !== 'undefined') {
        toastr.success(String(message || ''));
    }
}

function notifyWarning(message) {
    if (typeof toastr !== 'undefined') {
        toastr.warning(String(message || ''));
    }
}

function notifyError(message) {
    if (typeof toastr !== 'undefined') {
        toastr.error(String(message || ''));
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseCsvList(value) {
    return String(value ?? '')
        .split(',')
        .map(item => normalizeText(item))
        .filter(Boolean);
}

function asFiniteInteger(value, fallback = null) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return fallback;
    }
    return Math.floor(num);
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = clone(defaultSettings);
    }
    const settings = extension_settings[MODULE_NAME];
    settings.replaceLorebookSyncEnabled = settings.replaceLorebookSyncEnabled !== false;
    settings.lorebookSyncLlmPresetName = String(settings.lorebookSyncLlmPresetName || '').trim();
    settings.lorebookSyncApiPresetName = String(settings.lorebookSyncApiPresetName || '').trim();
    settings.plainTextFunctionCallMode = Boolean(settings.plainTextFunctionCallMode);
    settings.toolCallRetryMax = Math.max(0, Math.min(10, Math.floor(Number(settings.toolCallRetryMax || defaultSettings.toolCallRetryMax) || 0)));
    settings.maxJournalEntries = Math.max(20, Math.min(500, Number(settings.maxJournalEntries || defaultSettings.maxJournalEntries)));
}

function getSettings() {
    ensureSettings();
    return extension_settings[MODULE_NAME];
}

function getConnectionProfiles() {
    const profiles = extension_settings?.connectionManager?.profiles;
    if (!Array.isArray(profiles)) {
        return [];
    }
    return profiles
        .filter(profile => profile && typeof profile === 'object' && String(profile.mode || '') === 'cc');
}

function getConnectionProfileByName(name = '') {
    const target = String(name || '').trim();
    if (!target) {
        return null;
    }
    return getConnectionProfiles().find(profile => String(profile.name || '').trim() === target) || null;
}

function resolveChatSourceFromApiAlias(value, defaultSource = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return String(defaultSource || '').trim();
    }

    if (API_ALIAS_TO_CHAT_SOURCE[normalized]) {
        return API_ALIAS_TO_CHAT_SOURCE[normalized];
    }

    const mapEntry = Object.entries(CONNECT_API_MAP || {})
        .find(([alias]) => String(alias || '').toLowerCase() === normalized)?.[1];
    if (mapEntry?.selected === 'openai' && mapEntry?.source) {
        return String(mapEntry.source);
    }

    return String(defaultSource || '').trim();
}

function resolveRequestApiFromConnectionProfileName(context, profileName = '') {
    const defaultApi = String(context?.mainApi || 'openai').trim() || 'openai';
    const profile = getConnectionProfileByName(profileName);
    if (!profile) {
        return defaultApi;
    }

    const alias = String(profile.api || '').trim().toLowerCase();
    if (!alias) {
        return defaultApi;
    }

    const mapEntry = CONNECT_API_MAP?.[alias];
    const selectedApi = String(mapEntry?.selected || '').trim();
    if (selectedApi) {
        return selectedApi;
    }

    if (alias === 'koboldhorde') {
        return 'kobold';
    }
    return defaultApi;
}

function buildApiSettingsOverrideFromConnectionProfileName(profileName, defaultSource = '') {
    const profile = getConnectionProfileByName(profileName);
    if (!profile) {
        return null;
    }

    const overrides = {};
    const source = resolveChatSourceFromApiAlias(profile.api, defaultSource);
    if (source) {
        overrides.chat_completion_source = source;
    }

    const resolvedSource = String(source || defaultSource || '').trim();
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
        const proxyPreset = proxies.find(item => String(item?.name || '').trim() === proxyName);
        if (proxyPreset) {
            overrides.reverse_proxy = String(proxyPreset.url || '');
            overrides.proxy_password = String(proxyPreset.password || '');
        }
    }

    return Object.keys(overrides).length > 0 ? overrides : null;
}

function getLorebookSyncRequestPresetOptions(context = getContext()) {
    const settings = getSettings();
    const llmPresetName = String(settings.lorebookSyncLlmPresetName || '').trim();
    const selectedApiProfileName = String(settings.lorebookSyncApiPresetName || '').trim();
    const currentChatSource = String(context?.chatCompletionSettings?.chat_completion_source || '').trim();
    const apiSettingsOverride = buildApiSettingsOverrideFromConnectionProfileName(selectedApiProfileName, currentChatSource);
    const requestApi = resolveRequestApiFromConnectionProfileName(context, selectedApiProfileName);

    return {
        llmPresetName,
        requestApi,
        apiSettingsOverride,
        apiPresetName: '',
    };
}

function buildPresetAwareLorebookMessages(context, systemPrompt, userPrompt, { llmPresetName = '', requestApi = '' } = {}) {
    const baseMessages = [
        { role: 'system', content: String(systemPrompt || '').trim() },
        { role: 'user', content: String(userPrompt || '').trim() },
    ].filter(item => item.content);

    if (typeof context?.buildPresetAwarePromptMessages !== 'function') {
        return baseMessages;
    }

    const selectedPromptPresetName = String(llmPresetName || '').trim();
    const envelopeApi = selectedPromptPresetName ? 'openai' : (String(requestApi || context?.mainApi || 'openai').trim() || 'openai');
    try {
        const built = context.buildPresetAwarePromptMessages({
            messages: baseMessages,
            envelopeOptions: {
                includeCharacterCard: true,
                api: envelopeApi,
                promptPresetName: selectedPromptPresetName,
            },
            promptPresetName: selectedPromptPresetName,
        });
        if (Array.isArray(built) && built.length > 0) {
            return built;
        }
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to build preset-aware messages`, error);
    }

    return baseMessages;
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

function getConnectionProfileNames() {
    return getConnectionProfiles()
        .map(profile => String(profile.name || '').trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
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
    const names = getConnectionProfileNames();
    const options = [`<option value="">${escapeHtml(i18n('(Current API config)'))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function refreshPresetSelectors(root, context, settings) {
    const llmSelect = root.find('#cea_sync_llm_preset');
    if (llmSelect.length) {
        llmSelect.html(renderOpenAIPresetOptions(context, settings.lorebookSyncLlmPresetName));
        llmSelect.val(String(settings.lorebookSyncLlmPresetName || '').trim());
    }
    const apiSelect = root.find('#cea_sync_api_preset');
    if (apiSelect.length) {
        apiSelect.html(renderConnectionProfileOptions(settings.lorebookSyncApiPresetName));
        apiSelect.val(String(settings.lorebookSyncApiPresetName || '').trim());
    }
}

function createEmptyState() {
    return {
        version: 1,
        nextId: 1,
        journal: [],
        updatedAt: Date.now(),
    };
}

function normalizeOperationState(state) {
    const normalized = state && typeof state === 'object' ? clone(state) : createEmptyState();
    normalized.version = 1;
    normalized.nextId = Math.max(1, Number(normalized.nextId || 1));
    normalized.journal = Array.isArray(normalized.journal)
        ? normalized.journal.filter(item => item && typeof item === 'object' && String(item.id || '').trim())
        : [];
    normalized.updatedAt = Number(normalized.updatedAt || Date.now());
    return normalized;
}

function getCharacterOperationStateKey(context, avatar = '') {
    const preferredAvatar = String(avatar || '').trim();
    if (preferredAvatar) {
        return preferredAvatar;
    }
    const record = getActiveCharacterRecord(context);
    return String(record.avatar || '').trim();
}

async function getOperationStateSidecar(context, avatar) {
    const response = await fetch('/api/characters/state/get', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            avatar_url: avatar,
            namespace: MODULE_NAME,
        }),
        cache: 'no-cache',
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Character state read failed (${response.status}): ${detail || response.statusText}`);
    }
    const payload = await response.json().catch(() => null);
    return payload && typeof payload === 'object' ? payload.data : null;
}

async function setOperationStateSidecar(context, avatar, state) {
    const response = await fetch('/api/characters/state/set', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            avatar_url: avatar,
            namespace: MODULE_NAME,
            data: clone(state),
        }),
        cache: 'no-cache',
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Character state write failed (${response.status}): ${detail || response.statusText}`);
    }
}

async function loadOperationState(context, { force = false, avatar = '' } = {}) {
    const key = getCharacterOperationStateKey(context, avatar);
    if (!force && stateCache.has(key)) {
        return clone(stateCache.get(key));
    }
    const record = getActiveCharacterRecord(context, { avatar });
    const loaded = await getOperationStateSidecar(context, record.avatar);
    const normalized = normalizeOperationState(loaded);
    stateCache.set(key, clone(normalized));
    return normalized;
}

async function persistOperationState(context, state, { avatar = '' } = {}) {
    const key = getCharacterOperationStateKey(context, avatar);
    const record = getActiveCharacterRecord(context, { avatar });
    const next = normalizeOperationState(state);
    await setOperationStateSidecar(context, record.avatar, next);
    stateCache.set(key, clone(next));
}

async function deleteHistoryRecord(context, journalId, { avatar = '' } = {}) {
    const id = String(journalId || '').trim();
    if (!id) {
        return false;
    }
    const state = await loadOperationState(context, { force: true, avatar });
    const { index } = getJournalById(state, id);
    if (index < 0) {
        return false;
    }
    state.journal.splice(index, 1);
    state.updatedAt = Date.now();
    await persistOperationState(context, state, { avatar });
    return true;
}

async function clearHistoryRecords(context, { avatar = '' } = {}) {
    const state = await loadOperationState(context, { force: true, avatar });
    if (!Array.isArray(state.journal) || state.journal.length === 0) {
        return false;
    }
    state.journal = [];
    state.updatedAt = Date.now();
    await persistOperationState(context, state, { avatar });
    return true;
}

function nextStateId(state, prefix = 'op') {
    const id = `${prefix}_${Math.floor(Number(state.nextId || 1))}`;
    state.nextId = Math.max(1, Math.floor(Number(state.nextId || 1)) + 1);
    return id;
}

function getActiveCharacterRecord(context, { avatar = '' } = {}) {
    if (context.groupId) {
        throw new Error('Character editor assistant is unavailable in group chats.');
    }
    const preferredAvatar = String(avatar || '').trim();
    const characters = Array.isArray(context?.characters) ? context.characters : [];

    if (preferredAvatar) {
        const characterIndex = characters.findIndex(item => String(item?.avatar || '').trim() === preferredAvatar);
        if (characterIndex >= 0) {
            const character = characters[characterIndex];
            return {
                characterIndex,
                character,
                avatar: preferredAvatar,
            };
        }
        throw new Error(`Character not found for avatar: ${preferredAvatar}`);
    }

    const directIndex = context?.characterId;
    const directCharacter = characters?.[directIndex];
    if (directCharacter) {
        const resolvedAvatar = String(directCharacter?.avatar || '').trim();
        if (resolvedAvatar) {
            const resolvedIndex = Number.isInteger(Number(directIndex))
                ? Number(directIndex)
                : characters.findIndex(item => String(item?.avatar || '').trim() === resolvedAvatar);
            return {
                characterIndex: resolvedIndex,
                character: directCharacter,
                avatar: resolvedAvatar,
            };
        }
    }

    const currentChatId = String(context?.chatId || '').trim();
    if (currentChatId) {
        const characterIndex = characters.findIndex(item => String(item?.chat || '').trim() === currentChatId);
        if (characterIndex >= 0) {
            const character = characters[characterIndex];
            const resolvedAvatar = String(character?.avatar || '').trim();
            if (resolvedAvatar) {
                return {
                    characterIndex,
                    character,
                    avatar: resolvedAvatar,
                };
            }
        }
    }

    const activeName = String(context?.name2 || '').trim();
    if (activeName) {
        const characterIndex = characters.findIndex(item => String(item?.name || '').trim() === activeName);
        if (characterIndex >= 0) {
            const character = characters[characterIndex];
            const resolvedAvatar = String(character?.avatar || '').trim();
            if (resolvedAvatar) {
                return {
                    characterIndex,
                    character,
                    avatar: resolvedAvatar,
                };
            }
        }
    }

    throw new Error('No active character selected.');
}

async function mergeCharacterAttributes(context, avatar, patch) {
    const payload = {
        avatar,
        ...(patch && typeof patch === 'object' ? patch : {}),
    };
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify(payload),
        cache: 'no-cache',
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Character merge failed (${response.status}): ${detail || response.statusText}`);
    }
    await context.getOneCharacter(avatar);
    const currentIndex = Number(context?.characterId);
    const currentCharacter = Number.isInteger(currentIndex) && currentIndex >= 0
        ? context?.characters?.[currentIndex]
        : null;
    if (String(currentCharacter?.avatar || '').trim() === String(avatar || '').trim()) {
        try {
            select_selected_character(currentIndex, { switchMenu: false });
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to refresh character editor state after merge`, error);
        }
    }
}

async function syncWorldBindingUi(context, worldName = '') {
    const targetWorld = String(worldName || '').trim();
    const chid = Number(context?.characterId);

    if (jQuery('#character_world').length) {
        jQuery('#character_world').val(targetWorld).trigger('change');
    }
    if (Number.isInteger(chid) && chid >= 0) {
        jQuery('#set_character_world').data('chid', chid);
    }

    try {
        await updateWorldInfoList();
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to refresh world info list`, error);
    }

    const applyButtonState = () => {
        try {
            // First, apply the canonical check against the actual character binding.
            if (Number.isInteger(chid) && chid >= 0) {
                setWorldInfoButtonClass(chid);
            }

            // If binding exists but UI still not green, force class as a fallback.
            const shouldBeSet = Boolean(targetWorld);
            const isSet = jQuery('#set_character_world').hasClass('world_set')
                || jQuery('#world_button').hasClass('world_set');
            if (shouldBeSet && !isSet) {
                setWorldInfoButtonClass(undefined, true);
            } else if (!shouldBeSet && isSet) {
                setWorldInfoButtonClass(undefined, false);
            }
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to refresh world info button state`, error);
        }
    };

    applyButtonState();

    // Character data can land slightly later; re-apply once after the current tick.
    setTimeout(applyButtonState, 0);
    setTimeout(applyButtonState, 120);
}

async function refreshWorldInfoEditorUi(bookName = '') {
    const targetBook = String(bookName || '').trim();
    try {
        await updateWorldInfoList();
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to refresh world info list`, error);
    }
    if (!targetBook) {
        return;
    }
    try {
        reloadEditor(targetBook, false);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to reload world info editor`, error);
    }
}

function getPrimaryLorebookName(character) {
    return String(character?.data?.extensions?.world || '').trim();
}

function getLorebookNextUid(data) {
    const existing = Object.keys(data?.entries || {})
        .map(key => Number(key))
        .filter(Number.isFinite);
    return existing.length > 0 ? Math.max(...existing) + 1 : 0;
}

async function ensureLorebookExists(context, desiredName, fallbackName = 'Character Book') {
    const safeName = String(desiredName || '').trim() || String(fallbackName || 'Character Book').trim();
    const loaded = await context.loadWorldInfo(safeName);
    if (loaded && typeof loaded === 'object') {
        if (!loaded.entries || typeof loaded.entries !== 'object') {
            loaded.entries = {};
            await context.saveWorldInfo(safeName, loaded, true);
        }
        return safeName;
    }
    await context.saveWorldInfo(safeName, { entries: {} }, true);
    return safeName;
}

async function resolveTargetLorebook(context, record, {
    requestedName = '',
    createIfMissing = true,
    bindPrimaryWhenCreated = true,
} = {}) {
    const requested = String(requestedName || '').trim();
    if (requested) {
        const ensured = await ensureLorebookExists(context, requested, requested);
        if (!getPrimaryLorebookName(record.character) && bindPrimaryWhenCreated) {
            await mergeCharacterAttributes(context, record.avatar, {
                data: {
                    extensions: {
                        world: ensured,
                    },
                },
            });
            record.character = context.characters?.[record.characterIndex] || record.character;
        }
        return ensured;
    }

    const primary = getPrimaryLorebookName(record.character);
    if (primary) {
        return primary;
    }
    if (!createIfMissing) {
        return '';
    }

    const fallback = `Character Book ${String(record.character?.name || 'Character').replace(/[^a-z0-9 _\-]/gi, '_').trim()}`;
    const created = await ensureLorebookExists(context, fallback, fallback);
    await mergeCharacterAttributes(context, record.avatar, {
        data: {
            extensions: {
                world: created,
            },
        },
    });
    record.character = context.characters?.[record.characterIndex] || record.character;
    return created;
}

async function loadLorebookData(context, bookName) {
    const data = await context.loadWorldInfo(bookName);
    if (data && typeof data === 'object') {
        if (!data.entries || typeof data.entries !== 'object') {
            data.entries = {};
        }
        return data;
    }
    return { entries: {} };
}

function normalizeLorebookEntryForSync(entry, uid) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const normalizedUid = Number.isInteger(asFiniteInteger(uid, null))
        ? Number(asFiniteInteger(uid, 0))
        : Number(asFiniteInteger(source.uid, 0) || 0);
    return {
        uid: normalizedUid,
        comment: String(source.comment ?? ''),
        content: String(source.content ?? ''),
        key: Array.isArray(source.key) ? source.key.map(item => String(item ?? '').trim()).filter(Boolean) : [],
        keysecondary: Array.isArray(source.keysecondary) ? source.keysecondary.map(item => String(item ?? '').trim()).filter(Boolean) : [],
        selectiveLogic: asFiniteInteger(source.selectiveLogic, 0) ?? 0,
        order: asFiniteInteger(source.order, 0) ?? 0,
        position: asFiniteInteger(source.position, 0) ?? 0,
        depth: asFiniteInteger(source.depth, 0) ?? 0,
        disable: Boolean(source.disable),
        constant: Boolean(source.constant),
    };
}

function areLorebookEntriesEqualForSync(a, b) {
    return JSON.stringify(normalizeLorebookEntryForSync(a, a?.uid ?? 0)) === JSON.stringify(normalizeLorebookEntryForSync(b, b?.uid ?? 0));
}

function buildLorebookEntryUpsertArgs(bookName, uid, entry) {
    const normalized = normalizeLorebookEntryForSync(entry, uid);
    return {
        book_name: String(bookName || '').trim(),
        entry_uid: Number(normalized.uid),
        key_csv: normalized.key.join(', '),
        secondary_key_csv: normalized.keysecondary.join(', '),
        comment: normalized.comment,
        content: normalized.content,
        selective_logic: Number(normalized.selectiveLogic),
        order: Number(normalized.order),
        position: Number(normalized.position),
        depth: Number(normalized.depth),
        disable: Boolean(normalized.disable),
        constant: Boolean(normalized.constant),
    };
}

async function captureCharacterLorebookSnapshot(context, character) {
    const target = character && typeof character === 'object' ? character : null;
    const avatar = String(target?.avatar || '').trim();
    const characterName = String(target?.name || '').trim();
    const bookName = getPrimaryLorebookName(target);
    let entries = {};
    if (bookName) {
        try {
            const data = await loadLorebookData(context, bookName);
            entries = clone(data.entries || {}) || {};
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to snapshot lorebook '${bookName}'`, error);
        }
    }
    return {
        avatar,
        characterName,
        bookName,
        entries,
        capturedAt: Date.now(),
    };
}

function buildLorebookSyncPlan(previousSnapshot, currentSnapshot) {
    const previous = previousSnapshot && typeof previousSnapshot === 'object' ? previousSnapshot : {};
    const current = currentSnapshot && typeof currentSnapshot === 'object' ? currentSnapshot : {};
    const sourceBook = String(previous.bookName || '').trim();
    const targetBook = String(current.bookName || '').trim();
    const previousEntries = previous.entries && typeof previous.entries === 'object' ? previous.entries : {};
    const currentEntries = current.entries && typeof current.entries === 'object' ? current.entries : {};

    const operations = [];
    const diffItems = [];
    const maxOperations = 300;
    for (const [rawUid, oldEntryRaw] of Object.entries(previousEntries)) {
        const uid = asFiniteInteger(rawUid, asFiniteInteger(oldEntryRaw?.uid, null));
        if (!Number.isInteger(uid) || uid < 0) {
            continue;
        }
        const oldEntry = normalizeLorebookEntryForSync(oldEntryRaw, uid);
        const newEntry = Object.hasOwn(currentEntries, uid)
            ? normalizeLorebookEntryForSync(currentEntries[uid], uid)
            : (Object.hasOwn(currentEntries, String(uid))
                ? normalizeLorebookEntryForSync(currentEntries[String(uid)], uid)
                : null);
        if (newEntry && areLorebookEntriesEqualForSync(oldEntry, newEntry)) {
            continue;
        }
        diffItems.push({
            uid,
            reason: newEntry ? 'changed' : 'missing',
            oldEntry,
            newEntry,
        });
        if (targetBook && operations.length < maxOperations) {
            operations.push({
                kind: 'lorebook_upsert_entry',
                args: buildLorebookEntryUpsertArgs(targetBook, uid, oldEntry),
            });
        }
    }

    // Add reverse-side diffs so model can see entries that exist only in the new lorebook.
    for (const [rawUid, newEntryRaw] of Object.entries(currentEntries)) {
        const uid = asFiniteInteger(rawUid, asFiniteInteger(newEntryRaw?.uid, null));
        if (!Number.isInteger(uid) || uid < 0) {
            continue;
        }
        const oldEntryRaw = Object.hasOwn(previousEntries, uid)
            ? previousEntries[uid]
            : (Object.hasOwn(previousEntries, String(uid)) ? previousEntries[String(uid)] : null);
        if (oldEntryRaw) {
            continue;
        }
        const newEntry = normalizeLorebookEntryForSync(newEntryRaw, uid);
        diffItems.push({
            uid,
            reason: 'added',
            oldEntry: null,
            newEntry,
        });
    }

    return {
        sourceBook,
        targetBook,
        sourceCharacterName: String(previous.characterName || '').trim(),
        targetCharacterName: String(current.characterName || '').trim(),
        sourceEntryCount: Object.keys(previousEntries).length,
        targetEntryCount: Object.keys(currentEntries).length,
        diffItems,
        operations,
    };
}

function getEmbeddedLorebookImportPayload(character) {
    const target = character && typeof character === 'object' ? character : null;
    const rawBook = target?.data?.character_book;
    if (!rawBook || !Array.isArray(rawBook.entries)) {
        return null;
    }
    const safeBook = clone(rawBook);
    const bookName = String(safeBook?.name || `${String(target?.name || 'Character')}'s Lorebook`).trim();
    if (!bookName) {
        return null;
    }
    try {
        const converted = convertCharacterBook(safeBook);
        if (!converted || typeof converted !== 'object' || !converted.entries || typeof converted.entries !== 'object') {
            return null;
        }
        return {
            bookName,
            data: converted,
        };
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to convert embedded character book`, error);
        return null;
    }
}

async function applyDirectLorebookReplace(context, previousSnapshot, currentSnapshot, currentCharacter) {
    const previousBook = String(previousSnapshot?.bookName || '').trim();
    const embeddedImport = getEmbeddedLorebookImportPayload(currentCharacter);
    const fallbackTargetBook = String(currentSnapshot?.bookName || '').trim();
    const targetBook = embeddedImport?.bookName || fallbackTargetBook;
    const targetData = embeddedImport?.data || (targetBook ? { entries: clone(currentSnapshot?.entries || {}) } : null);
    if (!targetBook || !targetData || !targetData.entries || typeof targetData.entries !== 'object') {
        throw new Error('No target lorebook data available for direct replacement.');
    }

    // Write target first, then delete old one to avoid destructive half-success state.
    await context.saveWorldInfo(targetBook, targetData, true);

    if (previousBook && previousBook !== targetBook) {
        const existingPrevious = await context.loadWorldInfo(previousBook);
        if (existingPrevious) {
            const deleted = await deleteWorldInfo(previousBook);
            if (!deleted) {
                throw new Error(`Failed to delete old lorebook '${previousBook}'.`);
            }
        }
    }

    const avatar = String(currentSnapshot?.avatar || currentCharacter?.avatar || '').trim();
    if (avatar) {
        await mergeCharacterAttributes(context, avatar, {
            data: {
                extensions: {
                    world: targetBook,
                },
            },
        });
    }
    await syncWorldBindingUi(context, targetBook);

    return {
        previousBook,
        targetBook,
    };
}

async function restorePreviousLorebookBinding(context, previousSnapshot, currentSnapshot, currentCharacter) {
    const previousBook = String(previousSnapshot?.bookName || '').trim();
    const avatar = String(currentSnapshot?.avatar || currentCharacter?.avatar || '').trim();
    if (!avatar) {
        return {
            previousBook,
            applied: false,
        };
    }

    await mergeCharacterAttributes(context, avatar, {
        data: {
            extensions: {
                world: previousBook,
            },
        },
    });
    await syncWorldBindingUi(context, previousBook);

    return {
        previousBook,
        applied: true,
    };
}

function compactEntryForModel(entry, uid) {
    const normalized = normalizeLorebookEntryForSync(entry, uid);
    return {
        uid: normalized.uid,
        key: normalized.key,
        keysecondary: normalized.keysecondary,
        comment: String(normalized.comment ?? ''),
        content: String(normalized.content ?? ''),
        selectiveLogic: normalized.selectiveLogic,
        order: normalized.order,
        position: normalized.position,
        depth: normalized.depth,
        disable: normalized.disable,
        constant: normalized.constant,
    };
}

function renderLorebookSyncAnalysisMarkdown(markdownText) {
    const source = String(markdownText || '').trim();
    if (!source) {
        return `<div class="cea_sync_analysis_empty">${escapeHtml(i18n('No analysis output.'))}</div>`;
    }
    try {
        const html = converter?.makeHtml
            ? converter.makeHtml(source)
            : `<pre>${escapeHtml(source)}</pre>`;
        return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    } catch {
        return `<pre>${escapeHtml(source)}</pre>`;
    }
}

function buildLorebookSyncDialogHtml(plan) {
    const safePlan = plan && typeof plan === 'object' ? plan : {};

    return `
<div class="cea_sync_popup">
    <div class="cea_sync_intro">${escapeHtml(i18n('Review model analysis and optionally add requirements. Save will apply model edits; cancel will restore the previous lorebook.'))}</div>
    <div class="cea_sync_meta">
        <div class="cea_sync_meta_item"><b>${escapeHtml(i18n('Old lorebook'))}:</b> ${escapeHtml(String(safePlan.sourceBook || i18n('(empty)')))}</div>
        <div class="cea_sync_meta_item"><b>${escapeHtml(i18n('New lorebook'))}:</b> ${escapeHtml(String(safePlan.targetBook || i18n('(empty)')))}</div>
        <div class="cea_sync_meta_item"><b>${escapeHtml(i18n('Candidate sync operations'))}:</b> ${escapeHtml(String(Number(safePlan.operations?.length || 0)))}</div>
    </div>
    <div class="cea_sync_chat" data-cea-sync-chat>
    </div>
    <div class="cea_sync_composer">
        <textarea class="text_pole textarea_compact" rows="4" data-cea-sync-input placeholder="${escapeHtml(i18n('Type your requirement to continue this conversation...'))}"></textarea>
        <div class="menu_button menu_button_small" data-cea-sync-send>${escapeHtml(i18n('Send'))}</div>
    </div>
    <details class="cea_sync_history">
        <summary>${escapeHtml(i18n('History'))}</summary>
        <div class="cea_sync_history_list" data-cea-sync-history></div>
    </details>
</div>`;
}

function getLorebookEntryByUid(entries, uid) {
    if (!entries || typeof entries !== 'object') {
        return null;
    }
    if (Object.hasOwn(entries, uid)) {
        return entries[uid] ?? null;
    }
    const key = String(uid);
    if (Object.hasOwn(entries, key)) {
        return entries[key] ?? null;
    }
    return null;
}

function collectLorebookEntryUids(entries) {
    const output = new Set();
    for (const [rawUid, entry] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
        const uid = asFiniteInteger(rawUid, asFiniteInteger(entry?.uid, null));
        if (Number.isInteger(uid) && uid >= 0) {
            output.add(uid);
        }
    }
    return output;
}

function normalizeModelOperationsFromCalls(rawCalls, targetBook) {
    const normalizedOperations = [];
    for (const call of Array.isArray(rawCalls) ? rawCalls : []) {
        const kind = String(call?.name || '').trim();
        if (kind !== 'lorebook_upsert_entry' && kind !== 'lorebook_delete_entry') {
            continue;
        }
        const normalizedArgs = normalizeModelOperationArgs(kind, call.args, targetBook);
        if (!normalizedArgs) {
            continue;
        }
        normalizedOperations.push({
            kind,
            args: normalizedArgs,
        });
    }
    const dedupeMap = new Map();
    for (const item of normalizedOperations) {
        const uid = String(item?.args?.entry_uid ?? '');
        const key = `${String(item.kind)}:${uid}`;
        dedupeMap.set(key, item);
    }
    return Array.from(dedupeMap.values());
}

function buildLorebookDraftDiffPreview(operation, targetBook, beforeEntry, afterEntry) {
    const kind = String(operation?.kind || '');
    const args = operation?.args && typeof operation.args === 'object' ? operation.args : {};
    const entryUid = asFiniteInteger(args.entry_uid, null);
    const preview = {
        title: buildOperationSummary(operation),
        fields: [],
        meta: [
            {
                label: i18n('Target lorebook'),
                value: String(targetBook || i18n('(missing lorebook)')),
            },
            {
                label: i18n('Entry UID'),
                value: Number.isInteger(entryUid) ? String(entryUid) : '?',
            },
        ],
        rawArgs: clone(args || {}),
    };

    if (kind === 'lorebook_delete_entry') {
        pushDiffField(preview.fields, 'entry', beforeEntry ? 'exists' : '', i18n('(deleted)'), { force: true });
        if (beforeEntry) {
            pushDiffField(preview.fields, 'keywords', getEntryPreviewValue(beforeEntry, 'key'), i18n('(deleted)'), { force: true });
            pushDiffField(preview.fields, 'secondary keywords', getEntryPreviewValue(beforeEntry, 'keysecondary'), i18n('(deleted)'), { force: true });
            pushDiffField(preview.fields, 'comment', getEntryPreviewValue(beforeEntry, 'comment'), i18n('(deleted)'), { force: true });
            pushDiffField(preview.fields, 'content', getEntryPreviewValue(beforeEntry, 'content'), i18n('(deleted)'), { force: true });
        }
        return preview;
    }

    const fieldSpecs = [
        { label: 'comment', key: 'comment', touched: Object.hasOwn(args, 'comment') },
        { label: 'content', key: 'content', touched: Object.hasOwn(args, 'content') },
        { label: 'keywords', key: 'key', touched: Object.hasOwn(args, 'key_csv') },
        { label: 'secondary keywords', key: 'keysecondary', touched: Object.hasOwn(args, 'secondary_key_csv') },
        { label: 'selective logic', key: 'selectiveLogic', touched: Object.hasOwn(args, 'selective_logic') || Object.hasOwn(args, 'secondary_key_csv') },
        { label: 'order', key: 'order', touched: Object.hasOwn(args, 'order') },
        { label: 'position', key: 'position', touched: Object.hasOwn(args, 'position') },
        { label: 'depth', key: 'depth', touched: Object.hasOwn(args, 'depth') },
        { label: 'enabled', key: 'enabled', touched: Object.hasOwn(args, 'enabled') || Object.hasOwn(args, 'disable') },
        { label: 'constant', key: 'constant', touched: Object.hasOwn(args, 'constant') },
    ];
    for (const spec of fieldSpecs) {
        if (!spec.touched) {
            continue;
        }
        const beforeValue = beforeEntry ? getEntryPreviewValue(beforeEntry, spec.key) : '';
        const afterValue = afterEntry ? getEntryPreviewValue(afterEntry, spec.key) : i18n('(deleted)');
        pushDiffField(preview.fields, spec.label, beforeValue, afterValue, { force: !beforeEntry });
    }

    if (preview.fields.length === 0) {
        pushDiffField(
            preview.fields,
            'entry',
            beforeEntry ? 'exists' : '',
            afterEntry ? 'exists' : i18n('(deleted)'),
            { force: true },
        );
    }
    return preview;
}

function applyDraftOperationsAndBuildPreviews(targetBook, draftEntries, operationSpecs) {
    const entries = draftEntries && typeof draftEntries === 'object' ? draftEntries : {};
    const normalized = Array.isArray(operationSpecs) ? operationSpecs : [];
    const previews = [];
    const appliedOperations = [];

    for (const spec of normalized) {
        const kind = String(spec?.kind || '');
        const args = spec?.args && typeof spec.args === 'object' ? spec.args : {};
        const uid = asFiniteInteger(args.entry_uid, null);
        if (!Number.isInteger(uid) || uid < 0) {
            continue;
        }

        const beforeEntryRaw = getLorebookEntryByUid(entries, uid);
        const beforeEntry = beforeEntryRaw ? clone(beforeEntryRaw) : null;
        let afterEntry = beforeEntry ? clone(beforeEntry) : null;

        if (kind === 'lorebook_upsert_entry') {
            afterEntry = applyLorebookEntryArgs(beforeEntry, args, uid);
            entries[String(uid)] = clone(afterEntry);
        } else if (kind === 'lorebook_delete_entry') {
            delete entries[String(uid)];
            afterEntry = null;
        } else {
            continue;
        }

        previews.push(buildLorebookDraftDiffPreview(spec, targetBook, beforeEntry, afterEntry));
        appliedOperations.push({
            kind,
            args: clone(args),
        });
    }

    return {
        appliedOperations,
        diffPreviews: previews,
    };
}

function buildFinalLorebookOperationSpecsFromDraft(targetBook, baselineEntries, draftEntries) {
    const safeTargetBook = String(targetBook || '').trim();
    if (!safeTargetBook) {
        return [];
    }
    const baseline = baselineEntries && typeof baselineEntries === 'object' ? baselineEntries : {};
    const draft = draftEntries && typeof draftEntries === 'object' ? draftEntries : {};
    const uids = new Set([
        ...collectLorebookEntryUids(baseline),
        ...collectLorebookEntryUids(draft),
    ]);
    const sorted = Array.from(uids.values()).sort((a, b) => a - b);
    const output = [];

    for (const uid of sorted) {
        const beforeRaw = getLorebookEntryByUid(baseline, uid);
        const afterRaw = getLorebookEntryByUid(draft, uid);
        if (beforeRaw && !afterRaw) {
            output.push({
                kind: 'lorebook_delete_entry',
                args: {
                    book_name: safeTargetBook,
                    entry_uid: uid,
                },
            });
            continue;
        }
        if (!afterRaw) {
            continue;
        }
        if (!beforeRaw || !areLorebookEntriesEqualForSync(beforeRaw, afterRaw)) {
            output.push({
                kind: 'lorebook_upsert_entry',
                args: buildLorebookEntryUpsertArgs(safeTargetBook, uid, afterRaw),
            });
        }
    }

    return output;
}

function buildLorebookOperationApprovalKey(operation) {
    const kind = String(operation?.kind || '').trim();
    const uid = asFiniteInteger(operation?.args?.entry_uid, null);
    if (!kind || !Number.isInteger(uid) || uid < 0) {
        return '';
    }
    return `${kind}:${uid}`;
}

function markOperationsPendingApproval(operations, approvalMap) {
    const map = approvalMap instanceof Map ? approvalMap : new Map();
    for (const operation of Array.isArray(operations) ? operations : []) {
        const key = buildLorebookOperationApprovalKey(operation);
        if (!key) {
            continue;
        }
        map.set(key, 'pending');
    }
}

function getFinalOperationApprovalSummary(operationSpecs, approvalMap) {
    const map = approvalMap instanceof Map ? approvalMap : new Map();
    const summary = {
        approved: 0,
        pending: 0,
        rejected: 0,
    };
    for (const operation of Array.isArray(operationSpecs) ? operationSpecs : []) {
        const key = buildLorebookOperationApprovalKey(operation);
        const state = key ? String(map.get(key) || 'pending') : 'pending';
        if (state === 'approved') {
            summary.approved += 1;
        } else if (state === 'rejected') {
            summary.rejected += 1;
        } else {
            summary.pending += 1;
        }
    }
    return summary;
}

function selectApprovedFinalOperations(operationSpecs, approvalMap) {
    const map = approvalMap instanceof Map ? approvalMap : new Map();
    return (Array.isArray(operationSpecs) ? operationSpecs : []).filter(operation => {
        const key = buildLorebookOperationApprovalKey(operation);
        const state = key ? String(map.get(key) || 'pending') : 'pending';
        return state === 'approved';
    });
}

function buildFinalDiffReviewContext(operationSpecs, approvalMap) {
    const specs = Array.isArray(operationSpecs) ? operationSpecs : [];
    const summary = getFinalOperationApprovalSummary(specs, approvalMap);
    const decisions = specs.map(spec => {
        const kind = String(spec?.kind || '').trim();
        const entryUid = asFiniteInteger(spec?.args?.entry_uid, null);
        const key = buildLorebookOperationApprovalKey(spec);
        const status = key ? String(approvalMap?.get?.(key) || 'pending') : 'pending';
        return {
            kind,
            entry_uid: Number.isInteger(entryUid) ? entryUid : null,
            status,
        };
    });
    return {
        total: Number(specs.length),
        approved: Number(summary.approved),
        rejected: Number(summary.rejected),
        pending: Number(summary.pending),
        decisions,
    };
}

function rebuildLorebookDraftEntriesFromConversation(targetBook, baselineEntries, draftEntries, conversationMessages) {
    const safeDraftEntries = draftEntries && typeof draftEntries === 'object' ? draftEntries : {};
    const safeBaselineEntries = baselineEntries && typeof baselineEntries === 'object' ? baselineEntries : {};

    for (const key of Object.keys(safeDraftEntries)) {
        delete safeDraftEntries[key];
    }
    for (const [key, value] of Object.entries(safeBaselineEntries)) {
        safeDraftEntries[String(key)] = clone(value);
    }

    const list = Array.isArray(conversationMessages) ? conversationMessages : [];
    for (const item of list) {
        const operations = Array.isArray(item?.operations) ? item.operations : [];
        if (operations.length === 0) {
            if (item && typeof item === 'object') {
                item.operations = [];
                item.diffPreviews = [];
            }
            continue;
        }
        const draftRound = applyDraftOperationsAndBuildPreviews(targetBook, safeDraftEntries, operations);
        if (item && typeof item === 'object') {
            item.operations = draftRound.appliedOperations;
            item.diffPreviews = draftRound.diffPreviews;
        }
    }
}

const LINE_DIFF_LONG_CHAR_THRESHOLD = 900;
const LINE_DIFF_LONG_LINE_THRESHOLD = 18;
const LINE_DIFF_LCS_MAX_CELLS = 240000;

function splitLineDiffText(text) {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n');
    return normalized.length > 0 ? normalized.split('\n') : [];
}

function buildLineDiffOperations(beforeLines, afterLines) {
    const a = Array.isArray(beforeLines) ? beforeLines : [];
    const b = Array.isArray(afterLines) ? afterLines : [];
    if (a.length === 0 && b.length === 0) {
        return [];
    }
    if (a.length === 0) {
        return [{ type: 'insert', lines: b.slice() }];
    }
    if (b.length === 0) {
        return [{ type: 'delete', lines: a.slice() }];
    }
    if ((a.length * b.length) > LINE_DIFF_LCS_MAX_CELLS) {
        return [
            { type: 'delete', lines: a.slice() },
            { type: 'insert', lines: b.slice() },
        ];
    }

    const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j]
                ? (dp[i + 1][j + 1] + 1)
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const operations = [];
    const push = (type, line) => {
        const last = operations[operations.length - 1];
        if (last && last.type === type) {
            last.lines.push(line);
            return;
        }
        operations.push({ type, lines: [line] });
    };

    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            push('equal', a[i]);
            i += 1;
            j += 1;
            continue;
        }
        if (dp[i + 1][j] >= dp[i][j + 1]) {
            push('delete', a[i]);
            i += 1;
            continue;
        }
        push('insert', b[j]);
        j += 1;
    }
    while (i < a.length) {
        push('delete', a[i]);
        i += 1;
    }
    while (j < b.length) {
        push('insert', b[j]);
        j += 1;
    }
    return operations;
}

function buildLineDiffRows(beforeValue, afterValue) {
    const beforeText = String(beforeValue ?? '');
    const afterText = String(afterValue ?? '');
    const operations = buildLineDiffOperations(splitLineDiffText(beforeText), splitLineDiffText(afterText));
    const stats = { added: 0, removed: 0, unchanged: 0 };

    for (const operation of operations) {
        const type = String(operation?.type || 'equal');
        const lines = Array.isArray(operation?.lines) ? operation.lines : [];
        for (const line of lines) {
            if (type === 'insert') {
                stats.added += 1;
                continue;
            }
            if (type === 'delete') {
                stats.removed += 1;
                continue;
            }
            stats.unchanged += 1;
        }
    }

    const maxChars = Math.max(beforeText.length, afterText.length);
    const lineCount = stats.added + stats.removed + stats.unchanged;
    const isLong = lineCount > LINE_DIFF_LONG_LINE_THRESHOLD || maxChars > LINE_DIFF_LONG_CHAR_THRESHOLD;

    return {
        operations,
        added: stats.added,
        removed: stats.removed,
        unchanged: stats.unchanged,
        openByDefault: !isLong,
    };
}

function splitInlineDiffTokens(text) {
    const source = String(text ?? '');
    return source.length > 0 ? (source.match(/\s+|[^\s]+/g) || []) : [];
}

function renderInlineDiffHtml(beforeText, afterText, mode = 'old') {
    const beforeTokens = splitInlineDiffTokens(beforeText);
    const afterTokens = splitInlineDiffTokens(afterText);
    if (beforeTokens.length === 0 && afterTokens.length === 0) {
        return '&nbsp;';
    }
    if ((beforeTokens.length * afterTokens.length) > LINE_DIFF_LCS_MAX_CELLS) {
        const fallback = escapeHtml(mode === 'new' ? String(afterText ?? '') : String(beforeText ?? ''));
        return fallback.length > 0 ? fallback : '&nbsp;';
    }
    const operations = buildLineDiffOperations(beforeTokens, afterTokens);
    const chunks = [];
    for (const operation of operations) {
        const type = String(operation?.type || 'equal');
        const tokenText = escapeHtml(String((Array.isArray(operation?.lines) ? operation.lines : []).join('')));
        if (!tokenText) {
            continue;
        }
        if (type === 'equal') {
            chunks.push(tokenText);
            continue;
        }
        if (type === 'delete') {
            if (mode === 'old') {
                chunks.push(`<span class="cea_line_diff_word_del">${tokenText}</span>`);
            }
            continue;
        }
        if (type === 'insert') {
            if (mode === 'new') {
                chunks.push(`<span class="cea_line_diff_word_add">${tokenText}</span>`);
            }
        }
    }
    return chunks.length > 0 ? chunks.join('') : '&nbsp;';
}

function buildLineDiffVisualRows(operations) {
    const rows = [];
    let beforeLineNo = 1;
    let afterLineNo = 1;
    const appendRow = (rowType, oldLine, oldHtml, newLine, newHtml) => {
        rows.push({
            rowType: String(rowType || ''),
            oldLine: String(oldLine || ''),
            oldHtml: String(oldHtml || '&nbsp;'),
            newLine: String(newLine || ''),
            newHtml: String(newHtml || '&nbsp;'),
        });
    };

    const safeOperations = Array.isArray(operations) ? operations : [];
    for (let index = 0; index < safeOperations.length; index++) {
        const operation = safeOperations[index];
        const type = String(operation?.type || 'equal');
        const lines = Array.isArray(operation?.lines) ? operation.lines : [];
        const nextOperation = safeOperations[index + 1];
        if (type === 'delete' && String(nextOperation?.type || '') === 'insert') {
            const insertLines = Array.isArray(nextOperation?.lines) ? nextOperation.lines : [];
            const pairCount = Math.min(lines.length, insertLines.length);
            for (let i = 0; i < pairCount; i++) {
                const beforeLine = String(lines[i] ?? '');
                const afterLine = String(insertLines[i] ?? '');
                appendRow(
                    'cea_line_diff_row_mod',
                    String(beforeLineNo),
                    renderInlineDiffHtml(beforeLine, afterLine, 'old'),
                    String(afterLineNo),
                    renderInlineDiffHtml(beforeLine, afterLine, 'new'),
                );
                beforeLineNo += 1;
                afterLineNo += 1;
            }
            for (let i = pairCount; i < lines.length; i++) {
                const text = escapeHtml(String(lines[i] ?? '')) || '&nbsp;';
                appendRow('cea_line_diff_row_del', String(beforeLineNo), text, '', '&nbsp;');
                beforeLineNo += 1;
            }
            for (let i = pairCount; i < insertLines.length; i++) {
                const text = escapeHtml(String(insertLines[i] ?? '')) || '&nbsp;';
                appendRow('cea_line_diff_row_add', '', '&nbsp;', String(afterLineNo), text);
                afterLineNo += 1;
            }
            index += 1;
            continue;
        }
        for (const rawLine of lines) {
            const text = String(rawLine ?? '');
            const escapedText = text.length > 0 ? escapeHtml(text) : '&nbsp;';
            if (type === 'insert') {
                appendRow('cea_line_diff_row_add', '', '&nbsp;', String(afterLineNo), escapedText);
                afterLineNo += 1;
                continue;
            }
            if (type === 'delete') {
                appendRow('cea_line_diff_row_del', String(beforeLineNo), escapedText, '', '&nbsp;');
                beforeLineNo += 1;
                continue;
            }
            appendRow('cea_line_diff_row_eq', String(beforeLineNo), escapedText, String(afterLineNo), escapedText);
            beforeLineNo += 1;
            afterLineNo += 1;
        }
    }
    if (rows.length === 0) {
        appendRow('cea_line_diff_row_eq', '', '&nbsp;', '', '&nbsp;');
    }
    return rows;
}

function renderLineDiffSideRowsHtml(rows, side = 'old') {
    const safeRows = Array.isArray(rows) ? rows : [];
    const isOldSide = side !== 'new';
    return safeRows.map((row) => `
<tr class="cea_line_diff_row ${escapeHtml(String(row?.rowType || ''))}">
    <td class="cea_line_diff_ln ${isOldSide ? 'old' : 'new'}">${isOldSide ? escapeHtml(String(row?.oldLine || '')) : escapeHtml(String(row?.newLine || ''))}</td>
    <td class="cea_line_diff_text ${isOldSide ? 'old' : 'new'}"><div class="cea_line_diff_text_inner">${isOldSide ? String(row?.oldHtml || '&nbsp;') : String(row?.newHtml || '&nbsp;')}</div></td>
</tr>`).join('');
}

function renderLineDiffHtml(beforeValue, afterValue, fileLabel = 'field') {
    const payload = buildLineDiffRows(
        sanitizeDiffPlaceholderValue(beforeValue),
        sanitizeDiffPlaceholderValue(afterValue),
    );
    const summary = i18nFormat('Line diff (+${0} -${1})', payload.added, payload.removed);
    const safeLabel = escapeHtml(String(fileLabel || 'field'));
    const renderedRows = buildLineDiffVisualRows(payload.operations);
    const expandLabel = escapeHtml(i18n('Expand diff'));
    const resizeLabel = escapeHtml(i18n('Resize diff columns'));
    return `
<details class="cea_line_diff"${payload.openByDefault ? ' open' : ''}>
    <summary>
        <span class="cea_line_diff_summary_main">
            <span>${escapeHtml(summary)}</span>
            <span class="cea_line_diff_meta">=${escapeHtml(String(payload.unchanged))}</span>
        </span>
        <button type="button" class="menu_button menu_button_small cea_line_diff_expand_btn" data-cea-action="expand-line-diff" title="${expandLabel}" aria-label="${expandLabel}">
            <i class="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true"></i>
        </button>
    </summary>
    <div class="cea_line_diff_pre" data-cea-diff-label="${safeLabel}">
        <div class="cea_line_diff_dual" role="group">
            <div class="cea_line_diff_side old">
                <div class="cea_line_diff_side_scroll">
                    <table class="cea_line_diff_table old" role="grid">
                        <tbody>${renderLineDiffSideRowsHtml(renderedRows, 'old')}</tbody>
                    </table>
                </div>
            </div>
            <div class="cea_line_diff_splitter" role="separator" aria-orientation="vertical" aria-label="${resizeLabel}" title="${resizeLabel}"></div>
            <div class="cea_line_diff_side new">
                <div class="cea_line_diff_side_scroll">
                    <table class="cea_line_diff_table new" role="grid">
                        <tbody>${renderLineDiffSideRowsHtml(renderedRows, 'new')}</tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</details>`;
}

function closeCeaExpandedDiff(target) {
    const node = target instanceof Element ? target : null;
    const popupRoot = node?.closest?.('.popup');
    if (!(popupRoot instanceof HTMLElement)) {
        return;
    }
    popupRoot.querySelectorAll('.cea_line_diff_zoom_overlay').forEach((overlay) => overlay.remove());
}

function openCeaExpandedDiff(trigger) {
    const triggerElement = trigger instanceof Element ? trigger : null;
    const popupRoot = triggerElement?.closest?.('.popup');
    const diffRoot = triggerElement?.closest?.('.cea_line_diff');
    const diffBody = diffRoot?.querySelector?.('.cea_line_diff_pre');
    if (!(popupRoot instanceof HTMLElement) || !(diffBody instanceof HTMLElement)) {
        return;
    }

    popupRoot.querySelectorAll('.cea_line_diff_zoom_overlay').forEach((overlay) => overlay.remove());

    const diffLabel = String(diffBody.getAttribute('data-cea-diff-label') || i18n('Line diff'));
    const closeLabel = escapeHtml(i18n('Close expanded diff'));
    const overlay = document.createElement('div');
    overlay.className = 'cea_line_diff_zoom_overlay';
    overlay.innerHTML = `
<div class="cea_line_diff_zoom_backdrop" data-cea-action="close-line-diff-zoom"></div>
<div class="cea_line_diff_zoom_dialog" role="dialog" aria-modal="true">
    <div class="cea_line_diff_zoom_header">
        <div class="cea_line_diff_zoom_title">${escapeHtml(diffLabel)}</div>
        <button type="button" class="menu_button menu_button_small cea_line_diff_zoom_close" data-cea-action="close-line-diff-zoom" title="${closeLabel}" aria-label="${closeLabel}">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
    </div>
    <div class="cea_line_diff_zoom_body"></div>
</div>`;

    const zoomBody = overlay.querySelector('.cea_line_diff_zoom_body');
    if (zoomBody instanceof HTMLElement) {
        zoomBody.append(diffBody.cloneNode(true));
    }

    popupRoot.append(overlay);
}

function beginCeaLineDiffResize(splitterElement, pointerEvent) {
    const splitter = splitterElement instanceof HTMLElement ? splitterElement : null;
    const pointer = pointerEvent instanceof PointerEvent ? pointerEvent : null;
    const dual = splitter?.closest?.('.cea_line_diff_dual');
    if (!(splitter instanceof HTMLElement) || !(pointer instanceof PointerEvent) || !(dual instanceof HTMLElement)) {
        return;
    }

    pointer.preventDefault();
    pointer.stopPropagation();

    const bounds = dual.getBoundingClientRect();
    if (!Number.isFinite(bounds.width) || bounds.width <= 0) {
        return;
    }

    const minPercent = 15;
    const maxPercent = 85;
    const pointerId = pointer.pointerId;

    const applySplitAt = (clientX) => {
        const nextPercent = ((clientX - bounds.left) / bounds.width) * 100;
        const clampedPercent = Math.max(minPercent, Math.min(maxPercent, nextPercent));
        dual.style.setProperty('--cea-split-left', `${clampedPercent}%`);
    };

    const cleanup = () => {
        splitter.classList.remove('active');
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);
        try {
            splitter.releasePointerCapture(pointerId);
        } catch {
            // Ignore release errors when capture was not acquired.
        }
    };

    const handlePointerMove = (moveEvent) => {
        if (!(moveEvent instanceof PointerEvent) || moveEvent.pointerId !== pointerId) {
            return;
        }
        moveEvent.preventDefault();
        applySplitAt(moveEvent.clientX);
    };

    const handlePointerUp = (upEvent) => {
        if (!(upEvent instanceof PointerEvent) || upEvent.pointerId !== pointerId) {
            return;
        }
        upEvent.preventDefault();
        cleanup();
    };

    splitter.classList.add('active');
    applySplitAt(pointer.clientX);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    try {
        splitter.setPointerCapture(pointerId);
    } catch {
        // Pointer capture may fail in some browsers and is optional here.
    }
}

function renderLorebookSyncTurnDiffHtml(message, messageIndex = -1, approvalMap = null) {
    const safeMessage = message && typeof message === 'object' ? message : {};
    const hasTurnData = Object.hasOwn(safeMessage, 'diffPreviews') || Object.hasOwn(safeMessage, 'operations');
    if (!hasTurnData) {
        return '';
    }
    const previews = Array.isArray(safeMessage.diffPreviews) ? safeMessage.diffPreviews : [];
    const operations = Array.isArray(safeMessage.operations) ? safeMessage.operations : [];
    const canRollbackRound = Number.isInteger(messageIndex) && messageIndex >= 0 && operations.length > 0;
    const summaryText = previews.length > 0
        ? i18nFormat('Round diff (${0} operations)', previews.length)
        : i18n('Round diff');

    if (previews.length === 0) {
        return `
<details class="cea_sync_turn_diff">
    <summary>${escapeHtml(summaryText)}</summary>
    ${canRollbackRound ? `
    <div class="cea_sync_turn_actions">
        <div class="menu_button menu_button_small" data-cea-sync-action="rollback-round" data-cea-sync-message-index="${messageIndex}">${escapeHtml(i18n('Rollback to this round'))}</div>
    </div>` : ''}
    <div class="cea_sync_turn_diff_empty">${escapeHtml(i18n('No draft operations proposed in this round.'))}</div>
</details>`;
    }

    return `
<details class="cea_sync_turn_diff" open>
    <summary>${escapeHtml(summaryText)}</summary>
    ${canRollbackRound ? `
    <div class="cea_sync_turn_actions">
        <div class="menu_button menu_button_small" data-cea-sync-action="rollback-round" data-cea-sync-message-index="${messageIndex}">${escapeHtml(i18n('Rollback to this round'))}</div>
    </div>` : ''}
    <div class="cea_sync_turn_diff_list">
        ${previews.map((preview, index) => {
            const fields = Array.isArray(preview?.fields) ? preview.fields : [];
            const meta = Array.isArray(preview?.meta) ? preview.meta : [];
            const operation = operations[index] || null;
            const rawArgs = operation?.args || preview?.rawArgs || {};
            const operationKey = buildLorebookOperationApprovalKey(operation);
            const approvalState = operationKey ? String(approvalMap?.get?.(operationKey) || 'pending') : 'pending';
            const approvalLabel = approvalState === 'approved'
                ? i18n('Approved')
                : (approvalState === 'rejected' ? i18n('Rejected') : i18n('Pending review'));
            return `
<div class="cea_sync_turn_diff_item">
    <div class="cea_sync_turn_diff_title">${escapeHtml(i18nFormat('Operation ${0}', index + 1))}: ${escapeHtml(String(preview?.title || ''))}</div>
    <div class="cea_sync_turn_diff_actions">
        <div class="cea_sync_turn_diff_status ${escapeHtml(approvalState)}">${escapeHtml(approvalLabel)}</div>
        ${operationKey ? `
        <div class="menu_button menu_button_small" data-cea-sync-action="approve-diff" data-cea-sync-message-index="${messageIndex}" data-cea-sync-op-index="${index}">${escapeHtml(i18n('Approve'))}</div>
        <div class="menu_button menu_button_small" data-cea-sync-action="reject-diff" data-cea-sync-message-index="${messageIndex}" data-cea-sync-op-index="${index}">${escapeHtml(i18n('Reject'))}</div>
        ` : ''}
    </div>
    ${meta.length > 0 ? `<div class="cea_sync_turn_diff_meta">${meta.map(item => `
        <div class="cea_sync_turn_diff_meta_item"><b>${escapeHtml(String(item?.label || ''))}:</b> ${escapeHtml(String(item?.value || ''))}</div>
    `).join('')}</div>` : ''}
    <div class="cea_sync_turn_diff_fields">
        ${fields.map(field => `
<div class="cea_sync_turn_diff_field">
    <div class="cea_sync_turn_diff_label">${escapeHtml(String(field?.label || 'field'))}</div>
    ${renderLineDiffHtml(field?.before ?? '', field?.after ?? '', String(field?.label || 'field'))}
</div>`).join('')}
    </div>
    <details class="cea_sync_turn_diff_raw">
        <summary>${escapeHtml(i18n('Raw arguments'))}</summary>
        <pre>${escapeHtml(JSON.stringify(rawArgs, null, 2))}</pre>
    </details>
</div>`;
        }).join('')}
    </div>
</details>`;
}

function renderLorebookSyncChatMessages(messages, { loading = false, loadingText = '', approvalMap = null } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const html = list.map((item, index) => {
        const role = String(item?.role || 'assistant');
        const text = String(item?.content || '').trim();
        if (!text) {
            return '';
        }
        if (role === 'user') {
            return `
<div class="cea_sync_chat_msg cea_sync_chat_msg_user">
    <pre>${escapeHtml(text)}</pre>
</div>`;
        }
        return `
<div class="cea_sync_chat_msg cea_sync_chat_msg_assistant">
    <div class="cea_sync_chat_text">${renderLorebookSyncAnalysisMarkdown(text)}</div>
    ${renderLorebookSyncTurnDiffHtml(item, index, approvalMap)}
</div>`;
    }).join('');

    if (!loading) {
        return html;
    }
    const loadingLabel = String(loadingText || i18n('Assistant is thinking...'));
    return `${html}
<div class="cea_sync_chat_msg cea_sync_chat_msg_assistant cea_sync_chat_msg_loading">
    <i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
    <span>${escapeHtml(loadingLabel)}</span>
</div>`;
}

function buildLorebookSyncModeChoiceHtml(plan) {
    const safePlan = plan && typeof plan === 'object' ? plan : {};
    return `
<div class="cea_sync_popup">
    <div class="cea_sync_intro">${escapeHtml(i18n('Choose how to handle lorebook update'))}</div>
    <div class="cea_sync_meta">
        <div class="cea_sync_meta_item"><b>${escapeHtml(i18n('Old lorebook'))}:</b> ${escapeHtml(String(safePlan.sourceBook || i18n('(empty)')))}</div>
        <div class="cea_sync_meta_item"><b>${escapeHtml(i18n('New lorebook'))}:</b> ${escapeHtml(String(safePlan.targetBook || i18n('(empty)')))}</div>
        <div class="cea_sync_meta_item"><b>${escapeHtml(i18n('Candidate sync operations'))}:</b> ${escapeHtml(String(Number(safePlan.operations?.length || 0)))}</div>
    </div>
</div>`;
}

async function selectLorebookSyncMode(plan) {
    const popup = new Popup(
        buildLorebookSyncModeChoiceHtml(plan),
        POPUP_TYPE.CONFIRM,
        '',
        {
            wide: true,
            wider: true,
            allowVerticalScrolling: true,
            okButton: false,
            cancelButton: false,
            defaultResult: POPUP_RESULT.CUSTOM1,
            customButtons: [
                {
                    text: i18n('Analyze then update'),
                    result: POPUP_RESULT.CUSTOM1,
                },
                {
                    text: i18n('Direct replace'),
                    result: POPUP_RESULT.CUSTOM2,
                },
                {
                    text: i18n('Do not replace'),
                    result: POPUP_RESULT.CUSTOM3,
                },
            ],
        },
    );

    const result = await popup.show();
    if (result === POPUP_RESULT.CUSTOM2) {
        return 'direct_replace';
    }
    if (result === POPUP_RESULT.CUSTOM3 || result === POPUP_RESULT.CANCELLED) {
        return 'skip_replace';
    }
    return 'analyze_then_update';
}

function buildLorebookModelContextPayload(plan, requirements = '', analysisSummary = '') {
    const candidateItems = Array.isArray(plan?.diffItems) ? plan.diffItems : [];
    return {
        source_lorebook: String(plan?.sourceBook || ''),
        target_lorebook: String(plan?.targetBook || ''),
        source_entry_count: Number(plan?.sourceEntryCount || 0),
        target_entry_count: Number(plan?.targetEntryCount || 0),
        candidates: candidateItems.map(item => ({
            uid: Number(item?.uid || 0),
            reason: String(item?.reason || ''),
            old_entry: item?.oldEntry ? compactEntryForModel(item.oldEntry, item?.uid) : null,
            new_entry: item?.newEntry ? compactEntryForModel(item.newEntry, item.uid) : null,
        })),
        user_requirements: String(requirements || '').trim(),
        analysis_summary: String(analysisSummary || '').trim(),
    };
}

function buildLorebookSyncBaselineData(embeddedImport, baselineEntries) {
    const embeddedData = embeddedImport?.data;
    if (embeddedData && typeof embeddedData === 'object') {
        const data = clone(embeddedData);
        if (!data.entries || typeof data.entries !== 'object') {
            data.entries = {};
        }
        return data;
    }
    return {
        entries: clone(baselineEntries || {}) || {},
    };
}

function buildLorebookSyncModelTools() {
    return [
        {
            type: 'function',
            function: {
                name: 'lorebook_upsert_entry',
                description: 'Upsert one lorebook entry in the target lorebook.',
                parameters: {
                    type: 'object',
                    properties: {
                        entry_uid: { type: 'integer' },
                        key_csv: { type: 'string' },
                        secondary_key_csv: { type: 'string' },
                        comment: { type: 'string' },
                        content: { type: 'string' },
                        selective_logic: { type: 'integer' },
                        order: { type: 'integer' },
                        position: { type: 'integer' },
                        depth: { type: 'integer' },
                        enabled: { type: 'boolean' },
                        disable: { type: 'boolean' },
                        constant: { type: 'boolean' },
                    },
                    required: ['entry_uid'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'lorebook_delete_entry',
                description: 'Delete one lorebook entry in the target lorebook by uid.',
                parameters: {
                    type: 'object',
                    properties: {
                        entry_uid: { type: 'integer' },
                    },
                    required: ['entry_uid'],
                    additionalProperties: false,
                },
            },
        },
    ];
}

function extractToolCallsFromResponse(responseData) {
    const toolCalls = responseData?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls)) {
        return [];
    }
    const output = [];
    for (const call of toolCalls) {
        const name = String(call?.function?.name || '').trim();
        const argsText = String(call?.function?.arguments || '').trim();
        if (!name || !argsText) {
            continue;
        }
        try {
            output.push({
                name,
                args: JSON.parse(argsText),
            });
        } catch {
            continue;
        }
    }
    return output;
}

function renderLorebookSyncHistoryItems(state) {
    const items = Array.isArray(state?.journal) ? state.journal.slice().reverse() : [];
    const toolbar = items.length > 0
        ? `<div class="cea_sync_history_toolbar"><div class="menu_button menu_button_small" data-cea-sync-history-action="clear">${escapeHtml(i18n('Clear history'))}</div></div>`
        : '';
    if (items.length === 0) {
        return `${toolbar}<div class="cea_sync_history_empty">${escapeHtml(i18n('No history yet.'))}</div>`;
    }
    return `${toolbar}${items.map(item => {
        const journalId = String(item?.id || '').trim();
        const actions = [];
        if (journalId && String(item?.kind || '') !== 'rollback') {
            actions.push(`<div class="menu_button menu_button_small" data-cea-sync-history-action="rollback" data-cea-sync-history-id="${escapeHtml(journalId)}">${escapeHtml(i18n('Rollback'))}</div>`);
        }
        if (journalId) {
            actions.push(`<div class="menu_button menu_button_small" data-cea-sync-history-action="delete" data-cea-sync-history-id="${escapeHtml(journalId)}">${escapeHtml(i18n('Delete'))}</div>`);
        }
        return `
<div class="cea_sync_history_item">
    <div class="cea_sync_history_item_main">
        <div class="cea_sync_history_item_summary">${escapeHtml(String(item?.summary || item?.kind || ''))}</div>
        <div class="cea_sync_history_item_time">${escapeHtml(new Date(Number(item?.createdAt || Date.now())).toLocaleString())}</div>
    </div>
    ${actions.length > 0 ? `<div class="cea_sync_history_item_actions">${actions.join('')}</div>` : ''}
</div>`;
    }).join('')}`;
}

function getResponseMessageContent(responseData) {
    return String(responseData?.choices?.[0]?.message?.content || '').trim();
}

function collectJsonPayloadCandidates(text) {
    const source = String(text || '').trim();
    if (!source) {
        return [];
    }
    const candidates = [source];
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let blockMatch;
    while ((blockMatch = codeBlockRegex.exec(source)) !== null) {
        const body = String(blockMatch?.[1] || '').trim();
        if (body) {
            candidates.push(body);
        }
    }
    const arrayStart = source.indexOf('[');
    const arrayEnd = source.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
        const body = source.slice(arrayStart, arrayEnd + 1).trim();
        if (body) {
            candidates.push(body);
        }
    }
    const objectStart = source.indexOf('{');
    const objectEnd = source.lastIndexOf('}');
    if (objectStart >= 0 && objectEnd > objectStart) {
        const body = source.slice(objectStart, objectEnd + 1).trim();
        if (body) {
            candidates.push(body);
        }
    }
    return [...new Set(candidates)];
}

function normalizeTextToolCallsPayload(payload) {
    if (Array.isArray(payload)) {
        return payload;
    }
    if (payload && typeof payload === 'object') {
        if (Array.isArray(payload.tool_calls)) {
            return payload.tool_calls;
        }
        if (Array.isArray(payload.calls)) {
            return payload.calls;
        }
        if (payload.name || payload.function?.name) {
            return [payload];
        }
    }
    return [];
}

function coerceToolCallArgumentsObject(rawArgs, functionName) {
    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
        return rawArgs;
    }
    if (typeof rawArgs === 'string' && rawArgs.trim()) {
        try {
            const parsed = JSON.parse(rawArgs);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch {
            throw new Error(`Tool call '${functionName}' arguments are not valid JSON.`);
        }
    }
    throw new Error(`Tool call '${functionName}' arguments are empty.`);
}

function extractToolCallsFromTextResponse(responseData, allowedNames = null) {
    const content = getResponseMessageContent(responseData);
    if (!content) {
        return [];
    }
    const allowSet = allowedNames instanceof Set
        ? allowedNames
        : Array.isArray(allowedNames)
            ? new Set(allowedNames.map(name => String(name || '').trim()).filter(Boolean))
            : null;
    const candidates = collectJsonPayloadCandidates(content);
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            const rawCalls = normalizeTextToolCallsPayload(parsed);
            if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
                continue;
            }
            const calls = [];
            for (const item of rawCalls) {
                const name = String(item?.name || item?.function?.name || '').trim();
                if (!name) {
                    continue;
                }
                if (allowSet && !allowSet.has(name)) {
                    continue;
                }
                const rawArgs = item?.arguments ?? item?.args ?? item?.function?.arguments;
                calls.push({
                    name,
                    args: coerceToolCallArgumentsObject(rawArgs, name),
                });
            }
            if (calls.length > 0) {
                return calls;
            }
        } catch {
            continue;
        }
    }
    return [];
}

function extractDisplayTextFromPlainTextFunctionResponse(rawText) {
    const source = String(rawText || '').trim();
    if (!source) {
        return '';
    }
    const candidates = collectJsonPayloadCandidates(source);
    for (const candidate of candidates) {
        if (!source.endsWith(candidate)) {
            continue;
        }
        try {
            const parsed = JSON.parse(candidate);
            const rawCalls = normalizeTextToolCallsPayload(parsed);
            if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
                continue;
            }
            return source.slice(0, source.length - candidate.length).trim();
        } catch {
            continue;
        }
    }
    return source;
}

function buildPlainTextToolProtocolMessage(tools = []) {
    const normalizedTools = Array.isArray(tools) ? tools : [];
    const schemaGuide = normalizedTools.map((tool) => ({
        name: String(tool?.function?.name || ''),
        description: String(tool?.function?.description || ''),
        parameters: tool?.function?.parameters && typeof tool.function.parameters === 'object'
            ? tool.function.parameters
            : { type: 'object', additionalProperties: true },
    })).filter(item => item.name);
    return [
        'Plain-text function-call mode is enabled.',
        'You may output reasoning text (for example <thought>...</thought>) before the final JSON payload.',
        'The final output must end with one JSON object: {"tool_calls":[{"name":"FUNCTION_NAME","arguments":{...}}]}',
        `Allowed functions and JSON argument schemas: ${JSON.stringify(schemaGuide)}`,
    ].join('\n');
}

function mergeUserAddendumIntoPromptMessages(promptMessages, addendumText, tagName = 'function_call_protocol') {
    const messages = Array.isArray(promptMessages)
        ? promptMessages.map(message => ({ ...message }))
        : [];
    const addendum = String(addendumText || '').trim();
    if (!addendum) {
        return messages;
    }
    const tag = String(tagName || '').trim() || 'function_call_protocol';
    const wrapped = [`<${tag}>`, addendum, `</${tag}>`].join('\n');
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (String(message?.role || '').toLowerCase() !== 'user') {
            continue;
        }
        const base = typeof message?.content === 'string'
            ? message.content
            : String(message?.content ?? '');
        messages[index] = {
            ...message,
            content: base ? `${base}\n\n${wrapped}` : wrapped,
        };
        return messages;
    }
    messages.push({ role: 'user', content: wrapped });
    return messages;
}

async function requestLorebookToolCallsWithRetry(settings, promptMessages, {
    tools = [],
    allowedNames = null,
    requestPresetOptions = null,
} = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        return {
            calls: [],
            assistantText: '',
        };
    }
    const options = requestPresetOptions && typeof requestPresetOptions === 'object' ? requestPresetOptions : {};
    const retries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax || 0) || 0)));
    const usePlainTextCalls = isPlainTextFunctionCallModeEnabled(settings);
    const requestMessages = usePlainTextCalls
        ? mergeUserAddendumIntoPromptMessages(promptMessages, buildPlainTextToolProtocolMessage(tools))
        : promptMessages;
    const allowSet = allowedNames instanceof Set
        ? allowedNames
        : Array.isArray(allowedNames)
            ? new Set(allowedNames.map(name => String(name || '').trim()).filter(Boolean))
            : null;

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const responseData = await sendOpenAIRequest('quiet', requestMessages, null, {
                tools: usePlainTextCalls ? [] : tools,
                toolChoice: 'auto',
                replaceTools: true,
                requestScope: 'extension_internal',
                llmPresetName: options.llmPresetName,
                apiPresetName: options.apiPresetName,
                apiSettingsOverride: options.apiSettingsOverride,
            });
            const rawContent = getResponseMessageContent(responseData);
            const assistantText = usePlainTextCalls
                ? extractDisplayTextFromPlainTextFunctionResponse(rawContent)
                : rawContent;

            if (!usePlainTextCalls) {
                const calls = extractToolCallsFromResponse(responseData)
                    .filter(call => !allowSet || allowSet.has(String(call?.name || '').trim()));
                return { calls, assistantText };
            }

            const calls = extractToolCallsFromTextResponse(responseData, allowSet);
            return { calls, assistantText };
        } catch (error) {
            lastError = error;
            if (attempt >= retries) {
                throw error;
            }
            console.warn(`[${MODULE_NAME}] Lorebook tool call request failed. Retrying (${attempt + 1}/${retries})...`, error);
        }
    }

    if (lastError) {
        throw lastError;
    }
    return {
        calls: [],
        assistantText: '',
    };
}

function normalizeModelOperationArgs(kind, args, targetBook) {
    const safeArgs = args && typeof args === 'object' ? args : {};
    if (kind === 'lorebook_upsert_entry') {
        const entryUid = asFiniteInteger(safeArgs.entry_uid, null);
        if (!Number.isInteger(entryUid) || entryUid < 0) {
            return null;
        }
        const normalized = {
            book_name: targetBook,
            entry_uid: entryUid,
        };
        if (Object.hasOwn(safeArgs, 'key_csv')) {
            normalized.key_csv = String(safeArgs.key_csv ?? '');
        }
        if (Object.hasOwn(safeArgs, 'secondary_key_csv')) {
            normalized.secondary_key_csv = String(safeArgs.secondary_key_csv ?? '');
        }
        if (Object.hasOwn(safeArgs, 'comment')) {
            normalized.comment = String(safeArgs.comment ?? '');
        }
        if (Object.hasOwn(safeArgs, 'content')) {
            normalized.content = String(safeArgs.content ?? '');
        }
        if (Object.hasOwn(safeArgs, 'selective_logic')) {
            const value = asFiniteInteger(safeArgs.selective_logic, null);
            if (value !== null) {
                normalized.selective_logic = value;
            }
        }
        if (Object.hasOwn(safeArgs, 'order')) {
            const value = asFiniteInteger(safeArgs.order, null);
            if (value !== null) {
                normalized.order = value;
            }
        }
        if (Object.hasOwn(safeArgs, 'position')) {
            const value = asFiniteInteger(safeArgs.position, null);
            if (value !== null) {
                normalized.position = value;
            }
        }
        if (Object.hasOwn(safeArgs, 'depth')) {
            const value = asFiniteInteger(safeArgs.depth, null);
            if (value !== null) {
                normalized.depth = value;
            }
        }
        if (Object.hasOwn(safeArgs, 'enabled')) {
            normalized.enabled = Boolean(safeArgs.enabled);
        }
        if (Object.hasOwn(safeArgs, 'disable')) {
            normalized.disable = Boolean(safeArgs.disable);
        }
        if (Object.hasOwn(safeArgs, 'constant')) {
            normalized.constant = Boolean(safeArgs.constant);
        }
        return normalized;
    }
    if (kind === 'lorebook_delete_entry') {
        const entryUid = asFiniteInteger(safeArgs.entry_uid, null);
        if (!Number.isInteger(entryUid) || entryUid < 0) {
            return null;
        }
        return {
            book_name: targetBook,
            entry_uid: entryUid,
        };
    }
    return null;
}

async function requestModelLorebookDiffAnalysis(context, plan) {
    const targetBook = String(plan?.targetBook || '').trim();
    if (!targetBook) {
        return {
            assistantText: '',
        };
    }
    const contextPayload = buildLorebookModelContextPayload(plan, '');
    const systemPrompt = [
        'You are analyzing differences between an old lorebook and a new lorebook.',
        'Do not call tools in this step. Provide analysis only.',
        'Focus on migration risk, conflicts, and what should likely be preserved from the old lorebook.',
        `Target lorebook is "${targetBook}".`,
    ].join('\n');
    const userPrompt = [
        'Analyze this lorebook diff payload and summarize key points for the user.',
        'Keep it concise and practical.',
        JSON.stringify(contextPayload),
    ].join('\n\n');
    const requestPresetOptions = getLorebookSyncRequestPresetOptions(context);
    const requestMessages = buildPresetAwareLorebookMessages(context, systemPrompt, userPrompt, requestPresetOptions);

    const responseData = await sendOpenAIRequest('quiet', requestMessages, null, {
        requestScope: 'extension_internal',
        llmPresetName: requestPresetOptions.llmPresetName,
        apiPresetName: requestPresetOptions.apiPresetName,
        apiSettingsOverride: requestPresetOptions.apiSettingsOverride,
    });

    return {
        assistantText: String(responseData?.choices?.[0]?.message?.content || '').trim(),
    };
}

async function requestModelLorebookConversationReply(context, plan, conversationMessages, { draftEntries = {}, finalOperationSpecs = [], approvalMap = null } = {}) {
    const targetBook = String(plan?.targetBook || '').trim();
    if (!targetBook) {
        return { assistantText: '', operations: [] };
    }

    const contextPayload = buildLorebookModelContextPayload(plan, '', '');
    const history = (Array.isArray(conversationMessages) ? conversationMessages : [])
        .map(item => ({
            role: String(item?.role || ''),
            content: String(item?.content || '').trim(),
        }))
        .filter(item => (item.role === 'assistant' || item.role === 'user') && item.content);

    const safeDraftEntries = draftEntries && typeof draftEntries === 'object' ? draftEntries : {};
    const draftEntryUids = Array.from(collectLorebookEntryUids(safeDraftEntries).values()).sort((a, b) => a - b);
    const draftEntrySample = draftEntryUids.map(uid => compactEntryForModel(getLorebookEntryByUid(safeDraftEntries, uid), uid));
    const reviewContext = buildFinalDiffReviewContext(finalOperationSpecs, approvalMap);

    const systemPrompt = [
        'You are assisting the user in reviewing lorebook diffs.',
        'Continue the conversation and answer the user message directly.',
        'After your reply, you may provide tool calls to propose draft lorebook edits for this round.',
        'Tool calls are draft-only proposals and will not be auto-applied immediately.',
        'Respect review decisions: rejected operations are intentionally excluded.',
        'Do not re-propose rejected {kind, entry_uid} operations unless user explicitly asks to reconsider them.',
        'Use tool calls only when proposing concrete entry changes; otherwise return no tool calls.',
        'Be concise, practical, and grounded in the provided diff context.',
        `Target lorebook is "${targetBook}".`,
    ].join('\n');
    const userPrompt = [
        'Conversation task for lorebook sync:',
        JSON.stringify({
            context: contextPayload,
            conversation_history: history,
            final_diff_review: reviewContext,
            draft_entry_count: Number(draftEntryUids.length),
            draft_entry_sample: draftEntrySample,
        }),
    ].join('\n\n');
    const requestPresetOptions = getLorebookSyncRequestPresetOptions(context);
    const requestMessages = buildPresetAwareLorebookMessages(context, systemPrompt, userPrompt, requestPresetOptions);
    const settings = getSettings();
    const allowedToolNames = ['lorebook_upsert_entry', 'lorebook_delete_entry'];

    const { calls: rawCalls, assistantText } = await requestLorebookToolCallsWithRetry(
        settings,
        requestMessages,
        {
            tools: buildLorebookSyncModelTools(),
            allowedNames: allowedToolNames,
            requestPresetOptions,
        },
    );
    const operations = normalizeModelOperationsFromCalls(rawCalls, targetBook);
    return {
        assistantText: String(assistantText || '').trim(),
        operations,
    };
}

async function finalizeLorebookSyncReplacement(context, previousSnapshot, currentSnapshot, currentCharacter) {
    const previousBook = String(previousSnapshot?.bookName || '').trim();
    const embeddedImport = getEmbeddedLorebookImportPayload(currentCharacter);
    const targetBook = String(embeddedImport?.bookName || currentSnapshot?.bookName || '').trim();
    const avatar = String(currentSnapshot?.avatar || currentCharacter?.avatar || '').trim();

    if (avatar && targetBook) {
        await mergeCharacterAttributes(context, avatar, {
            data: {
                extensions: {
                    world: targetBook,
                },
            },
        });
    }

    if (previousBook && targetBook && previousBook !== targetBook) {
        const existingPrevious = await context.loadWorldInfo(previousBook);
        if (existingPrevious) {
            const deleted = await deleteWorldInfo(previousBook);
            if (!deleted) {
                throw new Error(`Failed to delete old lorebook '${previousBook}'.`);
            }
        }
    }
    await syncWorldBindingUi(context, targetBook);

    return {
        previousBook,
        targetBook,
    };
}

async function submitGeneratedOperations(context, operationSpecs, source = 'character_update_lorebook_sync', { targetAvatar = '' } = {}) {
    const specs = Array.isArray(operationSpecs) ? operationSpecs : [];
    const avatar = String(targetAvatar || '').trim();
    let applied = 0;
    let failed = 0;
    const errors = [];
    for (const spec of specs) {
        try {
            const state = await loadOperationState(context, { avatar });
            const operation = createOperationEnvelope(state, spec.kind, spec.args, source, { targetAvatar: avatar });
            await persistOperationState(context, state, { avatar });
            await submitOperation(context, operation, { avatar });
            applied++;
        } catch (error) {
            failed++;
            errors.push(String(error?.message || error));
        }
    }
    return { applied, failed, errors };
}

function buildCharacterEditorModelTools() {
    return [
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.UPDATE_FIELDS,
                description: 'Update current character card fields.',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        description: { type: 'string' },
                        personality: { type: 'string' },
                        scenario: { type: 'string' },
                        mes_example: { type: 'string' },
                        system_prompt: { type: 'string' },
                        post_history_instructions: { type: 'string' },
                        creator_notes: { type: 'string' },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.SET_PRIMARY_BOOK,
                description: 'Set or clear current character primary lorebook binding.',
                parameters: {
                    type: 'object',
                    properties: {
                        book_name: { type: 'string' },
                        create_if_missing: { type: 'boolean' },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.UPSERT_ENTRY,
                description: 'Create or update one lorebook entry.',
                parameters: {
                    type: 'object',
                    properties: {
                        book_name: { type: 'string' },
                        create_if_missing: { type: 'boolean' },
                        entry_uid: { type: 'integer' },
                        key_csv: { type: 'string' },
                        secondary_key_csv: { type: 'string' },
                        comment: { type: 'string' },
                        content: { type: 'string' },
                        selective_logic: { type: 'integer' },
                        order: { type: 'integer' },
                        position: { type: 'integer' },
                        depth: { type: 'integer' },
                        enabled: { type: 'boolean' },
                        disable: { type: 'boolean' },
                        constant: { type: 'boolean' },
                    },
                    required: ['entry_uid'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: TOOL_NAMES.DELETE_ENTRY,
                description: 'Delete one lorebook entry by UID.',
                parameters: {
                    type: 'object',
                    properties: {
                        book_name: { type: 'string' },
                        entry_uid: { type: 'integer' },
                    },
                    required: ['entry_uid'],
                    additionalProperties: false,
                },
            },
        },
    ];
}

function normalizeCharacterEditorOperationsFromCalls(rawCalls) {
    const output = [];
    const rootFieldNames = ['name', 'description', 'personality', 'scenario', 'mes_example'];
    const dataFieldNames = ['system_prompt', 'post_history_instructions', 'creator_notes'];
    for (const call of Array.isArray(rawCalls) ? rawCalls : []) {
        const name = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        if (name === TOOL_NAMES.UPDATE_FIELDS) {
            const normalizedArgs = {};
            for (const key of [...rootFieldNames, ...dataFieldNames]) {
                if (Object.hasOwn(args, key)) {
                    normalizedArgs[key] = String(args[key] ?? '');
                }
            }
            if (Object.keys(normalizedArgs).length > 0) {
                output.push({ kind: 'character_fields', args: normalizedArgs });
            }
            continue;
        }
        if (name === TOOL_NAMES.SET_PRIMARY_BOOK) {
            const normalizedArgs = {};
            if (Object.hasOwn(args, 'book_name')) {
                normalizedArgs.book_name = String(args.book_name ?? '');
            }
            if (Object.hasOwn(args, 'create_if_missing')) {
                normalizedArgs.create_if_missing = Boolean(args.create_if_missing);
            }
            output.push({ kind: 'set_primary_lorebook', args: normalizedArgs });
            continue;
        }
        if (name === TOOL_NAMES.UPSERT_ENTRY) {
            const uid = asFiniteInteger(args.entry_uid, null);
            if (!Number.isInteger(uid) || uid < 0) {
                continue;
            }
            const normalizedArgs = { entry_uid: uid };
            const passThrough = ['book_name', 'key_csv', 'secondary_key_csv', 'comment', 'content'];
            for (const key of passThrough) {
                if (Object.hasOwn(args, key)) {
                    normalizedArgs[key] = String(args[key] ?? '');
                }
            }
            const intFields = ['selective_logic', 'order', 'position', 'depth'];
            for (const key of intFields) {
                if (!Object.hasOwn(args, key)) {
                    continue;
                }
                const value = asFiniteInteger(args[key], null);
                if (value !== null) {
                    normalizedArgs[key] = value;
                }
            }
            const boolFields = ['create_if_missing', 'enabled', 'disable', 'constant'];
            for (const key of boolFields) {
                if (Object.hasOwn(args, key)) {
                    normalizedArgs[key] = Boolean(args[key]);
                }
            }
            output.push({ kind: 'lorebook_upsert_entry', args: normalizedArgs });
            continue;
        }
        if (name === TOOL_NAMES.DELETE_ENTRY) {
            const uid = asFiniteInteger(args.entry_uid, null);
            if (!Number.isInteger(uid) || uid < 0) {
                continue;
            }
            const normalizedArgs = { entry_uid: uid };
            if (Object.hasOwn(args, 'book_name')) {
                normalizedArgs.book_name = String(args.book_name ?? '');
            }
            output.push({ kind: 'lorebook_delete_entry', args: normalizedArgs });
        }
    }
    return output;
}

function buildCharacterEditorOperationKey(operation) {
    const kind = String(operation?.kind || '').trim();
    if (!kind) {
        return '';
    }
    if (kind === 'lorebook_upsert_entry' || kind === 'lorebook_delete_entry') {
        const uid = asFiniteInteger(operation?.args?.entry_uid, null);
        const bookName = String(operation?.args?.book_name || '').trim();
        return `${kind}:${bookName}:${Number.isInteger(uid) ? uid : '?'}`;
    }
    if (kind === 'set_primary_lorebook') {
        return `${kind}:${String(operation?.args?.book_name || '').trim()}`;
    }
    if (kind === 'character_fields') {
        const keys = Object.keys(operation?.args || {}).sort().join(',');
        return `${kind}:${keys}`;
    }
    return `${kind}:${JSON.stringify(operation?.args || {})}`;
}

async function buildCharacterEditorContextPayload(context, avatar = '') {
    const record = getActiveCharacterRecord(context, { avatar });
    const character = record.character || {};
    const primaryBook = getPrimaryLorebookName(character);
    const lorebookData = primaryBook ? await loadLorebookData(context, primaryBook) : { entries: {} };
    const operationState = await loadOperationState(context, { avatar: record.avatar });
    const recentJournal = Array.isArray(operationState?.journal) ? operationState.journal : [];
    const entryUids = Object.keys(lorebookData.entries || {}).map(uid => asFiniteInteger(uid, null)).filter(uid => Number.isInteger(uid) && uid >= 0).sort((a, b) => a - b);
    const entrySample = entryUids.map(uid => compactEntryForModel(lorebookData.entries[uid], uid));
    return {
        avatar: record.avatar,
        name: String(character?.name || ''),
        fields: {
            description: String(character?.description || ''),
            personality: String(character?.personality || ''),
            scenario: String(character?.scenario || ''),
            mes_example: String(character?.mes_example || ''),
            system_prompt: String(character?.data?.system_prompt || ''),
            post_history_instructions: String(character?.data?.post_history_instructions || ''),
            creator_notes: String(character?.data?.creator_notes || ''),
        },
        primary_lorebook: {
            name: primaryBook,
            entry_count: Number(Object.keys(lorebookData.entries || {}).length),
            sample: entrySample,
        },
        recent_journal: recentJournal.map(item => ({
            kind: String(item?.kind || ''),
            summary: String(item?.summary || ''),
        })),
    };
}

async function requestModelCharacterEditorConversationReply(context, conversationMessages, { avatar = '', rejectedOperationKeys = [] } = {}) {
    const payload = await buildCharacterEditorContextPayload(context, avatar);
    const history = (Array.isArray(conversationMessages) ? conversationMessages : [])
        .map(item => ({
            role: String(item?.role || ''),
            content: String(item?.content || '').trim(),
        }))
        .filter(item => (item.role === 'assistant' || item.role === 'user') && item.content);
    const systemPrompt = [
        'You are editing the current character card and its primary lorebook.',
        'Continue the conversation naturally, and propose edits only when needed.',
        'Use tool calls for concrete edits.',
        `Available tools: ${Object.values(TOOL_NAMES).join(', ')}`,
        'Do not repeat rejected operation keys unless user explicitly asks to reconsider.',
    ].join('\n');
    const userPrompt = [
        'Character editor conversation payload:',
        JSON.stringify({
            context: payload,
            conversation_history: history,
            rejected_operation_keys: Array.isArray(rejectedOperationKeys) ? rejectedOperationKeys : [],
        }),
    ].join('\n\n');
    const requestPresetOptions = getLorebookSyncRequestPresetOptions(context);
    const requestMessages = buildPresetAwareLorebookMessages(context, systemPrompt, userPrompt, requestPresetOptions);
    const settings = getSettings();
    const allowedToolNames = Object.values(TOOL_NAMES);
    const { calls: rawCalls, assistantText } = await requestLorebookToolCallsWithRetry(
        settings,
        requestMessages,
        {
            tools: buildCharacterEditorModelTools(),
            allowedNames: allowedToolNames,
            requestPresetOptions,
        },
    );
    return {
        assistantText: String(assistantText || '').trim(),
        operations: normalizeCharacterEditorOperationsFromCalls(rawCalls),
    };
}

function buildCharacterFieldsDiffPreview(operation, draftCharacter) {
    const args = operation?.args && typeof operation.args === 'object' ? operation.args : {};
    const preview = { title: buildOperationSummary(operation), fields: [], meta: [], rawArgs: clone(args) };
    const rootFieldNames = ['name', 'description', 'personality', 'scenario', 'mes_example'];
    const dataFieldNames = ['system_prompt', 'post_history_instructions', 'creator_notes'];
    for (const key of rootFieldNames) {
        if (!Object.hasOwn(args, key)) {
            continue;
        }
        const beforeValue = String(draftCharacter?.[key] ?? '');
        const afterValue = String(args[key] ?? '');
        pushDiffField(preview.fields, key, beforeValue, afterValue, { force: true });
        draftCharacter[key] = afterValue;
    }
    const data = draftCharacter?.data && typeof draftCharacter.data === 'object' ? draftCharacter.data : {};
    if (!draftCharacter.data || typeof draftCharacter.data !== 'object') {
        draftCharacter.data = data;
    }
    for (const key of dataFieldNames) {
        if (!Object.hasOwn(args, key)) {
            continue;
        }
        const beforeValue = String(data?.[key] ?? '');
        const afterValue = String(args[key] ?? '');
        pushDiffField(preview.fields, key, beforeValue, afterValue, { force: true });
        data[key] = afterValue;
    }
    if (preview.fields.length === 0) {
        pushDiffField(preview.fields, 'fields', '', '', { force: true });
    }
    return preview;
}

function buildPrimaryLorebookDiffPreview(operation, draftCharacter) {
    const args = operation?.args && typeof operation.args === 'object' ? operation.args : {};
    const beforeName = getPrimaryLorebookName(draftCharacter);
    const afterName = String(args.book_name || '').trim();
    const preview = {
        title: buildOperationSummary(operation),
        fields: [],
        meta: [],
        rawArgs: clone(args),
    };
    pushDiffField(preview.fields, 'primary lorebook', beforeName || '', afterName || '', { force: true });
    if (!draftCharacter.data || typeof draftCharacter.data !== 'object') {
        draftCharacter.data = {};
    }
    if (!draftCharacter.data.extensions || typeof draftCharacter.data.extensions !== 'object') {
        draftCharacter.data.extensions = {};
    }
    draftCharacter.data.extensions.world = afterName;
    return preview;
}

async function buildCharacterEditorDiffPreviews(context, operations, { avatar = '' } = {}) {
    const record = getActiveCharacterRecord(context, { avatar });
    const draftCharacter = clone(record.character || {});
    const lorebookCache = new Map();
    const getDraftLorebook = async (bookName) => {
        const key = String(bookName || '').trim();
        if (!key) {
            return null;
        }
        if (lorebookCache.has(key)) {
            return lorebookCache.get(key);
        }
        const loaded = await loadLorebookData(context, key);
        const cached = clone(loaded || { entries: {} }) || { entries: {} };
        if (!cached.entries || typeof cached.entries !== 'object') {
            cached.entries = {};
        }
        lorebookCache.set(key, cached);
        return cached;
    };

    const previews = [];
    for (const operation of Array.isArray(operations) ? operations : []) {
        const kind = String(operation?.kind || '').trim();
        if (kind === 'character_fields') {
            previews.push(buildCharacterFieldsDiffPreview(operation, draftCharacter));
            continue;
        }
        if (kind === 'set_primary_lorebook') {
            previews.push(buildPrimaryLorebookDiffPreview(operation, draftCharacter));
            continue;
        }
        if (kind === 'lorebook_upsert_entry' || kind === 'lorebook_delete_entry') {
            const args = operation?.args && typeof operation.args === 'object' ? operation.args : {};
            const entryUid = asFiniteInteger(args.entry_uid, null);
            const bookName = String(args.book_name || '').trim() || getPrimaryLorebookName(draftCharacter);
            if (!bookName || !Number.isInteger(entryUid) || entryUid < 0) {
                previews.push({
                    title: buildOperationSummary(operation),
                    fields: [{ label: 'operation', before: '', after: 'invalid args' }],
                    meta: [],
                    rawArgs: clone(args),
                });
                continue;
            }
            const lorebookData = await getDraftLorebook(bookName);
            const beforeEntry = getLorebookEntryByUid(lorebookData?.entries, entryUid);
            let afterEntry = beforeEntry ? clone(beforeEntry) : null;
            if (kind === 'lorebook_upsert_entry') {
                afterEntry = applyLorebookEntryArgs(beforeEntry, args, entryUid);
                lorebookData.entries[String(entryUid)] = clone(afterEntry);
            } else {
                delete lorebookData.entries[String(entryUid)];
                afterEntry = null;
            }
            previews.push(buildLorebookDraftDiffPreview(
                { kind, args: { ...clone(args), book_name: bookName, entry_uid: entryUid } },
                bookName,
                beforeEntry,
                afterEntry,
            ));
            continue;
        }
        previews.push({
            title: buildOperationSummary(operation),
            fields: [{ label: 'operation', before: '', after: '' }],
            meta: [],
            rawArgs: clone(operation?.args || {}),
        });
    }
    return previews;
}

function renderCharacterEditorBatchDiffItems(previews, operations) {
    const safePreviews = Array.isArray(previews) ? previews : [];
    const safeOperations = Array.isArray(operations) ? operations : [];
    return safePreviews.map((preview, index) => {
        const fields = Array.isArray(preview?.fields) ? preview.fields : [];
        const meta = Array.isArray(preview?.meta) ? preview.meta : [];
        const operation = safeOperations[index] || null;
        const rawArgs = operation?.args || preview?.rawArgs || {};
        return `
<div class="cea_sync_turn_diff_item">
    <div class="cea_sync_turn_diff_title">${escapeHtml(i18nFormat('Operation ${0}', index + 1))}: ${escapeHtml(String(preview?.title || ''))}</div>
    ${meta.length > 0 ? `<div class="cea_sync_turn_diff_meta">${meta.map(item => `
        <div class="cea_sync_turn_diff_meta_item"><b>${escapeHtml(String(item?.label || ''))}:</b> ${escapeHtml(String(item?.value || ''))}</div>
    `).join('')}</div>` : ''}
    <div class="cea_sync_turn_diff_fields">
        ${fields.map(field => `
<div class="cea_sync_turn_diff_field">
    <div class="cea_sync_turn_diff_label">${escapeHtml(String(field?.label || 'field'))}</div>
    ${renderLineDiffHtml(field?.before ?? '', field?.after ?? '', String(field?.label || 'field'))}
</div>`).join('')}
    </div>
    <details class="cea_sync_turn_diff_raw">
        <summary>${escapeHtml(i18n('Raw arguments'))}</summary>
        <pre>${escapeHtml(JSON.stringify(rawArgs, null, 2))}</pre>
    </details>
</div>`;
    }).join('');
}

function renderCharacterEditorRoundDiffHtml(previews, operations, { open = true } = {}) {
    const safePreviews = Array.isArray(previews) ? previews : [];
    const summary = safePreviews.length > 0
        ? i18nFormat('Round diff (${0} operations)', safePreviews.length)
        : i18n('Round diff');
    if (safePreviews.length === 0) {
        return `
<details class="cea_sync_turn_diff"${open ? ' open' : ''}>
    <summary>${escapeHtml(summary)}</summary>
    <div class="cea_sync_turn_diff_empty">${escapeHtml(i18n('No draft operations proposed in this round.'))}</div>
</details>`;
    }
    return `
<details class="cea_sync_turn_diff"${open ? ' open' : ''}>
    <summary>${escapeHtml(summary)}</summary>
    <div class="cea_sync_turn_diff_list">
        ${renderCharacterEditorBatchDiffItems(safePreviews, operations)}
    </div>
</details>`;
}

function renderCharacterEditorChatMessages(messages, { loading = false, loadingText = '' } = {}) {
    const list = Array.isArray(messages) ? messages : [];
    const html = list.map(item => {
        const role = String(item?.role || 'assistant');
        const text = String(item?.content || '').trim();
        const previews = Array.isArray(item?.diffPreviews) ? item.diffPreviews : [];
        const operations = Array.isArray(item?.operations) ? item.operations : [];
        const hasDiffData = previews.length > 0 || operations.length > 0;
        if (!text && !hasDiffData) {
            return '';
        }
        if (role === 'user') {
            return `
<div class="cea_sync_chat_msg cea_sync_chat_msg_user">
    <pre>${escapeHtml(text)}</pre>
</div>`;
        }
        return `
<div class="cea_sync_chat_msg cea_sync_chat_msg_assistant">
    ${text ? `<div class="cea_sync_chat_text">${renderLorebookSyncAnalysisMarkdown(text)}</div>` : ''}
    ${hasDiffData ? renderCharacterEditorRoundDiffHtml(previews, operations, { open: false }) : ''}
</div>`;
    }).join('');
    if (!loading) {
        return html;
    }
    const loadingLabel = String(loadingText || i18n('Assistant is thinking...'));
    return `${html}
<div class="cea_sync_chat_msg cea_sync_chat_msg_assistant cea_sync_chat_msg_loading">
    <i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
    <span>${escapeHtml(loadingLabel)}</span>
</div>`;
}

function renderCharacterEditorPendingHtml(pending) {
    if (!pending || typeof pending !== 'object') {
        return '';
    }
    const previews = Array.isArray(pending.diffPreviews) ? pending.diffPreviews : [];
    const operations = Array.isArray(pending.operations) ? pending.operations : [];
    return `
<div class="cea_editor_pending">
    <div class="cea_editor_pending_hint">${escapeHtml(i18n('AI proposed changes are waiting for approval.'))}</div>
    ${renderCharacterEditorRoundDiffHtml(previews, operations, { open: true })}
    <div class="cea_editor_pending_actions">
        <div class="menu_button" data-cea-editor-action="approve-batch">${escapeHtml(i18n('Approve batch'))}</div>
        <div class="menu_button" data-cea-editor-action="reject-batch">${escapeHtml(i18n('Reject batch'))}</div>
    </div>
</div>`;
}

function buildCharacterEditorPopupHtml(record) {
    const characterName = String(record?.character?.name || '').trim() || '(unknown)';
    const primaryBook = String(getPrimaryLorebookName(record?.character || {}) || i18n('(empty)'));
    return `
<div class="cea_sync_popup">
    <div class="cea_sync_intro">${escapeHtml(i18n('Character Editor'))}</div>
    <div class="cea_sync_meta">
        <div class="cea_sync_meta_item"><b>Character:</b> ${escapeHtml(characterName)}</div>
        <div class="cea_sync_meta_item"><b>${escapeHtml(i18n('Target lorebook'))}:</b> ${escapeHtml(primaryBook)}</div>
    </div>
    <div class="cea_sync_chat" data-cea-editor-chat></div>
    <div class="cea_sync_composer">
        <textarea class="text_pole textarea_compact" rows="4" data-cea-editor-input placeholder="${escapeHtml(i18n('Type your requirement to continue this conversation...'))}"></textarea>
        <div class="menu_button menu_button_small" data-cea-editor-send>${escapeHtml(i18n('Send'))}</div>
    </div>
    <div data-cea-editor-pending></div>
    <details class="cea_sync_history">
        <summary>${escapeHtml(i18n('History'))}</summary>
        <div class="cea_sync_history_list" data-cea-editor-history></div>
    </details>
</div>`;
}

async function openCharacterEditorPopup(context = getContext()) {
    const settings = getSettings();
    let record;
    try {
        record = getActiveCharacterRecord(context);
    } catch {
        notifyWarning(i18n('Current chat has no active character.'));
        return;
    }
    const avatar = String(record.avatar || '').trim();
    if (!avatar) {
        notifyWarning(i18n('Current chat has no active character.'));
        return;
    }
    if (editorStudioDialogLocks.has(avatar)) {
        notifyWarning(i18n('An editor is already open for this character.'));
        return;
    }
    editorStudioDialogLocks.add(avatar);

    const conversationMessages = [];
    let pendingApproval = null;
    let isSending = false;
    const rejectedOperationKeys = new Set();

    const popup = new Popup(
        buildCharacterEditorPopupHtml(record),
        POPUP_TYPE.TEXT,
        i18n('Character Editor'),
        {
            wide: true,
            wider: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: i18n('Close'),
            onOpen: (instance) => {
                const chat = instance?.content?.querySelector('[data-cea-editor-chat]');
                const input = instance?.content?.querySelector('[data-cea-editor-input]');
                const sendBtn = instance?.content?.querySelector('[data-cea-editor-send]');
                const pendingSlot = instance?.content?.querySelector('[data-cea-editor-pending]');
                const history = instance?.content?.querySelector('[data-cea-editor-history]');
                if (!(chat instanceof HTMLElement) || !(input instanceof HTMLTextAreaElement) || !(sendBtn instanceof HTMLElement) || !(pendingSlot instanceof HTMLElement) || !(history instanceof HTMLElement)) {
                    return;
                }
                const renderConversation = (loading = false, loadingText = '') => {
                    chat.innerHTML = renderCharacterEditorChatMessages(conversationMessages, { loading, loadingText });
                    chat.scrollTop = chat.scrollHeight;
                };
                const renderPending = () => {
                    pendingSlot.innerHTML = renderCharacterEditorPendingHtml(pendingApproval);
                };
                const renderHistory = async () => {
                    try {
                        const state = await loadOperationState(context, { force: true, avatar });
                        history.innerHTML = renderLorebookSyncHistoryItems(state);
                    } catch {
                        history.innerHTML = `<div class="cea_sync_history_empty">${escapeHtml(i18n('No history yet.'))}</div>`;
                    }
                };
                const setComposerState = (disabled) => {
                    input.disabled = Boolean(disabled);
                    sendBtn.classList.toggle('disabled', Boolean(disabled));
                };
                const handleSend = async () => {
                    if (isSending || input.disabled) {
                        return;
                    }
                    if (pendingApproval) {
                        notifyWarning(i18n('Please approve or reject pending changes first.'));
                        return;
                    }
                    const userText = String(input.value || '').trim();
                    if (!userText) {
                        notifyWarning(i18n('Message cannot be empty.'));
                        return;
                    }
                    conversationMessages.push({ role: 'user', content: userText });
                    input.value = '';
                    isSending = true;
                    setComposerState(true);
                    renderConversation(true, i18n('Assistant is thinking...'));
                    try {
                        const reply = await requestModelCharacterEditorConversationReply(
                            context,
                            conversationMessages,
                            {
                                avatar,
                                rejectedOperationKeys: Array.from(rejectedOperationKeys.values()),
                            },
                        );
                        const operations = Array.isArray(reply?.operations) ? reply.operations : [];
                        const diffPreviews = operations.length > 0
                            ? await buildCharacterEditorDiffPreviews(context, operations, { avatar })
                            : [];
                        const assistantText = String(reply?.assistantText || '').trim()
                            || (operations.length > 0
                                ? i18nFormat('Proposed ${0} operations in this round.', operations.length)
                                : i18n('No draft operations proposed in this round.'));
                        const assistantMessage = {
                            role: 'assistant',
                            content: assistantText,
                        };
                        if (operations.length > 0) {
                            assistantMessage.operations = operations;
                            assistantMessage.diffPreviews = diffPreviews;
                        }
                        conversationMessages.push(assistantMessage);
                        pendingApproval = operations.length > 0 ? { operations, diffPreviews } : null;
                        renderPending();
                    } catch (error) {
                        conversationMessages.push({
                            role: 'assistant',
                            content: i18nFormat('Model reply failed: ${0}', String(error?.message || error || '')),
                        });
                    } finally {
                        isSending = false;
                        setComposerState(false);
                        renderConversation(false);
                    }
                };

                sendBtn.addEventListener('click', () => void handleSend());
                input.addEventListener('keydown', (event) => {
                    if (event.key !== 'Enter' || event.shiftKey) {
                        return;
                    }
                    event.preventDefault();
                    void handleSend();
                });
                pendingSlot.addEventListener('click', async (event) => {
                    const target = event.target instanceof Element ? event.target.closest('[data-cea-editor-action]') : null;
                    if (!(target instanceof HTMLElement) || !pendingApproval || isSending) {
                        return;
                    }
                    const action = String(target.getAttribute('data-cea-editor-action') || '').trim();
                    if (action === 'reject-batch') {
                        for (const operation of pendingApproval.operations) {
                            const key = buildCharacterEditorOperationKey(operation);
                            if (key) {
                                rejectedOperationKeys.add(key);
                            }
                        }
                        pendingApproval = null;
                        renderPending();
                        conversationMessages.push({ role: 'assistant', content: i18n('Changes rejected.') });
                        renderConversation(false);
                        return;
                    }
                    if (action === 'approve-batch') {
                        const snapshot = pendingApproval;
                        pendingApproval = null;
                        renderPending();
                        isSending = true;
                        setComposerState(true);
                        renderConversation(true, i18n('Applying approved changes...'));
                        try {
                            const result = await submitGeneratedOperations(
                                context,
                                snapshot.operations,
                                'character_editor_popup',
                                { targetAvatar: avatar },
                            );
                            if (result.failed > 0) {
                                conversationMessages.push({ role: 'assistant', content: i18nFormat('Apply failed: ${0}', String(result.errors[0] || 'unknown error')) });
                            } else {
                                conversationMessages.push({ role: 'assistant', content: i18n('Changes applied.') });
                            }
                            await refreshUiState(context);
                            await renderHistory();
                            await primeActiveCharacterLorebookSnapshot(context);
                        } catch (error) {
                            pendingApproval = snapshot;
                            renderPending();
                            conversationMessages.push({ role: 'assistant', content: i18nFormat('Apply failed: ${0}', String(error?.message || error || '')) });
                        } finally {
                            isSending = false;
                            setComposerState(false);
                            renderConversation(false);
                        }
                    }
                });
                history.addEventListener('click', async (event) => {
                    const target = event.target instanceof Element ? event.target.closest('[data-cea-sync-history-action]') : null;
                    if (!(target instanceof HTMLElement)) {
                        return;
                    }
                    const action = String(target.getAttribute('data-cea-sync-history-action') || '').trim();
                    const journalId = String(target.getAttribute('data-cea-sync-history-id') || '').trim();
                    try {
                        if (action === 'clear') {
                            if (!window.confirm(i18n('Clear all history records?'))) {
                                return;
                            }
                            await clearHistoryRecords(context, { avatar });
                            await renderHistory();
                            await refreshUiState(context);
                            notifySuccess(i18n('History cleared.'));
                            return;
                        }
                        if (!journalId) {
                            return;
                        }
                        if (action === 'delete') {
                            if (!window.confirm(i18n('Delete this history record?'))) {
                                return;
                            }
                            const deleted = await deleteHistoryRecord(context, journalId, { avatar });
                            if (!deleted) {
                                throw new Error('Journal entry not found.');
                            }
                            await renderHistory();
                            await refreshUiState(context);
                            notifySuccess(i18n('History record deleted.'));
                            return;
                        }
                        if (action === 'rollback') {
                            const state = await loadOperationState(context, { force: true, avatar });
                            const { entry } = getJournalById(state, journalId);
                            if (!entry) {
                                throw new Error('Journal entry not found.');
                            }
                            if (String(entry.kind || '') === 'rollback') {
                                throw new Error('Rollback is not supported for rollback records.');
                            }
                            const summary = await rollbackJournalEntry(context, entry, { avatar });
                            const rollbackLog = {
                                id: nextStateId(state, 'tx'),
                                operationId: entry.operationId,
                                kind: 'rollback',
                                source: 'manual',
                                summary,
                                data: { targetJournalId: entry.id },
                                createdAt: Date.now(),
                            };
                            appendJournal(state, rollbackLog, settings);
                            state.updatedAt = Date.now();
                            await persistOperationState(context, state, { avatar });
                            await renderHistory();
                            await refreshUiState(context);
                            await primeActiveCharacterLorebookSnapshot(context);
                            notifySuccess(i18n('Rollback completed.'));
                        }
                    } catch (error) {
                        if (action === 'rollback') {
                            notifyError(i18nFormat('Rollback failed: ${0}', error?.message || error));
                            return;
                        }
                        if (action === 'delete') {
                            notifyError(i18nFormat('Delete failed: ${0}', error?.message || error));
                            return;
                        }
                        if (action === 'clear') {
                            notifyError(i18nFormat('Clear failed: ${0}', error?.message || error));
                        }
                    }
                });

                renderConversation(false);
                renderPending();
                void renderHistory();
            },
            onClosing: () => {
                if (isSending) {
                    notifyWarning(i18n('Assistant is thinking...'));
                    return false;
                }
                return true;
            },
        },
    );

    try {
        await popup.show();
    } finally {
        editorStudioDialogLocks.delete(avatar);
    }
}

async function runLorebookSyncFlow(context, previousSnapshot, currentSnapshot, currentCharacter = null) {
    const embeddedImport = getEmbeddedLorebookImportPayload(currentCharacter);
    const effectiveCurrentSnapshot = embeddedImport
        ? {
            ...(currentSnapshot && typeof currentSnapshot === 'object' ? currentSnapshot : {}),
            bookName: String(embeddedImport.bookName || ''),
            entries: clone(embeddedImport.data?.entries || {}),
        }
        : currentSnapshot;
    const plan = buildLorebookSyncPlan(previousSnapshot, effectiveCurrentSnapshot);
    const targetAvatar = String(currentCharacter?.avatar || effectiveCurrentSnapshot?.avatar || '').trim();
    if (!plan.targetBook && !embeddedImport?.bookName && !plan.sourceBook) {
        return;
    }

    // If no meaningful diff, just do raw replace to avoid unnecessary interaction.
    if (!plan.targetBook || !Array.isArray(plan.diffItems) || plan.diffItems.length === 0) {
        const replaced = await applyDirectLorebookReplace(context, previousSnapshot, effectiveCurrentSnapshot, currentCharacter);
        await refreshUiState(context);
        notifySuccess(`Lorebook replaced: ${String(replaced.targetBook || '(none)')}`);
        return;
    }

    const selectedMode = await selectLorebookSyncMode(plan);
    if (selectedMode === 'direct_replace') {
        const replaced = await applyDirectLorebookReplace(context, previousSnapshot, effectiveCurrentSnapshot, currentCharacter);
        await refreshUiState(context);
        notifySuccess(`Lorebook replaced: ${String(replaced.targetBook || '(none)')}`);
        return;
    }
    if (selectedMode === 'skip_replace') {
        const restored = await restorePreviousLorebookBinding(context, previousSnapshot, effectiveCurrentSnapshot, currentCharacter);
        await refreshUiState(context);
        notifyWarning(i18nFormat('No replacement applied. Restored previous lorebook binding: ${0}', restored.previousBook || '(none)'));
        return;
    }

    let analysisReady = false;
    let isSending = false;
    const conversationMessages = [];
    const baselineTargetEntries = clone(effectiveCurrentSnapshot?.entries || {}) || {};
    const draftTargetEntries = clone(baselineTargetEntries) || {};
    const baselineLorebookData = buildLorebookSyncBaselineData(embeddedImport, baselineTargetEntries);
    const operationApprovalMap = new Map();
    const getCurrentFinalOperationSpecs = () => buildFinalLorebookOperationSpecsFromDraft(
        plan.targetBook,
        baselineTargetEntries,
        draftTargetEntries,
    );

    const popup = new Popup(
        buildLorebookSyncDialogHtml(plan),
        POPUP_TYPE.TEXT,
        '',
        {
            wide: true,
            wider: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: i18n('Save and update'),
            cancelButton: i18n('Cancel and restore previous lorebook'),
            onOpen: (instance) => {
                const chat = instance?.content?.querySelector('[data-cea-sync-chat]');
                const input = instance?.content?.querySelector('[data-cea-sync-input]');
                const sendBtn = instance?.content?.querySelector('[data-cea-sync-send]');
                const history = instance?.content?.querySelector('[data-cea-sync-history]');
                if (!(chat instanceof HTMLElement) || !(input instanceof HTMLTextAreaElement) || !(sendBtn instanceof HTMLElement) || !(history instanceof HTMLElement)) {
                    return;
                }
                const renderConversation = (loading = false, loadingText = '') => {
                    chat.innerHTML = renderLorebookSyncChatMessages(conversationMessages, { loading, loadingText, approvalMap: operationApprovalMap });
                    chat.scrollTop = chat.scrollHeight;
                };
                const renderHistory = async () => {
                    try {
                        const opState = await loadOperationState(context, { force: true, avatar: targetAvatar });
                        history.innerHTML = renderLorebookSyncHistoryItems(opState);
                    } catch {
                        history.innerHTML = `<div class="cea_sync_history_empty">${escapeHtml(i18n('No history yet.'))}</div>`;
                    }
                };
                const setComposerState = (disabled) => {
                    input.disabled = Boolean(disabled);
                    sendBtn.classList.toggle('disabled', Boolean(disabled));
                };
                const rollbackToMessage = (messageIndex) => {
                    const index = asFiniteInteger(messageIndex, -1);
                    if (!Number.isInteger(index) || index < 0 || index >= conversationMessages.length) {
                        return;
                    }
                    if (isSending || input.disabled) {
                        notifyWarning(i18n('Assistant is thinking...'));
                        return;
                    }
                    const targetMessage = conversationMessages[index];
                    const hasOperations = Array.isArray(targetMessage?.operations) && targetMessage.operations.length > 0;
                    if (!hasOperations) {
                        return;
                    }

                    let removeFrom = index;
                    const previous = removeFrom > 0 ? conversationMessages[removeFrom - 1] : null;
                    if (String(targetMessage?.role || '') === 'assistant' && String(previous?.role || '') === 'user') {
                        removeFrom -= 1;
                    }
                    conversationMessages.splice(removeFrom);
                    rebuildLorebookDraftEntriesFromConversation(
                        plan.targetBook,
                        baselineTargetEntries,
                        draftTargetEntries,
                        conversationMessages,
                    );
                    const finalSpecs = getCurrentFinalOperationSpecs();
                    for (const key of Array.from(operationApprovalMap.keys())) {
                        const exists = finalSpecs.some(spec => buildLorebookOperationApprovalKey(spec) === key);
                        if (!exists) {
                            operationApprovalMap.delete(key);
                        }
                    }
                    renderConversation(false);
                    notifySuccess(i18n('Rolled back to selected round.'));
                };
                const rollbackHistoryEntry = async (journalId) => {
                    const id = String(journalId || '').trim();
                    if (!id) {
                        return;
                    }
                    const settings = getSettings();
                    const state = await loadOperationState(context, { force: true, avatar: targetAvatar });
                    const { entry } = getJournalById(state, id);
                    if (!entry) {
                        throw new Error('Journal entry not found.');
                    }
                    if (String(entry.kind || '') === 'rollback') {
                        throw new Error('Rollback is not supported for rollback records.');
                    }
                    const summary = await rollbackJournalEntry(context, entry, { avatar: targetAvatar });
                    const rollbackLog = {
                        id: nextStateId(state, 'tx'),
                        operationId: entry.operationId,
                        kind: 'rollback',
                        source: 'manual',
                        summary,
                        data: {
                            targetJournalId: entry.id,
                        },
                        createdAt: Date.now(),
                    };
                    appendJournal(state, rollbackLog, settings);
                    state.updatedAt = Date.now();
                    await persistOperationState(context, state, { avatar: targetAvatar });
                };
                const handleSend = async () => {
                    if (isSending || input.disabled) {
                        return;
                    }
                    const userText = String(input.value || '').trim();
                    if (!userText) {
                        notifyWarning(i18n('Message cannot be empty.'));
                        return;
                    }
                    conversationMessages.push({ role: 'user', content: userText });
                    input.value = '';
                    isSending = true;
                    setComposerState(true);
                    renderConversation(true, i18n('Assistant is thinking...'));
                    try {
                        const reply = await requestModelLorebookConversationReply(context, plan, conversationMessages, {
                            draftEntries: draftTargetEntries,
                            finalOperationSpecs: getCurrentFinalOperationSpecs(),
                            approvalMap: operationApprovalMap,
                        });
                        const proposedOperations = Array.isArray(reply?.operations) ? reply.operations : [];
                        const draftRound = applyDraftOperationsAndBuildPreviews(
                            plan.targetBook,
                            draftTargetEntries,
                            proposedOperations,
                        );
                        markOperationsPendingApproval(draftRound.appliedOperations, operationApprovalMap);
                        const assistantText = String(reply?.assistantText || '').trim();
                        if (assistantText) {
                            conversationMessages.push({
                                role: 'assistant',
                                content: assistantText,
                                operations: draftRound.appliedOperations,
                                diffPreviews: draftRound.diffPreviews,
                            });
                        } else {
                            const fallbackText = draftRound.appliedOperations.length > 0
                                ? i18nFormat('Proposed ${0} operations in this round.', draftRound.appliedOperations.length)
                                : i18n('No draft operations proposed in this round.');
                            conversationMessages.push({
                                role: 'assistant',
                                content: fallbackText,
                                operations: draftRound.appliedOperations,
                                diffPreviews: draftRound.diffPreviews,
                            });
                        }
                    } catch (error) {
                        const errorText = i18nFormat('Model reply failed: ${0}', String(error?.message || error || ''));
                        conversationMessages.push({ role: 'assistant', content: errorText });
                    } finally {
                        isSending = false;
                        setComposerState(false);
                        renderConversation(false);
                    }
                };

                sendBtn.addEventListener('click', () => void handleSend());
                chat.addEventListener('click', (event) => {
                    const target = event.target instanceof Element ? event.target.closest('[data-cea-sync-action]') : null;
                    if (!(target instanceof HTMLElement)) {
                        return;
                    }
                    const action = String(target.getAttribute('data-cea-sync-action') || '').trim();
                    if (action === 'rollback-round') {
                        const messageIndex = target.getAttribute('data-cea-sync-message-index');
                        rollbackToMessage(messageIndex);
                        return;
                    }
                    if (action === 'approve-diff' || action === 'reject-diff') {
                        const messageIndex = asFiniteInteger(target.getAttribute('data-cea-sync-message-index'), -1);
                        const opIndex = asFiniteInteger(target.getAttribute('data-cea-sync-op-index'), -1);
                        if (!Number.isInteger(messageIndex) || !Number.isInteger(opIndex) || messageIndex < 0 || opIndex < 0) {
                            return;
                        }
                        const message = conversationMessages[messageIndex];
                        const operation = Array.isArray(message?.operations) ? message.operations[opIndex] : null;
                        const key = buildLorebookOperationApprovalKey(operation);
                        if (!key) {
                            return;
                        }
                        operationApprovalMap.set(key, action === 'approve-diff' ? 'approved' : 'rejected');
                        renderConversation(false);
                    }
                });
                history.addEventListener('click', async (event) => {
                    const target = event.target instanceof Element ? event.target.closest('[data-cea-sync-history-action]') : null;
                    if (!(target instanceof HTMLElement)) {
                        return;
                    }
                    const action = String(target.getAttribute('data-cea-sync-history-action') || '').trim();
                    const journalId = String(target.getAttribute('data-cea-sync-history-id') || '').trim();
                    try {
                        if (action === 'clear') {
                            if (!window.confirm(i18n('Clear all history records?'))) {
                                return;
                            }
                            await clearHistoryRecords(context, { avatar: targetAvatar });
                            await renderHistory();
                            await refreshUiState(context);
                            notifySuccess(i18n('History cleared.'));
                            return;
                        }
                        if (!journalId) {
                            return;
                        }
                        if (action === 'delete') {
                            if (!window.confirm(i18n('Delete this history record?'))) {
                                return;
                            }
                            const deleted = await deleteHistoryRecord(context, journalId, { avatar: targetAvatar });
                            if (!deleted) {
                                throw new Error('Journal entry not found.');
                            }
                            await renderHistory();
                            await refreshUiState(context);
                            notifySuccess(i18n('History record deleted.'));
                            return;
                        }
                        if (action === 'rollback') {
                            await rollbackHistoryEntry(journalId);
                            await renderHistory();
                            await refreshUiState(context);
                            notifySuccess(i18n('Rollback completed.'));
                        }
                    } catch (error) {
                        if (action === 'rollback') {
                            notifyError(i18nFormat('Rollback failed: ${0}', error?.message || error));
                            return;
                        }
                        if (action === 'delete') {
                            notifyError(i18nFormat('Delete failed: ${0}', error?.message || error));
                            return;
                        }
                        if (action === 'clear') {
                            notifyError(i18nFormat('Clear failed: ${0}', error?.message || error));
                        }
                    }
                });
                input.addEventListener('keydown', (event) => {
                    if (event.key !== 'Enter' || event.shiftKey) {
                        return;
                    }
                    event.preventDefault();
                    void handleSend();
                });

                setComposerState(true);
                renderConversation(true, i18n('Analyzing lorebook differences with model...'));
                void renderHistory();
            },
            onClosing: (instance) => {
                if (!analysisReady && Number(instance?.result) === Number(POPUP_RESULT.AFFIRMATIVE)) {
                    notifyWarning(i18n('Model analysis is still running. Please wait or cancel to restore previous lorebook.'));
                    return false;
                }
                if (isSending && Number(instance?.result) === Number(POPUP_RESULT.AFFIRMATIVE)) {
                    notifyWarning(i18n('Assistant is thinking...'));
                    return false;
                }
                if (Number(instance?.result) === Number(POPUP_RESULT.AFFIRMATIVE)) {
                    const finalSpecs = getCurrentFinalOperationSpecs();
                    const summary = getFinalOperationApprovalSummary(finalSpecs, operationApprovalMap);
                    if (summary.pending > 0) {
                        notifyWarning(i18n('All final diffs must be reviewed before saving.'));
                        return false;
                    }
                }
                return true;
            },
        },
    );

    const popupPromise = popup.show();
    const analysisPromise = (async () => {
        try {
            const analysisResult = await requestModelLorebookDiffAnalysis(context, plan);
            const analysisText = String(analysisResult?.assistantText || '').trim();
            if (analysisText) {
                conversationMessages.push({ role: 'assistant', content: analysisText });
            } else {
                conversationMessages.push({ role: 'assistant', content: i18n('No analysis output.') });
            }
        } catch (error) {
            const analysisError = String(error?.message || error || '');
            conversationMessages.push({ role: 'assistant', content: i18nFormat('Model analysis failed: ${0}', analysisError) });
        } finally {
            analysisReady = true;
            if (popup?.dlg?.isConnected) {
                const chat = popup.content.querySelector('[data-cea-sync-chat]');
                const input = popup.content.querySelector('[data-cea-sync-input]');
                const sendBtn = popup.content.querySelector('[data-cea-sync-send]');
                if (chat instanceof HTMLElement) {
                    chat.innerHTML = renderLorebookSyncChatMessages(conversationMessages, { loading: false, approvalMap: operationApprovalMap });
                    chat.scrollTop = chat.scrollHeight;
                }
                if (input instanceof HTMLTextAreaElement) {
                    input.disabled = false;
                }
                if (sendBtn instanceof HTMLElement) {
                    sendBtn.classList.remove('disabled');
                }
            }
        }
    })();

    const popupResult = await popupPromise;

    // Cancel means restore previous lorebook binding.
    if (popupResult !== POPUP_RESULT.AFFIRMATIVE) {
        const restored = await restorePreviousLorebookBinding(context, previousSnapshot, effectiveCurrentSnapshot, currentCharacter);
        await refreshUiState(context);
        notifyWarning(i18nFormat('No replacement applied. Restored previous lorebook binding: ${0}', restored.previousBook || '(none)'));
        return;
    }

    await analysisPromise;

    if (String(plan.targetBook || '').trim()) {
        await context.saveWorldInfo(plan.targetBook, clone(baselineLorebookData), true);
    }

    const operationSpecs = getCurrentFinalOperationSpecs();
    const approvedOperationSpecs = selectApprovedFinalOperations(operationSpecs, operationApprovalMap);
    let result = { applied: 0, failed: 0, errors: [] };
    if (approvedOperationSpecs.length > 0) {
        result = await submitGeneratedOperations(context, approvedOperationSpecs, 'character_update_lorebook_sync', { targetAvatar });
        if (result.failed > 0) {
            notifyWarning(i18n('Lorebook finalization skipped due failed operations.'));
            await refreshUiState(context);
            notifySuccess(i18nFormat('Lorebook sync result: applied ${0}, failed ${1}', result.applied, result.failed));
            notifyWarning(result.errors[0] || 'Some operations failed.');
            return;
        }
    } else {
        notifyWarning(i18n('No approved diff to apply. Finalizing without additional changes.'));
    }

    const finalized = await finalizeLorebookSyncReplacement(context, previousSnapshot, effectiveCurrentSnapshot, currentCharacter);
    if (finalized.previousBook || finalized.targetBook) {
        notifySuccess(i18nFormat('Finalize lorebook replacement: ${0} -> ${1}', finalized.previousBook || '(none)', finalized.targetBook || '(none)'));
    }
    await refreshUiState(context);
    notifySuccess(i18nFormat('Lorebook sync result: applied ${0}, failed ${1}', result.applied, result.failed));
}

async function primeActiveCharacterLorebookSnapshot(context) {
    try {
        const record = getActiveCharacterRecord(context);
        const snapshot = await captureCharacterLorebookSnapshot(context, record.character);
        if (snapshot.avatar) {
            lorebookSnapshotCache.set(snapshot.avatar, clone(snapshot));
        }
    } catch {
        // no active character, ignore
    }
}

async function handleCharacterReplacedLorebookSync(context, event) {
    const settings = getSettings();
    if (!settings.replaceLorebookSyncEnabled) {
        return;
    }
    const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
    const currentCharacter = detail.character && typeof detail.character === 'object' ? detail.character : null;
    const previousCharacter = detail.previousCharacter && typeof detail.previousCharacter === 'object' ? detail.previousCharacter : null;
    const avatar = String(currentCharacter?.avatar || '').trim();
    if (!currentCharacter || !avatar) {
        return;
    }

    const previousSnapshot = previousCharacter
        ? await captureCharacterLorebookSnapshot(context, previousCharacter)
        : (lorebookSnapshotCache.get(avatar) || null);
    const currentSnapshot = await captureCharacterLorebookSnapshot(context, currentCharacter);
    lorebookSnapshotCache.set(avatar, clone(currentSnapshot));

    if (!previousSnapshot) {
        return;
    }
    const hasEmbeddedLorebook = Boolean(getEmbeddedLorebookImportPayload(currentCharacter)?.bookName);
    if (!hasEmbeddedLorebook && !String(previousSnapshot.bookName || '').trim() && !String(currentSnapshot.bookName || '').trim()) {
        return;
    }

    const plan = buildLorebookSyncPlan(previousSnapshot, currentSnapshot);
    if (!hasEmbeddedLorebook && plan.operations.length === 0) {
        return;
    }

    if (lorebookSyncDialogLocks.has(avatar)) {
        notifyWarning(i18n('A lorebook sync dialog is already open for this character.'));
        return;
    }
    lorebookSyncDialogLocks.add(avatar);
    try {
        await runLorebookSyncFlow(context, previousSnapshot, currentSnapshot, currentCharacter);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Lorebook sync flow failed`, error);
        notifyError(String(error?.message || error));
    } finally {
        lorebookSyncDialogLocks.delete(avatar);
        const refreshedSnapshot = await captureCharacterLorebookSnapshot(context, currentCharacter);
        if (refreshedSnapshot.avatar) {
            lorebookSnapshotCache.set(refreshedSnapshot.avatar, clone(refreshedSnapshot));
        }
    }
}

function buildOperationSummary(operation) {
    const kind = String(operation?.kind || 'unknown');
    if (kind === 'character_fields') {
        return `character_fields: ${Object.keys(operation.args || {}).join(', ') || 'no-fields'}`;
    }
    if (kind === 'set_primary_lorebook') {
        return `set_primary_lorebook: ${String(operation.args?.book_name || '(clear)')}`;
    }
    if (kind === 'lorebook_upsert_entry') {
        return `lorebook_upsert_entry: ${String(operation.args?.book_name || '(primary)')}#${String(operation.args?.entry_uid ?? 'new')}`;
    }
    if (kind === 'lorebook_delete_entry') {
        return `lorebook_delete_entry: ${String(operation.args?.book_name || '(primary)')}#${String(operation.args?.entry_uid ?? '?')}`;
    }
    return kind;
}

async function applyCharacterFieldsOperation(context, record, operation) {
    const args = operation.args && typeof operation.args === 'object' ? operation.args : {};
    const rootFieldNames = ['name', 'description', 'personality', 'scenario', 'mes_example'];
    const dataFieldNames = ['system_prompt', 'post_history_instructions', 'creator_notes'];

    const rootPatch = {};
    const dataPatch = {};
    const before = {};
    const after = {};

    for (const key of rootFieldNames) {
        if (!Object.hasOwn(args, key)) {
            continue;
        }
        const nextValue = String(args[key] ?? '');
        before[key] = String(record.character?.[key] ?? '');
        after[key] = nextValue;
        rootPatch[key] = nextValue;
    }
    for (const key of dataFieldNames) {
        if (!Object.hasOwn(args, key)) {
            continue;
        }
        const nextValue = String(args[key] ?? '');
        before[key] = String(record.character?.data?.[key] ?? '');
        after[key] = nextValue;
        dataPatch[key] = nextValue;
    }

    if (Object.keys(rootPatch).length === 0 && Object.keys(dataPatch).length === 0) {
        throw new Error('No character fields were provided.');
    }

    const payload = { ...rootPatch };
    if (Object.keys(dataPatch).length > 0) {
        payload.data = dataPatch;
    }

    await mergeCharacterAttributes(context, record.avatar, payload);

    return {
        summary: `Updated character fields: ${Object.keys({ ...rootPatch, ...dataPatch }).join(', ')}`,
        kind: operation.kind,
        data: {
            before,
            after,
        },
    };
}

function applyLorebookEntryArgs(baseEntry, args, entryUid) {
    const entry = clone(baseEntry && typeof baseEntry === 'object' ? baseEntry : { uid: entryUid, ...clone(newWorldInfoEntryTemplate) });
    entry.uid = Number(entryUid);

    if (Object.hasOwn(args, 'comment')) {
        entry.comment = String(args.comment ?? '');
    }
    if (Object.hasOwn(args, 'content')) {
        entry.content = String(args.content ?? '');
    }
    if (Object.hasOwn(args, 'key_csv')) {
        entry.key = parseCsvList(args.key_csv);
    }
    if (Object.hasOwn(args, 'secondary_key_csv')) {
        entry.keysecondary = parseCsvList(args.secondary_key_csv);
        entry.selective = entry.keysecondary.length > 0;
    }
    if (Object.hasOwn(args, 'selective_logic')) {
        const selectiveLogic = asFiniteInteger(args.selective_logic, entry.selectiveLogic);
        if (selectiveLogic !== null) {
            entry.selectiveLogic = selectiveLogic;
        }
    }
    if (Object.hasOwn(args, 'order')) {
        const order = asFiniteInteger(args.order, entry.order);
        if (order !== null) {
            entry.order = order;
        }
    }
    if (Object.hasOwn(args, 'position')) {
        const position = asFiniteInteger(args.position, entry.position);
        if (position !== null) {
            entry.position = position;
        }
    }
    if (Object.hasOwn(args, 'depth')) {
        const depth = asFiniteInteger(args.depth, entry.depth);
        if (depth !== null) {
            entry.depth = depth;
        }
    }
    if (Object.hasOwn(args, 'enabled')) {
        entry.disable = !Boolean(args.enabled);
    }
    if (Object.hasOwn(args, 'disable')) {
        entry.disable = Boolean(args.disable);
    }
    if (Object.hasOwn(args, 'constant')) {
        entry.constant = Boolean(args.constant);
    }

    return entry;
}

function sanitizeDiffPlaceholderValue(value) {
    const text = String(value ?? '');
    const normalized = text.trim();
    if (!normalized) {
        return '';
    }
    const notSetTokens = new Set([
        'Not set',
        '未设置',
        '未設定',
    ]);
    return notSetTokens.has(normalized) ? '' : text;
}

function normalizeDiffValue(value, emptyLabel = '') {
    const emptyText = emptyLabel ? i18n(emptyLabel) : '';
    if (value === null || value === undefined) {
        return emptyText;
    }
    if (Array.isArray(value)) {
        const text = value
            .map(item => sanitizeDiffPlaceholderValue(item).trim())
            .filter(Boolean)
            .join(', ');
        return text || emptyText;
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    const text = sanitizeDiffPlaceholderValue(value);
    if (!text.trim()) {
        return emptyText;
    }
    return text;
}

function clipDiffText(value, maxLength = 1200) {
    const text = String(value ?? '');
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, maxLength)}\n...`;
}

function pushDiffField(fields, label, before, after, { force = false } = {}) {
    const beforeText = clipDiffText(normalizeDiffValue(before));
    const afterText = clipDiffText(normalizeDiffValue(after));
    if (!force && beforeText === afterText) {
        return;
    }
    fields.push({
        label: String(label || 'field'),
        before: beforeText,
        after: afterText,
    });
}

function getEntryPreviewValue(entry, key) {
    const source = entry && typeof entry === 'object' ? entry : {};
    if (key === 'key') {
        return Array.isArray(source.key) ? source.key : [];
    }
    if (key === 'keysecondary') {
        return Array.isArray(source.keysecondary) ? source.keysecondary : [];
    }
    if (key === 'enabled') {
        return !Boolean(source.disable);
    }
    return source[key];
}

async function applyLorebookUpsertOperation(context, record, operation) {
    const args = operation.args && typeof operation.args === 'object' ? operation.args : {};
    const bookName = await resolveTargetLorebook(context, record, {
        requestedName: args.book_name,
        createIfMissing: args.create_if_missing !== false,
        bindPrimaryWhenCreated: true,
    });
    if (!bookName) {
        throw new Error('No target lorebook is available.');
    }

    const data = await loadLorebookData(context, bookName);
    const parsedUid = asFiniteInteger(args.entry_uid, null);
    const uid = Number.isInteger(parsedUid) && parsedUid >= 0 ? parsedUid : getLorebookNextUid(data);
    const beforeEntry = Object.hasOwn(data.entries, uid) ? clone(data.entries[uid]) : null;
    const nextEntry = applyLorebookEntryArgs(beforeEntry, args, uid);

    data.entries[uid] = nextEntry;
    await context.saveWorldInfo(bookName, data, true);
    await refreshWorldInfoEditorUi(bookName);

    return {
        summary: `Upserted lorebook entry #${uid} in ${bookName}`,
        kind: operation.kind,
        data: {
            bookName,
            entryUid: uid,
            beforeEntry,
            afterEntry: clone(nextEntry),
        },
    };
}

async function applyLorebookDeleteOperation(context, record, operation) {
    const args = operation.args && typeof operation.args === 'object' ? operation.args : {};
    const entryUid = asFiniteInteger(args.entry_uid, null);
    if (!Number.isInteger(entryUid) || entryUid < 0) {
        throw new Error('entry_uid is required for lorebook deletion.');
    }

    const bookName = await resolveTargetLorebook(context, record, {
        requestedName: args.book_name,
        createIfMissing: false,
        bindPrimaryWhenCreated: false,
    });
    if (!bookName) {
        throw new Error('No target lorebook is available.');
    }

    const data = await loadLorebookData(context, bookName);
    const beforeEntry = Object.hasOwn(data.entries, entryUid) ? clone(data.entries[entryUid]) : null;
    if (!beforeEntry) {
        throw new Error(`Lorebook entry #${entryUid} does not exist.`);
    }

    delete data.entries[entryUid];
    await context.saveWorldInfo(bookName, data, true);
    await refreshWorldInfoEditorUi(bookName);

    return {
        summary: `Deleted lorebook entry #${entryUid} from ${bookName}`,
        kind: operation.kind,
        data: {
            bookName,
            entryUid,
            beforeEntry,
            afterEntry: null,
        },
    };
}

async function applyPrimaryLorebookOperation(context, record, operation) {
    const args = operation.args && typeof operation.args === 'object' ? operation.args : {};
    const requestedName = String(args.book_name || '').trim();
    const beforeName = getPrimaryLorebookName(record.character);

    let targetName = requestedName;
    if (targetName && args.create_if_missing !== false) {
        targetName = await ensureLorebookExists(context, targetName, targetName);
    }

    await mergeCharacterAttributes(context, record.avatar, {
        data: {
            extensions: {
                world: targetName,
            },
        },
    });
    await syncWorldBindingUi(context, targetName);

    return {
        summary: `Set primary lorebook: ${beforeName || '(none)'} -> ${targetName || '(none)'}`,
        kind: operation.kind,
        data: {
            beforeName,
            afterName: targetName,
        },
    };
}

async function applyOperationNow(context, operation, { avatar = '' } = {}) {
    const record = getActiveCharacterRecord(context, { avatar: avatar || operation?.targetAvatar || '' });
    const kind = String(operation?.kind || '');
    if (!kind) {
        throw new Error('Operation kind is missing.');
    }

    if (kind === 'character_fields') {
        return await applyCharacterFieldsOperation(context, record, operation);
    }
    if (kind === 'set_primary_lorebook') {
        return await applyPrimaryLorebookOperation(context, record, operation);
    }
    if (kind === 'lorebook_upsert_entry') {
        return await applyLorebookUpsertOperation(context, record, operation);
    }
    if (kind === 'lorebook_delete_entry') {
        return await applyLorebookDeleteOperation(context, record, operation);
    }

    throw new Error(`Unsupported operation kind: ${kind}`);
}

function appendJournal(state, entry, settings) {
    const maxEntries = Math.max(20, Number(settings.maxJournalEntries || defaultSettings.maxJournalEntries));
    state.journal.push(entry);
    if (state.journal.length > maxEntries) {
        state.journal.splice(0, state.journal.length - maxEntries);
    }
}

function createOperationEnvelope(state, kind, args, source = 'tool', { targetAvatar = '' } = {}) {
    const operation = {
        id: nextStateId(state, 'op'),
        kind: String(kind || '').trim(),
        args: args && typeof args === 'object' ? clone(args) : {},
        source: String(source || 'tool'),
        createdAt: Date.now(),
    };
    const avatar = String(targetAvatar || '').trim();
    if (avatar) {
        operation.targetAvatar = avatar;
    }
    return operation;
}

async function submitOperation(context, operation, { avatar = '' } = {}) {
    const settings = getSettings();
    const targetAvatar = String(avatar || operation?.targetAvatar || '').trim();
    const state = await loadOperationState(context, { avatar: targetAvatar });

    const applied = await applyOperationNow(context, operation, { avatar: targetAvatar });
    const journalEntry = {
        id: nextStateId(state, 'tx'),
        operationId: operation.id,
        kind: applied.kind,
        source: operation.source,
        summary: String(applied.summary || buildOperationSummary(operation)),
        data: clone(applied.data || {}),
        createdAt: Date.now(),
    };
    appendJournal(state, journalEntry, settings);
    state.updatedAt = Date.now();
    await persistOperationState(context, state, { avatar: targetAvatar });

    return {
        status: 'applied',
        operation_id: operation.id,
        journal_id: journalEntry.id,
        summary: journalEntry.summary,
    };
}

function getJournalById(state, journalId) {
    const id = String(journalId || '').trim();
    const index = state.journal.findIndex(item => String(item?.id || '') === id);
    return {
        entry: index >= 0 ? state.journal[index] : null,
        index,
    };
}

async function rollbackJournalEntry(context, journalEntry, { avatar = '' } = {}) {
    const record = getActiveCharacterRecord(context, { avatar });
    const kind = String(journalEntry?.kind || '');
    const data = journalEntry?.data && typeof journalEntry.data === 'object' ? journalEntry.data : {};

    if (kind === 'character_fields') {
        const before = data.before && typeof data.before === 'object' ? data.before : {};
        if (Object.keys(before).length === 0) {
            throw new Error('No rollback payload for character fields.');
        }
        const payload = {};
        const dataPatch = {};
        const rootFieldNames = ['name', 'description', 'personality', 'scenario', 'mes_example'];
        const dataFieldNames = ['system_prompt', 'post_history_instructions', 'creator_notes'];
        for (const key of rootFieldNames) {
            if (Object.hasOwn(before, key)) {
                payload[key] = String(before[key] ?? '');
            }
        }
        for (const key of dataFieldNames) {
            if (Object.hasOwn(before, key)) {
                dataPatch[key] = String(before[key] ?? '');
            }
        }
        if (Object.keys(dataPatch).length > 0) {
            payload.data = dataPatch;
        }
        await mergeCharacterAttributes(context, record.avatar, payload);
        return `Rolled back character fields (${Object.keys(before).join(', ')})`;
    }

    if (kind === 'set_primary_lorebook') {
        const beforeName = String(data.beforeName ?? '');
        await mergeCharacterAttributes(context, record.avatar, {
            data: {
                extensions: {
                    world: beforeName,
                },
            },
        });
        await syncWorldBindingUi(context, beforeName);
        return `Rolled back primary lorebook to ${beforeName || '(none)'}`;
    }

    if (kind === 'lorebook_upsert_entry' || kind === 'lorebook_delete_entry') {
        const bookName = String(data.bookName || '').trim();
        const entryUid = asFiniteInteger(data.entryUid, null);
        if (!bookName || !Number.isInteger(entryUid) || entryUid < 0) {
            throw new Error('Rollback payload is incomplete for lorebook entry operation.');
        }
        const lorebookData = await loadLorebookData(context, bookName);
        if (data.beforeEntry && typeof data.beforeEntry === 'object') {
            lorebookData.entries[entryUid] = clone(data.beforeEntry);
        } else {
            delete lorebookData.entries[entryUid];
        }
        await context.saveWorldInfo(bookName, lorebookData, true);
        await refreshWorldInfoEditorUi(bookName);
        return `Rolled back lorebook entry #${entryUid} in ${bookName}`;
    }

    throw new Error(`Rollback is not supported for kind: ${kind}`);
}

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
#${UI_BLOCK_ID} .cea_row { display:flex; gap:8px; align-items:center; margin:6px 0; flex-wrap:wrap; }
#${UI_BLOCK_ID} .cea_panel { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 22%, transparent); border-radius:8px; padding:8px; margin:8px 0; }
#${UI_BLOCK_ID} .cea_item { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 16%, transparent); border-radius:8px; padding:8px; margin:6px 0; }
#${UI_BLOCK_ID} .cea_item_top { display:flex; justify-content:space-between; gap:8px; align-items:flex-start; }
#${UI_BLOCK_ID} .cea_item_meta { opacity:0.75; font-size:0.9em; }
#${UI_BLOCK_ID} .cea_status { opacity:0.85; }
#${UI_BLOCK_ID} .cea_item_actions { display:flex; gap:6px; flex-wrap:wrap; }
#${UI_BLOCK_ID} .cea_diff_popup { display:flex; flex-direction:column; gap:10px; }
#${UI_BLOCK_ID} .cea_diff_meta { display:flex; flex-wrap:wrap; gap:8px; }
#${UI_BLOCK_ID} .cea_diff_meta_item { padding:6px 8px; border-radius:8px; background:color-mix(in oklab, var(--SmartThemeBodyColor) 10%, transparent); }
#${UI_BLOCK_ID} .cea_diff_item { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 16%, transparent); border-radius:8px; padding:8px; }
#${UI_BLOCK_ID} .cea_diff_label { font-weight:600; margin-bottom:6px; }
#${UI_BLOCK_ID} .cea_diff_blocks { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
#${UI_BLOCK_ID} .cea_diff_block { border-radius:8px; border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 14%, transparent); padding:6px; min-height:72px; }
#${UI_BLOCK_ID} .cea_diff_block_title { font-size:0.9em; opacity:0.75; margin-bottom:4px; }
#${UI_BLOCK_ID} .cea_diff_block pre { margin:0; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; max-height:280px; overflow:auto; }
#${UI_BLOCK_ID} .cea_diff_block.before { background: color-mix(in oklab, #d9534f 12%, transparent); }
#${UI_BLOCK_ID} .cea_diff_block.after { background: color-mix(in oklab, #4caf50 14%, transparent); }
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
.popup .cea_sync_popup { display:flex; flex-direction:column; gap:10px; text-align:start; }
.popup .cea_sync_intro { opacity:0.9; }
.popup .cea_sync_meta { display:flex; flex-wrap:wrap; gap:8px; }
.popup .cea_sync_meta_item { padding:6px 8px; border-radius:8px; background:color-mix(in oklab, var(--SmartThemeBodyColor) 10%, transparent); }
.popup .cea_sync_chat { display:flex; flex-direction:column; gap:8px; }
.popup .cea_sync_chat_msg { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 16%, transparent); border-radius:12px; padding:10px 12px; max-height:40vh; overflow-y:auto; overflow-x:hidden; text-align:left; -webkit-overflow-scrolling:touch; touch-action:pan-y; }
.popup .cea_sync_chat_msg_assistant { background:color-mix(in oklab, var(--SmartThemeBodyColor) 8%, transparent); }
.popup .cea_sync_chat_msg_user { background:color-mix(in oklab, var(--SmartThemeBodyColor) 18%, transparent); margin-left:12%; }
.popup .cea_sync_chat_msg_user pre { margin:0; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; font-family:inherit; }
.popup .cea_sync_chat_msg_loading { display:flex; align-items:center; gap:8px; opacity:0.9; }
.popup .cea_sync_analysis_error { color:var(--crimson70); font-weight:600; }
.popup .cea_sync_analysis_empty { opacity:0.8; }
.popup .cea_sync_chat_text { margin-bottom:6px; }
.popup .cea_sync_chat_msg :is(p, ul, ol, pre, table, h1, h2, h3, h4) { margin:0 0 8px; }
.popup .cea_sync_chat_msg :is(pre, code) { white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; }
.popup .cea_sync_chat_msg table { display:block; width:100%; overflow:auto; border-collapse:collapse; }
.popup .cea_sync_chat_msg th, .popup .cea_sync_chat_msg td { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 16%, transparent); padding:4px 6px; vertical-align:top; }
.popup .cea_sync_popup .menu_button,
.popup .cea_sync_popup .menu_button_small {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: auto;
    min-width: max-content;
    white-space: nowrap;
    line-height: 1.2;
    writing-mode: horizontal-tb;
    text-orientation: mixed;
}
.popup .cea_sync_chat_text,
.popup .cea_sync_chat_text :is(p, ul, ol, li, pre, table, th, td, h1, h2, h3, h4) { text-align:left; }
.popup .cea_sync_turn_diff { margin-top:8px; border-top:1px dashed color-mix(in oklab, var(--SmartThemeBodyColor) 18%, transparent); padding-top:8px; }
.popup .cea_sync_turn_diff > summary { cursor:pointer; font-weight:600; opacity:0.9; }
.popup .cea_sync_turn_actions { margin-top:8px; display:flex; justify-content:flex-end; }
.popup .cea_sync_turn_diff_list { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
.popup .cea_sync_turn_diff_item { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 15%, transparent); border-radius:10px; padding:8px; }
.popup .cea_sync_turn_diff_title { font-weight:600; margin-bottom:6px; }
.popup .cea_sync_turn_diff_actions { display:flex; align-items:center; gap:6px; margin-bottom:8px; flex-wrap:wrap; }
.popup .cea_sync_turn_diff_status { padding:3px 8px; border-radius:999px; font-size:0.85em; line-height:1.2; border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 22%, transparent); }
.popup .cea_sync_turn_diff_status.approved { background:color-mix(in oklab, #4caf50 18%, transparent); }
.popup .cea_sync_turn_diff_status.rejected { background:color-mix(in oklab, #d9534f 16%, transparent); }
.popup .cea_sync_turn_diff_status.pending { background:color-mix(in oklab, var(--SmartThemeBodyColor) 10%, transparent); }
.popup .cea_sync_turn_diff_meta { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:8px; }
.popup .cea_sync_turn_diff_meta_item { padding:4px 8px; border-radius:8px; background:color-mix(in oklab, var(--SmartThemeBodyColor) 10%, transparent); }
.popup .cea_sync_turn_diff_fields { display:flex; flex-direction:column; gap:8px; }
.popup .cea_sync_turn_diff_label { font-weight:600; margin-bottom:4px; }
.popup .cea_line_diff { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 14%, transparent); border-radius:8px; background:color-mix(in oklab, var(--SmartThemeBodyColor) 5%, transparent); }
.popup .cea_line_diff > summary { cursor:pointer; padding:6px 8px; font-size:0.9em; display:flex; gap:8px; align-items:center; justify-content:space-between; }
.popup .cea_line_diff_summary_main { display:inline-flex; align-items:center; gap:8px; min-width:0; }
.popup .cea_line_diff_meta { opacity:0.75; font-size:0.88em; }
.popup .cea_line_diff_expand_btn { display:inline-flex; align-items:center; justify-content:center; min-width:2.2em; width:2.2em; padding:0; line-height:1; }
.popup .cea_line_diff_expand_btn i { pointer-events:none; }
.popup .cea_sync_popup,
.popup .cea_sync_chat,
.popup .cea_sync_chat_msg,
.popup .cea_sync_turn_diff,
.popup .cea_sync_turn_diff_item,
.popup .cea_sync_turn_diff_fields,
.popup .cea_sync_turn_diff_field,
.popup .cea_line_diff,
.popup .cea_line_diff_pre { min-width:0; max-width:100%; box-sizing:border-box; }
.popup .cea_line_diff_pre { margin:0; padding:6px; border-top:1px dashed color-mix(in oklab, var(--SmartThemeBodyColor) 16%, transparent); max-height:320px; overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch; }
.popup .cea_line_diff_dual { --cea-split-left:50%; --cea-splitter-width:12px; display:grid; grid-template-columns:minmax(0, var(--cea-split-left)) var(--cea-splitter-width) minmax(0, calc(100% - var(--cea-split-left) - var(--cea-splitter-width))); gap:0; width:100%; min-width:0; align-items:stretch; }
.popup .cea_line_diff_splitter { position:relative; cursor:col-resize; touch-action:none; user-select:none; background:transparent; }
.popup .cea_line_diff_splitter::before { content:''; position:absolute; left:50%; top:0; bottom:0; width:2px; transform:translateX(-50%); border-radius:999px; background:color-mix(in oklab, var(--SmartThemeBodyColor) 20%, transparent); transition:background-color .12s ease; }
.popup .cea_line_diff_splitter:hover::before,
.popup .cea_line_diff_splitter.active::before { background:color-mix(in oklab, var(--SmartThemeBodyColor) 38%, transparent); }
.popup .cea_line_diff_side { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 14%, transparent); border-radius:6px; background:color-mix(in oklab, var(--SmartThemeBodyColor) 4%, transparent); min-width:0; overflow:hidden; }
.popup .cea_line_diff_side_scroll { overflow-x:auto; overflow-y:hidden; -webkit-overflow-scrolling:touch; touch-action:auto; }
.popup .cea_line_diff_table { width:max-content; min-width:100%; border-collapse:collapse; table-layout:fixed; font-size:0.82rem; }
.popup .cea_line_diff_pre,
.popup .cea_line_diff_table,
.popup .cea_line_diff_row td,
.popup .cea_line_diff_text,
.popup .cea_line_diff_text_inner { text-align:left; }
.popup .cea_line_diff_row td { border-bottom:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 12%, transparent); padding:2px 6px; vertical-align:top; }
.popup .cea_line_diff_row:last-child td { border-bottom:none; }
.popup .cea_line_diff_ln { width:3.8em; text-align:right; color:color-mix(in oklab, var(--SmartThemeBodyColor) 72%, transparent); font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; position:sticky; left:0; z-index:3; background-color:var(--SmartThemeBlurTintColor); box-shadow:1px 0 0 var(--SmartThemeBorderColor); background-image:none; opacity:1; }
.popup .cea_line_diff_text { width:auto; min-width:0; }
.popup .cea_line_diff_text_inner { white-space:pre; word-break:normal; overflow-wrap:normal; user-select:text; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; min-width:max-content; }
.popup .cea_line_diff_word_add { background:color-mix(in oklab, #4caf50 30%, transparent); border-radius:3px; padding:0 1px; }
.popup .cea_line_diff_word_del { background:color-mix(in oklab, #d9534f 30%, transparent); border-radius:3px; padding:0 1px; }
.popup .cea_line_diff_row_add .cea_line_diff_text.new { background:color-mix(in oklab, #4caf50 12%, transparent); }
.popup .cea_line_diff_row_del .cea_line_diff_text.old { background:color-mix(in oklab, #d9534f 12%, transparent); }
.popup .cea_line_diff_row_mod .cea_line_diff_text.old { background:color-mix(in oklab, #d9534f 10%, transparent); }
.popup .cea_line_diff_row_mod .cea_line_diff_text.new { background:color-mix(in oklab, #4caf50 10%, transparent); }
.popup .cea_line_diff_row_eq { background:transparent; }
.popup .cea_line_diff_zoom_overlay { position:fixed; inset:0; z-index:10010; display:flex; align-items:center; justify-content:center; }
.popup .cea_line_diff_zoom_backdrop { position:absolute; inset:0; background:color-mix(in oklab, #000 70%, transparent); }
.popup .cea_line_diff_zoom_dialog { position:relative; z-index:1; width:min(1280px, 95vw); height:min(92vh, 920px); border:1px solid var(--SmartThemeBorderColor); border-radius:10px; background:var(--SmartThemeBlurTintColor); display:flex; flex-direction:column; overflow:hidden; box-shadow:0 12px 36px rgba(0,0,0,0.45); }
.popup .cea_line_diff_zoom_header { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; border-bottom:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 16%, transparent); }
.popup .cea_line_diff_zoom_title { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.popup .cea_line_diff_zoom_close { display:inline-flex; align-items:center; justify-content:center; min-width:2.2em; width:2.2em; padding:0; line-height:1; }
.popup .cea_line_diff_zoom_body { flex:1; min-height:0; overflow:auto; padding:10px; }
.popup .cea_line_diff_zoom_body .cea_line_diff_pre { max-height:none; height:auto; }
.popup .cea_sync_turn_diff_raw > summary { cursor:pointer; opacity:0.8; }
.popup .cea_sync_turn_diff_raw pre { margin-top:6px; max-height:180px; overflow:auto; }
.popup .cea_sync_turn_diff_empty { opacity:0.8; margin-top:6px; }
.popup .cea_sync_composer { display:flex; flex-direction:column; gap:8px; }
.popup .cea_sync_composer [data-cea-sync-send] {
    align-self:flex-end;
    width: fit-content;
    min-width: 4.2em;
}
.popup .cea_editor_pending { margin-top:8px; border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 15%, transparent); border-radius:10px; padding:8px; display:flex; flex-direction:column; gap:8px; background:color-mix(in oklab, var(--SmartThemeBodyColor) 8%, transparent); }
.popup .cea_editor_pending_hint { opacity:0.92; font-weight:600; }
.popup .cea_editor_pending_actions { display:flex; flex-wrap:wrap; gap:6px; justify-content:flex-end; }
.popup .cea_sync_history { margin-top:8px; border-top:1px dashed color-mix(in oklab, var(--SmartThemeBodyColor) 18%, transparent); padding-top:8px; }
.popup .cea_sync_history > summary { cursor:pointer; font-weight:600; opacity:0.9; }
.popup .cea_sync_history_toolbar { display:flex; justify-content:flex-end; margin:8px 0; }
.popup .cea_sync_history_list { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
.popup .cea_sync_history_item { border:1px solid color-mix(in oklab, var(--SmartThemeBodyColor) 15%, transparent); border-radius:10px; padding:8px; display:flex; justify-content:space-between; gap:8px; align-items:flex-start; }
.popup .cea_sync_history_item_main { min-width:0; flex:1; }
.popup .cea_sync_history_item_actions { display:flex; gap:6px; flex-wrap:wrap; }
.popup .cea_sync_history_item_summary { font-weight:600; line-height:1.35; word-break:break-word; }
.popup .cea_sync_history_item_time { opacity:0.75; font-size:0.9em; margin-top:4px; }
.popup .cea_sync_history_empty { opacity:0.8; }
@media (max-width: 900px) {
    #${UI_BLOCK_ID} .cea_diff_blocks { grid-template-columns:1fr; }
    .popup .cea_line_diff_ln { width:3.2em; }
}
`;
    document.head.append(style);
}

function renderJournalItems(state) {
    const items = Array.isArray(state?.journal) ? state.journal.slice().reverse() : [];
    const toolbar = items.length > 0
        ? `<div class="cea_row"><div class="menu_button menu_button_small" id="cea_clear_history">${escapeHtml(i18n('Clear history'))}</div></div>`
        : '';
    if (items.length === 0) {
        return `${toolbar}<div class="cea_item_meta">${escapeHtml(i18n('No history yet.'))}</div>`;
    }
    return `${toolbar}${items.map(item => `
<div class="cea_item" data-journal-id="${escapeHtml(item.id)}">
    <div class="cea_item_top">
        <div>
            <div><b>${escapeHtml(String(item.summary || item.kind || ''))}</b></div>
            <div class="cea_item_meta">${escapeHtml(new Date(Number(item.createdAt || Date.now())).toLocaleString())}</div>
        </div>
        <div class="cea_item_actions">
            ${String(item.kind || '') === 'rollback'
                ? ''
                : `<div class="menu_button menu_button_small" data-cea-action="rollback" data-journal-id="${escapeHtml(item.id)}">${escapeHtml(i18n('Rollback'))}</div>`}
            <div class="menu_button menu_button_small" data-cea-action="delete" data-journal-id="${escapeHtml(item.id)}">${escapeHtml(i18n('Delete'))}</div>
        </div>
    </div>
</div>`).join('')}`;
}

function canUseToolsInCurrentContext(context) {
    try {
        getActiveCharacterRecord(context);
        return true;
    } catch {
        return false;
    }
}

async function handleToolOperation(kind, args) {
    const context = getContext();
    if (!canUseToolsInCurrentContext(context)) {
        return {
            status: 'ignored',
            reason: i18n('Current chat has no active character.'),
        };
    }

    const state = await loadOperationState(context);
    const operation = createOperationEnvelope(state, kind, args, 'tool');
    await persistOperationState(context, state);

    const result = await submitOperation(context, operation);
    notifySuccess(i18nFormat('Operation applied: ${0}', result.summary));
    await refreshUiState(context);
    return result;
}

function registerTools(context) {
    Object.values(TOOL_NAMES).forEach(name => context.unregisterFunctionTool(name));

    context.registerFunctionTool({
        name: TOOL_NAMES.UPDATE_FIELDS,
        displayName: 'Update Character Fields',
        description: 'Update current character card fields (description, personality, scenario, mes_example, system_prompt, creator_notes, etc).',
        shouldRegister: async () => canUseToolsInCurrentContext(getContext()),
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                personality: { type: 'string' },
                scenario: { type: 'string' },
                mes_example: { type: 'string' },
                system_prompt: { type: 'string' },
                post_history_instructions: { type: 'string' },
                creator_notes: { type: 'string' },
            },
            additionalProperties: false,
        },
        action: async (args) => await handleToolOperation('character_fields', args),
        formatMessage: () => 'Preparing character field update...',
    });

    context.registerFunctionTool({
        name: TOOL_NAMES.SET_PRIMARY_BOOK,
        displayName: 'Set Primary Lorebook',
        description: 'Set or clear current character primary lorebook binding. Optionally create lorebook if missing.',
        shouldRegister: async () => canUseToolsInCurrentContext(getContext()),
        parameters: {
            type: 'object',
            properties: {
                book_name: { type: 'string' },
                create_if_missing: { type: 'boolean' },
            },
            additionalProperties: false,
        },
        action: async (args) => await handleToolOperation('set_primary_lorebook', args),
        formatMessage: () => 'Updating primary lorebook binding...',
    });

    context.registerFunctionTool({
        name: TOOL_NAMES.UPSERT_ENTRY,
        displayName: 'Upsert Lorebook Entry',
        description: 'Create or update one lorebook entry in current character primary lorebook (or an explicit lorebook name).',
        shouldRegister: async () => canUseToolsInCurrentContext(getContext()),
        parameters: {
            type: 'object',
            properties: {
                book_name: { type: 'string' },
                create_if_missing: { type: 'boolean' },
                entry_uid: { type: 'integer' },
                key_csv: { type: 'string' },
                secondary_key_csv: { type: 'string' },
                comment: { type: 'string' },
                content: { type: 'string' },
                selective_logic: { type: 'integer' },
                order: { type: 'integer' },
                position: { type: 'integer' },
                depth: { type: 'integer' },
                enabled: { type: 'boolean' },
                disable: { type: 'boolean' },
                constant: { type: 'boolean' },
            },
            additionalProperties: false,
        },
        action: async (args) => await handleToolOperation('lorebook_upsert_entry', args),
        formatMessage: () => 'Upserting lorebook entry...',
    });

    context.registerFunctionTool({
        name: TOOL_NAMES.DELETE_ENTRY,
        displayName: 'Delete Lorebook Entry',
        description: 'Delete one lorebook entry by UID in current character primary lorebook (or an explicit lorebook name).',
        shouldRegister: async () => canUseToolsInCurrentContext(getContext()),
        parameters: {
            type: 'object',
            properties: {
                book_name: { type: 'string' },
                entry_uid: { type: 'integer' },
            },
            required: ['entry_uid'],
            additionalProperties: false,
        },
        action: async (args) => {
            const normalizedArgs = args && typeof args === 'object' ? { ...args } : {};
            if (!Number.isInteger(asFiniteInteger(normalizedArgs.entry_uid, null))) {
                throw new Error('entry_uid is required for deletion.');
            }
            return await handleToolOperation('lorebook_delete_entry', normalizedArgs);
        },
        formatMessage: () => 'Deleting lorebook entry...',
    });
}

function ensureUi() {
    const host = jQuery('#extensions_settings2');
    if (!host.length) {
        return;
    }

    ensureStyles();
    if (jQuery(`#${UI_BLOCK_ID}`).length) {
        bindUi();
        return;
    }

    const html = `
<div id="${UI_BLOCK_ID}" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${escapeHtml(i18n('Character Editor Assistant'))}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="cea_row">
                <div class="menu_button" id="cea_open_editor_popup">${escapeHtml(i18n('Open Editor'))}</div>
            </div>
            <label class="checkbox_label"><input id="cea_replace_sync" type="checkbox"/> ${escapeHtml(i18n('Enable lorebook sync popup after Replace/Update'))}</label>
            <label for="cea_sync_llm_preset">${escapeHtml(i18n('Model request LLM preset name'))}</label>
            <select id="cea_sync_llm_preset" class="text_pole"></select>
            <label for="cea_sync_api_preset">${escapeHtml(i18n('Model request API preset name'))}</label>
            <select id="cea_sync_api_preset" class="text_pole"></select>
            <label class="checkbox_label"><input id="cea_plain_text_calls" type="checkbox"/> ${escapeHtml(i18n('Plain-text function-call mode'))}</label>
            <label for="cea_tool_retries">${escapeHtml(i18n('Tool-call retries on invalid/missing tool call (N)'))}</label>
            <input id="cea_tool_retries" class="text_pole" type="number" min="0" max="10" step="1"/>

            <div class="cea_panel">
                <div class="cea_row">
                    <div class="menu_button" id="cea_refresh">${escapeHtml(i18n('Refresh'))}</div>
                </div>
                <div><b>${escapeHtml(i18n('History'))}</b></div>
                <div id="cea_history"></div>
            </div>
            <small id="cea_status" class="cea_status"></small>
        </div>
    </div>
</div>`;

    host.append(html);
    bindUi();
}

function setStatus(message) {
    jQuery('#cea_status').text(String(message || ''));
}

async function refreshUiState(context = getContext()) {
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }
    const settings = getSettings();
    root.find('#cea_replace_sync').prop('checked', Boolean(settings.replaceLorebookSyncEnabled));
    root.find('#cea_plain_text_calls').prop('checked', Boolean(settings.plainTextFunctionCallMode));
    root.find('#cea_tool_retries').val(String(settings.toolCallRetryMax ?? defaultSettings.toolCallRetryMax));
    refreshPresetSelectors(root, context, settings);

    try {
        const state = await loadOperationState(context);
        root.find('#cea_history').html(renderJournalItems(state));
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Failed to refresh UI state`, error);
    }
}

function bindUi() {
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    root.off('.cea');
    jQuery(document).off('.ceaDiffZoom');

    jQuery(document).on('click.ceaDiffZoom', '.popup [data-cea-action="expand-line-diff"]', function (event) {
        event.preventDefault();
        event.stopPropagation();
        openCeaExpandedDiff(this);
    });

    jQuery(document).on('click.ceaDiffZoom', '.popup [data-cea-action="close-line-diff-zoom"], .popup .cea_line_diff_zoom_backdrop', function (event) {
        event.preventDefault();
        event.stopPropagation();
        closeCeaExpandedDiff(this);
    });

    jQuery(document).on('keydown.ceaDiffZoom', function (event) {
        if (event.key !== 'Escape') {
            return;
        }
        const overlays = Array.from(document.querySelectorAll('.popup .cea_line_diff_zoom_overlay'));
        const lastOverlay = overlays[overlays.length - 1];
        if (!(lastOverlay instanceof HTMLElement)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        lastOverlay.remove();
    });

    jQuery(document).on('pointerdown.ceaDiffZoom', '.popup .cea_line_diff_splitter', function (event) {
        beginCeaLineDiffResize(this, event.originalEvent || event);
    });

    root.on('change.cea', '#cea_replace_sync', function () {
        const settings = getSettings();
        settings.replaceLorebookSyncEnabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.on('change.cea', '#cea_sync_llm_preset', function () {
        const settings = getSettings();
        settings.lorebookSyncLlmPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('change.cea', '#cea_sync_api_preset', function () {
        const settings = getSettings();
        settings.lorebookSyncApiPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('change.cea', '#cea_plain_text_calls', function () {
        const settings = getSettings();
        settings.plainTextFunctionCallMode = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.on('change.cea', '#cea_tool_retries', function () {
        const settings = getSettings();
        settings.toolCallRetryMax = Math.max(0, Math.min(10, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('click.cea', '#cea_refresh', async function () {
        await refreshUiState();
    });

    root.on('click.cea', '#cea_open_editor_popup', async function () {
        await openCharacterEditorPopup(getContext());
    });

    root.on('click.cea', '#cea_clear_history', async function () {
        const context = getContext();
        if (!window.confirm(i18n('Clear all history records?'))) {
            return;
        }
        try {
            await clearHistoryRecords(context);
            notifySuccess(i18n('History cleared.'));
            await refreshUiState(context);
        } catch (error) {
            notifyError(i18nFormat('Clear failed: ${0}', error?.message || error));
        }
    });

    root.on('click.cea', '[data-cea-action]', async function () {
        const context = getContext();
        const action = String(jQuery(this).data('cea-action') || '').trim();
        const journalId = String(jQuery(this).data('journal-id') || '');
        if (!journalId || !action) {
            return;
        }
        try {
            if (action === 'delete') {
                if (!window.confirm(i18n('Delete this history record?'))) {
                    return;
                }
                const deleted = await deleteHistoryRecord(context, journalId);
                if (!deleted) {
                    throw new Error('Journal entry not found.');
                }
                notifySuccess(i18n('History record deleted.'));
                await refreshUiState(context);
                return;
            }
            if (action !== 'rollback') {
                return;
            }
            const settings = getSettings();
            const state = await loadOperationState(context, { force: true });
            const { entry } = getJournalById(state, journalId);
            if (!entry) {
                throw new Error('Journal entry not found.');
            }
            if (String(entry.kind || '') === 'rollback') {
                throw new Error('Rollback is not supported for rollback records.');
            }
            const summary = await rollbackJournalEntry(context, entry);
            const rollbackLog = {
                id: nextStateId(state, 'tx'),
                operationId: entry.operationId,
                kind: 'rollback',
                source: 'manual',
                summary,
                data: {
                    targetJournalId: entry.id,
                },
                createdAt: Date.now(),
            };
            appendJournal(state, rollbackLog, settings);
            state.updatedAt = Date.now();
            await persistOperationState(context, state);
            notifySuccess(i18n('Rollback completed.'));
            await refreshUiState(context);
        } catch (error) {
            if (action === 'rollback') {
                notifyError(i18nFormat('Rollback failed: ${0}', error?.message || error));
                return;
            }
            if (action === 'delete') {
                notifyError(i18nFormat('Delete failed: ${0}', error?.message || error));
            }
        }
    });
}

jQuery(async () => {
    registerLocaleData();
    ensureSettings();
    registerTools(getContext());
    ensureUi();
    setStatus(i18n('Character editor tools are ready.'));
    await refreshUiState();
    await primeActiveCharacterLorebookSnapshot(getContext());

    const eventSource = getContext().eventSource;
    const eventTypes = getContext().eventTypes;

    eventSource.on(eventTypes.CHAT_CHANGED, async () => {
        await refreshUiState();
        await primeActiveCharacterLorebookSnapshot(getContext());
    });

    eventSource.on(eventTypes.TOOL_CALLS_PERFORMED, async () => {
        await refreshUiState();
        await primeActiveCharacterLorebookSnapshot(getContext());
    });

    eventSource.on(eventTypes.OAI_PRESET_CHANGED_AFTER, async () => {
        await refreshUiState();
    });

    eventSource.on(eventTypes.SETTINGS_UPDATED, async () => {
        await refreshUiState();
    });

    const characterReplacedEvent = eventTypes?.CHARACTER_REPLACED || 'character_replaced';
    eventSource.on(characterReplacedEvent, async (event) => {
        await handleCharacterReplacedLorebookSync(getContext(), event);
    });
});
