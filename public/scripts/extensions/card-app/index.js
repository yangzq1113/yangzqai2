import { eventSource, event_types } from '../../../script.js';
import { getContext } from '../../extensions.js';

const MODULE_NAME = 'card-app';

// State
let isCardAppActive = false;
let currentCardApp = null;
let cleanupFunctions = [];

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

    // TODO: Phase 2 - implement full activation
    // 1. Hide default chat UI
    // 2. Create #card-app-container
    // 3. Load CSS with auto-scoping
    // 4. Load entry JS via dynamic import
    // 5. Call init(ctx)

    isCardAppActive = true;
    currentCardApp = { charId, config };
}

/**
 * Deactivate the current CardApp.
 */
async function deactivateCardApp() {
    if (!isCardAppActive) return;

    console.log(`[${MODULE_NAME}] Deactivating CardApp`);

    // Run all cleanup functions
    for (const fn of cleanupFunctions) {
        try {
            fn();
        } catch (err) {
            console.error(`[${MODULE_NAME}] Cleanup error:`, err);
        }
    }
    cleanupFunctions = [];

    // TODO: Phase 2 - implement full deactivation
    // 1. Call onDispose callbacks
    // 2. Remove injected CSS
    // 3. Remove script tags
    // 4. Remove #card-app-container
    // 5. Restore default chat UI
    // 6. Restore Quick Reply UI

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

// Register event listeners
eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

console.log(`[${MODULE_NAME}] Extension loaded`);
