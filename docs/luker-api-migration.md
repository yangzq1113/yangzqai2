# Luker Plugin/API Migration Guide

This guide is for extension authors migrating from legacy SillyTavern-style save flows to Luker’s patch-first, hook-first model.

## 1) Use Context Helpers First

In Luker, `getContext()` is the primary plugin surface. Prefer these helpers over direct endpoint calls.

### Chat/message persistence

- `appendChatMessages(messages)`
- `patchChatMessages(operations)`
- `saveChatMetadata(withMetadata?)`

### Chat-bound plugin state

- `getChatState(namespace, options?)`
- `patchChatState(namespace, operations, options?)`
- `deleteChatState(namespace, options?)`

### Prompt/world-info assembly

- `buildPresetAwarePromptMessages(options)`
- `simulateWorldInfoActivation(options?)`

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

Practical rule:
- If you need to read/update lorebook-triggered context for this request, do it at `GENERATION_WORLD_INFO_FINALIZED`.

## 3) Migration Rules

- Do not full-save entire chats after every tiny mutation.
- Use message patch ops for edit/delete/insert behavior.
- Use metadata patching for lightweight per-chat state.
- Use chat state sidecar for larger plugin objects.
- Prefer context helpers to preserve compatibility and future internal changes.

## 4) Generation Resilience

Luker generation routes attach backend generation IDs (`x-luker-generation-id`) and use backend-owned job state, so reply persistence is decoupled from frontend connection stability.

This behavior is not limited to a single model provider route.

## 5) Legacy Compatibility

Legacy full-save routes are still available for compatibility:

- `/api/chats/save`
- `/api/chats/group/save`

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

### Message patch operation format

- `insert`: `{ "op": "insert", "index": number, "message": {...} }`
- `update`: `{ "op": "update", "index": number, "message": {...} }`
- `delete`: `{ "op": "delete", "index": number }`
- `insert_many`: `{ "op": "insert_many", "index": number, "messages": [{...}, ...] }`
- `update_many`: `{ "op": "update_many", "index": number, "messages": [{...}, ...] }`
- `delete_range`: `{ "op": "delete_range", "index": number, "count": number }`
- `batch`: `{ "op": "batch", "operations": [ ... ] }`

### Object patch format (`meta/patch` and `state/patch`)

- `replace_root`
- `set`
- `merge`
- `delete`

Path example:

```json
{ "op": "set", "path": ["extensions", "memory", "last_capsule"], "value": { "ok": true } }
```

### Prompt-delta fields (chat-completions)

- `luker_prompt_state_id`
- `luker_prompt_delta` with:
  - `state_id`
  - `base_revision`
  - `prefix_length`
  - `messages`
