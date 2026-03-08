# Luker Plugin/API Migration Guide

This guide is for extension authors migrating from legacy SillyTavern-style save flows to Luker’s patch-first, hook-first model.

## 1) Use Context Helpers First

In Luker, `getContext()` is the primary plugin surface. Prefer these helpers over direct endpoint calls.

Global object recommendation:

- Prefer `Luker.getContext()` in new plugins.
- `st.getContext()` / `SillyTavern.getContext()` are compatibility aliases and should be considered legacy naming.

### Chat/message persistence

- `appendChatMessages(messages)`
- `patchChatMessages(operations)`
- `saveChatMetadata(withMetadata?)`

### Chat-bound plugin state

- `getChatState(namespace, options?)`
- `patchChatState(namespace, operations, options?)`
- `deleteChatState(namespace, options?)`

### Prompt/world-info assembly

- `getActivePromptPresetEnvelope(options?)`
- `getActivePromptLayout(options?)`
- `formatPromptPresetEnvelope(envelope, options?)`
- `buildPresetAwarePromptMessages(options)`
- `simulateWorldInfoActivation(options?)`
- `buildWorldInfoChatInput(messages, includeNames?)`
- `buildWorldInfoGlobalScanData(type, overrides?)`

#### Detailed parameter reference

Function signatures:

```ts
getActivePromptPresetEnvelope({
  includeCharacterCard = true,
  api = context.mainApi,
  promptPresetName = '',          // alias of completionPresetName
  completionPresetName = '',
  contextPresetName = '',
  instructPresetName = '',
  syspromptPresetName = '',
  reasoningPresetName = '',
} = {})
```

- Returns a full envelope object containing:
  - `presetRefs`
  - `promptCore` (`completion/context/instruct/sysprompt/reasoning`)
  - `promptLayout`
  - `promptCatalog`
  - optional `characterCard` (when `includeCharacterCard=true`)

```ts
getActivePromptLayout(options = {})
```

- `options` uses the same fields as `getActivePromptPresetEnvelope`.
- Returns normalized prompt layout only (`envelope.promptLayout` normalized).

```ts
formatPromptPresetEnvelope(envelope?, { label = 'LUKER_PRESET_ENVELOPE' } = {})
```

- If `envelope` is omitted, Luker uses current active envelope.
- Returns:
  - `[[<label>]]`
  - JSON string of the envelope

```ts
buildPresetAwarePromptMessages({
  taskSystem = '',
  taskUser = '',
  messages = [],                  // [{ role, content }] preferred
  envelope = null,                // optional prebuilt envelope
  envelopeOptions = {},           // used when envelope is null
  promptPresetName = '',          // completion preset shortcut
  runtimeWorldInfo = null,        // optional WI override bundle
} = {})
```

- `messages` replaces only chat-history content in preset layout.
- `taskSystem` / `taskUser` are legacy compatibility fields and are only used when `messages` is empty.
- `runtimeWorldInfo` supports:
  - `worldInfoBefore: string`
  - `worldInfoAfter: string`
  - `worldInfoDepth: Array<{ depth: number, role: 'system'|'user'|'assistant'|number, entries: string[] }>`
  - `outletEntries: object`
  - `worldInfoExamples: any[]`
- Throws when prompt layout cannot produce a valid plugin message sequence.

```ts
simulateWorldInfoActivation({
  coreChat = [],                  // ChatMessage[] in chronological order
  maxContext = undefined,         // default: current context size
  dryRun = false,
  type = 'normal',                // normal/continue/regenerate/swipe/...
  chatForWI = undefined,          // optional prebuilt string[]
  includeNames = true,
  globalScanData = undefined,     // optional override object
} = {})
```

- Returns WI resolution + normalized request inputs:
  - `worldInfoString/worldInfoBefore/worldInfoAfter/worldInfoDepth/...`
  - `chatForWI`
  - `maxContext`
  - `globalScanData`

```ts
buildWorldInfoChatInput(messages, includeNames = true)
```

- `messages` should be chronological and use chat shape (`{ name, mes, ... }`).
- Returns reversed `string[]` for WI scanner.

```ts
buildWorldInfoGlobalScanData(type, overrides = {})
```

- `type` is generation trigger type.
- Base payload fields:
  - `personaDescription`
  - `characterDescription`
  - `characterPersonality`
  - `characterDepthPrompt`
  - `scenario`
  - `creatorNotes`
  - `trigger`
- `overrides` is merged last and can replace any of the fields above.

Behavior notes:

- `buildPresetAwarePromptMessages(options)` preserves active preset content outside chat-history and only replaces chat-history with your supplied message list.
- For popup/sidecar generation, run world-info simulation/finalization helpers before composing the final request body if you need the same world-info behavior as main chat generation.
- If your plugin composes request messages after `GENERATION_WORLD_INFO_FINALIZED`, depth-based world-info injections are preserved in the final payload.

#### Best practices

- Prefer `messages` over legacy `taskSystem/taskUser` in new code.
- For popup/sidecar generation, call `simulateWorldInfoActivation(...)` and pass its result into `runtimeWorldInfo` to keep WI behavior consistent with main generation.
- Keep chat inputs chronological before calling `buildWorldInfoChatInput(...)`.
- Use `envelopeOptions` / `promptPresetName` instead of manually reconstructing preset internals.

#### Minimal popup chain example (recommended)

```js
const context = Luker.getContext();

const wi = await context.simulateWorldInfoActivation({
  coreChat: popupMessages, // [{ name, is_user, is_system, mes }]
  type: 'normal',
  includeNames: true,
});

const requestMessages = context.buildPresetAwarePromptMessages({
  messages: popupMessages.map(m => ({
    role: m.is_user ? 'user' : (m.is_system ? 'system' : 'assistant'),
    content: m.mes,
  })),
  runtimeWorldInfo: {
    worldInfoBefore: wi.worldInfoBefore,
    worldInfoAfter: wi.worldInfoAfter,
    worldInfoDepth: wi.worldInfoDepth,
    outletEntries: wi.outletEntries,
    worldInfoExamples: wi.worldInfoExamples,
  },
});
```

### Regex runtime API (plugin-side)

For plugin-owned temporary regex rules, use the regex runtime provider API instead of writing into global/scoped/preset regex storage.

Module path:

```js
import {
  registerRegexProvider,
  unregisterRegexProvider,
  notifyRuntimeRegexScriptsChanged,
  regex_placement,
  substitute_find_regex,
} from '../regex/engine.js';
```

Function signatures:

```ts
registerRegexProvider(
  owner: string,
  provider: (options?: { allowedOnly?: boolean }) => RegexScript[] | null | undefined,
  options?: { reloadOnChange?: boolean }   // default: false
): void
```

- Registers an in-memory provider keyed by `owner`.
- Re-registering with the same `owner` replaces the previous provider.
- Runtime scripts are never persisted to settings/character/preset files.
- `reloadOnChange=true` dispatches a runtime event requesting chat reload.

```ts
unregisterRegexProvider(owner: string): void
```

- Removes the provider by `owner`.
- If the removed provider was registered with `reloadOnChange=true`, unregister also requests a reload via runtime event.

```ts
notifyRuntimeRegexScriptsChanged({ requestReload?: boolean } = {}): void
```

- Triggers `luker:regex-runtime-scripts-changed`.
- Use this when provider output depends on mutable plugin settings/state and the provider function itself does not change.
- Set `requestReload=true` only when your regex changes require immediate chat re-render.

```ts
getRegexScripts({ allowedOnly = false } = {}): RegexScript[]
getRuntimeRegexScripts({ allowedOnly = false } = {}): RegexScript[]
runRegexScript(script: RegexScript, raw: string, { characterOverride? } = {}): string
```

- `getRegexScripts(...)` returns persisted scripts + runtime provider scripts.
- `getRuntimeRegexScripts(...)` returns runtime provider scripts only (read-only/debug use).
- `runRegexScript(...)` executes one script against a string without mutating storage.

`RegexScript` fields (runtime provider output) follow `RegexScriptData` shape. Required/important fields:

- `scriptName: string` (required, non-empty)
- `findRegex: string` (e.g. `'/[\\s\\S]*/g'`)
- `replaceString: string`
- `placement: number[]` (use `regex_placement` enum)
- `disabled: boolean`
- Optional controls: `promptOnly`, `markdownOnly`, `runOnEdit`, `substituteRegex`, `trimStrings`, `minDepth`, `maxDepth`

Enums:

```ts
regex_placement = {
  MD_DISPLAY: 0,   // deprecated
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6,
}

substitute_find_regex = {
  NONE: 0,
  RAW: 1,
  ESCAPED: 2,
}
```

Minimal provider example:

```js
const OWNER = 'my-plugin:visible-window';

function buildRuntimeRegexScripts() {
  const n = Number(extension_settings.my_plugin?.visibleAssistantTurns ?? 0);
  if (n <= 0) return [];
  return [{
    id: `${OWNER}:mask`,
    scriptName: `My Plugin Visible Window (${n})`,
    findRegex: '/[\\s\\S]*/g',
    replaceString: '',
    trimStrings: [],
    placement: [regex_placement.USER_INPUT, regex_placement.AI_OUTPUT],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    runOnEdit: false,
    substituteRegex: substitute_find_regex.NONE,
    minDepth: n,
    maxDepth: 999999,
  }];
}

registerRegexProvider(OWNER, () => buildRuntimeRegexScripts(), { reloadOnChange: false });

// Later, when plugin settings changed:
notifyRuntimeRegexScriptsChanged({ requestReload: false });

// On plugin teardown:
unregisterRegexProvider(OWNER);
```

Best practices:

- Keep provider pure and deterministic from current plugin state.
- Use stable `owner` IDs and stable `scriptName` values.
- Prefer `reloadOnChange=false` unless UI rendering must update immediately.
- Prefer runtime providers for plugin-temporary behavior; use persisted regex storage only for user-managed rules.

### Lorebook/world info persistence

- `loadWorldInfo(name)`
- `saveWorldInfo(name, data, immediately?)` (patch-first RFC6902 persistence path)

## 2) Generation Hook Order (Recommended)

Register generation-time logic with:

- `context.eventSource.on(context.eventTypes.GENERATION_BEFORE_WORLD_INFO_SCAN, handler)`
- `context.eventSource.on(context.eventTypes.GENERATION_AFTER_WORLD_INFO_SCAN, handler)`
- `context.eventSource.on(context.eventTypes.GENERATION_WORLD_INFO_FINALIZED, handler)`
- `context.eventSource.on(context.eventTypes.GENERATION_BEFORE_API_REQUEST, handler)`

Lifecycle hooks:

- `GENERATION_STARTED`
- `GENERATION_STOPPED`
- `GENERATION_ENDED`

Chat lifecycle hooks commonly used by plugins:

- `CHAT_CHANGED`
- `CHAT_CREATED`
- `GROUP_CHAT_CREATED`
- `CHAT_BRANCH_CREATED`

`CHAT_BRANCH_CREATED` is emitted after the new branch chat file is saved and before the UI switches into that branch. This is intended for chat-bound plugin state that needs to be copied or truncated for the new branch.

Payload shape:

```ts
{
  mesId: number,                  // branch point message index in source chat
  branchName: string,             // new branch chat id / file name
  assistantMessageCount: number,  // assistant turns included in the branch
  sourceTarget: {
    is_group: boolean,
    id?: string,                  // group chat id when is_group=true
    avatar_url?: string,          // character avatar when is_group=false
    file_name?: string,           // source character chat id when is_group=false
  },
  targetTarget: {
    is_group: boolean,
    id?: string,
    avatar_url?: string,
    file_name?: string,
  },
}
```

Practical rule:
- If your plugin stores chat-bound sidecar state and branch semantics depend on the cutoff point, use `CHAT_BRANCH_CREATED` to create the derived branch state instead of blindly copying the latest source state.

Practical rule:
- If you need to read/update lorebook-triggered context for this request, do it at `GENERATION_WORLD_INFO_FINALIZED`.

### Popup generation pattern (Recommended)

- Build popup-local messages first.
- Build preset-aware request messages with `buildPresetAwarePromptMessages(...)`.
- Run world-info simulation/finalization helpers or generation hooks in the same order as main generation.
- Send the final full `messages` array to your generation route.
- Do not manually strip world-info `before/after` sections from the assembled output.

## 3) Migration Rules

- Do not full-save entire chats after every tiny mutation.
- Use message patch ops for edit/delete/insert behavior.
- Use metadata patching for lightweight per-chat state.
- Use chat state sidecar for larger plugin objects.
- For app/global settings, prefer `saveSettings()` / `saveSettingsDebounced()` (Luker now routes these through settings patch internally).
- For lorebook edits, prefer `saveWorldInfo(...)` so built-ins and extensions get patch-first persistence automatically.
- Prefer context helpers to preserve compatibility and future internal changes.

## 4) Generation Resilience

Luker generation routes attach backend generation IDs (`x-luker-generation-id`) and use backend-owned job state, so reply persistence is decoupled from frontend connection stability.

This behavior is not limited to a single model provider route.

## 5) Legacy Compatibility

Legacy full-save routes are still available for compatibility:

- `/api/chats/save`
- `/api/chats/group/save`
- `/api/settings/save`

Luker internals and built-ins are patch-first; full-save is legacy compatibility, not the preferred path.

## 6) Endpoint Appendix (Only When You Need Direct Calls)

Most plugins should not call these directly, but they are listed for low-level integrations.

### Character chat

- `POST /api/chats/append`
- `POST /api/chats/patch`
- `POST /api/chats/meta/patch`
- `POST /api/chats/get-delta`

### Group chat

- `POST /api/chats/group/append`
- `POST /api/chats/group/patch`
- `POST /api/chats/group/meta/patch`
- `POST /api/chats/group/get-delta`

### Chat state sidecar

- `POST /api/chats/state/get`
- `POST /api/chats/state/patch`
- `POST /api/chats/state/delete`

### Settings

- `POST /api/settings/patch`

### World info

- `POST /api/worldinfo/patch`

### Message patch operation format

Message patch routes now use RFC6902 operations against the message array root:

- `add` (insert message): `{ "op": "add", "path": "/2", "value": { ...message } }`
- `replace` (edit message): `{ "op": "replace", "path": "/5", "value": { ...message } }`
- `remove` (delete message): `{ "op": "remove", "path": "/3" }`
- `test` (recommended guard): `{ "op": "test", "path": "/5", "value": { ...expectedMessage } }`

Legacy custom message ops (`insert/update/delete/insert_many/update_many/delete_range/batch`) are no longer supported.

### Object patch format (`meta/patch`, `state/patch`, `settings/patch`, `worldinfo/patch`)

Object patch routes use RFC6902-style operations:

- `add`
- `remove`
- `replace`
- `test` (recommended guard)

Path uses JSON Pointer string format:

```json
{ "op": "replace", "path": "/extensions/memory/last_capsule", "value": { "ok": true } }
```

Luker context helpers auto-attach lightweight `test` guards on patch-first paths.

### Patch conflict and integrity semantics

- `409 Conflict` means patch preconditions failed (for example: stale state, `test` mismatch, or integrity mismatch).
- Treat `409` as recoverable: refresh latest state/delta, rebuild operations, then retry.
- `500` indicates server-side failure and should not be used as a normal patch-conflict response.
- Prefer context helpers so guard/integrity behavior stays aligned with Luker internals.

#### Low-level retry pattern (if you must call endpoints directly)

```js
async function patchWithRetry(buildRequestBody, fetchPatch, fetchLatest, maxRetries = 1) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const latest = await fetchLatest();
    const body = buildRequestBody(latest);
    const res = await fetchPatch(body);
    if (res.ok) return true;
    if (res.status !== 409) return false;
  }
  return false;
}
```

### Chat-completions request body

For generation requests, send the full `messages` array in the request body.

### Connection profile resolution (recommended for plugins)

If your plugin supports selecting a Connection Manager profile, do not manually map profile fields (`api`, `model`, `api-url`, `proxy`, `secret-id`, `function-calling-plain-text`) to request payload keys.

Use shared resolver:

- `public/scripts/extensions/connection-manager/profile-resolver.js`
- `resolveChatCompletionRequestProfile({ profileName, defaultApi, defaultSource })`

Return values:

- `requestApi`: normalized API family to use in `buildPresetAwarePromptMessages(...)`
- `apiSettingsOverride`: normalized connection override object for `sendOpenAIRequest(...)`

This keeps plugin behavior aligned with core connection semantics and avoids drift when new connection fields are added.

### Shared function-call runtime for extensions

Luker now exposes a shared helper module for extension-side tool calling:

- `public/scripts/extensions/function-call-runtime.js`

Core request API now also supports mode switching:

- `sendOpenAIRequest(type, messages, signal, options?)`
- New options:
  - `functionCallMode`: `'native' | 'prompt_json'` (default `'native'`)
  - `functionCallOptions` (optional):
    - `requiredFunctionName?: string`
    - `strictTwoPart?: boolean` (default `true`)
    - `protocolStyle?: TOOL_PROTOCOL_STYLE.TABLE | TOOL_PROTOCOL_STYLE.JSON_SCHEMA`
    - `allowReasoningText?: boolean`
    - `appendStrictContract?: boolean` (default `true`)
    - `triggerSignal?: string` (auto-generated when omitted)

Behavior:

- `functionCallMode='native'`:
  - Uses normal `tools/tool_choice` flow.
  - If resolved request settings include `function_calling_plain_text=true`, runtime auto-upgrades to `prompt_json` mode (applies to both chat and extension-internal requests).
- `functionCallMode='prompt_json'`:
  - Core injects plain-text tool protocol prompts automatically.
  - Core disables native tool payload for that request (`tools=[]` override) to avoid mixed modes.
  - Core parses model text response as JSON tool-calls and normalizes it to `choices[0].message.tool_calls`.
  - If model output has no trigger signal / no tool-call payload, core returns `tool_calls=[]` and leaves policy decisions to the caller/plugin.
  - If trigger signal appears but tool-call JSON is invalid/unparseable, core throws request error.
  - Plugins can keep using `extractAllFunctionCalls(...)` as if it were native output.

Retry responsibility:

- `sendOpenAIRequest(...)` does **not** perform implicit retry loops for function-calling.
- Retry policy (if needed) is owned by the caller/plugin, including max attempts and retry conditions.

Recommended runtime exports (for custom parsing/contracts when needed):

- `buildPlainTextToolProtocolMessage(tools, options?)`
- `buildStrictThoughtAndFunctionOnlyAddendum(options?)`
- `mergeUserAddendumIntoPromptMessages(messages, addendum, tagOptions?)`
- `extractFunctionCallArguments(responseData, functionName)`
- `extractAllFunctionCalls(responseData, allowedNames?)`
- `extractAllFunctionCallsFromText(responseData, allowedNames?)`
- `extractToolCallsFromResponse(responseData, allowedNames?)` (lenient)
- `extractToolCallsFromTextResponse(responseData, allowedNames?)` (lenient)
- `extractDisplayTextFromPlainTextFunctionResponse(rawText)`
- `getResponseMessageContent(responseData)`

Protocol styles:

- `TOOL_PROTOCOL_STYLE.TABLE` (compact function table)
- `TOOL_PROTOCOL_STYLE.JSON_SCHEMA` (function + JSON schema list)

Practical rules:

- Prefer `sendOpenAIRequest(..., { functionCallMode })` over manually injecting/parsing in each plugin.
- Prefer native tool-calling where available.
- Keep plain-text mode (`prompt_json`) as fallback and enforce strict output contract.
- Use shared helpers instead of per-plugin parser copies to avoid drift.

### `secret_id` request override (chat-completions)

Luker supports an optional `secret_id` in chat-completions requests:

- `POST /api/backends/chat-completions/generate`
- `POST /api/backends/chat-completions/status`

Behavior:

- If `secret_id` is provided and valid for the selected provider key, backend uses that secret for this request.
- If missing/invalid, backend falls back to the provider's currently active secret.

Notes:

- Plugins should prefer profile resolver output over constructing `secret_id` manually.
- This is request-scoped override behavior; it does not rotate or mutate active secret selection globally.
