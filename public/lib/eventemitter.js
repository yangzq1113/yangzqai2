/* Polyfill indexOf. */
var indexOf;

if (typeof Array.prototype.indexOf === 'function') {
    indexOf = function (haystack, needle) {
        return haystack.indexOf(needle);
    };
} else {
    indexOf = function (haystack, needle) {
        var i = 0, length = haystack.length, idx = -1, found = false;

        while (i < length && !found) {
            if (haystack[i] === needle) {
                idx = i;
                found = true;
            }

            i++;
        }

        return idx;
    };
};


/* Polyfill EventEmitter. */
/**
 * Creates an event emitter.
 * @param {string[]} autoFireAfterEmit Auto-fire event names
 */
var EventEmitter = function (autoFireAfterEmit = []) {
    this.events = {};
    this.autoFireLastArgs = new Map();
    this.autoFireAfterEmit = new Set(autoFireAfterEmit);
    this.orderConfig = {};
    this.listenerCounter = 0;
    this.listenerMinOrder = 0;
    this.listenerMaxOrder = 0;
};

/**
 * @param {string} stack
 * @returns {string}
 */
function inferExtensionIdFromStack(stack) {
    if (typeof stack !== 'string') {
        return '';
    }

    const normalized = stack.replaceAll('\\', '/');
    const match = normalized.match(/\/scripts\/extensions\/(third-party\/[^/\s:()]+|[^/\s:()]+)\//);
    return match ? String(match[1] || '').trim() : '';
}

/**
 * @returns {{ pluginId: string, source: string }}
 */
function inferListenerOrigin() {
    const error = new Error();
    const stack = typeof error.stack === 'string' ? error.stack : '';
    const pluginId = inferExtensionIdFromStack(stack);
    const firstFrame = stack.split('\n').map(x => x.trim()).find(x => x.startsWith('at '));
    return {
        pluginId,
        source: firstFrame || '',
    };
}

/**
 * @param {any} options
 * @returns {{ pluginId: string, priority: number, source: string }}
 */
function normalizeListenerOptions(options) {
    const origin = inferListenerOrigin();
    const safe = options && typeof options === 'object' ? options : {};
    const pluginId = String(safe.pluginId || origin.pluginId || '').trim();
    const priority = Number.isFinite(Number(safe.priority)) ? Number(safe.priority) : 0;
    const source = String(safe.source || origin.source || '').trim();
    return { pluginId, priority, source };
}

/**
 * @param {any} value
 * @returns {string[]}
 */
function normalizeOrderList(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    const seen = new Set();
    const result = [];
    for (const item of value) {
        const id = String(item || '').trim();
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        result.push(id);
    }
    return result;
}

/**
 * @param {any} orderConfig
 * @returns {Record<string, { pluginOrder: string[] }>}
 */
function normalizeOrderConfig(orderConfig) {
    const source = orderConfig && typeof orderConfig === 'object' ? orderConfig : {};
    const normalized = {};
    for (const [eventName, eventConfig] of Object.entries(source)) {
        if (!eventConfig || typeof eventConfig !== 'object') {
            continue;
        }
        normalized[eventName] = {
            pluginOrder: normalizeOrderList(eventConfig.pluginOrder),
        };
    }
    return normalized;
}

EventEmitter.prototype._createListenerRecord = function (listener, options = null) {
    const { pluginId, priority, source } = normalizeListenerOptions(options);
    this.listenerCounter += 1;
    this.listenerMaxOrder = this.listenerCounter;
    return {
        listener,
        pluginId,
        priority,
        source,
        orderHint: this.listenerCounter,
    };
};

EventEmitter.prototype._getEventConfig = function (event) {
    const globalConfig = normalizeOrderConfig(globalThis.__stEventListenerOrderConfig || {});
    const localConfig = normalizeOrderConfig(this.orderConfig || {});
    return localConfig[event] || globalConfig[event] || { pluginOrder: [] };
};

EventEmitter.prototype._sortListeners = function (event, listeners) {
    const eventConfig = this._getEventConfig(event);
    const orderMap = new Map();
    normalizeOrderList(eventConfig.pluginOrder).forEach((pluginId, index) => {
        orderMap.set(pluginId, index);
    });

    return listeners.slice().sort((a, b) => {
        const aRank = a.pluginId && orderMap.has(a.pluginId) ? orderMap.get(a.pluginId) : Number.MAX_SAFE_INTEGER;
        const bRank = b.pluginId && orderMap.has(b.pluginId) ? orderMap.get(b.pluginId) : Number.MAX_SAFE_INTEGER;
        if (aRank !== bRank) {
            return aRank - bRank;
        }

        if (a.priority !== b.priority) {
            return b.priority - a.priority;
        }

        return Number(a.orderHint || 0) - Number(b.orderHint || 0);
    });
};

EventEmitter.prototype.setOrderConfig = function (orderConfig) {
    this.orderConfig = normalizeOrderConfig(orderConfig || {});
};

EventEmitter.prototype.getOrderConfig = function () {
    return normalizeOrderConfig(this.orderConfig || {});
};

EventEmitter.prototype.getListenersMeta = function (event) {
    const listeners = Array.isArray(this.events[event]) ? this.events[event] : [];
    return listeners.map((record, index) => ({
        index,
        pluginId: String(record.pluginId || ''),
        priority: Number(record.priority || 0),
        source: String(record.source || ''),
        orderHint: Number(record.orderHint || 0),
        listenerName: String(record.listener?.name || ''),
    }));
};

/**
 * Adds a listener to an event.
 * @param {string} event Event name
 * @param {function} listener Event listener
 * @returns
 */
EventEmitter.prototype.on = function (event, listener) {
    // Unknown event used by external libraries?
    if (event === undefined) {
        console.trace('EventEmitter: Cannot listen to undefined event');
        return;
    }

    if (typeof this.events[event] !== 'object') {
        this.events[event] = [];
    }

    const options = arguments.length >= 3 ? arguments[2] : null;
    const record = this._createListenerRecord(listener, options);
    this.events[event].push(record);

    if (this.autoFireAfterEmit.has(event) && this.autoFireLastArgs.has(event)) {
        listener.apply(this, this.autoFireLastArgs.get(event));
    }
};

/**
 * Makes the listener the last to be called when the event is emitted
 * @param {string} event Event name
 * @param {function} listener Event listener
 */
EventEmitter.prototype.makeLast = function (event, listener) {
    if (typeof this.events[event] !== 'object') {
        this.events[event] = [];
    }

    const events = this.events[event];
    const idx = events.findIndex(record => record.listener === listener);

    if (idx > -1) {
        const [record] = events.splice(idx, 1);
        this.listenerMaxOrder += 1;
        record.orderHint = this.listenerMaxOrder;
        events.push(record);
    } else {
        const record = this._createListenerRecord(listener);
        this.listenerMaxOrder += 1;
        record.orderHint = this.listenerMaxOrder;
        events.push(record);
    }

    if (this.autoFireAfterEmit.has(event) && this.autoFireLastArgs.has(event)) {
        listener.apply(this, this.autoFireLastArgs.get(event));
    }
}

/**
 * Makes the listener the first to be called when the event is emitted
 * @param {string} event Event name
 * @param {function} listener Event listener
 */
EventEmitter.prototype.makeFirst = function (event, listener) {
    if (typeof this.events[event] !== 'object') {
        this.events[event] = [];
    }

    const events = this.events[event];
    const idx = events.findIndex(record => record.listener === listener);

    if (idx > -1) {
        const [record] = events.splice(idx, 1);
        this.listenerMinOrder -= 1;
        record.orderHint = this.listenerMinOrder;
        events.unshift(record);
    } else {
        const record = this._createListenerRecord(listener);
        this.listenerMinOrder -= 1;
        record.orderHint = this.listenerMinOrder;
        events.unshift(record);
    }

    if (this.autoFireAfterEmit.has(event) && this.autoFireLastArgs.has(event)) {
        listener.apply(this, this.autoFireLastArgs.get(event));
    }
}

/**
 * Removes a listener from an event.
 * @param {string} event Event name
 * @param {function} listener Event listener
 */
EventEmitter.prototype.removeListener = function (event, listener) {
    var idx;

    if (typeof this.events[event] === 'object') {
        idx = this.events[event].findIndex(record => record.listener === listener);

        if (idx > -1) {
            this.events[event].splice(idx, 1);
        }
    }
};

/**
 * Emits an event with optional arguments.
 * @param {string} event Event name
 */
EventEmitter.prototype.emit = async function (event) {
    let args = [].slice.call(arguments, 1);
    if (localStorage.getItem('eventTracing') === 'true') {
        console.trace('Event emitted: ' + event, args);
    } else {
        console.debug('Event emitted: ' + event);
    }

    let i, listeners, length;

    if (typeof this.events[event] === 'object') {
        listeners = this._sortListeners(event, this.events[event]);
        length = listeners.length;

        for (i = 0; i < length; i++) {
            try {
                await listeners[i].listener.apply(this, args);
            }
            catch (err) {
                console.error(err);
                console.trace('Error in event listener');
            }
        }
    }

    if (this.autoFireAfterEmit.has(event)) {
        this.autoFireLastArgs.set(event, args);
    }
};

EventEmitter.prototype.emitAndWait = function (event) {
    let args = [].slice.call(arguments, 1);
    if (localStorage.getItem('eventTracing') === 'true') {
        console.trace('Event emitted: ' + event, args);
    } else {
        console.debug('Event emitted: ' + event);
    }

    let i, listeners, length;

    if (typeof this.events[event] === 'object') {
        listeners = this._sortListeners(event, this.events[event]);
        length = listeners.length;

        for (i = 0; i < length; i++) {
            try {
                listeners[i].listener.apply(this, args);
            }
            catch (err) {
                console.error(err);
                console.trace('Error in event listener');
            }
        }
    }

    if (this.autoFireAfterEmit.has(event)) {
        this.autoFireLastArgs.set(event, args);
    }
};

EventEmitter.prototype.once = function (event, listener) {
    this.on(event, function g() {
        this.removeListener(event, g);
        listener.apply(this, arguments);
    });
};

export { EventEmitter }
