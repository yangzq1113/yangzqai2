/**
 * CardApp Context - builds the ctx object passed to CardApp's init() function.
 */

import { eventSource, event_types, chat, chat_metadata, this_chid, characters, getRequestHeaders, openCharacterChat, doNewChat, closeCurrentChat, getPastCharacterChats } from '../../../script.js';
import { getContext, saveMetadataDebounced } from '../../extensions.js';
import { executeSlashCommandsWithOptions } from '../../slash-commands.js';

/**
 * Build the context object for a CardApp.
 * @param {HTMLElement} container - The CardApp container element
 * @param {string} charId - Character ID
 * @param {object} config - The card_app config from character data
 * @returns {object} The context object
 */
export function buildContext(container, charId, config) {
    // Tracked resources for automatic cleanup
    const intervals = [];
    const timeouts = [];
    const eventListeners = [];
    const disposeCallbacks = [];

    // Renderer registered by the CardApp
    let renderer = null;

    const ctx = {
        /** @type {HTMLElement} The CardApp container element */
        container,

        /** @type {string} The character ID */
        charId,

        /** @type {import('../../extensions.js').SillyTavernContext} Luker event bus (direct reference) */
        eventSource,

        // ==================== Renderer ====================

        /**
         * Register a renderer for message display.
         * @param {{renderMessage: Function, removeMessage: Function}} rendererObj
         */
        registerRenderer(rendererObj) {
            if (!rendererObj || typeof rendererObj.renderMessage !== 'function') {
                throw new Error('[CardApp] registerRenderer requires an object with renderMessage function');
            }
            renderer = rendererObj;
        },

        /**
         * Get the registered renderer (used internally by the bridge).
         * @returns {{renderMessage: Function, removeMessage: Function}|null}
         */
        getRenderer() {
            return renderer;
        },

        // ==================== Messages ====================

        /**
         * Send a message through Luker's message pipeline.
         * @param {string} text - Message text
         * @param {object} [options] - Options
         * @param {boolean} [options.silent=false] - If true, don't save to chat history
         * @returns {Promise<void>}
         */
        async sendMessage(text, options = {}) {
            if (options.silent) {
                // TODO: implement silent mode (send to LLM without saving to chat)
                console.warn('[CardApp] Silent mode not yet implemented, sending normally');
            }
            // Write text to the hidden send_textarea and trigger the send flow
            const textarea = document.getElementById('send_textarea');
            if (textarea) {
                textarea.value = text;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const { sendTextareaMessage } = await import('../../../script.js');
            await sendTextareaMessage();
        },

        /**
         * Get chat history.
         * @param {number} [limit] - Maximum number of messages to return
         * @param {number} [offset=0] - Offset from the end
         * @returns {Array} Chat messages
         */
        getHistory(limit, offset = 0) {
            const messages = chat || [];
            if (limit) {
                const start = Math.max(0, messages.length - offset - limit);
                const end = messages.length - offset;
                return messages.slice(start, end);
            }
            return [...messages];
        },

        /**
         * Edit a message.
         * @param {number} messageId - Message index
         * @param {string} newText - New message text
         * @returns {Promise<void>}
         */
        async editMessage(messageId, newText) {
            const context = getContext();
            if (messageId >= 0 && messageId < chat.length) {
                chat[messageId].mes = newText;
                await context.saveChat();
            }
        },

        /**
         * Delete a message.
         * @param {number} messageId - Message index
         * @returns {Promise<void>}
         */
        async deleteMessage(messageId) {
            const context = getContext();
            if (messageId >= 0 && messageId < chat.length) {
                chat.splice(messageId, 1);
                await context.saveChat();
            }
        },

        /**
         * Trigger a swipe (regenerate last message).
         * @returns {Promise<void>}
         */
        async swipe() {
            const context = getContext();
            await context.Generate('swipe');
        },

        /**
         * Stop the current generation.
         */
        stopGeneration() {
            const context = getContext();
            if (typeof context.abortController?.abort === 'function') {
                context.abortController.abort();
            }
        },

        /**
         * Continue generation (append to last message).
         * @returns {Promise<void>}
         */
        async continueGeneration() {
            const context = getContext();
            await context.Generate('continue');
        },

        // ==================== Data ====================

        /**
         * Get current character data.
         * @returns {object|null}
         */
        getCharacterData() {
            const context = getContext();
            if (context.characterId === undefined || context.characterId === null) return null;
            return context.characters[context.characterId] || null;
        },

        /**
         * Get a chat variable.
         * @param {string} key
         * @returns {*}
         */
        getVariable(key) {
            return chat_metadata?.variables?.[key];
        },

        /**
         * Set a chat variable.
         * @param {string} key
         * @param {*} value
         */
        setVariable(key, value) {
            if (!chat_metadata.variables) {
                chat_metadata.variables = {};
            }
            chat_metadata.variables[key] = value;
            saveMetadataDebounced();
        },

        /**
         * Get chat state for a namespace.
         * @param {string} namespace
         * @returns {object}
         */
        getChatState(namespace) {
            return chat_metadata?.[namespace] || {};
        },

        /**
         * Set chat state for a namespace.
         * @param {string} namespace
         * @param {string} key
         * @param {*} value
         */
        setChatState(namespace, key, value) {
            if (!chat_metadata[namespace]) {
                chat_metadata[namespace] = {};
            }
            chat_metadata[namespace][key] = value;
        },

        // ==================== Chat Management ====================

        /**
         * Get list of all chats for the current character.
         * @returns {Promise<Array<{file_name: string, mes: string, last_mes: string, file_size: number}>>}
         */
        async getChatList() {
            const context = getContext();
            if (!context.characterId && context.characterId !== 0) return [];
            return await getPastCharacterChats(context.characterId);
        },

        /**
         * Switch to a different chat.
         * @param {string} chatName - The chat file name to switch to
         * @returns {Promise<void>}
         */
        async switchChat(chatName) {
            await openCharacterChat(chatName);
        },

        /**
         * Create a new chat.
         * @returns {Promise<void>}
         */
        async newChat() {
            await doNewChat();
        },

        /**
         * Close the current chat (return to character list).
         * @returns {Promise<void>}
         */
        async closeChat() {
            await closeCurrentChat();
        },

        // ==================== Slash Commands ====================

        /**
         * Execute a slash command.
         * @param {string} command - The slash command string (e.g. '/sys Hello')
         * @returns {Promise<*>}
         */
        async executeSlashCommand(command) {
            return await executeSlashCommandsWithOptions(command);
        },

        // ==================== Scoped Utilities ====================

        /**
         * Scoped setInterval - automatically cleared on dispose.
         * @param {Function} fn
         * @param {number} ms
         * @returns {number} Interval ID
         */
        setInterval(fn, ms) {
            const id = window.setInterval(fn, ms);
            intervals.push(id);
            return id;
        },

        /**
         * Scoped setTimeout - automatically cleared on dispose.
         * @param {Function} fn
         * @param {number} ms
         * @returns {number} Timeout ID
         */
        setTimeout(fn, ms) {
            const id = window.setTimeout(fn, ms);
            timeouts.push(id);
            return id;
        },

        /**
         * Scoped addEventListener - automatically removed on dispose.
         * @param {EventTarget} target
         * @param {string} event
         * @param {Function} handler
         * @param {object} [options]
         */
        addEventListener(target, event, handler, options) {
            target.addEventListener(event, handler, options);
            eventListeners.push({ target, event, handler, options });
        },

        // ==================== Lifecycle ====================

        /**
         * Register a callback to run when the CardApp is disposed.
         * @param {Function} fn
         */
        onDispose(fn) {
            if (typeof fn === 'function') {
                disposeCallbacks.push(fn);
            }
        },

        /**
         * Render raw text through Luker's message formatting pipeline.
         * @param {string} rawText - Raw message text
         * @param {number} [messageId=-1] - Message ID for context
         * @returns {Promise<{html: string}>}
         */
        async renderText(rawText, messageId = -1) {
            // Import messageFormatting dynamically to avoid circular deps
            const { messageFormatting } = await import('../../../script.js');
            const html = messageFormatting(rawText, '', false, false, messageId, {}, false);
            return { html };
        },
    };

    /**
     * Dispose all tracked resources.
     * Called internally when the CardApp is deactivated.
     */
    ctx._dispose = function () {
        // Run user-registered dispose callbacks
        for (const fn of disposeCallbacks) {
            try {
                fn();
            } catch (err) {
                console.error('[CardApp] Dispose callback error:', err);
            }
        }

        // Clear all tracked intervals
        for (const id of intervals) {
            window.clearInterval(id);
        }

        // Clear all tracked timeouts
        for (const id of timeouts) {
            window.clearTimeout(id);
        }

        // Remove all tracked event listeners
        for (const { target, event, handler, options } of eventListeners) {
            try {
                target.removeEventListener(event, handler, options);
            } catch (err) {
                console.error('[CardApp] Failed to remove event listener:', err);
            }
        }

        // Clear arrays
        intervals.length = 0;
        timeouts.length = 0;
        eventListeners.length = 0;
        disposeCallbacks.length = 0;
        renderer = null;
    };

    return ctx;
}
