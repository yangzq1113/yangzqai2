import {
    buildObjectPatchOperations,
    extension_prompt_roles,
    extension_prompt_types,
    saveSettingsDebounced,
} from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { newWorldInfoEntryTemplate } from '../../world-info.js';

const MODULE_NAME = 'character_editor_assistant';
const CHAT_STATE_NAMESPACE = MODULE_NAME;
const UI_BLOCK_ID = 'character_editor_assistant_settings';
const STYLE_ID = 'character_editor_assistant_style';
const PROMPT_KEY = 'character_editor_assistant_prompt';

const TOOL_NAMES = Object.freeze({
    UPDATE_FIELDS: 'luker_card_update_fields',
    SET_PRIMARY_BOOK: 'luker_card_set_primary_lorebook',
    UPSERT_ENTRY: 'luker_card_upsert_lorebook_entry',
    DELETE_ENTRY: 'luker_card_delete_lorebook_entry',
});

const DEFAULT_TOOL_PROMPT = [
    'You can edit the CURRENT character card and its PRIMARY bound lorebook by using function tools.',
    'Use tool calls only when user intent is explicitly about creating/updating/deleting character card info or lorebook entries.',
    'You may call multiple tools in one response.',
    'Never delete lorebook entries unless user intent is explicit.',
    'If a tool result says pending approval, explain briefly and wait.',
].join('\n');

const defaultSettings = {
    enabled: false,
    requireApproval: true,
    autoInjectPrompt: true,
    toolInstructionPrompt: DEFAULT_TOOL_PROMPT,
    maxJournalEntries: 120,
};

const stateCache = new Map();
const snapshotCache = new Map();

function i18n(text) {
    return translate(String(text || ''));
}

function i18nFormat(text, ...values) {
    return i18n(text).replace(/\$\{(\d+)\}/g, (_, idx) => String(values[Number(idx)] ?? ''));
}

function registerLocaleData() {
    addLocaleData('zh-cn', {
        'Character Editor Assistant': '角色卡编辑助手',
        'Enabled': '启用',
        'Require approval before applying tool edits': '工具修改需审批后生效',
        'Inject tool instruction into generation context': '将工具说明注入生成上下文',
        'Tool instruction prompt': '工具说明提示词',
        'Refresh': '刷新',
        'Pending operations': '待审批操作',
        'History': '修改历史',
        'Approve': '批准',
        'Reject': '拒绝',
        'Rollback': '回滚',
        'No pending operations.': '暂无待审批操作。',
        'No history yet.': '暂无历史记录。',
        'Character editor tools are ready.': '角色编辑工具已就绪。',
        'Current chat has no active character.': '当前聊天没有活动角色卡。',
        'Operation queued for approval: ${0}': '操作已进入待审批队列：${0}',
        'Operation applied: ${0}': '操作已生效：${0}',
        'Operation approved: ${0}': '操作已批准：${0}',
        'Operation rejected.': '操作已拒绝。',
        'Rollback completed.': '回滚完成。',
        'Rollback failed: ${0}': '回滚失败：${0}',
        'Need explicit user intent before deletion.': '删除前需要用户明确意图。',
    });
    addLocaleData('zh-tw', {
        'Character Editor Assistant': '角色卡編輯助手',
        'Enabled': '啟用',
        'Require approval before applying tool edits': '工具修改需審批後生效',
        'Inject tool instruction into generation context': '將工具說明注入生成上下文',
        'Tool instruction prompt': '工具說明提示詞',
        'Refresh': '刷新',
        'Pending operations': '待審批操作',
        'History': '修改歷史',
        'Approve': '批准',
        'Reject': '拒絕',
        'Rollback': '回滾',
        'No pending operations.': '暫無待審批操作。',
        'No history yet.': '暫無歷史記錄。',
        'Character editor tools are ready.': '角色編輯工具已就緒。',
        'Current chat has no active character.': '當前聊天沒有活動角色卡。',
        'Operation queued for approval: ${0}': '操作已進入待審批隊列：${0}',
        'Operation applied: ${0}': '操作已生效：${0}',
        'Operation approved: ${0}': '操作已批准：${0}',
        'Operation rejected.': '操作已拒絕。',
        'Rollback completed.': '回滾完成。',
        'Rollback failed: ${0}': '回滾失敗：${0}',
        'Need explicit user intent before deletion.': '刪除前需要用戶明確意圖。',
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
    settings.enabled = Boolean(settings.enabled);
    settings.requireApproval = settings.requireApproval !== false;
    settings.autoInjectPrompt = settings.autoInjectPrompt !== false;
    settings.toolInstructionPrompt = String(settings.toolInstructionPrompt || '').trim() || DEFAULT_TOOL_PROMPT;
    settings.maxJournalEntries = Math.max(20, Math.min(500, Number(settings.maxJournalEntries || defaultSettings.maxJournalEntries)));
}

function getSettings() {
    ensureSettings();
    return extension_settings[MODULE_NAME];
}

function getChatKey(context) {
    if (context.groupId) {
        return `group:${String(context.chatId || '')}`;
    }
    const avatar = String(context.characters?.[context.characterId]?.avatar || '').trim();
    const chatId = String(context.chatId || '').trim();
    if (!avatar || !chatId) {
        return 'invalid';
    }
    return `char:${avatar}:${chatId}`;
}

function createEmptyState() {
    return {
        version: 1,
        nextId: 1,
        pending: [],
        journal: [],
        updatedAt: Date.now(),
    };
}

function normalizeOperationState(state) {
    const normalized = state && typeof state === 'object' ? clone(state) : createEmptyState();
    normalized.version = 1;
    normalized.nextId = Math.max(1, Number(normalized.nextId || 1));
    normalized.pending = Array.isArray(normalized.pending)
        ? normalized.pending.filter(item => item && typeof item === 'object' && String(item.id || '').trim())
        : [];
    normalized.journal = Array.isArray(normalized.journal)
        ? normalized.journal.filter(item => item && typeof item === 'object' && String(item.id || '').trim())
        : [];
    normalized.updatedAt = Number(normalized.updatedAt || Date.now());
    return normalized;
}

async function loadOperationState(context, { force = false } = {}) {
    const chatKey = getChatKey(context);
    if (!force && stateCache.has(chatKey)) {
        return clone(stateCache.get(chatKey));
    }
    const loaded = await context.getChatState(CHAT_STATE_NAMESPACE) || null;
    const normalized = normalizeOperationState(loaded);
    stateCache.set(chatKey, clone(normalized));
    snapshotCache.set(chatKey, clone(normalized));
    return normalized;
}

async function persistOperationState(context, state) {
    const chatKey = getChatKey(context);
    const previous = snapshotCache.get(chatKey) || null;
    const next = normalizeOperationState(state);
    const operations = buildObjectPatchOperations(previous, next, { maxOperations: 5000 });
    if (operations.length > 0) {
        const ok = await context.patchChatState(CHAT_STATE_NAMESPACE, operations);
        if (!ok) {
            throw new Error('Failed to persist operation state.');
        }
    }
    snapshotCache.set(chatKey, clone(next));
    stateCache.set(chatKey, clone(next));
}

function nextStateId(state, prefix = 'op') {
    const id = `${prefix}_${Math.floor(Number(state.nextId || 1))}`;
    state.nextId = Math.max(1, Math.floor(Number(state.nextId || 1)) + 1);
    return id;
}

function getActiveCharacterRecord(context) {
    if (context.groupId) {
        throw new Error('Character editor assistant is unavailable in group chats.');
    }
    const characterIndex = Number(context.characterId);
    const character = context.characters?.[characterIndex];
    if (!character) {
        throw new Error('No active character selected.');
    }
    const avatar = String(character.avatar || '').trim();
    if (!avatar) {
        throw new Error('Active character avatar is missing.');
    }
    return {
        characterIndex,
        character,
        avatar,
    };
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

    return {
        summary: `Set primary lorebook: ${beforeName || '(none)'} -> ${targetName || '(none)'}`,
        kind: operation.kind,
        data: {
            beforeName,
            afterName: targetName,
        },
    };
}

async function applyOperationNow(context, operation) {
    const record = getActiveCharacterRecord(context);
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

function createOperationEnvelope(state, kind, args, source = 'tool') {
    return {
        id: nextStateId(state, 'op'),
        kind: String(kind || '').trim(),
        args: args && typeof args === 'object' ? clone(args) : {},
        source: String(source || 'tool'),
        createdAt: Date.now(),
    };
}

async function submitOperation(context, operation) {
    const settings = getSettings();
    const state = await loadOperationState(context);

    if (settings.requireApproval) {
        state.pending.push(operation);
        state.updatedAt = Date.now();
        await persistOperationState(context, state);
        return {
            status: 'pending',
            operation_id: operation.id,
            summary: buildOperationSummary(operation),
        };
    }

    const applied = await applyOperationNow(context, operation);
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
    await persistOperationState(context, state);

    return {
        status: 'applied',
        operation_id: operation.id,
        journal_id: journalEntry.id,
        summary: journalEntry.summary,
    };
}

function getPendingOperationById(state, operationId) {
    const id = String(operationId || '').trim();
    if (!id) {
        return { operation: null, index: -1 };
    }
    const index = state.pending.findIndex(item => String(item?.id || '') === id);
    return {
        operation: index >= 0 ? state.pending[index] : null,
        index,
    };
}

async function approvePendingOperation(context, operationId) {
    const settings = getSettings();
    const state = await loadOperationState(context, { force: true });
    const { operation, index } = getPendingOperationById(state, operationId);
    if (!operation || index < 0) {
        throw new Error('Pending operation not found.');
    }

    const applied = await applyOperationNow(context, operation);
    state.pending.splice(index, 1);
    const journalEntry = {
        id: nextStateId(state, 'tx'),
        operationId: operation.id,
        kind: applied.kind,
        source: 'approval',
        summary: String(applied.summary || buildOperationSummary(operation)),
        data: clone(applied.data || {}),
        createdAt: Date.now(),
    };
    appendJournal(state, journalEntry, settings);
    state.updatedAt = Date.now();
    await persistOperationState(context, state);
    return journalEntry;
}

async function rejectPendingOperation(context, operationId) {
    const state = await loadOperationState(context, { force: true });
    const { index } = getPendingOperationById(state, operationId);
    if (index < 0) {
        throw new Error('Pending operation not found.');
    }
    state.pending.splice(index, 1);
    state.updatedAt = Date.now();
    await persistOperationState(context, state);
}

function getJournalById(state, journalId) {
    const id = String(journalId || '').trim();
    const index = state.journal.findIndex(item => String(item?.id || '') === id);
    return {
        entry: index >= 0 ? state.journal[index] : null,
        index,
    };
}

async function rollbackJournalEntry(context, journalEntry) {
    const record = getActiveCharacterRecord(context);
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
#${UI_BLOCK_ID} .cea_row .menu_button {
    display: inline-flex;
    width: auto;
    min-width: max-content;
    white-space: nowrap;
    writing-mode: horizontal-tb;
    text-orientation: mixed;
    align-items: center;
    justify-content: center;
}
`;
    document.head.append(style);
}

function renderPendingItems(state) {
    const items = Array.isArray(state?.pending) ? state.pending : [];
    if (items.length === 0) {
        return `<div class="cea_item_meta">${escapeHtml(i18n('No pending operations.'))}</div>`;
    }
    return items.map(item => {
        const summary = buildOperationSummary(item);
        return `
<div class="cea_item" data-op-id="${escapeHtml(item.id)}">
    <div class="cea_item_top">
        <div>
            <div><b>${escapeHtml(summary)}</b></div>
            <div class="cea_item_meta">${escapeHtml(new Date(Number(item.createdAt || Date.now())).toLocaleString())}</div>
        </div>
        <div class="cea_item_actions">
            <div class="menu_button menu_button_small" data-cea-action="approve" data-op-id="${escapeHtml(item.id)}">${escapeHtml(i18n('Approve'))}</div>
            <div class="menu_button menu_button_small" data-cea-action="reject" data-op-id="${escapeHtml(item.id)}">${escapeHtml(i18n('Reject'))}</div>
        </div>
    </div>
</div>`;
    }).join('');
}

function renderJournalItems(state) {
    const items = Array.isArray(state?.journal) ? state.journal.slice().reverse() : [];
    if (items.length === 0) {
        return `<div class="cea_item_meta">${escapeHtml(i18n('No history yet.'))}</div>`;
    }
    return items.map(item => `
<div class="cea_item" data-journal-id="${escapeHtml(item.id)}">
    <div class="cea_item_top">
        <div>
            <div><b>${escapeHtml(String(item.summary || item.kind || ''))}</b></div>
            <div class="cea_item_meta">${escapeHtml(new Date(Number(item.createdAt || Date.now())).toLocaleString())}</div>
        </div>
        <div class="cea_item_actions">
            <div class="menu_button menu_button_small" data-cea-action="rollback" data-journal-id="${escapeHtml(item.id)}">${escapeHtml(i18n('Rollback'))}</div>
        </div>
    </div>
</div>`).join('');
}

function syncPromptInjection(context) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoInjectPrompt) {
        context.setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.NONE, 0, true, extension_prompt_roles.SYSTEM);
        return;
    }
    context.setExtensionPrompt(
        PROMPT_KEY,
        String(settings.toolInstructionPrompt || '').trim(),
        extension_prompt_types.IN_PROMPT,
        0,
        true,
        extension_prompt_roles.SYSTEM,
    );
}

function canUseToolsInCurrentContext(context) {
    if (!getSettings().enabled) {
        return false;
    }
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
    if (result.status === 'pending') {
        notifyWarning(i18nFormat('Operation queued for approval: ${0}', result.summary));
    } else {
        notifySuccess(i18nFormat('Operation applied: ${0}', result.summary));
    }
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
            <label class="checkbox_label"><input id="cea_enabled" type="checkbox"/> ${escapeHtml(i18n('Enabled'))}</label>
            <label class="checkbox_label"><input id="cea_require_approval" type="checkbox"/> ${escapeHtml(i18n('Require approval before applying tool edits'))}</label>
            <label class="checkbox_label"><input id="cea_auto_inject" type="checkbox"/> ${escapeHtml(i18n('Inject tool instruction into generation context'))}</label>
            <label for="cea_prompt">${escapeHtml(i18n('Tool instruction prompt'))}</label>
            <textarea id="cea_prompt" class="text_pole textarea_compact" rows="6"></textarea>

            <div class="cea_panel">
                <div class="cea_row">
                    <div class="menu_button" id="cea_refresh">${escapeHtml(i18n('Refresh'))}</div>
                </div>
                <div><b>${escapeHtml(i18n('Pending operations'))}</b></div>
                <div id="cea_pending"></div>
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
    root.find('#cea_enabled').prop('checked', Boolean(settings.enabled));
    root.find('#cea_require_approval').prop('checked', Boolean(settings.requireApproval));
    root.find('#cea_auto_inject').prop('checked', Boolean(settings.autoInjectPrompt));
    root.find('#cea_prompt').val(String(settings.toolInstructionPrompt || DEFAULT_TOOL_PROMPT));

    try {
        const state = await loadOperationState(context);
        root.find('#cea_pending').html(renderPendingItems(state));
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
    const context = getContext();

    root.off('.cea');

    root.on('change.cea', '#cea_enabled', function () {
        const settings = getSettings();
        settings.enabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
        syncPromptInjection(context);
        refreshUiState(context);
    });

    root.on('change.cea', '#cea_require_approval', function () {
        const settings = getSettings();
        settings.requireApproval = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
        refreshUiState(context);
    });

    root.on('change.cea', '#cea_auto_inject', function () {
        const settings = getSettings();
        settings.autoInjectPrompt = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
        syncPromptInjection(context);
    });

    root.on('input.cea', '#cea_prompt', function () {
        const settings = getSettings();
        settings.toolInstructionPrompt = String(jQuery(this).val() || '').trim() || DEFAULT_TOOL_PROMPT;
        saveSettingsDebounced();
        syncPromptInjection(context);
    });

    root.on('click.cea', '#cea_refresh', async function () {
        await refreshUiState(context);
    });

    root.on('click.cea', '[data-cea-action="approve"]', async function () {
        const opId = String(jQuery(this).data('op-id') || '');
        if (!opId) {
            return;
        }
        try {
            const entry = await approvePendingOperation(context, opId);
            notifySuccess(i18nFormat('Operation approved: ${0}', entry.summary || opId));
            await refreshUiState(context);
        } catch (error) {
            notifyError(String(error?.message || error));
        }
    });

    root.on('click.cea', '[data-cea-action="reject"]', async function () {
        const opId = String(jQuery(this).data('op-id') || '');
        if (!opId) {
            return;
        }
        try {
            await rejectPendingOperation(context, opId);
            notifySuccess(i18n('Operation rejected.'));
            await refreshUiState(context);
        } catch (error) {
            notifyError(String(error?.message || error));
        }
    });

    root.on('click.cea', '[data-cea-action="rollback"]', async function () {
        const journalId = String(jQuery(this).data('journal-id') || '');
        if (!journalId) {
            return;
        }
        try {
            const settings = getSettings();
            const state = await loadOperationState(context, { force: true });
            const { entry } = getJournalById(state, journalId);
            if (!entry) {
                throw new Error('Journal entry not found.');
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
            notifyError(i18nFormat('Rollback failed: ${0}', error?.message || error));
        }
    });
}

jQuery(async () => {
    const context = getContext();
    registerLocaleData();
    ensureSettings();
    registerTools(context);
    syncPromptInjection(context);
    ensureUi();
    setStatus(i18n('Character editor tools are ready.'));
    await refreshUiState(context);

    context.eventSource.on(context.eventTypes.CHAT_CHANGED, async () => {
        syncPromptInjection(context);
        await refreshUiState(context);
    });

    context.eventSource.on(context.eventTypes.TOOL_CALLS_PERFORMED, async () => {
        await refreshUiState(context);
    });
});
