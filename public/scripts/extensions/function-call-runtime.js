// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
// Implementation source: Toolify: Empower any LLM with function calling capabilities. (https://github.com/funnycups/Toolify)

const RANDOM_SIGNAL_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const DEFAULT_REASONING_TAGS = Object.freeze(['thought', 'think']);

function normalizeReasoningTagNames(tagNameOrList) {
    if (Array.isArray(tagNameOrList)) {
        const names = tagNameOrList
            .map(item => String(item || '').trim().toLowerCase())
            .filter(Boolean);
        return names.length > 0 ? [...new Set(names)] : [...DEFAULT_REASONING_TAGS];
    }
    const single = String(tagNameOrList || '').trim().toLowerCase();
    if (!single) {
        return [...DEFAULT_REASONING_TAGS];
    }
    return [...new Set([single])];
}

function stripSingleTagBlocks(source, tagName) {
    const openTag = `<${tagName}>`;
    const closeTag = `</${tagName}>`;
    if (!source || !source.includes(openTag)) {
        return source;
    }

    let output = '';
    let index = 0;
    let depth = 0;

    while (index < source.length) {
        if (source.startsWith(openTag, index)) {
            depth += 1;
            index += openTag.length;
            continue;
        }
        if (source.startsWith(closeTag, index)) {
            if (depth > 0) {
                depth -= 1;
            } else {
                output += closeTag;
            }
            index += closeTag.length;
            continue;
        }
        if (depth === 0) {
            output += source[index];
        }
        index += 1;
    }

    return output;
}

export const TOOL_PROTOCOL_STYLE = Object.freeze({
    TABLE: 'table',
    JSON_SCHEMA: 'json_schema',
});

function normalizeAllowedNameSet(allowedNames = null) {
    if (allowedNames instanceof Set) {
        return allowedNames;
    }
    if (Array.isArray(allowedNames)) {
        return new Set(allowedNames.map(name => String(name || '').trim()).filter(Boolean));
    }
    return null;
}

function normalizeTools(tools = []) {
    return Array.isArray(tools) ? tools : [];
}

function normalizeToolName(name) {
    return String(name || '').trim();
}

function normalizeSchemaFromTool(tool) {
    const schema = tool?.function?.parameters;
    return schema && typeof schema === 'object' ? schema : { type: 'object', additionalProperties: true };
}

function isLikelySsePayload(text) {
    const source = String(text || '');
    return source.includes('\ndata:') || source.startsWith('data:');
}

function extractSseTextContent(raw) {
    const source = String(raw || '');
    if (!source.trim() || !isLikelySsePayload(source)) {
        return source.trim();
    }
    const lines = source.split(/\r?\n/);
    let out = '';
    for (const line of lines) {
        if (!line.startsWith('data:')) {
            continue;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') {
            continue;
        }
        try {
            const parsed = JSON.parse(payload);
            const text =
                parsed?.choices?.[0]?.delta?.content
                ?? parsed?.choices?.[0]?.message?.content
                ?? parsed?.choices?.[0]?.text
                ?? parsed?.delta?.text
                ?? parsed?.delta?.content
                ?? parsed?.candidates?.[0]?.content?.parts?.map(x => x?.text || '').join('')
                ?? '';
            out += String(text || '');
        } catch {
            continue;
        }
    }
    return out.trim();
}

function extractTextFromContentNode(node) {
    if (typeof node === 'string') {
        return node;
    }
    if (Array.isArray(node)) {
        return node.map(item => extractTextFromContentNode(item)).filter(Boolean).join('');
    }
    if (!node || typeof node !== 'object') {
        return '';
    }
    if (typeof node.text === 'string') {
        return node.text;
    }
    if (typeof node.content === 'string' || Array.isArray(node.content) || (node.content && typeof node.content === 'object')) {
        const contentText = extractTextFromContentNode(node.content);
        if (contentText) {
            return contentText;
        }
    }
    if (Array.isArray(node.parts)) {
        const partsText = node.parts.map(part => extractTextFromContentNode(part)).filter(Boolean).join('');
        if (partsText) {
            return partsText;
        }
    }
    if (Array.isArray(node.thinking)) {
        const thinkingText = node.thinking.map(part => extractTextFromContentNode(part)).filter(Boolean).join('');
        if (thinkingText) {
            return thinkingText;
        }
    }
    if (node.delta && typeof node.delta === 'object') {
        const deltaText = extractTextFromContentNode(node.delta);
        if (deltaText) {
            return deltaText;
        }
    }
    return '';
}

export function generateRandomTriggerSignal() {
    let suffix = '';
    for (let i = 0; i < 4; i += 1) {
        suffix += RANDOM_SIGNAL_CHARS[Math.floor(Math.random() * RANDOM_SIGNAL_CHARS.length)];
    }
    return `<Function_${suffix}_Start/>`;
}

export function stripThoughtBlocks(text, tagName = DEFAULT_REASONING_TAGS) {
    const source = String(text || '');
    const reasoningTags = normalizeReasoningTagNames(tagName);
    let output = source;
    for (const currentTagName of reasoningTags) {
        output = stripSingleTagBlocks(output, currentTagName);
    }
    return output;
}

export function findLastTriggerSignalOutsideThought(text, triggerSignal) {
    const source = String(text || '');
    const signal = String(triggerSignal || '').trim();
    if (!source || !signal) {
        return -1;
    }

    let index = 0;
    let depth = 0;
    let lastPos = -1;
    const openTags = DEFAULT_REASONING_TAGS.map(tag => `<${tag}>`);
    const closeTags = DEFAULT_REASONING_TAGS.map(tag => `</${tag}>`);

    while (index < source.length) {
        let matched = false;
        for (const openTag of openTags) {
            if (source.startsWith(openTag, index)) {
                depth += 1;
                index += openTag.length;
                matched = true;
                break;
            }
        }
        if (matched) {
            continue;
        }
        for (const closeTag of closeTags) {
            if (source.startsWith(closeTag, index)) {
                depth = Math.max(0, depth - 1);
                index += closeTag.length;
                matched = true;
                break;
            }
        }
        if (matched) {
            continue;
        }
        if (depth === 0 && source.startsWith(signal, index)) {
            lastPos = index;
            index += signal.length;
            continue;
        }
        index += 1;
    }
    return lastPos;
}

export function getResponseMessageContent(responseData) {
    if (typeof responseData === 'string') {
        return extractSseTextContent(responseData);
    }
    if (responseData && typeof responseData === 'object') {
        const choice = responseData?.choices?.[0];
        const direct = choice?.message?.content;
        const directText = extractTextFromContentNode(direct);
        if (typeof directText === 'string' && directText.trim()) {
            return directText.trim();
        }
        const choiceText = extractTextFromContentNode(choice?.text);
        if (typeof choiceText === 'string' && choiceText.trim()) {
            return choiceText.trim();
        }
        const candidateText = extractTextFromContentNode(responseData?.candidates?.[0]?.content);
        if (typeof candidateText === 'string' && candidateText.trim()) {
            return candidateText.trim();
        }
        const altRaw = responseData?.content ?? responseData?.raw_text ?? responseData?.sse_text ?? '';
        const alt = typeof altRaw === 'string' ? altRaw : extractTextFromContentNode(altRaw);
        if (typeof alt === 'string' && alt.trim()) {
            return extractSseTextContent(alt);
        }
    }
    return '';
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

export function collectJsonPayloadCandidates(text) {
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

function parseFunctionCallsFromJsonText(source, allowSet = null) {
    const candidates = collectJsonPayloadCandidates(source);
    let lastError = null;
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            const rawCalls = normalizeTextToolCallsPayload(parsed);
            if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
                continue;
            }
            const calls = [];
            for (const item of rawCalls) {
                const name = normalizeToolName(item?.name || item?.function?.name);
                if (!name) {
                    continue;
                }
                if (allowSet && !allowSet.has(name)) {
                    continue;
                }
                const rawArgs = item?.arguments ?? item?.args ?? item?.function?.arguments;
                calls.push({
                    id: String(item?.id || ''),
                    name,
                    args: coerceToolCallArgumentsObject(rawArgs, name),
                });
            }
            if (calls.length > 0) {
                return calls;
            }
        } catch (error) {
            lastError = error;
        }
    }
    if (lastError) {
        throw lastError;
    }
    return [];
}

export function extractAllFunctionCalls(responseData, allowedNames = null) {
    const toolCalls = responseData?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        throw new Error('Model did not return any tool call.');
    }

    const allowSet = normalizeAllowedNameSet(allowedNames);
    const parsedCalls = [];
    for (const call of toolCalls) {
        const fnName = normalizeToolName(call?.function?.name);
        if (!fnName) {
            continue;
        }
        if (allowSet && !allowSet.has(fnName)) {
            continue;
        }
        const argsText = call?.function?.arguments;
        if (typeof argsText !== 'string' || !argsText.trim()) {
            throw new Error(`Tool call '${fnName}' arguments are empty.`);
        }
        try {
            parsedCalls.push({
                id: String(call?.id || ''),
                name: fnName,
                args: JSON.parse(argsText),
            });
        } catch {
            throw new Error(`Tool call '${fnName}' arguments are not valid JSON.`);
        }
    }
    if (parsedCalls.length === 0) {
        throw new Error('Model returned tool calls, but none matched expected function names.');
    }
    return parsedCalls;
}

export function extractFunctionCallArguments(responseData, functionName) {
    const expectedName = normalizeToolName(functionName);
    if (!expectedName) {
        throw new Error('Function name is required.');
    }
    const calls = extractAllFunctionCalls(responseData, [expectedName]);
    const matchedCall = calls.find(call => normalizeToolName(call?.name) === expectedName);
    if (!matchedCall) {
        throw new Error(`Model returned tool call, but not '${expectedName}'.`);
    }
    return matchedCall.args;
}

export function extractToolCallsFromResponse(responseData, allowedNames = null) {
    try {
        return extractAllFunctionCalls(responseData, allowedNames).map(call => ({
            name: call.name,
            args: call.args,
        }));
    } catch {
        return [];
    }
}

export function extractAllFunctionCallsFromText(responseData, allowedNames = null, options = null) {
    const content = getResponseMessageContent(responseData);
    if (!content) {
        throw new Error('Model returned empty text response.');
    }

    const opts = options && typeof options === 'object' ? options : {};
    const triggerSignal = String(opts.triggerSignal || '').trim();
    const triggerRequired = Boolean(opts.triggerRequired);
    const allowSet = normalizeAllowedNameSet(allowedNames);

    const parseScopes = [];
    const triggerPos = triggerSignal ? findLastTriggerSignalOutsideThought(content, triggerSignal) : -1;
    if (triggerSignal && triggerPos >= 0) {
        const afterTrigger = content.slice(triggerPos + triggerSignal.length).trim();
        if (afterTrigger) {
            parseScopes.push(afterTrigger);
        }
    } else if (triggerSignal && triggerRequired) {
        throw new Error('Model text output did not include the required trigger signal.');
    }

    const strippedThought = stripThoughtBlocks(content).trim();
    if (strippedThought) {
        parseScopes.push(strippedThought);
    }
    parseScopes.push(content);

    const uniqueScopes = [...new Set(parseScopes.filter(Boolean))];
    let lastError = null;

    for (const scope of uniqueScopes) {
        try {
            const jsonCalls = parseFunctionCallsFromJsonText(scope, allowSet);
            if (jsonCalls.length > 0) {
                return jsonCalls;
            }
        } catch (error) {
            lastError = error;
        }
    }

    if (lastError) {
        throw lastError;
    }
    throw new Error('Model text output did not contain parseable function calls JSON.');
}

export function extractToolCallsFromTextResponse(responseData, allowedNames = null, options = null) {
    try {
        return extractAllFunctionCallsFromText(responseData, allowedNames, options).map(call => ({
            name: call.name,
            args: call.args,
        }));
    } catch {
        return [];
    }
}

export function extractDisplayTextFromPlainTextFunctionResponse(rawText, options = null) {
    const source = String(rawText || '').trim();
    if (!source) {
        return '';
    }

    const opts = options && typeof options === 'object' ? options : {};
    const triggerSignal = String(opts.triggerSignal || '').trim();
    if (triggerSignal) {
        const triggerPos = findLastTriggerSignalOutsideThought(source, triggerSignal);
        if (triggerPos >= 0) {
            return source.slice(0, triggerPos).trim();
        }
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

function buildToolRows(tools) {
    const normalizedTools = normalizeTools(tools);
    return normalizedTools.map((tool) => {
        const name = normalizeToolName(tool?.function?.name);
        if (!name) {
            return null;
        }
        const description = String(tool?.function?.description || '').replace(/\s+/g, ' ').trim();
        const schema = normalizeSchemaFromTool(tool);
        const properties = schema?.properties && typeof schema.properties === 'object'
            ? Object.keys(schema.properties)
            : [];
        const required = Array.isArray(schema?.required)
            ? schema.required.map(field => String(field || '').trim()).filter(Boolean)
            : [];
        const optional = properties.filter(field => !required.includes(field));
        return {
            name,
            description,
            required,
            optional,
            schema,
        };
    }).filter(Boolean);
}

export function buildToolChoiceConstraintAddendum(toolChoice = 'auto', tools = []) {
    if (toolChoice === null || toolChoice === undefined || toolChoice === 'auto') {
        return '';
    }
    if (toolChoice === 'none') {
        return 'Tool-choice constraint: do NOT call any tool in this response.';
    }
    if (toolChoice === 'required') {
        return 'Tool-choice constraint: you MUST call at least one allowed tool in this response.';
    }

    const selectedName = normalizeToolName(
        toolChoice?.function?.name
        || (typeof toolChoice === 'object' ? toolChoice?.name : ''),
    );
    if (!selectedName) {
        return '';
    }
    const availableNames = new Set(buildToolRows(tools).map(tool => tool.name));
    if (availableNames.size > 0 && !availableNames.has(selectedName)) {
        return `Tool-choice constraint: requested tool '${selectedName}' is unavailable. Use only allowed tools.`;
    }
    return `Tool-choice constraint: call ONLY tool '${selectedName}' in this response.`;
}

export function buildPlainTextToolProtocolMessage(
    tools = [],
    {
        requiredFunctionName = '',
        style = TOOL_PROTOCOL_STYLE.TABLE,
        allowReasoningText = false,
        strictTwoPart = false,
        triggerSignal = '',
        toolChoice = 'auto',
    } = {},
) {
    const requiredName = normalizeToolName(requiredFunctionName);
    const rows = buildToolRows(tools);
    const requiredLine = requiredName
        ? `Required function name for this response: ${requiredName}.`
        : '';
    const trigger = String(triggerSignal || '').trim();
    const triggerLine = trigger
        ? `When starting tool calls, output this line exactly on its own line first: ${trigger}`
        : '';
    const toolChoiceLine = buildToolChoiceConstraintAddendum(toolChoice, tools);

    if (style === TOOL_PROTOCOL_STYLE.JSON_SCHEMA) {
        const schemaGuide = rows.map((row) => ({
            name: row.name,
            description: row.description,
            parameters: row.schema,
        }));
        return [
            'Plain-text function-call mode is enabled.',
            allowReasoningText
                ? 'You may output reasoning text (for example <thought>...</thought>) before the final JSON payload.'
                : 'Output contract is strict.',
            strictTwoPart
                ? 'Return exactly two parts in order: (1) one <thought>...</thought>; (2) one and only one JSON object: {"tool_calls":[{"name":"FUNCTION_NAME","arguments":{...}}]}.'
                : 'The final output must end with one JSON object: {"tool_calls":[{"name":"FUNCTION_NAME","arguments":{...}}]}',
            strictTwoPart
                ? 'No narrative/body text, markdown, code fences, comments, XML blocks (except <thought>), or extra JSON before/after the JSON object.'
                : '',
            triggerLine,
            requiredLine,
            toolChoiceLine,
            `Allowed functions and JSON argument schemas: ${JSON.stringify(schemaGuide)}`,
        ].filter(Boolean).join('\n');
    }

    const tableHeader = '| Function | Required args | Optional args | Purpose |\n|---|---|---|---|';
    const tableRows = rows.map(item => {
        const required = item.required.length > 0 ? item.required.join(', ') : '-';
        const optional = item.optional.length > 0 ? item.optional.join(', ') : '-';
        const purpose = item.description || '-';
        return `| ${item.name} | ${required} | ${optional} | ${purpose} |`;
    });
    return [
        'Plain-text function-call mode is enabled.',
        'Do necessary reasoning following the current prompt policy, then output function-call payload only.',
        'Do not output extra prose outside the required payload.',
        'The final output must end with one JSON object: {"tool_calls":[{"name":"FUNCTION_NAME","arguments":{...}}]}',
        triggerLine,
        requiredLine,
        toolChoiceLine,
        'Allowed functions:',
        tableHeader,
        ...tableRows,
    ].filter(Boolean).join('\n');
}

export function buildStrictThoughtAndFunctionOnlyAddendum({ plainTextMode = false, requiredFunctionName = '' } = {}) {
    const requiredName = normalizeToolName(requiredFunctionName);
    return [
        'HIGHEST PRIORITY OUTPUT CONTRACT:',
        'You must return EXACTLY two parts in this order:',
        '1) one <thought>...</thought> block.',
        plainTextMode
            ? '2) exactly one JSON object for function calls: {"tool_calls":[...]}'
            : '2) function calls only (tool-calls channel).',
        requiredName ? `Required function name: ${requiredName}.` : '',
        'Do NOT output any other text or blocks.',
        'Forbidden: narrative/body text, <maintext>, <overall>, <UpdateVariable>, <StatusPlaceHolderImpl/>, markdown, code fences, comments, duplicate JSON payloads.',
        'After function calls, stop immediately.',
    ].filter(Boolean).join('\n');
}

export function buildFunctionCallRetryAddendum({
    rawResponse = '',
    errorDetails = '',
    triggerSignal = '',
    requiredFunctionName = '',
    plainTextMode = true,
} = {}) {
    const preview = String(rawResponse || '').trim().slice(0, 2000);
    const error = String(errorDetails || 'Unknown parse error').trim();
    const required = normalizeToolName(requiredFunctionName);
    const trigger = String(triggerSignal || '').trim();

    return [
        'Your previous response attempted function calling but failed parsing/validation.',
        `Error details: ${error}`,
        preview ? `Previous response preview:\n\`\`\`\n${preview}\n\`\`\`` : '',
        'Retry now with strictly valid output only.',
        trigger ? `First line must be exactly: ${trigger}` : '',
        plainTextMode
            ? 'Then output exactly one JSON object: {"tool_calls":[{"name":"FUNCTION_NAME","arguments":{...}}]}'
            : 'Then output tool calls only.',
        required ? `Required function name: ${required}.` : '',
        'Do not output any extra prose after the function payload.',
    ].filter(Boolean).join('\n');
}

export function mergeUserAddendumIntoPromptMessages(promptMessages, addendumText, tagOptions = null) {
    const messages = Array.isArray(promptMessages)
        ? promptMessages.map(message => ({ ...message }))
        : [];
    const addendum = String(addendumText || '').trim();
    if (!addendum) {
        return messages;
    }
    const options = typeof tagOptions === 'string'
        ? { tagName: tagOptions, wrapWithTag: true }
        : (tagOptions && typeof tagOptions === 'object' ? tagOptions : {});
    const wrapWithTag = Boolean(options?.wrapWithTag);
    const tag = String(options?.tagName || '').trim() || 'function_call_protocol';
    const payload = wrapWithTag
        ? [`<${tag}>`, addendum, `</${tag}>`].join('\n')
        : addendum;

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
            content: base ? `${base}\n\n${payload}` : payload,
        };
        return messages;
    }

    messages.push({ role: 'user', content: payload });
    return messages;
}

function schemaTypeName(value) {
    if (value === null) return 'null';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    if (typeof value === 'string') return 'string';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return 'object';
    return typeof value;
}

function validateValueAgainstSchema(value, schema, path = 'args', depth = 0) {
    const safeSchema = schema && typeof schema === 'object' ? schema : {};
    const errors = [];
    if (depth > 8) {
        return errors;
    }

    if (Array.isArray(safeSchema.allOf)) {
        for (let index = 0; index < safeSchema.allOf.length; index += 1) {
            errors.push(...validateValueAgainstSchema(value, safeSchema.allOf[index], `${path}.allOf[${index}]`, depth + 1));
        }
        return errors;
    }

    if (Array.isArray(safeSchema.anyOf)) {
        const result = safeSchema.anyOf.map(item => validateValueAgainstSchema(value, item, path, depth + 1));
        if (!result.some(item => item.length === 0)) {
            errors.push(`${path}: value does not satisfy anyOf options`);
        }
        return errors;
    }

    if (Array.isArray(safeSchema.oneOf)) {
        const result = safeSchema.oneOf.map(item => validateValueAgainstSchema(value, item, path, depth + 1));
        const matchCount = result.filter(item => item.length === 0).length;
        if (matchCount !== 1) {
            errors.push(`${path}: value must satisfy exactly one oneOf option (matched ${matchCount})`);
        }
        return errors;
    }

    if (Object.hasOwn(safeSchema, 'const') && value !== safeSchema.const) {
        errors.push(`${path}: expected const=${JSON.stringify(safeSchema.const)}, got ${JSON.stringify(value)}`);
        return errors;
    }

    if (Array.isArray(safeSchema.enum) && !safeSchema.enum.includes(value)) {
        errors.push(`${path}: expected one of ${JSON.stringify(safeSchema.enum)}, got ${JSON.stringify(value)}`);
        return errors;
    }

    let expectedType = safeSchema.type;
    if (!expectedType && (safeSchema.properties || safeSchema.required || Object.hasOwn(safeSchema, 'additionalProperties'))) {
        expectedType = 'object';
    }

    const typeCheck = (typeName) => {
        if (typeName === 'object') return value && typeof value === 'object' && !Array.isArray(value);
        if (typeName === 'array') return Array.isArray(value);
        if (typeName === 'string') return typeof value === 'string';
        if (typeName === 'boolean') return typeof value === 'boolean';
        if (typeName === 'integer') return Number.isInteger(value);
        if (typeName === 'number') return typeof value === 'number';
        if (typeName === 'null') return value === null;
        return true;
    };

    if (typeof expectedType === 'string') {
        if (!typeCheck(expectedType)) {
            errors.push(`${path}: expected type '${expectedType}', got '${schemaTypeName(value)}'`);
            return errors;
        }
    } else if (Array.isArray(expectedType)) {
        if (!expectedType.some(typeName => typeCheck(typeName))) {
            errors.push(`${path}: expected type in ${JSON.stringify(expectedType)}, got '${schemaTypeName(value)}'`);
            return errors;
        }
    }

    if (typeof value === 'string') {
        if (Number.isInteger(safeSchema.minLength) && value.length < safeSchema.minLength) {
            errors.push(`${path}: string shorter than minLength=${safeSchema.minLength}`);
        }
        if (Number.isInteger(safeSchema.maxLength) && value.length > safeSchema.maxLength) {
            errors.push(`${path}: string longer than maxLength=${safeSchema.maxLength}`);
        }
        if (typeof safeSchema.pattern === 'string') {
            try {
                if (!new RegExp(safeSchema.pattern).test(value)) {
                    errors.push(`${path}: string does not match pattern ${safeSchema.pattern}`);
                }
            } catch {
                // Ignore invalid schema regex.
            }
        }
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const properties = safeSchema.properties && typeof safeSchema.properties === 'object'
            ? safeSchema.properties
            : {};
        const required = Array.isArray(safeSchema.required)
            ? safeSchema.required.filter(item => typeof item === 'string')
            : [];
        const additional = Object.hasOwn(safeSchema, 'additionalProperties')
            ? safeSchema.additionalProperties
            : true;

        for (const key of required) {
            if (!Object.hasOwn(value, key)) {
                errors.push(`${path}: missing required property '${key}'`);
            }
        }
        for (const [key, childValue] of Object.entries(value)) {
            if (Object.hasOwn(properties, key)) {
                errors.push(...validateValueAgainstSchema(childValue, properties[key], `${path}.${key}`, depth + 1));
                continue;
            }
            if (additional === false) {
                errors.push(`${path}: unexpected property '${key}'`);
                continue;
            }
            if (additional && typeof additional === 'object') {
                errors.push(...validateValueAgainstSchema(childValue, additional, `${path}.${key}`, depth + 1));
            }
        }
    }

    if (Array.isArray(value)) {
        if (Number.isInteger(safeSchema.minItems) && value.length < safeSchema.minItems) {
            errors.push(`${path}: array shorter than minItems=${safeSchema.minItems}`);
        }
        if (Number.isInteger(safeSchema.maxItems) && value.length > safeSchema.maxItems) {
            errors.push(`${path}: array longer than maxItems=${safeSchema.maxItems}`);
        }
        if (safeSchema.uniqueItems === true) {
            const seen = new Set(value.map(item => JSON.stringify(item)));
            if (seen.size !== value.length) {
                errors.push(`${path}: array contains duplicate items but uniqueItems=true`);
            }
        }
        if (safeSchema.items && typeof safeSchema.items === 'object') {
            for (let index = 0; index < value.length; index += 1) {
                errors.push(...validateValueAgainstSchema(value[index], safeSchema.items, `${path}[${index}]`, depth + 1));
            }
        }
    }

    return errors;
}

export function validateParsedToolCalls(parsedCalls = [], tools = []) {
    const safeTools = normalizeTools(tools);
    if (safeTools.length === 0) {
        return null;
    }
    const schemaByName = new Map();
    for (const tool of safeTools) {
        const name = normalizeToolName(tool?.function?.name);
        if (!name) {
            continue;
        }
        schemaByName.set(name, normalizeSchemaFromTool(tool));
    }
    if (schemaByName.size === 0) {
        return null;
    }

    const safeCalls = Array.isArray(parsedCalls) ? parsedCalls : [];
    for (let index = 0; index < safeCalls.length; index += 1) {
        const call = safeCalls[index] || {};
        const name = normalizeToolName(call.name);
        const args = call.args;

        if (!name) {
            return `Tool call #${index + 1}: missing tool name.`;
        }
        if (!schemaByName.has(name)) {
            return `Tool call #${index + 1}: unknown tool '${name}'.`;
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return `Tool call #${index + 1} '${name}': arguments must be a JSON object.`;
        }
        const schema = schemaByName.get(name) || {};
        const errors = validateValueAgainstSchema(args, schema, name);
        if (errors.length > 0) {
            return `Tool call #${index + 1} '${name}': schema validation failed: ${errors.slice(0, 6).join('; ')}`;
        }
    }

    return null;
}

export function buildToolCallIndexFromMessages(messages = []) {
    const index = {};
    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || typeof message !== 'object') {
            continue;
        }
        if (String(message.role || '') !== 'assistant') {
            continue;
        }
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        for (const call of toolCalls) {
            const id = String(call?.id || '').trim();
            const name = normalizeToolName(call?.function?.name);
            const args = call?.function?.arguments;
            if (!id || !name) {
                continue;
            }
            let argsText = '{}';
            if (typeof args === 'string') {
                argsText = args;
            } else if (args && typeof args === 'object') {
                try {
                    argsText = JSON.stringify(args);
                } catch {
                    argsText = String(args);
                }
            }
            index[id] = { name, arguments: argsText };
        }
    }
    return index;
}

export function formatToolResultForModel(toolName, toolArguments, resultContent, { resultTag = 'tool_result' } = {}) {
    return [
        'Tool execution result:',
        `- Tool name: ${String(toolName || '')}`,
        `- Tool arguments: ${String(toolArguments || '{}')}`,
        `- Execution result:`,
        `<${resultTag}>`,
        String(resultContent || ''),
        `</${resultTag}>`,
    ].join('\n');
}

export function normalizeToolResultMessagesForModel(messages = [], options = {}) {
    const toolResultTag = String(options?.resultTag || 'tool_result');
    const index = buildToolCallIndexFromMessages(messages);
    const output = [];
    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || typeof message !== 'object') {
            continue;
        }
        if (String(message.role || '') !== 'tool') {
            output.push({ ...message });
            continue;
        }
        const toolCallId = String(message.tool_call_id || '').trim();
        const toolInfo = index[toolCallId];
        if (!toolInfo) {
            output.push({ ...message });
            continue;
        }
        output.push({
            role: 'user',
            content: formatToolResultForModel(
                toolInfo.name,
                toolInfo.arguments,
                message.content ?? '',
                { resultTag: toolResultTag },
            ),
        });
    }
    return output;
}
