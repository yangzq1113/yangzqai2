// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

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

export function getResponseMessageContent(responseData) {
    return String(responseData?.choices?.[0]?.message?.content || '').trim();
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

export function extractAllFunctionCalls(responseData, allowedNames = null) {
    const toolCalls = responseData?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        throw new Error('Model did not return any tool call.');
    }

    const allowSet = normalizeAllowedNameSet(allowedNames);
    const parsedCalls = [];
    for (const call of toolCalls) {
        const fnName = String(call?.function?.name || '').trim();
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
    const expectedName = String(functionName || '').trim();
    if (!expectedName) {
        throw new Error('Function name is required.');
    }
    const calls = extractAllFunctionCalls(responseData, [expectedName]);
    const matchedCall = calls.find(call => String(call?.name || '') === expectedName);
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

export function extractAllFunctionCallsFromText(responseData, allowedNames = null) {
    const content = getResponseMessageContent(responseData);
    if (!content) {
        throw new Error('Model returned empty text response.');
    }
    const allowSet = normalizeAllowedNameSet(allowedNames);
    const candidates = collectJsonPayloadCandidates(content);
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
                const name = String(item?.name || item?.function?.name || '').trim();
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
    throw new Error('Model text output did not contain parseable function calls JSON.');
}

export function extractToolCallsFromTextResponse(responseData, allowedNames = null) {
    try {
        return extractAllFunctionCallsFromText(responseData, allowedNames).map(call => ({
            name: call.name,
            args: call.args,
        }));
    } catch {
        return [];
    }
}

export function extractDisplayTextFromPlainTextFunctionResponse(rawText) {
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

export function buildPlainTextToolProtocolMessage(
    tools = [],
    {
        requiredFunctionName = '',
        style = TOOL_PROTOCOL_STYLE.TABLE,
        allowReasoningText = false,
        strictTwoPart = false,
    } = {},
) {
    const requiredName = String(requiredFunctionName || '').trim();
    const normalizedTools = Array.isArray(tools) ? tools : [];
    const requiredLine = requiredName
        ? `Required function name for this response: ${requiredName}.`
        : '';

    if (style === TOOL_PROTOCOL_STYLE.JSON_SCHEMA) {
        const schemaGuide = normalizedTools.map((tool) => ({
            name: String(tool?.function?.name || ''),
            description: String(tool?.function?.description || ''),
            parameters: tool?.function?.parameters && typeof tool.function.parameters === 'object'
                ? tool.function.parameters
                : { type: 'object', additionalProperties: true },
        })).filter(item => item.name);
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
            requiredLine,
            `Allowed functions and JSON argument schemas: ${JSON.stringify(schemaGuide)}`,
        ].filter(Boolean).join('\n');
    }

    const toolRows = normalizedTools.map((tool) => {
        const name = String(tool?.function?.name || '').trim();
        if (!name) {
            return null;
        }
        const description = String(tool?.function?.description || '').replace(/\s+/g, ' ').trim();
        const params = tool?.function?.parameters && typeof tool.function.parameters === 'object'
            ? tool.function.parameters
            : {};
        const properties = params?.properties && typeof params.properties === 'object'
            ? Object.keys(params.properties)
            : [];
        const required = Array.isArray(params?.required)
            ? params.required.map(field => String(field || '').trim()).filter(Boolean)
            : [];
        const optional = properties.filter(field => !required.includes(field));
        return {
            name,
            description,
            required,
            optional,
        };
    }).filter(Boolean);
    const tableHeader = '| Function | Required args | Optional args | Purpose |\n|---|---|---|---|';
    const tableRows = toolRows.map(item => {
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
        requiredLine,
        'Allowed functions:',
        tableHeader,
        ...tableRows,
    ].filter(Boolean).join('\n');
}

export function buildStrictThoughtAndFunctionOnlyAddendum({ plainTextMode = false, requiredFunctionName = '' } = {}) {
    const requiredName = String(requiredFunctionName || '').trim();
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
