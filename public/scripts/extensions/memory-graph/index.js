import { CONNECT_API_MAP, saveSettings, saveSettingsDebounced, buildObjectPatchOperations } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { chat_completion_sources, proxies, sendOpenAIRequest } from '../../openai.js';
import { newWorldInfoEntryTemplate } from '../../world-info.js';

const MODULE_NAME = 'memory_graph';
const CHAT_STATE_NAMESPACE = MODULE_NAME;
const UI_BLOCK_ID = 'memory_graph_settings';
const STYLE_ID = 'memory_graph_style';
const CHAT_LOREBOOK_METADATA_KEY = 'world_info';
const RUNTIME_LOREBOOK_COMMENT_PREFIX = 'MEMORY_GRAPH_RUNTIME';
const RECALL_ALLOWED_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe', 'impersonate']);
const CHARACTER_SCHEMA_OVERRIDE_KEY = 'schemaOverride';

const LEVEL = {
    SEMANTIC: 'semantic',
};

function isPlainTextFunctionCallModeEnabled(settings = null) {
    const currentSettings = settings && typeof settings === 'object' ? settings : getSettings();
    return Boolean(currentSettings?.plainTextFunctionCallMode);
}

const defaultNodeTypeSchema = [
    {
        id: 'event',
        label: 'Event',
        tableName: 'event_table',
        tableColumns: ['summary', 'status'],
        columnHints: {
            summary: 'Concise event abstraction with causality and outcome.',
            status: 'Event state such as resolved/ongoing/blocked.',
        },
        requiredColumns: ['summary'],
        forceUpdate: true,
        editable: false,
        level: LEVEL.SEMANTIC,
        extractHint: 'Critical plot events, turning points, commitments, betrayals, and irreversible outcomes.',
        keywords: ['battle', 'reveal', 'deal', 'betrayal', 'event', 'outcome'],
        alwaysInject: true,
        latestOnly: false,
        primaryKeyColumns: [],
        compression: {
            mode: 'hierarchical',
            threshold: 9,
            fanIn: 3,
            maxDepth: 10,
            keepRecentLeaves: 6,
            summarizeInstruction: 'Compress event nodes into high-value storyline milestones. Preserve causality, irreversible outcomes, and unresolved hooks. Keep each summary focused and compact, target within 150 Chinese characters (soft limit).',
        },
    },
    {
        id: 'thread',
        label: 'Thread',
        tableName: 'thread_table',
        tableColumns: ['title', 'summary', 'status'],
        columnHints: {
            title: 'Stable thread name.',
            summary: 'Current progress and key open points.',
            status: 'Thread state such as active/resolved/stalled.',
        },
        requiredColumns: ['title'],
        forceUpdate: false,
        editable: true,
        level: LEVEL.SEMANTIC,
        extractHint: 'Unresolved clues, foreshadowing, quests, promises, and long-term hooks.',
        keywords: ['quest', 'clue', 'mystery', 'promise', 'goal', 'thread'],
        alwaysInject: false,
        latestOnly: false,
        primaryKeyColumns: [],
        compression: {
            mode: 'hierarchical',
            threshold: 8,
            fanIn: 3,
            maxDepth: 8,
            keepRecentLeaves: 4,
            summarizeInstruction: 'Compress thread nodes into actionable quest/foreshadowing tracks. Preserve current status, blocker, and next likely progression. Keep each summary compact, target within 150 Chinese characters (soft limit).',
        },
    },
    {
        id: 'character_sheet',
        label: 'Character Sheet',
        tableName: 'character_table',
        tableColumns: ['name', 'aliases', 'identity', 'state', 'goal', 'inventory', 'language_sample', 'core_note', 'addressing_user'],
        columnHints: {
            name: 'Canonical character name.',
            aliases: 'Nicknames, aliases, titles, or alternative names used in dialogue.',
            identity: 'Stable identity/background facts.',
            state: 'Current condition or stance.',
            goal: 'Current objective or motivation.',
            inventory: 'Key carried or owned items.',
            language_sample: 'Representative current speech style sample.',
            core_note: 'Stable critical notes worth persistent recall.',
            addressing_user: 'How this character addresses the user.',
        },
        requiredColumns: ['name'],
        forceUpdate: false,
        editable: true,
        level: LEVEL.SEMANTIC,
        extractHint: 'Stable character facts and evolving state. Prefer structured JSON-like content: aliases/identity/status/goal/inventory/core notes.',
        keywords: ['character', 'alias', 'status', 'relationship', 'inventory', 'goal', 'core note'],
        alwaysInject: false,
        latestOnly: true,
        primaryKeyColumns: ['name', 'aliases'],
        compression: {
            mode: 'none',
            threshold: 2,
            fanIn: 2,
            maxDepth: 1,
            keepRecentLeaves: 1,
            summarizeInstruction: '',
        },
    },
    {
        id: 'location_state',
        label: 'Location State',
        tableName: 'location_table',
        tableColumns: ['name', 'aliases', 'controller', 'danger', 'resources', 'state'],
        columnHints: {
            name: 'Canonical location name.',
            aliases: 'Alternative location names, short names, or colloquial references.',
            controller: 'Current owner/controller of the location.',
            danger: 'Current danger level or threat profile.',
            resources: 'Important available resources/services/features.',
            state: 'Current location condition.',
        },
        requiredColumns: ['name'],
        forceUpdate: false,
        editable: true,
        level: LEVEL.SEMANTIC,
        extractHint: 'Location status, aliases, ownership/control, danger level, and environmental/resource changes. Prefer structured JSON-like content.',
        keywords: ['location', 'alias', 'control', 'danger', 'resource', 'region', 'base'],
        alwaysInject: false,
        latestOnly: true,
        primaryKeyColumns: ['name', 'aliases'],
        compression: {
            mode: 'none',
            threshold: 2,
            fanIn: 2,
            maxDepth: 1,
            keepRecentLeaves: 1,
            summarizeInstruction: '',
        },
    },
    {
        id: 'rule_constraint',
        label: 'Rule Constraint',
        tableName: 'rule_table',
        tableColumns: ['title', 'constraint', 'scope', 'status'],
        columnHints: {
            title: 'Short rule name.',
            constraint: 'Non-negotiable rule text.',
            scope: 'Where/when this rule applies.',
            status: 'Current validity or enforcement state.',
        },
        requiredColumns: ['title', 'constraint'],
        forceUpdate: false,
        editable: true,
        level: LEVEL.SEMANTIC,
        extractHint: 'World rules, magic limits, taboos, hard constraints, and never-break conditions.',
        keywords: ['rule', 'constraint', 'law', 'taboo', 'limit'],
        alwaysInject: true,
        latestOnly: false,
        primaryKeyColumns: [],
        compression: {
            mode: 'none',
            threshold: 2,
            fanIn: 2,
            maxDepth: 1,
            keepRecentLeaves: 1,
            summarizeInstruction: '',
        },
    },
];

const DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT = [
    'You are a memory recall planner focused on relevance, continuity, and efficiency.',
    'You may output one short <thought>...</thought> before tool call to explain your plan.',
    'Input format: XML blocks (recall_query_context, candidate_nodes, always_inject_node_ids, schema_overview, selection_constraints). Read all blocks before deciding.',
    'First, extract a compact query profile from recall_query_context: active entities, locations, goals, unresolved commitments, relationship/emotion shifts, and causal constraints.',
    'Do not rely on keywords only. Use semantic cues, intent, and causal context from recent dialogue.',
    'Primary goal: pick the smallest high-value set that best supports the CURRENT scene and next reply.',
    'Apply layered relevance explicitly: (1) direct relevance to this turn, (2) indirect continuity support, (3) background context with clear potential impact.',
    'Rank candidates by practical usefulness now: direct event support, causality continuity, unresolved commitments/constraints, and key character/location/rule grounding.',
    'Use edge_summary to follow relation chains and avoid isolated picks.',
    'Return action="finalize" if current candidates are sufficient.',
    'Return action="drill" only when extra expansion is clearly needed for missing context.',
    'When drilling, expand around high-value seeds instead of broad expansion.',
    'Always-inject nodes are already injected separately. Never include them in selected_node_ids.',
    'Do not fabricate missing facts. If grounded evidence is weak or absent, prefer conservative selection or empty selection and explain briefly in reason.',
    'Be honest: if no grounded memory should be recalled, return finalize with empty selected_node_ids.',
].join('\n');

const DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT = [
    'You are finalizing memory recall node selection after optional drill expansion.',
    'You may output one short <thought>...</thought> before tool call to explain your final tradeoff.',
    'Input format: XML blocks (recall_query_context, candidate_nodes, always_inject_node_ids, route_result, selection_constraints). Read all blocks before deciding.',
    'Before selecting, extract the key information needs of this turn from context: who/where/what is active, what must stay continuous, and what unknowns matter now.',
    'Do not rely on keywords only. Use semantic intent and causal continuity.',
    'Select nodes that maximize practical value for the immediate next reply.',
    'Keep storyline continuity first, then add essential support nodes (character/location/rule/thread) only when they materially improve correctness.',
    'Apply layered relevance in final ranking: direct > indirect > background-potential.',
    'Output selected_node_ids in priority order (highest value first).',
    'Prefer a compact set (typically 3-8 when available) instead of selecting everything.',
    'Always-inject nodes are already injected separately. Never include them in selected_node_ids.',
    'If no candidate is grounded and useful, return an empty list rather than forcing weak picks or inventing links.',
    'Be explicit and honest when returning empty selection.',
    'Never hallucinate facts not grounded in candidates.',
].join('\n');

const DEFAULT_EXTRACT_SYSTEM_PROMPT = [
    'Extract structured memory nodes from dialogue messages into a high-utility memory graph.',
    'Before tool calls, output one VERY detailed <thought>...</thought> analysis. Do not output plain JSON text.',
    'Do not skip reasoning. Do not jump directly to tool calls.',
    'Hard output format for <thought> (must follow exactly this order):',
    '<thought>',
    '[0] Batch scope and chronology: this batch covered seq range, what changed vs previous memory.',
    '[1] Event decision (event/event_table): create or skip, and why.',
    '[2] Thread decision (thread/thread_table): create/edit/delete/skip with evidence.',
    '[3] Character decision (character_sheet/character_table): create/edit/delete/skip with evidence.',
    '[4] Location decision (location_state/location_table): create/edit/delete/skip with evidence.',
    '[5] Rule decision (rule_constraint/rule_table): create/edit/delete/skip with evidence.',
    '[6] Link plan: exact relation edges to add (from -> relation -> target), locator method per edge (target_node_id vs target_ref), or explicit no-link reason.',
    '[7] Planned tool calls: full call list in execution order (done last), including ref declarations before any link that depends on them.',
    '</thought>',
    'If <thought> misses any required section above, treat your own response as invalid and regenerate fully.',
    'Thought depth rule: each section must include (a) decision, (b) evidence seq(s), (c) field-level update plan.',
    'Thought anti-lazy rule: no one-line vague claims like "no update needed" without evidence.',
    'If the active schema contains additional custom types, append extra per-type analysis after section [5].',
    'For each type, explicitly check whether optional columns can be updated from evidence in this batch.',
    'Tool set is dynamic. Semantic types expose create/edit/delete tools as needed; some types can be create-only. Treat tool descriptions as the source of truth.',
    'Call type tools to emit concrete updates, then call luker_rpg_extract_done as the final call.',
    'Hard rule: one response must contain COMPLETE extraction tool calls; do not stop after a single tool call.',
    'Hard rule: return at least 2 tool calls in one response: >=1 type tool call + 1 luker_rpg_extract_done (done must be last).',
    'Type tools are split by intent: create / edit / delete (if available for that type).',
    'Use create for new nodes, edit for existing node_id patch updates, delete for explicit removals.',
    'Create tool uses flattened top-level table columns. Edit tool uses set_fields for sparse patch updates.',
    'Node edit rule: when updating an existing node, set node_id explicitly using an id present in graph_data.nodes.',
    'Edit payload rule: put only changed columns in set_fields; do not resend the full row unless needed.',
    'Never fabricate node_id. If no suitable existing node is listed, create a new node without node_id.',
    'If an existing node clearly matches, prefer node_id update over duplicate creation.',
    'Delete rule: use delete tool only when a listed node is clearly wrong/duplicate/stale and must be removed.',
    'Coverage goal: when evidence exists for a semantic type in this batch, actively update that type instead of only emitting minimal name-only skeletons.',
    'Hard coverage rule: if a type has grounded evidence and there are editable nodes or clear new facts, you MUST emit create/edit calls for that type in this batch.',
    'Never output lazy rationale such as "non-required type so can skip" when grounded evidence is present.',
    'Alias quality rule: when dialogue uses nicknames/short names/titles, fill aliases for character/location nodes.',
    'Fill optional columns whenever evidence is present; if unknown, omit conservatively.',
    'Respect required columns and force-update types declared in tool descriptions.',
    'If a type is marked force-update, emit at least one grounded node for it in this batch.',
    'Character consistency hard rule: for any mentioned character grounded by card/world-info baseline, if no character_sheet node exists, create one; if an existing character_sheet conflicts with baseline facts, emit edit to align it.',
    'Grounding rule: do not hallucinate. Every field should be inferable from the batch or stable continuity.',
    'Coverage rule: avoid event-only outputs when other schema types have clear evidence; update them in the same batch.',
    'State quality rule: keep state/status fields updated when progression changes (e.g. ongoing/resolved/blocked).',
    'Editability rule: only types listed in graph_data.editable_type_ids may use edit/delete tools. For non-editable types, use create tools only.',
    'Event strict policy: each extraction batch may create AT MOST ONE event node.',
    'If multiple sub-events happened in one batch, merge them into one coherent event summary instead of creating multiple event rows.',
    'If no meaningful event progression occurred, do not fabricate an event; explain the skip clearly in section [1].',
    'Relation modeling rule: encode cross-node relations (who/where/thread linkage) via links, not by stuffing relation lists into node row columns.',
    'Never store relationship linkage text inside node fields when links can represent it.',
    'Link quality rule: include links for involved entities/locations/threads when evidence exists.',
    'Event linking priority: when an event clearly involves participants/locations/threads, include links for those relations.',
    'If relation-worthy nodes are updated but links are missing, your response is incomplete.',
    'If you decide not to add links in this batch, explain why in <thought> section [6] with explicit evidence.',
    'Link locator rule: use target_ref (same-batch temporary reference) or target_node_id (existing node id). Do not use title/type matching.',
    'Link locator decision policy: if target already exists in graph_data.nodes, use target_node_id.',
    'Link locator decision policy: if target will be created in this batch, assign ref in its create call and use target_ref.',
    'Link locator decision policy: if you cannot locate by node_id and target is missing, create target first (with ref), then link by target_ref.',
    'Never skip a grounded relation only because locator is missing; create/ref it first, then link.',
    'In <thought> section [6], for each planned edge, explicitly state locator choice and why (existing node_id vs same-batch ref).',
    'Create-time linking rule: if a node needs links now, include links in that create call instead of deferring.',
    'Post-update linking rule: when only relations change, use luker_rpg_extract_link_upsert.',
    'For each create call, you may set optional ref to name this new node for later same-batch links.',
    'Event strict link rule: event create must include links. If truly no relation can be grounded, set links: [] and provide no_link_reason.',
    'Summary rule: summary is abstraction, not raw text copy.',
    'Summary quality: emphasize causality, turning points, commitments, outcomes, and unresolved hooks.',
    'Length guide for summary: target around 300 Chinese characters (soft limit).',
    'Never paste long dialogue, narration, or quotes into summary.',
    'If information is large, split into multiple focused create/edit operations instead of one oversized summary.',
    'For non-event types, summary is optional unless schema requires it.',
    'Title policy: non-event nodes should use short stable human-readable titles.',
    'Reuse the exact same title for the same ongoing entity/thread/location to keep updates merged.',
    'Type-specific titles: when a type does not define title column in tool schema, omit title.',
].join('\n');

const defaultSettings = {
    enabled: false,
    updateEvery: 1,
    maxTurns: 900,
    recallEnabled: true,
    recallApiPresetName: '',
    recallPresetName: '',
    toolCallRetryMax: 2,
    plainTextFunctionCallMode: false,
    recallMaxIterations: 3,
    recallRouteSystemPrompt: DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT,
    recallFinalizeSystemPrompt: DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT,
    extractApiPresetName: '',
    extractPresetName: '',
    extractSystemPrompt: DEFAULT_EXTRACT_SYSTEM_PROMPT,
    extractBatchTurns: 1,
    extractContextTurns: 2,
    recallQueryMessages: 2,
    recentRawTurns: 5,
    lorebookProjectionEnabled: true,
    lorebookNameOverride: '',
    lorebookEntryOrderBase: 9800,
    nodeTypeSchema: defaultNodeTypeSchema,
};

function i18n(text) {
    return translate(String(text || ''));
}

function i18nFormat(key, ...values) {
    return i18n(key).replace(/\$\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
}

function registerLocaleData() {
    addLocaleData('zh-cn', {
        'Memory': '记忆',
        'Enabled': '启用',
        'Enable recall injection': '启用记忆召回注入',
        'Recall API preset (Connection profile, empty = current)': '召回 API 预设（连接配置，留空=当前）',
        'Recall preset (params + prompt, empty = current)': '召回预设（参数+提示词，留空=当前）',
        'Extract API preset (Connection profile, empty = current)': '写入 API 预设（连接配置，留空=当前）',
        'Extract preset (params + prompt, empty = current)': '写入预设（参数+提示词，留空=当前）',
        'Project recall output to chat lorebook (rescan WI after inject)': '将召回结果投影到聊天 Lorebook（注入后重扫世界书）',
        'Exclude latest N messages from memory injection': '记忆注入排除最近 N 条消息',
        'Recall max iterations': '召回最大轮数',
        'Extract context assistant turns': '写入上下文 Assistant 楼层数',
        'Recall query recent messages': '召回查询最近消息条数',
        'Extract batch assistant turns': '每次抽取请求处理的 Assistant 楼层数',
        'Tool-call retries': '工具调用重试次数',
        'Plain-text function-call mode': '纯文本函数调用模式',
        'Extract Table Fill Prompt': '抽取填表提示词',
        'Recall Stage 1 Prompt (Route/Drill)': '召回阶段1提示词（路由/深挖）',
        'Recall Stage 2 Prompt (Finalize)': '召回阶段2提示词（最终选择）',
        'Advanced Settings': '高级设置',
        'Open Advanced Settings': '打开高级设置',
        'Save Advanced Settings': '保存高级设置',
        'Reset Advanced Settings': '重置高级设置',
        'Advanced settings saved.': '高级设置已保存。',
        'Saved advanced settings.': '已保存高级设置。',
        'Advanced settings reset to defaults in editor.': '高级设置已在编辑器中重置为默认值。',
        'Reset advanced settings editor to default? This will overwrite current unsaved advanced edits.': '确认将高级设置编辑器重置为默认？这会覆盖当前未保存的编辑。',
        'Update every N assistant turns': '每 N 条 Assistant 楼层更新',
        'Node Type Schema (Visual Editor)': '节点类型 Schema（可视化编辑）',
        'Configure memory table types, extraction hints, and compression strategy in a popup editor.': '在弹窗里配置记忆表类型、抽取提示与压缩策略。',
        'Schema scope: character override (${0})': 'Schema 作用域：角色卡覆写（${0}）',
        'Schema scope: global': 'Schema 作用域：全局',
        'Open Schema Editor': '打开 Schema 编辑器',
        'Save Schema to Global': '将 Schema 保存到全局',
        'Save Schema to Character': '将 Schema 保存到角色卡',
        'Clear Character Schema Override': '清除角色卡 Schema 覆写',
        'Schema saved to global settings.': 'Schema 已保存到全局设置。',
        'No active character selected.': '当前未选择角色卡。',
        'Schema saved to character override: ${0}.': 'Schema 已保存到角色卡覆写：${0}。',
        'Failed to persist character schema override.': '角色卡 Schema 覆写保存失败。',
        'Failed to clear character schema override.': '清除角色卡 Schema 覆写失败。',
        'Cleared character schema override: ${0}.': '已清除角色卡 Schema 覆写：${0}。',
        'Save Settings': '保存设置',
        'View Graph': '查看图',
        'Fill Graph (Incremental)': '补全图（仅增量）',
        'Rebuild From Chat': '从聊天重建',
        'Rebuild Recent N Turns': '重建最近 N 层',
        'Rebuild recent turns: enter N (1-${0}).': '重建最近楼层：请输入 N（1-${0}）。',
        'Rebuild Recent': '重建最近范围',
        'Please enter a valid integer between 1 and ${0}.': '请输入 1 到 ${0} 之间的整数。',
        'No assistant turns available to rebuild.': '当前没有可重建的 Assistant 楼层。',
        'Memory graph rebuilt for recent ${0} turn(s).': '已完成最近 ${0} 层的记忆图重建。',
        'Rebuilt recent memory graph range: seq ${0}-${1}.': '已重建最近范围：楼层 ${0}-${1}。',
        'Manual Compress': '手动压缩',
        'Reset Current Chat': '重置当前聊天',
        'Export Current Chat Graph': '导出当前聊天图',
        'Import Current Chat Graph': '导入当前聊天图',
        'Recall debug query': '召回调试查询',
        'e.g. what happened at the ruins with Mira?': '例如：和 Mira 在遗迹发生了什么？',
        'Run Recall Debug': '运行召回调试',
        'View Last Injection': '查看最近注入',
        'Core Packet': '核心注入包',
        'Core packet is empty.': '核心注入包为空。',
        'No recall injection result yet.': '当前还没有召回注入结果。',
        'Memory recall running...': '记忆召回进行中...',
        'Memory graph update running...': '记忆图更新进行中...',
        'Memory graph update running... seq ${0}-${1} / latest ${2}': '记忆图更新进行中... 楼层 ${0}-${1} / 最新 ${2}',
        'No active chat selected.': '未选择有效聊天。',
        'Paste memory graph JSON for current chat.': '为当前聊天粘贴记忆图 JSON。',
        'Import': '导入',
        'Cancel': '取消',
        'Delete': '删除',
        'Memory graph imported for current chat.': '当前聊天记忆图已导入。',
        'Imported memory graph JSON.': '已导入记忆图 JSON。',
        'Memory graph import failed.': '记忆图导入失败。',
        'Memory graph incremental fill completed.': '记忆图增量补全完成。',
        'Memory graph is already up to date.': '记忆图已是最新，无需补全。',
        'Import failed: ${0}': '导入失败：${0}',
        'Types: ${0} | Always Inject: ${1} | Force Update: ${2} | Hierarchical: ${3}': '类型：${0} | 常驻注入：${1} | 强制更新：${2} | 分层压缩：${3}',
        'Types: ${0} | Editable: ${1} | Always Inject: ${2} | Force Update: ${3} | Hierarchical: ${4}': '类型：${0} | 可编辑：${1} | 常驻注入：${2} | 强制更新：${3} | 分层压缩：${4}',
        '(Current preset)': '（当前预设）',
        '(Current API config)': '（当前 API 配置）',
        '(missing)': '（缺失）',
        '(none)': '（无）',
        '(select node)': '（选择节点）',
        '(unset)': '（未设置）',
        '(new)': '（新建）',
        'Memory Graph': '记忆图',
        'Inspector': '检查器',
        'Select a node or edge to edit.': '点击节点或边以编辑。',
        'Apply Changes': '应用修改',
        'No node selected. Click a node in graph first.': '未选择节点。请先在图中点击一个节点。',
        'Nodes: ${0} | Edges: ${1} | Assistant turns: ${2} | Source turns: ${3}': '节点：${0} | 边：${1} | Assistant 楼层：${2} | 源楼层：${3}',
        'semantic=${0}': 'semantic=${0}',
        'Last recall steps: ${0}': '最近召回步数：${0}',
        'Visual graph ready. Click a node or edge to select it for editing.': '可视化图已就绪。点击节点或边可选择并编辑。',
        'Fit View': '适配视图',
        'Add Edge': '新增边',
        'Edit Selected Edge': '编辑所选边',
        'Delete Selected Edge': '删除所选边',
        'Advanced JSON View': '高级 JSON 查看',
        'Advanced JSON Edit': '高级 JSON 编辑',
        'ID': 'ID',
        'Level': '层级',
        'Type': '类型',
        'Title': '标题',
        'Summary': '摘要',
        'Children': '子节点',
        'SeqRange': '序列范围',
        'Actions': '操作',
        'Recent Edges': '最近边',
        'From': '起点',
        'To': '终点',
        'Edit': '编辑',
        'Last Projection': '最近投影',
        'View': '查看',
        'Form Edit': '表单编辑',
        'Form editor for one node. Parent/child relationships and graph persistence are applied automatically.': '单节点表单编辑器。父子关系和图持久化会自动处理。',
        'Node ID': '节点 ID',
        'Parent Node': '父节点',
        'Sequence': '序号',
        'From Sequence': '起始序号',
        'To Sequence': '结束序号',
        'Archived': '已归档',
        'Fields (one key=value per line)': '字段（每行一个 key=value）',
        'Edge ${0}: configure relation between two nodes.': '边 ${0}：配置两个节点之间的关系。',
        'From Node': '起点节点',
        'To Node': '终点节点',
        'Edge not found: #${0}': '未找到边：#${0}',
        'Apply Edge': '应用边',
        'Create Edge': '创建边',
        'Edge form not found': '未找到边表单',
        'From/To node is required': '起点/终点节点必填',
        'From/To node does not exist': '起点/终点节点不存在',
        'From and To cannot be the same node': '起点和终点不能是同一节点',
        'Edge updated (#${0})': '边已更新（#${0}）',
        'Updated edge #${0}.': '已更新边 #${0}。',
        'Edge created.': '边已创建。',
        'Created edge #${0}.': '已创建边 #${0}。',
        'Edge edit failed: ${0}': '边编辑失败：${0}',
        'Node not found: ${0}': '未找到节点：${0}',
        'Apply Node': '应用节点',
        'Node form not found': '未找到节点表单',
        'Parent node does not exist: ${0}': '父节点不存在：${0}',
        'Parent node cannot be itself': '父节点不能是自身',
        'Parent selection would create a cycle': '当前父节点选择会产生环',
        'Updated node ${0}.': '已更新节点 ${0}。',
        'Node updated: ${0}': '节点已更新：${0}',
        'Node edit failed: ${0}': '节点编辑失败：${0}',
        'Fitted graph view.': '图视图已适配。',
        'No edge selected. Click an edge in graph first.': '未选择边。请先在图中点击一条边。',
        'Delete edge #${0}: ${1} -> ${2} [${3}]?': '删除边 #${0}：${1} -> ${2} [${3}]？',
        'Deleted edge #${0}.': '已删除边 #${0}。',
        'Deleted selected edge.': '已删除所选边。',
        'Advanced: edit full memory graph JSON for current chat.': '高级：编辑当前聊天的完整记忆图 JSON。',
        'Apply Graph': '应用图',
        'Applied raw graph JSON edit.': '已应用原始图 JSON 编辑。',
        'Memory graph JSON updated.': '记忆图 JSON 已更新。',
        'Graph edit failed: ${0}': '图编辑失败：${0}',
        'Memory disabled, runtime lorebook projection cleared.': '记忆已禁用，已清理运行时 Lorebook 投影。',
        'Lorebook projection disabled.': 'Lorebook 投影已禁用。',
        'Memory store unavailable for current chat.': '当前聊天的记忆存储不可用。',
        'Recall ready. selected=${0}': '召回就绪。selected=${0}',
        'Recall injection failed (${0}): ${1}': '召回注入失败（${0}）：${1}',
        'nodes=${0}, edges=${1}, messages=${2}, source=${3}, semantic=${4}': 'nodes=${0}, edges=${1}, messages=${2}, source=${3}, semantic=${4}',
        'Memory Node Schema Editor': '记忆节点 Schema 编辑器',
        'Define node tables, extraction hints, and compression strategy. This controls what your memory graph stores and how it compacts over time.': '定义节点表、抽取提示和压缩策略。这会控制记忆图存储内容及其随时间压缩方式。',
        'Hierarchical Compression': '分层压缩',
        'Latest-only Merge': 'Latest-only 合并',
        'Always Inject': '常驻注入',
        'Current type count: ${0}': '当前类型数量：${0}',
        'Add Type': '新增类型',
        'Reset to Default Schema': '重置为默认 Schema',
        'Schema reset to default in editor.': '已在编辑器中重置为默认 Schema。',
        'Reset schema editor content to default? This will overwrite current unsaved schema edits.': '确认将 Schema 编辑器重置为默认？这会覆盖当前未保存的编辑。',
        'table: ${0}': '表：${0}',
        'mode: ${0}': '模式：${0}',
        'always inject': '常驻注入',
        'Type ID': '类型 ID',
        'Label': '标签',
        'Table Name': '表名',
        'Table Columns (comma separated)': '表列（逗号分隔）',
        'Required Columns (comma separated)': '必填列（逗号分隔）',
        'Column Hints (one per line: column=meaning)': '列含义（每行一个：列名=含义）',
        'Keywords (comma separated)': '关键词（逗号分隔）',
        'Force Update (must appear each extraction batch)': '强制更新（每次抽取必须出现）',
        'Latest Only Upsert': 'Latest-only 覆写',
        'Editable': '可编辑',
        'Create-only': '仅创建',
        'Editable (enable edit/delete tools and graph edit context)': '可编辑（启用编辑/删除工具与图编辑上下文）',
        'Primary Key Columns': '主键列',
        'Extract Hint': '抽取提示',
        'Enable Hierarchical Compression': '启用层级压缩',
        'none': 'none',
        'hierarchical': 'hierarchical',
        'Threshold': '阈值',
        'Fan-In': '扇入',
        'Max Depth': '最大深度',
        'Keep Recent Leaves': '保留最近叶子',
        'Summarize Instruction': '摘要指令',
        'Duplicate Type': '复制类型',
        'Remove Type': '删除类型',
        'Apply Schema': '应用 Schema',
        'Memory schema updated.': '记忆 Schema 已更新。',
        'Applied memory schema from popup editor.': '已应用弹窗编辑器中的记忆 Schema。',
        'Saved memory settings.': '记忆设置已保存。',
        'Invalid schema settings: ${0}': 'Schema 设置无效：${0}',
        'Memory settings save failed.': '记忆设置保存失败。',
        'Memory graph rebuilt from current chat.': '已从当前聊天重建记忆图。',
        'Rebuilt memory graph and compression from chat.': '已从聊天重建记忆图并完成压缩。',
        'Manual Compression': '手动压缩',
        'Compression scope': '压缩范围',
        'All nodes': '全图节点',
        'Older nodes only (exclude recent N assistant turns)': '仅旧节点（排除最近 N 条 Assistant）',
        'Exclude recent assistant turns': '排除最近 Assistant 条数',
        'Compression mode': '压缩模式',
        'Use schema thresholds': '按 Schema 阈值压缩',
        'Force compress (ignore threshold)': '强制压缩（忽略阈值）',
        'Max rounds per type': '每种类型最大轮数',
        'Types to compress': '要压缩的类型',
        'Apply Manual Compression': '执行手动压缩',
        'No compressible types in current schema.': '当前 Schema 没有可压缩类型。',
        'Select at least one type to compress.': '请至少选择一种要压缩的类型。',
        'No nodes are eligible for the selected scope.': '当前范围内没有可压缩节点。',
        'Manual compression completed. Created=${0}, archived=${1}': '手动压缩完成。新建=${0}，归档=${1}',
        'Manual compression made no changes.': '手动压缩未产生变化。',
        'Event compression completed: ${0} round(s).': '事件压缩完成：本次 ${0} 轮。',
        'Current chat memory graph reset.': '已重置当前聊天记忆图。',
        'Reset memory graph for current chat.': '已重置当前聊天的记忆图。',
        'Reset current chat memory graph? This cannot be undone.': '确认重置当前聊天记忆图吗？此操作不可撤销。',
        'Visual graph unavailable: failed to load Cytoscape.': '可视化图不可用：加载 Cytoscape 失败。',
        'Selected node: ${0}. Tip: click an edge to edit relation.': '已选择节点：${0}。提示：点击边可编辑关系。',
        'Selected edge index ${0} (missing).': '已选择边索引 ${0}（缺失）。',
        'Selected edge #${0}: ${1} -> ${2} [${3}]': '已选择边 #${0}：${1} -> ${2} [${3}]',
        'Chat mutation detected. Memory graph will re-sync on next generation.': '检测到聊天变更。记忆图会在下次生成时重新同步。',
        'Generation aborted. Skipped memory recall.': '生成已中断，已跳过记忆召回。',
        'Memory recall cancelled by user.': '记忆召回已由用户终止。',
        'Memory graph update cancelled by user.': '记忆图更新已由用户终止。',
        'Stop': '终止',
    });
    addLocaleData('zh-tw', {
        'Memory': '記憶',
        'Enabled': '啟用',
        'Enable recall injection': '啟用記憶召回注入',
        'Recall API preset (Connection profile, empty = current)': '召回 API 預設（連線設定，留空=目前）',
        'Recall preset (params + prompt, empty = current)': '召回預設（參數+提示詞，留空=目前）',
        'Extract API preset (Connection profile, empty = current)': '寫入 API 預設（連線設定，留空=目前）',
        'Extract preset (params + prompt, empty = current)': '寫入預設（參數+提示詞，留空=目前）',
        'Project recall output to chat lorebook (rescan WI after inject)': '將召回結果投影到聊天 Lorebook（注入後重掃世界書）',
        'Exclude latest N messages from memory injection': '記憶注入排除最近 N 條訊息',
        'Recall max iterations': '召回最大輪數',
        'Extract context assistant turns': '寫入上下文 Assistant 樓層數',
        'Recall query recent messages': '召回查詢最近訊息條數',
        'Extract batch assistant turns': '每次抽取請求處理的 Assistant 樓層數',
        'Tool-call retries': '工具呼叫重試次數',
        'Plain-text function-call mode': '純文字函式呼叫模式',
        'Extract Table Fill Prompt': '抽取填表提示詞',
        'Recall Stage 1 Prompt (Route/Drill)': '召回階段1提示詞（路由/深挖）',
        'Recall Stage 2 Prompt (Finalize)': '召回階段2提示詞（最終選擇）',
        'Advanced Settings': '進階設定',
        'Open Advanced Settings': '打開進階設定',
        'Save Advanced Settings': '儲存進階設定',
        'Reset Advanced Settings': '重置進階設定',
        'Advanced settings saved.': '進階設定已儲存。',
        'Saved advanced settings.': '已儲存進階設定。',
        'Advanced settings reset to defaults in editor.': '進階設定已在編輯器中重設為預設值。',
        'Reset advanced settings editor to default? This will overwrite current unsaved advanced edits.': '確認將進階設定編輯器重設為預設？這會覆蓋目前未儲存的編輯。',
        'Update every N assistant turns': '每 N 條 Assistant 樓層更新',
        'Node Type Schema (Visual Editor)': '節點類型 Schema（視覺化編輯）',
        'Configure memory table types, extraction hints, and compression strategy in a popup editor.': '在彈窗中配置記憶表類型、抽取提示與壓縮策略。',
        'Schema scope: character override (${0})': 'Schema 作用域：角色卡覆寫（${0}）',
        'Schema scope: global': 'Schema 作用域：全域',
        'Open Schema Editor': '開啟 Schema 編輯器',
        'Save Schema to Global': '將 Schema 儲存到全域',
        'Save Schema to Character': '將 Schema 儲存到角色卡',
        'Clear Character Schema Override': '清除角色卡 Schema 覆寫',
        'Schema saved to global settings.': 'Schema 已儲存到全域設定。',
        'No active character selected.': '目前未選擇角色卡。',
        'Schema saved to character override: ${0}.': 'Schema 已儲存到角色卡覆寫：${0}。',
        'Failed to persist character schema override.': '角色卡 Schema 覆寫儲存失敗。',
        'Failed to clear character schema override.': '清除角色卡 Schema 覆寫失敗。',
        'Cleared character schema override: ${0}.': '已清除角色卡 Schema 覆寫：${0}。',
        'Save Settings': '儲存設定',
        'View Graph': '查看圖譜',
        'Fill Graph (Incremental)': '補全圖譜（僅增量）',
        'Rebuild From Chat': '從聊天重建',
        'Rebuild Recent N Turns': '重建最近 N 層',
        'Rebuild recent turns: enter N (1-${0}).': '重建最近樓層：請輸入 N（1-${0}）。',
        'Rebuild Recent': '重建最近範圍',
        'Please enter a valid integer between 1 and ${0}.': '請輸入 1 到 ${0} 之間的整數。',
        'No assistant turns available to rebuild.': '目前沒有可重建的 Assistant 樓層。',
        'Memory graph rebuilt for recent ${0} turn(s).': '已完成最近 ${0} 層的記憶圖重建。',
        'Rebuilt recent memory graph range: seq ${0}-${1}.': '已重建最近範圍：樓層 ${0}-${1}。',
        'Manual Compress': '手動壓縮',
        'Reset Current Chat': '重設目前聊天',
        'Export Current Chat Graph': '匯出目前聊天圖',
        'Import Current Chat Graph': '匯入目前聊天圖',
        'Recall debug query': '召回除錯查詢',
        'e.g. what happened at the ruins with Mira?': '例如：和 Mira 在遺跡發生了什麼？',
        'Run Recall Debug': '執行召回除錯',
        'View Last Injection': '查看最近注入',
        'Core Packet': '核心注入包',
        'Core packet is empty.': '核心注入包為空。',
        'No recall injection result yet.': '目前還沒有召回注入結果。',
        'Memory recall running...': '記憶召回進行中...',
        'Memory graph update running...': '記憶圖更新進行中...',
        'Memory graph update running... seq ${0}-${1} / latest ${2}': '記憶圖更新進行中... 樓層 ${0}-${1} / 最新 ${2}',
        'No active chat selected.': '未選擇有效聊天。',
        'Paste memory graph JSON for current chat.': '請貼上目前聊天的記憶圖 JSON。',
        'Import': '匯入',
        'Cancel': '取消',
        'Delete': '刪除',
        'Memory graph imported for current chat.': '目前聊天記憶圖已匯入。',
        'Imported memory graph JSON.': '已匯入記憶圖 JSON。',
        'Memory graph import failed.': '記憶圖匯入失敗。',
        'Memory graph incremental fill completed.': '記憶圖譜增量補全完成。',
        'Memory graph is already up to date.': '記憶圖譜已是最新，無需補全。',
        'Import failed: ${0}': '匯入失敗：${0}',
        'Types: ${0} | Always Inject: ${1} | Force Update: ${2} | Hierarchical: ${3}': '類型：${0} | 常駐注入：${1} | 強制更新：${2} | 分層壓縮：${3}',
        'Types: ${0} | Editable: ${1} | Always Inject: ${2} | Force Update: ${3} | Hierarchical: ${4}': '類型：${0} | 可編輯：${1} | 常駐注入：${2} | 強制更新：${3} | 分層壓縮：${4}',
        '(Current preset)': '（目前預設）',
        '(Current API config)': '（目前 API 設定）',
        '(missing)': '（缺失）',
        '(none)': '（無）',
        '(select node)': '（選擇節點）',
        '(unset)': '（未設定）',
        '(new)': '（新建）',
        'Memory Graph': '記憶圖',
        'Inspector': '檢視器',
        'Select a node or edge to edit.': '點擊節點或邊以編輯。',
        'Apply Changes': '套用修改',
        'No node selected. Click a node in graph first.': '未選擇節點。請先在圖中點擊一個節點。',
        'Nodes: ${0} | Edges: ${1} | Assistant turns: ${2} | Source turns: ${3}': '節點：${0} | 邊：${1} | Assistant 樓層：${2} | 來源樓層：${3}',
        'semantic=${0}': 'semantic=${0}',
        'Last recall steps: ${0}': '最近召回步數：${0}',
        'Visual graph ready. Click a node or edge to select it for editing.': '視覺化圖已就緒。點擊節點或邊可選取並編輯。',
        'Fit View': '適配視圖',
        'Add Edge': '新增邊',
        'Edit Selected Edge': '編輯所選邊',
        'Delete Selected Edge': '刪除所選邊',
        'Advanced JSON View': '進階 JSON 檢視',
        'Advanced JSON Edit': '進階 JSON 編輯',
        'ID': 'ID',
        'Level': '層級',
        'Type': '類型',
        'Title': '標題',
        'Summary': '摘要',
        'Children': '子節點',
        'SeqRange': '序列範圍',
        'Actions': '操作',
        'Recent Edges': '最近邊',
        'From': '起點',
        'To': '終點',
        'Edit': '編輯',
        'Last Projection': '最近投影',
        'View': '查看',
        'Form Edit': '表單編輯',
        'Form editor for one node. Parent/child relationships and graph persistence are applied automatically.': '單節點表單編輯器。父子關係與圖持久化會自動處理。',
        'Node ID': '節點 ID',
        'Parent Node': '父節點',
        'Sequence': '序號',
        'From Sequence': '起始序號',
        'To Sequence': '結束序號',
        'Archived': '已封存',
        'Fields (one key=value per line)': '字段（每行一個 key=value）',
        'Edge ${0}: configure relation between two nodes.': '邊 ${0}：設定兩個節點之間的關係。',
        'From Node': '起點節點',
        'To Node': '終點節點',
        'Edge not found: #${0}': '找不到邊：#${0}',
        'Apply Edge': '套用邊',
        'Create Edge': '建立邊',
        'Edge form not found': '找不到邊表單',
        'From/To node is required': '起點/終點節點為必填',
        'From/To node does not exist': '起點/終點節點不存在',
        'From and To cannot be the same node': '起點與終點不能是同一節點',
        'Edge updated (#${0})': '邊已更新（#${0}）',
        'Updated edge #${0}.': '已更新邊 #${0}。',
        'Edge created.': '邊已建立。',
        'Created edge #${0}.': '已建立邊 #${0}。',
        'Edge edit failed: ${0}': '邊編輯失敗：${0}',
        'Node not found: ${0}': '找不到節點：${0}',
        'Apply Node': '套用節點',
        'Node form not found': '找不到節點表單',
        'Parent node does not exist: ${0}': '父節點不存在：${0}',
        'Parent node cannot be itself': '父節點不能是自己',
        'Parent selection would create a cycle': '目前父節點選擇會形成循環',
        'Updated node ${0}.': '已更新節點 ${0}。',
        'Node updated: ${0}': '節點已更新：${0}',
        'Node edit failed: ${0}': '節點編輯失敗：${0}',
        'Fitted graph view.': '圖視圖已適配。',
        'No edge selected. Click an edge in graph first.': '未選擇邊。請先在圖中點擊一條邊。',
        'Delete edge #${0}: ${1} -> ${2} [${3}]?': '刪除邊 #${0}：${1} -> ${2} [${3}]？',
        'Deleted edge #${0}.': '已刪除邊 #${0}。',
        'Deleted selected edge.': '已刪除所選邊。',
        'Advanced: edit full memory graph JSON for current chat.': '進階：編輯目前聊天的完整記憶圖 JSON。',
        'Apply Graph': '套用圖',
        'Applied raw graph JSON edit.': '已套用原始圖 JSON 編輯。',
        'Memory graph JSON updated.': '記憶圖 JSON 已更新。',
        'Graph edit failed: ${0}': '圖編輯失敗：${0}',
        'Memory disabled, runtime lorebook projection cleared.': '記憶已停用，已清理執行期 Lorebook 投影。',
        'Lorebook projection disabled.': 'Lorebook 投影已停用。',
        'Memory store unavailable for current chat.': '目前聊天的記憶儲存不可用。',
        'Recall ready. selected=${0}': '召回就緒。selected=${0}',
        'Recall injection failed (${0}): ${1}': '召回注入失敗（${0}）：${1}',
        'nodes=${0}, edges=${1}, messages=${2}, source=${3}, semantic=${4}': 'nodes=${0}, edges=${1}, messages=${2}, source=${3}, semantic=${4}',
        'Memory Node Schema Editor': '記憶節點 Schema 編輯器',
        'Define node tables, extraction hints, and compression strategy. This controls what your memory graph stores and how it compacts over time.': '定義節點資料表、抽取提示與壓縮策略。這會控制記憶圖儲存內容及其隨時間壓縮方式。',
        'Hierarchical Compression': '分層壓縮',
        'Latest-only Merge': 'Latest-only 合併',
        'Always Inject': '常駐注入',
        'Current type count: ${0}': '目前類型數量：${0}',
        'Add Type': '新增類型',
        'Reset to Default Schema': '重設為預設 Schema',
        'Schema reset to default in editor.': '已在編輯器中重設為預設 Schema。',
        'Reset schema editor content to default? This will overwrite current unsaved schema edits.': '確認將 Schema 編輯器重設為預設？這會覆蓋目前未儲存的編輯。',
        'table: ${0}': '表：${0}',
        'mode: ${0}': '模式：${0}',
        'always inject': '常駐注入',
        'Type ID': '類型 ID',
        'Label': '標籤',
        'Table Name': '表名',
        'Table Columns (comma separated)': '表欄位（逗號分隔）',
        'Required Columns (comma separated)': '必填欄位（逗號分隔）',
        'Column Hints (one per line: column=meaning)': '欄位說明（每行一個：欄位=說明）',
        'Keywords (comma separated)': '關鍵字（逗號分隔）',
        'Force Update (must appear each extraction batch)': '強制更新（每次抽取必須出現）',
        'Latest Only Upsert': 'Latest-only 覆寫',
        'Editable': '可編輯',
        'Create-only': '僅建立',
        'Editable (enable edit/delete tools and graph edit context)': '可編輯（啟用編輯/刪除工具與圖編輯上下文）',
        'Primary Key Columns': '主鍵列',
        'Extract Hint': '抽取提示',
        'Enable Hierarchical Compression': '啟用分層壓縮',
        'none': 'none',
        'hierarchical': 'hierarchical',
        'Threshold': '閾值',
        'Fan-In': '扇入',
        'Max Depth': '最大深度',
        'Keep Recent Leaves': '保留最近葉節點',
        'Summarize Instruction': '摘要指令',
        'Duplicate Type': '複製類型',
        'Remove Type': '移除類型',
        'Apply Schema': '套用 Schema',
        'Memory schema updated.': '記憶 Schema 已更新。',
        'Applied memory schema from popup editor.': '已套用彈窗編輯器中的記憶 Schema。',
        'Saved memory settings.': '記憶設定已儲存。',
        'Invalid schema settings: ${0}': 'Schema 設定無效：${0}',
        'Memory settings save failed.': '記憶設定儲存失敗。',
        'Memory graph rebuilt from current chat.': '已從目前聊天重建記憶圖。',
        'Rebuilt memory graph and compression from chat.': '已從聊天重建記憶圖並完成壓縮。',
        'Manual Compression': '手動壓縮',
        'Compression scope': '壓縮範圍',
        'All nodes': '全圖節點',
        'Older nodes only (exclude recent N assistant turns)': '僅舊節點（排除最近 N 條 Assistant）',
        'Exclude recent assistant turns': '排除最近 Assistant 條數',
        'Compression mode': '壓縮模式',
        'Use schema thresholds': '按 Schema 閾值壓縮',
        'Force compress (ignore threshold)': '強制壓縮（忽略閾值）',
        'Max rounds per type': '每種類型最大輪數',
        'Types to compress': '要壓縮的類型',
        'Apply Manual Compression': '執行手動壓縮',
        'No compressible types in current schema.': '目前 Schema 沒有可壓縮類型。',
        'Select at least one type to compress.': '請至少選擇一種要壓縮的類型。',
        'No nodes are eligible for the selected scope.': '目前範圍內沒有可壓縮節點。',
        'Manual compression completed. Created=${0}, archived=${1}': '手動壓縮完成。新建=${0}，歸檔=${1}',
        'Manual compression made no changes.': '手動壓縮未產生變化。',
        'Event compression completed: ${0} round(s).': '事件壓縮完成：本次 ${0} 輪。',
        'Current chat memory graph reset.': '已重設目前聊天記憶圖。',
        'Reset memory graph for current chat.': '已重設目前聊天記憶圖。',
        'Reset current chat memory graph? This cannot be undone.': '確認重設目前聊天記憶圖嗎？此操作不可撤銷。',
        'Visual graph unavailable: failed to load Cytoscape.': '視覺化圖不可用：載入 Cytoscape 失敗。',
        'Selected node: ${0}. Tip: click an edge to edit relation.': '已選擇節點：${0}。提示：點擊邊可編輯關係。',
        'Selected edge index ${0} (missing).': '已選擇邊索引 ${0}（缺失）。',
        'Selected edge #${0}: ${1} -> ${2} [${3}]': '已選擇邊 #${0}：${1} -> ${2} [${3}]',
        'Chat mutation detected. Memory graph will re-sync on next generation.': '偵測到聊天變更。記憶圖會在下次生成時重新同步。',
        'Generation aborted. Skipped memory recall.': '生成已中斷，已跳過記憶召回。',
        'Memory recall cancelled by user.': '記憶召回已由使用者終止。',
        'Memory graph update cancelled by user.': '記憶圖更新已由使用者終止。',
        'Stop': '終止',
    });
}

const CHAT_MODEL_SETTING_BY_SOURCE = {
    [chat_completion_sources.OPENAI]: 'openai_model',
    [chat_completion_sources.CLAUDE]: 'claude_model',
    [chat_completion_sources.OPENROUTER]: 'openrouter_model',
    [chat_completion_sources.AI21]: 'ai21_model',
    [chat_completion_sources.MAKERSUITE]: 'google_model',
    [chat_completion_sources.VERTEXAI]: 'vertexai_model',
    [chat_completion_sources.MISTRALAI]: 'mistralai_model',
    [chat_completion_sources.CUSTOM]: 'custom_model',
    [chat_completion_sources.COHERE]: 'cohere_model',
    [chat_completion_sources.PERPLEXITY]: 'perplexity_model',
    [chat_completion_sources.GROQ]: 'groq_model',
    [chat_completion_sources.ELECTRONHUB]: 'electronhub_model',
    [chat_completion_sources.CHUTES]: 'chutes_model',
    [chat_completion_sources.NANOGPT]: 'nanogpt_model',
    [chat_completion_sources.DEEPSEEK]: 'deepseek_model',
    [chat_completion_sources.AIMLAPI]: 'aimlapi_model',
    [chat_completion_sources.XAI]: 'xai_model',
    [chat_completion_sources.POLLINATIONS]: 'pollinations_model',
    [chat_completion_sources.MOONSHOT]: 'moonshot_model',
    [chat_completion_sources.FIREWORKS]: 'fireworks_model',
    [chat_completion_sources.COMETAPI]: 'cometapi_model',
    [chat_completion_sources.AZURE_OPENAI]: 'azure_openai_model',
    [chat_completion_sources.ZAI]: 'zai_model',
    [chat_completion_sources.SILICONFLOW]: 'siliconflow_model',
};

const API_ALIAS_TO_CHAT_SOURCE = {
    openai: chat_completion_sources.OPENAI,
    claude: chat_completion_sources.CLAUDE,
    openrouter: chat_completion_sources.OPENROUTER,
    ai21: chat_completion_sources.AI21,
    makersuite: chat_completion_sources.MAKERSUITE,
    vertexai: chat_completion_sources.VERTEXAI,
    mistralai: chat_completion_sources.MISTRALAI,
    custom: chat_completion_sources.CUSTOM,
    cohere: chat_completion_sources.COHERE,
    perplexity: chat_completion_sources.PERPLEXITY,
    groq: chat_completion_sources.GROQ,
    electronhub: chat_completion_sources.ELECTRONHUB,
    chutes: chat_completion_sources.CHUTES,
    nanogpt: chat_completion_sources.NANOGPT,
    deepseek: chat_completion_sources.DEEPSEEK,
    aimlapi: chat_completion_sources.AIMLAPI,
    xai: chat_completion_sources.XAI,
    pollinations: chat_completion_sources.POLLINATIONS,
    moonshot: chat_completion_sources.MOONSHOT,
    fireworks: chat_completion_sources.FIREWORKS,
    cometapi: chat_completion_sources.COMETAPI,
    azure_openai: chat_completion_sources.AZURE_OPENAI,
    zai: chat_completion_sources.ZAI,
    siliconflow: chat_completion_sources.SILICONFLOW,
};

const extractionTimers = new Map();
const memoryStoreCache = new Map();
const memoryStoreTargets = new Map();
const memoryStorePersistedSnapshots = new Map();
const memoryLoadTasks = new Map();
let activeRuntimeInfoToast = null;
let activeRecallAbortController = null;
let activeExtractionAbortController = null;
let cytoscapeLoadPromise = null;
let lastKnownChatKey = '';

function cloneDefault(value) {
    return Array.isArray(value) || typeof value === 'object' ? structuredClone(value) : value;
}

function normalizeNodeTypeSchema(schema) {
    const list = Array.isArray(schema) ? schema : defaultNodeTypeSchema;
    const normalizeCompressionMode = (mode) => {
        const value = String(mode || '').trim().toLowerCase();
        return ['none', 'hierarchical'].includes(value) ? value : 'none';
    };
    const normalized = list
        .filter(item => item && typeof item === 'object')
        .map((item, index) => {
            const rawId = String(item.id || `custom_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_\-]/g, '_');
            const defaultRequired = rawId === 'event' ? ['summary'] : [];
            const requiredColumns = Array.isArray(item.requiredColumns)
                ? item.requiredColumns.map(x => String(x || '').trim()).filter(Boolean)
                : defaultRequired;
            const columnHints = item.columnHints && typeof item.columnHints === 'object' && !Array.isArray(item.columnHints)
                ? Object.fromEntries(
                    Object.entries(item.columnHints)
                        .map(([key, value]) => [String(key || '').trim(), String(value || '').trim()])
                        .filter(([key, value]) => key && value),
                )
                : {};
            const forceUpdate = item.forceUpdate === undefined
                ? rawId === 'event'
                : Boolean(item.forceUpdate);
            const editable = item.editable === undefined
                ? rawId !== 'event'
                : Boolean(item.editable);
            const rawCompressionMode = String(item?.compression?.mode || '').trim().toLowerCase();
            const tableColumns = Array.isArray(item.tableColumns)
                ? item.tableColumns.map(x => String(x || '').trim()).filter(Boolean)
                : ['title'];
            const requestedLatestOnly = Boolean(item.latestOnly);
            const rawPrimaryKeyColumns = Array.isArray(item.primaryKeyColumns)
                ? item.primaryKeyColumns
                : [];
            const allowedKeyColumns = new Set(tableColumns);
            const primaryKeyColumns = Array.from(new Set(
                rawPrimaryKeyColumns
                    .map(x => String(x || '').trim())
                    .filter(Boolean)
                    .filter(column => allowedKeyColumns.has(column)),
            ));
            const latestOnly = requestedLatestOnly;
            return {
                id: rawId,
                label: String(item.label || item.id || `Type ${index + 1}`).trim(),
                tableName: String(item.tableName || item.id || `table_${index + 1}`).trim(),
                tableColumns,
                level: String(item.level || LEVEL.SEMANTIC),
                extractHint: String(item.extractHint || '').trim(),
                keywords: Array.isArray(item.keywords) ? item.keywords.map(x => String(x || '').trim()).filter(Boolean) : [],
                columnHints,
                requiredColumns,
                forceUpdate,
                editable,
                alwaysInject: Boolean(item.alwaysInject),
                latestOnly,
                primaryKeyColumns,
                compression: {
                    mode: normalizeCompressionMode(rawCompressionMode),
                    threshold: Math.max(2, Number(item?.compression?.threshold) || 6),
                    fanIn: Math.max(2, Number(item?.compression?.fanIn) || 3),
                    maxDepth: Math.max(1, Number(item?.compression?.maxDepth) || 6),
                    keepRecentLeaves: Math.max(0, Number(item?.compression?.keepRecentLeaves) || 0),
                    summarizeInstruction: String(item?.compression?.summarizeInstruction || '').trim(),
                },
            };
        })
        .filter(item => item.id);

    const deduped = [];
    const seenIds = new Set();
    for (const item of normalized) {
        let id = String(item.id || '').trim();
        if (!id) {
            continue;
        }
        if (seenIds.has(id)) {
            let suffix = 2;
            while (seenIds.has(`${id}_${suffix}`)) {
                suffix += 1;
            }
            id = `${id}_${suffix}`;
        }
        seenIds.add(id);
        deduped.push({ ...item, id });
    }

    return deduped.length > 0 ? deduped : structuredClone(defaultNodeTypeSchema);
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = cloneDefault(value);
        }
    }

    extension_settings[MODULE_NAME].toolCallRetryMax = Math.max(
        0,
        Math.min(10, Math.floor(Number(extension_settings[MODULE_NAME].toolCallRetryMax) || 0)),
    );
    extension_settings[MODULE_NAME].plainTextFunctionCallMode = Boolean(extension_settings[MODULE_NAME].plainTextFunctionCallMode);
    extension_settings[MODULE_NAME].updateEvery = Math.max(
        1,
        Math.floor(Number(extension_settings[MODULE_NAME].updateEvery) || defaultSettings.updateEvery),
    );
    extension_settings[MODULE_NAME].recallMaxIterations = Math.max(
        2,
        Math.min(6, Math.floor(Number(extension_settings[MODULE_NAME].recallMaxIterations) || defaultSettings.recallMaxIterations)),
    );
    const extractBatchTurnsRaw = Number(extension_settings[MODULE_NAME].extractBatchTurns);
    const extractContextTurnsRaw = Number(extension_settings[MODULE_NAME].extractContextTurns);
    const recallQueryMessagesRaw = Number(extension_settings[MODULE_NAME].recallQueryMessages);
    const recentRawTurnsRaw = Number(extension_settings[MODULE_NAME].recentRawTurns);
    extension_settings[MODULE_NAME].extractBatchTurns = Math.max(
        1,
        Math.floor(Number.isFinite(extractBatchTurnsRaw) ? extractBatchTurnsRaw : defaultSettings.extractBatchTurns),
    );
    extension_settings[MODULE_NAME].extractContextTurns = Math.max(
        1,
        Math.min(32, Math.floor(Number.isFinite(extractContextTurnsRaw) ? extractContextTurnsRaw : defaultSettings.extractContextTurns)),
    );
    extension_settings[MODULE_NAME].recallQueryMessages = Math.max(
        1,
        Math.min(64, Math.floor(Number.isFinite(recallQueryMessagesRaw) ? recallQueryMessagesRaw : defaultSettings.recallQueryMessages)),
    );
    extension_settings[MODULE_NAME].recentRawTurns = Math.max(
        0,
        Math.floor(Number.isFinite(recentRawTurnsRaw) ? recentRawTurnsRaw : defaultSettings.recentRawTurns),
    );
    extension_settings[MODULE_NAME].extractSystemPrompt = String(extension_settings[MODULE_NAME].extractSystemPrompt || '').trim() || DEFAULT_EXTRACT_SYSTEM_PROMPT;
    extension_settings[MODULE_NAME].recallRouteSystemPrompt = String(extension_settings[MODULE_NAME].recallRouteSystemPrompt || '').trim() || DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT;
    extension_settings[MODULE_NAME].recallFinalizeSystemPrompt = String(extension_settings[MODULE_NAME].recallFinalizeSystemPrompt || '').trim() || DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT;
    extension_settings[MODULE_NAME].nodeTypeSchema = normalizeNodeTypeSchema(extension_settings[MODULE_NAME].nodeTypeSchema);
}

function getSettings() {
    return extension_settings[MODULE_NAME];
}

function getCurrentAvatar(context) {
    const ctx = context || getContext();
    return String(ctx?.characters?.[ctx?.characterId]?.avatar || '').trim();
}

function getCharacterByAvatar(context, avatar) {
    const target = String(avatar || '').trim();
    if (!target) {
        return null;
    }
    return (context?.characters || []).find((item) => String(item?.avatar || '').trim() === target) || null;
}

function getCharacterIndexByAvatar(context, avatar) {
    const target = String(avatar || '').trim();
    if (!target) {
        return -1;
    }
    return (context?.characters || []).findIndex((item) => String(item?.avatar || '').trim() === target);
}

function getCharacterDisplayNameByAvatar(context, avatar) {
    const character = getCharacterByAvatar(context, avatar);
    return String(character?.name || avatar || '').trim();
}

function getCharacterExtensionDataByAvatar(context, avatar) {
    const character = getCharacterByAvatar(context, avatar);
    const payload = character?.data?.extensions?.[MODULE_NAME];
    return payload && typeof payload === 'object' ? payload : {};
}

function getCharacterSchemaOverrideByAvatar(context, avatar) {
    const extensionData = getCharacterExtensionDataByAvatar(context, avatar);
    const schema = extensionData?.[CHARACTER_SCHEMA_OVERRIDE_KEY];
    if (!Array.isArray(schema) || schema.length === 0) {
        return null;
    }
    return normalizeNodeTypeSchema(schema);
}

function getEffectiveNodeTypeSchema(context = null, settings = null) {
    const ctx = context || getContext();
    const currentSettings = settings || getSettings();
    const avatar = getCurrentAvatar(ctx);
    const overrideSchema = getCharacterSchemaOverrideByAvatar(ctx, avatar);
    if (overrideSchema && overrideSchema.length > 0) {
        return overrideSchema;
    }
    return normalizeNodeTypeSchema(currentSettings?.nodeTypeSchema);
}

function getSchemaScopeInfo(context = null, settings = null) {
    const ctx = context || getContext();
    const currentSettings = settings || getSettings();
    const avatar = getCurrentAvatar(ctx);
    const hasAvatar = Boolean(avatar);
    const characterName = hasAvatar ? getCharacterDisplayNameByAvatar(ctx, avatar) : '';
    const overrideSchema = hasAvatar ? getCharacterSchemaOverrideByAvatar(ctx, avatar) : null;
    const hasOverride = Array.isArray(overrideSchema) && overrideSchema.length > 0;
    const effectiveSchema = hasOverride
        ? overrideSchema
        : normalizeNodeTypeSchema(currentSettings?.nodeTypeSchema);
    return {
        avatar,
        hasAvatar,
        characterName,
        hasOverride,
        scope: hasOverride ? 'character' : 'global',
        schema: effectiveSchema,
    };
}

async function persistCharacterSchemaOverride(context, avatar, schema) {
    const target = String(avatar || '').trim();
    if (!target || typeof context?.writeExtensionField !== 'function') {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }
    const previous = getCharacterExtensionDataByAvatar(context, target);
    const next = {
        ...previous,
        [CHARACTER_SCHEMA_OVERRIDE_KEY]: normalizeNodeTypeSchema(schema),
    };
    await context.writeExtensionField(characterIndex, MODULE_NAME, next);
    return true;
}

async function removeCharacterSchemaOverride(context, avatar) {
    const target = String(avatar || '').trim();
    if (!target || typeof context?.writeExtensionField !== 'function') {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }
    const previous = getCharacterExtensionDataByAvatar(context, target);
    if (!Object.prototype.hasOwnProperty.call(previous, CHARACTER_SCHEMA_OVERRIDE_KEY)) {
        return true;
    }
    const next = { ...previous };
    delete next[CHARACTER_SCHEMA_OVERRIDE_KEY];
    await context.writeExtensionField(characterIndex, MODULE_NAME, next);
    return true;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function getOpenAIPresetNames(context) {
    const manager = context.getPresetManager?.('openai');
    if (!manager || typeof manager.getAllPresets !== 'function') {
        return [];
    }
    const names = manager.getAllPresets();
    if (!Array.isArray(names)) {
        return [];
    }
    return [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))];
}

function renderOpenAIPresetOptions(context, selectedName = '') {
    const selected = String(selectedName || '').trim();
    const names = getOpenAIPresetNames(context);
    const options = [`<option value="">${escapeHtml(i18n('(Current preset)'))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function getConnectionProfiles() {
    const profiles = extension_settings?.connectionManager?.profiles;
    if (!Array.isArray(profiles)) {
        return [];
    }
    return profiles
        .filter(profile => profile && typeof profile === 'object' && String(profile.mode || '') === 'cc')
        .map(profile => ({ ...profile, name: String(profile.name || '').trim() }))
        .filter(profile => profile.name)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function renderConnectionProfileOptions(selectedName = '') {
    const selected = String(selectedName || '').trim();
    const names = getConnectionProfiles().map(profile => profile.name);
    const options = [`<option value="">${escapeHtml(i18n('(Current API config)'))}</option>`];
    for (const name of names) {
        options.push(`<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`);
    }
    if (selected && !names.includes(selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function resolveChatSourceFromApiAlias(value, defaultSource = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return String(defaultSource || '').trim();
    }

    if (API_ALIAS_TO_CHAT_SOURCE[normalized]) {
        return API_ALIAS_TO_CHAT_SOURCE[normalized];
    }

    const mapEntry = Object.entries(CONNECT_API_MAP || {})
        .find(([alias]) => String(alias || '').toLowerCase() === normalized)?.[1];
    if (mapEntry?.selected === 'openai' && mapEntry?.source) {
        return String(mapEntry.source);
    }

    return String(defaultSource || '').trim();
}

function getConnectionProfileByName(name = '') {
    const target = String(name || '').trim();
    if (!target) {
        return null;
    }
    return getConnectionProfiles().find(profile => profile.name === target) || null;
}

function resolveRequestApiFromConnectionProfileName(context, profileName = '') {
    const defaultApi = String(context?.mainApi || 'openai').trim() || 'openai';
    const profile = getConnectionProfileByName(profileName);
    if (!profile) {
        return defaultApi;
    }

    const alias = String(profile.api || '').trim().toLowerCase();
    if (!alias) {
        return defaultApi;
    }

    const mapEntry = CONNECT_API_MAP?.[alias];
    const selectedApi = String(mapEntry?.selected || '').trim();
    if (selectedApi) {
        return selectedApi;
    }

    if (alias === 'koboldhorde') {
        return 'kobold';
    }
    return defaultApi;
}

function buildApiSettingsOverrideFromConnectionProfileName(profileName, defaultSource = '') {
    const profile = getConnectionProfileByName(profileName);
    if (!profile) {
        return null;
    }

    const overrides = {};
    const source = resolveChatSourceFromApiAlias(profile.api, defaultSource);
    if (source) {
        overrides.chat_completion_source = source;
    }

    const resolvedSource = String(source || defaultSource || '').trim();
    const modelField = CHAT_MODEL_SETTING_BY_SOURCE[resolvedSource];
    const modelValue = String(profile.model || '').trim();
    if (modelField && modelValue) {
        overrides[modelField] = modelValue;
    }

    const apiUrlValue = String(profile['api-url'] || '').trim();
    if (apiUrlValue) {
        if (resolvedSource === chat_completion_sources.CUSTOM) {
            overrides.custom_url = apiUrlValue;
        } else if (resolvedSource === chat_completion_sources.VERTEXAI) {
            overrides.vertexai_region = apiUrlValue;
        } else if (resolvedSource === chat_completion_sources.ZAI) {
            overrides.zai_endpoint = apiUrlValue;
        }
    }

    const promptPostProcessing = String(profile['prompt-post-processing'] || '').trim();
    if (promptPostProcessing) {
        overrides.custom_prompt_post_processing = promptPostProcessing;
    }

    const proxyName = String(profile.proxy || '').trim();
    if (proxyName && Array.isArray(proxies)) {
        const proxyPreset = proxies.find(item => String(item?.name || '') === proxyName);
        if (proxyPreset) {
            overrides.reverse_proxy = String(proxyPreset.url || '');
            overrides.proxy_password = String(proxyPreset.password || '');
        }
    }

    return Object.keys(overrides).length > 0 ? overrides : null;
}

function refreshOpenAIPresetSelectors(root, context, settings) {
    const selectorValues = [
        ['#luker_rpg_memory_recall_api_preset', settings.recallApiPresetName],
        ['#luker_rpg_memory_recall_preset', settings.recallPresetName],
        ['#luker_rpg_memory_extract_api_preset', settings.extractApiPresetName],
        ['#luker_rpg_memory_extract_preset', settings.extractPresetName],
    ];

    for (const [selector, value] of selectorValues) {
        const select = root.find(selector);
        if (!select.length) {
            continue;
        }
        const isConnectionSelector = selector.endsWith('_api_preset');
        select.html(isConnectionSelector ? renderConnectionProfileOptions(value) : renderOpenAIPresetOptions(context, value));
        select.val(String(value || '').trim());
    }
}

function getChatKey(context, explicitTarget = null) {
    const target = buildMemoryTargetFromContext(context, explicitTarget);
    if (!target) {
        return 'invalid_target';
    }
    if (target.is_group) {
        const key = `group:${target.id}`;
        lastKnownChatKey = key;
        return key;
    }
    const key = `char:${target.avatar_url}:${target.file_name}`;
    lastKnownChatKey = key;
    return key;
}

function normalizeExplicitChatStateTarget(target) {
    if (!target || typeof target !== 'object') {
        return null;
    }
    if (target.is_group) {
        const id = String(target.id || '').trim();
        return id ? { is_group: true, id } : null;
    }
    const avatar = String(target.avatar_url || '').trim();
    const fileName = String(target.file_name || '').trim();
    return avatar && fileName
        ? { is_group: false, avatar_url: avatar, file_name: fileName }
        : null;
}

function buildMemoryTargetFromContext(context, explicitTarget = null) {
    const normalizedExplicit = normalizeExplicitChatStateTarget(explicitTarget);
    if (normalizedExplicit) {
        return normalizedExplicit;
    }
    const live = getContext();
    const runtime = live && typeof live === 'object' ? live : context;
    const groupId = runtime?.groupId ?? context?.groupId;
    const hasGroupId = groupId !== null && groupId !== undefined && String(groupId).trim() !== '';
    const chatId = String(
        (typeof runtime?.getCurrentChatId === 'function'
            ? runtime.getCurrentChatId()
            : (typeof context?.getCurrentChatId === 'function' ? context.getCurrentChatId() : (runtime?.chatId ?? context?.chatId))) || '',
    ).trim();

    if (hasGroupId) {
        const groupChatId = chatId;
        if (!groupChatId) {
            return null;
        }
        return { is_group: true, id: groupChatId };
    }

    const characterId = runtime?.characterId ?? context?.characterId;
    const characters = Array.isArray(runtime?.characters)
        ? runtime.characters
        : (Array.isArray(context?.characters) ? context.characters : []);
    const character = characters?.[characterId];
    const avatar = String(character?.avatar || '').trim();
    const metadataChatId = String(runtime?.chatMetadata?.main_chat || context?.chatMetadata?.main_chat || '').trim();
    const fileName = String(character?.chat || chatId || metadataChatId || '').trim();
    if (!avatar || !fileName) {
        return null;
    }
    return {
        is_group: false,
        avatar_url: avatar,
        file_name: fileName,
    };
}

async function loadMemoryStoreByTarget(context, target) {
    if (typeof context.getChatState !== 'function') {
        throw new Error('Chat state API is unavailable in extension context.');
    }
    const data = await context.getChatState(CHAT_STATE_NAMESPACE, { target });
    return normalizeStoreForRuntime(data || createEmptyStore());
}

function buildMemoryStorePatchOperations(previousStore, nextStore) {
    return buildObjectPatchOperations(previousStore, nextStore, { maxOperations: 16000 });
}

async function patchMemoryStoreByTarget(context, target, operations) {
    const ops = Array.isArray(operations) ? operations.filter(Boolean) : [];
    if (ops.length === 0) {
        return;
    }
    if (typeof context.patchChatState !== 'function') {
        throw new Error('Chat state patch API is unavailable in extension context.');
    }
    const ok = await context.patchChatState(CHAT_STATE_NAMESPACE, ops, { target });
    if (!ok) {
        throw new Error('Failed to patch memory store.');
    }
}

async function deleteMemoryStoreByTarget(context, target) {
    if (typeof context.deleteChatState !== 'function') {
        throw new Error('Chat state delete API is unavailable in extension context.');
    }
    const ok = await context.deleteChatState(CHAT_STATE_NAMESPACE, { target });
    if (!ok) {
        throw new Error('Failed to delete memory store.');
    }
}

function createEmptyStore() {
    return {
        version: 5,
        nodeSeq: 0,
        seqCounter: 0,
        appliedSeqTo: 0,
        nodes: {},
        edges: [],
        lastRecallTrace: [],
        lastRecallProjection: null,
        sourceMessageCount: 0,
        sourceDigest: '',
    };
}

function normalizeStoreForRuntime(store) {
    if (!store || typeof store !== 'object') {
        return createEmptyStore();
    }
    const normalized = createEmptyStore();
    normalized.sourceMessageCount = Math.max(0, Number(store.sourceMessageCount || 0));
    normalized.sourceDigest = String(store.sourceDigest || '');
    normalized.lastRecallTrace = Array.isArray(store.lastRecallTrace) ? store.lastRecallTrace : [];
    normalized.lastRecallProjection = store.lastRecallProjection && typeof store.lastRecallProjection === 'object'
        ? store.lastRecallProjection
        : null;

    if (store.nodes && typeof store.nodes === 'object') {
        for (const [id, rawNode] of Object.entries(store.nodes)) {
            if (!rawNode || typeof rawNode !== 'object') {
                continue;
            }
            const nodeId = String(id || '').trim();
            if (!nodeId) {
                continue;
            }
            const level = String(rawNode.level || LEVEL.SEMANTIC).trim();
            if (level !== LEVEL.SEMANTIC) {
                continue;
            }
            const seqTo = Number.isFinite(Number(rawNode.seqTo))
                ? Math.max(0, Math.floor(Number(rawNode.seqTo)))
                : 0;
            const fields = rawNode.fields && typeof rawNode.fields === 'object' && !Array.isArray(rawNode.fields)
                ? { ...rawNode.fields }
                : {};
            normalized.nodes[nodeId] = {
                id: nodeId,
                type: String(rawNode.type || 'semantic'),
                level: LEVEL.SEMANTIC,
                title: normalizeText(rawNode.title || nodeId),
                seqTo,
                fields,
                semanticDepth: Number.isFinite(Number(rawNode.semanticDepth)) ? Number(rawNode.semanticDepth) : 0,
                semanticRollup: Boolean(rawNode.semanticRollup),
                childrenIds: Array.isArray(rawNode.childrenIds) ? rawNode.childrenIds.map(child => String(child || '').trim()).filter(Boolean) : [],
                parentId: String(rawNode.parentId || '').trim(),
                archived: Boolean(rawNode.archived),
            };
            normalized.seqCounter = Math.max(normalized.seqCounter, seqTo);
            const extractedNodeSeq = Number(String(nodeId).replace(/^n_/, ''));
            if (Number.isFinite(extractedNodeSeq)) {
                normalized.nodeSeq = Math.max(normalized.nodeSeq, extractedNodeSeq);
            }
        }
    }

    const validNodeIds = new Set(Object.keys(normalized.nodes));
    for (const node of Object.values(normalized.nodes)) {
        node.childrenIds = node.childrenIds.filter(id => validNodeIds.has(id));
        if (node.parentId && !validNodeIds.has(node.parentId)) {
            node.parentId = '';
        }
    }

    normalized.edges = Array.isArray(store.edges)
        ? store.edges
            .filter(edge => edge && typeof edge === 'object')
            .map(edge => ({
                from: String(edge.from || '').trim(),
                to: String(edge.to || '').trim(),
                type: normalizeText(edge.type || 'related') || 'related',
            }))
            .filter(edge => edge.from && edge.to && edge.from !== edge.to && validNodeIds.has(edge.from) && validNodeIds.has(edge.to))
        : [];

    normalized.appliedSeqTo = Math.max(
        0,
        Math.min(
            normalized.seqCounter,
            Math.floor(Number.isFinite(Number(store.appliedSeqTo)) ? Number(store.appliedSeqTo) : normalized.seqCounter),
        ),
    );
    return normalized;
}

async function ensureMemoryStoreLoaded(context, { force = false, targetHint = null } = {}) {
    const target = buildMemoryTargetFromContext(context, targetHint);
    if (!target) {
        return null;
    }

    const chatKey = getChatKey(context, target);
    memoryStoreTargets.set(chatKey, target);

    if (!force && memoryStoreCache.has(chatKey)) {
        return memoryStoreCache.get(chatKey);
    }
    if (!force && memoryLoadTasks.has(chatKey)) {
        return await memoryLoadTasks.get(chatKey);
    }

    const task = (async () => {
        const loaded = await loadMemoryStoreByTarget(context, target);
        memoryStoreCache.set(chatKey, loaded);
        memoryStorePersistedSnapshots.set(chatKey, structuredClone(loaded));
        return loaded;
    })();
    memoryLoadTasks.set(chatKey, task);

    try {
        return await task;
    } finally {
        memoryLoadTasks.delete(chatKey);
    }
}

function getMemoryStore(context, targetHint = null) {
    const chatKey = getChatKey(context, targetHint);
    return memoryStoreCache.get(chatKey) || null;
}

async function persistMemoryStoreByChatKey(context, chatKey, store) {
    const target = memoryStoreTargets.get(chatKey);
    if (!target) {
        return;
    }
    const previous = memoryStorePersistedSnapshots.get(chatKey) || null;
    const operations = buildMemoryStorePatchOperations(previous, store);
    if (operations.length === 0) {
        return;
    }
    await patchMemoryStoreByTarget(context, target, operations);
    memoryStorePersistedSnapshots.set(chatKey, structuredClone(store));
}

function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function ensureNodeFieldsObject(node) {
    if (!node || typeof node !== 'object') {
        return {};
    }
    if (!node.fields || typeof node.fields !== 'object' || Array.isArray(node.fields)) {
        node.fields = {};
    }
    return node.fields;
}

function tryParseJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) {
        return null;
    }
    const stripFence = (input) => input.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const candidates = [raw, stripFence(raw)];
    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }
        if ((candidate.startsWith('{') && candidate.endsWith('}')) || (candidate.startsWith('[') && candidate.endsWith(']'))) {
            try {
                const parsed = JSON.parse(candidate);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed;
                }
            } catch {
                // ignore and continue
            }
        }
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                const parsed = JSON.parse(candidate.slice(start, end + 1));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed;
                }
            } catch {
                // ignore and continue
            }
        }
    }
    return null;
}

function toDisplayScalar(value) {
    if (value === null || value === undefined) {
        return '';
    }
    if (Array.isArray(value)) {
        return value.map(item => normalizeText(typeof item === 'string' ? item : JSON.stringify(item))).filter(Boolean).join(', ');
    }
    if (typeof value === 'object') {
        return normalizeText(JSON.stringify(value));
    }
    return normalizeText(String(value));
}

function getNodeSummary(node) {
    if (!node || typeof node !== 'object') {
        return '';
    }
    const fields = node.fields && typeof node.fields === 'object' && !Array.isArray(node.fields)
        ? node.fields
        : {};
    if (fields.summary !== undefined && fields.summary !== null) {
        return normalizeText(toDisplayScalar(fields.summary));
    }
    return '';
}

function setNodeSummary(node, summaryText) {
    if (!node || typeof node !== 'object') {
        return;
    }
    const fields = ensureNodeFieldsObject(node);
    const normalized = normalizeText(summaryText);
    if (normalized) {
        fields.summary = normalized;
    } else {
        delete fields.summary;
    }
    if (Object.prototype.hasOwnProperty.call(node, 'summary')) {
        delete node.summary;
    }
}

function getStructuredNodeFields(node) {
    const fields = {};
    const mergeObject = (obj) => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            return;
        }
        Object.assign(fields, obj);
        if (obj.fields && typeof obj.fields === 'object' && !Array.isArray(obj.fields)) {
            Object.assign(fields, obj.fields);
        }
    };
    mergeObject(node?.fields);
    mergeObject(tryParseJsonObject(node?.fields));
    mergeObject(tryParseJsonObject(getNodeSummary(node)));
    return fields;
}

function findValueByKeyDeep(value, targetKey, depth = 0) {
    if (!value || depth > 5) {
        return undefined;
    }
    const key = String(targetKey || '').trim().toLowerCase();
    if (!key) {
        return undefined;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const hit = findValueByKeyDeep(item, key, depth + 1);
            if (hit !== undefined) {
                return hit;
            }
        }
        return undefined;
    }
    if (typeof value !== 'object') {
        return undefined;
    }
    for (const [entryKey, entryValue] of Object.entries(value)) {
        if (String(entryKey || '').trim().toLowerCase() === key) {
            return entryValue;
        }
    }
    for (const entryValue of Object.values(value)) {
        const hit = findValueByKeyDeep(entryValue, key, depth + 1);
        if (hit !== undefined) {
            return hit;
        }
    }
    return undefined;
}

function hashTextFNV1a(text) {
    let hash = 0x811c9dc5;
    const input = String(text || '');
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function getAssistantChatMessages(context) {
    const source = Array.isArray(context?.chat) ? context.chat : [];
    const result = [];
    let lastUser = null;
    for (const message of source) {
        if (!message || message.is_system) {
            continue;
        }
        if (message.is_user) {
            lastUser = {
                name: String(message.name || ''),
                mes: String(message.mes || ''),
                send_date: String(message.send_date || ''),
            };
            continue;
        }
        const text = normalizeText(message?.mes || '');
        if (!text) {
            continue;
        }
        result.push({
            is_user: false,
            name: String(message.name || ''),
            mes: text,
            send_date: String(message.send_date || ''),
            last_user_name: String(lastUser?.name || ''),
            last_user_mes: String(lastUser?.mes || ''),
            last_user_send_date: String(lastUser?.send_date || ''),
        });
    }
    return result;
}

function computeChatSourceState(context) {
    const source = getAssistantChatMessages(context);
    const tail = [];
    let count = 0;
    for (const message of source) {
        count += 1;
        tail.push({
            is_user: Boolean(message.is_user),
            name: String(message.name || ''),
            mes: String(message.mes || ''),
            send_date: String(message.send_date || ''),
            last_user_name: String(message.last_user_name || ''),
            last_user_mes: String(message.last_user_mes || ''),
            last_user_send_date: String(message.last_user_send_date || ''),
        });
        if (tail.length > 24) {
            tail.shift();
        }
    }
    const digestPayload = tail.map(message => [
        message.is_user ? 'u' : 'a',
        message.name,
        normalizeText(message.mes),
        message.send_date,
        `ctx_user_name=${message.last_user_name}`,
        `ctx_user_mes=${normalizeText(message.last_user_mes)}`,
        `ctx_user_date=${message.last_user_send_date}`,
    ].join('|')).join('\n');
    return {
        messageCount: count,
        digest: hashTextFNV1a(`${count}\n${digestPayload}`),
    };
}

function updateStoreSourceState(store, context) {
    const source = computeChatSourceState(context);
    store.sourceMessageCount = Number(source.messageCount || 0);
    store.sourceDigest = String(source.digest || '');
}

function getNodeTypeSchemaMap(settings, context = null) {
    const map = new Map();
    for (const entry of getEffectiveNodeTypeSchema(context, settings)) {
        map.set(String(entry.id || '').toLowerCase(), entry);
    }
    return map;
}

function getSemanticTypeSpec(settings, type, context = null) {
    const map = getNodeTypeSchemaMap(settings, context);
    return map.get(String(type || '').toLowerCase()) || null;
}

function getSemanticCompressionConfig(settings, type, context = null) {
    const spec = getSemanticTypeSpec(settings, type, context);
    const raw = spec?.compression && typeof spec.compression === 'object' ? spec.compression : {};
    const mode = ['none', 'hierarchical'].includes(String(raw.mode || '').toLowerCase())
        ? String(raw.mode).toLowerCase()
        : 'none';
    return {
        mode,
        threshold: Math.max(2, Number(raw.threshold) || 6),
        fanIn: Math.max(2, Number(raw.fanIn) || 3),
        maxDepth: Math.max(1, Number(raw.maxDepth) || 6),
        keepRecentLeaves: Math.max(0, Number(raw.keepRecentLeaves) || 0),
        summarizeInstruction: String(raw.summarizeInstruction || '').trim(),
        label: String(spec?.label || type || 'Semantic'),
    };
}

function getSemanticLatestOnlyConfig(settings, type, context = null) {
    const spec = getSemanticTypeSpec(settings, type, context);
    return {
        enabled: Boolean(spec?.latestOnly),
        keyFields: Array.isArray(spec?.primaryKeyColumns)
            ? spec.primaryKeyColumns.map(column => String(column || '').trim()).filter(Boolean)
            : [],
    };
}

function nextNodeId(store) {
    store.nodeSeq = Number(store.nodeSeq || 0) + 1;
    return `n_${store.nodeSeq}`;
}

function createNode(store, node) {
    const id = nextNodeId(store);
    const seqToRaw = Number.isFinite(Number(node.seqTo))
        ? Number(node.seqTo)
        : Number.isFinite(Number(node.seq))
            ? Number(node.seq)
            : Number(store.seqCounter || 0);
    const seqTo = Number.isFinite(seqToRaw) ? Math.max(0, Math.floor(seqToRaw)) : Number(store.seqCounter || 0);
    store.seqCounter = Math.max(Number(store.seqCounter || 0), Number.isFinite(seqTo) ? seqTo : 0);
    store.nodes[id] = {
        id,
        type: String(node.type || 'unknown'),
        level: String(node.level || LEVEL.SEMANTIC),
        title: normalizeText(node.title || id),
        parentId: node.parentId ? String(node.parentId) : '',
        childrenIds: [],
        fields: node.fields && typeof node.fields === 'object' && !Array.isArray(node.fields) ? node.fields : {},
        semanticDepth: Number.isFinite(Number(node.semanticDepth)) ? Number(node.semanticDepth) : 0,
        semanticRollup: Boolean(node.semanticRollup),
        seqTo: Number.isFinite(seqTo) ? seqTo : undefined,
        archived: Boolean(node.archived),
    };
    setNodeSummary(store.nodes[id], node?.fields?.summary ?? '');

    if (store.nodes[id].parentId && store.nodes[store.nodes[id].parentId]) {
        const parent = store.nodes[store.nodes[id].parentId];
        if (!parent.childrenIds.includes(id)) {
            parent.childrenIds.push(id);
        }
        addEdge(store, parent.id, id, 'contains');
    }

    return store.nodes[id];
}

function addEdge(store, from, to, type = 'related') {
    if (!from || !to || from === to) {
        return;
    }

    const found = store.edges.find(edge => edge.from === from && edge.to === to && edge.type === type);
    if (found) {
        return;
    }

    store.edges.push({
        from,
        to,
        type,
    });
}

function reparentNode(store, childId, parentId) {
    const child = store.nodes[childId];
    const parent = store.nodes[parentId];
    if (!child || !parent) {
        return;
    }

    const oldParentId = String(child.parentId || '');
    if (oldParentId && store.nodes[oldParentId]) {
        const oldParent = store.nodes[oldParentId];
        oldParent.childrenIds = (oldParent.childrenIds || []).filter(id => id !== childId);
    }

    child.parentId = parentId;
    if (!Array.isArray(parent.childrenIds)) {
        parent.childrenIds = [];
    }
    if (!parent.childrenIds.includes(childId)) {
        parent.childrenIds.push(childId);
    }
    addEdge(store, parentId, childId, 'contains');
}

function listNodesByLevel(store, level) {
    return Object.values(store.nodes).filter(node => node.level === level);
}

function getChildren(store, nodeId) {
    const node = store.nodes[nodeId];
    if (!node || !Array.isArray(node.childrenIds)) {
        return [];
    }
    return node.childrenIds.map(id => store.nodes[id]).filter(child => Boolean(child) && !child.archived);
}

function dropNode(store, nodeId, recursive = true) {
    const node = store.nodes[nodeId];
    if (!node) {
        return;
    }

    if (recursive && Array.isArray(node.childrenIds)) {
        for (const childId of [...node.childrenIds]) {
            dropNode(store, childId, true);
        }
    }

    if (node.parentId && store.nodes[node.parentId]) {
        const parent = store.nodes[node.parentId];
        parent.childrenIds = parent.childrenIds.filter(id => id !== nodeId);
    }

    delete store.nodes[nodeId];
    store.edges = store.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);
}

function archiveNode(store, nodeId) {
    const node = store.nodes[nodeId];
    if (!node) {
        return;
    }
    node.archived = true;
}

function summarizeTextHeuristic(lines) {
    return lines
        .map(line => normalizeText(line))
        .filter(Boolean)
        .join('\n');
}

function buildCompressionSummaryInstruction(baseInstruction) {
    const base = normalizeText(baseInstruction || '');
    const defaultInstruction = 'Compress semantic nodes into concise higher-level memory while preserving key causality and unresolved hooks.';
    const instruction = base || defaultInstruction;
    return [
        instruction,
        'Length guide: target within 150 Chinese characters (soft limit; slight overflow only if critical information would be lost).',
        'Avoid raw dialogue and excessive detail. Keep only durable plot signal.',
    ].join('\n');
}

function buildPresetAwareLLMMessages(
    context,
    settings,
    { api = '', systemPrompt = '', userPrompt = '', includeCharacterCard = true, promptPresetName = '' } = {},
) {
    const systemText = String(systemPrompt || '').trim();
    const userText = String(userPrompt || '').trim();
    const selectedPromptPresetName = String(promptPresetName || '').trim();
    const envelopeApi = selectedPromptPresetName ? 'openai' : (api || context.mainApi || 'openai');

    return context.buildPresetAwarePromptMessages({
        messages: [
            { role: 'system', content: systemText },
            { role: 'user', content: userText },
        ],
        envelopeOptions: {
            includeCharacterCard,
            api: envelopeApi,
            promptPresetName: selectedPromptPresetName,
        },
        promptPresetName: selectedPromptPresetName,
    });
}

async function summarizeTextWithLLM(context, settings, instruction, lines, abortSignal = null) {
    const joined = summarizeTextHeuristic(lines);
    if (!joined) {
        return '';
    }

    try {
        const result = await runFunctionCallTask(context, settings, {
            systemPrompt: instruction,
            userPrompt: joined,
            apiPresetName: settings.extractApiPresetName || '',
            promptPresetName: settings.extractPresetName || '',
            functionName: 'luker_rpg_summary',
            functionDescription: 'Return compressed memory summary text.',
            parameters: {
                type: 'object',
                properties: {
                    summary: { type: 'string' },
                },
                required: ['summary'],
                additionalProperties: false,
            },
            abortSignal,
        });
        return normalizeText(result?.summary || '');
    } catch (error) {
        console.warn(`[${MODULE_NAME}] LLM summary failed`, error);
        return '';
    }
}

function extractFunctionCallArguments(responseData, functionName) {
    const expectedName = String(functionName || '').trim();
    if (!expectedName) {
        throw new Error('Function name is required.');
    }

    const toolCalls = responseData?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        throw new Error('Model did not return any tool call.');
    }

    const matchedCall = toolCalls.find(call => String(call?.function?.name || '') === expectedName);
    if (!matchedCall) {
        throw new Error(`Model returned tool call, but not '${expectedName}'.`);
    }

    const argsText = matchedCall?.function?.arguments;
    if (typeof argsText !== 'string' || !argsText.trim()) {
        throw new Error('Tool call arguments are empty.');
    }

    try {
        return JSON.parse(argsText);
    } catch {
        throw new Error('Tool call arguments are not valid JSON.');
    }
}

function extractAllFunctionCalls(responseData, allowedNames = null) {
    const toolCalls = responseData?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        throw new Error('Model did not return any tool call.');
    }

    const allowSet = allowedNames instanceof Set
        ? allowedNames
        : Array.isArray(allowedNames)
            ? new Set(allowedNames.map(name => String(name || '').trim()).filter(Boolean))
            : null;
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

function getResponseMessageContent(responseData) {
    return String(responseData?.choices?.[0]?.message?.content || '').trim();
}

function collectJsonPayloadCandidates(text) {
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

function extractAllFunctionCallsFromText(responseData, allowedNames = null) {
    const content = getResponseMessageContent(responseData);
    if (!content) {
        throw new Error('Model returned empty text response.');
    }
    const allowSet = allowedNames instanceof Set
        ? allowedNames
        : Array.isArray(allowedNames)
            ? new Set(allowedNames.map(name => String(name || '').trim()).filter(Boolean))
            : null;
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

function buildPlainTextToolProtocolMessage(tools = [], { requiredFunctionName = '' } = {}) {
    const requiredName = String(requiredFunctionName || '').trim();
    const normalizedTools = Array.isArray(tools) ? tools : [];
    const schemaGuide = normalizedTools.map((tool) => ({
        name: String(tool?.function?.name || ''),
        description: String(tool?.function?.description || ''),
        parameters: tool?.function?.parameters && typeof tool.function.parameters === 'object'
            ? tool.function.parameters
            : { type: 'object', additionalProperties: true },
    })).filter(item => item.name);
    const requiredLine = requiredName
        ? `Required function name for this response: ${requiredName}.`
        : '';
    return [
        'Plain-text function-call mode is enabled.',
        'You may output reasoning text (for example <thought>...</thought>) before the final JSON payload.',
        'The final output must end with one JSON object: {"tool_calls":[{"name":"FUNCTION_NAME","arguments":{...}}]}',
        requiredLine,
        `Allowed functions and JSON argument schemas: ${JSON.stringify(schemaGuide)}`,
    ].filter(Boolean).join('\n');
}

function mergeUserAddendumIntoPromptMessages(promptMessages, addendumText, tagName = 'function_call_protocol') {
    const messages = Array.isArray(promptMessages)
        ? promptMessages.map(message => ({ ...message }))
        : [];
    const addendum = String(addendumText || '').trim();
    if (!addendum) {
        return messages;
    }
    const tag = String(tagName || '').trim() || 'function_call_protocol';
    const wrapped = [`<${tag}>`, addendum, `</${tag}>`].join('\n');
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
            content: base ? `${base}\n\n${wrapped}` : wrapped,
        };
        return messages;
    }
    messages.push({ role: 'user', content: wrapped });
    return messages;
}

function isAbortSignalLike(value) {
    return Boolean(value && typeof value === 'object' && 'aborted' in value);
}

function isAbortError(error, abortSignal = null) {
    if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
        return true;
    }
    const name = String(error?.name || '').toLowerCase();
    if (name === 'aborterror') {
        return true;
    }
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('aborted') || message.includes('abort');
}

function linkAbortSignals(...signals) {
    const validSignals = signals.filter(isAbortSignalLike);
    if (validSignals.length === 0) {
        return { signal: null, cleanup: () => {} };
    }
    if (validSignals.length === 1) {
        return { signal: validSignals[0], cleanup: () => {} };
    }

    const controller = new AbortController();
    const onAbort = () => {
        if (!controller.signal.aborted) {
            controller.abort();
        }
    };

    for (const signal of validSignals) {
        if (signal.aborted) {
            onAbort();
            break;
        }
        signal.addEventListener('abort', onAbort, { once: true });
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            for (const signal of validSignals) {
                signal.removeEventListener('abort', onAbort);
            }
        },
    };
}

async function requestToolCallWithRetry(settings, promptMessages, {
    functionName = '',
    functionDescription = '',
    parameters = {},
    llmPresetName = '',
    apiSettingsOverride = null,
    abortSignal = null,
} = {}) {
    const fnName = String(functionName || '').trim();
    if (!fnName) {
        throw new Error('Function name is required.');
    }

    const retries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
    const tools = [{
        type: 'function',
        function: {
            name: fnName,
            description: String(functionDescription || `Function output for ${fnName}`),
            parameters: parameters && typeof parameters === 'object' ? parameters : { type: 'object', additionalProperties: true },
        },
    }];
    const toolChoice = {
        type: 'function',
        function: { name: fnName },
    };
    const usePlainTextCalls = isPlainTextFunctionCallModeEnabled(settings);
    const requestMessages = usePlainTextCalls
        ? mergeUserAddendumIntoPromptMessages(
            promptMessages,
            buildPlainTextToolProtocolMessage(tools, { requiredFunctionName: fnName }),
            'function_call_protocol',
        )
        : promptMessages;

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const responseData = await sendOpenAIRequest('quiet', requestMessages, isAbortSignalLike(abortSignal) ? abortSignal : null, {
                tools: usePlainTextCalls ? [] : tools,
                toolChoice: usePlainTextCalls ? 'auto' : toolChoice,
                replaceTools: true,
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
                requestScope: 'extension_internal',
            });
            if (usePlainTextCalls) {
                const calls = extractAllFunctionCallsFromText(responseData, [fnName]);
                const matched = calls.find(call => String(call?.name || '') === fnName);
                if (!matched) {
                    throw new Error(`Model returned text calls, but not '${fnName}'.`);
                }
                return matched.args;
            }
            return extractFunctionCallArguments(responseData, fnName);
        } catch (error) {
            if (isAbortError(error, abortSignal)) {
                throw error;
            }
            lastError = error;
            if (attempt >= retries) {
                throw error;
            }
            console.warn(`[${MODULE_NAME}] Tool call '${fnName}' failed. Retrying (${attempt + 1}/${retries})...`, error);
        }
    }

    throw lastError || new Error(`Tool call '${fnName}' failed.`);
}

async function requestToolCallsWithRetry(settings, promptMessages, {
    tools = [],
    allowedNames = null,
    llmPresetName = '',
    apiSettingsOverride = null,
    retriesOverride = null,
    abortSignal = null,
} = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error('Tools are required.');
    }

    const retriesSource = retriesOverride === null || retriesOverride === undefined
        ? Number(settings?.toolCallRetryMax)
        : Number(retriesOverride);
    const retries = Math.max(0, Math.min(10, Math.floor(retriesSource || 0)));
    const usePlainTextCalls = isPlainTextFunctionCallModeEnabled(settings);
    const requestMessages = usePlainTextCalls
        ? mergeUserAddendumIntoPromptMessages(
            promptMessages,
            buildPlainTextToolProtocolMessage(tools),
            'function_call_protocol',
        )
        : promptMessages;
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const responseData = await sendOpenAIRequest('quiet', requestMessages, isAbortSignalLike(abortSignal) ? abortSignal : null, {
                tools: usePlainTextCalls ? [] : tools,
                toolChoice: 'auto',
                replaceTools: true,
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
                requestScope: 'extension_internal',
            });
            if (usePlainTextCalls) {
                return extractAllFunctionCallsFromText(responseData, allowedNames);
            }
            return extractAllFunctionCalls(responseData, allowedNames);
        } catch (error) {
            if (isAbortError(error, abortSignal)) {
                throw error;
            }
            lastError = error;
            if (attempt >= retries) {
                throw error;
            }
            console.warn(`[${MODULE_NAME}] Multi tool call request failed. Retrying (${attempt + 1}/${retries})...`, error);
        }
    }

    throw lastError || new Error('Multi tool call request failed.');
}

async function runFunctionCallTask(context, settings, {
    systemPrompt = '',
    userPrompt = '',
    promptPresetName = '',
    apiPresetName = '',
    functionName = '',
    functionDescription = '',
    parameters = {},
    abortSignal = null,
} = {}) {
    const fnName = String(functionName || '').trim();
    if (!fnName) {
        throw new Error('Function name is required.');
    }

    const resolvedApiPresetName = String(apiPresetName || '').trim();
    const requestApi = resolveRequestApiFromConnectionProfileName(context, resolvedApiPresetName);
    const prompt = buildPresetAwareLLMMessages(context, settings, {
        api: requestApi,
        systemPrompt,
        userPrompt,
        includeCharacterCard: true,
        promptPresetName: String(promptPresetName || '').trim(),
    });

    const apiSettingsOverride = buildApiSettingsOverrideFromConnectionProfileName(
        resolvedApiPresetName,
        String(context?.chatCompletionSettings?.chat_completion_source || ''),
    );

    return await requestToolCallWithRetry(settings, prompt, {
        functionName: fnName,
        functionDescription,
        parameters,
        llmPresetName: String(promptPresetName || '').trim(),
        apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
        abortSignal,
    });
}

function buildEvidenceSeqRange(item, batch) {
    const seqs = Array.isArray(item?.evidence_seqs)
        ? item.evidence_seqs.map(value => Number(value)).filter(Number.isFinite)
        : [];
    if (seqs.length > 0) {
        return { seqTo: Math.max(...seqs) };
    }
    const fromRaw = Number(item?.evidence_seq_range?.from_seq);
    const toRaw = Number(item?.evidence_seq_range?.to_seq);
    if (Number.isFinite(fromRaw) || Number.isFinite(toRaw)) {
        const to = Number.isFinite(toRaw) ? toRaw : fromRaw;
        return { seqTo: Number(to) };
    }
    const lastSeqInBatch = Number(batch?.[batch.length - 1]?.seq);
    if (Number.isFinite(lastSeqInBatch)) {
        return { seqTo: Number(lastSeqInBatch) };
    }
    return { seqTo: 0 };
}

function sanitizeExtractToolNameSuffix(typeId = '') {
    return String(typeId || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '') || 'semantic';
}

function buildDynamicToolDescription(spec = {}, mode = 'create') {
    const typeId = String(spec?.id || '').trim().toLowerCase();
    const tableName = String(spec?.tableName || typeId || '').trim();
    const hint = normalizeText(spec?.extractHint || '');
    const fields = Array.isArray(spec?.tableColumns) ? spec.tableColumns.map(field => String(field || '').trim()).filter(Boolean) : [];
    const columnHints = spec?.columnHints && typeof spec.columnHints === 'object' && !Array.isArray(spec.columnHints)
        ? spec.columnHints
        : {};
    const required = Array.isArray(spec?.requiredColumns) ? spec.requiredColumns.map(field => String(field || '').trim()).filter(Boolean) : [];
    const forceUpdate = Boolean(spec?.forceUpdate);
    const normalizedMode = String(mode || 'create').trim().toLowerCase();
    const chunks = [];
    if (normalizedMode === 'edit') {
        chunks.push(`Edit semantic node for type "${typeId}" (table "${tableName || typeId}") by node_id.`);
        chunks.push('Provide only changed fields in set_fields. Existing fields not mentioned will stay unchanged.');
    } else {
        chunks.push(`Create semantic node for type "${typeId}" (table "${tableName || typeId}").`);
        chunks.push('Use this tool only for creating new nodes.');
    }
    if (hint) {
        chunks.push(`Meaning: ${hint}`);
    }
    if (fields.length > 0) {
        chunks.push(`Columns: ${fields.join(', ')}`);
    }
    const hintRows = fields
        .map(field => `${field}=${normalizeText(columnHints[field] || '')}`)
        .filter(row => !row.endsWith('='));
    if (hintRows.length > 0) {
        chunks.push(`Column meanings: ${hintRows.join('; ')}`);
    }
    if (required.length > 0) {
        chunks.push(`Required columns: ${required.join(', ')}`);
    } else {
        chunks.push('Required columns: none');
    }
    chunks.push(`Force update each extraction batch: ${forceUpdate ? 'yes' : 'no'}`);
    return chunks.join(' ');
}

function buildDynamicExtractTools(schema = [], options = {}) {
    const tools = [];
    const specByToolName = new Map();
    const usedNames = new Set();
    const allowEditDelete = options?.allowEditDelete !== false;

    for (const rawSpec of Array.isArray(schema) ? schema : []) {
        const spec = rawSpec && typeof rawSpec === 'object' ? rawSpec : null;
        if (!spec) {
            continue;
        }
        const typeId = String(spec.id || '').trim().toLowerCase();
        if (!typeId) {
            continue;
        }
        const baseName = `luker_rpg_extract_${sanitizeExtractToolNameSuffix(typeId)}`;
        const isEditableType = Boolean(spec?.editable);
        let createToolName = `${baseName}_create`;
        let suffix = 2;
        while (usedNames.has(createToolName)) {
            createToolName = `${baseName}_create_${suffix}`;
            suffix += 1;
        }
        usedNames.add(createToolName);
        let editToolName = '';
        if (isEditableType && allowEditDelete) {
            editToolName = `${baseName}_edit`;
            suffix = 2;
            while (usedNames.has(editToolName)) {
                editToolName = `${baseName}_edit_${suffix}`;
                suffix += 1;
            }
            usedNames.add(editToolName);
        }
        let deleteToolName = '';
        if (isEditableType && allowEditDelete) {
            deleteToolName = `${baseName}_delete`;
            suffix = 2;
            while (usedNames.has(deleteToolName)) {
                deleteToolName = `${baseName}_delete_${suffix}`;
                suffix += 1;
            }
            usedNames.add(deleteToolName);
        }
        const fields = Array.isArray(spec.tableColumns)
            ? spec.tableColumns.map(field => String(field || '').trim()).filter(Boolean)
            : [];
        const filteredFields = fields;
        const requiredColumns = Array.isArray(spec.requiredColumns)
            ? spec.requiredColumns.map(field => String(field || '').trim()).filter(Boolean)
            : [];
        const filteredRequiredColumns = requiredColumns;
        const rawColumnHints = spec.columnHints && typeof spec.columnHints === 'object' && !Array.isArray(spec.columnHints)
            ? spec.columnHints
            : {};
        const filteredColumnHints = Object.fromEntries(
            Object.entries(rawColumnHints)
                .map(([key, value]) => [String(key || '').trim(), String(value || '').trim()])
                .filter(([key, value]) => key && value && filteredFields.includes(key)),
        );
        const fieldSet = new Set(filteredFields);
        const createProperties = {
            ref: { type: 'string' },
            evidence_seqs: {
                type: 'array',
                items: { type: 'integer' },
            },
            evidence_seq_range: {
                type: 'object',
                properties: {
                    from_seq: { type: 'integer' },
                    to_seq: { type: 'integer' },
                },
                additionalProperties: false,
            },
            no_link_reason: { type: 'string' },
            links: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        target_ref: { type: 'string' },
                        target_node_id: { type: 'string' },
                        relation: { type: 'string' },
                        direction: { type: 'string', enum: ['outgoing', 'incoming', 'bidirectional'] },
                    },
                    anyOf: [
                        { required: ['target_ref'] },
                        { required: ['target_node_id'] },
                    ],
                    additionalProperties: false,
                },
            },
        };
        if (fieldSet.has('title')) {
            createProperties.title = { type: 'string' };
        }
        for (const field of fieldSet) {
            if (createProperties[field]) {
                continue;
            }
            createProperties[field] = { type: 'string' };
        }
        const editFieldProperties = {};
        for (const field of fieldSet) {
            editFieldProperties[field] = { type: 'string' };
        }

        const createRequiredColumns = filteredRequiredColumns
            .filter(field => fieldSet.has(field) || field === 'title');
        if (typeId === 'event' && !createRequiredColumns.includes('links')) {
            createRequiredColumns.push('links');
        }

        tools.push({
            type: 'function',
            function: {
                name: createToolName,
                description: buildDynamicToolDescription({
                    ...spec,
                    id: typeId,
                    tableColumns: filteredFields,
                    requiredColumns: filteredRequiredColumns,
                    columnHints: filteredColumnHints,
                }, 'create'),
                parameters: {
                    type: 'object',
                    properties: createProperties,
                    required: createRequiredColumns,
                    additionalProperties: false,
                },
            },
        });
        if (isEditableType && allowEditDelete) {
            tools.push({
                type: 'function',
                function: {
                    name: editToolName,
                    description: buildDynamicToolDescription({
                        ...spec,
                        id: typeId,
                        tableColumns: filteredFields,
                        requiredColumns: filteredRequiredColumns,
                        columnHints: filteredColumnHints,
                    }, 'edit'),
                    parameters: {
                        type: 'object',
                        properties: {
                            node_id: { type: 'string' },
                            title: { type: 'string' },
                            set_fields: {
                                type: 'object',
                                properties: editFieldProperties,
                                additionalProperties: false,
                            },
                            clear_fields: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                    enum: filteredFields,
                                },
                            },
                            reason: { type: 'string' },
                        },
                        required: ['node_id'],
                        additionalProperties: false,
                    },
                },
            });
        }
        if (isEditableType && allowEditDelete) {
            tools.push({
                type: 'function',
                function: {
                    name: deleteToolName,
                    description: `Delete semantic node for type "${typeId}" by node_id.`,
                    parameters: {
                        type: 'object',
                        properties: {
                            node_id: { type: 'string' },
                            reason: { type: 'string' },
                        },
                        required: ['node_id'],
                        additionalProperties: false,
                    },
                },
            });
        }
        specByToolName.set(createToolName, {
            ...spec,
            id: typeId,
            tableColumns: filteredFields,
            requiredColumns: filteredRequiredColumns,
            columnHints: filteredColumnHints,
            op: 'create',
        });
        if (isEditableType && allowEditDelete) {
            specByToolName.set(editToolName, {
                ...spec,
                id: typeId,
                tableColumns: filteredFields,
                requiredColumns: filteredRequiredColumns,
                columnHints: filteredColumnHints,
                op: 'edit',
            });
        }
        if (isEditableType && allowEditDelete) {
            specByToolName.set(deleteToolName, {
                ...spec,
                id: typeId,
                tableColumns: filteredFields,
                requiredColumns: filteredRequiredColumns,
                columnHints: filteredColumnHints,
                op: 'delete',
            });
        }
    }

    const linkUpsertToolName = 'luker_rpg_extract_link_upsert';
    tools.push({
        type: 'function',
        function: {
            name: linkUpsertToolName,
            description: 'Upsert relation edges between semantic nodes. Use this when only links change.',
            parameters: {
                type: 'object',
                properties: {
                    source_ref: { type: 'string' },
                    source_node_id: { type: 'string' },
                    links: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                target_ref: { type: 'string' },
                                target_node_id: { type: 'string' },
                                relation: { type: 'string' },
                                direction: { type: 'string', enum: ['outgoing', 'incoming', 'bidirectional'] },
                            },
                            anyOf: [
                                { required: ['target_ref'] },
                                { required: ['target_node_id'] },
                            ],
                            additionalProperties: false,
                        },
                    },
                    evidence_seqs: {
                        type: 'array',
                        items: { type: 'integer' },
                    },
                    evidence_seq_range: {
                        type: 'object',
                        properties: {
                            from_seq: { type: 'integer' },
                            to_seq: { type: 'integer' },
                        },
                        additionalProperties: false,
                    },
                },
                required: ['links'],
                anyOf: [
                    { required: ['source_ref'] },
                    { required: ['source_node_id'] },
                ],
                additionalProperties: false,
            },
        },
    });
    specByToolName.set(linkUpsertToolName, {
        ...buildSpecFallback('link', { tableName: 'link' }),
        id: 'link',
        op: 'link_upsert',
        toolName: linkUpsertToolName,
    });

    tools.push({
        type: 'function',
        function: {
            name: 'luker_rpg_extract_done',
            description: 'Signal extraction completion.',
            parameters: {
                type: 'object',
                properties: {
                    note: { type: 'string' },
                },
                additionalProperties: false,
            },
        },
    });

    return { tools, specByToolName };
}

function normalizeExtractLinks(rawLinks) {
    if (!Array.isArray(rawLinks)) {
        return [];
    }
    const normalized = [];
    for (const rawLink of rawLinks) {
        const link = rawLink && typeof rawLink === 'object' ? rawLink : null;
        if (!link) {
            continue;
        }
        const targetRef = normalizeText(link?.target_ref || link?.targetRef || '');
        const targetNodeId = normalizeText(link?.target_node_id || link?.targetNodeId || '');
        if (!targetRef && !targetNodeId) {
            continue;
        }
        const relation = normalizeText(link?.relation || 'related') || 'related';
        const directionRaw = String(link?.direction || 'bidirectional').toLowerCase();
        const direction = ['outgoing', 'incoming', 'bidirectional'].includes(directionRaw)
            ? directionRaw
            : 'bidirectional';
        normalized.push({
            targetRef,
            targetNodeId,
            relation,
            direction,
        });
    }
    return normalized;
}

function buildCreateFromDynamicToolCall(call, spec) {
    if (!call || typeof call !== 'object' || !spec || typeof spec !== 'object') {
        return { payload: null, missingRequired: [] };
    }
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const fields = {};
    for (const column of Array.isArray(spec.tableColumns) ? spec.tableColumns : []) {
        const key = String(column || '').trim();
        if (!key) {
            continue;
        }
        if (key === 'title') {
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(args, key)) {
            continue;
        }
        const rawValue = args[key];
        if (rawValue === undefined || rawValue === null) {
            continue;
        }
        fields[key] = rawValue;
    }
    const titleValue = args.title ?? '';
    const missingRequired = [];
    for (const requiredField of Array.isArray(spec.requiredColumns) ? spec.requiredColumns : []) {
        const key = String(requiredField || '').trim();
        if (!key) {
            continue;
        }
        const value = key === 'title'
            ? titleValue
            : fields[key];
        if (!normalizeText(toDisplayScalar(value))) {
            missingRequired.push(key);
        }
    }
    return {
        payload: {
            type: String(spec.id || '').trim().toLowerCase(),
            title: normalizeText(titleValue),
            fields,
            ref: normalizeText(args.ref || ''),
            links: normalizeExtractLinks(args.links),
            noLinkReason: normalizeText(args.no_link_reason || ''),
            hasLinksProp: Object.prototype.hasOwnProperty.call(args, 'links'),
            evidence_seqs: Array.isArray(args.evidence_seqs) ? args.evidence_seqs : [],
            evidence_seq_range: args.evidence_seq_range && typeof args.evidence_seq_range === 'object'
                ? args.evidence_seq_range
                : null,
        },
        missingRequired,
    };
}

function buildLinkUpsertFromToolCall(call) {
    if (!call || typeof call !== 'object') {
        return { payload: null, invalidReason: 'Invalid call.' };
    }
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const sourceNodeId = normalizeText(args.source_node_id || '');
    const sourceRef = normalizeText(args.source_ref || '');
    if (!sourceNodeId && !sourceRef) {
        return { payload: null, invalidReason: 'source_node_id or source_ref is required.' };
    }
    const links = normalizeExtractLinks(args.links);
    if (links.length === 0) {
        return { payload: null, invalidReason: 'links must contain at least one valid target.' };
    }
    return {
        payload: {
            op: 'link_upsert',
            sourceNodeId,
            sourceRef,
            links,
            evidence_seqs: Array.isArray(args.evidence_seqs) ? args.evidence_seqs : [],
            evidence_seq_range: args.evidence_seq_range && typeof args.evidence_seq_range === 'object'
                ? args.evidence_seq_range
                : null,
        },
        invalidReason: '',
    };
}

function buildEditFromDynamicToolCall(call, spec) {
    if (!call || typeof call !== 'object' || !spec || typeof spec !== 'object') {
        return { payload: null, invalidReason: 'Invalid call.' };
    }
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const nodeId = normalizeText(args.node_id || '');
    if (!nodeId) {
        return { payload: null, invalidReason: 'node_id is required.' };
    }
    const allowedFields = new Set(
        (Array.isArray(spec.tableColumns) ? spec.tableColumns : [])
            .map(column => String(column || '').trim())
            .filter(key => key && key !== 'title'),
    );
    const rawSetFields = args.set_fields && typeof args.set_fields === 'object' && !Array.isArray(args.set_fields)
        ? args.set_fields
        : {};
    const setFields = {};
    for (const [key, value] of Object.entries(rawSetFields)) {
        const normalizedKey = String(key || '').trim();
        if (!normalizedKey || !allowedFields.has(normalizedKey)) {
            continue;
        }
        if (value === undefined || value === null) {
            continue;
        }
        setFields[normalizedKey] = value;
    }
    const clearFields = Array.isArray(args.clear_fields)
        ? args.clear_fields
            .map(key => String(key || '').trim())
            .filter(key => key && allowedFields.has(key))
        : [];
    const titleValue = Object.prototype.hasOwnProperty.call(args, 'title')
        ? normalizeText(args.title || '')
        : '';
    const hasTitlePatch = Object.prototype.hasOwnProperty.call(args, 'title');
    if (!hasTitlePatch && Object.keys(setFields).length === 0 && clearFields.length === 0) {
        return { payload: null, invalidReason: 'No effective edit fields provided.' };
    }
    return {
        payload: {
            op: 'edit',
            type: String(spec.id || '').trim().toLowerCase(),
            nodeId,
            hasTitlePatch,
            title: titleValue,
            setFields,
            clearFields,
        },
        invalidReason: '',
    };
}

function buildDeleteFromDynamicToolCall(call, spec) {
    if (!call || typeof call !== 'object' || !spec || typeof spec !== 'object') {
        return { payload: null, invalidReason: 'Invalid call.' };
    }
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    const nodeId = normalizeText(args.node_id || '');
    if (!nodeId) {
        return { payload: null, invalidReason: 'node_id is required.' };
    }
    return {
        payload: {
            op: 'delete',
            type: String(spec.id || '').trim().toLowerCase(),
            nodeId,
        },
        invalidReason: '',
    };
}

function buildGraphNodeHints(store, schema, limit = 0, options = {}) {
    const numericLimit = Number(limit);
    const safeLimit = Number.isFinite(numericLimit) && numericLimit > 0
        ? Math.max(1, Math.min(5000, Math.floor(numericLimit)))
        : Number.POSITIVE_INFINITY;
    const maxSeq = Number.isFinite(Number(options?.maxSeq))
        ? Math.max(0, Math.floor(Number(options.maxSeq)))
        : null;
    if (!store || typeof store !== 'object') {
        return [];
    }
    const schemaMap = new Map(
        (Array.isArray(schema) ? schema : [])
            .map(item => [String(item?.id || '').trim().toLowerCase(), item]),
    );
    const allSemanticNodes = listNodesByLevel(store, LEVEL.SEMANTIC)
        .filter(node => !node?.archived)
        .filter(node => !isRecallDiagnosticNode(node))
        .filter((node) => {
            if (maxSeq === null) {
                return true;
            }
            const seq = Number(node?.seqTo ?? NaN);
            return !Number.isFinite(seq) || seq <= maxSeq;
        });
    const typeIds = new Set(
        allSemanticNodes
            .map(node => String(node?.type || '').trim().toLowerCase())
            .filter(Boolean),
    );
    const visibleNodes = [];
    const visibleNodeIds = new Set();
    for (const type of typeIds) {
        const spec = schemaMap.get(type);
        const compressionMode = String(spec?.compression?.mode || 'none').trim().toLowerCase();
        const typeNodes = allSemanticNodes
            .filter(node => String(node?.type || '').trim().toLowerCase() === type)
            .sort(compareNodesByTimeline);
        if (typeNodes.length === 0) {
            continue;
        }
        const selectedTypeNodes = selectVisibleNodesForType(store, typeNodes, type, compressionMode);
        for (const node of selectedTypeNodes) {
            if (!node?.id || visibleNodeIds.has(node.id)) {
                continue;
            }
            visibleNodeIds.add(node.id);
            visibleNodes.push(node);
        }
    }
    visibleNodes.sort(compareNodesByTimeline);
    const rows = [];
    for (const node of visibleNodes) {
        if (rows.length >= safeLimit) {
            break;
        }
        const type = String(node?.type || '').trim().toLowerCase();
        const spec = schemaMap.get(type);
        const fields = node?.fields && typeof node.fields === 'object' && !Array.isArray(node.fields)
            ? node.fields
            : {};
        const keyColumns = Array.from(new Set([
            ...(
                Array.isArray(spec?.primaryKeyColumns)
                    ? spec.primaryKeyColumns.map(column => String(column || '').trim()).filter(Boolean)
                    : []
            ),
            ...(
                Array.isArray(spec?.requiredColumns)
                    ? spec.requiredColumns.map(column => String(column || '').trim()).filter(Boolean)
                    : []
            ),
        ]));
        const keyValues = {};
        for (const column of keyColumns) {
            const value = toDisplayScalar(fields[column]);
            if (value) {
                keyValues[column] = value;
            }
        }
        rows.push({
            id: String(node?.id || ''),
            type,
            title: String(node?.title || ''),
            to_seq: Number(node?.seqTo ?? 0),
            semantic_depth: Number(node?.semanticDepth ?? node?.metadata?.semantic_depth ?? 0),
            parent_id: String(node?.parentId || ''),
            child_count: Array.isArray(node?.childrenIds) ? node.childrenIds.length : 0,
            editable: Boolean(spec?.editable),
            key_values: keyValues,
        });
    }
    return rows;
}

function buildJsonXmlSection(tag, value) {
    const name = String(tag || '').trim();
    const safeTag = name || 'data';
    const jsonText = JSON.stringify(value ?? {});
    return [
        `  <${safeTag}>`,
        `    ${jsonText}`,
        `  </${safeTag}>`,
    ].join('\n');
}

function buildRawXmlTag(tag, value, indent = '    ') {
    const safeTag = String(tag || '').trim() || 'value';
    const body = String(value ?? '');
    return [
        `${indent}<${safeTag}>`,
        `${indent}  ${body}`,
        `${indent}</${safeTag}>`,
    ].join('\n');
}

function buildExtractInputXml(requiredTypes, graphData, messages) {
    const safeRequiredTypes = Array.isArray(requiredTypes)
        ? requiredTypes.map(item => normalizeText(item).toLowerCase()).filter(Boolean)
        : [];
    const safeGraphData = graphData && typeof graphData === 'object' ? graphData : { initialized: false, nodes: [] };
    const safeMessages = Array.isArray(messages) ? messages : [];

    const requiredTypeXml = safeRequiredTypes.length > 0
        ? safeRequiredTypes.map(type => `    <type>${type}</type>`).join('\n')
        : '    <type>(none)</type>';

    const messageXml = safeMessages.map(message => {
        const seq = String(Number(message?.seq || 0));
        const roleRaw = String(message?.role || '').trim().toLowerCase() === 'assistant' ? 'Assistant' : 'User';
        const nameRaw = String(message?.name || '');
        const speaker = nameRaw ? `${roleRaw}: ${nameRaw}` : roleRaw;
        return [
            '    <message>',
            `      <seq>${seq}</seq>`,
            `      <role>${roleRaw}</role>`,
            buildRawXmlTag('name', nameRaw, '      '),
            buildRawXmlTag('speaker', speaker, '      '),
            buildRawXmlTag('text', String(message?.text || ''), '      '),
            '    </message>',
        ].join('\n');
    }).join('\n');

    return [
        '<extract_input>',
        '  <input_guide>Below are the extraction inputs. graph_data is the current semantic memory graph state for extraction.</input_guide>',
        '  <input_guide>Visibility policy matches core injection for hierarchical types: when parent exists, expose parent instead of child leaf to avoid context explosion.</input_guide>',
        '  <input_guide>Non-hierarchical types are exposed as full semantic nodes.</input_guide>',
        '  <input_guide>If graph_data.initialized=false, treat graph as uninitialized and prefer create operations over edit/delete.</input_guide>',
        '  <input_guide>required_types are hard-required types for this batch.</input_guide>',
        '  <input_guide>dialogue_batch is the current source dialogue to extract from.</input_guide>',
        buildJsonXmlSection('graph_data', safeGraphData),
        '  <required_types>',
        requiredTypeXml,
        '  </required_types>',
        '  <dialogue_batch>',
        messageXml,
        '  </dialogue_batch>',
        '</extract_input>',
    ].join('\n');
}

function buildRecallRouteInputXml({
    recallQueryContext = {},
    candidateNodes = [],
    alwaysInjectNodeIds = [],
    schemaOverview = [],
    selectionConstraints = {},
} = {}) {
    return [
        '<recall_route_input>',
        '  <input_guide>Plan recall route from the data blocks below. Use node ids from candidate_nodes only.</input_guide>',
        '  <input_guide>always_inject_node_ids are injected separately; never include them in selected_node_ids.</input_guide>',
        buildJsonXmlSection('recall_query_context', recallQueryContext),
        buildJsonXmlSection('candidate_nodes', candidateNodes),
        buildJsonXmlSection('always_inject_node_ids', alwaysInjectNodeIds),
        buildJsonXmlSection('schema_overview', schemaOverview),
        buildJsonXmlSection('selection_constraints', selectionConstraints),
        '</recall_route_input>',
    ].join('\n');
}

function buildRecallFinalizeInputXml({
    recallQueryContext = {},
    candidateNodes = [],
    alwaysInjectNodeIds = [],
    routeResult = {},
    selectionConstraints = {},
} = {}) {
    return [
        '<recall_finalize_input>',
        '  <input_guide>Finalize selected node ids for injection from candidate_nodes.</input_guide>',
        '  <input_guide>always_inject_node_ids are injected separately; never include them in selected_node_ids.</input_guide>',
        buildJsonXmlSection('recall_query_context', recallQueryContext),
        buildJsonXmlSection('candidate_nodes', candidateNodes),
        buildJsonXmlSection('always_inject_node_ids', alwaysInjectNodeIds),
        buildJsonXmlSection('route_result', routeResult),
        buildJsonXmlSection('selection_constraints', selectionConstraints),
        '</recall_finalize_input>',
    ].join('\n');
}

async function extractNodesWithLLM(context, store, settings, schema, messageBatch, options = {}) {
    const messages = (Array.isArray(messageBatch) ? messageBatch : [])
        .map(item => ({
            seq: Number(item?.seq || 0),
            role: item?.is_user ? 'user' : 'assistant',
            name: String(item?.name || ''),
            text: String(item?.mes || ''),
        }))
        .filter(item => normalizeText(item.text));
    if (messages.length === 0) {
        return [];
    }

    const resolvedApiPresetName = String(settings.extractApiPresetName || '').trim();
    const requestApi = resolveRequestApiFromConnectionProfileName(context, resolvedApiPresetName);
    const promptPresetName = String(settings.extractPresetName || '').trim();
    const forceUpdateTypes = new Set(
        schema
            .filter(item => item && typeof item === 'object' && item.forceUpdate)
            .map(item => String(item.id || '').trim().toLowerCase())
            .filter(Boolean),
    );
    const editableTypeSet = new Set(
        schema
            .filter(item => item && typeof item === 'object' && item.editable)
            .map(item => String(item.id || '').trim().toLowerCase())
            .filter(Boolean),
    );
    const extractionMaxSeq = Number.isFinite(Number(options?.maxSeq))
        ? Math.max(0, Math.floor(Number(options.maxSeq)))
        : null;
    const rebuildCreateOnly = Boolean(options?.rebuildCreateOnly);
    const graphNodes = rebuildCreateOnly
        ? []
        : buildGraphNodeHints(store, schema, 0, { maxSeq: extractionMaxSeq });
    const semanticNodeTotal = rebuildCreateOnly
        ? 0
        : listNodesByLevel(store, LEVEL.SEMANTIC)
            .filter(node => !node?.archived)
            .filter(node => !isRecallDiagnosticNode(node))
            .filter((node) => {
                if (extractionMaxSeq === null) {
                    return true;
                }
                const seq = Number(node?.seqTo ?? NaN);
                return !Number.isFinite(seq) || seq <= extractionMaxSeq;
            })
            .length;
    const graphDataPayload = rebuildCreateOnly
        ? {
            initialized: false,
            editable_type_ids: [],
            projection_policy: {
                hierarchical_types: 'core_like_parent_preferred',
                non_hierarchical_types: 'full',
            },
            semantic_node_total: 0,
            visible_node_count: 0,
            nodes: [],
        }
        : {
            initialized: graphNodes.length > 0,
            editable_type_ids: Array.from(editableTypeSet.values()),
            projection_policy: {
                hierarchical_types: 'core_like_parent_preferred',
                non_hierarchical_types: 'full',
            },
            semantic_node_total: semanticNodeTotal,
            visible_node_count: graphNodes.length,
            nodes: graphNodes,
        };
    const promptMessages = buildPresetAwareLLMMessages(context, settings, {
        api: requestApi,
        systemPrompt: String(settings.extractSystemPrompt || '').trim() || DEFAULT_EXTRACT_SYSTEM_PROMPT,
        userPrompt: buildExtractInputXml(
            Array.from(forceUpdateTypes),
            graphDataPayload,
            messages,
        ),
        includeCharacterCard: true,
        promptPresetName,
    });
    const { tools, specByToolName } = buildDynamicExtractTools(schema, {
        allowEditDelete: !rebuildCreateOnly,
    });
    const allowedNames = new Set(['luker_rpg_extract_done', ...specByToolName.keys()]);
    const apiSettingsOverride = buildApiSettingsOverrideFromConnectionProfileName(
        resolvedApiPresetName,
        String(context?.chatCompletionSettings?.chat_completion_source || ''),
    );
    const semanticRetries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
    const editableNodes = new Map(
        listNodesByLevel(store, LEVEL.SEMANTIC)
            .filter((node) => {
                if (!node || node.archived || !node.id) {
                    return false;
                }
                if (extractionMaxSeq !== null) {
                    const seq = Number(node?.seqTo ?? NaN);
                    if (Number.isFinite(seq) && seq > extractionMaxSeq) {
                        return false;
                    }
                }
                const type = String(node?.type || '').trim().toLowerCase();
                return editableTypeSet.has(type);
            })
            .map(node => [String(node.id), node]),
    );
    let validatedOps = [];
    let retryReason = '';
    let lastRetryableError = null;
    for (let attempt = 0; attempt <= semanticRetries; attempt++) {
        const reminderText = attempt > 0
            ? `Previous response was incomplete. Return COMPLETE extraction tool calls in one response: at least one type tool call and exactly one final luker_rpg_extract_done as the last call.${retryReason ? ` Fix: ${retryReason}` : ''}`
            : '';
        const requestPromptMessages = reminderText
            ? mergeUserAddendumIntoPromptMessages(promptMessages, reminderText, 'retry_requirements')
            : promptMessages;
        let calls = [];
        try {
            calls = await requestToolCallsWithRetry(settings, requestPromptMessages, {
                tools,
                allowedNames,
                llmPresetName: promptPresetName,
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
                retriesOverride: 0,
                abortSignal: options?.abortSignal || null,
            });
        } catch (error) {
            if (isAbortError(error, options?.abortSignal || null)) {
                throw error;
            }
            if (attempt >= semanticRetries) {
                throw error;
            }
            lastRetryableError = error;
            retryReason = `request_error: ${String(error?.message || error)}`;
            console.warn(`[${MODULE_NAME}] Extract request failed. Retrying semantic pass (${attempt + 1}/${semanticRetries})...`, error);
            continue;
        }
        if (!Array.isArray(calls) || calls.length < 2) {
            retryReason = 'Tool calls are missing or incomplete.';
            continue;
        }
            const names = calls.map(call => String(call?.name || '').trim()).filter(Boolean);
            const doneCount = names.filter(name => name === 'luker_rpg_extract_done').length;
            if (doneCount < 1) {
                continue;
            }
            if (names[names.length - 1] !== 'luker_rpg_extract_done') {
                retryReason = 'luker_rpg_extract_done must be the last call.';
                continue;
            }
            const typeCalls = calls.filter(call => specByToolName.has(String(call?.name || '')));
            if (typeCalls.length < 1) {
                retryReason = 'No semantic type tool call found.';
                continue;
            }
            const ops = [];
            const calledTypes = new Set();
            let invalid = false;
            for (const call of typeCalls) {
                const toolName = String(call?.name || '');
                const specEntry = specByToolName.get(toolName);
                if (!specEntry) {
                    continue;
                }
                const spec = { ...specEntry };
                if (spec.op === 'delete') {
                    const deletion = buildDeleteFromDynamicToolCall(call, spec);
                    if (!deletion.payload) {
                        invalid = true;
                        retryReason = `Delete call invalid for "${spec.id}": ${deletion.invalidReason}`;
                        break;
                    }
                    const mappedNodeId = String(deletion.payload.nodeId || '').trim();
                    const targetNode = editableNodes.get(mappedNodeId);
                    if (!targetNode) {
                        invalid = true;
                        retryReason = `Unknown node_id "${mappedNodeId}". Use only ids from graph_data.nodes (editable nodes only).`;
                        break;
                    }
                    if (String(targetNode?.type || '').trim().toLowerCase() !== String(spec.id || '').trim().toLowerCase()) {
                        invalid = true;
                        retryReason = `node_id "${mappedNodeId}" type mismatch: expected "${spec.id}".`;
                        break;
                    }
                    ops.push(deletion.payload);
                    continue;
                }
                if (spec.op === 'link_upsert') {
                    const linkOp = buildLinkUpsertFromToolCall(call);
                    if (!linkOp.payload) {
                        invalid = true;
                        retryReason = `Link call invalid: ${linkOp.invalidReason}`;
                        break;
                    }
                    ops.push(linkOp.payload);
                    continue;
                }
                if (spec.op === 'edit') {
                    const editOp = buildEditFromDynamicToolCall(call, spec);
                    if (!editOp.payload) {
                        invalid = true;
                        retryReason = `Edit call invalid for "${spec.id}": ${editOp.invalidReason}`;
                        break;
                    }
                    const mappedNodeId = String(editOp.payload.nodeId || '').trim();
                    const targetNode = editableNodes.get(mappedNodeId);
                    if (!targetNode) {
                        invalid = true;
                        retryReason = `Unknown node_id "${mappedNodeId}". Use only ids from graph_data.nodes (editable nodes only).`;
                        break;
                    }
                    if (String(targetNode?.type || '').trim().toLowerCase() !== String(spec.id || '').trim().toLowerCase()) {
                        invalid = true;
                        retryReason = `node_id "${mappedNodeId}" type mismatch: expected "${spec.id}".`;
                        break;
                    }
                    calledTypes.add(String(spec.id || '').trim().toLowerCase());
                    ops.push(editOp.payload);
                    continue;
                }
                const mapped = buildCreateFromDynamicToolCall(call, spec);
                if (mapped.missingRequired.length > 0) {
                    invalid = true;
                    retryReason = `Type "${spec.id}" missing required columns: ${mapped.missingRequired.join(', ')}.`;
                    break;
                }
                const safeTypeId = String(spec.id || '').trim().toLowerCase();
                if (safeTypeId === 'event') {
                    if (!mapped.payload?.hasLinksProp) {
                        invalid = true;
                        retryReason = 'Event create must include links. Use links: [] with no_link_reason if no relation is grounded.';
                        break;
                    }
                    const eventLinkCount = Array.isArray(mapped.payload?.links) ? mapped.payload.links.length : 0;
                    const eventNoLinkReason = normalizeText(mapped.payload?.noLinkReason || '');
                    if (eventLinkCount === 0 && !eventNoLinkReason) {
                        invalid = true;
                        retryReason = 'Event create has empty links. Provide no_link_reason when no links are grounded.';
                        break;
                    }
                }
                if (mapped.payload) {
                    calledTypes.add(safeTypeId);
                    ops.push({
                        op: 'create',
                        ...mapped.payload,
                    });
                }
            }
            if (invalid) {
                continue;
            }
            const missingForceTypes = [...forceUpdateTypes].filter(typeId => !calledTypes.has(typeId));
            if (missingForceTypes.length > 0) {
                retryReason = `Missing force-update type tool calls: ${missingForceTypes.join(', ')}.`;
                continue;
            }
            if (ops.length < 1) {
                retryReason = 'No valid extraction operations found.';
                continue;
            }
        validatedOps = ops;
        break;
    }
    if (validatedOps.length > 0) {
        return validatedOps;
    }
    const failureReason = normalizeText(retryReason || String(lastRetryableError?.message || '')) || 'No valid extraction tool calls after retries.';
    throw new Error(failureReason);
}

function upsertSemanticNode(store, item, settings = null, options = {}) {
    const type = String(item.type || 'semantic').toLowerCase();
    let title = normalizeText(item.title || '');
    const explicitNodeId = normalizeText(item?.nodeId || item?.node_id || '');
    const maxSeqLimit = Number.isFinite(Number(options?.maxSeq))
        ? Math.max(0, Math.floor(Number(options.maxSeq)))
        : null;
    const isNodeVisibleAtSeq = (node) => {
        if (!node || node.archived || node.level !== LEVEL.SEMANTIC) {
            return false;
        }
        if (maxSeqLimit === null) {
            return true;
        }
        const nodeSeq = Number(node?.seqTo ?? NaN);
        if (!Number.isFinite(nodeSeq)) {
            return true;
        }
        return nodeSeq <= maxSeqLimit;
    };
    const parseEventSummaryIndex = (value) => {
        const text = normalizeText(value || '');
        if (!text) {
            return null;
        }
        const match = text.match(/^(?:summary|摘要)\s*#?\s*(\d+)$/i);
        if (!match) {
            return null;
        }
        const num = Number(match[1]);
        return Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
    };
    const nextEventSummaryTitle = () => {
        let maxIndex = 0;
        for (const node of Object.values(store.nodes || {})) {
            if (!node || node.archived || node.level !== LEVEL.SEMANTIC) {
                continue;
            }
            if (String(node.type || '').toLowerCase() !== 'event') {
                continue;
            }
            const index = parseEventSummaryIndex(node.title);
            if (index && index > maxIndex) {
                maxIndex = index;
            }
        }
        return `Summary ${maxIndex + 1}`;
    };
    const seqTo = Number.isFinite(Number(item.seqTo))
        ? Math.max(0, Math.floor(Number(item.seqTo)))
        : Math.max(0, Number(store.seqCounter || 0));
    const incomingFields = item?.fields && typeof item.fields === 'object' && !Array.isArray(item.fields)
        ? { ...item.fields }
        : {};
    const itemSummary = normalizeText(
        incomingFields.summary
        ?? '',
    );
    const latestOnlyConfig = settings ? getSemanticLatestOnlyConfig(settings, type) : { enabled: false, keyFields: [] };
    const latestOnlyKeyFields = Array.isArray(latestOnlyConfig.keyFields)
        ? latestOnlyConfig.keyFields.map(column => String(column || '').trim()).filter(Boolean)
        : [];
    const tokenizePrimaryKeyField = (fieldsObject, key) => {
        const fields = fieldsObject && typeof fieldsObject === 'object' && !Array.isArray(fieldsObject)
            ? fieldsObject
            : {};
        const raw = toDisplayScalar(fields[key]);
        if (!raw) {
            return [];
        }
        return String(raw)
            .split(/[,，;；|]/g)
            .map(part => normalizeText(part).toLowerCase())
            .filter(Boolean);
    };
    const computeLatestOnlyMatchScore = (candidateFields) => {
        if (latestOnlyKeyFields.length === 0) {
            return 0;
        }
        let score = 0;
        for (const key of latestOnlyKeyFields) {
            const incomingTokens = tokenizePrimaryKeyField(incomingFields, key);
            const candidateTokens = tokenizePrimaryKeyField(candidateFields, key);
            if (incomingTokens.length === 0 || candidateTokens.length === 0) {
                continue;
            }
            const candidateSet = new Set(candidateTokens);
            if (incomingTokens.some(token => candidateSet.has(token))) {
                score += 1;
            }
        }
        return score;
    };

    let target = null;
    if (explicitNodeId) {
        const explicitTarget = store?.nodes?.[explicitNodeId];
        if (
            isNodeVisibleAtSeq(explicitTarget)
            && String(explicitTarget.type || '').toLowerCase() === type
        ) {
            target = explicitTarget;
        }
    }

    if (type === 'event' && !target) {
        const generatedTitle = nextEventSummaryTitle();
        return createNode(store, {
            type,
            level: LEVEL.SEMANTIC,
            title: generatedTitle,
            fields: incomingFields,
            semanticDepth: 0,
            semanticRollup: false,
            seqTo,
        });
    }

    if (!title) {
        const derivedTitle = normalizeText(
            incomingFields?.name
            || incomingFields?.id
            || incomingFields?.key
            || incomingFields?.label
            || '',
        );
        title = derivedTitle || `${type}_${Math.max(1, seqTo || Number(store.seqCounter || 0) || 1)}`;
    }
    if (!target && latestOnlyConfig.enabled) {
        const candidates = Object.values(store.nodes)
            .filter(node => isNodeVisibleAtSeq(node))
            .filter(node => String(node.type || '').toLowerCase() === type)
            .map(node => ({ node, score: computeLatestOnlyMatchScore(node?.fields) }))
            .filter(entry => entry.score > 0)
            .sort((a, b) => {
                if (a.score !== b.score) {
                    return b.score - a.score;
                }
                const aSeq = Number(a?.node?.seqTo ?? -1);
                const bSeq = Number(b?.node?.seqTo ?? -1);
                if (aSeq !== bSeq) {
                    return bSeq - aSeq;
                }
                return String(a?.node?.id || '').localeCompare(String(b?.node?.id || ''));
            });
        target = candidates[0]?.node || null;
        for (let i = 1; i < candidates.length; i++) {
            archiveNode(store, candidates[i]?.node?.id);
        }
    } else if (!target) {
        const normalizedKey = `${type}::${title.toLowerCase()}`;
        target = Object.values(store.nodes).find(node => isNodeVisibleAtSeq(node) && `${node.type}::${node.title.toLowerCase()}` === normalizedKey);
    }

    if (!target) {
        target = createNode(store, {
            type,
            level: LEVEL.SEMANTIC,
            title,
            fields: incomingFields,
            semanticDepth: 0,
            semanticRollup: false,
            seqTo,
        });
    } else {
        setNodeSummary(target, itemSummary || getNodeSummary(target));
        if (!target.fields || typeof target.fields !== 'object' || Array.isArray(target.fields)) {
            target.fields = {};
        }
        if (!Number.isFinite(Number(target.semanticDepth))) {
            target.semanticDepth = 0;
        }
        if (target.semanticRollup === undefined) {
            target.semanticRollup = false;
        }
        if (incomingFields && typeof incomingFields === 'object') {
            Object.assign(target.fields, incomingFields);
        }
        target.seqTo = Math.max(Number(target.seqTo || 0), seqTo);
    }

    return target;
}

function resolveExtractNodeId(store, {
    nodeId = '',
    ref = '',
} = {}, options = {}) {
    const normalizedNodeId = normalizeText(nodeId || '');
    if (normalizedNodeId) {
        const directNode = store?.nodes?.[normalizedNodeId];
        if (directNode && !directNode.archived && directNode.level === LEVEL.SEMANTIC) {
            return normalizedNodeId;
        }
    }
    const normalizedRef = normalizeText(ref || '');
    if (!normalizedRef) {
        return '';
    }
    const refIndex = options?.refIndex instanceof Map ? options.refIndex : null;
    if (!refIndex) {
        return '';
    }
    const refNodeId = normalizeText(refIndex.get(normalizedRef) || '');
    if (!refNodeId) {
        return '';
    }
    const mappedNode = store?.nodes?.[refNodeId];
    if (!mappedNode || mappedNode.archived || mappedNode.level !== LEVEL.SEMANTIC) {
        return '';
    }
    return refNodeId;
}

function applyExtractedLinks(store, sourceNode, rawLinks, defaultSeqRange = { seqTo: 0 }, options = {}) {
    if (!sourceNode || !Array.isArray(rawLinks) || rawLinks.length === 0) {
        return;
    }

    for (const link of rawLinks) {
        const targetNodeId = resolveExtractNodeId(store, {
            nodeId: link?.targetNodeId || link?.target_node_id || '',
            ref: link?.targetRef || link?.target_ref || '',
        }, options);
        if (!targetNodeId) {
            continue;
        }
        const targetNode = store?.nodes?.[targetNodeId];
        if (!targetNode || targetNode.archived || targetNode.level !== LEVEL.SEMANTIC) {
            continue;
        }

        const relation = normalizeText(link?.relation || 'related') || 'related';
        const direction = String(link?.direction || 'bidirectional').toLowerCase();

        if (direction === 'incoming') {
            addEdge(store, targetNode.id, sourceNode.id, relation);
            continue;
        }
        if (direction === 'outgoing') {
            addEdge(store, sourceNode.id, targetNode.id, relation);
            continue;
        }

        addEdge(store, sourceNode.id, targetNode.id, relation);
        addEdge(store, targetNode.id, sourceNode.id, relation);
    }
}

function getSemanticNodesForType(store, type) {
    const targetType = String(type || '').toLowerCase();
    return listNodesByLevel(store, LEVEL.SEMANTIC)
        .filter(node => !node.archived)
        .filter(node => String(node.type || '').toLowerCase() === targetType);
}

function createCompressionStats() {
    return {
        totalRounds: 0,
        byType: {},
    };
}

function recordCompressionRound(stats, type, rounds = 1) {
    if (!stats || typeof stats !== 'object') {
        return;
    }
    const safeType = String(type || '').trim().toLowerCase();
    const safeRounds = Math.max(0, Math.floor(Number(rounds) || 0));
    if (!safeType || safeRounds <= 0) {
        return;
    }
    stats.totalRounds = Math.max(0, Math.floor(Number(stats.totalRounds || 0))) + safeRounds;
    if (!stats.byType || typeof stats.byType !== 'object') {
        stats.byType = {};
    }
    stats.byType[safeType] = Math.max(0, Math.floor(Number(stats.byType[safeType] || 0))) + safeRounds;
}

function getCompressionRoundsByType(stats, type) {
    const safeType = String(type || '').trim().toLowerCase();
    if (!safeType || !stats || typeof stats !== 'object' || !stats.byType || typeof stats.byType !== 'object') {
        return 0;
    }
    return Math.max(0, Math.floor(Number(stats.byType[safeType] || 0)));
}

function collectSemanticRootsByDepth(store, type, depth, options = {}) {
    const maxSeq = Number.isFinite(Number(options?.maxSeq)) ? Math.max(0, Math.floor(Number(options.maxSeq))) : null;
    return getSemanticNodesForType(store, type)
        .filter(node => Number(node?.semanticDepth ?? 0) === Number(depth))
        .filter(node => !String(node.parentId || '').trim())
        .filter(node => maxSeq === null || Number(node?.seqTo ?? 0) <= maxSeq)
        .sort((a, b) => {
            const aTo = Number(a.seqTo ?? 0);
            const bTo = Number(b.seqTo ?? 0);
            if (aTo !== bTo) {
                return aTo - bTo;
            }
            return String(a?.id || '').localeCompare(String(b?.id || ''));
        });
}

function getNextSemanticRollupOrdinal(store, type, depth) {
    const targetDepth = Math.max(1, Math.floor(Number(depth || 0)));
    const nodes = getSemanticNodesForType(store, type)
        .filter(node => !node.archived)
        .filter(node => Number(node?.semanticDepth ?? 0) === targetDepth);
    let maxOrdinal = 0;
    const suffixPattern = /#(\d+)\s*$/;
    for (const node of nodes) {
        const title = String(node?.title || '');
        const match = title.match(suffixPattern);
        if (!match) {
            continue;
        }
        const value = Number(match[1]);
        if (Number.isFinite(value) && value > maxOrdinal) {
            maxOrdinal = value;
        }
    }
    if (maxOrdinal > 0) {
        return maxOrdinal + 1;
    }
    return nodes.length + 1;
}

async function compressSemanticHierarchical(context, store, settings, type, config, options = {}) {
    let changed = false;
    let guard = 0;
    let compressedRounds = 0;
    const forceMode = Boolean(options?.force);
    const maxRoundsPerType = Number.isFinite(Number(options?.maxRoundsPerType))
        ? Math.max(1, Math.floor(Number(options.maxRoundsPerType)))
        : Number.POSITIVE_INFINITY;
    const threshold = forceMode
        ? 2
        : Math.max(2, Number(config.threshold || 2));
    const fanIn = Math.max(2, Number(config.fanIn || 2));

    for (let depth = 0; depth < Number(config.maxDepth || 1); depth++) {
        while (guard < 120 && compressedRounds < maxRoundsPerType) {
            if (isAbortSignalLike(options?.abortSignal) && options.abortSignal.aborted) {
                throw new DOMException('Memory compression aborted.', 'AbortError');
            }
            guard += 1;
            let candidates = collectSemanticRootsByDepth(store, type, depth, options);
            if (!forceMode && depth === 0 && Number(config.keepRecentLeaves || 0) > 0 && candidates.length > Number(config.keepRecentLeaves || 0)) {
                candidates = candidates.slice(0, Math.max(0, candidates.length - Number(config.keepRecentLeaves || 0)));
            }
            if (candidates.length < threshold) {
                break;
            }

            const groupSize = forceMode ? Math.min(fanIn, candidates.length) : fanIn;
            if (groupSize < 2) {
                break;
            }
            const group = candidates.slice(0, groupSize);
            if (group.length < groupSize || group.length < 2) {
                break;
            }

            const lines = group.map(node => `${node.title}: ${getNodeSummary(node)}`);
            const instruction = buildCompressionSummaryInstruction(
                config.summarizeInstruction
                || `Compress semantic type "${type}" into a higher-level summary node. Keep enduring facts and unresolved hooks.`,
            );
            const summary = await summarizeTextWithLLM(
                context,
                settings,
                instruction,
                lines,
                options?.abortSignal || null,
            );
            if (!summary) {
                break;
            }

            const rollupDepth = depth + 1;
            const rollupOrdinal = getNextSemanticRollupOrdinal(store, type, rollupDepth);
            const parent = createNode(store, {
                type: String(type || 'semantic'),
                level: LEVEL.SEMANTIC,
                title: `${String(config.label || type || 'Semantic')} Summary L${rollupDepth} #${rollupOrdinal}`,
                fields: { summary },
                archived: false,
                semanticRollup: true,
                semanticDepth: rollupDepth,
                seqTo: Math.max(...group.map(node => Number(node.seqTo ?? 0))),
            });

            for (const child of group) {
                reparentNode(store, child.id, parent.id);
                addEdge(store, parent.id, child.id, 'semantic_contains');
            }
            changed = true;
            compressedRounds += 1;
            recordCompressionRound(options?.compressionStats, type, 1);
        }
        if (compressedRounds >= maxRoundsPerType) {
            break;
        }
    }

    return changed;
}

async function compressSemanticTypesIfNeeded(context, store, settings, options = {}) {
    const schema = getEffectiveNodeTypeSchema(context, settings);
    const selectedTypeSet = Array.isArray(options?.typeIds)
        ? new Set(options.typeIds.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))
        : null;
    let changed = false;
    for (const spec of schema) {
        const type = String(spec.id || '').toLowerCase();
        if (!type) {
            continue;
        }
        if (selectedTypeSet && !selectedTypeSet.has(type)) {
            continue;
        }
        const config = getSemanticCompressionConfig(settings, type, context);
        if (config.mode === 'none') {
            continue;
        }
        if (config.mode === 'hierarchical') {
            if (await compressSemanticHierarchical(context, store, settings, type, config, options)) {
                changed = true;
            }
        }
    }
    return changed;
}

async function runCompressionLoop(context, store, settings, options = {}) {
    return await compressSemanticTypesIfNeeded(context, store, settings, options);
}

function buildExtractBatchFromFrames(frames, batchStartIndex, batchEndIndex, contextTurns = 1) {
    const source = Array.isArray(frames) ? frames : [];
    const safeStart = Math.max(0, Math.min(source.length - 1, Math.floor(Number(batchStartIndex) || 0)));
    const safeEnd = Math.max(safeStart, Math.min(source.length - 1, Math.floor(Number(batchEndIndex) || safeStart)));
    const windowSize = Math.max(1, Math.min(32, Math.floor(Number(contextTurns) || 1)));
    const contextStartIndex = Math.max(0, safeStart - windowSize);
    const rangeStart = contextStartIndex;
    const rangeEnd = safeEnd;
    const batch = [];

    for (let i = rangeStart; i <= rangeEnd; i++) {
        const frame = source[i];
        if (!frame || typeof frame !== 'object') {
            continue;
        }
        const seq = Number(frame?.seq || 0);
        const lastUserText = normalizeText(frame?.last_user_mes || '');
        if (lastUserText) {
            batch.push({
                seq,
                is_user: true,
                name: String(frame?.last_user_name || ''),
                mes: lastUserText,
                send_date: String(frame?.last_user_send_date || ''),
            });
        }
        const assistantText = normalizeText(frame?.mes || '');
        if (!assistantText) {
            continue;
        }
        batch.push({
            seq,
            is_user: Boolean(frame?.is_user),
            name: String(frame?.name || ''),
            mes: assistantText,
            send_date: String(frame?.send_date || ''),
        });
    }

    return batch;
}

async function processPendingMessageBatchWithLLM(context, store, settings, schema, frames, batchStartIndex, batchEndIndex, options = {}) {
    const source = Array.isArray(frames) ? frames : [];
    const safeStart = Math.max(0, Math.min(source.length - 1, Math.floor(Number(batchStartIndex) || 0)));
    const safeEnd = Math.max(safeStart, Math.min(source.length - 1, Math.floor(Number(batchEndIndex) || safeStart)));
    const endFrame = source[safeEnd];
    if (!endFrame || typeof endFrame !== 'object') {
        return false;
    }
    const extractBatch = [];
    const contextTurns = Math.max(1, Math.min(32, Number(settings?.extractContextTurns || 1)));
    extractBatch.push(...buildExtractBatchFromFrames(frames, safeStart, safeEnd, contextTurns));
    const endFrameSeq = Number(endFrame?.seq || 0);
    const extractionMaxSeq = Number.isFinite(endFrameSeq) ? Math.max(0, Math.floor(endFrameSeq)) : null;
    const operations = await extractNodesWithLLM(context, store, settings, schema, extractBatch, {
        maxSeq: extractionMaxSeq,
        abortSignal: options?.abortSignal || null,
        rebuildCreateOnly: Boolean(options?.rebuildCreateOnly),
    });
    if (operations.length === 0) {
        return false;
    }

    const extractionRefIndex = new Map();
    const pendingLinkJobs = [];

    for (const item of operations) {
        const op = String(item?.op || 'create').trim().toLowerCase();
        if (op === 'delete') {
            const nodeId = String(item?.nodeId || '').trim();
            if (nodeId && store?.nodes?.[nodeId]) {
                dropNode(store, nodeId, true);
            }
            continue;
        }
        if (op === 'edit') {
            const nodeId = String(item?.nodeId || '').trim();
            const targetNode = nodeId ? store?.nodes?.[nodeId] : null;
            if (!targetNode || targetNode.archived || targetNode.level !== LEVEL.SEMANTIC) {
                continue;
            }
            if (String(targetNode.type || '').toLowerCase() !== String(item?.type || '').toLowerCase()) {
                continue;
            }
            const setFields = item?.setFields && typeof item.setFields === 'object' && !Array.isArray(item.setFields)
                ? item.setFields
                : {};
            const clearFields = Array.isArray(item?.clearFields)
                ? item.clearFields.map(key => String(key || '').trim()).filter(Boolean)
                : [];
            const evidence = buildEvidenceSeqRange(item, extractBatch);
            if (!targetNode.fields || typeof targetNode.fields !== 'object' || Array.isArray(targetNode.fields)) {
                targetNode.fields = {};
            }
            if (Boolean(item?.hasTitlePatch)) {
                const patchedTitle = normalizeText(item?.title || '');
                if (patchedTitle) {
                    targetNode.title = patchedTitle;
                }
            }
            for (const [key, value] of Object.entries(setFields)) {
                if (value === undefined || value === null) {
                    continue;
                }
                targetNode.fields[key] = value;
            }
            for (const key of clearFields) {
                delete targetNode.fields[key];
            }
            targetNode.seqTo = Math.max(Number(targetNode.seqTo || 0), Number(evidence.seqTo || 0));
            continue;
        }
        if (op === 'link_upsert') {
            const evidence = buildEvidenceSeqRange(item, extractBatch);
            pendingLinkJobs.push({
                sourceNodeId: normalizeText(item?.sourceNodeId || ''),
                sourceRef: normalizeText(item?.sourceRef || ''),
                links: Array.isArray(item?.links) ? item.links : [],
                evidence,
            });
            continue;
        }
        const type = String(item?.type || 'semantic').toLowerCase();
        const title = normalizeText(item?.title || '');
        if (!type) {
            continue;
        }
        const evidence = buildEvidenceSeqRange(item, extractBatch);
        const targetNode = upsertSemanticNode(store, {
            type,
            nodeId: String(item?.nodeId || ''),
            title,
            fields: item?.fields && typeof item.fields === 'object' ? item.fields : {},
            seqTo: evidence.seqTo,
        }, settings, { maxSeq: extractionMaxSeq });
        if (targetNode) {
            const ref = normalizeText(item?.ref || '');
            if (ref) {
                extractionRefIndex.set(ref, targetNode.id);
            }
            pendingLinkJobs.push({
                sourceNodeId: targetNode.id,
                sourceRef: '',
                links: Array.isArray(item?.links) ? item.links : [],
                evidence,
            });
        }
    }

    for (const job of pendingLinkJobs) {
        const sourceNodeId = resolveExtractNodeId(store, {
            nodeId: job?.sourceNodeId || '',
            ref: job?.sourceRef || '',
        }, { refIndex: extractionRefIndex });
        if (!sourceNodeId) {
            continue;
        }
        const sourceNode = store?.nodes?.[sourceNodeId];
        if (!sourceNode || sourceNode.archived || sourceNode.level !== LEVEL.SEMANTIC) {
            continue;
        }
        applyExtractedLinks(
            store,
            sourceNode,
            Array.isArray(job?.links) ? job.links : [],
            job?.evidence || { seqTo: 0 },
            { maxSeq: extractionMaxSeq, refIndex: extractionRefIndex },
        );
    }

    await runCompressionLoop(context, store, settings, {
        compressionStats: options?.compressionStats,
        maxSeq: extractionMaxSeq,
        abortSignal: options?.abortSignal || null,
    });
    return true;
}

async function runExtractionForStore(context, store, {
    force = false,
    startSeq = null,
    showCompressionToast = true,
    abortSignal = null,
    onBatchStart = null,
    rebuildCreateOnly = false,
} = {}) {
    const settings = getSettings();
    const window = computeExtractionWindow(context, store, startSeq);
    const frames = window.frames;
    const latestSeq = window.latestSeq;
    const coveredSeqTo = window.coveredSeqTo;
    if (coveredSeqTo !== Math.max(0, Math.floor(Number(store.appliedSeqTo || 0)))) {
        store.appliedSeqTo = coveredSeqTo;
    }
    const beginSeq = window.beginSeq;
    if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
        throw new DOMException('Memory extraction aborted.', 'AbortError');
    }
    if (beginSeq > latestSeq) {
        store.appliedSeqTo = latestSeq;
        store.seqCounter = latestSeq;
        store.lastExtractionDebug = {
            beginSeq,
            latestSeq,
            coveredSeqTo,
            extracted: false,
            reason: 'already_up_to_date',
            at: Date.now(),
        };
        return false;
    }

    if (!force) {
        const gap = Number(window.gap || 0);
        if (gap < Number(settings.updateEvery || 1)) {
            store.lastExtractionDebug = {
                beginSeq,
                latestSeq,
                coveredSeqTo,
                extracted: false,
                reason: 'gap_below_threshold',
                at: Date.now(),
            };
            return false;
        }
    }

    const schema = getEffectiveNodeTypeSchema(context, settings);
    const compressionStats = createCompressionStats();
    const frameErrorRetries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
    const extractBatchTurns = Math.max(
        1,
        Math.floor(Number(settings?.extractBatchTurns || defaultSettings.extractBatchTurns || 1)),
    );
    let extractedAny = false;
    for (let i = beginSeq - 1; i < frames.length; i += extractBatchTurns) {
        if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
            throw new DOMException('Memory extraction aborted.', 'AbortError');
        }
        const batchStartIndex = i;
        const batchEndIndex = Math.min(frames.length - 1, i + extractBatchTurns - 1);
        const startFrame = frames[batchStartIndex];
        const endFrame = frames[batchEndIndex];
        if (typeof onBatchStart === 'function') {
            onBatchStart({
                beginSeq: Number(startFrame?.seq || 0),
                endSeq: Number(endFrame?.seq || 0),
                latestSeq,
                batchStartIndex,
                batchEndIndex,
            });
        }
        let success = false;
        let lastFrameError = null;
        for (let attempt = 0; attempt <= frameErrorRetries; attempt++) {
            try {
                success = await processPendingMessageBatchWithLLM(
                    context,
                    store,
                    settings,
                    schema,
                    frames,
                    batchStartIndex,
                    batchEndIndex,
                    {
                        compressionStats,
                        abortSignal,
                        rebuildCreateOnly: Boolean(rebuildCreateOnly),
                    },
                );
                lastFrameError = null;
                break;
            } catch (error) {
                if (isAbortError(error, abortSignal)) {
                    throw error;
                }
                lastFrameError = error;
                if (attempt >= frameErrorRetries) {
                    throw error;
                }
                console.warn(
                    `[${MODULE_NAME}] Extraction batch failed (seq=${Number(startFrame?.seq || 0)}-${Number(endFrame?.seq || 0)}). Retrying (${attempt + 1}/${frameErrorRetries})...`,
                    error,
                );
            }
        }
        if (lastFrameError) {
            throw lastFrameError;
        }
        if (!success) {
            break;
        }
        extractedAny = true;
        store.appliedSeqTo = Math.max(Number(store.appliedSeqTo || 0), Number(endFrame?.seq || 0));
    }
    store.appliedSeqTo = Math.min(latestSeq, getSemanticCoverageSeq(store));
    store.seqCounter = store.appliedSeqTo;
    updateStoreSourceState(store, context);
    store.lastExtractionDebug = {
        beginSeq,
        latestSeq,
        coveredSeqTo,
        extracted: extractedAny,
        reason: extractedAny ? 'ok' : 'no_upserts',
        compression: compressionStats,
        at: Date.now(),
    };
    if (showCompressionToast) {
        notifyEventCompressionIfAny(compressionStats);
    }
    return extractedAny;
}

function formatNodeBrief(node, extra = {}) {
    return {
        id: node.id,
        level: node.level,
        type: node.type,
        title: node.title,
        summary: getNodeSummary(node),
        child_count: Array.isArray(node.childrenIds) ? node.childrenIds.length : 0,
        to_seq: node.seqTo ?? null,
        ...extra,
    };
}

function formatNodeDetail(node, extra = {}) {
    return {
        id: node.id,
        level: node.level,
        type: node.type,
        title: node.title,
        summary: getNodeSummary(node),
        fields: node.fields || {},
        semantic_depth: Number(node.semanticDepth || 0),
        semantic_rollup: Boolean(node.semanticRollup),
        children: Array.isArray(node.childrenIds) ? node.childrenIds : [],
        to_seq: node.seqTo ?? null,
        ...extra,
    };
}

function extractWorldInfoHints(payload) {
    const hints = [];
    const before = normalizeText(payload?.worldInfoBefore || '');
    const after = normalizeText(payload?.worldInfoAfter || '');
    if (before) hints.push(before);
    if (after) hints.push(after);

    const allActivated = payload?.worldInfoResolution?.allActivatedEntries;
    if (allActivated && typeof allActivated[Symbol.iterator] === 'function') {
        for (const entry of allActivated) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const raw = normalizeText(entry.comment || entry.content || entry.key || entry.keys || '');
            if (raw) {
                hints.push(raw);
            }
            if (hints.length >= 8) {
                break;
            }
        }
    }

    return hints;
}

function compareNodesByRecency(a, b) {
    const aSeq = Number(a?.seqTo ?? -1);
    const bSeq = Number(b?.seqTo ?? -1);
    if (aSeq !== bSeq) {
        return bSeq - aSeq;
    }
    const aDepth = Number(a?.semanticDepth ?? 0);
    const bDepth = Number(b?.semanticDepth ?? 0);
    if (aDepth !== bDepth) {
        return bDepth - aDepth;
    }
    return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function getSortedNodesByRecency(nodes) {
    return nodes
        .slice()
        .sort(compareNodesByRecency);
}

function getRecallQueryBundle(payload, context, settings = null) {
    const payloadMessages = Array.isArray(payload?.coreChat) ? payload.coreChat : null;
    const source = payloadMessages || context.chat || [];
    const recentLimit = Math.max(
        1,
        Math.min(
            64,
            Math.floor(Number(settings?.recallQueryMessages || defaultSettings.recallQueryMessages || 2)),
        ),
    );
    const recentMessages = [];
    let lastUser = '';
    let lastAssistant = '';

    for (let i = source.length - 1; i >= 0; i--) {
        const message = source[i];
        if (!message) {
            continue;
        }
        if (message.is_system) {
            continue;
        }
        const text = normalizeText(message.mes || '');
        if (text && recentMessages.length < recentLimit) {
            recentMessages.push({
                role: message.is_user ? 'user' : 'assistant',
                text,
            });
        }
        if (!lastUser && message.is_user) {
            lastUser = text;
            continue;
        }
        if (!lastAssistant && !message.is_user) {
            lastAssistant = text;
            continue;
        }
        if (lastUser && lastAssistant && recentMessages.length >= recentLimit) {
            break;
        }
    }
    recentMessages.reverse();
    const wiHints = extractWorldInfoHints(payload);
    const recentText = recentMessages
        .map(item => `${item.role}: ${item.text}`)
        .join('\n');
    const fullText = normalizeText([recentText, ...wiHints].join('\n'));
    return {
        last_user: normalizeText(lastUser),
        last_assistant: normalizeText(lastAssistant),
        recent_messages: recentMessages,
        wi_hints: wiHints,
        fullText,
    };
}

function getNodeRecallExposure(settings, node, context = null) {
    if (!node) {
        return 'high_only';
    }
    if (node.level !== LEVEL.SEMANTIC) {
        return 'high_only';
    }
    const config = getSemanticCompressionConfig(settings, node.type, context);
    if (config.mode === 'hierarchical') {
        return 'high_only';
    }
    return 'full';
}

function getNearestVisibleAncestorId(store, nodeId, visibleSet) {
    const target = String(nodeId || '').trim();
    if (!target) {
        return '';
    }
    const set = visibleSet instanceof Set ? visibleSet : new Set();
    let currentId = target;
    const guard = new Set();
    while (currentId && !guard.has(currentId)) {
        guard.add(currentId);
        const node = store?.nodes?.[currentId];
        if (!node || node.archived) {
            return '';
        }
        if (set.has(currentId)) {
            return currentId;
        }
        currentId = String(node.parentId || '').trim();
    }
    return '';
}

function buildProjectedEdges(store, {
    visibleNodeIds = null,
    relationTypes = null,
    excludeInternal = false,
} = {}) {
    const visibleSet = visibleNodeIds instanceof Set
        ? visibleNodeIds
        : Array.isArray(visibleNodeIds)
            ? new Set(visibleNodeIds.map(id => String(id || '').trim()).filter(Boolean))
            : new Set(
                Object.values(store?.nodes || {})
                    .filter(node => node && !node.archived)
                    .map(node => String(node.id || '').trim())
                    .filter(Boolean),
            );
    const relationAllow = Array.isArray(relationTypes) && relationTypes.length > 0
        ? new Set(relationTypes.map(type => normalizeText(type).toLowerCase()).filter(Boolean))
        : null;
    const internalEdgeTypes = new Set(['contains', 'semantic_contains']);
    const merged = new Map();
    for (const edge of store?.edges || []) {
        if (!edge) {
            continue;
        }
        const edgeType = normalizeText(edge.type || '').toLowerCase() || 'related';
        if (excludeInternal && internalEdgeTypes.has(edgeType)) {
            continue;
        }
        if (relationAllow && !relationAllow.has(edgeType)) {
            continue;
        }
        const fromVisible = getNearestVisibleAncestorId(store, edge.from, visibleSet);
        const toVisible = getNearestVisibleAncestorId(store, edge.to, visibleSet);
        if (!fromVisible || !toVisible || fromVisible === toVisible) {
            continue;
        }
        const key = `${fromVisible}::${toVisible}::${edgeType}`;
        const current = merged.get(key);
        if (!current) {
            merged.set(key, {
                from: fromVisible,
                to: toVisible,
                type: edgeType,
                weight: 1,
            });
            continue;
        }
        current.weight = Number(current.weight || 0) + 1;
    }
    return Array.from(merged.values());
}

function buildEdgeSummary(store, nodeId, { nodeSet = null, relationTypes = null, limit = 10 } = {}) {
    if (!nodeId) {
        return {
            degree: 0,
            relations: [],
            sample_neighbors: [],
        };
    }
    const visibleSet = nodeSet instanceof Set
        ? nodeSet
        : Array.isArray(nodeSet)
            ? new Set(nodeSet.map(id => String(id || '').trim()).filter(Boolean))
            : null;
    const projectedEdges = buildProjectedEdges(store, {
        visibleNodeIds: visibleSet,
        relationTypes,
        excludeInternal: false,
    });
    const byRelation = new Map();
    const neighborIds = new Set();
    let degree = 0;
    for (const edge of projectedEdges) {
        const edgeType = normalizeText(edge.type || '').toLowerCase() || 'related';
        let neighborId = '';
        let direction = '';
        if (edge.from === nodeId) {
            neighborId = String(edge.to || '');
            direction = 'out';
        } else if (edge.to === nodeId) {
            neighborId = String(edge.from || '');
            direction = 'in';
        } else {
            continue;
        }
        if (!neighborId) {
            continue;
        }
        if (visibleSet && !visibleSet.has(neighborId)) {
            continue;
        }
        if (!store.nodes[neighborId] || store.nodes[neighborId].archived) {
            continue;
        }
        const supportCount = Math.max(1, Number(edge?.weight || 1));
        degree += supportCount;
        neighborIds.add(neighborId);
        const key = `${edgeType}:${direction}`;
        byRelation.set(key, Number(byRelation.get(key) || 0) + supportCount);
    }
    const relationRows = Array.from(byRelation.entries())
        .map(([key, count]) => {
            const [relation, direction] = key.split(':');
            return { relation, direction, count };
        })
        .sort((a, b) => b.count - a.count);

    const sampleNeighbors = Array.from(neighborIds)
        .slice(0, Math.max(1, Number(limit || 10)))
        .map(id => {
            const node = store.nodes[id];
            return {
                id,
                type: String(node?.type || ''),
                title: String(node?.title || ''),
            };
        });

    return {
        degree,
        relations: relationRows,
        sample_neighbors: sampleNeighbors,
    };
}

function isRecallDiagnosticNode(node) {
    const type = String(node?.type || '').trim().toLowerCase();
    return type === 'recall' || type.startsWith('recall_');
}

function collectRootCandidates(store, settings, queryBundle = { fullText: '' }, alwaysInjectNodes = [], context = null) {
    void queryBundle;
    const schema = getEffectiveNodeTypeSchema(context, settings);
    const visibleRows = buildGraphNodeHints(store, schema, 0);
    const visibleNodes = visibleRows
        .map((row) => store?.nodes?.[String(row?.id || '')] || null)
        .filter((node) => Boolean(node) && !node.archived && !isRecallDiagnosticNode(node));
    const merged = [
        ...getSortedNodesByRecency(alwaysInjectNodes.filter(Boolean)),
        ...getSortedNodesByRecency(visibleNodes),
    ];
    const deduped = [];
    const seen = new Set();
    for (const node of merged) {
        const nodeId = String(node?.id || '');
        if (!nodeId || seen.has(nodeId)) {
            continue;
        }
        seen.add(nodeId);
        deduped.push(node);
    }
    return deduped;
}

function normalizeEdgeTypeList(rawTypes) {
    if (!Array.isArray(rawTypes)) {
        return ['related', 'involved_in', 'mentions', 'evidence', 'contains', 'updates', 'advances', 'occurred_at'];
    }
    const list = rawTypes.map(type => normalizeText(type).toLowerCase()).filter(Boolean);
    return list.length > 0 ? list : ['related', 'involved_in', 'mentions', 'evidence', 'contains', 'updates', 'advances', 'occurred_at'];
}

async function chooseRecallRoute(context, settings, recallState) {
    const routeSystemPrompt = String(settings?.recallRouteSystemPrompt || '').trim() || DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT;
    const alwaysInjectIds = Array.isArray(recallState?.alwaysInjectIds) ? recallState.alwaysInjectIds : [];
    const candidateSet = new Set((recallState.candidates || []).map(node => String(node?.id || '')).filter(Boolean));
    if (candidateSet.size === 0) {
        return {
            action: 'finalize',
            selected_node_ids: [],
            expand_plan: [],
            referenced_always_inject_ids: [],
            reason: 'No recall candidates.',
        };
    }
    const candidateRows = (recallState.candidates || []).map(node => {
        const row = formatNodeBrief(node, {
            exposure: getNodeRecallExposure(settings, node, context),
            edge_summary: buildEdgeSummary(recallState.store, node?.id, { nodeSet: candidateSet, limit: 8 }),
            always_inject: alwaysInjectIds.includes(String(node?.id || '')),
            fields: node?.fields && typeof node.fields === 'object' ? node.fields : {},
        });
        return row;
    });
    try {
        const parsed = await runFunctionCallTask(context, settings, {
            systemPrompt: routeSystemPrompt,
            userPrompt: buildRecallRouteInputXml({
                recallQueryContext: {
                    user_query_text: recallState.query,
                    recent_dialogue_context: recallState.queryBundle,
                },
                candidateNodes: candidateRows,
                alwaysInjectNodeIds: alwaysInjectIds,
                schemaOverview: getEffectiveNodeTypeSchema(context, settings).map(item => ({
                    id: item.id,
                    table_name: item.tableName,
                    table_columns: item.tableColumns,
                    required_columns: item.requiredColumns,
                    force_update: Boolean(item.forceUpdate),
                    always_inject: Boolean(item.alwaysInject),
                    editable: Boolean(item.editable),
                    compression_mode: String(item?.compression?.mode || 'none'),
                })),
                selectionConstraints: {
                    recent_message_window: Math.max(3, Number(settings.recentRawTurns || 5)),
                    injection_exclude_recent_messages: Math.max(0, Number(settings.recentRawTurns || 5)),
                    recall_query_recent_messages: Math.max(1, Number(settings.recallQueryMessages || defaultSettings.recallQueryMessages || 2)),
                },
            }),
            apiPresetName: settings.recallApiPresetName || '',
            promptPresetName: String(settings.recallPresetName || '').trim(),
            functionName: 'luker_rpg_recall_plan',
            functionDescription: 'Plan recall as finalize or drill with optional expansion plan.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['finalize', 'drill'] },
                    selected_node_ids: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                    expand_plan: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                seed_node_id: { type: 'string' },
                                relation_types: {
                                    type: 'array',
                                    items: { type: 'string' },
                                },
                                depth: { type: 'integer' },
                                include_children: { type: 'boolean' },
                            },
                            required: ['seed_node_id'],
                            additionalProperties: true,
                        },
                    },
                    referenced_always_inject_ids: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                    reason: { type: 'string' },
                },
                required: ['action'],
                additionalProperties: true,
            },
            abortSignal: recallState?.abortSignal || null,
        });
        return {
            action: String(parsed?.action || '').toLowerCase() === 'drill' ? 'drill' : 'finalize',
            selected_node_ids: Array.isArray(parsed?.selected_node_ids)
                ? parsed.selected_node_ids.map(id => String(id || '').trim()).filter(id => id && candidateSet.has(id))
                : [],
            expand_plan: Array.isArray(parsed?.expand_plan)
                ? parsed.expand_plan.map(item => ({
                    seed_node_id: String(item?.seed_node_id || '').trim(),
                    relation_types: normalizeEdgeTypeList(item?.relation_types),
                    depth: Math.max(1, Math.floor(Number(item?.depth) || 1)),
                    include_children: item?.include_children !== false,
                })).filter(item => item.seed_node_id && candidateSet.has(item.seed_node_id))
                : [],
            referenced_always_inject_ids: Array.isArray(parsed?.referenced_always_inject_ids)
                ? parsed.referenced_always_inject_ids.map(id => String(id || '').trim()).filter(Boolean)
                : [],
            reason: String(parsed?.reason || ''),
        };
    } catch (error) {
        console.warn(`[${MODULE_NAME}] recall route failed`, error);
        return {
            action: 'finalize',
            selected_node_ids: recallState.candidates.map(node => node.id),
            expand_plan: [],
            referenced_always_inject_ids: [],
            reason: 'Fallback route used.',
        };
    }
}

function addCandidate(candidateMap, node) {
    if (!node?.id) {
        return;
    }
    if (!candidateMap.has(node.id)) {
        candidateMap.set(node.id, node);
    }
}

function expandRouteCandidates(store, route, rootCandidates) {
    const candidateMap = new Map();
    const expandPlan = Array.isArray(route?.expand_plan) ? route.expand_plan : [];

    for (const node of rootCandidates) {
        addCandidate(candidateMap, node);
    }
    for (const request of expandPlan) {
        const seedId = String(request?.seed_node_id || '').trim();
        if (!seedId || !store.nodes[seedId]) {
            continue;
        }
        const relationTypes = normalizeEdgeTypeList(request?.relation_types);
        const depth = Math.max(1, Math.floor(Number(request?.depth) || 1));
        const includeChildren = request?.include_children !== false;
        const seen = new Set([seedId]);
        let frontier = [seedId];
        addCandidate(candidateMap, store.nodes[seedId]);
        for (let hop = 0; hop < depth; hop++) {
            if (frontier.length === 0) {
                break;
            }
            const visibleSet = new Set(candidateMap.keys());
            const projectedEdges = buildProjectedEdges(store, {
                visibleNodeIds: visibleSet,
                relationTypes,
                excludeInternal: false,
            });
            const next = [];
            for (const currentId of frontier) {
                const currentNode = store.nodes[currentId];
                if (!currentNode || currentNode.archived) {
                    continue;
                }
                if (includeChildren) {
                    for (const child of getChildren(store, currentId)) {
                        if (!child?.id || child.archived || seen.has(child.id)) {
                            continue;
                        }
                        seen.add(child.id);
                        addCandidate(candidateMap, child);
                        next.push(child.id);
                    }
                }
                for (const edge of projectedEdges) {
                    if (!edge) {
                        continue;
                    }
                    let neighborId = '';
                    if (edge.from === currentId) {
                        neighborId = String(edge.to || '');
                    } else if (edge.to === currentId) {
                        neighborId = String(edge.from || '');
                    } else {
                        continue;
                    }
                    if (!neighborId || seen.has(neighborId)) {
                        continue;
                    }
                    const neighbor = store.nodes[neighborId];
                    if (!neighbor || neighbor.archived) {
                        continue;
                    }
                    seen.add(neighborId);
                    addCandidate(candidateMap, neighbor);
                    next.push(neighborId);
                }
            }
            frontier = next;
        }
    }

    return Array.from(candidateMap.values());
}

async function chooseFocusNodes(context, settings, recallState) {
    const finalizeSystemPrompt = String(settings?.recallFinalizeSystemPrompt || '').trim() || DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT;
    const alwaysInjectIds = Array.isArray(recallState?.alwaysInjectIds) ? recallState.alwaysInjectIds : [];
    const candidateSet = new Set((recallState.candidates || []).map(node => String(node?.id || '')).filter(Boolean));
    if (candidateSet.size === 0) {
        return {
            selected_node_ids: [],
            reason: 'No recall candidates.',
        };
    }
    const detailRows = (recallState.candidates || []).map(node => {
        const row = formatNodeDetail(node, {
            exposure: getNodeRecallExposure(settings, node, context),
            edge_summary: buildEdgeSummary(recallState.store, node?.id, { nodeSet: candidateSet, limit: 12 }),
            always_inject: alwaysInjectIds.includes(String(node?.id || '')),
        });
        return row;
    });
    try {
        const parsed = await runFunctionCallTask(context, settings, {
            systemPrompt: finalizeSystemPrompt,
            userPrompt: buildRecallFinalizeInputXml({
                recallQueryContext: {
                    user_query_text: recallState.query,
                    recent_dialogue_context: recallState.queryBundle,
                },
                candidateNodes: detailRows,
                alwaysInjectNodeIds: alwaysInjectIds,
                routeResult: recallState.route || {},
                selectionConstraints: {
                    include_non_event_nodes: true,
                    require_event_continuity: true,
                    recent_message_window: Math.max(3, Number(settings.recentRawTurns || 5)),
                    injection_exclude_recent_messages: Math.max(0, Number(settings.recentRawTurns || 5)),
                    recall_query_recent_messages: Math.max(1, Number(settings.recallQueryMessages || defaultSettings.recallQueryMessages || 2)),
                    min_event_nodes_if_available: 2,
                },
            }),
            apiPresetName: settings.recallApiPresetName || '',
            promptPresetName: String(settings.recallPresetName || '').trim(),
            functionName: 'luker_rpg_recall_finalize',
            functionDescription: 'Finalize memory node IDs to inject.',
            parameters: {
                type: 'object',
                properties: {
                    selected_node_ids: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                    reason: { type: 'string' },
                },
                required: ['selected_node_ids'],
                additionalProperties: true,
            },
            abortSignal: recallState?.abortSignal || null,
        });

        const selectedIds = Array.isArray(parsed?.selected_node_ids)
            ? parsed.selected_node_ids.map(id => String(id || '').trim()).filter(id => id && candidateSet.has(id))
            : [];
        return {
            selected_node_ids: selectedIds,
            reason: String(parsed?.reason || ''),
        };
    } catch (error) {
        console.warn(`[${MODULE_NAME}] recall select failed`, error);
        return {
            selected_node_ids: recallState.candidates.map(node => node.id),
            reason: 'Fallback selection used.',
        };
    }
}

function compareNodesByTimeline(a, b) {
    const aTo = Number(a?.seqTo ?? Number.MAX_SAFE_INTEGER);
    const bTo = Number(b?.seqTo ?? Number.MAX_SAFE_INTEGER);
    if (aTo !== bTo) {
        return aTo - bTo;
    }
    return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function getActiveSemanticParentOfType(store, node, type) {
    const parentId = String(node?.parentId || '').trim();
    if (!parentId) {
        return null;
    }
    const parent = store.nodes[parentId];
    if (!parent || parent.archived) {
        return null;
    }
    if (String(parent.type || '').toLowerCase() !== String(type || '').toLowerCase()) {
        return null;
    }
    return parent;
}

function getTopActiveSemanticAncestorOfType(store, node, type) {
    if (!node) {
        return null;
    }
    const targetType = String(type || '').toLowerCase();
    let current = node;
    let top = node;
    const guard = new Set();
    while (current && current.id && !guard.has(current.id)) {
        guard.add(current.id);
        const parent = getActiveSemanticParentOfType(store, current, targetType);
        if (!parent) {
            break;
        }
        top = parent;
        current = parent;
    }
    return top;
}

function hasActiveSemanticChildOfType(store, node, type) {
    if (!node || !Array.isArray(node.childrenIds) || node.childrenIds.length === 0) {
        return false;
    }
    const targetType = String(type || '').toLowerCase();
    for (const childId of node.childrenIds) {
        const child = store.nodes[childId];
        if (!child || child.archived) {
            continue;
        }
        if (String(child.type || '').toLowerCase() === targetType) {
            return true;
        }
    }
    return false;
}

function selectVisibleNodesForType(store, typeNodes, type, compressionMode = 'none') {
    const sorted = Array.isArray(typeNodes)
        ? typeNodes.slice().sort(compareNodesByTimeline)
        : [];
    if (sorted.length === 0) {
        return [];
    }
    if (String(compressionMode || '').toLowerCase() !== 'hierarchical') {
        return sorted;
    }

    const leaves = sorted.filter(node => !hasActiveSemanticChildOfType(store, node, type));
    const picked = [];
    const seen = new Set();
    for (const leaf of leaves) {
        const candidate = getTopActiveSemanticAncestorOfType(store, leaf, type) || leaf;
        if (!candidate?.id || seen.has(candidate.id)) {
            continue;
        }
        seen.add(candidate.id);
        picked.push(candidate);
    }
    return picked.sort(compareNodesByTimeline);
}

function collectAlwaysInjectNodes(store, settings, context = null) {
    const alwaysSpecs = getEffectiveNodeTypeSchema(context, settings)
        .filter((spec) => {
            const tableName = String(spec?.tableName || '').trim().toLowerCase();
            // `event_table` is always considered core storyline context and must stay injected.
            return Boolean(spec?.alwaysInject) || tableName === 'event_table';
        })
        .map(spec => ({
            type: String(spec.id || '').toLowerCase(),
            compression: getSemanticCompressionConfig(settings, String(spec.id || '').toLowerCase(), context),
        }))
        .filter(spec => spec.type);
    if (alwaysSpecs.length === 0) {
        return [];
    }

    const picked = [];
    const seen = new Set();
    for (const spec of alwaysSpecs) {
        const nodes = listNodesByLevel(store, LEVEL.SEMANTIC)
            .filter(node => !node.archived)
            .filter(node => !isRecallDiagnosticNode(node))
            .filter(node => String(node.type || '').toLowerCase() === spec.type);
        if (nodes.length === 0) {
            continue;
        }
        const selectedTypeNodes = selectVisibleNodesForType(store, nodes, spec.type, spec.compression.mode);
        for (const node of selectedTypeNodes) {
            if (!node?.id || seen.has(node.id)) {
                continue;
            }
            seen.add(node.id);
            picked.push(node);
        }
    }

    return picked.sort(compareNodesByTimeline);
}

function getNodeSeqRange(node) {
    if (Number.isFinite(Number(node?.seqTo))) {
        return String(Number(node.seqTo));
    }
    return '';
}

function getLatestSeqIndex(store) {
    return Math.max(-1, getSemanticCoverageSeq(store));
}

function isNodeInRecentExcludeWindow(node, latestSeqIndex, excludeMessages) {
    const windowSize = Math.max(0, Number(excludeMessages || 0));
    if (windowSize <= 0 || latestSeqIndex < 0 || !node) {
        return false;
    }
    const toSeq = Number(node?.seqTo ?? NaN);
    if (!Number.isFinite(toSeq)) {
        return false;
    }
    const cutoff = latestSeqIndex - windowSize + 1;
    return Number.isFinite(cutoff) && toSeq >= cutoff;
}

function toMarkdownTable(headers, rows) {
    if (!Array.isArray(headers) || headers.length === 0 || !Array.isArray(rows) || rows.length === 0) {
        return '';
    }
    const safeHeaders = headers.map(header => normalizeText(header || '-').replaceAll('|', '\\|'));
    const lines = [];
    lines.push(`| ${safeHeaders.join(' | ')} |`);
    lines.push(`| ${safeHeaders.map(() => '---').join(' | ')} |`);
    for (const row of rows) {
        const cells = safeHeaders.map((_, index) => normalizeText(row?.[index] ?? '').replaceAll('|', '\\|'));
        lines.push(`| ${cells.join(' | ')} |`);
    }
    return lines.join('\n');
}

function getTableCellValueFromNode(node, columnName) {
    const key = String(columnName || '').trim().toLowerCase();
    if (!key) {
        return '';
    }
    const structured = getStructuredNodeFields(node);
    if (key === 'title' || key === 'name') {
        return String(node.title || structured.name || '');
    }
    if (key === 'type') {
        return String(node.type || '');
    }
    if (key === 'seq_range' || key === 'turn_range') {
        return getNodeSeqRange(node);
    }
    if (key === 'summary') {
        return getNodeSummary(node);
    }
    if (key === 'details') {
        if (structured[key] !== undefined) {
            return toDisplayScalar(structured[key]);
        }
        return '';
    }
    if (key === 'last_update_seq' || key === 'last_update_turn') {
        return String(node.seqTo ?? '');
    }
    if (key === 'seq_to' || key === 'turn_to' || key === 'seq') {
        return String(node.seqTo ?? '');
    }
    if (structured[key] !== undefined) {
        return toDisplayScalar(structured[key]);
    }
    const parsedSummary = tryParseJsonObject(getNodeSummary(node));
    const deepHit = findValueByKeyDeep(node?.fields, key)
        ?? findValueByKeyDeep(parsedSummary, key);
    if (deepHit !== undefined) {
        return toDisplayScalar(deepHit);
    }
    return String(node?.fields?.[key] ?? '');
}

function buildFocusTablesText(nodes, settings, options = {}, context = null) {
    const byBucket = new Map();
    const sourceNodes = Array.isArray(nodes) ? nodes : [];
    const tablePrefix = String(options?.tablePrefix || 'Focus').trim() || 'Focus';
    const schemaMap = getNodeTypeSchemaMap(settings, context);
    for (const node of sourceNodes) {
        if (!node) {
            continue;
        }
        const bucket = node.level === LEVEL.SEMANTIC
            ? `semantic:${String(node.type || 'semantic')}`
            : `timeline:${String(node.level || 'unknown')}`;
        if (!byBucket.has(bucket)) {
            byBucket.set(bucket, []);
        }
        byBucket.get(bucket).push(node);
    }

    const blocks = [];
    for (const [bucket, bucketNodes] of byBucket.entries()) {
        let headers = ['title', 'type', 'seq_range', 'summary'];
        let rows = bucketNodes.map(node => [
            String(node.title || ''),
            String(node.type || ''),
            getNodeSeqRange(node),
            getNodeSummary(node),
        ]);
        let bucketTitle = `${tablePrefix} ${bucket}`;

        if (bucket.startsWith('semantic:')) {
            const semanticType = String(bucket.slice('semantic:'.length) || '').trim().toLowerCase();
            const spec = schemaMap.get(semanticType);
            const columns = Array.isArray(spec?.tableColumns) ? spec.tableColumns : [];
            if (columns.length > 0) {
                headers = columns;
                rows = bucketNodes.map(node => columns.map(column => getTableCellValueFromNode(node, column)));
            }
            bucketTitle = `${tablePrefix} ${spec?.tableName || semanticType || bucket}`;
        }

        const table = toMarkdownTable(headers, rows);
        if (!table) {
            continue;
        }
        blocks.push(`[Table: ${bucketTitle}]\n${table}`);
    }

    return blocks.join('\n\n');
}

function createRuntimeLorebookEntry(uid, comment, content, order) {
    return {
        uid,
        ...structuredClone(newWorldInfoEntryTemplate),
        key: [],
        keysecondary: [],
        comment: String(comment || ''),
        content: String(content || ''),
        constant: true,
        selective: true,
        disable: false,
        order: Number(order || 100),
        preventRecursion: true,
        excludeRecursion: true,
        useProbability: true,
        probability: 100,
        depth: 4,
        role: 0,
    };
}

function getRuntimeLorebookNameFromMetadata(context) {
    const metadata = context.chatMetadata && typeof context.chatMetadata === 'object' ? context.chatMetadata : {};
    return String(metadata?.[CHAT_LOREBOOK_METADATA_KEY] || '').trim();
}

function buildRuntimeLorebookName(context) {
    const chatId = String(context.chatId || context.getCurrentChatId?.() || '').trim();
    const groupPart = context.groupId ? 'group' : 'char';
    const suffix = chatId || `${groupPart}_${Date.now()}`;
    return `Luker Memory ${suffix}`.replace(/[^a-z0-9 _\-]/gi, '_');
}

async function ensureRuntimeLorebook(context, settings) {
    const overrideName = String(settings.lorebookNameOverride || '').trim();
    const existingName = overrideName || getRuntimeLorebookNameFromMetadata(context);
    if (existingName) {
        const loaded = await context.loadWorldInfo(existingName);
        if (loaded && typeof loaded === 'object') {
            return existingName;
        }
    }

    const newName = buildRuntimeLorebookName(context);
    await context.saveWorldInfo(newName, { entries: {} }, true);
    context.updateChatMetadata({ [CHAT_LOREBOOK_METADATA_KEY]: newName });
    await context.saveMetadata();
    return newName;
}

async function syncLorebookProjection(context, settings, blocks) {
    if (!settings.lorebookProjectionEnabled) {
        return;
    }
    const bookName = await ensureRuntimeLorebook(context, settings);
    const data = await context.loadWorldInfo(bookName) || { entries: {} };
    if (!data.entries || typeof data.entries !== 'object') {
        data.entries = {};
    }

    for (const [uid, entry] of Object.entries(data.entries)) {
        const comment = String(entry?.comment || '');
        if (comment.startsWith(RUNTIME_LOREBOOK_COMMENT_PREFIX)) {
            delete data.entries[uid];
        }
    }

    const sections = [
        ['CORE_PACKET', String(blocks.corePacket || '').trim()],
        ['FOCUS_PACKET', String(blocks.focusPacket || '').trim()],
    ].filter(([, text]) => Boolean(text));

    let nextUid = Object.keys(data.entries)
        .map(uid => Number(uid))
        .filter(Number.isFinite)
        .reduce((max, value) => Math.max(max, value), -1) + 1;
    const baseOrder = Math.max(100, Number(settings.lorebookEntryOrderBase || 9800));
    for (let i = 0; i < sections.length; i++) {
        const [name, text] = sections[i];
        const entry = createRuntimeLorebookEntry(
            nextUid,
            `${RUNTIME_LOREBOOK_COMMENT_PREFIX}::${name}`,
            text,
            baseOrder + i,
        );
        data.entries[nextUid] = entry;
        nextUid += 1;
    }

    await context.saveWorldInfo(bookName, data, true);
}

async function clearRuntimeLorebookProjection(context, settings) {
    const overrideName = String(settings.lorebookNameOverride || '').trim();
    const bookName = overrideName || getRuntimeLorebookNameFromMetadata(context);
    if (!bookName) {
        return;
    }
    const data = await context.loadWorldInfo(bookName);
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
        return;
    }

    let changed = false;
    for (const [uid, entry] of Object.entries(data.entries)) {
        const comment = String(entry?.comment || '');
        if (comment.startsWith(RUNTIME_LOREBOOK_COMMENT_PREFIX)) {
            delete data.entries[uid];
            changed = true;
        }
    }
    if (changed) {
        await context.saveWorldInfo(bookName, data, true);
    }
}

async function runLLMDrivenRecall(context, store, payload) {
    const settings = getSettings();
    if (!settings.recallEnabled) {
        return { selectedNodes: [], alwaysInjectNodes: [], trace: [], query: '' };
    }
    const abortSignal = isAbortSignalLike(payload?.signal) ? payload.signal : null;

    const queryBundle = getRecallQueryBundle(payload, context, settings);
    const query = normalizeText(queryBundle.fullText || '');
    const alwaysInjectNodes = collectAlwaysInjectNodes(store, settings, context);
    const rootCandidates = collectRootCandidates(store, settings, queryBundle, alwaysInjectNodes, context);
    const maxIterations = Math.max(2, Math.min(6, Number(settings.recallMaxIterations || 3)));
    const trace = [];
    const alwaysInjectIds = alwaysInjectNodes.map(node => String(node?.id || '')).filter(Boolean);
    const alwaysInjectSet = new Set(alwaysInjectIds);

    let selectedIds = [];
    let currentCandidates = rootCandidates.slice();
    let latestRoute = null;
    let earlyFinalized = false;
    const drillBudget = Math.max(0, maxIterations - 1);

    for (let pass = 1; pass <= drillBudget; pass++) {
        const route = await chooseRecallRoute(context, settings, {
            store,
            query,
            queryBundle,
            candidates: currentCandidates,
            alwaysInjectIds,
            abortSignal,
        });
        latestRoute = route;
        trace.push({
            step: `plan_pass_${pass}`,
            route,
            stage1_candidates: currentCandidates.map(node => node.id),
        });
        if (Array.isArray(route?.referenced_always_inject_ids) && route.referenced_always_inject_ids.length > 0) {
            trace.push({
                step: `plan_referenced_always_inject_${pass}`,
                node_ids: route.referenced_always_inject_ids,
            });
        }

        if (route.action === 'finalize') {
            selectedIds = Array.isArray(route.selected_node_ids) ? route.selected_node_ids : [];
            trace.push({
                step: `plan_early_finalize_${pass}`,
                selected_ids: selectedIds,
                reason: route.reason || '',
            });
            earlyFinalized = true;
            break;
        }

        if (route.action !== 'drill') {
            trace.push({
                step: `plan_stop_non_drill_${pass}`,
                action: String(route.action || ''),
            });
            break;
        }

        const expandedCandidates = expandRouteCandidates(store, route, currentCandidates);
        trace.push({
            step: `expand_from_plan_${pass}`,
            expanded_candidates: expandedCandidates.map(node => node.id),
        });

        if (expandedCandidates.length <= currentCandidates.length) {
            currentCandidates = expandedCandidates;
            trace.push({
                step: `drill_stagnated_${pass}`,
                candidate_count: currentCandidates.length,
            });
            break;
        }

        currentCandidates = expandedCandidates;
    }

    if (!earlyFinalized) {
        const selectedRaw = await chooseFocusNodes(context, settings, {
            store,
            query,
            queryBundle,
            route: latestRoute || {},
            candidates: currentCandidates,
            alwaysInjectIds,
            abortSignal,
        });
        selectedIds = Array.isArray(selectedRaw.selected_node_ids) ? selectedRaw.selected_node_ids : [];
        trace.push({
            step: 'finalize_pass',
            selected_ids: selectedIds,
            reason: selectedRaw.reason || '',
        });
    }

    const droppedAlwaysInjectIds = [];
    const filteredSelectionIds = [];
    for (const id of selectedIds) {
        const key = String(id || '').trim();
        if (!key) {
            continue;
        }
        if (alwaysInjectSet.has(key)) {
            droppedAlwaysInjectIds.push(key);
            continue;
        }
        filteredSelectionIds.push(key);
    }
    if (droppedAlwaysInjectIds.length > 0) {
        trace.push({
            step: 'drop_always_inject_from_selection',
            dropped_always_inject_ids: droppedAlwaysInjectIds,
        });
    }

    const selectedNodesRaw = filteredSelectionIds
        .map(id => store.nodes[id])
        .filter(Boolean);
    const dedupedSelectedNodes = [];
    const selectedNodeSeen = new Set();
    for (const node of selectedNodesRaw) {
        if (!node?.id || selectedNodeSeen.has(node.id)) {
            continue;
        }
        selectedNodeSeen.add(node.id);
        dedupedSelectedNodes.push(node);
    }
    const selectedNodes = dedupedSelectedNodes;
    if (alwaysInjectNodes.length > 0) {
        trace.push({
            step: 'always_inject',
            node_ids: alwaysInjectNodes.map(node => node.id),
        });
    }

    const latestSeqIndex = getLatestSeqIndex(store);
    const excludeMessages = Math.max(0, Number(settings.recentRawTurns || 5));
    const excludedNodeIds = [];
    const filteredSelectedNodes = selectedNodes.filter((node) => {
        const excluded = isNodeInRecentExcludeWindow(node, latestSeqIndex, excludeMessages);
        if (excluded && node?.id) {
            excludedNodeIds.push(node.id);
        }
        return !excluded;
    }).sort(compareNodesByTimeline);
    if (excludeMessages > 0 && excludedNodeIds.length > 0) {
        trace.push({
            step: 'exclude_recent_window',
            exclude_messages: excludeMessages,
            latest_seq: latestSeqIndex,
            excluded_node_ids: excludedNodeIds,
        });
    }

    return {
        selectedNodes: filteredSelectedNodes,
        alwaysInjectNodes,
        query,
        trace,
    };
}

async function rebuildStoreFromCurrentChat(context, { abortSignal = null, onBatchStart = null } = {}) {
    const chatKey = getChatKey(context);
    const target = memoryStoreTargets.get(chatKey) || buildMemoryTargetFromContext(context);
    if (!target) {
        return null;
    }

    const rebuilt = createEmptyStore();
    await runExtractionForStore(context, rebuilt, {
        force: true,
        startSeq: 1,
        showCompressionToast: false,
        abortSignal,
        onBatchStart,
        rebuildCreateOnly: true,
    });
    updateStoreSourceState(rebuilt, context);
    memoryStoreTargets.set(chatKey, target);
    memoryStoreCache.set(chatKey, rebuilt);
    await persistMemoryStoreByChatKey(context, chatKey, rebuilt);
    return rebuilt;
}

function buildPlayableFramesFromContext(context) {
    const frames = [];
    let seq = 0;
    for (const message of getAssistantChatMessages(context)) {
        const text = normalizeText(message?.mes || '');
        if (!text) {
            continue;
        }
        seq += 1;
        frames.push({
            seq,
            is_user: Boolean(message?.is_user),
            name: String(message?.name || ''),
            mes: text,
            send_date: String(message?.send_date || ''),
            last_user_name: String(message?.last_user_name || ''),
            last_user_mes: String(message?.last_user_mes || ''),
            last_user_send_date: String(message?.last_user_send_date || ''),
        });
    }
    return frames;
}

function getSemanticCoverageSeq(store) {
    const nodes = Object.values(store?.nodes || {})
        .filter(node => node && !node.archived && node.level === LEVEL.SEMANTIC);
    if (nodes.length === 0) {
        return 0;
    }
    const maxSeq = nodes.reduce((maxSeq, node) => {
        const seq = Number(node?.seqTo ?? 0);
        if (!Number.isFinite(seq)) {
            return maxSeq;
        }
        return Math.max(maxSeq, Math.max(0, Math.floor(seq)));
    }, 0);
    return Number.isFinite(maxSeq) ? maxSeq : 0;
}

function computeExtractionWindow(context, store, startSeq = null) {
    const frames = buildPlayableFramesFromContext(context);
    const latestSeq = Number(frames.length || 0);
    const coveredSeqTo = Math.min(latestSeq, getSemanticCoverageSeq(store));
    const hasExplicitStartSeq = startSeq !== null
        && startSeq !== undefined
        && Number.isFinite(Number(startSeq));
    const beginSeq = hasExplicitStartSeq
        ? Math.max(1, Math.floor(Number(startSeq)))
        : coveredSeqTo + 1;
    return {
        frames,
        latestSeq,
        coveredSeqTo,
        beginSeq,
        gap: latestSeq - coveredSeqTo,
    };
}

function formatExtractionRangeToast(beginSeq, endSeq, latestSeq) {
    const begin = Math.max(1, Math.floor(Number(beginSeq || 0)));
    const end = Math.max(begin, Math.floor(Number(endSeq || begin)));
    const latest = Math.max(end, Math.floor(Number(latestSeq || end)));
    return i18nFormat('Memory graph update running... seq ${0}-${1} / latest ${2}', begin, end, latest);
}

function normalizeMutationMeta(rawMeta = null) {
    if (!rawMeta || typeof rawMeta !== 'object') {
        return null;
    }
    const kind = String(rawMeta.kind || '').trim().toLowerCase();
    const assistantFromSeq = Number(rawMeta?.deletedAssistantSeqFrom);
    const assistantToSeq = Number(rawMeta?.deletedAssistantSeqTo);
    const playableFromSeq = Number(rawMeta?.deletedPlayableSeqFrom);
    const playableToSeq = Number(rawMeta?.deletedPlayableSeqTo);
    return {
        kind,
        deletedAssistantSeqFrom: Number.isFinite(assistantFromSeq) ? Math.max(1, Math.floor(assistantFromSeq)) : null,
        deletedAssistantSeqTo: Number.isFinite(assistantToSeq) ? Math.max(1, Math.floor(assistantToSeq)) : null,
        deletedPlayableSeqFrom: Number.isFinite(playableFromSeq) ? Math.max(1, Math.floor(playableFromSeq)) : null,
        deletedPlayableSeqTo: Number.isFinite(playableToSeq) ? Math.max(1, Math.floor(playableToSeq)) : null,
    };
}

function truncateStoreFromSeq(store, fromSeq) {
    const startSeq = Math.max(1, Math.floor(Number(fromSeq || 0)));
    if (!store || typeof store !== 'object' || !Number.isFinite(startSeq) || startSeq <= 0) {
        return;
    }
    const removeIds = new Set();
    for (const [id, node] of Object.entries(store.nodes || {})) {
        const nodeSeq = Number(node?.seqTo || 0);
        if (Number.isFinite(nodeSeq) && nodeSeq >= startSeq) {
            removeIds.add(String(id || ''));
        }
    }
    if (removeIds.size === 0) {
        const covered = getSemanticCoverageSeq(store);
        store.appliedSeqTo = covered;
        store.seqCounter = covered;
        return;
    }

    for (const id of removeIds) {
        delete store.nodes[id];
    }
    for (const node of Object.values(store.nodes || {})) {
        if (!node || typeof node !== 'object') {
            continue;
        }
        if (Array.isArray(node.childrenIds)) {
            node.childrenIds = node.childrenIds.filter(childId => !removeIds.has(String(childId || '')));
        } else {
            node.childrenIds = [];
        }
        if (String(node.parentId || '').trim() && removeIds.has(String(node.parentId || '').trim())) {
            node.parentId = '';
        }
    }
    if (Array.isArray(store.edges)) {
        store.edges = store.edges.filter(edge => {
            const from = String(edge?.from || '');
            const to = String(edge?.to || '');
            return from && to && !removeIds.has(from) && !removeIds.has(to);
        });
    }
    const covered = getSemanticCoverageSeq(store);
    store.appliedSeqTo = covered;
    store.seqCounter = covered;
}

function alignStoreCoverageToChat(store, context) {
    if (!store || typeof store !== 'object') {
        return { changed: false, latestSeq: 0 };
    }
    const frames = buildPlayableFramesFromContext(context);
    const latestSeq = Number(frames.length || 0);
    const covered = getSemanticCoverageSeq(store);
    let changed = false;
    if (covered > latestSeq) {
        truncateStoreFromSeq(store, latestSeq + 1);
        changed = true;
    }
    const normalizedCovered = Math.min(latestSeq, getSemanticCoverageSeq(store));
    store.appliedSeqTo = normalizedCovered;
    store.seqCounter = normalizedCovered;
    updateStoreSourceState(store, context);
    return { changed, latestSeq };
}

async function ensureStoreSyncedWithChat(context, targetHint = null) {
    const loaded = await ensureMemoryStoreLoaded(context, { targetHint });
    const store = getMemoryStore(context, targetHint) || loaded || null;
    if (!store) {
        return null;
    }
    const target = buildMemoryTargetFromContext(context, targetHint);
    if (!target) {
        return store;
    }
    const { changed } = alignStoreCoverageToChat(store, context);
    if (changed) {
        const chatKey = getChatKey(context, target);
        await persistMemoryStoreByChatKey(context, chatKey, store);
    }
    return store;
}

async function injectMemoryPrompts(context, payload) {
    const settings = getSettings();
    const generationType = String(payload?.type || '').trim().toLowerCase();
    const isDryRun = payload?.dryRun === true;
    if (isDryRun || generationType === 'quiet') {
        return false;
    }
    if (!RECALL_ALLOWED_GENERATION_TYPES.has(generationType)) {
        return false;
    }
    if (!Array.isArray(payload?.coreChat)) {
        return false;
    }
    if (isAbortSignalLike(payload?.signal) && payload.signal.aborted) {
        updateUiStatus(i18n('Generation aborted. Skipped memory recall.'));
        return false;
    }
    if (!settings.enabled) {
        await clearRuntimeLorebookProjection(context, settings);
        updateUiStatus(i18n('Memory disabled, runtime lorebook projection cleared.'));
        return false;
    }
    if (!settings.lorebookProjectionEnabled) {
        await clearRuntimeLorebookProjection(context, settings);
        updateUiStatus(i18n('Lorebook projection disabled.'));
        return false;
    }

    const targetHint = normalizeExplicitChatStateTarget(payload?.chatStateTarget);
    const store = await ensureStoreSyncedWithChat(context, targetHint);
    if (!store) {
        updateUiStatus(i18n('Memory store unavailable for current chat.'));
        return false;
    }

    const { selectedNodes, alwaysInjectNodes, trace, query } = await runLLMDrivenRecall(context, store, payload);
    store.lastRecallTrace = trace;

    const blocks = {
        corePacket: buildFocusTablesText(alwaysInjectNodes, settings, { tablePrefix: 'Core' }, context),
        focusPacket: buildFocusTablesText(selectedNodes, settings, { tablePrefix: 'Recall' }, context),
    };
    await syncLorebookProjection(context, settings, blocks);
    store.lastRecallProjection = {
        at: Date.now(),
        blocks,
    };
    const chatKey = getChatKey(context, targetHint);
    await persistMemoryStoreByChatKey(context, chatKey, store);
    updateUiStatus(i18nFormat('Recall ready. selected=${0}', selectedNodes.length));
    return true;
}

async function safeInjectMemoryPrompts(context, payload, trigger = 'after_world_info_scan') {
    const settings = getSettings();
    const generationType = String(payload?.type || '').trim().toLowerCase();
    const shouldShowRuntimeToast = settings.enabled
        && settings.recallEnabled
        && settings.lorebookProjectionEnabled
        && RECALL_ALLOWED_GENERATION_TYPES.has(generationType)
        && payload?.dryRun !== true
        && generationType !== 'quiet'
        && Array.isArray(payload?.coreChat);
    const recallAbortController = shouldShowRuntimeToast ? new AbortController() : null;
    if (recallAbortController) {
        activeRecallAbortController = recallAbortController;
    }
    const linkedAbort = linkAbortSignals(payload?.signal, recallAbortController?.signal);
    const effectivePayload = linkedAbort.signal && linkedAbort.signal !== payload?.signal
        ? { ...payload, signal: linkedAbort.signal }
        : payload;
    if (shouldShowRuntimeToast) {
        showRuntimeInfoToast(i18n('Memory recall running...'), {
            stopLabel: i18n('Stop'),
            onStop: () => {
                if (recallAbortController && !recallAbortController.signal.aborted) {
                    recallAbortController.abort();
                }
            },
        });
    }
    try {
        const injected = await injectMemoryPrompts(context, effectivePayload);
        if (injected && payload && typeof payload === 'object') {
            payload.__lukerRpgMemoryInjected = true;
        }
        return Boolean(injected);
    } catch (error) {
        if (isAbortError(error, effectivePayload?.signal)) {
            const generationAborted = Boolean(isAbortSignalLike(payload?.signal) && payload.signal.aborted);
            updateUiStatus(generationAborted
                ? i18n('Generation aborted. Skipped memory recall.')
                : i18n('Memory recall cancelled by user.'));
            return false;
        }
        console.error(`[${MODULE_NAME}] Recall injection failed during ${trigger}`, error);
        updateUiStatus(i18nFormat(
            'Recall injection failed (${0}): ${1}',
            trigger,
            String(error?.message || error),
        ));
        return false;
    } finally {
        linkedAbort.cleanup();
        if (activeRecallAbortController === recallAbortController) {
            activeRecallAbortController = null;
        }
        if (shouldShowRuntimeToast) {
            clearRuntimeInfoToast();
        }
    }
}

async function captureLatestAssistantAfterGeneration() {
    const context = getContext();
    const settings = getSettings();
    if (!settings.enabled) {
        return;
    }
    if (!Array.isArray(context.chat) || context.chat.length === 0) {
        return;
    }
    const index = context.chat.length - 1;
    const message = context.chat[index];
    if (!message || message.is_system || message.is_user) {
        return;
    }
    if (!normalizeText(message.mes || '')) {
        return;
    }
    await ensureMemoryStoreLoaded(context);
    scheduleExtraction(context);
}

function scheduleExtraction(context) {
    const chatKey = getChatKey(context);
    if (!chatKey || chatKey === 'invalid_target') {
        return;
    }
    if (extractionTimers.has(chatKey)) {
        return;
    }

    const timer = setTimeout(async () => {
        extractionTimers.delete(chatKey);
        const store = memoryStoreCache.get(chatKey);
        if (!store) {
            return;
        }
        const extractionAbortController = new AbortController();
        activeExtractionAbortController = extractionAbortController;
        try {
            alignStoreCoverageToChat(store, context);
            const settings = getSettings();
            const preview = computeExtractionWindow(context, store, null);
            if (preview.beginSeq > preview.latestSeq || preview.gap < Number(settings.updateEvery || 1)) {
                store.lastExtractionDebug = {
                    beginSeq: preview.beginSeq,
                    latestSeq: preview.latestSeq,
                    coveredSeqTo: preview.coveredSeqTo,
                    extracted: false,
                    reason: preview.beginSeq > preview.latestSeq ? 'already_up_to_date' : 'gap_below_threshold',
                    at: Date.now(),
                };
                const debug = store.lastExtractionDebug || {};
                updateUiStatus(i18nFormat(
                    'Extraction ${0}: begin=${1} latest=${2} covered=${3}',
                    'skip',
                    Number(debug.beginSeq || 0),
                    Number(debug.latestSeq || 0),
                    Number(debug.coveredSeqTo || 0),
                ));
                refreshUiStats();
                return;
            }
            const extractBatchTurns = Math.max(
                1,
                Math.floor(Number(settings?.extractBatchTurns || defaultSettings.extractBatchTurns || 1)),
            );
            const initialEndSeq = Math.min(
                Number(preview.latestSeq || 0),
                Number(preview.beginSeq || 1) + extractBatchTurns - 1,
            );
            showRuntimeInfoToast(formatExtractionRangeToast(preview.beginSeq, initialEndSeq, preview.latestSeq), {
                stopLabel: i18n('Stop'),
                onStop: () => {
                    if (!extractionAbortController.signal.aborted) {
                        extractionAbortController.abort();
                    }
                },
            });
            await runExtractionForStore(context, store, {
                abortSignal: extractionAbortController.signal,
                onBatchStart: ({ beginSeq, endSeq, latestSeq }) => {
                    updateRuntimeInfoToastMessage(formatExtractionRangeToast(beginSeq, endSeq, latestSeq));
                },
            });
            await persistMemoryStoreByChatKey(context, chatKey, store);
            const debug = store.lastExtractionDebug || {};
            updateUiStatus(i18nFormat(
                'Extraction ${0}: begin=${1} latest=${2} covered=${3}',
                debug.extracted ? 'ok' : 'skip',
                Number(debug.beginSeq || 0),
                Number(debug.latestSeq || 0),
                Number(debug.coveredSeqTo || 0),
            ));
            refreshUiStats();
        } catch (error) {
            if (isAbortError(error, extractionAbortController.signal)) {
                updateUiStatus(i18n('Memory graph update cancelled by user.'));
                return;
            }
            console.warn(`[${MODULE_NAME}] Extraction failed`, error);
            updateUiStatus(i18nFormat('Recall injection failed (${0}): ${1}', 'extract', String(error?.message || error)));
        } finally {
            if (activeExtractionAbortController === extractionAbortController) {
                activeExtractionAbortController = null;
            }
            clearRuntimeInfoToast();
        }
    }, 0);

    extractionTimers.set(chatKey, timer);
}

function getStoreStats(store) {
    const nodes = Object.values(store.nodes || {});
    const levelCount = {
        semantic: nodes.filter(n => n.level === LEVEL.SEMANTIC).length,
    };

    return {
        nodeCount: nodes.length,
        edgeCount: Array.isArray(store.edges) ? store.edges.length : 0,
        messageCount: getSemanticCoverageSeq(store),
        sourceMessageCount: Number(store.sourceMessageCount || 0),
        levelCount,
        lastRecallSteps: Array.isArray(store.lastRecallTrace) ? store.lastRecallTrace.length : 0,
    };
}

function renderGraphInspectorHtml(store) {
    const stats = getStoreStats(store);
    const nodes = Object.values(store.nodes || {})
        .sort(compareNodesByTimeline)
        .slice(-220);
    const edges = Array.isArray(store.edges)
        ? store.edges
            .map((edge, index) => ({ ...edge, _index: index }))
            .sort((a, b) => Number(b._index || 0) - Number(a._index || 0))
            .slice(0, 160)
        : [];

    const rows = nodes.map(node => `
<tr>
<td>${node.id}</td>
<td>${node.level}</td>
<td>${node.type}</td>
<td>${String(node.title || '').replace(/</g, '&lt;')}</td>
<td>${String(getNodeSummary(node) || '').replace(/</g, '&lt;')}</td>
<td>${Array.isArray(node.childrenIds) ? node.childrenIds.length : 0}</td>
<td>${node.seqTo ?? ''}</td>
<td>
    <div class="flex-container">
        <div class="menu_button menu_button_small luker-rpg-memory-node-view" data-node-id="${escapeHtml(node.id)}">${escapeHtml(i18n('View'))}</div>
        <div class="menu_button menu_button_small luker-rpg-memory-node-edit" data-node-id="${escapeHtml(node.id)}">${escapeHtml(i18n('Form Edit'))}</div>
    </div>
</td>
</tr>`).join('');

    return `
<div class="flex-container flexFlowColumn luker-rpg-memory-graph-popup-inner">
    <h3 class="margin0">${escapeHtml(i18n('Memory Graph'))}</h3>
    <div>${escapeHtml(i18nFormat('Nodes: ${0} | Edges: ${1} | Assistant turns: ${2} | Source turns: ${3}', stats.nodeCount, stats.edgeCount, stats.messageCount, stats.sourceMessageCount))}</div>
    <div>${escapeHtml(i18nFormat('semantic=${0}', stats.levelCount.semantic))}</div>
    <div>${escapeHtml(i18nFormat('Last recall steps: ${0}', stats.lastRecallSteps))}</div>
    <div class="luker-rpg-memory-graph-workspace">
        <div class="luker-rpg-memory-graph-canvas-wrap">
            <div class="luker-rpg-memory-graph-cy"></div>
            <small class="luker-rpg-memory-graph-selection">${escapeHtml(i18n('Visual graph ready. Click a node or edge to select it for editing.'))}</small>
        </div>
        <div class="luker-rpg-memory-graph-sidepanel">
            <h4 class="margin0">${escapeHtml(i18n('Inspector'))}</h4>
            <small class="luker-rpg-memory-graph-sidehint">${escapeHtml(i18n('Select a node or edge to edit.'))}</small>
            <div class="luker-rpg-memory-graph-editor-slot"></div>
        </div>
    </div>
    <div class="flex-container luker-rpg-memory-graph-toolbar">
        <div class="menu_button luker-rpg-memory-graph-fit">${escapeHtml(i18n('Fit View'))}</div>
        <div class="menu_button luker-rpg-memory-edge-add">${escapeHtml(i18n('Add Edge'))}</div>
        <div class="menu_button luker-rpg-memory-edge-edit">${escapeHtml(i18n('Edit Selected Edge'))}</div>
        <div class="menu_button luker-rpg-memory-edge-delete">${escapeHtml(i18n('Delete Selected Edge'))}</div>
        <div class="menu_button luker-rpg-memory-graph-raw-view">${escapeHtml(i18n('Advanced JSON View'))}</div>
        <div class="menu_button luker-rpg-memory-graph-raw-edit">${escapeHtml(i18n('Advanced JSON Edit'))}</div>
    </div>
    <div class="luker-rpg-memory-graph-table-wrap">
    <table class="table" style="font-size:12px; margin-top:8px;">
        <thead><tr><th>${escapeHtml(i18n('ID'))}</th><th>${escapeHtml(i18n('Level'))}</th><th>${escapeHtml(i18n('Type'))}</th><th>${escapeHtml(i18n('Title'))}</th><th>${escapeHtml(i18n('Summary'))}</th><th>${escapeHtml(i18n('Children'))}</th><th>${escapeHtml(i18n('Sequence'))}</th><th>${escapeHtml(i18n('Actions'))}</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>
    </div>
    <h4 class="margin0" style="margin-top:10px;">${escapeHtml(i18n('Recent Edges'))}</h4>
    <div class="luker-rpg-memory-graph-table-wrap">
    <table class="table" style="font-size:12px; margin-top:6px;">
        <thead><tr><th>${escapeHtml(i18n('From'))}</th><th>${escapeHtml(i18n('To'))}</th><th>${escapeHtml(i18n('Type'))}</th><th>${escapeHtml(i18n('ID'))}</th><th>${escapeHtml(i18n('Actions'))}</th></tr></thead>
        <tbody>${edges.map(edge => `<tr><td>${escapeHtml(String(edge.from || ''))}</td><td>${escapeHtml(String(edge.to || ''))}</td><td>${escapeHtml(String(edge.type || ''))}</td><td>${Number(edge._index)}</td><td><div class="menu_button menu_button_small luker-rpg-memory-edge-edit-row" data-edge-index="${Number(edge._index)}">${escapeHtml(i18n('Edit'))}</div></td></tr>`).join('')}</tbody>
    </table>
    </div>
    <h4 class="margin0" style="margin-top:10px;">${escapeHtml(i18n('Last Projection'))}</h4>
    ${buildLastRecallCorePacketHtml(store, { showHeader: false })}
</div>`;
}

function parseOptionalNumber(value) {
    const text = String(value ?? '').trim();
    if (!text.length) {
        return undefined;
    }
    const number = Number(text);
    return Number.isFinite(number) ? number : undefined;
}

function parseLooseScalar(value) {
    const text = String(value ?? '').trim();
    if (!text.length) {
        return '';
    }
    const lower = text.toLowerCase();
    if (lower === 'true') {
        return true;
    }
    if (lower === 'false') {
        return false;
    }
    if (lower === 'null') {
        return null;
    }
    if (lower === 'undefined') {
        return '';
    }
    const number = Number(text);
    if (Number.isFinite(number) && /^[-+]?\d+(\.\d+)?$/.test(text)) {
        return number;
    }
    return text;
}

function getLastRecallProjection(store) {
    return store?.lastRecallProjection && typeof store.lastRecallProjection === 'object'
        ? store.lastRecallProjection
        : null;
}

function getLastRecallCorePacketText(store) {
    const projection = getLastRecallProjection(store);
    if (!projection) {
        return '';
    }
    const fromBlocks = normalizeText(projection?.blocks?.corePacket || '');
    if (fromBlocks) {
        return fromBlocks;
    }
    return normalizeText(projection?.corePacket || '');
}

function buildLastRecallCorePacketHtml(store, options = {}) {
    const projection = getLastRecallProjection(store);
    if (!projection) {
        return `<div style="opacity:0.8;">${escapeHtml(i18n('No recall injection result yet.'))}</div>`;
    }
    const corePacket = getLastRecallCorePacketText(store);
    const showHeader = options?.showHeader !== false;
    const at = Number(projection?.at);
    const renderedAt = Number.isFinite(at) ? new Date(at).toLocaleString() : '';
    const header = showHeader
        ? `<div style="font-weight:600; margin-bottom:6px;">${escapeHtml(i18n('Core Packet'))}</div>`
        : '';
    const timeLine = renderedAt
        ? `<div style="font-size:12px; opacity:0.8; margin-bottom:8px;">${escapeHtml(renderedAt)}</div>`
        : '';
    return `
<div style="display:flex; flex-direction:column; gap:4px;">
    ${header}
    ${timeLine}
    <pre style="white-space:pre-wrap; max-height:65vh; overflow:auto;">${escapeHtml(corePacket || i18n('Core packet is empty.'))}</pre>
</div>`;
}

function encodeFieldsAsLines(fields) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        return '';
    }
    return Object.entries(fields)
        .filter(([key]) => String(key || '').trim().toLowerCase() !== 'summary')
        .map(([key, value]) => {
            let encoded = value;
            if (value && typeof value === 'object') {
                encoded = JSON.stringify(value);
            }
            return `${key}=${String(encoded ?? '')}`;
        })
        .join('\n');
}

function decodeFieldsFromLines(text) {
    const out = {};
    for (const rawLine of String(text || '').split('\n')) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        const sep = line.indexOf('=');
        if (sep <= 0) {
            continue;
        }
        const key = line.slice(0, sep).trim();
        const valueRaw = line.slice(sep + 1).trim();
        if (!key) {
            continue;
        }
        if ((valueRaw.startsWith('{') && valueRaw.endsWith('}')) || (valueRaw.startsWith('[') && valueRaw.endsWith(']'))) {
            try {
                out[key] = JSON.parse(valueRaw);
                continue;
            } catch {
                // scalar parsing below
            }
        }
        out[key] = parseLooseScalar(valueRaw);
    }
    return out;
}

function getNodeTypeOptionsHtml(settings, store, currentType = '') {
    const candidates = new Set();
    for (const entry of getEffectiveNodeTypeSchema(null, settings)) {
        candidates.add(String(entry.id || '').trim());
    }
    for (const node of Object.values(store.nodes || {})) {
        const type = String(node?.type || '').trim();
        if (type) {
            candidates.add(type);
        }
    }
    const selected = String(currentType || '').trim();
    if (selected) {
        candidates.add(selected);
    }
    return [...candidates]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
        .map(type => `<option value="${escapeHtml(type)}"${type === selected ? ' selected' : ''}>${escapeHtml(type)}</option>`)
        .join('');
}

function getNodeParentOptionsHtml(store, selfId, selectedParentId = '') {
    const selected = String(selectedParentId || '').trim();
    const options = [`<option value="">${escapeHtml(i18n('(none)'))}</option>`];
    const nodes = Object.values(store.nodes || {})
        .filter(node => node && String(node.id || '') !== String(selfId || ''))
        .sort(compareNodesByTimeline);
    for (const node of nodes) {
        const id = String(node.id || '');
        const title = String(node.title || '').trim();
        const label = `${id} | ${node.level}/${node.type} | ${title}`;
        options.push(`<option value="${escapeHtml(id)}"${id === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`);
    }
    if (selected && !nodes.find(node => String(node.id || '') === selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function renderNodeFormEditorHtml(node, store, settings, editorId) {
    const levelOptions = [LEVEL.SEMANTIC]
        .map(level => `<option value="${level}"${String(node.level || '') === level ? ' selected' : ''}>${level}</option>`).join('');

    return `
<div id="${editorId}" class="flex-container flexFlowColumn luker-rpg-memory-node-form">
    <small style="opacity:0.85">${escapeHtml(i18n('Form editor for one node. Parent/child relationships and graph persistence are applied automatically.'))}</small>
    <div class="luker-rpg-memory-node-form-grid">
        <label>${escapeHtml(i18n('Node ID'))}
            <input data-field="id" class="text_pole" type="text" value="${escapeHtml(node.id)}" readonly />
        </label>
        <label>${escapeHtml(i18n('Parent Node'))}
            <select data-field="parentId" class="text_pole">${getNodeParentOptionsHtml(store, node.id, node.parentId || '')}</select>
        </label>
        <label>${escapeHtml(i18n('Type'))}
            <select data-field="type" class="text_pole">${getNodeTypeOptionsHtml(settings, store, node.type || '')}</select>
        </label>
        <label>${escapeHtml(i18n('Level'))}
            <select data-field="level" class="text_pole">${levelOptions}</select>
        </label>
        <label>${escapeHtml(i18n('Sequence'))}
            <input data-field="seqTo" class="text_pole" type="number" step="1" value="${escapeHtml(node.seqTo ?? '')}" />
        </label>
    </div>
    <div class="luker-rpg-memory-node-form-flags">
        <label class="checkbox_label"><input data-field="archived" type="checkbox" ${node.archived ? 'checked' : ''} /> ${escapeHtml(i18n('Archived'))}</label>
    </div>
    <label>${escapeHtml(i18n('Title'))}
        <input data-field="title" class="text_pole" type="text" value="${escapeHtml(node.title || '')}" />
    </label>
    <label>${escapeHtml(i18n('Summary'))}
        <textarea data-field="summary" class="text_pole textarea_compact" rows="3">${escapeHtml(getNodeSummary(node))}</textarea>
    </label>
    <label>${escapeHtml(i18n('Fields (one key=value per line)'))}
        <textarea data-field="fieldsLines" class="text_pole textarea_compact" rows="6">${escapeHtml(encodeFieldsAsLines(node.fields || {}))}</textarea>
    </label>
</div>`;
}

function willCreateParentCycle(store, nodeId, parentId) {
    const childId = String(nodeId || '').trim();
    let current = String(parentId || '').trim();
    if (!childId || !current) {
        return false;
    }

    let guard = 0;
    while (current && guard < 3000) {
        if (current === childId) {
            return true;
        }
        const node = store.nodes?.[current];
        current = String(node?.parentId || '').trim();
        guard += 1;
    }
    return false;
}

async function ensureCytoscapeLoaded() {
    if (window.cytoscape) {
        return window.cytoscape;
    }
    if (cytoscapeLoadPromise) {
        return cytoscapeLoadPromise;
    }

    const scriptId = 'luker_rpg_memory_cytoscape_script';
    const src = '/lib/cytoscape.min.js';
    cytoscapeLoadPromise = new Promise((resolve, reject) => {
        const existing = document.getElementById(scriptId);
        if (existing) {
            if (window.cytoscape) {
                resolve(window.cytoscape);
                return;
            }
            existing.addEventListener('load', () => resolve(window.cytoscape), { once: true });
            existing.addEventListener('error', () => reject(new Error('Failed to load Cytoscape script')), { once: true });
            return;
        }

        const script = document.createElement('script');
        script.id = scriptId;
        script.src = src;
        script.async = true;
        script.onload = () => resolve(window.cytoscape);
        script.onerror = () => reject(new Error(`Failed to load Cytoscape from ${src}`));
        document.head.append(script);
    });

    try {
        return await cytoscapeLoadPromise;
    } catch (error) {
        cytoscapeLoadPromise = null;
        throw error;
    }
}

function buildGraphCytoscapeElements(store) {
    const sortedNodes = Object.values(store.nodes || {})
        .sort(compareNodesByTimeline);
    const maxVisualNodes = 450;
    const scopedNodes = sortedNodes.slice(-maxVisualNodes);
    const scopedNodeIds = new Set(scopedNodes.map(node => String(node.id || '')));
    const scopedNodeList = [...scopedNodeIds]
        .map(id => store.nodes[id])
        .filter(Boolean);
    const timelineNodes = scopedNodeList
        .slice()
        .sort((a, b) => {
            const at = Number(a.seqTo ?? 0);
            const bt = Number(b.seqTo ?? 0);
            if (at !== bt) {
                return at - bt;
            }
            const typeCompare = String(a.type || '').localeCompare(String(b.type || ''));
            if (typeCompare !== 0) {
                return typeCompare;
            }
            return String(a.id || '').localeCompare(String(b.id || ''));
        });
    const timelineIndexByNodeId = new Map();
    timelineNodes.forEach((node, index) => {
        timelineIndexByNodeId.set(String(node.id || ''), index);
    });

    const preferredTypeOrder = ['event', 'thread', 'character_sheet', 'location_state', 'rule_constraint'];
    const typeRank = new Map(preferredTypeOrder.map((type, index) => [type, index]));
    const types = [...new Set(scopedNodeList.map(node => String(node.type || 'unknown').trim() || 'unknown'))]
        .sort((a, b) => {
            const ar = typeRank.has(a) ? Number(typeRank.get(a)) : 999;
            const br = typeRank.has(b) ? Number(typeRank.get(b)) : 999;
            if (ar !== br) {
                return ar - br;
            }
            return a.localeCompare(b);
        });
    const rowByType = new Map(types.map((type, index) => [type, index]));

    const count = timelineNodes.length;
    const colGap = count <= 12 ? 220 : count <= 28 ? 178 : 142;
    const rowGap = 170;
    const centerCol = (timelineNodes.length - 1) / 2;
    const centerRow = (types.length - 1) / 2;

    const buckets = new Map();
    for (const node of scopedNodeList) {
        const nodeId = String(node.id || '');
        const timelineIndex = Number(timelineIndexByNodeId.get(nodeId) ?? 0);
        const type = String(node.type || 'unknown').trim() || 'unknown';
        const bucketKey = `${type}|${timelineIndex}`;
        if (!buckets.has(bucketKey)) {
            buckets.set(bucketKey, []);
        }
        buckets.get(bucketKey).push(node);
    }

    const offsetsByNodeId = new Map();
    const getClusterOffset = (index) => {
        if (index <= 0) {
            return { x: 0, y: 0 };
        }
        const ring = Math.ceil(index / 6);
        const slot = (index - 1) % 6;
        const base = 22 + ((ring - 1) * 12);
        const pattern = [
            { x: -base, y: -base },
            { x: base, y: -base },
            { x: -base, y: base },
            { x: base, y: base },
            { x: 0, y: -(base + 8) },
            { x: 0, y: base + 8 },
        ];
        return pattern[slot] || { x: 0, y: 0 };
    };
    for (const bucket of buckets.values()) {
        bucket
            .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))
            .forEach((node, index) => {
                offsetsByNodeId.set(String(node.id || ''), getClusterOffset(index));
            });
    }

    const positionByNodeId = new Map();
    for (const node of scopedNodeList) {
        const nodeId = String(node.id || '');
        const timelineIndex = Number(timelineIndexByNodeId.get(nodeId) ?? 0);
        const type = String(node.type || 'unknown').trim() || 'unknown';
        const rowIndex = Number(rowByType.get(type) ?? 0);
        const offset = offsetsByNodeId.get(nodeId) || { x: 0, y: 0 };
        positionByNodeId.set(nodeId, {
            x: ((timelineIndex - centerCol) * colGap) + offset.x,
            y: ((rowIndex - centerRow) * rowGap) + offset.y,
        });
    }

    const nodes = scopedNodeList
        .map(node => ({
            data: {
                id: `node:${node.id}`,
                nodeId: String(node.id),
                label: `${String(node.title || node.id)}\n${String(node.level || '')}/${String(node.type || '')}`,
                level: String(node.level || ''),
                type: String(node.type || ''),
                archived: Boolean(node.archived),
            },
            position: positionByNodeId.get(String(node.id)) || { x: 0, y: 0 },
        }));

    const edges = Array.isArray(store.edges)
        ? store.edges
            .map((edge, index) => ({ edge, index }))
            .filter(item => {
                const from = String(item.edge?.from || '');
                const to = String(item.edge?.to || '');
                return from && to && scopedNodeIds.has(from) && scopedNodeIds.has(to);
            })
            .map(item => ({
                data: {
                    id: `edge:${item.index}`,
                    edgeIndex: Number(item.index),
                    source: `node:${String(item.edge.from)}`,
                    target: `node:${String(item.edge.to)}`,
                    type: String(item.edge?.type || 'related'),
                },
            }))
        : [];

    return { nodes, edges };
}

function getEdgeNodeOptionsHtml(store, selectedNodeId = '') {
    const selected = String(selectedNodeId || '').trim();
    const options = [`<option value="">${escapeHtml(i18n('(select node)'))}</option>`];
    const nodes = Object.values(store.nodes || {})
        .sort(compareNodesByTimeline);
    for (const node of nodes) {
        const id = String(node.id || '');
        if (!id) {
            continue;
        }
        const label = `${id} | ${node.level}/${node.type} | ${(node.title || '')}`;
        options.push(`<option value="${escapeHtml(id)}"${id === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`);
    }
    if (selected && !nodes.find(node => String(node.id || '') === selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function getEdgeTypeOptionsHtml(store, selectedType = 'related') {
    const selected = String(selectedType || 'related').trim() || 'related';
    const presets = ['contains', 'related', 'mentions', 'involves', 'located_at', 'caused_by', 'follows', 'depends_on'];
    const known = new Set(presets);
    for (const edge of store.edges || []) {
        const type = String(edge?.type || '').trim();
        if (type) {
            known.add(type);
        }
    }
    known.add(selected);
    return [...known]
        .sort((a, b) => a.localeCompare(b))
        .map(type => `<option value="${escapeHtml(type)}"${type === selected ? ' selected' : ''}>${escapeHtml(type)}</option>`)
        .join('');
}

function renderEdgeFormEditorHtml(store, editorId, edge = {}, edgeIndex = -1) {
    const from = String(edge?.from || '').trim();
    const to = String(edge?.to || '').trim();
    const type = String(edge?.type || 'related').trim() || 'related';

    return `
<div id="${editorId}" class="flex-container flexFlowColumn">
    <small style="opacity:0.85">${escapeHtml(i18nFormat('Edge ${0}: configure relation between two nodes.', edgeIndex >= 0 ? `#${edgeIndex}` : i18n('(new)')))}</small>
    <div class="luker-rpg-memory-edge-form-grid">
        <label>${escapeHtml(i18n('From Node'))}
            <select data-field="from" class="text_pole">${getEdgeNodeOptionsHtml(store, from)}</select>
        </label>
        <label>${escapeHtml(i18n('To Node'))}
            <select data-field="to" class="text_pole">${getEdgeNodeOptionsHtml(store, to)}</select>
        </label>
        <label>${escapeHtml(i18n('Type'))}
            <select data-field="type" class="text_pole">${getEdgeTypeOptionsHtml(store, type)}</select>
        </label>
    </div>
</div>`;
}

async function openGraphInspectorPopup(context) {
    await ensureMemoryStoreLoaded(context);
    const chatKey = getChatKey(context);
    const store = getMemoryStore(context);
    if (!store) {
        notifyError(i18n('No active chat selected.'));
        return;
    }

    const popupId = `luker_rpg_memory_graph_popup_${Date.now()}`;
    const selector = `#${popupId}`;
    const namespace = `.lukerGraphPopup_${popupId}`;
    const popupHtml = `<div id="${popupId}" class="luker-rpg-memory-graph-popup">${renderGraphInspectorHtml(store)}</div>`;
    let cy = null;
    let selectedEdgeIndex = -1;
    let selectedNodeId = '';
    let runLayout = null;
    let mountRetryTimer = null;

    const popupPromise = context.callGenericPopup(
        popupHtml,
        context.POPUP_TYPE.TEXT,
        '',
        { wide: true, wider: true, large: true, allowVerticalScrolling: true, allowHorizontalScrolling: true },
    );

    const getStore = () => memoryStoreCache.get(chatKey) || store;
    const getPopupRoot = () => jQuery(selector);
    const getDefaultSelectionText = () => i18n('Visual graph ready. Click a node or edge to select it for editing.');
    const updateSelectionText = (text = '') => {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        popupRoot.find('.luker-rpg-memory-graph-selection').text(String(text || getDefaultSelectionText()));
    };
    const updateInspectorPanel = () => {
        const popupRoot = getPopupRoot();
        const latest = getStore();
        if (!popupRoot.length || !latest) {
            return;
        }
        const slot = popupRoot.find('.luker-rpg-memory-graph-editor-slot');
        if (!slot.length) {
            return;
        }
        if (selectedNodeId) {
            const node = latest.nodes?.[selectedNodeId];
            if (!node) {
                slot.html(`<div class="luker-rpg-memory-graph-editor-empty">${escapeHtml(i18nFormat('Node not found: ${0}', selectedNodeId))}</div>`);
                return;
            }
            const editorId = `${popupId}_inline_node_editor`;
            slot.html(`
<div class="luker-rpg-memory-graph-editor-box">
${renderNodeFormEditorHtml(node, latest, getSettings(), editorId)}
<div class="luker-rpg-memory-graph-inline-actions">
    <div class="menu_button luker-rpg-memory-inline-node-apply">${escapeHtml(i18n('Apply Changes'))}</div>
    <div class="menu_button luker-rpg-memory-inline-node-view" data-node-id="${escapeHtml(selectedNodeId)}">${escapeHtml(i18n('View'))}</div>
</div>
</div>`);
            return;
        }
        if (Number.isInteger(selectedEdgeIndex) && selectedEdgeIndex >= 0) {
            const edge = latest.edges?.[selectedEdgeIndex];
            if (!edge) {
                slot.html(`<div class="luker-rpg-memory-graph-editor-empty">${escapeHtml(i18nFormat('Selected edge index ${0} (missing).', selectedEdgeIndex))}</div>`);
                return;
            }
            const editorId = `${popupId}_inline_edge_editor`;
            slot.html(`
<div class="luker-rpg-memory-graph-editor-box">
${renderEdgeFormEditorHtml(latest, editorId, edge, selectedEdgeIndex)}
<div class="luker-rpg-memory-graph-inline-actions">
    <div class="menu_button luker-rpg-memory-inline-edge-apply">${escapeHtml(i18n('Apply Changes'))}</div>
    <div class="menu_button luker-rpg-memory-inline-edge-delete">${escapeHtml(i18n('Delete'))}</div>
</div>
</div>`);
            return;
        }
        slot.html(`<div class="luker-rpg-memory-graph-editor-empty">${escapeHtml(i18n('Select a node or edge to edit.'))}</div>`);
    };
    const persistLatest = async (latest, successText, statusText) => {
        memoryStoreCache.set(chatKey, latest);
        await persistMemoryStoreByChatKey(context, chatKey, latest);
        refreshUiStats();
        if (statusText) {
            updateUiStatus(statusText);
        }
        if (successText) {
            notifySuccess(successText);
        }
    };
    const mountGraph = async () => {
        const popupRoot = getPopupRoot();
        const latest = getStore();
        if (!popupRoot.length || !latest) {
            return false;
        }
        if (cy) {
            cy.destroy();
            cy = null;
        }

        const container = popupRoot.find('.luker-rpg-memory-graph-cy').get(0);
        if (!container) {
            return false;
        }

        try {
            const cytoscape = await ensureCytoscapeLoaded();
            const elements = buildGraphCytoscapeElements(latest);
            cy = cytoscape({
                container,
                elements,
                wheelSensitivity: 0.2,
                layout: { name: 'preset', fit: true, padding: 20 },
                minZoom: 0.02,
                maxZoom: 5,
                panningEnabled: true,
                userPanningEnabled: true,
                zoomingEnabled: true,
                userZoomingEnabled: true,
                boxSelectionEnabled: false,
                style: [
                    {
                        selector: 'node',
                        style: {
                            label: 'data(label)',
                            'font-size': 12,
                            'text-wrap': 'wrap',
                            'text-max-width': 220,
                            'text-valign': 'center',
                            'text-halign': 'center',
                            color: '#f5f5f5',
                            'text-outline-width': 2,
                            'text-outline-color': '#1a1a1a',
                            'background-color': '#4f7ba7',
                            shape: 'round-rectangle',
                            width: 'label',
                            height: 'label',
                            padding: '14px',
                        },
                    },
                    { selector: 'node[level = "semantic"]', style: { 'background-color': '#3c9b7b' } },
                    { selector: 'node[archived = true]', style: { opacity: 0.45 } },
                    {
                        selector: 'edge',
                        style: {
                            label: '',
                            'font-size': 9,
                            'curve-style': 'taxi',
                            'taxi-direction': 'horizontal',
                            'taxi-turn': 18,
                            'taxi-turn-min-distance': 12,
                            'target-arrow-shape': 'vee',
                            'target-arrow-color': '#8e95a0',
                            'line-color': '#8e95a0',
                            width: 2,
                            'line-opacity': 0.75,
                            color: '#d3d9e2',
                            'text-outline-width': 2,
                            'text-outline-color': '#20242b',
                            'text-opacity': 0,
                        },
                    },
                    {
                        selector: 'edge[type = "contains"]',
                        style: {
                            'line-color': '#3fa66f',
                            'target-arrow-color': '#3fa66f',
                        },
                    },
                    {
                        selector: 'edge:selected',
                        style: {
                            label: 'data(type)',
                            'text-opacity': 1,
                            'line-color': '#ffd96c',
                            'target-arrow-color': '#ffd96c',
                            width: 4,
                        },
                    },
                    {
                        selector: ':selected',
                        style: {
                            'overlay-color': '#ffd96c',
                            'overlay-padding': 6,
                            'overlay-opacity': 0.2,
                            'border-width': 3,
                            'border-color': '#ffd96c',
                        },
                    },
                ],
            });
            const applyViewportFit = () => {
                if (!cy) {
                    return;
                }
                const nodeCount = Number(cy.nodes().length || 0);
                const padding = nodeCount <= 10 ? 20 : nodeCount <= 24 ? 32 : nodeCount <= 48 ? 48 : 64;
                const minComfortZoom = nodeCount <= 8 ? 1.2 : nodeCount <= 16 ? 1.0 : nodeCount <= 32 ? 0.85 : 0.65;
                cy.resize();
                cy.fit(cy.elements(), padding);
                if (cy.zoom() < minComfortZoom) {
                    cy.zoom(minComfortZoom);
                }
                cy.center();
            };
            runLayout = () => {
                if (!cy) {
                    return;
                }
                const current = getStore();
                const refreshed = buildGraphCytoscapeElements(current);
                const positionMap = new Map(
                    refreshed.nodes
                        .map(node => [String(node?.data?.nodeId || ''), node.position])
                        .filter(([id, pos]) => id && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)),
                );
                cy.startBatch();
                cy.nodes().forEach(node => {
                    const nodeId = String(node.data('nodeId') || '');
                    const nextPos = positionMap.get(nodeId);
                    if (nextPos) {
                        node.position(nextPos);
                    }
                });
                cy.endBatch();
                applyViewportFit();
            };
            runLayout();
            setTimeout(() => {
                applyViewportFit();
            }, 0);
            setTimeout(() => {
                applyViewportFit();
            }, 60);
            setTimeout(() => {
                applyViewportFit();
            }, 220);

            cy.on('tap', 'node', (event) => {
                const nodeId = String(event.target.data('nodeId') || '');
                selectedNodeId = nodeId;
                selectedEdgeIndex = -1;
                updateSelectionText(i18nFormat('Selected node: ${0}. Tip: click an edge to edit relation.', nodeId));
                updateInspectorPanel();
            });
            cy.on('tap', 'edge', (event) => {
                const edgeIndex = Number(event.target.data('edgeIndex'));
                if (!Number.isInteger(edgeIndex) || edgeIndex < 0) {
                    return;
                }
                selectedEdgeIndex = edgeIndex;
                selectedNodeId = '';
                const edge = getStore()?.edges?.[edgeIndex];
                if (!edge) {
                    updateSelectionText(i18nFormat('Selected edge index ${0} (missing).', edgeIndex));
                    updateInspectorPanel();
                    return;
                }
                updateSelectionText(i18nFormat(
                    'Selected edge #${0}: ${1} -> ${2} [${3}]',
                    edgeIndex,
                    edge.from,
                    edge.to,
                    edge.type,
                ));
                updateInspectorPanel();
            });
            cy.on('tap', (event) => {
                if (event.target !== cy) {
                    return;
                }
                selectedNodeId = '';
                selectedEdgeIndex = -1;
                updateSelectionText('');
                updateInspectorPanel();
            });
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Cytoscape mount failed`, error);
            updateSelectionText(i18n('Visual graph unavailable: failed to load Cytoscape.'));
            return false;
        }
        return true;
    };
    const mountGraphWithRetry = async (attempt = 0) => {
        const mounted = await mountGraph();
        if (mounted || attempt >= 25) {
            return mounted;
        }
        if (mountRetryTimer) {
            clearTimeout(mountRetryTimer);
            mountRetryTimer = null;
        }
        await new Promise(resolve => {
            mountRetryTimer = setTimeout(resolve, 80);
        });
        mountRetryTimer = null;
        return await mountGraphWithRetry(attempt + 1);
    };
    const rerender = async () => {
        const popupRoot = jQuery(selector);
        const latest = getStore();
        if (!popupRoot.length || !latest) {
            return;
        }
        if (cy) {
            cy.destroy();
            cy = null;
        }
        popupRoot.html(renderGraphInspectorHtml(latest));
        if (!latest.edges?.[selectedEdgeIndex]) {
            selectedEdgeIndex = -1;
        }
        if (!latest.nodes?.[selectedNodeId]) {
            selectedNodeId = '';
        }
        await mountGraphWithRetry();
        if (cy && selectedNodeId && latest.nodes?.[selectedNodeId]) {
            cy.$id(`node:${selectedNodeId}`).select();
        } else if (cy && selectedEdgeIndex >= 0 && latest.edges?.[selectedEdgeIndex]) {
            cy.$id(`edge:${selectedEdgeIndex}`).select();
        }
        if (selectedNodeId && latest.nodes?.[selectedNodeId]) {
            updateSelectionText(i18nFormat('Selected node: ${0}. Tip: click an edge to edit relation.', selectedNodeId));
        } else if (selectedEdgeIndex >= 0 && latest.edges?.[selectedEdgeIndex]) {
            const edge = latest.edges[selectedEdgeIndex];
            updateSelectionText(i18nFormat(
                'Selected edge #${0}: ${1} -> ${2} [${3}]',
                selectedEdgeIndex,
                edge.from,
                edge.to,
                edge.type,
            ));
        } else {
            updateSelectionText('');
        }
        updateInspectorPanel();
    };
    const openEdgeEditor = async (edgeIndex = -1) => {
        const latest = getStore();
        if (!latest) {
            return;
        }
        const isEdit = Number.isInteger(edgeIndex) && edgeIndex >= 0;
        const sourceEdge = isEdit ? latest.edges?.[edgeIndex] : null;
        if (isEdit && !sourceEdge) {
            notifyError(i18nFormat('Edge not found: #${0}', edgeIndex));
            return;
        }
        const editorId = `luker_rpg_memory_edge_editor_${Date.now()}`;
        const editorHtml = renderEdgeFormEditorHtml(
            latest,
            editorId,
            sourceEdge || { from: '', to: '', type: 'related' },
            isEdit ? edgeIndex : -1,
        );
        const result = await context.callGenericPopup(
            editorHtml,
            context.POPUP_TYPE.CONFIRM,
            '',
            {
                okButton: isEdit ? i18n('Apply Edge') : i18n('Create Edge'),
                cancelButton: i18n('Cancel'),
                wide: true,
                wider: true,
                large: false,
                allowVerticalScrolling: true,
                allowHorizontalScrolling: true,
            },
        );
        if (result !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        try {
            const editorRoot = jQuery(`#${editorId}`);
            if (!editorRoot.length) {
                throw new Error(i18n('Edge form not found'));
            }
            const from = String(editorRoot.find('[data-field="from"]').val() || '').trim();
            const to = String(editorRoot.find('[data-field="to"]').val() || '').trim();
            const type = String(editorRoot.find('[data-field="type"]').val() || 'related').trim() || 'related';

            if (!from || !to) {
                throw new Error(i18n('From/To node is required'));
            }
            if (!latest.nodes[from] || !latest.nodes[to]) {
                throw new Error(i18n('From/To node does not exist'));
            }
            if (from === to) {
                throw new Error(i18n('From and To cannot be the same node'));
            }

            const next = {
                from,
                to,
                type,
            };

            if (isEdit) {
                latest.edges[edgeIndex] = next;
                selectedEdgeIndex = edgeIndex;
                await persistLatest(
                    latest,
                    i18nFormat('Edge updated (#${0})', edgeIndex),
                    i18nFormat('Updated edge #${0}.', edgeIndex),
                );
            } else {
                latest.edges.push(next);
                selectedEdgeIndex = latest.edges.length - 1;
                await persistLatest(
                    latest,
                    i18n('Edge created.'),
                    i18nFormat('Created edge #${0}.', selectedEdgeIndex),
                );
            }
            await rerender();
        } catch (error) {
            notifyError(i18nFormat('Edge edit failed: ${0}', error?.message || error));
        }
    };
    const applyNodeEditorFromRoot = async (editorRoot, nodeId) => {
        const latest = getStore();
        if (!latest) {
            return;
        }
        const node = latest?.nodes?.[nodeId];
        if (!node) {
            throw new Error(i18nFormat('Node not found: ${0}', nodeId));
        }
        if (!editorRoot || !editorRoot.length) {
            throw new Error(i18n('Node form not found'));
        }
        const parsedParentId = String(editorRoot.find('[data-field="parentId"]').val() || '').trim();
        if (parsedParentId && !latest.nodes[parsedParentId]) {
            throw new Error(i18nFormat('Parent node does not exist: ${0}', parsedParentId));
        }
        if (parsedParentId === nodeId) {
            throw new Error(i18n('Parent node cannot be itself'));
        }
        if (willCreateParentCycle(latest, nodeId, parsedParentId)) {
            throw new Error(i18n('Parent selection would create a cycle'));
        }

        const target = latest.nodes[nodeId];
        const oldParentId = String(target.parentId || '').trim();

        target.type = String(editorRoot.find('[data-field="type"]').val() || target.type || 'unknown').trim() || 'unknown';
        target.level = String(editorRoot.find('[data-field="level"]').val() || target.level || LEVEL.SEMANTIC).trim() || LEVEL.SEMANTIC;
        target.title = normalizeText(editorRoot.find('[data-field="title"]').val() || target.title || nodeId);
        target.seqTo = parseOptionalNumber(editorRoot.find('[data-field="seqTo"]').val());
        target.archived = Boolean(editorRoot.find('[data-field="archived"]').prop('checked'));
        target.fields = decodeFieldsFromLines(editorRoot.find('[data-field="fieldsLines"]').val());
        setNodeSummary(target, editorRoot.find('[data-field="summary"]').val() || '');

        if (parsedParentId !== oldParentId) {
            if (oldParentId && latest.nodes[oldParentId]) {
                const oldParent = latest.nodes[oldParentId];
                oldParent.childrenIds = (oldParent.childrenIds || []).filter(id => id !== nodeId);
            }
            if (parsedParentId && latest.nodes[parsedParentId]) {
                reparentNode(latest, nodeId, parsedParentId);
            } else {
                target.parentId = '';
            }
        } else if (parsedParentId && latest.nodes[parsedParentId]) {
            const parent = latest.nodes[parsedParentId];
            if (!Array.isArray(parent.childrenIds)) {
                parent.childrenIds = [];
            }
            if (!parent.childrenIds.includes(nodeId)) {
                parent.childrenIds.push(nodeId);
            }
        }

        selectedNodeId = nodeId;
        selectedEdgeIndex = -1;
        await persistLatest(
            latest,
            i18nFormat('Node updated: ${0}', nodeId),
            i18nFormat('Updated node ${0}.', nodeId),
        );
        await rerender();
    };
    const applyEdgeEditorFromRoot = async (editorRoot, edgeIndex) => {
        const latest = getStore();
        if (!latest) {
            return;
        }
        const edge = latest.edges?.[edgeIndex];
        if (!edge) {
            throw new Error(i18nFormat('Edge not found: #${0}', edgeIndex));
        }
        if (!editorRoot || !editorRoot.length) {
            throw new Error(i18n('Edge form not found'));
        }
        const from = String(editorRoot.find('[data-field="from"]').val() || '').trim();
        const to = String(editorRoot.find('[data-field="to"]').val() || '').trim();
        const type = String(editorRoot.find('[data-field="type"]').val() || 'related').trim() || 'related';

        if (!from || !to) {
            throw new Error(i18n('From/To node is required'));
        }
        if (!latest.nodes[from] || !latest.nodes[to]) {
            throw new Error(i18n('From/To node does not exist'));
        }
        if (from === to) {
            throw new Error(i18n('From and To cannot be the same node'));
        }

        latest.edges[edgeIndex] = {
            from,
            to,
            type,
        };
        selectedEdgeIndex = edgeIndex;
        selectedNodeId = '';
        await persistLatest(
            latest,
            i18nFormat('Edge updated (#${0})', edgeIndex),
            i18nFormat('Updated edge #${0}.', edgeIndex),
        );
        await rerender();
    };

    jQuery(document).off(namespace);
    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-node-view`, async function () {
        const nodeId = String(jQuery(this).data('node-id') || '').trim();
        selectedNodeId = nodeId;
        selectedEdgeIndex = -1;
        updateInspectorPanel();
        const latest = getStore();
        const node = latest?.nodes?.[nodeId];
        if (!node) {
            notifyError(i18nFormat('Node not found: ${0}', nodeId));
            return;
        }
        await context.callGenericPopup(
            `<pre style="white-space:pre-wrap; max-height:68vh; overflow:auto;">${escapeHtml(JSON.stringify(node, null, 2))}</pre>`,
            context.POPUP_TYPE.TEXT,
            '',
            { wide: true, large: true, allowVerticalScrolling: true },
        );
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-node-edit`, async function () {
        const nodeId = String(jQuery(this).data('node-id') || '').trim();
        selectedNodeId = nodeId;
        selectedEdgeIndex = -1;
        updateSelectionText(i18nFormat('Selected node: ${0}. Tip: click an edge to edit relation.', nodeId));
        updateInspectorPanel();
        if (cy && nodeId) {
            cy.elements().unselect();
            cy.$id(`node:${nodeId}`).select();
        }
        return;
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-inline-node-view`, async function () {
        const nodeId = String(jQuery(this).data('node-id') || selectedNodeId || '').trim();
        const latest = getStore();
        const node = latest?.nodes?.[nodeId];
        if (!node) {
            notifyError(i18nFormat('Node not found: ${0}', nodeId));
            return;
        }
        await context.callGenericPopup(
            `<pre style="white-space:pre-wrap; max-height:68vh; overflow:auto;">${escapeHtml(JSON.stringify(node, null, 2))}</pre>`,
            context.POPUP_TYPE.TEXT,
            '',
            { wide: true, large: true, allowVerticalScrolling: true },
        );
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-inline-node-apply`, async function () {
        const nodeId = String(selectedNodeId || '').trim();
        if (!nodeId) {
            notifyError(i18n('No node selected. Click a node in graph first.'));
            return;
        }
        const editorRoot = jQuery(`#${popupId}_inline_node_editor`);
        try {
            await applyNodeEditorFromRoot(editorRoot, nodeId);
        } catch (error) {
            notifyError(i18nFormat('Node edit failed: ${0}', error?.message || error));
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-edge-add`, async function () {
        await openEdgeEditor(-1);
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-graph-fit`, function () {
        if (!cy) {
            return;
        }
        const nodeCount = Number(cy.nodes().length || 0);
        const padding = nodeCount <= 10 ? 20 : nodeCount <= 24 ? 32 : nodeCount <= 48 ? 48 : 64;
        const minComfortZoom = nodeCount <= 8 ? 1.2 : nodeCount <= 16 ? 1.0 : nodeCount <= 32 ? 0.85 : 0.65;
        cy.resize();
        cy.fit(cy.elements(), padding);
        if (cy.zoom() < minComfortZoom) {
            cy.zoom(minComfortZoom);
        }
        cy.center();
        updateSelectionText(i18n('Fitted graph view.'));
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-edge-edit`, async function () {
        if (!Number.isInteger(selectedEdgeIndex) || selectedEdgeIndex < 0) {
            notifyError(i18n('No edge selected. Click an edge in graph first.'));
            return;
        }
        await openEdgeEditor(selectedEdgeIndex);
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-edge-edit-row`, async function () {
        const edgeIndex = Number(jQuery(this).data('edge-index'));
        if (!Number.isInteger(edgeIndex) || edgeIndex < 0) {
            return;
        }
        selectedEdgeIndex = edgeIndex;
        selectedNodeId = '';
        const latest = getStore();
        const edge = latest?.edges?.[edgeIndex];
        if (edge) {
            updateSelectionText(i18nFormat(
                'Selected edge #${0}: ${1} -> ${2} [${3}]',
                edgeIndex,
                edge.from,
                edge.to,
                edge.type,
            ));
        }
        updateInspectorPanel();
        if (cy) {
            cy.elements().unselect();
            cy.$id(`edge:${edgeIndex}`).select();
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-inline-edge-apply`, async function () {
        if (!Number.isInteger(selectedEdgeIndex) || selectedEdgeIndex < 0) {
            notifyError(i18n('No edge selected. Click an edge in graph first.'));
            return;
        }
        const editorRoot = jQuery(`#${popupId}_inline_edge_editor`);
        try {
            await applyEdgeEditorFromRoot(editorRoot, selectedEdgeIndex);
        } catch (error) {
            notifyError(i18nFormat('Edge edit failed: ${0}', error?.message || error));
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-inline-edge-delete`, async function () {
        jQuery(`${selector} .luker-rpg-memory-edge-delete`).trigger('click');
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-edge-delete`, async function () {
        const latest = getStore();
        if (!latest) {
            return;
        }
        if (!Number.isInteger(selectedEdgeIndex) || selectedEdgeIndex < 0 || !latest.edges?.[selectedEdgeIndex]) {
            notifyError(i18n('No edge selected. Click an edge in graph first.'));
            return;
        }

        const edge = latest.edges[selectedEdgeIndex];
        const confirm = await context.callGenericPopup(
            i18nFormat(
                'Delete edge #${0}: ${1} -> ${2} [${3}]?',
                selectedEdgeIndex,
                escapeHtml(String(edge.from || '')),
                escapeHtml(String(edge.to || '')),
                escapeHtml(String(edge.type || '')),
            ),
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: i18n('Delete'), cancelButton: i18n('Cancel') },
        );
        if (confirm !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        latest.edges.splice(selectedEdgeIndex, 1);
        await persistLatest(
            latest,
            i18nFormat('Deleted edge #${0}.', selectedEdgeIndex),
            i18n('Deleted selected edge.'),
        );
        selectedEdgeIndex = -1;
        await rerender();
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-graph-raw-view`, async function () {
        const latest = getStore();
        if (!latest) {
            return;
        }
        await context.callGenericPopup(
            `<pre style="white-space:pre-wrap; max-height:72vh; overflow:auto;">${escapeHtml(JSON.stringify(latest, null, 2))}</pre>`,
            context.POPUP_TYPE.TEXT,
            '',
            { wide: true, large: true, allowVerticalScrolling: true },
        );
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-graph-raw-edit`, async function () {
        const latest = getStore();
        if (!latest) {
            return;
        }

        const editorId = `luker_rpg_memory_graph_editor_${Date.now()}`;
        const editorHtml = `
<div class="flex-container flexFlowColumn">
    <small style="opacity:0.85">${escapeHtml(i18n('Advanced: edit full memory graph JSON for current chat.'))}</small>
    <textarea id="${editorId}" class="text_pole textarea_compact" style="min-height:68vh; font-family:monospace;">${escapeHtml(JSON.stringify(latest, null, 2))}</textarea>
</div>`;

        const result = await context.callGenericPopup(
            editorHtml,
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: i18n('Apply Graph'), cancelButton: i18n('Cancel'), wide: true, large: true, allowVerticalScrolling: true },
        );
        if (result !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        try {
            const raw = String(jQuery(`#${editorId}`).val() || '').trim();
            const parsed = JSON.parse(raw);
            const migrated = normalizeStoreForRuntime(parsed);
            updateStoreSourceState(migrated, context);
            memoryStoreCache.set(chatKey, migrated);
            await persistMemoryStoreByChatKey(context, chatKey, migrated);
            refreshUiStats();
            updateUiStatus(i18n('Applied raw graph JSON edit.'));
            notifySuccess(i18n('Memory graph JSON updated.'));
            selectedEdgeIndex = -1;
            await rerender();
        } catch (error) {
            notifyError(i18nFormat('Graph edit failed: ${0}', error?.message || error));
        }
    });

    await mountGraphWithRetry();
    updateInspectorPanel();
    setTimeout(() => { void mountGraphWithRetry(); }, 0);
    setTimeout(() => { void mountGraphWithRetry(); }, 180);
    try {
        await popupPromise;
    } finally {
        jQuery(document).off(namespace);
        if (cy) {
            cy.destroy();
            cy = null;
        }
        if (mountRetryTimer) {
            clearTimeout(mountRetryTimer);
            mountRetryTimer = null;
        }
    }
}

function notifySuccess(message) {
    if (typeof toastr !== 'undefined') {
        toastr.success(String(message));
    }
}

function notifyError(message) {
    if (typeof toastr !== 'undefined') {
        toastr.error(String(message));
    }
}

function notifyInfo(message) {
    if (typeof toastr !== 'undefined') {
        toastr.info(String(message));
    }
}

function notifyEventCompressionIfAny(compressionStats) {
    const eventRounds = getCompressionRoundsByType(compressionStats, 'event');
    if (eventRounds <= 0) {
        return;
    }
    notifyInfo(i18nFormat('Event compression completed: ${0} round(s).', eventRounds));
}

function showRuntimeInfoToast(message, { stopLabel = '', onStop = null } = {}) {
    if (typeof toastr === 'undefined') {
        return;
    }
    if (activeRuntimeInfoToast) {
        toastr.clear(activeRuntimeInfoToast);
        activeRuntimeInfoToast = null;
    }
    activeRuntimeInfoToast = toastr.info(String(message || ''), '', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        progressBar: false,
    });
    const toastBody = activeRuntimeInfoToast ? activeRuntimeInfoToast.find('.toast-message') : null;
    if (toastBody && toastBody.length > 0) {
        toastBody.empty();
        const textNode = jQuery('<div class="luker-rpg-memory-toast-text"></div>');
        textNode.text(String(message || ''));
        toastBody.append(textNode);
        if (typeof onStop === 'function') {
            const button = jQuery('<button type="button" class="menu_button menu_button_small luker-toast-stop-button"></button>');
            button.text(String(stopLabel || i18n('Stop')));
            button.on('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                button.prop('disabled', true);
                const toastElement = button.closest('.toast');
                clearRuntimeInfoToast();
                if (toastElement && toastElement.length > 0) {
                    toastElement.remove();
                }
                onStop();
            });
            toastBody.append(button);
        }
    }
}

function updateRuntimeInfoToastMessage(message) {
    if (!activeRuntimeInfoToast) {
        return;
    }
    const textNode = activeRuntimeInfoToast.find('.luker-rpg-memory-toast-text');
    if (textNode.length > 0) {
        textNode.text(String(message || ''));
    }
}

function clearRuntimeInfoToast() {
    if (typeof toastr === 'undefined' || !activeRuntimeInfoToast) {
        return;
    }
    toastr.clear(activeRuntimeInfoToast);
    activeRuntimeInfoToast = null;
}

function updateUiStatus(text) {
    jQuery('#luker_rpg_memory_status').text(String(text || ''));
}

function refreshUiStats() {
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    const context = getContext();
    const chatKey = getChatKey(context);
    const store = memoryStoreCache.get(chatKey) || createEmptyStore();
    const stats = getStoreStats(store);

    root.find('#luker_rpg_memory_stats').text(
        i18nFormat(
            'nodes=${0}, edges=${1}, messages=${2}, source=${3}, semantic=${4}',
            stats.nodeCount,
            stats.edgeCount,
            stats.messageCount,
            stats.sourceMessageCount,
            stats.levelCount.semantic,
        ),
    );
}

function joinCommaList(list) {
    if (!Array.isArray(list)) {
        return '';
    }
    return list.map(item => String(item || '').trim()).filter(Boolean).join(', ');
}

function splitCommaList(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function joinKeyValueLines(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
        return '';
    }
    return Object.entries(map)
        .map(([key, value]) => `${String(key || '').trim()}=${String(value || '').trim()}`)
        .filter(line => !line.startsWith('=') && !line.endsWith('='))
        .join('\n');
}

function parseKeyValueLines(value) {
    const lines = String(value || '').split(/\r?\n/);
    const result = {};
    for (const line of lines) {
        const trimmed = String(line || '').trim();
        if (!trimmed) {
            continue;
        }
        const idx = trimmed.indexOf('=');
        if (idx <= 0) {
            continue;
        }
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!key || !val) {
            continue;
        }
        result[key] = val;
    }
    return result;
}

function getSchemaTypeTemplate(index = 1) {
    return {
        id: `custom_${index}`,
        label: `Custom Type ${index}`,
        tableName: `custom_table_${index}`,
        tableColumns: ['title'],
        level: LEVEL.SEMANTIC,
        extractHint: '',
        keywords: [],
        columnHints: {},
        requiredColumns: [],
        forceUpdate: false,
        editable: true,
        alwaysInject: false,
        latestOnly: false,
        primaryKeyColumns: [],
        compression: {
            mode: 'none',
            threshold: 6,
            fanIn: 3,
            maxDepth: 6,
            keepRecentLeaves: 0,
            summarizeInstruction: '',
        },
    };
}

function ensureStyles() {
    const existingStyle = jQuery(`#${STYLE_ID}`);
    if (existingStyle.length) {
        existingStyle.remove();
    }

    jQuery('head').append(`
<style id="${STYLE_ID}">
#${UI_BLOCK_ID} .menu_button,
#${UI_BLOCK_ID} .menu_button_small {
    width: auto;
    min-width: max-content;
    white-space: nowrap;
}
#${UI_BLOCK_ID} #luker_rpg_memory_schema_summary {
    display: block;
    margin: 4px 0 8px;
    padding: 6px 9px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.45));
    border-radius: 8px;
    background: linear-gradient(140deg, rgba(27, 43, 36, 0.2), rgba(24, 30, 44, 0.17));
    font-variant-numeric: tabular-nums;
}

.luker-rpg-schema-popup {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    text-align: left;
}

.luker-rpg-schema-popup .menu_button,
.luker-rpg-schema-popup .menu_button_small,
.luker-rpg-memory-graph-popup .menu_button,
.luker-rpg-memory-graph-popup .menu_button_small,
.luker-rpg-memory-advanced-popup .menu_button,
.luker-rpg-memory-advanced-popup .menu_button_small {
    width: auto;
    min-width: max-content;
    white-space: nowrap;
    display: inline-flex;
    writing-mode: horizontal-tb;
    text-orientation: mixed;
}

.luker-rpg-memory-graph-popup .menu_button,
.luker-rpg-memory-graph-popup .menu_button_small {
    min-width: 0;
    white-space: normal;
}

.popup:has(.luker-rpg-memory-graph-popup) {
    width: min(96vw, 1480px) !important;
    max-width: min(96vw, 1480px) !important;
}

.popup:has(.luker-rpg-memory-graph-popup) .popup-content {
    overflow: auto !important;
}

.luker-rpg-schema-popup .luker-schema-topbar {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.45));
    border-radius: 10px;
    padding: 10px;
    background: linear-gradient(155deg, rgba(17, 47, 43, 0.25), rgba(31, 30, 44, 0.2));
}

.luker-rpg-schema-popup .luker-schema-topbar-title {
    font-weight: 700;
    letter-spacing: 0.01em;
}

.luker-rpg-schema-popup .luker-schema-topbar-note {
    opacity: 0.85;
    margin-top: 3px;
    font-size: 0.93em;
}

.luker-rpg-schema-popup .luker-schema-chip-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.luker-rpg-schema-popup .luker-schema-chip {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.45));
    border-radius: 999px;
    padding: 3px 9px;
    font-size: 0.82em;
    background: rgba(255, 255, 255, 0.05);
    white-space: nowrap;
}

.luker-rpg-schema-popup .luker-schema-chip.hier {
    border-color: rgba(69, 164, 133, 0.75);
}

.luker-rpg-schema-popup .luker-schema-chip.latest {
    border-color: rgba(68, 136, 215, 0.75);
}

.luker-rpg-schema-popup .luker-schema-chip.inject {
    border-color: rgba(194, 146, 76, 0.8);
}

.luker-rpg-schema-popup .luker-schema-editor-list {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    max-height: 65vh;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 4px;
    gap: 10px;
}

.luker-rpg-schema-popup .luker-schema-card {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.42));
    border-radius: 11px;
    padding: 10px;
    background: linear-gradient(145deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015));
    box-shadow: 0 4px 12px rgba(0,0,0,0.16);
    border-left-width: 4px;
}

.luker-rpg-schema-popup .luker-schema-card.mode-none {
    border-left-color: rgba(140, 140, 140, 0.9);
}

.luker-rpg-schema-popup .luker-schema-card.mode-hierarchical {
    border-left-color: rgba(58, 173, 118, 0.95);
}

.luker-rpg-schema-popup .luker-schema-card.is-always {
    box-shadow: 0 4px 14px rgba(191, 143, 62, 0.25);
}

.luker-rpg-schema-popup .luker-schema-card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 8px;
}

.luker-rpg-schema-popup .luker-schema-card-title {
    font-size: 1.02em;
    font-weight: 700;
    letter-spacing: 0.01em;
}

.luker-rpg-schema-popup .luker-schema-card-sub {
    opacity: 0.76;
    font-size: 0.86em;
}

.luker-rpg-schema-popup .luker-schema-badges {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.luker-rpg-schema-popup .luker-schema-badge {
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 0.8em;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.42));
    background: rgba(255,255,255,0.05);
}

.luker-rpg-schema-popup .luker-schema-grid-2 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}

.luker-rpg-schema-popup .luker-schema-card label:not(.checkbox_label) {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    min-width: 0;
    gap: 3px;
}

.luker-rpg-schema-popup .text_pole,
.luker-rpg-schema-popup textarea,
.luker-rpg-schema-popup input:not([type="checkbox"]),
.luker-rpg-schema-popup select {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
}

.luker-rpg-schema-popup .luker-schema-card label.checkbox_label {
    display: inline-flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    min-width: 0;
    justify-content: flex-start;
}

.luker-rpg-schema-popup .luker-schema-card label.checkbox_label input[type="checkbox"] {
    width: auto;
    max-width: none;
    min-width: 0;
    margin: 0;
    align-self: center;
}

.luker-rpg-schema-popup .luker-schema-actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
    margin-top: 6px;
}

.luker-rpg-schema-popup .luker-schema-footer {
    display: flex;
    gap: 8px;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    border-top: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    padding-top: 8px;
}

.luker-rpg-schema-popup .luker-schema-footer-note {
    opacity: 0.76;
    font-size: 0.86em;
}

.luker-rpg-schema-popup .luker-schema-footer-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
}

.luker-rpg-memory-graph-popup {
    width: min(1380px, calc(100vw - 48px));
    max-width: min(1380px, calc(100vw - 48px));
    min-width: 0;
    box-sizing: border-box;
    overflow-x: auto;
}

.luker-rpg-memory-graph-popup-inner {
    gap: 8px;
    align-items: stretch;
    text-align: left;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    overflow-x: auto;
}

.luker-rpg-memory-graph-workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
    align-items: stretch;
    width: 100%;
    max-width: 100%;
    min-width: 0;
}

.luker-rpg-memory-graph-toolbar {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
    margin-top: 6px;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
}

.luker-rpg-memory-graph-toolbar .menu_button,
.luker-rpg-memory-graph-toolbar .menu_button_small {
    width: 100%;
    text-align: center;
}

.luker-rpg-memory-graph-canvas-wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 10px;
    background: radial-gradient(circle at 20% 20%, rgba(70, 104, 138, 0.2), rgba(21, 24, 31, 0.25));
    padding: 6px;
}

.luker-rpg-memory-graph-cy {
    width: 100%;
    height: min(62vh, 640px);
    border-radius: 8px;
    background: rgba(10, 12, 16, 0.5);
    cursor: grab;
}

.luker-rpg-memory-graph-selection {
    display: block;
    opacity: 0.9;
    font-size: 0.9em;
}

.luker-rpg-memory-graph-sidepanel {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 10px;
    background: linear-gradient(150deg, rgba(30, 35, 47, 0.35), rgba(12, 14, 20, 0.4));
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: min(62vh, 640px);
    overflow: auto;
}

.luker-rpg-memory-graph-sidehint {
    opacity: 0.8;
    font-size: 0.88em;
}

.luker-rpg-memory-graph-editor-slot {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.luker-rpg-memory-graph-editor-empty {
    opacity: 0.78;
    font-size: 0.9em;
    padding: 8px;
    border: 1px dashed var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.08);
}

.luker-rpg-memory-graph-inline-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
}

.luker-rpg-memory-graph-sidepanel .luker-rpg-memory-node-form {
    min-width: 0;
    width: 100%;
    max-width: 100%;
}

.luker-rpg-memory-graph-sidepanel .luker-rpg-memory-node-form-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
}

.luker-rpg-memory-graph-sidepanel .luker-rpg-memory-edge-form-grid {
    grid-template-columns: repeat(1, minmax(0, 1fr));
}

.luker-rpg-memory-graph-table-wrap {
    max-height: 38vh;
    overflow: auto;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.32));
    border-radius: 8px;
    padding: 4px;
    background: rgba(0, 0, 0, 0.08);
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
}

.luker-rpg-memory-graph-table-wrap table {
    width: 100%;
    table-layout: fixed;
}

.luker-rpg-memory-graph-table-wrap th,
.luker-rpg-memory-graph-table-wrap td {
    word-break: break-word;
    overflow-wrap: anywhere;
}

@media (min-width: 1500px) {
    .luker-rpg-memory-graph-workspace {
        grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr);
    }
}

.luker-rpg-memory-node-form {
    gap: 8px;
    min-width: 0;
    width: 100%;
    max-width: 100%;
}

.luker-rpg-memory-advanced-popup {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: stretch;
    text-align: left;
}

.luker-rpg-memory-advanced-popup label {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.luker-rpg-memory-advanced-actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    flex-wrap: wrap;
}

.luker-rpg-memory-node-form-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
}

.luker-rpg-memory-node-form-flags {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    padding: 2px 0;
}

.luker-rpg-memory-node-form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.luker-rpg-memory-edge-form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}

.luker-rpg-memory-edge-form-grid label {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

@media (max-width: 980px) {
    .luker-rpg-schema-popup {
        width: 100%;
        max-width: 100%;
    }
    .luker-rpg-schema-popup .luker-schema-topbar {
        flex-direction: column;
    }
    .luker-rpg-schema-popup .luker-schema-grid-2 {
        grid-template-columns: 1fr;
    }
    .luker-rpg-schema-popup .luker-schema-footer {
        flex-direction: column;
        align-items: stretch;
    }
    .luker-rpg-schema-popup .luker-schema-footer-actions {
        justify-content: flex-start;
    }
    .luker-rpg-memory-advanced-actions {
        justify-content: flex-start;
    }
    .luker-rpg-memory-graph-workspace {
        grid-template-columns: minmax(0, 1fr);
    }
    .luker-rpg-memory-graph-sidepanel {
        max-height: none;
    }
}
</style>`);
}

function renderPrimaryKeyOptions(columns = [], selected = []) {
    const cols = Array.isArray(columns) ? columns.map(column => String(column || '').trim()).filter(Boolean) : [];
    const selectedSet = new Set(Array.isArray(selected) ? selected.map(column => String(column || '').trim()).filter(Boolean) : []);
    if (cols.length === 0) {
        return `<small style="opacity:0.8">${escapeHtml(i18n('(empty)'))}</small>`;
    }
    return cols.map((column) => `
        <label class="checkbox_label">
            <input type="checkbox" data-field="primaryKeyColumns" value="${escapeHtml(column)}" ${selectedSet.has(column) ? 'checked' : ''} />
            ${escapeHtml(column)}
        </label>
    `).join('');
}

function refreshPrimaryKeyOptionsForCard(card) {
    const root = jQuery(card);
    if (!root.length) {
        return;
    }
    const columns = splitCommaList(root.find('[data-field="tableColumns"]').val());
    const checked = root.find('[data-field="primaryKeyColumns"]:checked')
        .map((_, el) => String(jQuery(el).val() || '').trim())
        .get()
        .filter(Boolean);
    const validChecked = checked.filter(column => columns.includes(column));
    root.find('.luker-schema-primary-key-options').html(renderPrimaryKeyOptions(columns, validChecked));
}

function renderNodeTypeSchemaCard(spec, index) {
        const mode = String(spec?.compression?.mode || 'none');
    const threshold = Number(spec?.compression?.threshold || 6);
    const fanIn = Number(spec?.compression?.fanIn || 3);
    const maxDepth = Number(spec?.compression?.maxDepth || 6);
    const keepRecentLeaves = Number(spec?.compression?.keepRecentLeaves || 0);
    const summarizeInstruction = String(spec?.compression?.summarizeInstruction || '');
    const latestOnly = Boolean(spec?.latestOnly);
    const primaryKeyColumns = Array.isArray(spec?.primaryKeyColumns)
        ? spec.primaryKeyColumns.map(column => String(column || '').trim()).filter(Boolean)
        : [];
    const cardTitle = String(spec?.label || `Type ${index + 1}`).trim();
    const tableName = String(spec?.tableName || spec?.id || '').trim();
    const cardClass = `mode-${mode}${spec.alwaysInject ? ' is-always' : ''}${spec.forceUpdate ? ' is-force' : ''}`;
    return `
<div class="luker-schema-card ${cardClass}" data-index="${index}">
    <div class="luker-schema-card-header">
        <div>
            <div class="luker-schema-card-title">${escapeHtml(cardTitle)}</div>
            <div class="luker-schema-card-sub">${escapeHtml(i18nFormat('table: ${0}', tableName || i18n('(unset)')))}</div>
        </div>
        <div class="luker-schema-badges">
            <span class="luker-schema-badge">${escapeHtml(i18nFormat('mode: ${0}', mode))}</span>
            ${spec.editable ? `<span class="luker-schema-badge">${escapeHtml(i18n('Editable'))}</span>` : `<span class="luker-schema-badge">${escapeHtml(i18n('Create-only'))}</span>`}
            ${spec.alwaysInject ? `<span class="luker-schema-badge">${escapeHtml(i18n('always inject'))}</span>` : ''}
            ${spec.latestOnly ? `<span class="luker-schema-badge">${escapeHtml(i18n('Latest Only Upsert'))}</span>` : ''}
            ${spec.forceUpdate ? `<span class="luker-schema-badge">${escapeHtml(i18n('Force Update (must appear each extraction batch)'))}</span>` : ''}
        </div>
    </div>
    <div class="luker-schema-grid-2">
        <label>${escapeHtml(i18n('Type ID'))}
            <input data-field="id" class="text_pole" type="text" value="${escapeHtml(spec.id)}" />
        </label>
        <label>${escapeHtml(i18n('Label'))}
            <input data-field="label" class="text_pole" type="text" value="${escapeHtml(spec.label)}" />
        </label>
    </div>
    <div class="luker-schema-grid-2">
        <label>${escapeHtml(i18n('Table Name'))}
            <input data-field="tableName" class="text_pole" type="text" value="${escapeHtml(spec.tableName || spec.id)}" />
        </label>
        <label class="checkbox_label luker-schema-checkbox"><input data-field="alwaysInject" type="checkbox" ${spec.alwaysInject ? 'checked' : ''} />${escapeHtml(i18n('Always Inject'))}
        </label>
    </div>
    <label class="checkbox_label luker-schema-checkbox"><input data-field="forceUpdate" type="checkbox" ${spec.forceUpdate ? 'checked' : ''} />${escapeHtml(i18n('Force Update (must appear each extraction batch)'))}
    </label>
    <label class="checkbox_label luker-schema-checkbox"><input data-field="editable" type="checkbox" ${spec.editable ? 'checked' : ''} />${escapeHtml(i18n('Editable (enable edit/delete tools and graph edit context)'))}
    </label>
    <div class="luker-schema-grid-2">
        <label class="checkbox_label luker-schema-checkbox"><input data-field="latestOnly" type="checkbox" ${latestOnly ? 'checked' : ''} />${escapeHtml(i18n('Latest Only Upsert'))}
        </label>
        <div class="luker-schema-latestonly-keys" style="${latestOnly ? '' : 'display:none;'}">
            <label>${escapeHtml(i18n('Primary Key Columns'))}</label>
            <div class="luker-schema-primary-key-options">${renderPrimaryKeyOptions(spec.tableColumns, primaryKeyColumns)}</div>
        </div>
    </div>
    <label>${escapeHtml(i18n('Table Columns (comma separated)'))}
        <input data-field="tableColumns" class="text_pole" type="text" value="${escapeHtml(joinCommaList(spec.tableColumns))}" />
    </label>
    <label>${escapeHtml(i18n('Required Columns (comma separated)'))}
        <input data-field="requiredColumns" class="text_pole" type="text" value="${escapeHtml(joinCommaList(spec.requiredColumns))}" />
    </label>
    <label>${escapeHtml(i18n('Column Hints (one per line: column=meaning)'))}
        <textarea data-field="columnHints" class="text_pole textarea_compact" rows="3">${escapeHtml(joinKeyValueLines(spec.columnHints))}</textarea>
    </label>
    <label>${escapeHtml(i18n('Keywords (comma separated)'))}
        <input data-field="keywords" class="text_pole" type="text" value="${escapeHtml(joinCommaList(spec.keywords))}" />
    </label>
    <label>${escapeHtml(i18n('Extract Hint'))}
        <textarea data-field="extractHint" class="text_pole textarea_compact" rows="2">${escapeHtml(spec.extractHint || '')}</textarea>
    </label>
    <label class="checkbox_label luker-schema-checkbox"><input data-field="compression.enabled" type="checkbox" ${mode === 'hierarchical' ? 'checked' : ''} />${escapeHtml(i18n('Enable Hierarchical Compression'))}
    </label>
    <div class="luker-schema-grid-2 luker-schema-compression-hier" style="${mode === 'hierarchical' ? '' : 'display:none;'}">
        <label>${escapeHtml(i18n('Threshold'))}
            <input data-field="compression.threshold" class="text_pole" type="number" min="2" step="1" value="${threshold}" />
        </label>
        <label>${escapeHtml(i18n('Fan-In'))}
            <input data-field="compression.fanIn" class="text_pole" type="number" min="2" step="1" value="${fanIn}" />
        </label>
    </div>
    <div class="luker-schema-grid-2 luker-schema-compression-hier" style="${mode === 'hierarchical' ? '' : 'display:none;'}">
        <label>${escapeHtml(i18n('Max Depth'))}
            <input data-field="compression.maxDepth" class="text_pole" type="number" min="1" step="1" value="${maxDepth}" />
        </label>
        <label>${escapeHtml(i18n('Keep Recent Leaves'))}
            <input data-field="compression.keepRecentLeaves" class="text_pole" type="number" min="0" step="1" value="${keepRecentLeaves}" />
        </label>
    </div>
    <label class="luker-schema-compression-hier" style="${mode === 'hierarchical' ? '' : 'display:none;'}">${escapeHtml(i18n('Summarize Instruction'))}
        <textarea data-field="compression.summarizeInstruction" class="text_pole textarea_compact" rows="2">${escapeHtml(summarizeInstruction)}</textarea>
    </label>
    <div class="luker-schema-actions">
        <div class="menu_button luker-schema-action" data-action="duplicate">${escapeHtml(i18n('Duplicate Type'))}</div>
        <div class="menu_button luker-schema-action" data-action="remove">${escapeHtml(i18n('Remove Type'))}</div>
    </div>
</div>`;
}

function updateSchemaCardModeUi(card) {
    const root = jQuery(card);
    const enabled = Boolean(root.find('[data-field="compression.enabled"]').prop('checked'));
    const latestOnlyEnabled = Boolean(root.find('[data-field="latestOnly"]').prop('checked'));
    root.find('.luker-schema-compression-hier').toggle(enabled);
    root.find('.luker-schema-latestonly-keys').toggle(latestOnlyEnabled);
}

function readSchemaCard(card) {
    const root = jQuery(card);
    return {
        id: String(root.find('[data-field="id"]').val() || '').trim(),
        label: String(root.find('[data-field="label"]').val() || '').trim(),
        tableName: String(root.find('[data-field="tableName"]').val() || '').trim(),
        tableColumns: splitCommaList(root.find('[data-field="tableColumns"]').val()),
        requiredColumns: splitCommaList(root.find('[data-field="requiredColumns"]').val()),
        columnHints: parseKeyValueLines(root.find('[data-field="columnHints"]').val()),
        level: LEVEL.SEMANTIC,
        extractHint: String(root.find('[data-field="extractHint"]').val() || '').trim(),
        keywords: splitCommaList(root.find('[data-field="keywords"]').val()),
        forceUpdate: Boolean(root.find('[data-field="forceUpdate"]').prop('checked')),
        editable: Boolean(root.find('[data-field="editable"]').prop('checked')),
        alwaysInject: Boolean(root.find('[data-field="alwaysInject"]').prop('checked')),
        latestOnly: Boolean(root.find('[data-field="latestOnly"]').prop('checked')),
        primaryKeyColumns: root.find('[data-field="primaryKeyColumns"]:checked')
            .map((_, el) => String(jQuery(el).val() || '').trim())
            .get()
            .filter(Boolean),
        compression: {
            mode: Boolean(root.find('[data-field="compression.enabled"]').prop('checked')) ? 'hierarchical' : 'none',
            threshold: Math.max(2, Number(root.find('[data-field="compression.threshold"]').val()) || 6),
            fanIn: Math.max(2, Number(root.find('[data-field="compression.fanIn"]').val()) || 3),
            maxDepth: Math.max(1, Number(root.find('[data-field="compression.maxDepth"]').val()) || 6),
            keepRecentLeaves: Math.max(0, Number(root.find('[data-field="compression.keepRecentLeaves"]').val()) || 0),
            summarizeInstruction: String(root.find('[data-field="compression.summarizeInstruction"]').val() || '').trim(),
        },
    };
}

function readNodeTypeSchemaEditor(root, listSelector = '#luker_rpg_memory_schema_editor_list') {
    const cards = root.find(`${listSelector} .luker-schema-card`);
    const raw = [];
    cards.each((_, card) => raw.push(readSchemaCard(card)));
    return normalizeNodeTypeSchema(raw);
}

function renderNodeTypeSchemaEditor(root, schema, listSelector = '#luker_rpg_memory_schema_editor_list') {
    const list = root.find(listSelector);
    if (!list.length) {
        return;
    }
    const normalized = normalizeNodeTypeSchema(schema);
    list.html(normalized.map((spec, index) => renderNodeTypeSchemaCard(spec, index)).join(''));
    list.find('.luker-schema-card').each((_, card) => updateSchemaCardModeUi(card));
    list.off('change.lukerSchemaMode input.lukerSchemaMode');
    list.on('change.lukerSchemaMode', '[data-field="compression.enabled"],[data-field="latestOnly"]', function () {
        updateSchemaCardModeUi(jQuery(this).closest('.luker-schema-card'));
        refreshPrimaryKeyOptionsForCard(jQuery(this).closest('.luker-schema-card'));
    });
    list.on('input.lukerSchemaMode change.lukerSchemaMode', '[data-field="tableColumns"]', function () {
        refreshPrimaryKeyOptionsForCard(jQuery(this).closest('.luker-schema-card'));
    });
}

function updateSchemaSummary(root, schema) {
    const normalized = normalizeNodeTypeSchema(schema);
    const total = normalized.length;
    const alwaysInject = normalized.filter(item => item.alwaysInject).length;
    const forceUpdate = normalized.filter(item => item.forceUpdate).length;
    const editable = normalized.filter(item => item.editable).length;
    const hierarchical = normalized.filter(item => String(item?.compression?.mode || '') === 'hierarchical').length;
    root.find('#luker_rpg_memory_schema_summary').text(i18nFormat(
        'Types: ${0} | Editable: ${1} | Always Inject: ${2} | Force Update: ${3} | Hierarchical: ${4}',
        total,
        editable,
        alwaysInject,
        forceUpdate,
        hierarchical,
    ));
}

function updateSchemaScopeIndicator(root, scopeInfo) {
    const scopeText = scopeInfo?.hasOverride
        ? i18nFormat('Schema scope: character override (${0})', scopeInfo.characterName || scopeInfo.avatar || i18n('(unset)'))
        : i18n('Schema scope: global');
    root.find('#luker_rpg_memory_schema_scope').text(scopeText);
}

async function persistSchemaToGlobal(settings, schema) {
    settings.nodeTypeSchema = normalizeNodeTypeSchema(schema);
    await saveSettings();
}

async function persistSchemaToCharacter(context, avatar, schema) {
    const targetAvatar = String(avatar || '').trim();
    if (!targetAvatar) {
        return false;
    }
    return await persistCharacterSchemaOverride(context, targetAvatar, schema);
}

async function persistSchemaToEffectiveScope(context, settings, schema) {
    const info = getSchemaScopeInfo(context, settings);
    if (info.hasOverride && info.hasAvatar) {
        const ok = await persistSchemaToCharacter(context, info.avatar, schema);
        if (!ok) {
            return { ok: false, scope: 'character' };
        }
        return { ok: true, scope: 'character', avatar: info.avatar, characterName: info.characterName };
    }
    await persistSchemaToGlobal(settings, schema);
    return { ok: true, scope: 'global' };
}

function buildSchemaEditorPopupHtml(popupId, schema) {
    const normalized = normalizeNodeTypeSchema(schema);
    const cardsHtml = normalized.map((spec, index) => renderNodeTypeSchemaCard(spec, index)).join('');
    return `
<div id="${popupId}" class="luker-rpg-schema-popup">
    <div class="luker-schema-topbar">
        <div>
            <div class="luker-schema-topbar-title">${escapeHtml(i18n('Memory Node Schema Editor'))}</div>
            <div class="luker-schema-topbar-note">${escapeHtml(i18n('Define node tables, extraction hints, and compression strategy. This controls what your memory graph stores and how it compacts over time.'))}</div>
        </div>
        <div class="luker-schema-chip-row">
            <span class="luker-schema-chip hier">${escapeHtml(i18n('Hierarchical Compression'))}</span>
            <span class="luker-schema-chip latest">${escapeHtml(i18n('Latest-only Merge'))}</span>
            <span class="luker-schema-chip inject">${escapeHtml(i18n('Always Inject'))}</span>
        </div>
    </div>
    <div class="luker-schema-editor-list">${cardsHtml}</div>
    <div class="luker-schema-footer">
        <div class="luker-schema-footer-note">${escapeHtml(i18nFormat('Current type count: ${0}', normalized.length))}</div>
        <div class="luker-schema-footer-actions">
            <div class="menu_button luker-schema-editor-add">${escapeHtml(i18n('Add Type'))}</div>
            <div class="menu_button luker-schema-editor-reset">${escapeHtml(i18n('Reset to Default Schema'))}</div>
        </div>
    </div>
</div>`;
}

async function openSchemaEditorPopup(context, settings, root) {
    ensureStyles();
    const popupId = `luker_rpg_memory_schema_popup_${Date.now()}`;
    const scopeInfo = getSchemaScopeInfo(context, settings);
    const popupHtml = buildSchemaEditorPopupHtml(popupId, scopeInfo.schema);
    const namespace = `.lukerSchemaPopup_${popupId}`;
    const selector = `#${popupId}`;
    const listSelector = '.luker-schema-editor-list';

    const getPopupRoot = () => jQuery(selector);
    const readCurrentSchema = () => {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return null;
        }
        return readNodeTypeSchemaEditor(popupRoot, listSelector);
    };
    const rerender = (schema) => {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        renderNodeTypeSchemaEditor(popupRoot, schema, listSelector);
    };
    let capturedSchema = null;
    const popupPromise = context.callGenericPopup(
        popupHtml,
        context.POPUP_TYPE.CONFIRM,
        '',
        {
            okButton: i18n('Apply Schema'),
            cancelButton: i18n('Cancel'),
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            onClosing: () => {
                capturedSchema = readCurrentSchema();
                return true;
            },
        },
    );

    jQuery(document).off(namespace);
    jQuery(document).on(`change${namespace}`, `${selector} [data-field="compression.enabled"], ${selector} [data-field="latestOnly"]`, function () {
        const card = jQuery(this).closest('.luker-schema-card');
        updateSchemaCardModeUi(card);
        refreshPrimaryKeyOptionsForCard(card);
    });
    jQuery(document).on(`input${namespace} change${namespace}`, `${selector} [data-field="tableColumns"]`, function () {
        const card = jQuery(this).closest('.luker-schema-card');
        refreshPrimaryKeyOptionsForCard(card);
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-schema-editor-add`, function () {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        const current = readNodeTypeSchemaEditor(popupRoot, listSelector);
        current.push(getSchemaTypeTemplate(current.length + 1));
        rerender(current);
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-schema-editor-reset`, function () {
        if (!window.confirm(i18n('Reset schema editor content to default? This will overwrite current unsaved schema edits.'))) {
            return;
        }
        rerender(normalizeNodeTypeSchema(structuredClone(defaultNodeTypeSchema)));
        notifySuccess(i18n('Schema reset to default in editor.'));
    });
    jQuery(document).on(`click${namespace}`, `${selector} .luker-schema-action`, function () {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        const card = jQuery(this).closest('.luker-schema-card');
        const index = Number(card.data('index'));
        const action = String(jQuery(this).data('action') || '');
        const current = readNodeTypeSchemaEditor(popupRoot, listSelector);
        if (!Number.isInteger(index) || index < 0 || index >= current.length) {
            return;
        }

        if (action === 'duplicate') {
            const clone = structuredClone(current[index]);
            clone.id = `${clone.id || 'custom'}_copy_${Date.now()}`;
            clone.label = `${clone.label || 'Custom'} Copy`;
            current.splice(index + 1, 0, clone);
            rerender(current);
            return;
        }

        if (action === 'remove') {
            current.splice(index, 1);
            if (current.length === 0) {
                current.push(getSchemaTypeTemplate(1));
            }
            rerender(current);
        }
    });

    try {
        const result = await popupPromise;
        if (result !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        const nextSchema = Array.isArray(capturedSchema) && capturedSchema.length > 0
            ? capturedSchema
            : readCurrentSchema();
        if (!Array.isArray(nextSchema) || nextSchema.length === 0) {
            notifyError(i18n('Failed to read schema from editor.'));
            return;
        }
        const resultInfo = await persistSchemaToEffectiveScope(context, settings, nextSchema);
        if (!resultInfo.ok) {
            notifyError(i18n('Failed to persist character schema override.'));
            return;
        }
        const nextScopeInfo = getSchemaScopeInfo(context, settings);
        updateSchemaSummary(root, nextScopeInfo.schema);
        updateSchemaScopeIndicator(root, nextScopeInfo);
        notifySuccess(i18n('Memory schema updated.'));
        updateUiStatus(i18n('Applied memory schema from popup editor.'));
        bindUi();
    } finally {
        jQuery(document).off(namespace);
    }
}

function buildAdvancedSettingsPopupHtml(popupId, settings) {
    const extractPrompt = String(settings.extractSystemPrompt || defaultSettings.extractSystemPrompt || '');
    const routePrompt = String(settings.recallRouteSystemPrompt || defaultSettings.recallRouteSystemPrompt || '');
    const finalizePrompt = String(settings.recallFinalizeSystemPrompt || defaultSettings.recallFinalizeSystemPrompt || '');
    return `
<div id="${popupId}" class="luker-rpg-memory-advanced-popup">
    <h3 class="margin0">${escapeHtml(i18n('Advanced Settings'))}</h3>
    <label>${escapeHtml(i18n('Exclude latest N messages from memory injection'))}
        <input id="${popupId}_recent_raw_turns" class="text_pole" type="number" min="0" step="1" value="${Number(settings.recentRawTurns || defaultSettings.recentRawTurns)}" />
    </label>
    <label>${escapeHtml(i18n('Recall max iterations'))}
        <input id="${popupId}_recall_iterations" class="text_pole" type="number" min="2" max="6" step="1" value="${Number(settings.recallMaxIterations || defaultSettings.recallMaxIterations)}" />
    </label>
    <label>${escapeHtml(i18n('Tool-call retries'))}
        <input id="${popupId}_tool_retries" class="text_pole" type="number" min="0" max="10" step="1" value="${Math.max(0, Math.min(10, Number(settings.toolCallRetryMax ?? defaultSettings.toolCallRetryMax)))}" />
    </label>
    <label>${escapeHtml(i18n('Extract context assistant turns'))}
        <input id="${popupId}_extract_context_turns" class="text_pole" type="number" min="1" max="32" step="1" value="${Math.max(1, Math.min(32, Number(settings.extractContextTurns || defaultSettings.extractContextTurns)))}" />
    </label>
    <label>${escapeHtml(i18n('Recall query recent messages'))}
        <input id="${popupId}_recall_query_messages" class="text_pole" type="number" min="1" max="64" step="1" value="${Math.max(1, Math.min(64, Number(settings.recallQueryMessages || defaultSettings.recallQueryMessages)))}" />
    </label>
    <label>${escapeHtml(i18n('Extract batch assistant turns'))}
        <input id="${popupId}_extract_batch_turns" class="text_pole" type="number" min="1" step="1" value="${Math.max(1, Number(settings.extractBatchTurns || defaultSettings.extractBatchTurns))}" />
    </label>
    <label>${escapeHtml(i18n('Extract Table Fill Prompt'))}
        <textarea id="${popupId}_extract_system_prompt" class="text_pole textarea_compact" rows="8">${escapeHtml(extractPrompt)}</textarea>
    </label>
    <label>${escapeHtml(i18n('Recall Stage 1 Prompt (Route/Drill)'))}
        <textarea id="${popupId}_recall_route_prompt" class="text_pole textarea_compact" rows="8">${escapeHtml(routePrompt)}</textarea>
    </label>
    <label>${escapeHtml(i18n('Recall Stage 2 Prompt (Finalize)'))}
        <textarea id="${popupId}_recall_finalize_prompt" class="text_pole textarea_compact" rows="8">${escapeHtml(finalizePrompt)}</textarea>
    </label>
    <div class="luker-rpg-memory-advanced-actions">
        <div id="${popupId}_reset_advanced" class="menu_button">${escapeHtml(i18n('Reset Advanced Settings'))}</div>
    </div>
</div>`;
}

async function openAdvancedSettingsPopup(context, settings, root) {
    const popupId = `luker_rpg_memory_advanced_popup_${Date.now()}`;
    const html = buildAdvancedSettingsPopupHtml(popupId, settings);
    const applyValuesToPopup = (popupRoot, source) => {
        if (!popupRoot?.length) {
            return;
        }
        popupRoot.find(`#${popupId}_recent_raw_turns`).val(String(Math.max(0, Number(source.recentRawTurns ?? defaultSettings.recentRawTurns))));
        popupRoot.find(`#${popupId}_recall_iterations`).val(String(Math.max(2, Math.min(6, Number(source.recallMaxIterations ?? defaultSettings.recallMaxIterations)))));
        popupRoot.find(`#${popupId}_tool_retries`).val(String(Math.max(0, Math.min(10, Number(source.toolCallRetryMax ?? defaultSettings.toolCallRetryMax)))));
        popupRoot.find(`#${popupId}_extract_context_turns`).val(String(Math.max(1, Math.min(32, Number(source.extractContextTurns ?? defaultSettings.extractContextTurns)))));
        popupRoot.find(`#${popupId}_recall_query_messages`).val(String(Math.max(1, Math.min(64, Number(source.recallQueryMessages ?? defaultSettings.recallQueryMessages)))));
        popupRoot.find(`#${popupId}_extract_batch_turns`).val(String(Math.max(1, Number(source.extractBatchTurns ?? defaultSettings.extractBatchTurns))));
        popupRoot.find(`#${popupId}_extract_system_prompt`).val(String(source.extractSystemPrompt || DEFAULT_EXTRACT_SYSTEM_PROMPT));
        popupRoot.find(`#${popupId}_recall_route_prompt`).val(String(source.recallRouteSystemPrompt || DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT));
        popupRoot.find(`#${popupId}_recall_finalize_prompt`).val(String(source.recallFinalizeSystemPrompt || DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT));
    };
    const readAdvancedValues = () => {
        const popupRoot = jQuery(`#${popupId}`);
        if (!popupRoot.length) {
            return null;
        }
        return {
            recentRawTurnsValue: Number(popupRoot.find(`#${popupId}_recent_raw_turns`).val()),
            recallIterationsValue: Number(popupRoot.find(`#${popupId}_recall_iterations`).val()),
            toolRetriesValue: Number(popupRoot.find(`#${popupId}_tool_retries`).val()),
            extractContextTurnsValue: Number(popupRoot.find(`#${popupId}_extract_context_turns`).val()),
            recallQueryMessagesValue: Number(popupRoot.find(`#${popupId}_recall_query_messages`).val()),
            extractBatchTurnsValue: Number(popupRoot.find(`#${popupId}_extract_batch_turns`).val()),
            extractSystemPromptValue: String(popupRoot.find(`#${popupId}_extract_system_prompt`).val() || '').trim(),
            recallRoutePromptValue: String(popupRoot.find(`#${popupId}_recall_route_prompt`).val() || '').trim(),
            recallFinalizePromptValue: String(popupRoot.find(`#${popupId}_recall_finalize_prompt`).val() || '').trim(),
        };
    };
    let capturedValues = null;
    const result = await context.callGenericPopup(
        html,
        context.POPUP_TYPE.CONFIRM,
        '',
        {
            okButton: i18n('Save Advanced Settings'),
            cancelButton: i18n('Cancel'),
            wide: true,
            large: false,
            allowVerticalScrolling: true,
            onOpen: () => {
                const popupRoot = jQuery(`#${popupId}`);
                popupRoot.find(`#${popupId}_reset_advanced`).off('click').on('click', () => {
                    if (!window.confirm(i18n('Reset advanced settings editor to default? This will overwrite current unsaved advanced edits.'))) {
                        return;
                    }
                    applyValuesToPopup(popupRoot, defaultSettings);
                    notifySuccess(i18n('Advanced settings reset to defaults in editor.'));
                });
            },
            onClosing: () => {
                capturedValues = readAdvancedValues();
                return true;
            },
        },
    );

    if (result !== context.POPUP_RESULT.AFFIRMATIVE) {
        return;
    }
    const values = capturedValues || readAdvancedValues();
    if (!values) {
        notifyError(i18n('Failed to read advanced settings.'));
        return;
    }

    settings.recentRawTurns = Math.max(
        0,
        Math.floor(Number.isFinite(values.recentRawTurnsValue) ? values.recentRawTurnsValue : defaultSettings.recentRawTurns),
    );
    settings.recallMaxIterations = Math.max(
        2,
        Math.min(6, Math.floor(Number.isFinite(values.recallIterationsValue) ? values.recallIterationsValue : defaultSettings.recallMaxIterations)),
    );
    settings.toolCallRetryMax = Math.max(
        0,
        Math.min(10, Math.floor(Number.isFinite(values.toolRetriesValue) ? values.toolRetriesValue : defaultSettings.toolCallRetryMax)),
    );
    settings.extractContextTurns = Math.max(
        1,
        Math.min(32, Math.floor(Number.isFinite(values.extractContextTurnsValue) ? values.extractContextTurnsValue : defaultSettings.extractContextTurns)),
    );
    settings.recallQueryMessages = Math.max(
        1,
        Math.min(64, Math.floor(Number.isFinite(values.recallQueryMessagesValue) ? values.recallQueryMessagesValue : defaultSettings.recallQueryMessages)),
    );
    settings.extractBatchTurns = Math.max(
        1,
        Math.floor(Number.isFinite(values.extractBatchTurnsValue) ? values.extractBatchTurnsValue : defaultSettings.extractBatchTurns),
    );
    settings.extractSystemPrompt = values.extractSystemPromptValue || DEFAULT_EXTRACT_SYSTEM_PROMPT;
    settings.recallRouteSystemPrompt = values.recallRoutePromptValue || DEFAULT_RECALL_ROUTE_SYSTEM_PROMPT;
    settings.recallFinalizeSystemPrompt = values.recallFinalizePromptValue || DEFAULT_RECALL_FINALIZE_SYSTEM_PROMPT;

    saveSettingsDebounced();
    notifySuccess(i18n('Advanced settings saved.'));
    updateUiStatus(i18n('Saved advanced settings.'));
    bindUi();
    if (root?.length) {
        const scopeInfo = getSchemaScopeInfo(context, settings);
        updateSchemaSummary(root, scopeInfo.schema);
        updateSchemaScopeIndicator(root, scopeInfo);
    }
}

function getCompressibleTypeSpecs(settings, context = null) {
    const schema = getEffectiveNodeTypeSchema(context, settings);
    const specs = [];
    for (const item of schema) {
        const typeId = String(item?.id || '').trim().toLowerCase();
        if (!typeId) {
            continue;
        }
        const config = getSemanticCompressionConfig(settings, typeId, context);
        if (config.mode === 'none') {
            continue;
        }
        specs.push({
            id: typeId,
            label: String(item?.label || typeId),
            mode: config.mode,
        });
    }
    return specs;
}

function buildManualCompressionPopupHtml(popupId, settings, compressibleTypes) {
    const excludeRecentDefault = Math.max(0, Number(settings.recentRawTurns || 0));
    const maxRoundsDefault = 3;
    const typeRows = compressibleTypes.map(item => `
        <label class="checkbox_label">
            <input type="checkbox" data-field="type" value="${escapeHtml(item.id)}" checked />
            ${escapeHtml(`${item.label} (${item.id}, ${item.mode})`)}
        </label>
    `).join('');
    return `
<div id="${popupId}" class="luker-rpg-memory-advanced-popup">
    <h3 class="margin0">${escapeHtml(i18n('Manual Compression'))}</h3>
    <label>${escapeHtml(i18n('Compression scope'))}
        <select id="${popupId}_scope" class="text_pole">
            <option value="all">${escapeHtml(i18n('All nodes'))}</option>
            <option value="older" selected>${escapeHtml(i18n('Older nodes only (exclude recent N assistant turns)'))}</option>
        </select>
    </label>
    <label>${escapeHtml(i18n('Exclude recent assistant turns'))}
        <input id="${popupId}_exclude_recent" class="text_pole" type="number" min="0" step="1" value="${excludeRecentDefault}" />
    </label>
    <label>${escapeHtml(i18n('Compression mode'))}
        <select id="${popupId}_mode" class="text_pole">
            <option value="schema" selected>${escapeHtml(i18n('Use schema thresholds'))}</option>
            <option value="force">${escapeHtml(i18n('Force compress (ignore threshold)'))}</option>
        </select>
    </label>
    <label>${escapeHtml(i18n('Max rounds per type'))}
        <input id="${popupId}_max_rounds" class="text_pole" type="number" min="1" step="1" value="${maxRoundsDefault}" />
    </label>
    <label>${escapeHtml(i18n('Types to compress'))}</label>
    <div id="${popupId}_types" style="max-height: 200px; overflow: auto; border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; padding: 8px;">
        ${typeRows}
    </div>
</div>`;
}

async function openManualCompressionPopup(context, settings) {
    const compressibleTypes = getCompressibleTypeSpecs(settings, context);
    if (compressibleTypes.length === 0) {
        notifyError(i18n('No compressible types in current schema.'));
        return;
    }
    await ensureMemoryStoreLoaded(context);
    const store = getMemoryStore(context);
    if (!store) {
        notifyError(i18n('No active chat selected.'));
        return;
    }

    const popupId = `luker_rpg_memory_manual_compress_${Date.now()}`;
    const html = buildManualCompressionPopupHtml(popupId, settings, compressibleTypes);
    const readValues = () => {
        const popupRoot = jQuery(`#${popupId}`);
        if (!popupRoot.length) {
            return null;
        }
        const selectedTypeIds = popupRoot
            .find('input[data-field="type"]:checked')
            .map((_, el) => String(jQuery(el).val() || '').trim().toLowerCase())
            .get()
            .filter(Boolean);
        return {
            scope: String(popupRoot.find(`#${popupId}_scope`).val() || 'all').trim(),
            mode: String(popupRoot.find(`#${popupId}_mode`).val() || 'schema').trim(),
            excludeRecent: Math.max(0, Math.floor(Number(popupRoot.find(`#${popupId}_exclude_recent`).val()) || 0)),
            maxRoundsPerType: Math.max(1, Math.floor(Number(popupRoot.find(`#${popupId}_max_rounds`).val()) || 1)),
            selectedTypeIds,
        };
    };

    let captured = null;
    const result = await context.callGenericPopup(
        html,
        context.POPUP_TYPE.CONFIRM,
        '',
        {
            okButton: i18n('Apply Manual Compression'),
            cancelButton: i18n('Cancel'),
            wide: true,
            large: false,
            allowVerticalScrolling: true,
            onClosing: () => {
                captured = readValues();
                return true;
            },
        },
    );
    if (result !== context.POPUP_RESULT.AFFIRMATIVE) {
        return;
    }
    const values = captured || readValues();
    if (!values) {
        notifyError(i18n('Failed to read advanced settings.'));
        return;
    }
    if (!Array.isArray(values.selectedTypeIds) || values.selectedTypeIds.length === 0) {
        notifyError(i18n('Select at least one type to compress.'));
        return;
    }

    let maxSeq = null;
    if (values.scope === 'older') {
        const latestSeq = Math.max(0, Number(buildPlayableFramesFromContext(context).length || 0));
        maxSeq = Math.max(0, latestSeq - Math.max(0, values.excludeRecent));
        if (maxSeq <= 0) {
            notifyError(i18n('No nodes are eligible for the selected scope.'));
            return;
        }
    }

    const beforeNodes = Object.values(store.nodes || {});
    const beforeNodeCount = beforeNodes.length;
    const beforeArchivedCount = beforeNodes.filter(node => Boolean(node?.archived)).length;
    const compressionStats = createCompressionStats();
    const compressionAbortController = new AbortController();
    activeExtractionAbortController = compressionAbortController;
    showRuntimeInfoToast(i18n('Memory graph update running...'), {
        stopLabel: i18n('Stop'),
        onStop: () => {
            if (!compressionAbortController.signal.aborted) {
                compressionAbortController.abort();
            }
        },
    });
    try {
        const changed = await runCompressionLoop(context, store, settings, {
            typeIds: values.selectedTypeIds,
            force: values.mode === 'force',
            maxRoundsPerType: values.maxRoundsPerType,
            maxSeq,
            compressionStats,
            abortSignal: compressionAbortController.signal,
        });
        if (!changed) {
            notifySuccess(i18n('Manual compression made no changes.'));
            return;
        }
        const afterNodes = Object.values(store.nodes || {});
        const afterNodeCount = afterNodes.length;
        const afterArchivedCount = afterNodes.filter(node => Boolean(node?.archived)).length;
        const createdDelta = Math.max(0, afterNodeCount - beforeNodeCount);
        const archivedDelta = Math.max(0, afterArchivedCount - beforeArchivedCount);
        await persistMemoryStoreByChatKey(context, getChatKey(context), store);
        refreshUiStats();
        const summary = i18nFormat('Manual compression completed. Created=${0}, archived=${1}', createdDelta, archivedDelta);
        notifySuccess(summary);
        notifyEventCompressionIfAny(compressionStats);
        updateUiStatus(summary);
    } catch (error) {
        if (isAbortError(error, compressionAbortController.signal)) {
            updateUiStatus(i18n('Memory graph update cancelled by user.'));
            return;
        }
        console.warn(`[${MODULE_NAME}] Manual compression failed`, error);
        notifyError(i18nFormat('Recall injection failed (${0}): ${1}', 'compress', String(error?.message || error)));
    } finally {
        if (activeExtractionAbortController === compressionAbortController) {
            activeExtractionAbortController = null;
        }
        clearRuntimeInfoToast();
    }
}

function bindUi() {
    const context = getContext();
    const settings = getSettings();
    const root = jQuery(`#${UI_BLOCK_ID}`);

    if (!root.length) {
        return;
    }

    root.find('#luker_rpg_memory_enabled').prop('checked', Boolean(settings.enabled));
    root.find('#luker_rpg_memory_plain_text_calls').prop('checked', isPlainTextFunctionCallModeEnabled(settings));
    root.find('#luker_rpg_memory_recall_enabled').prop('checked', Boolean(settings.recallEnabled));
    root.find('#luker_rpg_memory_recall_api_preset').val(String(settings.recallApiPresetName || ''));
    root.find('#luker_rpg_memory_recall_preset').val(String(settings.recallPresetName || ''));
    root.find('#luker_rpg_memory_extract_api_preset').val(String(settings.extractApiPresetName || ''));
    root.find('#luker_rpg_memory_extract_preset').val(String(settings.extractPresetName || ''));
    root.find('#luker_rpg_memory_projection_enabled').prop('checked', Boolean(settings.lorebookProjectionEnabled));
    root.find('#luker_rpg_memory_update_every').val(String(settings.updateEvery));
    const schemaScopeInfo = getSchemaScopeInfo(context, settings);
    updateSchemaSummary(root, schemaScopeInfo.schema);
    updateSchemaScopeIndicator(root, schemaScopeInfo);
    root.find('#luker_rpg_memory_schema_save_character').prop('disabled', !schemaScopeInfo.hasAvatar);
    root.find('#luker_rpg_memory_schema_clear_character_override').prop('disabled', !(schemaScopeInfo.hasAvatar && schemaScopeInfo.hasOverride));
    refreshOpenAIPresetSelectors(root, context, settings);

    ensureMemoryStoreLoaded(context)
        .then(() => refreshUiStats())
        .catch(() => refreshUiStats());

    root.find('#luker_rpg_memory_enabled').off('input').on('input', function () {
        settings.enabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_plain_text_calls').off('input').on('input', function () {
        settings.plainTextFunctionCallMode = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_recall_enabled').off('input').on('input', function () {
        settings.recallEnabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_recall_api_preset').off('change').on('change', function () {
        settings.recallApiPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_recall_preset').off('change').on('change', function () {
        settings.recallPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_extract_api_preset').off('change').on('change', function () {
        settings.extractApiPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_extract_preset').off('change').on('change', function () {
        settings.extractPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_projection_enabled').off('input').on('input', function () {
        settings.lorebookProjectionEnabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_update_every').off('change input').on('change input', function () {
        const nextValue = Math.max(1, Math.floor(Number(jQuery(this).val()) || defaultSettings.updateEvery));
        settings.updateEvery = nextValue;
        jQuery(this).val(String(nextValue));
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_open_schema_editor').off('click').on('click', async function () {
        await openSchemaEditorPopup(context, settings, root);
    });
    root.find('#luker_rpg_memory_schema_save_global').off('click').on('click', async function () {
        const info = getSchemaScopeInfo(context, settings);
        await persistSchemaToGlobal(settings, info.schema);
        const nextScopeInfo = getSchemaScopeInfo(context, settings);
        updateSchemaSummary(root, nextScopeInfo.schema);
        updateSchemaScopeIndicator(root, nextScopeInfo);
        notifySuccess(i18n('Schema saved to global settings.'));
        updateUiStatus(i18n('Schema saved to global settings.'));
        bindUi();
    });
    root.find('#luker_rpg_memory_schema_save_character').off('click').on('click', async function () {
        const info = getSchemaScopeInfo(context, settings);
        if (!info.hasAvatar) {
            notifyError(i18n('No active character selected.'));
            return;
        }
        const ok = await persistSchemaToCharacter(context, info.avatar, info.schema);
        if (!ok) {
            notifyError(i18n('Failed to persist character schema override.'));
            return;
        }
        const nextScopeInfo = getSchemaScopeInfo(context, settings);
        updateSchemaSummary(root, nextScopeInfo.schema);
        updateSchemaScopeIndicator(root, nextScopeInfo);
        notifySuccess(i18nFormat('Schema saved to character override: ${0}.', nextScopeInfo.characterName || info.characterName || info.avatar));
        updateUiStatus(i18nFormat('Schema saved to character override: ${0}.', nextScopeInfo.characterName || info.characterName || info.avatar));
        bindUi();
    });
    root.find('#luker_rpg_memory_schema_clear_character_override').off('click').on('click', async function () {
        const info = getSchemaScopeInfo(context, settings);
        if (!info.hasAvatar) {
            notifyError(i18n('No active character selected.'));
            return;
        }
        const ok = await removeCharacterSchemaOverride(context, info.avatar);
        if (!ok) {
            notifyError(i18n('Failed to clear character schema override.'));
            return;
        }
        const nextScopeInfo = getSchemaScopeInfo(context, settings);
        updateSchemaSummary(root, nextScopeInfo.schema);
        updateSchemaScopeIndicator(root, nextScopeInfo);
        notifySuccess(i18nFormat('Cleared character schema override: ${0}.', info.characterName || info.avatar));
        updateUiStatus(i18nFormat('Cleared character schema override: ${0}.', info.characterName || info.avatar));
        bindUi();
    });
    root.find('#luker_rpg_memory_open_advanced').off('click').on('click', async function () {
        await openAdvancedSettingsPopup(context, settings, root);
    });

    root.find('#luker_rpg_memory_view_graph').off('click').on('click', async function () {
        await openGraphInspectorPopup(context);
    });

    root.find('#luker_rpg_memory_fill').off('click').on('click', async function () {
        await ensureMemoryStoreLoaded(context);
        const chatKey = getChatKey(context);
        const store = memoryStoreCache.get(chatKey);
        if (!store) {
            notifyError(i18n('No active chat selected.'));
            return;
        }
        alignStoreCoverageToChat(store, context);
        const fillAbortController = new AbortController();
        activeExtractionAbortController = fillAbortController;
        try {
            const preview = computeExtractionWindow(context, store, null);
            if (preview.beginSeq > preview.latestSeq) {
                notifySuccess(i18n('Memory graph is already up to date.'));
                updateUiStatus(i18n('Memory graph is already up to date.'));
                refreshUiStats();
                return;
            }
            const extractBatchTurns = Math.max(
                1,
                Math.floor(Number(settings?.extractBatchTurns || defaultSettings.extractBatchTurns || 1)),
            );
            const initialEndSeq = Math.min(
                Number(preview.latestSeq || 0),
                Number(preview.beginSeq || 1) + extractBatchTurns - 1,
            );
            showRuntimeInfoToast(formatExtractionRangeToast(preview.beginSeq, initialEndSeq, preview.latestSeq), {
                stopLabel: i18n('Stop'),
                onStop: () => {
                    if (!fillAbortController.signal.aborted) {
                        fillAbortController.abort();
                    }
                },
            });
            await runExtractionForStore(context, store, {
                force: true,
                abortSignal: fillAbortController.signal,
                onBatchStart: ({ beginSeq, endSeq, latestSeq }) => {
                    updateRuntimeInfoToastMessage(formatExtractionRangeToast(beginSeq, endSeq, latestSeq));
                },
            });
            await persistMemoryStoreByChatKey(context, chatKey, store);
            const debug = store.lastExtractionDebug || {};
            updateUiStatus(i18nFormat(
                'Extraction ${0}: begin=${1} latest=${2} covered=${3}',
                debug.extracted ? 'ok' : 'skip',
                Number(debug.beginSeq || 0),
                Number(debug.latestSeq || 0),
                Number(debug.coveredSeqTo || 0),
            ));
            refreshUiStats();
            notifySuccess(i18n('Memory graph incremental fill completed.'));
        } catch (error) {
            if (isAbortError(error, fillAbortController.signal)) {
                updateUiStatus(i18n('Memory graph update cancelled by user.'));
                return;
            }
            console.warn(`[${MODULE_NAME}] Incremental fill failed`, error);
            notifyError(i18nFormat('Recall injection failed (${0}): ${1}', 'fill', String(error?.message || error)));
        } finally {
            if (activeExtractionAbortController === fillAbortController) {
                activeExtractionAbortController = null;
            }
            clearRuntimeInfoToast();
        }
    });

    root.find('#luker_rpg_memory_recall_debug').off('click').on('click', async function () {
        await ensureMemoryStoreLoaded(context);
        const store = getMemoryStore(context);
        if (!store) {
            notifyError(i18n('No active chat selected.'));
            return;
        }
        const query = String(root.find('#luker_rpg_memory_debug_query').val() || '');
        const payload = { coreChat: [{ is_user: true, mes: query || 'Recall debug for current context.' }] };

        const result = await runLLMDrivenRecall(context, store, payload);
        store.lastRecallTrace = result.trace;
        updateUiStatus(i18nFormat('Recall ready. selected=${0}', result.selectedNodes.length));
        refreshUiStats();
    });

    root.find('#luker_rpg_memory_view_last_injection').off('click').on('click', async function () {
        await ensureMemoryStoreLoaded(context);
        const store = getMemoryStore(context);
        if (!store) {
            notifyError(i18n('No active chat selected.'));
            return;
        }
        const html = buildLastRecallCorePacketHtml(store, { showHeader: true });
        await context.callGenericPopup(html, context.POPUP_TYPE.TEXT, i18n('View Last Injection'), { wide: true, large: true });
    });

    root.find('#luker_rpg_memory_rebuild').off('click').on('click', async function () {
        const rebuildAbortController = new AbortController();
        activeExtractionAbortController = rebuildAbortController;
        const rebuildLatestSeq = Math.max(0, Number(buildPlayableFramesFromContext(context).length || 0));
        showRuntimeInfoToast(formatExtractionRangeToast(1, Math.min(1, rebuildLatestSeq || 1), Math.max(1, rebuildLatestSeq)), {
            stopLabel: i18n('Stop'),
            onStop: () => {
                if (!rebuildAbortController.signal.aborted) {
                    rebuildAbortController.abort();
                }
            },
        });
        try {
            const store = await rebuildStoreFromCurrentChat(context, {
                abortSignal: rebuildAbortController.signal,
                onBatchStart: ({ beginSeq, endSeq, latestSeq }) => {
                    updateRuntimeInfoToastMessage(formatExtractionRangeToast(beginSeq, endSeq, latestSeq));
                },
            });
            if (!store) {
                notifyError(i18n('No active chat selected.'));
                return;
            }
            const extractionEventRounds = getCompressionRoundsByType(store?.lastExtractionDebug?.compression, 'event');
            const compressionStats = createCompressionStats();
            await runCompressionLoop(context, store, settings, {
                compressionStats,
                abortSignal: rebuildAbortController.signal,
            });
            await persistMemoryStoreByChatKey(context, getChatKey(context), store);
            refreshUiStats();
            notifySuccess(i18n('Memory graph rebuilt from current chat.'));
            recordCompressionRound(compressionStats, 'event', extractionEventRounds);
            notifyEventCompressionIfAny(compressionStats);
            updateUiStatus(i18n('Rebuilt memory graph and compression from chat.'));
        } catch (error) {
            if (isAbortError(error, rebuildAbortController.signal)) {
                updateUiStatus(i18n('Memory graph update cancelled by user.'));
                return;
            }
            console.warn(`[${MODULE_NAME}] Rebuild failed`, error);
            notifyError(i18nFormat('Recall injection failed (${0}): ${1}', 'rebuild', String(error?.message || error)));
        } finally {
            if (activeExtractionAbortController === rebuildAbortController) {
                activeExtractionAbortController = null;
            }
            clearRuntimeInfoToast();
        }
    });

    root.find('#luker_rpg_memory_rebuild_recent').off('click').on('click', async function () {
        await ensureMemoryStoreLoaded(context);
        const chatKey = getChatKey(context);
        const store = memoryStoreCache.get(chatKey);
        if (!store) {
            notifyError(i18n('No active chat selected.'));
            return;
        }
        alignStoreCoverageToChat(store, context);
        const latestSeq = Math.max(0, Number(buildPlayableFramesFromContext(context).length || 0));
        if (latestSeq <= 0) {
            notifyError(i18n('No assistant turns available to rebuild.'));
            return;
        }

        const defaultRecentTurns = Math.min(20, latestSeq);
        const input = await context.callGenericPopup(
            i18nFormat('Rebuild recent turns: enter N (1-${0}).', latestSeq),
            context.POPUP_TYPE.INPUT,
            String(defaultRecentTurns),
            { okButton: i18n('Rebuild Recent'), cancelButton: i18n('Cancel') },
        );
        if (!input || typeof input !== 'string') {
            return;
        }
        const trimmed = String(input).trim();
        if (!/^\d+$/.test(trimmed)) {
            notifyError(i18nFormat('Please enter a valid integer between 1 and ${0}.', latestSeq));
            return;
        }
        const recentTurns = Number(trimmed);
        if (!Number.isFinite(recentTurns) || recentTurns < 1 || recentTurns > latestSeq) {
            notifyError(i18nFormat('Please enter a valid integer between 1 and ${0}.', latestSeq));
            return;
        }

        const startSeq = Math.max(1, latestSeq - recentTurns + 1);
        truncateStoreFromSeq(store, startSeq);
        const rebuildAbortController = new AbortController();
        activeExtractionAbortController = rebuildAbortController;
        const extractBatchTurns = Math.max(
            1,
            Math.floor(Number(settings?.extractBatchTurns || defaultSettings.extractBatchTurns || 1)),
        );
        const initialEndSeq = Math.min(
            latestSeq,
            startSeq + extractBatchTurns - 1,
        );
        showRuntimeInfoToast(formatExtractionRangeToast(startSeq, initialEndSeq, latestSeq), {
            stopLabel: i18n('Stop'),
            onStop: () => {
                if (!rebuildAbortController.signal.aborted) {
                    rebuildAbortController.abort();
                }
            },
        });
        try {
            await runExtractionForStore(context, store, {
                force: true,
                startSeq,
                abortSignal: rebuildAbortController.signal,
                onBatchStart: ({ beginSeq, endSeq, latestSeq: latest }) => {
                    updateRuntimeInfoToastMessage(formatExtractionRangeToast(beginSeq, endSeq, latest));
                },
            });
            await persistMemoryStoreByChatKey(context, chatKey, store);
            refreshUiStats();
            notifySuccess(i18nFormat('Memory graph rebuilt for recent ${0} turn(s).', recentTurns));
            updateUiStatus(i18nFormat('Rebuilt recent memory graph range: seq ${0}-${1}.', startSeq, latestSeq));
        } catch (error) {
            if (isAbortError(error, rebuildAbortController.signal)) {
                updateUiStatus(i18n('Memory graph update cancelled by user.'));
                return;
            }
            console.warn(`[${MODULE_NAME}] Recent rebuild failed`, error);
            notifyError(i18nFormat('Recall injection failed (${0}): ${1}', 'rebuild_recent', String(error?.message || error)));
        } finally {
            if (activeExtractionAbortController === rebuildAbortController) {
                activeExtractionAbortController = null;
            }
            clearRuntimeInfoToast();
        }
    });

    root.find('#luker_rpg_memory_manual_compress').off('click').on('click', async function () {
        await openManualCompressionPopup(context, settings);
    });

    root.find('#luker_rpg_memory_reset').off('click').on('click', async function () {
        const confirm = await context.callGenericPopup(
            i18n('Reset current chat memory graph? This cannot be undone.'),
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: i18n('Reset'), cancelButton: i18n('Cancel') },
        );
        if (confirm !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
        const chatKey = getChatKey(context);
        const target = memoryStoreTargets.get(chatKey) || buildMemoryTargetFromContext(context);
        if (target) {
            memoryStoreTargets.set(chatKey, target);
        }
        memoryStoreCache.set(chatKey, createEmptyStore());
        memoryStorePersistedSnapshots.delete(chatKey);
        if (target) {
            await deleteMemoryStoreByTarget(context, target);
        }
        await clearRuntimeLorebookProjection(context, settings);
        refreshUiStats();
        notifySuccess(i18n('Current chat memory graph reset.'));
        updateUiStatus(i18n('Reset memory graph for current chat.'));
    });

    root.find('#luker_rpg_memory_export').off('click').on('click', async function () {
        await ensureMemoryStoreLoaded(context);
        const store = getMemoryStore(context);
        if (!store) {
            notifyError(i18n('No active chat selected.'));
            return;
        }
        await context.callGenericPopup(
            `<pre style="white-space:pre-wrap;">${JSON.stringify(store, null, 2).replace(/</g, '&lt;')}</pre>`,
            context.POPUP_TYPE.TEXT,
            '',
            { wide: true, large: true, allowVerticalScrolling: true },
        );
    });

    root.find('#luker_rpg_memory_import').off('click').on('click', async function () {
        await ensureMemoryStoreLoaded(context);
        const store = getMemoryStore(context);
        if (!store) {
            notifyError(i18n('No active chat selected.'));
            return;
        }
        const current = JSON.stringify(store, null, 2);
        const input = await context.callGenericPopup(
            i18n('Paste memory graph JSON for current chat.'),
            context.POPUP_TYPE.INPUT,
            current,
            { rows: 16, wide: true, large: true, okButton: i18n('Import'), cancelButton: i18n('Cancel') },
        );

        if (!input || typeof input !== 'string') {
            return;
        }

        try {
            const parsed = JSON.parse(input);
            const chatKey = getChatKey(context);
            const target = memoryStoreTargets.get(chatKey) || buildMemoryTargetFromContext(context);
            if (target) {
                memoryStoreTargets.set(chatKey, target);
            }
            const migrated = normalizeStoreForRuntime(parsed);
            updateStoreSourceState(migrated, context);
            memoryStoreCache.set(chatKey, migrated);
            await persistMemoryStoreByChatKey(context, chatKey, migrated);
            refreshUiStats();
            notifySuccess(i18n('Memory graph imported for current chat.'));
            updateUiStatus(i18n('Imported memory graph JSON.'));
        } catch (error) {
            notifyError(i18nFormat('Import failed: ${0}', error?.message || error));
            updateUiStatus(i18n('Memory graph import failed.'));
        }
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
            <b>${escapeHtml(i18n('Memory'))}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input id="luker_rpg_memory_enabled" type="checkbox" /> ${escapeHtml(i18n('Enabled'))}</label>
            <label class="checkbox_label"><input id="luker_rpg_memory_plain_text_calls" type="checkbox" /> ${escapeHtml(i18n('Plain-text function-call mode'))}</label>
            <label class="checkbox_label"><input id="luker_rpg_memory_recall_enabled" type="checkbox" /> ${escapeHtml(i18n('Enable recall injection'))}</label>
            <label for="luker_rpg_memory_recall_api_preset">${escapeHtml(i18n('Recall API preset (Connection profile, empty = current)'))}</label>
            <select id="luker_rpg_memory_recall_api_preset" class="text_pole"></select>
            <label for="luker_rpg_memory_recall_preset">${escapeHtml(i18n('Recall preset (params + prompt, empty = current)'))}</label>
            <select id="luker_rpg_memory_recall_preset" class="text_pole"></select>
            <label for="luker_rpg_memory_extract_api_preset">${escapeHtml(i18n('Extract API preset (Connection profile, empty = current)'))}</label>
            <select id="luker_rpg_memory_extract_api_preset" class="text_pole"></select>
            <label for="luker_rpg_memory_extract_preset">${escapeHtml(i18n('Extract preset (params + prompt, empty = current)'))}</label>
            <select id="luker_rpg_memory_extract_preset" class="text_pole"></select>
            <label class="checkbox_label"><input id="luker_rpg_memory_projection_enabled" type="checkbox" /> ${escapeHtml(i18n('Project recall output to chat lorebook (rescan WI after inject)'))}</label>

            <div class="flex-container">
                <label style="flex:1">${escapeHtml(i18n('Update every N assistant turns'))} <input id="luker_rpg_memory_update_every" class="text_pole" type="number" min="1" step="1" /></label>
            </div>

            <label>${escapeHtml(i18n('Node Type Schema (Visual Editor)'))}</label>
            <small style="opacity:0.8">${escapeHtml(i18n('Configure memory table types, extraction hints, and compression strategy in a popup editor.'))}</small>
            <small id="luker_rpg_memory_schema_scope" style="opacity:0.85"></small>
            <small id="luker_rpg_memory_schema_summary" style="opacity:0.85"></small>
            <div class="flex-container">
                <div id="luker_rpg_memory_open_schema_editor" class="menu_button">${escapeHtml(i18n('Open Schema Editor'))}</div>
                <div id="luker_rpg_memory_open_advanced" class="menu_button">${escapeHtml(i18n('Open Advanced Settings'))}</div>
            </div>
            <div class="flex-container">
                <div id="luker_rpg_memory_schema_save_global" class="menu_button">${escapeHtml(i18n('Save Schema to Global'))}</div>
                <div id="luker_rpg_memory_schema_save_character" class="menu_button">${escapeHtml(i18n('Save Schema to Character'))}</div>
                <div id="luker_rpg_memory_schema_clear_character_override" class="menu_button">${escapeHtml(i18n('Clear Character Schema Override'))}</div>
            </div>

            <div class="flex-container">
                <div id="luker_rpg_memory_view_graph" class="menu_button">${escapeHtml(i18n('View Graph'))}</div>
                <div id="luker_rpg_memory_fill" class="menu_button">${escapeHtml(i18n('Fill Graph (Incremental)'))}</div>
                <div id="luker_rpg_memory_rebuild" class="menu_button">${escapeHtml(i18n('Rebuild From Chat'))}</div>
                <div id="luker_rpg_memory_rebuild_recent" class="menu_button">${escapeHtml(i18n('Rebuild Recent N Turns'))}</div>
            </div>
            <div class="flex-container">
                <div id="luker_rpg_memory_manual_compress" class="menu_button">${escapeHtml(i18n('Manual Compress'))}</div>
                <div id="luker_rpg_memory_reset" class="menu_button">${escapeHtml(i18n('Reset Current Chat'))}</div>
            </div>
            <div class="flex-container">
                <div id="luker_rpg_memory_export" class="menu_button">${escapeHtml(i18n('Export Current Chat Graph'))}</div>
                <div id="luker_rpg_memory_import" class="menu_button">${escapeHtml(i18n('Import Current Chat Graph'))}</div>
            </div>

            <label for="luker_rpg_memory_debug_query">${escapeHtml(i18n('Recall debug query'))}</label>
            <input id="luker_rpg_memory_debug_query" class="text_pole" type="text" placeholder="${escapeHtml(i18n('e.g. what happened at the ruins with Mira?'))}" />
            <div class="flex-container">
                <div id="luker_rpg_memory_recall_debug" class="menu_button">${escapeHtml(i18n('Run Recall Debug'))}</div>
                <div id="luker_rpg_memory_view_last_injection" class="menu_button">${escapeHtml(i18n('View Last Injection'))}</div>
            </div>

            <small id="luker_rpg_memory_stats" style="opacity:0.8"></small>
            <small id="luker_rpg_memory_status" style="opacity:0.8"></small>
        </div>
    </div>
</div>`;

    host.append(html);
    bindUi();
}

jQuery(() => {
    const context = getContext();
    registerLocaleData();
    ensureSettings();
    saveSettingsDebounced();
    ensureUi();

    const wiAfterEvent = context.eventTypes.GENERATION_AFTER_WORLD_INFO_SCAN;
    if (wiAfterEvent) {
        context.eventSource.on(wiAfterEvent, async (payload) => {
            const runtimeContext = getContext();
            const injected = await safeInjectMemoryPrompts(runtimeContext, payload, 'after_world_info_scan');
            if (injected && payload && typeof payload === 'object') {
                payload.requestRescan = true;
            }
        });
    }
    const clearRuntimeProjectionAfterGeneration = async () => {
        const runtimeContext = getContext();
        try {
            await clearRuntimeLorebookProjection(runtimeContext, getSettings());
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to clear runtime lorebook projection after generation`, error);
        }
    };
    if (context.eventTypes.GENERATION_ENDED) {
        context.eventSource.on(context.eventTypes.GENERATION_ENDED, async () => {
            await clearRuntimeProjectionAfterGeneration();
            clearRuntimeInfoToast();
            const runtimeContext = getContext();
            const abortedByUser = Boolean(runtimeContext?.streamingProcessor?.abortController?.signal?.aborted);
            if (abortedByUser) {
                updateUiStatus(i18n('Generation aborted. Skipped memory extraction.'));
                return;
            }
            await captureLatestAssistantAfterGeneration();
        });
    }
    context.eventSource.on(context.eventTypes.MESSAGE_DELETED, async (_messageCount, mutationMeta) => {
        const runtimeContext = getContext();
        try {
            await ensureMemoryStoreLoaded(runtimeContext);
            const chatKey = getChatKey(runtimeContext);
            const store = memoryStoreCache.get(chatKey);
            if (!store) {
                return;
            }
            const meta = normalizeMutationMeta(mutationMeta);
            const fromSeq = Number(meta?.deletedAssistantSeqFrom || 0);
            if (!Number.isFinite(fromSeq) || fromSeq <= 0) {
                alignStoreCoverageToChat(store, runtimeContext);
                await persistMemoryStoreByChatKey(runtimeContext, chatKey, store);
                refreshUiStats();
                return;
            }
            truncateStoreFromSeq(store, fromSeq);
            alignStoreCoverageToChat(store, runtimeContext);
            await persistMemoryStoreByChatKey(runtimeContext, chatKey, store);
            refreshUiStats();
            updateUiStatus(i18n('Chat mutation detected. Memory graph will re-sync on next generation.'));
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Local truncate after chat mutation failed`, error);
            updateUiStatus(i18n('Chat mutation detected. Memory graph will re-sync on next generation.'));
        }
    });
    if (context.eventTypes.PRESET_CHANGED) {
        context.eventSource.on(context.eventTypes.PRESET_CHANGED, (event) => {
            if (String(event?.apiId || '') === 'openai') {
                ensureUi();
            }
        });
    }
    const connectionProfileEvents = [
        context.eventTypes.CONNECTION_PROFILE_LOADED,
        context.eventTypes.CONNECTION_PROFILE_CREATED,
        context.eventTypes.CONNECTION_PROFILE_DELETED,
        context.eventTypes.CONNECTION_PROFILE_UPDATED,
    ].filter(Boolean);
    for (const eventName of connectionProfileEvents) {
        context.eventSource.on(eventName, () => ensureUi());
    }
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        const runtimeContext = getContext();
        ensureUi();
        ensureMemoryStoreLoaded(runtimeContext)
            .then(() => refreshUiStats())
            .catch(() => refreshUiStats());
    });
});
