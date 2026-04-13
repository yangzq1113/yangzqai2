/**
 * CardApp Extension - enables character cards to carry custom frontend UI.
 */

import { eventSource, event_types, getRequestHeaders } from '../../../script.js';
import { getContext } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { createContainer, destroyContainer, injectScopedCSS, loadEntryModule, showError } from './loader.js';
import { buildContext } from './context.js';
import { activateRendererBridge, deactivateRendererBridge } from './renderer.js';

const MODULE_NAME = 'card-app';

function t(text) {
    return translate(String(text || ''));
}

// Register i18n locale data
addLocaleData('zh-cn', {
    'Enable CardApp': '启用 CardApp',
    'Entry file': '入口文件',
    'Open CardApp Studio': '打开 CardApp Studio',
    'No character selected or character has no avatar.': '未选择角色或角色没有头像。',
    'CardApp Studio is already open.': 'CardApp Studio 已经打开了。',
    'Saved ${0}': '已保存 ${0}',
    'Failed to save: ${0}': '保存失败：${0}',
    'Created ${0}': '已创建 ${0}',
    'Failed to create file: ${0}': '创建文件失败：${0}',
    'Thinking...': '思考中...',
    '(Request cancelled)': '（请求已取消）',
    'AI Assistant': 'AI 助手',
    'Code Editor': '代码编辑器',
    'Files': '文件',
    'No files yet': '暂无文件',
    'Describe what you want to build...': '描述你想要构建的内容...',
    'Send': '发送',
    'Stop': '停止',
    'Save': '保存',
    'Reload': '重载',
    'Close Studio': '关闭 Studio',
    'New file name (e.g. utils.js):': '新文件名（如 utils.js）：',
    'Clear chat': '清空对话',
    'History': '历史记录',
    'Refresh': '刷新',
    'No history yet': '暂无历史记录',
    'Loading...': '加载中...',
    'Rollback to this version? This cannot be undone.': '回滚到此版本？此操作不可撤销。',
    'Rolled back successfully': '回滚成功',
});
addLocaleData('zh-tw', {
    'Enable CardApp': '啟用 CardApp',
    'Entry file': '入口檔案',
    'Open CardApp Studio': '開啟 CardApp Studio',
    'No character selected or character has no avatar.': '未選擇角色或角色沒有頭像。',
    'CardApp Studio is already open.': 'CardApp Studio 已經開啟了。',
    'Saved ${0}': '已儲存 ${0}',
    'Failed to save: ${0}': '儲存失敗：${0}',
    'Created ${0}': '已建立 ${0}',
    'Failed to create file: ${0}': '建立檔案失敗：${0}',
    'Thinking...': '思考中...',
    '(Request cancelled)': '（請求已取消）',
    'AI Assistant': 'AI 助手',
    'Code Editor': '程式碼編輯器',
    'Files': '檔案',
    'No files yet': '暫無檔案',
    'Describe what you want to build...': '描述你想要建構的內容...',
    'Send': '傳送',
    'Stop': '停止',
    'Save': '儲存',
    'Reload': '重新載入',
    'Close Studio': '關閉 Studio',
    'New file name (e.g. utils.js):': '新檔案名稱（如 utils.js）：',
    'Clear chat': '清空對話',
    'History': '歷史記錄',
    'Refresh': '重新整理',
    'No history yet': '暫無歷史記錄',
    'Loading...': '載入中...',
    'Rollback to this version? This cannot be undone.': '回滾到此版本？此操作不可撤銷。',
    'Rolled back successfully': '回滾成功',
});

// State
let isCardAppActive = false;
let currentCardApp = null;
let currentCtx = null;

/**
 * Check if the current character has a CardApp enabled.
 * @returns {object|null} The card_app config or null
 */
function getCardAppConfig() {
    const context = getContext();
    if (!context.characterId && context.characterId !== 0) return null;
    const character = context.characters[context.characterId];
    if (!character) return null;
    const cardApp = character?.data?.extensions?.card_app;
    if (!cardApp?.enabled) return null;
    return cardApp;
}

/**
 * Get the character's avatar-based ID (without .png extension).
 * @returns {string|null}
 */
function getCharId() {
    const context = getContext();
    if (!context.characterId && context.characterId !== 0) return null;
    const character = context.characters[context.characterId];
    if (!character?.avatar) return null;
    return character.avatar.replace('.png', '');
}

/**
 * Activate CardApp for the current character.
 */
async function activateCardApp() {
    const config = getCardAppConfig();
    const charId = getCharId();
    if (!config || !charId) return;

    console.log(`[${MODULE_NAME}] Activating CardApp for character: ${charId}`);

    // 1. Create container and hide default chat UI
    const container = createContainer();

    // 2. Load and inject scoped CSS (if any CSS files exist)
    try {
        const cssFiles = await findCSSFiles(charId, config);
        for (const cssContent of cssFiles) {
            injectScopedCSS(cssContent);
        }
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to load CSS:`, err);
    }

    // 3. Build context object
    const ctx = buildContext(container, charId, config);
    currentCtx = ctx;

    // 4. Load entry JS module and call init(ctx)
    const entry = config.entry || 'index.js';
    try {
        const module = await loadEntryModule(charId, entry);

        if (typeof module.init !== 'function') {
            throw new Error(`CardApp entry module does not export an init() function`);
        }

        await module.init(ctx);
    } catch (err) {
        console.error(`[${MODULE_NAME}] Failed to initialize CardApp:`, err);
        showError(container, err, () => deactivateCardApp());
        // Still mark as active so deactivate can clean up
    }

    // 5. Activate renderer bridge to push messages to CardApp
    activateRendererBridge(ctx);

    isCardAppActive = true;
    currentCardApp = { charId, config };
}

/**
 * Find and fetch CSS files for a CardApp.
 * @param {string} charId
 * @param {object} config
 * @returns {Promise<string[]>} Array of CSS content strings
 */
async function findCSSFiles(charId, config) {
    const cssFiles = [];

    // Check for style.css by convention
    try {
        const response = await fetch(`/api/card-app/${encodeURIComponent(charId)}/style.css`, {
            headers: getRequestHeaders(),
        });
        if (response.ok) {
            cssFiles.push(await response.text());
        }
    } catch {
        // No style.css, that's fine
    }

    return cssFiles;
}

/**
 * Deactivate the current CardApp.
 */
async function deactivateCardApp() {
    if (!isCardAppActive) return;

    console.log(`[${MODULE_NAME}] Deactivating CardApp`);

    // Deactivate renderer bridge
    deactivateRendererBridge();

    // Dispose context (cleans up intervals, timeouts, event listeners, user callbacks)
    if (currentCtx) {
        try {
            currentCtx._dispose();
        } catch (err) {
            console.error(`[${MODULE_NAME}] Context dispose error:`, err);
        }
        currentCtx = null;
    }

    // Remove container and restore default UI
    destroyContainer();

    isCardAppActive = false;
    currentCardApp = null;
}

/**
 * Handle chat changed event - check if we need to activate/deactivate CardApp.
 */
async function onChatChanged() {
    // Always deactivate first
    await deactivateCardApp();

    // Check if new character has CardApp
    const config = getCardAppConfig();
    if (config) {
        await activateCardApp();
    }
}

/**
 * Hot-reload the CardApp (deactivate then reactivate).
 * Used by CardApp Studio after file modifications.
 */
export async function reloadCardApp() {
    await deactivateCardApp();
    const config = getCardAppConfig();
    if (config) {
        await activateCardApp();
    }
}

/**
 * Check if a CardApp is currently active.
 * @returns {boolean}
 */
export function isActive() {
    return isCardAppActive;
}

// Register event listeners
eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

// CardApp Studio button in character advanced settings
$(document).on('click', '#card_app_open_studio', async function () {
    const charId = getCharId();
    if (!charId) {
        toastr.warning(t('No character selected or character has no avatar.'));
        return;
    }
    const { openCardAppStudio } = await import('./studio/studio.js');
    await openCardAppStudio(charId);
});

console.log(`[${MODULE_NAME}] Extension loaded`);
