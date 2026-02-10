import { CONNECT_API_MAP, saveSettingsDebounced, buildObjectPatchOperations } from '../../../script.js';
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

const LEVEL = {
    CANON: 'canon',
    ROLLUP: 'rollup',
    ARC: 'arc',
    EPISODE: 'episode',
    TURN: 'turn',
    SEMANTIC: 'semantic',
};

const defaultNodeTypeSchema = [
    {
        id: 'event',
        label: 'Event',
        tableName: 'event_table',
        tableColumns: ['title', 'turn_range', 'summary', 'details', 'participants', 'locations', 'threads', 'status'],
        level: LEVEL.SEMANTIC,
        extractHint: 'Critical plot events, turning points, commitments, betrayals, and irreversible outcomes.',
        keywords: ['battle', 'reveal', 'deal', 'betrayal', 'event', 'outcome'],
        alwaysInject: false,
        compression: {
            mode: 'hierarchical',
            threshold: 9,
            fanIn: 3,
            maxDepth: 10,
            keepRecentLeaves: 6,
            keepLatest: 1,
            summarizeInstruction: 'Compress event nodes into higher-level storyline milestones while preserving causality and unresolved hooks.',
        },
    },
    {
        id: 'thread',
        label: 'Thread',
        tableName: 'thread_table',
        tableColumns: ['title', 'summary', 'status', 'related_events', 'last_update_turn'],
        level: LEVEL.SEMANTIC,
        extractHint: 'Unresolved clues, foreshadowing, quests, promises, and long-term hooks.',
        keywords: ['quest', 'clue', 'mystery', 'promise', 'goal', 'thread'],
        alwaysInject: false,
        compression: {
            mode: 'hierarchical',
            threshold: 8,
            fanIn: 3,
            maxDepth: 8,
            keepRecentLeaves: 4,
            keepLatest: 1,
            summarizeInstruction: 'Compress thread nodes into concise quest/foreshadowing tracks with current status and blockers.',
        },
    },
    {
        id: 'character_sheet',
        label: 'Character Sheet',
        tableName: 'character_table',
        tableColumns: ['name', 'identity', 'state', 'goal', 'relationship', 'inventory', 'secret', 'last_update_turn'],
        level: LEVEL.SEMANTIC,
        extractHint: 'Stable character facts and evolving state. Prefer structured JSON-like content: identity/status/goal/inventory/relationships/secrets.',
        keywords: ['character', 'status', 'relationship', 'inventory', 'goal', 'secret'],
        alwaysInject: false,
        compression: {
            mode: 'latest_only',
            threshold: 2,
            fanIn: 2,
            maxDepth: 1,
            keepRecentLeaves: 1,
            keepLatest: 1,
            summarizeInstruction: '',
        },
    },
    {
        id: 'location_state',
        label: 'Location State',
        tableName: 'location_table',
        tableColumns: ['name', 'controller', 'danger', 'resource', 'state', 'last_event', 'last_update_turn'],
        level: LEVEL.SEMANTIC,
        extractHint: 'Location status, ownership/control, danger level, and environmental/resource changes. Prefer structured JSON-like content.',
        keywords: ['location', 'control', 'danger', 'resource', 'region', 'base'],
        alwaysInject: false,
        compression: {
            mode: 'latest_only',
            threshold: 2,
            fanIn: 2,
            maxDepth: 1,
            keepRecentLeaves: 1,
            keepLatest: 1,
            summarizeInstruction: '',
        },
    },
    {
        id: 'faction_state',
        label: 'Faction State',
        tableName: 'faction_table',
        tableColumns: ['name', 'goal', 'alliance', 'hostility', 'leverage', 'state', 'last_update_turn'],
        level: LEVEL.SEMANTIC,
        extractHint: 'Faction goals, alliances, hostility shifts, leverage, and conflict escalation.',
        keywords: ['faction', 'alliance', 'hostility', 'politics', 'power'],
        alwaysInject: false,
        compression: {
            mode: 'latest_only',
            threshold: 2,
            fanIn: 2,
            maxDepth: 1,
            keepRecentLeaves: 1,
            keepLatest: 1,
            summarizeInstruction: '',
        },
    },
    {
        id: 'item_state',
        label: 'Item State',
        tableName: 'item_table',
        tableColumns: ['name', 'owner', 'state', 'effect', 'constraint', 'last_update_turn'],
        level: LEVEL.SEMANTIC,
        extractHint: 'Key item ownership, condition, unlock state, seals, and usage constraints.',
        keywords: ['artifact', 'item', 'key', 'weapon', 'relic'],
        alwaysInject: false,
        compression: {
            mode: 'latest_only',
            threshold: 2,
            fanIn: 2,
            maxDepth: 1,
            keepRecentLeaves: 1,
            keepLatest: 1,
            summarizeInstruction: '',
        },
    },
    {
        id: 'rule_constraint',
        label: 'Rule Constraint',
        tableName: 'rule_table',
        tableColumns: ['title', 'constraint', 'scope', 'status'],
        level: LEVEL.SEMANTIC,
        extractHint: 'World rules, magic limits, taboos, hard constraints, and never-break conditions.',
        keywords: ['rule', 'constraint', 'law', 'taboo', 'limit'],
        alwaysInject: true,
        compression: {
            mode: 'none',
            threshold: 2,
            fanIn: 2,
            maxDepth: 1,
            keepRecentLeaves: 1,
            keepLatest: 1,
            summarizeInstruction: '',
        },
    },
];

const defaultSettings = {
    enabled: false,
    updateEvery: 6,
    maxTurns: 900,
    turnsPerEpisode: 10,
    episodesPerArc: 4,
    arcsPerCanon: 3,
    rollupFanIn: 3,
    keepRecentEpisodeTurns: 3,
    recallEnabled: true,
    recallApiPresetName: '',
    recallPresetName: '',
    recallResponseLength: 260,
    toolCallRetryMax: 2,
    recallMaxIterations: 3,
    recallMaxSelection: 8,
    recallRootCandidates: 24,
    recallExpandedCandidates: 48,
    recallNeighborLimit: 24,
    extractApiPresetName: '',
    extractPresetName: '',
    extractResponseLength: 360,
    extractBatchTurns: 12,
    recentRawTurns: 5,
    lorebookProjectionEnabled: true,
    lorebookNameOverride: '',
    lorebookEntryOrderBase: 9800,
    nodeTypeSchema: defaultNodeTypeSchema,
    maxLayerSnapshots: 800,
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
        'Project recall output to chat lorebook before WI scan': '在世界书扫描前将召回结果投影到聊天 Lorebook',
        'Exclude latest N turns from memory injection': '记忆注入排除最近 N 轮',
        'Recall max iterations': '召回最大轮数',
        'Extract batch turns': '写入批量轮数',
        'Recall max selection (0 = unlimited)': '召回最大选择数（0=不限制）',
        'Tool-call retries': '工具调用重试次数',
        'Update every N messages': '每 N 条消息更新',
        'Turns / Episode': '每 Episode 回合数',
        'Episodes / Arc': '每 Arc 的 Episode 数',
        'Arcs / Canon': '每 Canon 的 Arc 数',
        'Rollup fan-in (N->1)': 'Rollup 扇入（N->1）',
        'Node Type Schema (Visual Editor)': '节点类型 Schema（可视化编辑）',
        'Configure memory table types, extraction hints, and compression strategy in a popup editor.': '在弹窗里配置记忆表类型、抽取提示与压缩策略。',
        'Open Schema Editor': '打开 Schema 编辑器',
        'Save Settings': '保存设置',
        'View Graph': '查看图',
        'Rebuild From Chat': '从聊天重建',
        'Reset Current Chat': '重置当前聊天',
        'Export Current Chat Graph': '导出当前聊天图',
        'Import Current Chat Graph': '导入当前聊天图',
        'Recall debug query': '召回调试查询',
        'e.g. what happened at the ruins with Mira?': '例如：和 Mira 在遗迹发生了什么？',
        'Run Recall Debug': '运行召回调试',
        'No active chat selected.': '未选择有效聊天。',
        'Paste memory graph JSON for current chat.': '为当前聊天粘贴记忆图 JSON。',
        'Import': '导入',
        'Cancel': '取消',
        'Delete': '删除',
        'Memory graph imported for current chat.': '当前聊天记忆图已导入。',
        'Imported memory graph JSON.': '已导入记忆图 JSON。',
        'Memory graph import failed.': '记忆图导入失败。',
        'Import failed: ${0}': '导入失败：${0}',
        'Types: ${0} | Always Inject: ${1} | Hierarchical: ${2}': '类型：${0} | 常驻注入：${1} | 分层压缩：${2}',
        '(Current preset)': '（当前预设）',
        '(Current API config)': '（当前 API 配置）',
        '(missing)': '（缺失）',
        '(none)': '（无）',
        '(select node)': '（选择节点）',
        '(unset)': '（未设置）',
        '(new)': '（新建）',
        'Memory Graph': '记忆图',
        'Nodes: ${0} | Edges: ${1} | Turns: ${2} | Source messages: ${3}': '节点：${0} | 边：${1} | 回合：${2} | 源消息：${3}',
        'canon=${0}, rollup=${1}, arc=${2}, episode=${3}, turn=${4}, semantic=${5}': 'canon=${0}, rollup=${1}, arc=${2}, episode=${3}, turn=${4}, semantic=${5}',
        'Last recall steps: ${0} | Layer snapshots: ${1}': '最近召回步数：${0} | 层快照：${1}',
        'Visual graph ready. Click an edge to select it for editing.': '可视化图已就绪。点击边可选择并编辑。',
        'Fit View': '适配视图',
        'Re-layout': '重新布局',
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
        'TurnRange': '回合范围',
        'Actions': '操作',
        'Recent Edges': '最近边',
        'From': '起点',
        'To': '终点',
        'Weight': '权重',
        'Updated': '更新时间',
        'Edit': '编辑',
        'Last Projection': '最近投影',
        'View': '查看',
        'Form Edit': '表单编辑',
        'Form editor for one node. Parent/child relationships and graph persistence are applied automatically.': '单节点表单编辑器。父子关系和图持久化会自动处理。',
        'Node ID': '节点 ID',
        'Parent Node': '父节点',
        'Turn Index': '回合索引',
        'From Turn': '起始回合',
        'To Turn': '结束回合',
        'Count': '计数',
        'Finalized': '已定稿',
        'Archived': '已归档',
        'Content': '内容',
        'Links (comma separated node ids)': '链接（逗号分隔节点 ID）',
        'Metadata (one key=value per line)': '元数据（每行一个 key=value）',
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
        'Graph re-layout completed.': '图重新布局完成。',
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
        'Recall ready. query="${0}" selected=${1}': '召回就绪。query="${0}" selected=${1}',
        'Recall injection failed (${0}): ${1}': '召回注入失败（${0}）：${1}',
        'nodes=${0}, edges=${1}, turns=${2}, source=${3}, canon=${4}, rollup=${5}, arc=${6}, episode=${7}, semantic=${8}, snapshots=${9}': 'nodes=${0}, edges=${1}, turns=${2}, source=${3}, canon=${4}, rollup=${5}, arc=${6}, episode=${7}, semantic=${8}, snapshots=${9}',
        'Memory Node Schema Editor': '记忆节点 Schema 编辑器',
        'Define node tables, extraction hints, and compression strategy. This controls what your memory graph stores and how it compacts over time.': '定义节点表、抽取提示和压缩策略。这会控制记忆图存储内容及其随时间压缩方式。',
        'Hierarchical Compression': '分层压缩',
        'Latest Snapshot': '最新快照',
        'Always Inject': '常驻注入',
        'Current type count: ${0}': '当前类型数量：${0}',
        'Add Type': '新增类型',
        'Load Recommended Schema': '加载推荐 Schema',
        'table: ${0}': '表：${0}',
        'mode: ${0}': '模式：${0}',
        'always inject': '常驻注入',
        'Type ID': '类型 ID',
        'Label': '标签',
        'Table Name': '表名',
        'Table Columns (comma separated)': '表列（逗号分隔）',
        'Keywords (comma separated)': '关键词（逗号分隔）',
        'Extract Hint': '抽取提示',
        'Compression Mode': '压缩模式',
        'none': 'none',
        'latest_only': 'latest_only',
        'hierarchical': 'hierarchical',
        'Keep Latest': '保留最新',
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
        'Current chat memory graph reset.': '已重置当前聊天记忆图。',
        'Reset memory graph for current chat.': '已重置当前聊天的记忆图。',
        'Recall injected via fallback after WI scan. Requested WI rescan for this generation.': '通过 WI 扫描后回退流程注入了召回内容，并请求本次生成重新扫描 WI。',
        'Visual graph unavailable: failed to load Cytoscape.': '可视化图不可用：加载 Cytoscape 失败。',
        'Selected node: ${0}. Tip: click an edge to edit relation.': '已选择节点：${0}。提示：点击边可编辑关系。',
        'Selected edge index ${0} (missing).': '已选择边索引 ${0}（缺失）。',
        'Selected edge #${0}: ${1} -> ${2} [${3}]': '已选择边 #${0}：${1} -> ${2} [${3}]',
        'Chat mutation detected. Memory graph will re-sync on next generation.': '检测到聊天变更。记忆图会在下次生成时重新同步。',
    });
    addLocaleData('zh-tw', {
        'Memory': '記憶',
        'Enabled': '啟用',
        'Enable recall injection': '啟用記憶召回注入',
        'Recall API preset (Connection profile, empty = current)': '召回 API 預設（連線設定，留空=目前）',
        'Recall preset (params + prompt, empty = current)': '召回預設（參數+提示詞，留空=目前）',
        'Extract API preset (Connection profile, empty = current)': '寫入 API 預設（連線設定，留空=目前）',
        'Extract preset (params + prompt, empty = current)': '寫入預設（參數+提示詞，留空=目前）',
        'Project recall output to chat lorebook before WI scan': '在世界書掃描前將召回結果投影到聊天 Lorebook',
        'Exclude latest N turns from memory injection': '記憶注入排除最近 N 輪',
        'Recall max iterations': '召回最大輪數',
        'Extract batch turns': '寫入批次輪數',
        'Recall max selection (0 = unlimited)': '召回最大選取數（0=不限）',
        'Tool-call retries': '工具呼叫重試次數',
        'Update every N messages': '每 N 條訊息更新',
        'Turns / Episode': '每 Episode 回合數',
        'Episodes / Arc': '每 Arc 的 Episode 數',
        'Arcs / Canon': '每 Canon 的 Arc 數',
        'Rollup fan-in (N->1)': 'Rollup 扇入（N->1）',
        'Node Type Schema (Visual Editor)': '節點類型 Schema（視覺化編輯）',
        'Configure memory table types, extraction hints, and compression strategy in a popup editor.': '在彈窗中配置記憶表類型、抽取提示與壓縮策略。',
        'Open Schema Editor': '開啟 Schema 編輯器',
        'Save Settings': '儲存設定',
        'View Graph': '查看圖譜',
        'Rebuild From Chat': '從聊天重建',
        'Reset Current Chat': '重設目前聊天',
        'Export Current Chat Graph': '匯出目前聊天圖',
        'Import Current Chat Graph': '匯入目前聊天圖',
        'Recall debug query': '召回除錯查詢',
        'e.g. what happened at the ruins with Mira?': '例如：和 Mira 在遺跡發生了什麼？',
        'Run Recall Debug': '執行召回除錯',
        'No active chat selected.': '未選擇有效聊天。',
        'Paste memory graph JSON for current chat.': '請貼上目前聊天的記憶圖 JSON。',
        'Import': '匯入',
        'Cancel': '取消',
        'Delete': '刪除',
        'Memory graph imported for current chat.': '目前聊天記憶圖已匯入。',
        'Imported memory graph JSON.': '已匯入記憶圖 JSON。',
        'Memory graph import failed.': '記憶圖匯入失敗。',
        'Import failed: ${0}': '匯入失敗：${0}',
        'Types: ${0} | Always Inject: ${1} | Hierarchical: ${2}': '類型：${0} | 常駐注入：${1} | 分層壓縮：${2}',
        '(Current preset)': '（目前預設）',
        '(Current API config)': '（目前 API 設定）',
        '(missing)': '（缺失）',
        '(none)': '（無）',
        '(select node)': '（選擇節點）',
        '(unset)': '（未設定）',
        '(new)': '（新建）',
        'Memory Graph': '記憶圖',
        'Nodes: ${0} | Edges: ${1} | Turns: ${2} | Source messages: ${3}': '節點：${0} | 邊：${1} | 回合：${2} | 來源訊息：${3}',
        'canon=${0}, rollup=${1}, arc=${2}, episode=${3}, turn=${4}, semantic=${5}': 'canon=${0}, rollup=${1}, arc=${2}, episode=${3}, turn=${4}, semantic=${5}',
        'Last recall steps: ${0} | Layer snapshots: ${1}': '最近召回步數：${0} | 層快照：${1}',
        'Visual graph ready. Click an edge to select it for editing.': '視覺化圖已就緒。點擊邊可選取並編輯。',
        'Fit View': '適配視圖',
        'Re-layout': '重新佈局',
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
        'TurnRange': '回合範圍',
        'Actions': '操作',
        'Recent Edges': '最近邊',
        'From': '起點',
        'To': '終點',
        'Weight': '權重',
        'Updated': '更新時間',
        'Edit': '編輯',
        'Last Projection': '最近投影',
        'View': '查看',
        'Form Edit': '表單編輯',
        'Form editor for one node. Parent/child relationships and graph persistence are applied automatically.': '單節點表單編輯器。父子關係與圖持久化會自動處理。',
        'Node ID': '節點 ID',
        'Parent Node': '父節點',
        'Turn Index': '回合索引',
        'From Turn': '起始回合',
        'To Turn': '結束回合',
        'Count': '計數',
        'Finalized': '已定稿',
        'Archived': '已封存',
        'Content': '內容',
        'Links (comma separated node ids)': '連結（以逗號分隔節點 ID）',
        'Metadata (one key=value per line)': '中繼資料（每行一個 key=value）',
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
        'Graph re-layout completed.': '圖重新佈局完成。',
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
        'Recall ready. query="${0}" selected=${1}': '召回就緒。query="${0}" selected=${1}',
        'Recall injection failed (${0}): ${1}': '召回注入失敗（${0}）：${1}',
        'nodes=${0}, edges=${1}, turns=${2}, source=${3}, canon=${4}, rollup=${5}, arc=${6}, episode=${7}, semantic=${8}, snapshots=${9}': 'nodes=${0}, edges=${1}, turns=${2}, source=${3}, canon=${4}, rollup=${5}, arc=${6}, episode=${7}, semantic=${8}, snapshots=${9}',
        'Memory Node Schema Editor': '記憶節點 Schema 編輯器',
        'Define node tables, extraction hints, and compression strategy. This controls what your memory graph stores and how it compacts over time.': '定義節點資料表、抽取提示與壓縮策略。這會控制記憶圖儲存內容及其隨時間壓縮方式。',
        'Hierarchical Compression': '分層壓縮',
        'Latest Snapshot': '最新快照',
        'Always Inject': '常駐注入',
        'Current type count: ${0}': '目前類型數量：${0}',
        'Add Type': '新增類型',
        'Load Recommended Schema': '載入推薦 Schema',
        'table: ${0}': '表：${0}',
        'mode: ${0}': '模式：${0}',
        'always inject': '常駐注入',
        'Type ID': '類型 ID',
        'Label': '標籤',
        'Table Name': '表名',
        'Table Columns (comma separated)': '表欄位（逗號分隔）',
        'Keywords (comma separated)': '關鍵字（逗號分隔）',
        'Extract Hint': '抽取提示',
        'Compression Mode': '壓縮模式',
        'none': 'none',
        'latest_only': 'latest_only',
        'hierarchical': 'hierarchical',
        'Keep Latest': '保留最新',
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
        'Current chat memory graph reset.': '已重設目前聊天記憶圖。',
        'Reset memory graph for current chat.': '已重設目前聊天記憶圖。',
        'Recall injected via fallback after WI scan. Requested WI rescan for this generation.': '透過 WI 掃描後回退流程注入了召回內容，並要求本次生成重新掃描 WI。',
        'Visual graph unavailable: failed to load Cytoscape.': '視覺化圖不可用：載入 Cytoscape 失敗。',
        'Selected node: ${0}. Tip: click an edge to edit relation.': '已選擇節點：${0}。提示：點擊邊可編輯關係。',
        'Selected edge index ${0} (missing).': '已選擇邊索引 ${0}（缺失）。',
        'Selected edge #${0}: ${1} -> ${2} [${3}]': '已選擇邊 #${0}：${1} -> ${2} [${3}]',
        'Chat mutation detected. Memory graph will re-sync on next generation.': '偵測到聊天變更。記憶圖會在下次生成時重新同步。',
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
let cytoscapeLoadPromise = null;
let lastKnownChatKey = '';

function cloneDefault(value) {
    return Array.isArray(value) || typeof value === 'object' ? structuredClone(value) : value;
}

function normalizeNodeTypeSchema(schema) {
    const list = Array.isArray(schema) ? schema : defaultNodeTypeSchema;
    const normalizeCompressionMode = (mode) => {
        const value = String(mode || '').trim().toLowerCase();
        return ['none', 'hierarchical', 'latest_only'].includes(value) ? value : 'none';
    };
    const normalized = list
        .filter(item => item && typeof item === 'object')
        .map((item, index) => ({
            id: String(item.id || `custom_${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9_\-]/g, '_'),
            label: String(item.label || item.id || `Type ${index + 1}`).trim(),
            tableName: String(item.tableName || item.id || `table_${index + 1}`).trim(),
            tableColumns: Array.isArray(item.tableColumns)
                ? item.tableColumns.map(x => String(x || '').trim()).filter(Boolean)
                : ['title', 'summary', 'content'],
            level: String(item.level || LEVEL.SEMANTIC),
            extractHint: String(item.extractHint || '').trim(),
            keywords: Array.isArray(item.keywords) ? item.keywords.map(x => String(x || '').trim()).filter(Boolean) : [],
            alwaysInject: Boolean(item.alwaysInject),
            compression: {
                mode: normalizeCompressionMode(item?.compression?.mode),
                threshold: Math.max(2, Number(item?.compression?.threshold) || 6),
                fanIn: Math.max(2, Number(item?.compression?.fanIn) || 3),
                maxDepth: Math.max(1, Number(item?.compression?.maxDepth) || 6),
                keepRecentLeaves: Math.max(0, Number(item?.compression?.keepRecentLeaves) || 0),
                keepLatest: Math.max(1, Number(item?.compression?.keepLatest) || 1),
                summarizeInstruction: String(item?.compression?.summarizeInstruction || '').trim(),
            },
        }))
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

    if (!String(extension_settings[MODULE_NAME].recallPresetName || '').trim()) {
        extension_settings[MODULE_NAME].recallPresetName = String(
            extension_settings[MODULE_NAME].recallPromptPresetName
            || extension_settings[MODULE_NAME].recallLlmPresetName
            || '',
        ).trim();
    }
    if (!String(extension_settings[MODULE_NAME].extractPresetName || '').trim()) {
        extension_settings[MODULE_NAME].extractPresetName = String(
            extension_settings[MODULE_NAME].extractPromptPresetName
            || extension_settings[MODULE_NAME].extractLlmPresetName
            || '',
        ).trim();
    }
    delete extension_settings[MODULE_NAME].recallPromptPresetName;
    delete extension_settings[MODULE_NAME].recallLlmPresetName;
    delete extension_settings[MODULE_NAME].extractPromptPresetName;
    delete extension_settings[MODULE_NAME].extractLlmPresetName;

    extension_settings[MODULE_NAME].toolCallRetryMax = Math.max(
        0,
        Math.min(10, Math.floor(Number(extension_settings[MODULE_NAME].toolCallRetryMax) || 0)),
    );
    extension_settings[MODULE_NAME].recallMaxSelection = Math.max(
        0,
        Math.floor(Number(extension_settings[MODULE_NAME].recallMaxSelection)),
    );
    if (!Number.isFinite(extension_settings[MODULE_NAME].recallMaxSelection)) {
        extension_settings[MODULE_NAME].recallMaxSelection = defaultSettings.recallMaxSelection;
    }
    extension_settings[MODULE_NAME].nodeTypeSchema = normalizeNodeTypeSchema(extension_settings[MODULE_NAME].nodeTypeSchema);
}

function getSettings() {
    return extension_settings[MODULE_NAME];
}

function getRecallSelectionLimit(settings) {
    const fallback = Math.max(0, Math.floor(Number(defaultSettings.recallMaxSelection) || 0));
    const raw = Number(settings?.recallMaxSelection);
    if (!Number.isFinite(raw)) {
        return fallback;
    }
    return Math.max(0, Math.floor(raw));
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

function resolveChatSourceFromApiAlias(value, fallbackSource = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return String(fallbackSource || '').trim();
    }

    if (API_ALIAS_TO_CHAT_SOURCE[normalized]) {
        return API_ALIAS_TO_CHAT_SOURCE[normalized];
    }

    const mapEntry = Object.entries(CONNECT_API_MAP || {})
        .find(([alias]) => String(alias || '').toLowerCase() === normalized)?.[1];
    if (mapEntry?.selected === 'openai' && mapEntry?.source) {
        return String(mapEntry.source);
    }

    return String(fallbackSource || '').trim();
}

function getConnectionProfileByName(name = '') {
    const target = String(name || '').trim();
    if (!target) {
        return null;
    }
    return getConnectionProfiles().find(profile => profile.name === target) || null;
}

function resolveRequestApiFromConnectionProfileName(context, profileName = '') {
    const fallbackApi = String(context?.mainApi || 'openai').trim() || 'openai';
    const profile = getConnectionProfileByName(profileName);
    if (!profile) {
        return fallbackApi;
    }

    const alias = String(profile.api || '').trim().toLowerCase();
    if (!alias) {
        return fallbackApi;
    }

    const mapEntry = CONNECT_API_MAP?.[alias];
    const selectedApi = String(mapEntry?.selected || '').trim();
    if (selectedApi) {
        return selectedApi;
    }

    if (alias === 'koboldhorde') {
        return 'kobold';
    }
    return fallbackApi;
}

function buildApiSettingsOverrideFromConnectionProfileName(profileName, fallbackSource = '') {
    const profile = getConnectionProfileByName(profileName);
    if (!profile) {
        return null;
    }

    const overrides = {};
    const source = resolveChatSourceFromApiAlias(profile.api, fallbackSource);
    if (source) {
        overrides.chat_completion_source = source;
    }

    const resolvedSource = String(source || fallbackSource || '').trim();
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

function findFallbackChatKeyBySourceState(context) {
    const source = computeChatSourceState(context);
    const exactMatches = [];
    for (const [chatKey, store] of memoryStoreCache.entries()) {
        if (!store || typeof store !== 'object') {
            continue;
        }
        if (Number(store.sourceMessageCount || 0) === Number(source.messageCount || 0)
            && String(store.sourceDigest || '') === String(source.digest || '')) {
            exactMatches.push([chatKey, store]);
        }
    }
    if (exactMatches.length > 0) {
        exactMatches.sort((a, b) => Number(b?.[1]?.updatedAt || 0) - Number(a?.[1]?.updatedAt || 0));
        return String(exactMatches[0]?.[0] || '').trim();
    }
    if (lastKnownChatKey && memoryStoreCache.has(lastKnownChatKey)) {
        return lastKnownChatKey;
    }
    return '';
}

function getChatKey(context, { allowFallback = false } = {}) {
    const target = buildMemoryTargetFromContext(context);
    if (!target) {
        if (allowFallback) {
            const fallback = findFallbackChatKeyBySourceState(context);
            if (fallback) {
                return fallback;
            }
        }
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

function buildMemoryTargetFromContext(context) {
    if (context.groupId) {
        const groupChatId = String(context.chatId || '').trim();
        if (!groupChatId) {
            return null;
        }
        return { is_group: true, id: groupChatId };
    }

    const avatar = String(context.characters?.[context.characterId]?.avatar || '').trim();
    const fileName = String(context.characters?.[context.characterId]?.chat || context.chatId || '').trim();
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
    return migrateLegacyStoreIfNeeded(data || createEmptyStore());
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
        version: 2,
        nodeSeq: 0,
        nodes: {},
        edges: [],
        turnOrder: [],
        turnsSinceUpdate: 0,
        totalTurns: 0,
        activeArcId: '',
        activeEpisodeId: '',
        canonId: '',
        rollupRootId: '',
        lastCanonSnapshotKey: '',
        lastExtractedTurn: -1,
        lastRecallTrace: [],
        layerSnapshots: [],
        sourceMessageCount: 0,
        sourceDigest: '',
        updatedAt: Date.now(),
    };
}

function migrateLegacyStoreIfNeeded(store) {
    if (!store || typeof store !== 'object') {
        return createEmptyStore();
    }
    if (store.version === 2 && store.nodes && typeof store.nodes === 'object') {
        if (!Array.isArray(store.layerSnapshots)) {
            store.layerSnapshots = [];
        }
        if (typeof store.lastCanonSnapshotKey !== 'string') {
            store.lastCanonSnapshotKey = '';
        }
        if (typeof store.rollupRootId !== 'string') {
            store.rollupRootId = '';
        }
        if (!Number.isFinite(Number(store.sourceMessageCount))) {
            store.sourceMessageCount = 0;
        }
        if (typeof store.sourceDigest !== 'string') {
            store.sourceDigest = '';
        }
        return store;
    }

    const migrated = createEmptyStore();
    const turns = Array.isArray(store.turns) ? store.turns : [];
    for (const turn of turns) {
        const pseudoTurn = {
            is_user: Boolean(turn?.is_user),
            name: String(turn?.name || ''),
            mes: String(turn?.mes || ''),
            send_date: String(turn?.send_date || ''),
        };
        ingestTurnNode(migrated, pseudoTurn);
    }

    migrated.layerSnapshots = Array.isArray(store.layerSnapshots) ? store.layerSnapshots : [];
    migrated.lastCanonSnapshotKey = String(store.lastCanonSnapshotKey || '');
    migrated.rollupRootId = String(store.rollupRootId || '');

    return migrated;
}

async function ensureMemoryStoreLoaded(context, { force = false } = {}) {
    const target = buildMemoryTargetFromContext(context);
    if (!target) {
        const fallbackKey = getChatKey(context, { allowFallback: true });
        if (fallbackKey !== 'invalid_target' && memoryStoreCache.has(fallbackKey)) {
            return memoryStoreCache.get(fallbackKey);
        }
        return createEmptyStore();
    }

    const chatKey = getChatKey(context);
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

function getMemoryStore(context) {
    const chatKey = getChatKey(context, { allowFallback: true });
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
    mergeObject(node?.metadata);
    mergeObject(tryParseJsonObject(node?.metadata?.fields));
    mergeObject(tryParseJsonObject(node?.metadata?.data));
    mergeObject(tryParseJsonObject(node?.content));
    mergeObject(tryParseJsonObject(node?.summary));
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

function getPlayableChatMessages(context) {
    return (Array.isArray(context?.chat) ? context.chat : [])
        .filter(message => message && !message.is_system)
        .map(message => ({
            is_user: Boolean(message.is_user),
            name: String(message.name || ''),
            mes: String(message.mes || ''),
            send_date: String(message.send_date || ''),
        }));
}

function computeChatSourceState(context) {
    const source = Array.isArray(context?.chat) ? context.chat : [];
    const tail = [];
    let count = 0;
    for (const message of source) {
        if (!message || message.is_system) {
            continue;
        }
        count += 1;
        tail.push({
            is_user: Boolean(message.is_user),
            name: String(message.name || ''),
            mes: String(message.mes || ''),
            send_date: String(message.send_date || ''),
        });
        if (tail.length > 24) {
            tail.shift();
        }
    }
    const digestPayload = tail.map(message => `${message.is_user ? 'u' : 'a'}|${message.name}|${normalizeText(message.mes)}|${message.send_date}`).join('\n');
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

function hasStoreSourceMismatch(store, context) {
    const source = computeChatSourceState(context);
    return Number(store?.sourceMessageCount || 0) !== Number(source.messageCount || 0)
        || String(store?.sourceDigest || '') !== String(source.digest || '');
}

function getNodeTypeSchemaMap(settings) {
    const map = new Map();
    for (const entry of normalizeNodeTypeSchema(settings.nodeTypeSchema)) {
        map.set(String(entry.id || '').toLowerCase(), entry);
    }
    return map;
}

function getSemanticTypeSpec(settings, type) {
    const map = getNodeTypeSchemaMap(settings);
    return map.get(String(type || '').toLowerCase()) || null;
}

function getSemanticCompressionConfig(settings, type) {
    const spec = getSemanticTypeSpec(settings, type);
    const raw = spec?.compression && typeof spec.compression === 'object' ? spec.compression : {};
    const mode = ['none', 'hierarchical', 'latest_only'].includes(String(raw.mode || '').toLowerCase())
        ? String(raw.mode).toLowerCase()
        : 'none';
    return {
        mode,
        threshold: Math.max(2, Number(raw.threshold) || 6),
        fanIn: Math.max(2, Number(raw.fanIn) || 3),
        maxDepth: Math.max(1, Number(raw.maxDepth) || 6),
        keepRecentLeaves: Math.max(0, Number(raw.keepRecentLeaves) || 0),
        keepLatest: Math.max(1, Number(raw.keepLatest) || 1),
        summarizeInstruction: String(raw.summarizeInstruction || '').trim(),
        label: String(spec?.label || type || 'Semantic'),
    };
}

function scoreQueryKeywords(query, keywords) {
    const normalizedQuery = normalizeText(query).toLowerCase();
    if (!normalizedQuery || !Array.isArray(keywords) || keywords.length === 0) {
        return 0;
    }
    let score = 0;
    for (const keyword of keywords) {
        const token = normalizeText(keyword).toLowerCase();
        if (!token) {
            continue;
        }
        if (normalizedQuery.includes(token)) {
            score += 1;
        }
    }
    return score;
}

function nextNodeId(store) {
    store.nodeSeq = Number(store.nodeSeq || 0) + 1;
    return `n_${store.nodeSeq}`;
}

function createNode(store, node) {
    const id = nextNodeId(store);
    const now = Date.now();
    store.nodes[id] = {
        id,
        type: String(node.type || 'unknown'),
        level: String(node.level || LEVEL.SEMANTIC),
        title: normalizeText(node.title || id),
        summary: normalizeText(node.summary || ''),
        content: normalizeText(node.content || ''),
        parentId: node.parentId ? String(node.parentId) : '',
        childrenIds: [],
        links: [],
        metadata: node.metadata && typeof node.metadata === 'object' ? node.metadata : {},
        turnIndex: Number.isFinite(Number(node.turnIndex)) ? Number(node.turnIndex) : undefined,
        fromTurn: Number.isFinite(Number(node.fromTurn)) ? Number(node.fromTurn) : undefined,
        toTurn: Number.isFinite(Number(node.toTurn)) ? Number(node.toTurn) : undefined,
        finalized: Boolean(node.finalized),
        archived: Boolean(node.archived),
        count: Number(node.count || 1),
        createdAt: now,
        updatedAt: now,
    };

    if (store.nodes[id].parentId && store.nodes[store.nodes[id].parentId]) {
        const parent = store.nodes[store.nodes[id].parentId];
        if (!parent.childrenIds.includes(id)) {
            parent.childrenIds.push(id);
            parent.updatedAt = now;
        }
        addEdge(store, parent.id, id, 'contains');
    }

    return store.nodes[id];
}

function addEdge(store, from, to, type = 'related') {
    if (!from || !to || from === to) {
        return;
    }

    const now = Date.now();
    const found = store.edges.find(edge => edge.from === from && edge.to === to && edge.type === type);
    if (found) {
        found.updatedAt = now;
        return;
    }

    store.edges.push({
        from,
        to,
        type,
        updatedAt: now,
    });
}

function ensureCanonNode(store) {
    if (store.canonId && store.nodes[store.canonId]) {
        return store.nodes[store.canonId];
    }

    const canon = createNode(store, {
        type: 'canon',
        level: LEVEL.CANON,
        title: 'Canon',
        summary: '',
        content: '',
        finalized: false,
    });
    store.canonId = canon.id;
    return canon;
}

function ensureRollupRoot(store) {
    if (store.rollupRootId && store.nodes[store.rollupRootId]) {
        return store.nodes[store.rollupRootId];
    }

    const root = createNode(store, {
        type: 'rollup_root',
        level: LEVEL.ROLLUP,
        title: 'Memory Rollup Root',
        summary: '',
        content: '',
        finalized: true,
        metadata: { depth: -1 },
    });
    store.rollupRootId = root.id;
    return root;
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
        oldParent.updatedAt = Date.now();
    }

    child.parentId = parentId;
    if (!Array.isArray(parent.childrenIds)) {
        parent.childrenIds = [];
    }
    if (!parent.childrenIds.includes(childId)) {
        parent.childrenIds.push(childId);
    }
    parent.updatedAt = Date.now();
    child.updatedAt = Date.now();
    addEdge(store, parentId, childId, 'contains');
}

function saveLayerSnapshot(store, level, node, extra = {}) {
    const settings = getSettings();
    const maxSnapshots = Math.max(100, Number(settings.maxLayerSnapshots || 800));
    if (!Array.isArray(store.layerSnapshots)) {
        store.layerSnapshots = [];
    }

    store.layerSnapshots.push({
        at: Date.now(),
        level: String(level || ''),
        node_id: String(node?.id || ''),
        title: String(node?.title || ''),
        summary: String(node?.summary || ''),
        from_turn: Number(node?.fromTurn ?? node?.turnIndex ?? -1),
        to_turn: Number(node?.toTurn ?? node?.turnIndex ?? -1),
        ...extra,
    });

    if (store.layerSnapshots.length > maxSnapshots) {
        const overflow = store.layerSnapshots.length - maxSnapshots;
        store.layerSnapshots.splice(0, overflow);
    }
}

function ensureActiveArcNode(store) {
    if (store.activeArcId && store.nodes[store.activeArcId] && !store.nodes[store.activeArcId].finalized) {
        return store.nodes[store.activeArcId];
    }

    const canon = ensureCanonNode(store);
    const arc = createNode(store, {
        type: 'arc',
        level: LEVEL.ARC,
        title: `Arc ${listNodesByLevel(store, LEVEL.ARC).length + 1}`,
        summary: '',
        content: '',
        parentId: canon.id,
    });
    store.activeArcId = arc.id;
    return arc;
}

function ensureActiveEpisodeNode(store) {
    if (store.activeEpisodeId && store.nodes[store.activeEpisodeId] && !store.nodes[store.activeEpisodeId].finalized) {
        return store.nodes[store.activeEpisodeId];
    }

    const arc = ensureActiveArcNode(store);
    const episode = createNode(store, {
        type: 'episode',
        level: LEVEL.EPISODE,
        title: `Episode ${listNodesByLevel(store, LEVEL.EPISODE).length + 1}`,
        summary: '',
        content: '',
        parentId: arc.id,
    });
    store.activeEpisodeId = episode.id;
    return episode;
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

function ingestTurnNode(store, message) {
    const settings = getSettings();
    const text = normalizeText(message?.mes || '');
    if (!text) {
        return null;
    }

    const episode = ensureActiveEpisodeNode(store);
    const turnNode = createNode(store, {
        type: 'turn',
        level: LEVEL.TURN,
        title: `Turn ${store.totalTurns + 1}`,
        summary: '',
        content: text,
        parentId: episode.id,
        turnIndex: store.totalTurns,
        fromTurn: store.totalTurns,
        toTurn: store.totalTurns,
        metadata: {
            is_user: Boolean(message?.is_user),
            name: String(message?.name || ''),
            send_date: String(message?.send_date || ''),
        },
    });

    store.turnOrder.push(turnNode.id);
    store.totalTurns += 1;
    store.turnsSinceUpdate += 1;

    if (store.turnOrder.length > Number(settings.maxTurns || 900)) {
        const overflow = store.turnOrder.length - Number(settings.maxTurns || 900);
        const removed = store.turnOrder.splice(0, overflow);
        for (const nodeId of removed) {
            const node = store.nodes[nodeId];
            if (node) {
                node.archived = true;
                node.updatedAt = Date.now();
            }
        }
    }

    store.updatedAt = Date.now();
    return turnNode;
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
    store.turnOrder = store.turnOrder.filter(id => id !== nodeId);
    store.edges = store.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);

    if (store.activeEpisodeId === nodeId) {
        store.activeEpisodeId = '';
    }
    if (store.activeArcId === nodeId) {
        store.activeArcId = '';
    }
    if (store.canonId === nodeId) {
        store.canonId = '';
    }
}

function archiveNode(store, nodeId, { detachFromTurnOrder = false } = {}) {
    const node = store.nodes[nodeId];
    if (!node) {
        return;
    }
    node.archived = true;
    node.updatedAt = Date.now();
    if (detachFromTurnOrder && Array.isArray(store.turnOrder)) {
        store.turnOrder = store.turnOrder.filter(id => id !== nodeId);
    }
}

function summarizeTextHeuristic(lines) {
    return lines
        .map(line => normalizeText(line))
        .filter(Boolean)
        .join('\n');
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

async function summarizeTextWithLLM(context, settings, instruction, lines, responseLength = 260) {
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
            responseLength,
            parameters: {
                type: 'object',
                properties: {
                    summary: { type: 'string' },
                },
                required: ['summary'],
                additionalProperties: false,
            },
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
                arguments: JSON.parse(argsText),
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

function isRetryableToolCallError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('tool call');
}

async function requestToolCallWithRetry(settings, promptMessages, {
    functionName = '',
    functionDescription = '',
    parameters = {},
    responseLength = 320,
    llmPresetName = '',
    apiSettingsOverride = null,
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

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const responseData = await sendOpenAIRequest('quiet', promptMessages, null, {
                tools,
                toolChoice,
                replaceTools: true,
                responseLength: Number(responseLength || 320),
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
            });
            return extractFunctionCallArguments(responseData, fnName);
        } catch (error) {
            lastError = error;
            if (!isRetryableToolCallError(error) || attempt >= retries) {
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
    responseLength = 320,
    llmPresetName = '',
    apiSettingsOverride = null,
} = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error('Tools are required.');
    }

    const retries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const responseData = await sendOpenAIRequest('quiet', promptMessages, null, {
                tools,
                toolChoice: 'auto',
                replaceTools: true,
                responseLength: Number(responseLength || 320),
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
            });
            return extractAllFunctionCalls(responseData, allowedNames);
        } catch (error) {
            lastError = error;
            if (!isRetryableToolCallError(error) || attempt >= retries) {
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
    responseLength = 320,
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
        responseLength: Number(responseLength || 320),
        llmPresetName: String(promptPresetName || '').trim(),
        apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
    });
}

async function extractNodesWithLLM(context, settings, schema, turnNodes) {
    const lines = turnNodes.map(node => `[${node.title}] ${node.content}`);
    if (lines.length === 0) {
        return [];
    }

    try {
        const resolvedApiPresetName = String(settings.extractApiPresetName || '').trim();
        const requestApi = resolveRequestApiFromConnectionProfileName(context, resolvedApiPresetName);
        const promptPresetName = String(settings.extractPresetName || '').trim();
        const promptMessages = buildPresetAwareLLMMessages(context, settings, {
            api: requestApi,
            systemPrompt: [
                'Extract structured memory nodes from dialogue turns.',
                'Use tool calls only. Do not return plain JSON text.',
                'Call luker_rpg_extract_upsert once per node update. Never emit one huge array payload.',
                'For events, include links to involved entities/locations/threads whenever possible.',
                'Summary rule: summary must be concise and abstract. Never copy long raw dialogue into summary.',
                'Write long evidence and quotes in content, not summary.',
                'Put table-like attributes into "fields" object and align keys with schema table columns.',
                'If evidence supports a field (state/goal/identity/status/etc), fill it explicitly instead of leaving blank.',
                'Call luker_rpg_extract_done after all upserts are emitted.',
            ].join('\n'),
            userPrompt: JSON.stringify({
                schema,
                schema_field_targets: schema.map(item => ({
                    type: String(item?.id || ''),
                    table_name: String(item?.tableName || ''),
                    fields: Array.isArray(item?.tableColumns) ? item.tableColumns : [],
                })),
                turns: lines,
            }),
            includeCharacterCard: true,
            promptPresetName,
        });
        const tools = [
            {
                type: 'function',
                function: {
                    name: 'luker_rpg_extract_upsert',
                    description: 'Emit one semantic node upsert.',
                    parameters: {
                        type: 'object',
                        properties: {
                            type: { type: 'string' },
                            title: { type: 'string' },
                            summary: { type: 'string' },
                            content: { type: 'string' },
                            fields: {
                                type: 'object',
                                additionalProperties: true,
                            },
                            evidence_turn_titles: {
                                type: 'array',
                                items: { type: 'string' },
                            },
                            links: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    properties: {
                                        target_type: { type: 'string' },
                                        target_title: { type: 'string' },
                                        target_summary: { type: 'string' },
                                        target_content: { type: 'string' },
                                        relation: { type: 'string' },
                                        direction: { type: 'string', enum: ['outgoing', 'incoming', 'bidirectional'] },
                                    },
                                    required: ['target_title'],
                                    additionalProperties: true,
                                },
                            },
                        },
                        required: ['type', 'title'],
                        additionalProperties: true,
                    },
                },
            },
            {
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
            },
        ];
        const allowedNames = new Set(['luker_rpg_extract_upsert', 'luker_rpg_extract_done']);
        const apiSettingsOverride = buildApiSettingsOverrideFromConnectionProfileName(
            resolvedApiPresetName,
            String(context?.chatCompletionSettings?.chat_completion_source || ''),
        );
        const calls = await requestToolCallsWithRetry(settings, promptMessages, {
            tools,
            allowedNames,
            responseLength: Number(settings.extractResponseLength || 360),
            llmPresetName: promptPresetName,
            apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
        });
        const upserts = calls
            .filter(call => String(call?.name || '') === 'luker_rpg_extract_upsert')
            .map(call => call.arguments)
            .filter(item => item && typeof item === 'object' && String(item.title || '').trim());
        if (upserts.length > 0) {
            return upserts;
        }
    } catch (error) {
        console.warn(`[${MODULE_NAME}] extract llm failed`, error);
    }

    return [];
}

function findTurnNodeByTitle(store, title) {
    const normalized = normalizeText(title).toLowerCase();
    if (!normalized) {
        return null;
    }
    return Object.values(store.nodes).find(node => node.level === LEVEL.TURN && node.title.toLowerCase() === normalized) || null;
}

function upsertSemanticNode(store, item) {
    const type = String(item.type || 'semantic').toLowerCase();
    const title = normalizeText(item.title || 'Untitled');
    if (!title) {
        return null;
    }

    const normalizedKey = `${type}::${title.toLowerCase()}`;
    let target = Object.values(store.nodes).find(node => node.level === LEVEL.SEMANTIC && `${node.type}::${node.title.toLowerCase()}` === normalizedKey);

    if (!target) {
        target = createNode(store, {
            type,
            level: LEVEL.SEMANTIC,
            title,
            summary: normalizeText(item.summary || ''),
            content: normalizeText(item.content || item.summary || ''),
            finalized: true,
            metadata: {
                semantic_depth: 0,
                semantic_rollup: false,
                ...(item?.fields && typeof item.fields === 'object' ? item.fields : {}),
            },
            turnIndex: Number.isFinite(Number(item.turnIndex)) ? Number(item.turnIndex) : undefined,
            fromTurn: Number.isFinite(Number(item.turnIndex)) ? Number(item.turnIndex) : undefined,
            toTurn: Number.isFinite(Number(item.turnIndex)) ? Number(item.turnIndex) : undefined,
        });
        saveLayerSnapshot(store, LEVEL.SEMANTIC, target, { action: 'create' });
    } else {
        target.summary = normalizeText(item.summary || target.summary || '');
        target.content = normalizeText(item.content || target.content || '');
        target.count = Number(target.count || 1) + 1;
        if (!target.metadata || typeof target.metadata !== 'object') {
            target.metadata = {};
        }
        if (!Number.isFinite(Number(target.metadata.semantic_depth))) {
            target.metadata.semantic_depth = 0;
        }
        if (target.metadata.semantic_rollup === undefined) {
            target.metadata.semantic_rollup = false;
        }
        if (item?.fields && typeof item.fields === 'object') {
            Object.assign(target.metadata, item.fields);
        }
        if (Number.isFinite(Number(item.turnIndex))) {
            target.toTurn = Number(item.turnIndex);
            target.fromTurn = Number.isFinite(Number(target.fromTurn)) ? Math.min(Number(target.fromTurn), Number(item.turnIndex)) : Number(item.turnIndex);
        }
        target.updatedAt = Date.now();
        saveLayerSnapshot(store, LEVEL.SEMANTIC, target, { action: 'update' });
    }

    if (item.turnNodeId && store.nodes[item.turnNodeId]) {
        addEdge(store, target.id, item.turnNodeId, 'evidence');
        addEdge(store, item.turnNodeId, target.id, 'mentions');
    }

    return target;
}

function applyExtractedLinks(store, sourceNode, rawLinks, defaultTurnIndex) {
    if (!sourceNode || !Array.isArray(rawLinks) || rawLinks.length === 0) {
        return;
    }

    for (const link of rawLinks) {
        const targetTitle = normalizeText(link?.target_title || '');
        if (!targetTitle) {
            continue;
        }

        const targetNode = upsertSemanticNode(store, {
            type: String(link?.target_type || 'entity').toLowerCase(),
            title: targetTitle,
            summary: normalizeText(link?.target_summary || ''),
            content: normalizeText(link?.target_content || link?.target_summary || ''),
            turnIndex: Number.isFinite(Number(defaultTurnIndex)) ? Number(defaultTurnIndex) : undefined,
        });
        if (!targetNode) {
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

async function finalizeEpisodeIfNeeded(context, store, settings) {
    const episode = store.activeEpisodeId ? store.nodes[store.activeEpisodeId] : null;
    if (!episode || episode.finalized) {
        return false;
    }

    const turns = getChildren(store, episode.id).filter(node => node.level === LEVEL.TURN);
    if (turns.length < Number(settings.turnsPerEpisode || 10)) {
        return false;
    }

    const lines = turns.map(node => `${node.metadata?.is_user ? 'User' : (node.metadata?.name || 'Assistant')}: ${node.content}`);
    const summary = await summarizeTextWithLLM(
        context,
        settings,
        'Summarize this episode for long-term roleplay memory. Keep key facts, unresolved threads, and state changes.',
        lines,
        280,
    );
    if (!summary) {
        return false;
    }

    episode.summary = summary;
    episode.content = summary;
    episode.fromTurn = turns.length > 0 ? Math.min(...turns.map(node => Number(node.turnIndex || 0))) : episode.fromTurn;
    episode.toTurn = turns.length > 0 ? Math.max(...turns.map(node => Number(node.turnIndex || 0))) : episode.toTurn;
    episode.finalized = true;
    episode.updatedAt = Date.now();
    saveLayerSnapshot(store, LEVEL.EPISODE, episode);
    store.activeEpisodeId = '';

    return true;
}

async function finalizeArcIfNeeded(context, store, settings) {
    const arc = store.activeArcId ? store.nodes[store.activeArcId] : null;
    if (!arc || arc.finalized) {
        return false;
    }

    const episodes = getChildren(store, arc.id).filter(node => node.level === LEVEL.EPISODE && node.finalized);
    if (episodes.length < Number(settings.episodesPerArc || 4)) {
        return false;
    }

    const lines = episodes.map(node => `${node.title}: ${node.summary || node.content}`);
    const summary = await summarizeTextWithLLM(
        context,
        settings,
        'Summarize these episodes into one Arc memory. Focus on major trajectories, consequences, and unresolved hooks.',
        lines,
        320,
    );
    if (!summary) {
        return false;
    }

    arc.summary = summary;
    arc.content = summary;
    arc.fromTurn = Math.min(...episodes.map(node => Number(node.fromTurn ?? node.toTurn ?? 0)));
    arc.toTurn = Math.max(...episodes.map(node => Number(node.toTurn ?? node.fromTurn ?? 0)));
    arc.finalized = true;
    arc.updatedAt = Date.now();
    saveLayerSnapshot(store, LEVEL.ARC, arc);
    store.activeArcId = '';

    return true;
}

async function updateCanonSummaryIfNeeded(context, store, settings, force = false) {
    const canon = ensureCanonNode(store);
    const arcs = getChildren(store, canon.id).filter(node => node.level === LEVEL.ARC && node.finalized && !node.archived);

    if (!force && arcs.length < Number(settings.arcsPerCanon || 3)) {
        return false;
    }

    if (arcs.length === 0) {
        return false;
    }

    const lines = arcs.map(node => `${node.title}: ${node.summary || node.content}`);
    const summary = await summarizeTextWithLLM(
        context,
        settings,
        'Summarize these arcs into canonical long-term memory, preserving major world-state facts and enduring threads.',
        lines,
        360,
    );
    if (!summary) {
        return false;
    }

    canon.summary = summary;
    canon.content = summary;
    canon.updatedAt = Date.now();
    saveLayerSnapshot(store, LEVEL.CANON, canon);

    const keepArcs = Number(settings.arcsPerCanon || 3);
    if (arcs.length > keepArcs) {
        const sorted = arcs.slice().sort((a, b) => Number(a.toTurn || 0) - Number(b.toTurn || 0));
        const archived = sorted.slice(0, Math.max(0, sorted.length - keepArcs));
        for (const arc of archived) {
            arc.archived = true;
            arc.updatedAt = Date.now();
            compactArcDeepChildren(store, arc.id, Number(settings.keepRecentEpisodeTurns || 3));
        }
    }

    snapshotCanonToRollup(store, settings);
    return true;
}

function snapshotCanonToRollup(store, settings) {
    const canon = ensureCanonNode(store);
    const summary = normalizeText(canon.summary || canon.content || '');
    if (!summary) {
        return null;
    }

    const snapshotKey = `${summary.slice(0, 180)}::${Number(canon.toTurn ?? store.totalTurns)}`;
    if (snapshotKey === String(store.lastCanonSnapshotKey || '')) {
        return null;
    }

    const root = ensureRollupRoot(store);
    const leaf = createNode(store, {
        type: 'rollup',
        level: LEVEL.ROLLUP,
        title: `Rollup L0 #${listNodesByLevel(store, LEVEL.ROLLUP).length + 1}`,
        summary,
        content: summary,
        finalized: true,
        archived: false,
        parentId: root.id,
        fromTurn: Number(canon.fromTurn ?? 0),
        toTurn: Number(canon.toTurn ?? store.totalTurns),
        metadata: {
            depth: 0,
            source: 'canon_snapshot',
        },
    });
    store.lastCanonSnapshotKey = snapshotKey;
    saveLayerSnapshot(store, LEVEL.ROLLUP, leaf, { depth: 0, source: 'canon_snapshot' });
    return leaf;
}

function getActiveRollupNodesByDepth(store, depth) {
    return listNodesByLevel(store, LEVEL.ROLLUP)
        .filter(node => Number(node?.metadata?.depth) === Number(depth) && !node.archived && node.id !== store.rollupRootId)
        .sort((a, b) => Number(a.toTurn ?? a.createdAt ?? 0) - Number(b.toTurn ?? b.createdAt ?? 0));
}

async function compressRollupLayersIfNeeded(context, store, settings) {
    const fanIn = Math.max(2, Number(settings.rollupFanIn || settings.arcsPerCanon || 3));
    const root = ensureRollupRoot(store);
    let depth = 0;
    let guard = 0;
    let changed = false;
    let maxDepth = Math.max(0, ...listNodesByLevel(store, LEVEL.ROLLUP)
        .map(node => Number(node?.metadata?.depth))
        .filter(Number.isFinite));

    while (guard < 80) {
        guard += 1;
        const candidates = getActiveRollupNodesByDepth(store, depth);
        if (candidates.length < fanIn) {
            depth += 1;
            if (depth > maxDepth + 1) {
                break;
            }
            continue;
        }

        const group = candidates.slice(0, fanIn);
        const lines = group.map(node => `${node.title}: ${node.summary || node.content}`);
        const summary = await summarizeTextWithLLM(
            context,
            settings,
            `Compress rollup depth ${depth} into depth ${depth + 1}. Keep only critical long-term facts and unresolved threads.`,
            lines,
            320,
        );
        if (!summary) {
            break;
        }

        const parent = createNode(store, {
            type: 'rollup',
            level: LEVEL.ROLLUP,
            title: `Rollup L${depth + 1} #${Date.now()}`,
            summary,
            content: summary,
            finalized: true,
            parentId: root.id,
            archived: false,
            fromTurn: Math.min(...group.map(node => Number(node.fromTurn ?? node.toTurn ?? 0))),
            toTurn: Math.max(...group.map(node => Number(node.toTurn ?? node.fromTurn ?? 0))),
            metadata: {
                depth: depth + 1,
                source: 'rollup_merge',
                merged_node_ids: group.map(node => node.id),
            },
        });

        for (const node of group) {
            node.archived = true;
            node.updatedAt = Date.now();
            reparentNode(store, node.id, parent.id);
        }
        maxDepth = Math.max(maxDepth, depth + 1);
        saveLayerSnapshot(store, LEVEL.ROLLUP, parent, { depth: depth + 1, source: 'rollup_merge' });
        changed = true;
    }

    return changed;
}

function compactArcDeepChildren(store, arcId, keepRecentEpisodeTurns = 3) {
    const arc = store.nodes[arcId];
    if (!arc) {
        return;
    }

    const episodes = getChildren(store, arc.id).filter(node => node.level === LEVEL.EPISODE);
    const sortedEpisodes = episodes.slice().sort((a, b) => Number(a.toTurn || 0) - Number(b.toTurn || 0));
    const removable = sortedEpisodes.slice(0, Math.max(0, sortedEpisodes.length - keepRecentEpisodeTurns));

    for (const episode of removable) {
        const turns = getChildren(store, episode.id).filter(node => node.level === LEVEL.TURN);
        for (const turn of turns) {
            archiveNode(store, turn.id, { detachFromTurnOrder: true });
        }
        episode.childrenIds = episode.childrenIds.filter(childId => store.nodes[childId] && !store.nodes[childId].archived);
        episode.updatedAt = Date.now();
    }
}

function getSemanticNodesForType(store, type) {
    const targetType = String(type || '').toLowerCase();
    return listNodesByLevel(store, LEVEL.SEMANTIC)
        .filter(node => !node.archived)
        .filter(node => String(node.type || '').toLowerCase() === targetType);
}

function compactSemanticLatestOnly(store, type, keepLatest = 1) {
    const nodes = getSemanticNodesForType(store, type)
        .filter(node => !node.metadata?.semantic_rollup)
        .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
    const byTitle = new Map();
    let changed = false;

    for (const node of nodes) {
        const key = String(node.title || '').trim().toLowerCase() || node.id;
        if (!byTitle.has(key)) {
            byTitle.set(key, []);
        }
        byTitle.get(key).push(node);
    }

    for (const [, bucket] of byTitle.entries()) {
        for (let i = Math.max(1, Number(keepLatest || 1)); i < bucket.length; i++) {
            archiveNode(store, bucket[i].id);
            changed = true;
        }
    }

    return changed;
}

function collectSemanticRootsByDepth(store, type, depth) {
    return getSemanticNodesForType(store, type)
        .filter(node => Number(node?.metadata?.semantic_depth ?? 0) === Number(depth))
        .filter(node => !String(node.parentId || '').trim())
        .sort((a, b) => {
            const aTo = Number(a.toTurn ?? a.turnIndex ?? a.createdAt ?? 0);
            const bTo = Number(b.toTurn ?? b.turnIndex ?? b.createdAt ?? 0);
            return aTo - bTo;
        });
}

async function compressSemanticHierarchical(context, store, settings, type, config) {
    let changed = false;
    let guard = 0;

    for (let depth = 0; depth < Number(config.maxDepth || 1); depth++) {
        while (guard < 120) {
            guard += 1;
            let candidates = collectSemanticRootsByDepth(store, type, depth);
            if (depth === 0 && Number(config.keepRecentLeaves || 0) > 0 && candidates.length > Number(config.keepRecentLeaves || 0)) {
                candidates = candidates.slice(0, Math.max(0, candidates.length - Number(config.keepRecentLeaves || 0)));
            }
            if (candidates.length < Number(config.threshold || 2)) {
                break;
            }

            const group = candidates.slice(0, Number(config.fanIn || 2));
            if (group.length < Number(config.fanIn || 2)) {
                break;
            }

            const lines = group.map(node => `${node.title}: ${node.summary || node.content}`);
            const instruction = config.summarizeInstruction
                || `Compress semantic type "${type}" into a higher-level summary node. Keep enduring facts and unresolved hooks.`;
            const summary = await summarizeTextWithLLM(context, settings, instruction, lines, 320);
            if (!summary) {
                break;
            }

            const parent = createNode(store, {
                type: String(type || 'semantic'),
                level: LEVEL.SEMANTIC,
                title: `${String(config.label || type || 'Semantic')} Summary L${depth + 1} #${Date.now()}`,
                summary,
                content: summary,
                finalized: true,
                archived: false,
                metadata: {
                    semantic_rollup: true,
                    semantic_depth: depth + 1,
                    semantic_source_type: type,
                    merged_node_ids: group.map(node => node.id),
                },
                fromTurn: Math.min(...group.map(node => Number(node.fromTurn ?? node.toTurn ?? 0))),
                toTurn: Math.max(...group.map(node => Number(node.toTurn ?? node.fromTurn ?? 0))),
            });

            for (const child of group) {
                reparentNode(store, child.id, parent.id);
                addEdge(store, parent.id, child.id, 'semantic_contains');
            }
            saveLayerSnapshot(store, LEVEL.SEMANTIC, parent, {
                source: 'semantic_rollup',
                semantic_type: type,
                semantic_depth: depth + 1,
            });
            changed = true;
        }
    }

    return changed;
}

async function compressSemanticTypesIfNeeded(context, store, settings) {
    const schema = normalizeNodeTypeSchema(settings.nodeTypeSchema);
    let changed = false;
    for (const spec of schema) {
        const type = String(spec.id || '').toLowerCase();
        if (!type) {
            continue;
        }
        const config = getSemanticCompressionConfig(settings, type);
        if (config.mode === 'none') {
            continue;
        }
        if (config.mode === 'latest_only') {
            if (compactSemanticLatestOnly(store, type, config.keepLatest)) {
                changed = true;
            }
            continue;
        }
        if (config.mode === 'hierarchical') {
            if (await compressSemanticHierarchical(context, store, settings, type, config)) {
                changed = true;
            }
        }
    }
    return changed;
}

async function runCompressionLoop(context, store, settings) {
    let changed = false;
    let guard = 0;

    while (guard < 12) {
        guard += 1;
        let stepChanged = false;

        if (await finalizeEpisodeIfNeeded(context, store, settings)) {
            stepChanged = true;
        }

        if (await finalizeArcIfNeeded(context, store, settings)) {
            stepChanged = true;
        }

        if (await updateCanonSummaryIfNeeded(context, store, settings, false)) {
            stepChanged = true;
        }

        if (!stepChanged) {
            break;
        }
        changed = true;

        ensureActiveArcNode(store);
        ensureActiveEpisodeNode(store);
    }

    if (!changed) {
        await updateCanonSummaryIfNeeded(context, store, settings, true);
    }

    if (await compressRollupLayersIfNeeded(context, store, settings)) {
        changed = true;
    }
    if (await compressSemanticTypesIfNeeded(context, store, settings)) {
        changed = true;
    }
    return changed;
}

async function runExtractionForStore(context, store) {
    const settings = getSettings();
    if (store.turnsSinceUpdate < Number(settings.updateEvery || 6)) {
        return;
    }

    const turnNodes = store.turnOrder
        .map(id => store.nodes[id])
        .filter(Boolean)
        .filter(node => node.level === LEVEL.TURN)
        .filter(node => Number(node.turnIndex || 0) > Number(store.lastExtractedTurn || -1));

    if (turnNodes.length === 0) {
        store.turnsSinceUpdate = 0;
        return;
    }

    const schema = normalizeNodeTypeSchema(settings.nodeTypeSchema);
    const batchSize = Math.max(2, Number(settings.extractBatchTurns || settings.updateEvery || 6));
    for (let offset = 0; offset < turnNodes.length; offset += batchSize) {
        const batch = turnNodes.slice(offset, offset + batchSize);
        const upserts = await extractNodesWithLLM(context, settings, schema, batch);
        for (const item of upserts) {
            const title = normalizeText(item?.title || '');
            if (!title) {
                continue;
            }
            const evidenceTitle = Array.isArray(item?.evidence_turn_titles) ? item.evidence_turn_titles[0] : '';
            const evidenceNode = evidenceTitle ? findTurnNodeByTitle(store, evidenceTitle) : null;
            const targetNode = upsertSemanticNode(store, {
                type: String(item?.type || 'semantic').toLowerCase(),
                title,
                summary: normalizeText(item?.summary || ''),
                content: normalizeText(item?.content || item?.summary || ''),
                fields: item?.fields && typeof item.fields === 'object' ? item.fields : {},
                turnIndex: Number.isFinite(Number(evidenceNode?.turnIndex)) ? Number(evidenceNode?.turnIndex) : Number(batch[batch.length - 1]?.turnIndex || 0),
                turnNodeId: evidenceNode?.id,
            });
            if (targetNode) {
                applyExtractedLinks(
                    store,
                    targetNode,
                    Array.isArray(item?.links) ? item.links : [],
                    Number.isFinite(Number(evidenceNode?.turnIndex)) ? Number(evidenceNode?.turnIndex) : Number(batch[batch.length - 1]?.turnIndex || 0),
                );
            }
        }
        store.lastExtractedTurn = Math.max(...batch.map(node => Number(node.turnIndex || 0)));
    }
    store.turnsSinceUpdate = 0;

    await runCompressionLoop(context, store, settings);
    store.updatedAt = Date.now();
}

function formatNodeBrief(node, extra = {}) {
    return {
        id: node.id,
        level: node.level,
        type: node.type,
        title: node.title,
        summary: String(node.summary || node.content || ''),
        child_count: Array.isArray(node.childrenIds) ? node.childrenIds.length : 0,
        to_turn: node.toTurn ?? node.turnIndex ?? null,
        from_turn: node.fromTurn ?? node.turnIndex ?? null,
        ...extra,
    };
}

function formatNodeDetail(node, extra = {}) {
    return {
        id: node.id,
        level: node.level,
        type: node.type,
        title: node.title,
        summary: String(node.summary || ''),
        content: String(node.content || ''),
        metadata: node.metadata || {},
        children: Array.isArray(node.childrenIds) ? node.childrenIds : [],
        from_turn: node.fromTurn ?? node.turnIndex ?? null,
        to_turn: node.toTurn ?? node.turnIndex ?? null,
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

function getNodeScore(node) {
    const toTurn = Number(node?.toTurn ?? node?.turnIndex ?? 0);
    const updatedAt = Number(node?.updatedAt ?? node?.createdAt ?? 0);
    const depth = Number(node?.metadata?.depth ?? 0);
    return (toTurn * 1000) + updatedAt + (depth * 100);
}

function getSortedNodesByScore(nodes) {
    return nodes
        .slice()
        .sort((a, b) => getNodeScore(b) - getNodeScore(a));
}

function getRecallQueryBundle(payload, context) {
    const payloadMessages = Array.isArray(payload?.coreChat) ? payload.coreChat : null;
    const source = payloadMessages || context.chat || [];
    let lastUser = '';
    let lastAssistant = '';

    for (let i = source.length - 1; i >= 0; i--) {
        const message = source[i];
        if (!message) {
            continue;
        }
        if (!lastUser && message.is_user) {
            lastUser = String(message.mes || '');
            continue;
        }
        if (!lastAssistant && !message.is_user) {
            lastAssistant = String(message.mes || '');
            continue;
        }
        if (lastUser && lastAssistant) {
            break;
        }
    }
    const wiHints = extractWorldInfoHints(payload);
    const fullText = normalizeText([lastUser, lastAssistant, ...wiHints].join('\n'));
    return {
        last_user: normalizeText(lastUser),
        last_assistant: normalizeText(lastAssistant),
        wi_hints: wiHints,
        fullText,
    };
}

function getNodeRecallExposure(settings, node) {
    if (!node) {
        return 'high_only';
    }
    if (node.level !== LEVEL.SEMANTIC) {
        return 'high_only';
    }
    const config = getSemanticCompressionConfig(settings, node.type);
    if (config.mode === 'hierarchical') {
        return 'high_only';
    }
    if (config.mode === 'latest_only') {
        return 'latest';
    }
    return 'full';
}

function buildNodeDegreeMap(store) {
    const degree = new Map();
    for (const edge of store.edges || []) {
        if (!edge) {
            continue;
        }
        degree.set(edge.from, Number(degree.get(edge.from) || 0) + 1);
        degree.set(edge.to, Number(degree.get(edge.to) || 0) + 1);
    }
    return degree;
}

function buildEdgeSummary(store, nodeId, { nodeSet = null, relationTypes = null, limit = 10 } = {}) {
    if (!nodeId) {
        return {
            degree: 0,
            relations: [],
            sample_neighbors: [],
        };
    }
    const relationAllow = Array.isArray(relationTypes) && relationTypes.length > 0
        ? new Set(relationTypes.map(type => normalizeText(type).toLowerCase()).filter(Boolean))
        : null;
    const byRelation = new Map();
    const neighborIds = new Set();
    let degree = 0;
    for (const edge of store.edges || []) {
        if (!edge) {
            continue;
        }
        const edgeType = normalizeText(edge.type || '').toLowerCase() || 'related';
        if (relationAllow && !relationAllow.has(edgeType)) {
            continue;
        }
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
        if (nodeSet && !nodeSet.has(neighborId)) {
            continue;
        }
        if (!store.nodes[neighborId] || store.nodes[neighborId].archived) {
            continue;
        }
        degree += 1;
        neighborIds.add(neighborId);
        const key = `${edgeType}:${direction}`;
        byRelation.set(key, Number(byRelation.get(key) || 0) + 1);
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

function scoreTitleAndAliasHit(queryText, node) {
    const normalizedQuery = normalizeText(queryText).toLowerCase();
    if (!normalizedQuery) {
        return 0;
    }
    const title = normalizeText(node?.title || '').toLowerCase();
    const aliases = []
        .concat(Array.isArray(node?.metadata?.aliases) ? node.metadata.aliases : [])
        .concat(Array.isArray(node?.metadata?.alias) ? node.metadata.alias : [])
        .map(item => normalizeText(item).toLowerCase())
        .filter(Boolean);
    let score = 0;
    if (title && normalizedQuery.includes(title)) {
        score += 3;
    }
    for (const alias of aliases) {
        if (alias && normalizedQuery.includes(alias)) {
            score += 2;
        }
    }
    return score;
}

function collectRootCandidates(store, settings, queryBundle = { fullText: '' }) {
    const maxItems = Math.max(6, Number(settings.recallRootCandidates || 24));
    const query = normalizeText(queryBundle?.fullText || '');
    const rollups = listNodesByLevel(store, LEVEL.ROLLUP)
        .filter(node => node.id !== store.rollupRootId && !node.archived)
        .slice(0);
    const canon = store.canonId && store.nodes[store.canonId] ? [store.nodes[store.canonId]] : [];
    const arcs = listNodesByLevel(store, LEVEL.ARC).filter(node => !node.archived);
    const episodes = listNodesByLevel(store, LEVEL.EPISODE).filter(node => !node.archived);
    const semantic = listNodesByLevel(store, LEVEL.SEMANTIC)
        .filter(node => !node.archived)
        .filter(node => !String(node.parentId || '').trim());
    const turns = store.turnOrder.map(id => store.nodes[id]).filter(Boolean).filter(node => !node.archived);
    const schemaMap = getNodeTypeSchemaMap(settings);
    const degreeMap = buildNodeDegreeMap(store);
    const merged = [
        ...getSortedNodesByScore(rollups).slice(0, 8),
        ...canon,
        ...getSortedNodesByScore(arcs).slice(0, 10),
        ...getSortedNodesByScore(episodes).slice(0, 10),
        ...getSortedNodesByScore(semantic).slice(0, 24),
        ...getSortedNodesByScore(turns).slice(0, 8),
    ];

    const uniqueNodes = [];
    const seen = new Set();
    for (const node of merged) {
        if (!node?.id || seen.has(node.id)) {
            continue;
        }
        seen.add(node.id);
        uniqueNodes.push(node);
    }

    const scored = uniqueNodes.map(node => {
        const type = String(node.type || '').toLowerCase();
        const spec = schemaMap.get(type);
        const keywordHit = scoreQueryKeywords(query, spec?.keywords);
        const titleHit = scoreTitleAndAliasHit(query, node);
        const mandatory = keywordHit > 0 || titleHit > 0;
        const alwaysInject = Boolean(spec?.alwaysInject);
        const levelBoost = node.level === LEVEL.SEMANTIC ? 16_000
            : node.level === LEVEL.ROLLUP ? 14_000
                : node.level === LEVEL.CANON ? 13_000
                    : node.level === LEVEL.ARC ? 12_000
                        : node.level === LEVEL.EPISODE ? 11_000
                            : node.level === LEVEL.TURN ? 8_000
                                : 0;
        const typeBoost = alwaysInject ? 220_000
            : type === 'event' ? 35_000
                : type === 'thread' ? 26_000
                    : type.includes('character') ? 22_000
                        : type.includes('location') ? 20_000
                            : type.includes('item') ? 18_000
                                : 8_000;
        const keywordBoost = (keywordHit * 60_000) + (titleHit * 40_000);
        const recency = Math.max(0, Number(node.toTurn ?? node.turnIndex ?? 0)) * 400;
        const connectivity = Math.min(60_000, Number(degreeMap.get(node.id) || 0) * 1200);
        return {
            node,
            mandatory,
            score: getNodeScore(node) + levelBoost + typeBoost + keywordBoost + recency + connectivity,
        };
    });
    scored.sort((a, b) => {
        if (a.mandatory !== b.mandatory) {
            return a.mandatory ? -1 : 1;
        }
        return b.score - a.score;
    });

    const mandatoryRows = scored.filter(item => item.mandatory);
    const optionalRows = scored.filter(item => !item.mandatory);
    const picked = [];
    const pickedIds = new Set();
    for (const row of mandatoryRows) {
        if (!row?.node?.id || pickedIds.has(row.node.id)) {
            continue;
        }
        pickedIds.add(row.node.id);
        picked.push(row.node);
    }
    for (const row of optionalRows) {
        if (picked.length >= maxItems && mandatoryRows.length <= maxItems) {
            break;
        }
        if (!row?.node?.id || pickedIds.has(row.node.id)) {
            continue;
        }
        pickedIds.add(row.node.id);
        picked.push(row.node);
        if (picked.length >= maxItems && mandatoryRows.length <= maxItems) {
            break;
        }
    }
    return picked;
}

function normalizeEdgeTypeList(rawTypes) {
    if (!Array.isArray(rawTypes)) {
        return ['related', 'involved_in', 'mentions', 'evidence', 'contains', 'updates', 'advances', 'occurred_at'];
    }
    const list = rawTypes.map(type => normalizeText(type).toLowerCase()).filter(Boolean);
    return list.length > 0 ? list : ['related', 'involved_in', 'mentions', 'evidence', 'contains', 'updates', 'advances', 'occurred_at'];
}

async function chooseRecallRoute(context, settings, recallState) {
    const selectionLimit = getRecallSelectionLimit(settings);
    const maxSelection = selectionLimit > 0 ? Math.max(2, selectionLimit) : 0;
    const alwaysInjectIds = Array.isArray(recallState?.alwaysInjectIds) ? recallState.alwaysInjectIds : [];
    const candidateSet = new Set((recallState.candidates || []).map(node => String(node?.id || '')).filter(Boolean));
    const candidateRows = (recallState.candidates || []).map(node => {
        const exposure = getNodeRecallExposure(settings, node);
        const row = formatNodeBrief(node, {
            exposure,
            edge_summary: buildEdgeSummary(recallState.store, node?.id, { nodeSet: candidateSet, limit: 8 }),
            always_inject: alwaysInjectIds.includes(String(node?.id || '')),
            fields: node?.metadata && typeof node.metadata === 'object' ? node.metadata : {},
        });
        if (exposure !== 'high_only') {
            row.content = String(node?.content || '');
        }
        return row;
    });
    try {
        const parsed = await runFunctionCallTask(context, settings, {
            systemPrompt: [
                'You are a memory recall agent.',
                'Step 1 decides whether current candidate graph is enough.',
                'Return action="finalize" if you can pick final nodes now.',
                'Return action="drill" only if you need deeper local expansion.',
                'Always-inject nodes are already injected separately. Never include them in selected_node_ids.',
                'Use edge_summary to reason about relations and continuity.',
            ].join('\n'),
            userPrompt: JSON.stringify({
                query_bundle: recallState.queryBundle,
                query: recallState.query,
                candidates: candidateRows,
                always_inject_ids: alwaysInjectIds,
                node_type_schema: normalizeNodeTypeSchema(settings.nodeTypeSchema).map(item => ({
                    id: item.id,
                    table_name: item.tableName,
                    table_columns: item.tableColumns,
                    always_inject: Boolean(item.alwaysInject),
                    compression_mode: String(item?.compression?.mode || 'none'),
                })),
                constraints: {
                    max_selection: maxSelection,
                    zero_means_unlimited: true,
                    max_expand_requests: 4,
                    max_expand_depth: 2,
                    max_expand_budget_nodes: Math.max(8, Number(settings.recallNeighborLimit || 24)),
                    recent_turn_window: Math.max(3, Number(settings.recentRawTurns || 5)),
                    injection_exclude_recent_turns: Math.max(0, Number(settings.recentRawTurns || 5)),
                },
            }),
            apiPresetName: settings.recallApiPresetName || '',
            promptPresetName: String(settings.recallPresetName || '').trim(),
            functionName: 'luker_rpg_recall_plan',
            functionDescription: 'Plan recall as finalize or drill with optional expansion plan.',
            responseLength: Number(settings.recallResponseLength || 260),
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
                                budget_nodes: { type: 'integer' },
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
                    depth: Math.max(1, Math.min(2, Number(item?.depth) || 1)),
                    budget_nodes: Math.max(4, Math.min(120, Number(item?.budget_nodes) || Number(settings.recallNeighborLimit || 24))),
                    include_children: item?.include_children !== false,
                })).filter(item => item.seed_node_id && candidateSet.has(item.seed_node_id))
                : [],
            referenced_always_inject_ids: Array.isArray(parsed?.referenced_always_inject_ids)
                ? parsed.referenced_always_inject_ids.map(id => String(id || '').trim()).filter(Boolean)
                : [],
            reason: String(parsed?.reason || '').slice(0, 280),
        };
    } catch (error) {
        console.warn(`[${MODULE_NAME}] recall route failed`, error);
        return {
            action: 'finalize',
            selected_node_ids: (selectionLimit > 0
                ? recallState.candidates.slice(0, maxSelection)
                : recallState.candidates).map(node => node.id),
            expand_plan: [],
            referenced_always_inject_ids: [],
            reason: 'Fallback route used.',
        };
    }
}

function addCandidate(candidateMap, node, scoreBoost = 0) {
    if (!node?.id) {
        return;
    }
    const current = candidateMap.get(node.id);
    const baseScore = getNodeScore(node) + Number(scoreBoost || 0);
    if (!current || baseScore > current.score) {
        candidateMap.set(node.id, { node, score: baseScore });
    }
}

function expandRouteCandidates(store, route, rootCandidates, settings) {
    const candidateMap = new Map();
    const expandPlan = Array.isArray(route?.expand_plan) ? route.expand_plan : [];
    const edges = Array.isArray(store?.edges) ? store.edges : [];
    const expandedCap = Math.max(12, Number(settings.recallExpandedCandidates || 48));

    for (const node of rootCandidates) {
        addCandidate(candidateMap, node, 0);
    }
    for (const request of expandPlan) {
        const seedId = String(request?.seed_node_id || '').trim();
        if (!seedId || !store.nodes[seedId]) {
            continue;
        }
        const relationTypes = normalizeEdgeTypeList(request?.relation_types);
        const relationSet = relationTypes.length > 0 ? new Set(relationTypes) : null;
        const depth = Math.max(1, Math.min(2, Number(request?.depth) || 1));
        const budget = Math.max(4, Math.min(120, Number(request?.budget_nodes) || Number(settings.recallNeighborLimit || 24)));
        const includeChildren = request?.include_children !== false;
        const seen = new Set([seedId]);
        let frontier = [seedId];
        let used = 0;
        addCandidate(candidateMap, store.nodes[seedId], 210_000);
        for (let hop = 0; hop < depth; hop++) {
            if (frontier.length === 0 || used >= budget) {
                break;
            }
            const next = [];
            for (const currentId of frontier) {
                if (used >= budget) {
                    break;
                }
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
                        addCandidate(candidateMap, child, 150_000 - (hop * 12_000));
                        next.push(child.id);
                        used += 1;
                        if (used >= budget) {
                            break;
                        }
                    }
                }
                if (used >= budget) {
                    break;
                }
                for (const edge of edges) {
                    if (!edge) {
                        continue;
                    }
                    const edgeType = normalizeText(edge.type || '').toLowerCase();
                    if (relationSet && !relationSet.has(edgeType)) {
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
                    addCandidate(candidateMap, neighbor, 130_000 - (hop * 10_000));
                    next.push(neighborId);
                    used += 1;
                    if (used >= budget) {
                        break;
                    }
                }
            }
            frontier = next;
        }
    }

    const expanded = Array.from(candidateMap.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, expandedCap)
        .map(item => item.node);

    return expanded;
}

async function chooseFocusNodes(context, settings, recallState) {
    const selectionLimit = getRecallSelectionLimit(settings);
    const maxSelection = selectionLimit > 0 ? Math.max(2, selectionLimit) : 0;
    const alwaysInjectIds = Array.isArray(recallState?.alwaysInjectIds) ? recallState.alwaysInjectIds : [];
    const candidateSet = new Set((recallState.candidates || []).map(node => String(node?.id || '')).filter(Boolean));
    const detailRows = (recallState.candidates || []).map(node => {
        const exposure = getNodeRecallExposure(settings, node);
        const row = formatNodeDetail(node, {
            exposure,
            edge_summary: buildEdgeSummary(recallState.store, node?.id, { nodeSet: candidateSet, limit: 12 }),
            always_inject: alwaysInjectIds.includes(String(node?.id || '')),
        });
        if (exposure === 'high_only') {
            delete row.content;
        }
        return row;
    });
    try {
        const parsed = await runFunctionCallTask(context, settings, {
            systemPrompt: [
                'You are finalizing memory recall node selection after optional drill expansion.',
                'Select both storyline continuity and required semantic support nodes.',
                'Always-inject nodes are already injected separately. Never include them in selected_node_ids.',
            ].join('\n'),
            userPrompt: JSON.stringify({
                query_bundle: recallState.queryBundle,
                query: recallState.query,
                candidates: detailRows,
                always_inject_ids: alwaysInjectIds,
                prior_plan: recallState.route || {},
                constraints: {
                    max_selection: maxSelection,
                    zero_means_unlimited: true,
                    include_non_event_nodes: true,
                    require_event_continuity: true,
                    recent_turn_window: Math.max(3, Number(settings.recentRawTurns || 5)),
                    injection_exclude_recent_turns: Math.max(0, Number(settings.recentRawTurns || 5)),
                    min_event_nodes_if_available: 2,
                },
            }),
            apiPresetName: settings.recallApiPresetName || '',
            promptPresetName: String(settings.recallPresetName || '').trim(),
            functionName: 'luker_rpg_recall_finalize',
            functionDescription: 'Finalize memory node IDs to inject.',
            responseLength: Number(settings.recallResponseLength || 260),
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
        });

        const selectedIds = Array.isArray(parsed?.selected_node_ids)
            ? parsed.selected_node_ids.map(id => String(id || '').trim()).filter(id => id && candidateSet.has(id))
            : [];
        return {
            selected_node_ids: selectedIds,
            reason: String(parsed?.reason || '').slice(0, 260),
        };
    } catch (error) {
        console.warn(`[${MODULE_NAME}] recall select failed`, error);
        return {
            selected_node_ids: (selectionLimit > 0
                ? recallState.candidates.slice(0, maxSelection)
                : recallState.candidates).map(node => node.id),
            reason: 'Fallback selection used.',
        };
    }
}

function collectAlwaysInjectNodes(store, settings) {
    const schemaMap = getNodeTypeSchemaMap(settings);
    const alwaysTypes = Array.from(schemaMap.values())
        .filter(spec => spec?.alwaysInject)
        .map(spec => String(spec.id || '').toLowerCase());
    if (alwaysTypes.length === 0) {
        return [];
    }

    return listNodesByLevel(store, LEVEL.SEMANTIC)
        .filter(node => !node.archived)
        .filter(node => alwaysTypes.includes(String(node.type || '').toLowerCase()))
        .sort((a, b) => getNodeScore(b) - getNodeScore(a))
        .slice(0, 6);
}

function getNodeTurnRange(node) {
    if (Number.isFinite(Number(node?.fromTurn)) || Number.isFinite(Number(node?.toTurn))) {
        const from = Number.isFinite(Number(node?.fromTurn)) ? Number(node.fromTurn) : Number(node?.toTurn ?? 0);
        const to = Number.isFinite(Number(node?.toTurn)) ? Number(node.toTurn) : Number(node?.fromTurn ?? 0);
        return `${from}~${to}`;
    }
    if (Number.isFinite(Number(node?.turnIndex))) {
        return `${Number(node.turnIndex)}`;
    }
    return '';
}

function getLatestTurnIndex(store) {
    const turns = Array.isArray(store?.turnOrder) ? store.turnOrder : [];
    if (turns.length === 0) {
        return -1;
    }
    const lastNode = store.nodes?.[turns[turns.length - 1]];
    const idx = Number(lastNode?.turnIndex ?? lastNode?.toTurn ?? -1);
    return Number.isFinite(idx) ? idx : -1;
}

function isNodeInRecentExcludeWindow(node, latestTurnIndex, excludeTurns) {
    const windowSize = Math.max(0, Number(excludeTurns || 0));
    if (windowSize <= 0 || latestTurnIndex < 0 || !node) {
        return false;
    }
    let fromTurn = Number(node?.fromTurn ?? node?.turnIndex ?? NaN);
    let toTurn = Number(node?.toTurn ?? node?.turnIndex ?? NaN);
    if (!Number.isFinite(fromTurn) && !Number.isFinite(toTurn)) {
        return false;
    }
    if (!Number.isFinite(fromTurn)) {
        fromTurn = toTurn;
    }
    if (!Number.isFinite(toTurn)) {
        toTurn = fromTurn;
    }
    const cutoff = latestTurnIndex - windowSize + 1;
    return Number.isFinite(cutoff) && toTurn >= cutoff;
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

function buildGlobalSpineText(store, settings) {
    const rows = [];
    const seen = new Set();
    const latestTurnIndex = getLatestTurnIndex(store);
    const excludeTurns = Math.max(0, Number(settings.recentRawTurns || 5));
    const snapshots = Array.isArray(store.layerSnapshots) ? store.layerSnapshots.slice() : [];
    snapshots.sort((a, b) => {
        const aFrom = Number(a?.from_turn ?? -1);
        const bFrom = Number(b?.from_turn ?? -1);
        if (aFrom !== bFrom) {
            return aFrom - bFrom;
        }
        const aTo = Number(a?.to_turn ?? -1);
        const bTo = Number(b?.to_turn ?? -1);
        if (aTo !== bTo) {
            return aTo - bTo;
        }
        return Number(a?.at ?? 0) - Number(b?.at ?? 0);
    });

    for (const item of snapshots) {
        if (!item || !['rollup', 'canon', 'arc', 'episode'].includes(String(item.level || ''))) {
            continue;
        }
        if (isNodeInRecentExcludeWindow({
            fromTurn: Number(item.from_turn ?? NaN),
            toTurn: Number(item.to_turn ?? NaN),
        }, latestTurnIndex, excludeTurns)) {
            continue;
        }
        const summary = normalizeText(item.summary || '');
        if (!summary) {
            continue;
        }
        const dedupeKey = `${item.level}:${item.node_id}:${summary.slice(0, 120)}`;
        if (seen.has(dedupeKey)) {
            continue;
        }
        seen.add(dedupeKey);
        rows.push([
            String(item.level || ''),
            String(item.title || ''),
            `${Number(item.from_turn ?? -1)}~${Number(item.to_turn ?? -1)}`,
            summary,
        ]);
    }

    const table = toMarkdownTable(['level', 'title', 'turn_range', 'summary'], rows);
    if (!table) {
        return '';
    }
    return `[Table: Global Event Spine]\n${table}`;
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
    if (key === 'turn_range') {
        return getNodeTurnRange(node);
    }
    if (key === 'summary') {
        return normalizeText(node.summary || '');
    }
    if (key === 'details' || key === 'content') {
        if (structured[key] !== undefined) {
            return toDisplayScalar(structured[key]);
        }
        if (structured.details !== undefined && key === 'content') {
            return toDisplayScalar(structured.details);
        }
        return String(node.content || '');
    }
    if (key === 'last_update_turn') {
        return String(node.toTurn ?? node.turnIndex ?? '');
    }
    if (structured[key] !== undefined) {
        return toDisplayScalar(structured[key]);
    }
    const parsedContent = tryParseJsonObject(node?.content);
    const parsedSummary = tryParseJsonObject(node?.summary);
    const deepHit = findValueByKeyDeep(node?.metadata, key)
        ?? findValueByKeyDeep(parsedContent, key)
        ?? findValueByKeyDeep(parsedSummary, key);
    if (deepHit !== undefined) {
        return toDisplayScalar(deepHit);
    }
    return String(node?.metadata?.[key] ?? '');
}

function getRecallBucketKey(node) {
    if (!node) {
        return 'unknown';
    }
    if (node.level === LEVEL.SEMANTIC) {
        return `semantic:${String(node.type || 'semantic').trim().toLowerCase()}`;
    }
    return `timeline:${String(node.level || 'unknown').trim().toLowerCase()}`;
}

function applySelectionCapWithCoverage(nodes, maxSelection) {
    const limit = Math.max(0, Number(maxSelection || 0));
    if (limit <= 0) {
        return {
            selected: Array.isArray(nodes) ? nodes.slice() : [],
            dropped: [],
        };
    }
    if (!Array.isArray(nodes) || nodes.length <= limit) {
        return {
            selected: Array.isArray(nodes) ? nodes.slice() : [],
            dropped: [],
        };
    }

    const selected = [];
    const dropped = [];
    const usedIds = new Set();
    const coveredBuckets = new Set();

    for (const node of nodes) {
        if (!node?.id || usedIds.has(node.id)) {
            continue;
        }
        const bucket = getRecallBucketKey(node);
        if (coveredBuckets.has(bucket)) {
            continue;
        }
        selected.push(node);
        usedIds.add(node.id);
        coveredBuckets.add(bucket);
        if (selected.length >= limit) {
            break;
        }
    }

    if (selected.length < limit) {
        for (const node of nodes) {
            if (!node?.id || usedIds.has(node.id)) {
                continue;
            }
            selected.push(node);
            usedIds.add(node.id);
            if (selected.length >= limit) {
                break;
            }
        }
    }

    for (const node of nodes) {
        if (!node?.id || usedIds.has(node.id)) {
            continue;
        }
        dropped.push(node);
    }

    return { selected, dropped };
}

function buildFocusTablesText(nodes, settings) {
    const byBucket = new Map();
    const schemaMap = getNodeTypeSchemaMap(settings);
    for (const node of nodes) {
        if (!node) {
            continue;
        }
        if (node.level === LEVEL.TURN) {
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
        let headers = ['title', 'type', 'turn_range', 'summary'];
        let rows = bucketNodes.map(node => [
            String(node.title || ''),
            String(node.type || ''),
            getNodeTurnRange(node),
            normalizeText(node.summary || ''),
        ]);
        let bucketTitle = `Focus ${bucket}`;

        if (bucket.startsWith('semantic:')) {
            const semanticType = String(bucket.slice('semantic:'.length) || '').trim().toLowerCase();
            const spec = schemaMap.get(semanticType);
            const columns = Array.isArray(spec?.tableColumns) ? spec.tableColumns : [];
            if (columns.length > 0) {
                headers = columns;
                rows = bucketNodes.map(node => columns.map(column => getTableCellValueFromNode(node, column)));
            }
            bucketTitle = `Focus ${spec?.tableName || semanticType || bucket}`;
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
    return `Luker Memory ${suffix}`.replace(/[^a-z0-9 _\-]/gi, '_').slice(0, 64);
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
        ['GLOBAL_SPINE', String(blocks.globalSpine || '').trim()],
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
        return { selectedNodes: [], trace: [], query: '' };
    }

    const queryBundle = getRecallQueryBundle(payload, context);
    const query = normalizeText(queryBundle.fullText || '');
    const rootCandidates = collectRootCandidates(store, settings, queryBundle);
    const maxIterations = Math.max(2, Math.min(6, Number(settings.recallMaxIterations || 3)));
    const trace = [];
    const alwaysInjectNodes = collectAlwaysInjectNodes(store, settings);
    const alwaysInjectIds = alwaysInjectNodes.map(node => String(node?.id || '')).filter(Boolean);
    const alwaysInjectSet = new Set(alwaysInjectIds);

    const route = await chooseRecallRoute(context, settings, {
        store,
        query,
        queryBundle,
        candidates: rootCandidates,
        alwaysInjectIds,
    });
    trace.push({
        step: 'plan_pass_1',
        route,
        root_candidates: rootCandidates.map(node => node.id),
    });
    if (Array.isArray(route?.referenced_always_inject_ids) && route.referenced_always_inject_ids.length > 0) {
        trace.push({
            step: 'plan_referenced_always_inject',
            node_ids: route.referenced_always_inject_ids,
        });
    }

    let selectedIds = [];
    if (route.action === 'finalize' && Array.isArray(route.selected_node_ids) && route.selected_node_ids.length > 0) {
        selectedIds = route.selected_node_ids;
    }

    let expandedCandidates = rootCandidates.slice();
    if (selectedIds.length === 0 && route.action === 'drill' && maxIterations >= 2) {
        expandedCandidates = expandRouteCandidates(store, route, rootCandidates, settings);
        trace.push({
            step: 'expand_from_plan',
            expanded_candidates: expandedCandidates.map(node => node.id),
        });
        const selectedRaw = await chooseFocusNodes(context, settings, {
            store,
            query,
            queryBundle,
            route,
            candidates: expandedCandidates,
            alwaysInjectIds,
        });
        selectedIds = Array.isArray(selectedRaw.selected_node_ids) ? selectedRaw.selected_node_ids : [];
        trace.push({
            step: 'finalize_pass_2',
            selected_ids: selectedIds,
            reason: selectedRaw.reason || '',
        });
    }

    if (selectedIds.length === 0) {
        const selectedRaw = await chooseFocusNodes(context, settings, {
            store,
            query,
            queryBundle,
            route,
            candidates: expandedCandidates,
            alwaysInjectIds,
        });
        selectedIds = Array.isArray(selectedRaw.selected_node_ids) ? selectedRaw.selected_node_ids : [];
        trace.push({
            step: 'finalize_fallback',
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
    const selectionCap = getRecallSelectionLimit(settings);
    const cappedSelection = applySelectionCapWithCoverage(dedupedSelectedNodes, selectionCap);
    const selectedNodes = cappedSelection.selected;
    if (cappedSelection.dropped.length > 0) {
        trace.push({
            step: 'selection_cap_applied',
            cap: selectionCap,
            selected_node_ids: selectedNodes.map(node => node.id),
            dropped_node_ids: cappedSelection.dropped.map(node => node.id),
        });
    }
    const mergedNodes = [];
    const seenNodeIds = new Set();
    for (const node of [...selectedNodes, ...alwaysInjectNodes]) {
        if (!node?.id || seenNodeIds.has(node.id)) {
            continue;
        }
        seenNodeIds.add(node.id);
        mergedNodes.push(node);
    }
    if (alwaysInjectNodes.length > 0) {
        trace.push({
            step: 'always_inject',
            node_ids: alwaysInjectNodes.map(node => node.id),
        });
    }

    const latestTurnIndex = getLatestTurnIndex(store);
    const excludeTurns = Math.max(0, Number(settings.recentRawTurns || 5));
    const excludedNodeIds = [];
    const filteredNodes = mergedNodes.filter((node) => {
        const excluded = isNodeInRecentExcludeWindow(node, latestTurnIndex, excludeTurns);
        if (excluded && node?.id) {
            excludedNodeIds.push(node.id);
        }
        return !excluded;
    });
    if (excludeTurns > 0 && excludedNodeIds.length > 0) {
        trace.push({
            step: 'exclude_recent_window',
            exclude_turns: excludeTurns,
            latest_turn: latestTurnIndex,
            excluded_node_ids: excludedNodeIds,
        });
    }

    return {
        selectedNodes: filteredNodes,
        query,
        trace,
    };
}

async function rebuildStoreFromCurrentChat(context) {
    const settings = getSettings();
    const chatKey = getChatKey(context);
    const target = memoryStoreTargets.get(chatKey) || buildMemoryTargetFromContext(context);
    if (!target) {
        return null;
    }

    const rebuilt = createEmptyStore();
    for (const message of getPlayableChatMessages(context)) {
        ingestTurnNode(rebuilt, message);
    }
    updateStoreSourceState(rebuilt, context);
    if (rebuilt.turnOrder.length > 0) {
        rebuilt.turnsSinceUpdate = Math.max(Number(settings.updateEvery || 6), Number(rebuilt.turnsSinceUpdate || 0));
        await runExtractionForStore(context, rebuilt);
    }
    rebuilt.updatedAt = Date.now();
    memoryStoreTargets.set(chatKey, target);
    memoryStoreCache.set(chatKey, rebuilt);
    await persistMemoryStoreByChatKey(context, chatKey, rebuilt);
    return rebuilt;
}

async function ensureStoreSyncedWithChat(context, { force = false } = {}) {
    const loaded = await ensureMemoryStoreLoaded(context);
    const store = getMemoryStore(context) || loaded || null;
    if (!store) {
        return null;
    }
    const target = buildMemoryTargetFromContext(context);
    if (!target) {
        return store;
    }
    if (!force && !hasStoreSourceMismatch(store, context)) {
        return store;
    }
    return await rebuildStoreFromCurrentChat(context);
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

    const store = await ensureStoreSyncedWithChat(context);
    if (!store) {
        updateUiStatus(i18n('Memory store unavailable for current chat.'));
        return false;
    }

    const { selectedNodes, trace, query } = await runLLMDrivenRecall(context, store, payload);
    store.lastRecallTrace = trace;
    store.updatedAt = Date.now();

    const blocks = {
        globalSpine: buildGlobalSpineText(store, settings),
        focusPacket: buildFocusTablesText(selectedNodes, settings),
    };
    await syncLorebookProjection(context, settings, blocks);
    store.lastRecallProjection = {
        at: Date.now(),
        blocks,
    };
    const chatKey = getChatKey(context, { allowFallback: true });
    await persistMemoryStoreByChatKey(context, chatKey, store);
    updateUiStatus(i18nFormat('Recall ready. query="${0}" selected=${1}', query.slice(0, 90), selectedNodes.length));
    return true;
}

async function safeInjectMemoryPrompts(context, payload, trigger = 'before_world_info_scan') {
    try {
        const injected = await injectMemoryPrompts(context, payload);
        if (injected && payload && typeof payload === 'object') {
            payload.__lukerRpgMemoryInjected = true;
        }
        return Boolean(injected);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Recall injection failed during ${trigger}`, error);
        updateUiStatus(i18nFormat(
            'Recall injection failed (${0}): ${1}',
            trigger,
            String(error?.message || error).slice(0, 180),
        ));
        return false;
    }
}

async function captureMessage(messageId) {
    const context = getContext();
    const settings = getSettings();
    if (!settings.enabled) {
        return;
    }

    const index = Number(messageId);
    if (!Number.isInteger(index) || index < 0 || index >= context.chat.length) {
        return;
    }

    const message = context.chat[index];
    if (!message || message.is_system) {
        return;
    }

    await ensureMemoryStoreLoaded(context);
    const store = getMemoryStore(context);
    if (!store) {
        return;
    }
    ingestTurnNode(store, {
        is_user: Boolean(message.is_user),
        name: String(message.name || ''),
        mes: String(message.mes || ''),
        send_date: String(message.send_date || ''),
    });
    updateStoreSourceState(store, context);

    scheduleExtraction(context);
}

function scheduleExtraction(context) {
    const chatKey = getChatKey(context);
    if (extractionTimers.has(chatKey)) {
        return;
    }

    const timer = setTimeout(async () => {
        extractionTimers.delete(chatKey);
        const store = memoryStoreCache.get(chatKey);
        if (!store) {
            return;
        }
        await runExtractionForStore(context, store);
        store.updatedAt = Date.now();
        await persistMemoryStoreByChatKey(context, chatKey, store);
        refreshUiStats();
    }, 0);

    extractionTimers.set(chatKey, timer);
}

function getStoreStats(store) {
    const nodes = Object.values(store.nodes || {});
    const levelCount = {
        canon: nodes.filter(n => n.level === LEVEL.CANON).length,
        rollup: nodes.filter(n => n.level === LEVEL.ROLLUP).length,
        arc: nodes.filter(n => n.level === LEVEL.ARC).length,
        episode: nodes.filter(n => n.level === LEVEL.EPISODE).length,
        turn: nodes.filter(n => n.level === LEVEL.TURN).length,
        semantic: nodes.filter(n => n.level === LEVEL.SEMANTIC).length,
    };

    return {
        nodeCount: nodes.length,
        edgeCount: Array.isArray(store.edges) ? store.edges.length : 0,
        turnCount: store.turnOrder?.length || 0,
        sourceMessageCount: Number(store.sourceMessageCount || 0),
        levelCount,
        lastRecallSteps: Array.isArray(store.lastRecallTrace) ? store.lastRecallTrace.length : 0,
        layerSnapshots: Array.isArray(store.layerSnapshots) ? store.layerSnapshots.length : 0,
    };
}

function renderGraphInspectorHtml(store) {
    const stats = getStoreStats(store);
    const nodes = Object.values(store.nodes || {})
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
        .slice(-220);
    const edges = Array.isArray(store.edges)
        ? store.edges
            .map((edge, index) => ({ ...edge, _index: index }))
            .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
            .slice(0, 160)
        : [];

    const rows = nodes.map(node => `
<tr>
<td>${node.id}</td>
<td>${node.level}</td>
<td>${node.type}</td>
<td>${String(node.title || '').replace(/</g, '&lt;')}</td>
<td>${String(node.summary || '').slice(0, 120).replace(/</g, '&lt;')}</td>
<td>${Array.isArray(node.childrenIds) ? node.childrenIds.length : 0}</td>
<td>${node.fromTurn ?? ''}~${node.toTurn ?? node.turnIndex ?? ''}</td>
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
    <div>${escapeHtml(i18nFormat('Nodes: ${0} | Edges: ${1} | Turns: ${2} | Source messages: ${3}', stats.nodeCount, stats.edgeCount, stats.turnCount, stats.sourceMessageCount))}</div>
    <div>${escapeHtml(i18nFormat('canon=${0}, rollup=${1}, arc=${2}, episode=${3}, turn=${4}, semantic=${5}', stats.levelCount.canon, stats.levelCount.rollup, stats.levelCount.arc, stats.levelCount.episode, stats.levelCount.turn, stats.levelCount.semantic))}</div>
    <div>${escapeHtml(i18nFormat('Last recall steps: ${0} | Layer snapshots: ${1}', stats.lastRecallSteps, stats.layerSnapshots))}</div>
    <div class="luker-rpg-memory-graph-canvas-wrap">
        <div class="luker-rpg-memory-graph-cy"></div>
    </div>
    <small class="luker-rpg-memory-graph-selection">${escapeHtml(i18n('Visual graph ready. Click an edge to select it for editing.'))}</small>
    <div class="flex-container luker-rpg-memory-graph-toolbar">
        <div class="menu_button luker-rpg-memory-graph-fit">${escapeHtml(i18n('Fit View'))}</div>
        <div class="menu_button luker-rpg-memory-graph-relayout">${escapeHtml(i18n('Re-layout'))}</div>
        <div class="menu_button luker-rpg-memory-edge-add">${escapeHtml(i18n('Add Edge'))}</div>
        <div class="menu_button luker-rpg-memory-edge-edit">${escapeHtml(i18n('Edit Selected Edge'))}</div>
        <div class="menu_button luker-rpg-memory-edge-delete">${escapeHtml(i18n('Delete Selected Edge'))}</div>
        <div class="menu_button luker-rpg-memory-graph-raw-view">${escapeHtml(i18n('Advanced JSON View'))}</div>
        <div class="menu_button luker-rpg-memory-graph-raw-edit">${escapeHtml(i18n('Advanced JSON Edit'))}</div>
    </div>
    <div class="luker-rpg-memory-graph-table-wrap">
    <table class="table" style="font-size:12px; margin-top:8px;">
        <thead><tr><th>${escapeHtml(i18n('ID'))}</th><th>${escapeHtml(i18n('Level'))}</th><th>${escapeHtml(i18n('Type'))}</th><th>${escapeHtml(i18n('Title'))}</th><th>${escapeHtml(i18n('Summary'))}</th><th>${escapeHtml(i18n('Children'))}</th><th>${escapeHtml(i18n('TurnRange'))}</th><th>${escapeHtml(i18n('Actions'))}</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>
    </div>
    <h4 class="margin0" style="margin-top:10px;">${escapeHtml(i18n('Recent Edges'))}</h4>
    <div class="luker-rpg-memory-graph-table-wrap">
    <table class="table" style="font-size:12px; margin-top:6px;">
        <thead><tr><th>${escapeHtml(i18n('From'))}</th><th>${escapeHtml(i18n('To'))}</th><th>${escapeHtml(i18n('Type'))}</th><th>${escapeHtml(i18n('Updated'))}</th><th>${escapeHtml(i18n('Actions'))}</th></tr></thead>
        <tbody>${edges.map(edge => `<tr><td>${escapeHtml(String(edge.from || ''))}</td><td>${escapeHtml(String(edge.to || ''))}</td><td>${escapeHtml(String(edge.type || ''))}</td><td>${Number(edge.updatedAt || 0)}</td><td><div class="menu_button menu_button_small luker-rpg-memory-edge-edit-row" data-edge-index="${Number(edge._index)}">${escapeHtml(i18n('Edit'))}</div></td></tr>`).join('')}</tbody>
    </table>
    </div>
    <h4 class="margin0" style="margin-top:10px;">${escapeHtml(i18n('Last Projection'))}</h4>
    <pre style="white-space:pre-wrap; max-height:260px; overflow:auto;">${JSON.stringify(store.lastRecallProjection || {}, null, 2).replace(/</g, '&lt;')}</pre>
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

function encodeMetadataAsLines(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return '';
    }
    return Object.entries(metadata)
        .map(([key, value]) => {
            let encoded = value;
            if (value && typeof value === 'object') {
                encoded = JSON.stringify(value);
            }
            return `${key}=${String(encoded ?? '')}`;
        })
        .join('\n');
}

function decodeMetadataFromLines(text) {
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
                // fallback to scalar parsing below
            }
        }
        out[key] = parseLooseScalar(valueRaw);
    }
    return out;
}

function getNodeTypeOptionsHtml(settings, store, currentType = '') {
    const candidates = new Set(['canon', 'rollup_root', 'arc', 'episode', 'turn']);
    for (const entry of normalizeNodeTypeSchema(settings.nodeTypeSchema)) {
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
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    for (const node of nodes) {
        const id = String(node.id || '');
        const title = String(node.title || '').trim();
        const label = `${id} | ${node.level}/${node.type} | ${title.slice(0, 52)}`;
        options.push(`<option value="${escapeHtml(id)}"${id === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`);
    }
    if (selected && !nodes.find(node => String(node.id || '') === selected)) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }
    return options.join('');
}

function renderNodeFormEditorHtml(node, store, settings, editorId) {
    const levelOptions = [
        LEVEL.CANON,
        LEVEL.ROLLUP,
        LEVEL.ARC,
        LEVEL.EPISODE,
        LEVEL.TURN,
        LEVEL.SEMANTIC,
    ].map(level => `<option value="${level}"${String(node.level || '') === level ? ' selected' : ''}>${level}</option>`).join('');

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
        <label>${escapeHtml(i18n('Turn Index'))}
            <input data-field="turnIndex" class="text_pole" type="number" step="1" value="${escapeHtml(node.turnIndex ?? '')}" />
        </label>
        <label>${escapeHtml(i18n('From Turn'))}
            <input data-field="fromTurn" class="text_pole" type="number" step="1" value="${escapeHtml(node.fromTurn ?? '')}" />
        </label>
        <label>${escapeHtml(i18n('To Turn'))}
            <input data-field="toTurn" class="text_pole" type="number" step="1" value="${escapeHtml(node.toTurn ?? '')}" />
        </label>
        <label>${escapeHtml(i18n('Count'))}
            <input data-field="count" class="text_pole" type="number" min="1" step="1" value="${escapeHtml(node.count ?? 1)}" />
        </label>
    </div>
    <div class="luker-rpg-memory-node-form-flags">
        <label class="checkbox_label"><input data-field="finalized" type="checkbox" ${node.finalized ? 'checked' : ''} /> ${escapeHtml(i18n('Finalized'))}</label>
        <label class="checkbox_label"><input data-field="archived" type="checkbox" ${node.archived ? 'checked' : ''} /> ${escapeHtml(i18n('Archived'))}</label>
    </div>
    <label>${escapeHtml(i18n('Title'))}
        <input data-field="title" class="text_pole" type="text" value="${escapeHtml(node.title || '')}" />
    </label>
    <label>${escapeHtml(i18n('Summary'))}
        <textarea data-field="summary" class="text_pole textarea_compact" rows="3">${escapeHtml(node.summary || '')}</textarea>
    </label>
    <label>${escapeHtml(i18n('Content'))}
        <textarea data-field="content" class="text_pole textarea_compact" rows="7">${escapeHtml(node.content || '')}</textarea>
    </label>
    <label>${escapeHtml(i18n('Links (comma separated node ids)'))}
        <input data-field="links" class="text_pole" type="text" value="${escapeHtml(joinCommaList(node.links || []))}" />
    </label>
    <label>${escapeHtml(i18n('Metadata (one key=value per line)'))}
        <textarea data-field="metadataLines" class="text_pole textarea_compact" rows="6">${escapeHtml(encodeMetadataAsLines(node.metadata || {}))}</textarea>
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
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    const maxVisualNodes = 450;
    const scopedNodes = sortedNodes.slice(-maxVisualNodes);
    const scopedNodeIds = new Set(scopedNodes.map(node => String(node.id || '')));
    for (const rootId of [store.canonId, store.rollupRootId, store.activeArcId, store.activeEpisodeId]) {
        const id = String(rootId || '').trim();
        if (id && store.nodes[id]) {
            scopedNodeIds.add(id);
        }
    }

    const levelOrderMap = {
        [LEVEL.CANON]: 0,
        [LEVEL.ROLLUP]: 1,
        [LEVEL.ARC]: 2,
        [LEVEL.EPISODE]: 3,
        [LEVEL.SEMANTIC]: 4,
        [LEVEL.TURN]: 5,
    };
    const scopedNodeList = [...scopedNodeIds]
        .map(id => store.nodes[id])
        .filter(Boolean);
    const nodesByLevel = new Map();
    for (const node of scopedNodeList) {
        const level = String(node.level || LEVEL.SEMANTIC);
        if (!nodesByLevel.has(level)) {
            nodesByLevel.set(level, []);
        }
        nodesByLevel.get(level).push(node);
    }

    const sortedLevels = [...nodesByLevel.keys()].sort((a, b) => {
        const av = Number.isFinite(levelOrderMap[a]) ? levelOrderMap[a] : 99;
        const bv = Number.isFinite(levelOrderMap[b]) ? levelOrderMap[b] : 99;
        if (av !== bv) {
            return av - bv;
        }
        return a.localeCompare(b);
    });
    const colGap = 260;
    const rowGap = 108;
    const centerCol = (sortedLevels.length - 1) / 2;
    const positionByNodeId = new Map();
    for (let colIndex = 0; colIndex < sortedLevels.length; colIndex++) {
        const level = sortedLevels[colIndex];
        const levelNodes = (nodesByLevel.get(level) || [])
            .slice()
            .sort((a, b) => {
                const at = Number(a.toTurn ?? a.fromTurn ?? a.turnIndex ?? a.createdAt ?? 0);
                const bt = Number(b.toTurn ?? b.fromTurn ?? b.turnIndex ?? b.createdAt ?? 0);
                if (at !== bt) {
                    return at - bt;
                }
                return String(a.id || '').localeCompare(String(b.id || ''));
            });
        const centerRow = (levelNodes.length - 1) / 2;
        for (let rowIndex = 0; rowIndex < levelNodes.length; rowIndex++) {
            const node = levelNodes[rowIndex];
            let hash = 0;
            const idText = String(node.id || '');
            for (let i = 0; i < idText.length; i++) {
                hash = ((hash * 31) + idText.charCodeAt(i)) >>> 0;
            }
            const jitterX = ((hash % 13) - 6) * 2;
            const jitterY = (((hash >> 3) % 13) - 6) * 2;
            positionByNodeId.set(String(node.id), {
                x: ((colIndex - centerCol) * colGap) + jitterX,
                y: ((rowIndex - centerRow) * rowGap) + jitterY,
            });
        }
    }

    const nodes = scopedNodeList
        .map(node => ({
            data: {
                id: `node:${node.id}`,
                nodeId: String(node.id),
                label: `${String(node.title || node.id).slice(0, 36)}${String(node.title || '').length > 36 ? '…' : ''}\n${String(node.level || '')}/${String(node.type || '')}`,
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
        .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    for (const node of nodes) {
        const id = String(node.id || '');
        if (!id) {
            continue;
        }
        const label = `${id} | ${node.level}/${node.type} | ${(node.title || '').slice(0, 48)}`;
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
    let runLayout = null;
    let mountRetryTimer = null;

    const popupPromise = context.callGenericPopup(
        popupHtml,
        context.POPUP_TYPE.TEXT,
        '',
        { wide: true, large: true, allowVerticalScrolling: true },
    );

    const getStore = () => memoryStoreCache.get(chatKey) || store;
    const getPopupRoot = () => jQuery(selector);
    const getDefaultSelectionText = () => i18n('Visual graph ready. Click an edge to select it for editing.');
    const updateSelectionText = (text = '') => {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        popupRoot.find('.luker-rpg-memory-graph-selection').text(String(text || getDefaultSelectionText()));
    };
    const persistLatest = async (latest, successText, statusText) => {
        latest.updatedAt = Date.now();
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
                            'font-size': 10,
                            'text-wrap': 'wrap',
                            'text-max-width': 180,
                            'text-valign': 'center',
                            'text-halign': 'center',
                            color: '#f5f5f5',
                            'text-outline-width': 2,
                            'text-outline-color': '#1a1a1a',
                            'background-color': '#4f7ba7',
                            shape: 'round-rectangle',
                            width: 'label',
                            height: 'label',
                            padding: '12px',
                        },
                    },
                    { selector: 'node[level = "canon"]', style: { 'background-color': '#c77d2f' } },
                    { selector: 'node[level = "rollup"]', style: { 'background-color': '#8a5db4' } },
                    { selector: 'node[level = "arc"]', style: { 'background-color': '#3c9b7b' } },
                    { selector: 'node[level = "episode"]', style: { 'background-color': '#2f8aa6' } },
                    { selector: 'node[level = "turn"]', style: { 'background-color': '#626b7b', 'font-size': 9 } },
                    { selector: 'node[archived = true]', style: { opacity: 0.45 } },
                    {
                        selector: 'edge',
                        style: {
                            label: '',
                            'font-size': 9,
                            'curve-style': 'bezier',
                            'target-arrow-shape': 'triangle',
                            'target-arrow-color': '#8e95a0',
                            'line-color': '#8e95a0',
                            width: 2,
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
                cy.resize();
                cy.fit(cy.elements(), 64);
                cy.center();
            };
            runLayout();
            setTimeout(() => {
                if (!cy) {
                    return;
                }
                cy.resize();
                cy.fit(cy.elements(), 64);
            }, 0);
            setTimeout(() => {
                if (!cy) {
                    return;
                }
                cy.resize();
                cy.fit(cy.elements(), 64);
            }, 60);
            setTimeout(() => {
                if (!cy) {
                    return;
                }
                cy.resize();
                cy.fit(cy.elements(), 64);
            }, 220);

            cy.on('tap', 'node', (event) => {
                const nodeId = String(event.target.data('nodeId') || '');
                updateSelectionText(i18nFormat('Selected node: ${0}. Tip: click an edge to edit relation.', nodeId));
            });
            cy.on('tap', 'edge', (event) => {
                const edgeIndex = Number(event.target.data('edgeIndex'));
                if (!Number.isInteger(edgeIndex) || edgeIndex < 0) {
                    return;
                }
                selectedEdgeIndex = edgeIndex;
                const edge = latest.edges?.[edgeIndex];
                if (!edge) {
                    updateSelectionText(i18nFormat('Selected edge index ${0} (missing).', edgeIndex));
                    return;
                }
                updateSelectionText(i18nFormat(
                    'Selected edge #${0}: ${1} -> ${2} [${3}]',
                    edgeIndex,
                    edge.from,
                    edge.to,
                    edge.type,
                ));
            });
            cy.on('tap', (event) => {
                if (event.target !== cy) {
                    return;
                }
                selectedEdgeIndex = -1;
                updateSelectionText('');
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
        await mountGraphWithRetry();
        if (selectedEdgeIndex >= 0 && latest.edges?.[selectedEdgeIndex]) {
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
                large: false,
                allowVerticalScrolling: true,
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
                updatedAt: Date.now(),
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

    jQuery(document).off(namespace);
    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-node-view`, async function () {
        const nodeId = String(jQuery(this).data('node-id') || '').trim();
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
        const latest = getStore();
        const node = latest?.nodes?.[nodeId];
        if (!node) {
            notifyError(i18nFormat('Node not found: ${0}', nodeId));
            return;
        }

        const editorId = `luker_rpg_memory_node_editor_${Date.now()}`;
        const editorHtml = renderNodeFormEditorHtml(node, latest, getSettings(), editorId);

        const result = await context.callGenericPopup(
            editorHtml,
            context.POPUP_TYPE.CONFIRM,
            '',
            { okButton: i18n('Apply Node'), cancelButton: i18n('Cancel'), wide: true, large: true, allowVerticalScrolling: true },
        );
        if (result !== context.POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        try {
            const editorRoot = jQuery(`#${editorId}`);
            if (!editorRoot.length) {
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
            const now = Date.now();

            target.type = String(editorRoot.find('[data-field="type"]').val() || target.type || 'unknown').trim() || 'unknown';
            target.level = String(editorRoot.find('[data-field="level"]').val() || target.level || LEVEL.SEMANTIC).trim() || LEVEL.SEMANTIC;
            target.title = normalizeText(editorRoot.find('[data-field="title"]').val() || target.title || nodeId);
            target.summary = normalizeText(editorRoot.find('[data-field="summary"]').val() || '');
            target.content = normalizeText(editorRoot.find('[data-field="content"]').val() || '');
            target.turnIndex = parseOptionalNumber(editorRoot.find('[data-field="turnIndex"]').val());
            target.fromTurn = parseOptionalNumber(editorRoot.find('[data-field="fromTurn"]').val());
            target.toTurn = parseOptionalNumber(editorRoot.find('[data-field="toTurn"]').val());
            target.count = Math.max(1, Number(editorRoot.find('[data-field="count"]').val()) || Number(target.count || 1));
            target.finalized = Boolean(editorRoot.find('[data-field="finalized"]').prop('checked'));
            target.archived = Boolean(editorRoot.find('[data-field="archived"]').prop('checked'));
            target.links = splitCommaList(editorRoot.find('[data-field="links"]').val());
            target.metadata = decodeMetadataFromLines(editorRoot.find('[data-field="metadataLines"]').val());

            if (parsedParentId !== oldParentId) {
                if (oldParentId && latest.nodes[oldParentId]) {
                    const oldParent = latest.nodes[oldParentId];
                    oldParent.childrenIds = (oldParent.childrenIds || []).filter(id => id !== nodeId);
                    oldParent.updatedAt = now;
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

            target.updatedAt = now;
            latest.updatedAt = now;
            memoryStoreCache.set(chatKey, latest);
            await persistMemoryStoreByChatKey(context, chatKey, latest);
            refreshUiStats();
            updateUiStatus(i18nFormat('Updated node ${0}.', nodeId));
            notifySuccess(i18nFormat('Node updated: ${0}', nodeId));
            await rerender();
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
        cy.resize();
        cy.fit(cy.elements(), 64);
        cy.center();
        updateSelectionText(i18n('Fitted graph view.'));
    });

    jQuery(document).on(`click${namespace}`, `${selector} .luker-rpg-memory-graph-relayout`, function () {
        if (!runLayout) {
            return;
        }
        runLayout();
        updateSelectionText(i18n('Graph re-layout completed.'));
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
        await openEdgeEditor(edgeIndex);
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
            const migrated = migrateLegacyStoreIfNeeded(parsed);
            updateStoreSourceState(migrated, context);
            migrated.updatedAt = Date.now();
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

function updateUiStatus(text) {
    jQuery('#luker_rpg_memory_status').text(String(text || ''));
}

function refreshUiStats() {
    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    const context = getContext();
    const chatKey = getChatKey(context, { allowFallback: true });
    const store = memoryStoreCache.get(chatKey) || createEmptyStore();
    const stats = getStoreStats(store);

    root.find('#luker_rpg_memory_stats').text(
        i18nFormat(
            'nodes=${0}, edges=${1}, turns=${2}, source=${3}, canon=${4}, rollup=${5}, arc=${6}, episode=${7}, semantic=${8}, snapshots=${9}',
            stats.nodeCount,
            stats.edgeCount,
            stats.turnCount,
            stats.sourceMessageCount,
            stats.levelCount.canon,
            stats.levelCount.rollup,
            stats.levelCount.arc,
            stats.levelCount.episode,
            stats.levelCount.semantic,
            stats.layerSnapshots,
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

function getSchemaTypeTemplate(index = 1) {
    return {
        id: `custom_${index}`,
        label: `Custom Type ${index}`,
        tableName: `custom_table_${index}`,
        tableColumns: ['title', 'summary', 'content'],
        level: LEVEL.SEMANTIC,
        extractHint: '',
        keywords: [],
        alwaysInject: false,
        compression: {
            mode: 'none',
            threshold: 6,
            fanIn: 3,
            maxDepth: 6,
            keepRecentLeaves: 0,
            keepLatest: 1,
            summarizeInstruction: '',
        },
    };
}

function ensureStyles() {
    if (jQuery(`#${STYLE_ID}`).length) {
        return;
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
    gap: 10px;
    min-width: min(1120px, 92vw);
}

.luker-rpg-schema-popup .luker-schema-topbar {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
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
    max-height: 65vh;
    overflow-y: auto;
    padding-right: 4px;
    gap: 10px;
}

.luker-rpg-schema-popup .luker-schema-card {
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

.luker-rpg-schema-popup .luker-schema-card.mode-latest_only {
    border-left-color: rgba(77, 144, 226, 0.9);
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

.luker-rpg-schema-popup .luker-schema-card label {
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.luker-rpg-schema-popup .luker-schema-checkbox {
    justify-content: flex-end;
}

.luker-rpg-schema-popup .luker-schema-checkbox input[type="checkbox"] {
    margin-top: 8px;
    align-self: flex-start;
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
    border-top: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    padding-top: 8px;
}

.luker-rpg-schema-popup .luker-schema-footer-note {
    opacity: 0.76;
    font-size: 0.86em;
}

.luker-rpg-memory-graph-popup {
    min-width: min(1300px, 94vw);
}

.luker-rpg-memory-graph-popup-inner {
    gap: 8px;
    align-items: stretch;
    text-align: left;
}

.luker-rpg-memory-graph-toolbar {
    gap: 8px;
    margin-top: 6px;
    flex-wrap: wrap;
}

.luker-rpg-memory-graph-canvas-wrap {
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

.luker-rpg-memory-graph-table-wrap {
    max-height: 38vh;
    overflow: auto;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.32));
    border-radius: 8px;
    padding: 4px;
    background: rgba(0, 0, 0, 0.08);
}

.luker-rpg-memory-node-form {
    gap: 8px;
    min-width: min(980px, 92vw);
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
</style>`);
}

function renderNodeTypeSchemaCard(spec, index) {
    const mode = String(spec?.compression?.mode || 'none');
    const threshold = Number(spec?.compression?.threshold || 6);
    const fanIn = Number(spec?.compression?.fanIn || 3);
    const maxDepth = Number(spec?.compression?.maxDepth || 6);
    const keepRecentLeaves = Number(spec?.compression?.keepRecentLeaves || 0);
    const keepLatest = Number(spec?.compression?.keepLatest || 1);
    const summarizeInstruction = String(spec?.compression?.summarizeInstruction || '');
    const cardTitle = String(spec?.label || `Type ${index + 1}`).trim();
    const tableName = String(spec?.tableName || spec?.id || '').trim();
    const cardClass = `mode-${mode}${spec.alwaysInject ? ' is-always' : ''}`;
    return `
<div class="luker-schema-card flex-container flexFlowColumn ${cardClass}" data-index="${index}">
    <div class="luker-schema-card-header">
        <div>
            <div class="luker-schema-card-title">${escapeHtml(cardTitle)}</div>
            <div class="luker-schema-card-sub">${escapeHtml(i18nFormat('table: ${0}', tableName || i18n('(unset)')))}</div>
        </div>
        <div class="luker-schema-badges">
            <span class="luker-schema-badge">${escapeHtml(i18nFormat('mode: ${0}', mode))}</span>
            ${spec.alwaysInject ? `<span class="luker-schema-badge">${escapeHtml(i18n('always inject'))}</span>` : ''}
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
        <label class="luker-schema-checkbox">${escapeHtml(i18n('Always Inject'))}
            <input data-field="alwaysInject" type="checkbox" ${spec.alwaysInject ? 'checked' : ''} />
        </label>
    </div>
    <label>${escapeHtml(i18n('Table Columns (comma separated)'))}
        <input data-field="tableColumns" class="text_pole" type="text" value="${escapeHtml(joinCommaList(spec.tableColumns))}" />
    </label>
    <label>${escapeHtml(i18n('Keywords (comma separated)'))}
        <input data-field="keywords" class="text_pole" type="text" value="${escapeHtml(joinCommaList(spec.keywords))}" />
    </label>
    <label>${escapeHtml(i18n('Extract Hint'))}
        <textarea data-field="extractHint" class="text_pole textarea_compact" rows="2">${escapeHtml(spec.extractHint || '')}</textarea>
    </label>
    <div class="luker-schema-grid-2">
        <label>${escapeHtml(i18n('Compression Mode'))}
            <select data-field="compression.mode" class="text_pole">
                <option value="none"${mode === 'none' ? ' selected' : ''}>${escapeHtml(i18n('none'))}</option>
                <option value="latest_only"${mode === 'latest_only' ? ' selected' : ''}>${escapeHtml(i18n('latest_only'))}</option>
                <option value="hierarchical"${mode === 'hierarchical' ? ' selected' : ''}>${escapeHtml(i18n('hierarchical'))}</option>
            </select>
        </label>
        <label class="luker-schema-compression-latest">${escapeHtml(i18n('Keep Latest'))}
            <input data-field="compression.keepLatest" class="text_pole" type="number" min="1" step="1" value="${keepLatest}" />
        </label>
    </div>
    <div class="luker-schema-grid-2 luker-schema-compression-hier">
        <label>${escapeHtml(i18n('Threshold'))}
            <input data-field="compression.threshold" class="text_pole" type="number" min="2" step="1" value="${threshold}" />
        </label>
        <label>${escapeHtml(i18n('Fan-In'))}
            <input data-field="compression.fanIn" class="text_pole" type="number" min="2" step="1" value="${fanIn}" />
        </label>
    </div>
    <div class="luker-schema-grid-2 luker-schema-compression-hier">
        <label>${escapeHtml(i18n('Max Depth'))}
            <input data-field="compression.maxDepth" class="text_pole" type="number" min="1" step="1" value="${maxDepth}" />
        </label>
        <label>${escapeHtml(i18n('Keep Recent Leaves'))}
            <input data-field="compression.keepRecentLeaves" class="text_pole" type="number" min="0" step="1" value="${keepRecentLeaves}" />
        </label>
    </div>
    <label class="luker-schema-compression-hier">${escapeHtml(i18n('Summarize Instruction'))}
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
    const mode = String(root.find('[data-field="compression.mode"]').val() || 'none');
    root.find('.luker-schema-compression-hier').toggle(mode === 'hierarchical');
    root.find('.luker-schema-compression-latest').toggle(mode === 'latest_only');
}

function readSchemaCard(card) {
    const root = jQuery(card);
    return {
        id: String(root.find('[data-field="id"]').val() || '').trim(),
        label: String(root.find('[data-field="label"]').val() || '').trim(),
        tableName: String(root.find('[data-field="tableName"]').val() || '').trim(),
        tableColumns: splitCommaList(root.find('[data-field="tableColumns"]').val()),
        level: LEVEL.SEMANTIC,
        extractHint: String(root.find('[data-field="extractHint"]').val() || '').trim(),
        keywords: splitCommaList(root.find('[data-field="keywords"]').val()),
        alwaysInject: Boolean(root.find('[data-field="alwaysInject"]').prop('checked')),
        compression: {
            mode: String(root.find('[data-field="compression.mode"]').val() || 'none').trim(),
            threshold: Math.max(2, Number(root.find('[data-field="compression.threshold"]').val()) || 6),
            fanIn: Math.max(2, Number(root.find('[data-field="compression.fanIn"]').val()) || 3),
            maxDepth: Math.max(1, Number(root.find('[data-field="compression.maxDepth"]').val()) || 6),
            keepRecentLeaves: Math.max(0, Number(root.find('[data-field="compression.keepRecentLeaves"]').val()) || 0),
            keepLatest: Math.max(1, Number(root.find('[data-field="compression.keepLatest"]').val()) || 1),
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
    list.off('change.lukerSchemaMode').on('change.lukerSchemaMode', '[data-field="compression.mode"]', function () {
        updateSchemaCardModeUi(jQuery(this).closest('.luker-schema-card'));
    });
}

function updateSchemaSummary(root, schema) {
    const normalized = normalizeNodeTypeSchema(schema);
    const total = normalized.length;
    const alwaysInject = normalized.filter(item => item.alwaysInject).length;
    const hierarchical = normalized.filter(item => String(item?.compression?.mode || '') === 'hierarchical').length;
    root.find('#luker_rpg_memory_schema_summary').text(i18nFormat(
        'Types: ${0} | Always Inject: ${1} | Hierarchical: ${2}',
        total,
        alwaysInject,
        hierarchical,
    ));
}

function buildSchemaEditorPopupHtml(popupId, schema) {
    const normalized = normalizeNodeTypeSchema(schema);
    const cardsHtml = normalized.map((spec, index) => renderNodeTypeSchemaCard(spec, index)).join('');
    return `
<div id="${popupId}" class="luker-rpg-schema-popup flex-container flexFlowColumn">
    <div class="luker-schema-topbar">
        <div>
            <div class="luker-schema-topbar-title">${escapeHtml(i18n('Memory Node Schema Editor'))}</div>
            <div class="luker-schema-topbar-note">${escapeHtml(i18n('Define node tables, extraction hints, and compression strategy. This controls what your memory graph stores and how it compacts over time.'))}</div>
        </div>
        <div class="luker-schema-chip-row">
            <span class="luker-schema-chip hier">${escapeHtml(i18n('Hierarchical Compression'))}</span>
            <span class="luker-schema-chip latest">${escapeHtml(i18n('Latest Snapshot'))}</span>
            <span class="luker-schema-chip inject">${escapeHtml(i18n('Always Inject'))}</span>
        </div>
    </div>
    <div class="luker-schema-editor-list flex-container flexFlowColumn">${cardsHtml}</div>
    <div class="luker-schema-footer">
        <div class="luker-schema-footer-note">${escapeHtml(i18nFormat('Current type count: ${0}', normalized.length))}</div>
        <div class="flex-container">
            <div class="menu_button luker-schema-editor-add">${escapeHtml(i18n('Add Type'))}</div>
            <div class="menu_button luker-schema-editor-default">${escapeHtml(i18n('Load Recommended Schema'))}</div>
        </div>
    </div>
</div>`;
}

async function openSchemaEditorPopup(context, settings, root) {
    ensureStyles();
    const popupId = `luker_rpg_memory_schema_popup_${Date.now()}`;
    const popupHtml = buildSchemaEditorPopupHtml(popupId, settings.nodeTypeSchema);
    const namespace = `.lukerSchemaPopup_${popupId}`;
    const selector = `#${popupId}`;
    const listSelector = '.luker-schema-editor-list';

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
        },
    );

    const getPopupRoot = () => jQuery(selector);
    const rerender = (schema) => {
        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        renderNodeTypeSchemaEditor(popupRoot, schema, listSelector);
    };

    jQuery(document).off(namespace);
    jQuery(document).on(`change${namespace}`, `${selector} [data-field="compression.mode"]`, function () {
        updateSchemaCardModeUi(jQuery(this).closest('.luker-schema-card'));
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
    jQuery(document).on(`click${namespace}`, `${selector} .luker-schema-editor-default`, function () {
        rerender(normalizeNodeTypeSchema(structuredClone(defaultNodeTypeSchema)));
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
            clone.id = `${clone.id || 'custom'}_copy_${Date.now().toString().slice(-4)}`;
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

        const popupRoot = getPopupRoot();
        if (!popupRoot.length) {
            return;
        }
        settings.nodeTypeSchema = readNodeTypeSchemaEditor(popupRoot, listSelector);
        saveSettingsDebounced();
        updateSchemaSummary(root, settings.nodeTypeSchema);
        notifySuccess(i18n('Memory schema updated.'));
        updateUiStatus(i18n('Applied memory schema from popup editor.'));
    } finally {
        jQuery(document).off(namespace);
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
    root.find('#luker_rpg_memory_recall_enabled').prop('checked', Boolean(settings.recallEnabled));
    root.find('#luker_rpg_memory_recall_api_preset').val(String(settings.recallApiPresetName || ''));
    root.find('#luker_rpg_memory_recall_preset').val(String(settings.recallPresetName || ''));
    root.find('#luker_rpg_memory_extract_api_preset').val(String(settings.extractApiPresetName || ''));
    root.find('#luker_rpg_memory_extract_preset').val(String(settings.extractPresetName || ''));
    root.find('#luker_rpg_memory_projection_enabled').prop('checked', Boolean(settings.lorebookProjectionEnabled));
    root.find('#luker_rpg_memory_recent_raw_turns').val(String(settings.recentRawTurns || 5));
    root.find('#luker_rpg_memory_recall_iterations').val(String(settings.recallMaxIterations || 3));
    root.find('#luker_rpg_memory_recall_max_selection').val(String(getRecallSelectionLimit(settings)));
    root.find('#luker_rpg_memory_tool_retries').val(String(settings.toolCallRetryMax ?? 2));
    root.find('#luker_rpg_memory_extract_batch_turns').val(String(settings.extractBatchTurns || 12));
    root.find('#luker_rpg_memory_update_every').val(String(settings.updateEvery));
    root.find('#luker_rpg_memory_turns_episode').val(String(settings.turnsPerEpisode));
    root.find('#luker_rpg_memory_episodes_arc').val(String(settings.episodesPerArc));
    root.find('#luker_rpg_memory_arcs_canon').val(String(settings.arcsPerCanon));
    root.find('#luker_rpg_memory_rollup_fanin').val(String(settings.rollupFanIn || 3));
    updateSchemaSummary(root, settings.nodeTypeSchema);
    refreshOpenAIPresetSelectors(root, context, settings);

    ensureMemoryStoreLoaded(context)
        .then(() => refreshUiStats())
        .catch(() => refreshUiStats());

    root.find('#luker_rpg_memory_enabled').off('input').on('input', function () {
        settings.enabled = Boolean(jQuery(this).prop('checked'));
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

    root.find('#luker_rpg_memory_recent_raw_turns').off('change').on('change', function () {
        settings.recentRawTurns = Math.max(0, Number(jQuery(this).val()) || defaultSettings.recentRawTurns);
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_tool_retries').off('change').on('change', function () {
        settings.toolCallRetryMax = Math.max(0, Math.min(10, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });
    root.find('#luker_rpg_memory_recall_max_selection').off('change').on('change', function () {
        const value = Math.max(0, Math.floor(Number(jQuery(this).val()) || 0));
        settings.recallMaxSelection = Number.isFinite(value) ? value : defaultSettings.recallMaxSelection;
        saveSettingsDebounced();
    });

    root.find('#luker_rpg_memory_open_schema_editor').off('click').on('click', async function () {
        await openSchemaEditorPopup(context, settings, root);
    });

    root.find('#luker_rpg_memory_save').off('click').on('click', function () {
        try {
            settings.updateEvery = Math.max(1, Number(root.find('#luker_rpg_memory_update_every').val()) || defaultSettings.updateEvery);
            settings.turnsPerEpisode = Math.max(2, Number(root.find('#luker_rpg_memory_turns_episode').val()) || defaultSettings.turnsPerEpisode);
            settings.episodesPerArc = Math.max(2, Number(root.find('#luker_rpg_memory_episodes_arc').val()) || defaultSettings.episodesPerArc);
            settings.arcsPerCanon = Math.max(1, Number(root.find('#luker_rpg_memory_arcs_canon').val()) || defaultSettings.arcsPerCanon);
            settings.rollupFanIn = Math.max(2, Number(root.find('#luker_rpg_memory_rollup_fanin').val()) || defaultSettings.rollupFanIn);
            settings.recentRawTurns = Math.max(0, Number(root.find('#luker_rpg_memory_recent_raw_turns').val()) || defaultSettings.recentRawTurns);
            settings.recallMaxIterations = Math.max(2, Math.min(6, Number(root.find('#luker_rpg_memory_recall_iterations').val()) || defaultSettings.recallMaxIterations));
            settings.recallMaxSelection = Math.max(0, Math.floor(Number(root.find('#luker_rpg_memory_recall_max_selection').val()) || 0));
            settings.toolCallRetryMax = Math.max(0, Math.min(10, Math.floor(Number(root.find('#luker_rpg_memory_tool_retries').val()) || 0)));
            settings.extractBatchTurns = Math.max(2, Number(root.find('#luker_rpg_memory_extract_batch_turns').val()) || defaultSettings.extractBatchTurns);
            settings.lorebookProjectionEnabled = Boolean(root.find('#luker_rpg_memory_projection_enabled').prop('checked'));
            updateSchemaSummary(root, settings.nodeTypeSchema);

            saveSettingsDebounced();
            notifySuccess(i18n('Memory settings saved.'));
            updateUiStatus(i18n('Saved memory settings.'));
        } catch (error) {
            notifyError(i18nFormat('Invalid schema settings: ${0}', error?.message || error));
            updateUiStatus(i18n('Memory settings save failed.'));
        }
    });

    root.find('#luker_rpg_memory_view_graph').off('click').on('click', async function () {
        await openGraphInspectorPopup(context);
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

        const details = {
            query,
            selected_nodes: result.selectedNodes.map(formatNodeDetail),
            trace: result.trace,
            preview: {
                global_spine: buildGlobalSpineText(store, settings),
                focus_packet: buildFocusTablesText(result.selectedNodes, settings),
            },
        };

        await context.callGenericPopup(
            `<pre style="white-space:pre-wrap;">${JSON.stringify(details, null, 2).replace(/</g, '&lt;')}</pre>`,
            context.POPUP_TYPE.TEXT,
            '',
            { wide: true, large: true, allowVerticalScrolling: true },
        );

        refreshUiStats();
    });

    root.find('#luker_rpg_memory_rebuild').off('click').on('click', async function () {
        const store = await ensureStoreSyncedWithChat(context, { force: true });
        if (!store) {
            notifyError(i18n('No active chat selected.'));
            return;
        }
        await runCompressionLoop(context, store, settings);
        await persistMemoryStoreByChatKey(context, getChatKey(context), store);
        refreshUiStats();
        notifySuccess(i18n('Memory graph rebuilt from current chat.'));
        updateUiStatus(i18n('Rebuilt memory graph and compression from chat.'));
    });

    root.find('#luker_rpg_memory_reset').off('click').on('click', async function () {
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
            const migrated = migrateLegacyStoreIfNeeded(parsed);
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
            <label class="checkbox_label"><input id="luker_rpg_memory_recall_enabled" type="checkbox" /> ${escapeHtml(i18n('Enable recall injection'))}</label>
            <label for="luker_rpg_memory_recall_api_preset">${escapeHtml(i18n('Recall API preset (Connection profile, empty = current)'))}</label>
            <select id="luker_rpg_memory_recall_api_preset" class="text_pole"></select>
            <label for="luker_rpg_memory_recall_preset">${escapeHtml(i18n('Recall preset (params + prompt, empty = current)'))}</label>
            <select id="luker_rpg_memory_recall_preset" class="text_pole"></select>
            <label for="luker_rpg_memory_extract_api_preset">${escapeHtml(i18n('Extract API preset (Connection profile, empty = current)'))}</label>
            <select id="luker_rpg_memory_extract_api_preset" class="text_pole"></select>
            <label for="luker_rpg_memory_extract_preset">${escapeHtml(i18n('Extract preset (params + prompt, empty = current)'))}</label>
            <select id="luker_rpg_memory_extract_preset" class="text_pole"></select>
            <label class="checkbox_label"><input id="luker_rpg_memory_projection_enabled" type="checkbox" /> ${escapeHtml(i18n('Project recall output to chat lorebook before WI scan'))}</label>
            <div class="flex-container">
                <label style="flex:1">${escapeHtml(i18n('Exclude latest N turns from memory injection'))} <input id="luker_rpg_memory_recent_raw_turns" class="text_pole" type="number" min="0" step="1" /></label>
            </div>
            <div class="flex-container">
                <label style="flex:1">${escapeHtml(i18n('Recall max iterations'))} <input id="luker_rpg_memory_recall_iterations" class="text_pole" type="number" min="2" max="6" step="1" /></label>
                <label style="flex:1">${escapeHtml(i18n('Extract batch turns'))} <input id="luker_rpg_memory_extract_batch_turns" class="text_pole" type="number" min="2" step="1" /></label>
            </div>
            <div class="flex-container">
                <label style="flex:1">${escapeHtml(i18n('Recall max selection (0 = unlimited)'))} <input id="luker_rpg_memory_recall_max_selection" class="text_pole" type="number" min="0" step="1" /></label>
            </div>
            <div class="flex-container">
                <label style="flex:1">${escapeHtml(i18n('Tool-call retries'))} <input id="luker_rpg_memory_tool_retries" class="text_pole" type="number" min="0" max="10" step="1" /></label>
            </div>

            <div class="flex-container">
                <label style="flex:1">${escapeHtml(i18n('Update every N messages'))} <input id="luker_rpg_memory_update_every" class="text_pole" type="number" min="1" step="1" /></label>
                <label style="flex:1">${escapeHtml(i18n('Turns / Episode'))} <input id="luker_rpg_memory_turns_episode" class="text_pole" type="number" min="2" step="1" /></label>
            </div>
            <div class="flex-container">
                <label style="flex:1">${escapeHtml(i18n('Episodes / Arc'))} <input id="luker_rpg_memory_episodes_arc" class="text_pole" type="number" min="2" step="1" /></label>
                <label style="flex:1">${escapeHtml(i18n('Arcs / Canon'))} <input id="luker_rpg_memory_arcs_canon" class="text_pole" type="number" min="1" step="1" /></label>
            </div>
            <div class="flex-container">
                <label style="flex:1">${escapeHtml(i18n('Rollup fan-in (N->1)'))} <input id="luker_rpg_memory_rollup_fanin" class="text_pole" type="number" min="2" step="1" /></label>
            </div>

            <label>${escapeHtml(i18n('Node Type Schema (Visual Editor)'))}</label>
            <small style="opacity:0.8">${escapeHtml(i18n('Configure memory table types, extraction hints, and compression strategy in a popup editor.'))}</small>
            <small id="luker_rpg_memory_schema_summary" style="opacity:0.85"></small>
            <div class="flex-container">
                <div id="luker_rpg_memory_open_schema_editor" class="menu_button">${escapeHtml(i18n('Open Schema Editor'))}</div>
            </div>

            <div class="flex-container">
                <div id="luker_rpg_memory_save" class="menu_button">${escapeHtml(i18n('Save Settings'))}</div>
                <div id="luker_rpg_memory_view_graph" class="menu_button">${escapeHtml(i18n('View Graph'))}</div>
                <div id="luker_rpg_memory_rebuild" class="menu_button">${escapeHtml(i18n('Rebuild From Chat'))}</div>
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

    const wiBeforeEvent = context.eventTypes.GENERATION_BEFORE_WORLD_INFO_SCAN;
    context.eventSource.on(wiBeforeEvent, async (payload) => {
        await safeInjectMemoryPrompts(context, payload, 'before_world_info_scan');
    });
    const wiAfterEvent = context.eventTypes.GENERATION_AFTER_WORLD_INFO_SCAN;
    context.eventSource.on(wiAfterEvent, async (payload) => {
        const settings = getSettings();
        if (!settings.enabled || !settings.lorebookProjectionEnabled) {
            return;
        }
        if (payload?.__lukerRpgMemoryInjected === true) {
            return;
        }
        const injected = await safeInjectMemoryPrompts(context, payload, 'after_world_info_scan_fallback');
        if (injected && payload && typeof payload === 'object') {
            payload.requestRescan = true;
            updateUiStatus(i18n('Recall injected via fallback after WI scan. Requested WI rescan for this generation.'));
        }
    });

    context.eventSource.on(context.eventTypes.MESSAGE_SENT, captureMessage);
    context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, captureMessage);
    const markStoreDirtyFromMutation = () => {
        const chatKey = getChatKey(context, { allowFallback: true });
        const store = memoryStoreCache.get(chatKey);
        if (!store) {
            return;
        }
        store.sourceMessageCount = -1;
        store.sourceDigest = '';
        store.updatedAt = Date.now();
        updateUiStatus(i18n('Chat mutation detected. Memory graph will re-sync on next generation.'));
        refreshUiStats();
    };
    context.eventSource.on(context.eventTypes.MESSAGE_DELETED, markStoreDirtyFromMutation);
    context.eventSource.on(context.eventTypes.MESSAGE_EDITED, markStoreDirtyFromMutation);
    context.eventSource.on(context.eventTypes.MESSAGE_SWIPED, markStoreDirtyFromMutation);
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
        ensureUi();
        ensureMemoryStoreLoaded(context)
            .then(() => refreshUiStats())
            .catch(() => refreshUiStats());
    });
});
