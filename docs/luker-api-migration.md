# Luker API Additions and Migration Guide

This document summarizes the Luker API changes on top of SillyTavern and shows how extension authors should migrate to incremental, chat-bound APIs.

## Goals

- Avoid repeated full chat uploads for save/edit/delete.
- Keep plugin state chat-bound, patchable, and lightweight.
- Make generation persistence/recovery backend-owned.
- Keep legacy `/save` style APIs available for compatibility.

## Recommended Migration (TL;DR)

1. Stop calling full-save endpoints for every change.
2. Use incremental message APIs (`append` / `patch`) for chat content.
3. Use metadata patch APIs for `chat_metadata` changes.
4. Use chat state sidecar APIs for large plugin state objects.
5. For OpenAI chat-completion requests, use prompt delta + persisted job APIs when reconnect recovery matters.

## Incremental Chat APIs

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

### Message patch operation format

Base operations:

- `insert`: `{ "op": "insert", "index": number, "message": {...} }`
- `update`: `{ "op": "update", "index": number, "message": {...} }`
- `delete`: `{ "op": "delete", "index": number }`

Batch/range helpers (server-normalized into base ops):

- `insert_many`: `{ "op": "insert_many", "index": number, "messages": [{...}, ...] }`
- `update_many`: `{ "op": "update_many", "index": number, "messages": [{...}, ...] }`
- `delete_range`: `{ "op": "delete_range", "index": number, "count": number }`
- `batch`: `{ "op": "batch", "operations": [ ... ] }`

Notes:

- `index` is zero-based over message rows (header excluded).
- `chat_metadata` can be included alongside patch/append payloads.

## Metadata/Object Patch Semantics

`/meta/patch` and `/state/patch` use object patch ops:

- `replace_root`
- `set`
- `merge`
- `delete`

Paths are array-based and safe-segment validated:

- Example: `{ "op": "set", "path": ["extensions", "memory", "last_capsule"], "value": {...} }`

## Chat-Bound Plugin State (Sidecar)

For plugin data that is too heavy for frequent full metadata writes, use:

- `POST /api/chats/state/get`
- `POST /api/chats/state/patch`
- `POST /api/chats/state/delete`

Payload target:

- Character chat: `{ is_group: false, avatar_url, file_name, namespace }`
- Group chat: `{ is_group: true, id, namespace }`

Behavior:

- Sidecar state is tied to the chat lifecycle.
- Rename/delete operations move/remove sidecar files with the chat.

## Frontend Helper APIs (Preferred for Extensions)

From `getContext()` in `public/scripts/st-context.js`:

- `appendChatMessages(messages)`
- `patchChatMessages(operations)`
- `saveChatMetadata(withMetadata?)`
- `getChatState(namespace, options?)`
- `patchChatState(namespace, operations, options?)`
- `deleteChatState(namespace, options?)`
- `simulateWorldInfoActivation(options?)`
- `buildPresetAwarePromptMessages(options?)`

These helpers already target Luker incremental endpoints and preserve compatibility behavior.

## Prompt-Preset-Aware Plugin Message Assembly

Use `buildPresetAwarePromptMessages()` to construct plugin request messages using current prompt preset structure.

`plugin_extra` prompts are excluded from plugin message assembly by design.

This lets plugins reuse the active preset skeleton while injecting their own runtime `messages`.

## Generation Persistence and Reconnect Recovery

For OpenAI chat-completions generation:

- Request supports `persist_target` for backend-owned message persistence.
- Request supports prompt delta via:
  - `luker_prompt_state_id`
  - `luker_prompt_delta` (`state_id`, `base_revision`, `prefix_length`, `messages`)
- Active/recovery endpoints:
  - `POST /api/backends/chat-completions/jobs/active`
  - `POST /api/backends/chat-completions/jobs/status`
  - `POST /api/backends/chat-completions/jobs/events`

Streaming responses expose `x-luker-generation-id` so the frontend can resume status/events after reconnect.

## Legacy Compatibility

Legacy full-save routes are still available:

- `/api/chats/save`
- `/api/chats/group/save`

Luker core now prefers patch/append/meta patch paths internally and only falls back to full save when necessary.

## Minimal Migration Examples

### Replace full chat save after edit

Before:

```js
await fetch('/api/chats/save', { method: 'POST', body: JSON.stringify(fullPayload) });
```

After:

```js
await context.patchChatMessages([
  { op: 'update', index: editedIndex, message: editedMessage },
]);
```

### Persist plugin state incrementally

```js
await context.patchChatState('my_plugin', [
  { op: 'set', path: ['graph', 'lastRecall'], value: recallResult },
  { op: 'merge', path: ['stats'], value: { updatedAt: Date.now() } },
]);
```

### Save only metadata diff

```js
await context.saveChatMetadata({
  my_plugin_last_capsule: capsule,
});
```
