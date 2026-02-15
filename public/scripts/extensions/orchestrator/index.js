import { CONNECT_API_MAP, extension_prompt_roles, extension_prompt_types, saveSettings, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { chat_completion_sources, proxies, sendOpenAIRequest } from '../../openai.js';

const MODULE_NAME = 'orchestrator';
const CAPSULE_PROMPT_KEY = 'luker_orchestrator_capsule';
const LAST_CAPSULE_METADATA_KEY = 'luker_orchestrator_last_capsule';
const UI_BLOCK_ID = 'orchestrator_settings';
const DEFAULT_CAPSULE_CUSTOM_INSTRUCTION = 'Follow the orchestration guidance below and prioritize it when drafting the next in-character reply.';
const DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT = 'You are a single-agent orchestration planner for roleplay generation. Produce concise, actionable guidance for the next reply while preserving continuity, character consistency, and world constraints.';
const DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE = [
    'Previous orchestration capsule:',
    '{{previous_orchestration}}',
    '',
    'Recent chat:',
    '{{recent_chat}}',
    '',
    'Current user message:',
    '{{last_user}}',
    '',
    'Task:',
    '- Distill the immediate narrative state and user intent.',
    '- Provide concrete directives for next reply drafting.',
    '- List key risks to avoid (OOC, continuity breaks, data-like language).',
    '- If useful, provide a patch_last_user candidate.',
    '',
    'Return function-call fields only. Keep summary/directives/risks/tags as plain text.',
].join('\n');
const ALLOWED_TEMPLATE_VARS = ['recent_chat', 'last_user', 'previous_outputs', 'distiller', 'previous_orchestration'];
const ORCH_ALLOWED_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe', 'impersonate']);
const REQUIRED_AI_BUILD_NODE_IDS = ['lorebook_reader', 'anti_data_guard'];
const ANTI_DATA_BLOCKED_LEXICON = [
    '观察', '分析', '评估', '统计', '监测', '检测', '实验', '推测', '记录', '汇报',
    'observation', 'analyze', 'analysis', 'evaluate', 'metric', 'kpi', 'ratio', 'probability',
];
const ORCH_AI_QUALITY_AXES = {
    user_intent: 'Analyze user intent, emotional expectation, and implicit goals.',
    character_traits: 'Use character traits and card constraints without restating full biographies in every node.',
    lorebook_compliance: 'Read and obey active lorebook/world-info constraints as hard writing constraints.',
    character_independence: 'Preserve multi-character independence and avoid voice/agency collapse.',
    anti_ooc: 'Detect and prevent OOC behavior and persona drift.',
    anti_datafication: 'Treat data-like prose as a hard violation (quantification, pseudo-analytics, report-style phrasing).',
    latent_behavior: 'Infer plausible latent behavior, motivations, and next-step actions.',
    human_realism: 'Increase human-like behavior through natural uncertainty, bounded knowledge, and believable pacing.',
    world_autonomy: 'Keep the world autonomous; events should not always orbit the user.',
};

function isPlainTextFunctionCallModeEnabled(settings = null) {
    const currentSettings = settings && typeof settings === 'object'
        ? settings
        : extension_settings[MODULE_NAME];
    return Boolean(currentSettings?.plainTextFunctionCallMode);
}

function getDefaultAiSuggestSystemPrompt() {
    return [
        'You design RP multi-agent orchestration profiles for a specific character card.',
        'Use tool calls only. Do not return plain JSON text.',
        'Call multiple functions in one response to build the profile incrementally.',
        'Keep stages concise, operational, and easy to run in a single request turn.',
        'Only the LAST stage outputs are injected into the final generation context.',
        'Design a clear pipeline: state distillation -> parallel reasoning/critique -> final synthesis.',
        'Node outputs are returned via function fields. Do NOT embed JSON blobs inside summary.',
        'For last-stage nodes, use plain structured fields (summary, directives, risks, tags, patch_last_user).',
        'Runtime will assemble the final injected YAML from those structured fields.',
        'Do NOT hardcode any fixed narrator persona/identity/roleplay character in system prompts.',
        'Do NOT mirror long single-prompt identity blocks; focus on process quality and constraints.',
        'Runtime context guarantee: both orchestration agents and final generation already see assembled preset context, character card context, and world-info activation context.',
        'Do NOT repeat full character biography in every node prompt. Prefer compact behavior policy and decision criteria.',
        'Each node must have a distinct role, concrete output focus, and minimal overlap.',
        'Prefer practical distiller/planner/critic/synthesizer style agents and add custom presets only when necessary.',
        'Design for robust RP quality: user-intent understanding, character independence, anti-OOC, realism, and world autonomy.',
        'Require explicit hard-gate checks (consistency, OOC, causality, continuity, over-interpretation) in the critic node.',
        'Hard requirement: include one dedicated node id "lorebook_reader" to explicitly study active lorebook/world-info constraints.',
        'Hard requirement: include one dedicated node id "anti_data_guard" to explicitly block data-like writing and metric-style phrasing.',
        `For anti_data_guard, enforce blocked lexicon as hard risk: ${ANTI_DATA_BLOCKED_LEXICON.join(', ')}.`,
        'For anti_data_guard, also hard-block detached report/bulletin cadence (e.g., weather-broadcast style flat narration).',
        'For anti_data_guard, avoid genre slogans and style branding; output hard compliance checks and rewrite rules only.',
        'Those two required nodes must exist even when you innovate other stage/node designs.',
        'Require final synthesizer output to be concise, actionable, and directly usable for drafting.',
        'Flexibility policy: treat the provided blueprint as a strong baseline, not a prison.',
        'You may innovate node roles/stage topology for this specific character card if quality improves.',
        'Any innovation must keep hard-gate coverage, causal clarity, and final-output contract intact.',
        `Allowed template placeholders ONLY: ${ALLOWED_TEMPLATE_VARS.map(x => `{{${x}}}`).join(', ')}.`,
        'Do not invent any other placeholder names.',
        'When designing prompts, encode checks and directives, not verbose restatements of the card.',
        'Read global_orchestration_spec and global_presets as primary reference before creating card-specific overrides.',
        'Do not output thin prompts. Each node preset must contain concrete process steps, hard constraints, and output contract details.',
        'Minimum richness target per node preset: systemPrompt >= 3 concrete rule lines; userPromptTemplate includes Task block with multiple actionable bullets.',
        'Call luker_orch_append_stage one stage per call.',
        'luker_orch_append_stage arguments must be flat: stage_id, mode, nodes.',
        'Call luker_orch_upsert_preset one preset per call.',
        'Hard rule: one response must contain COMPLETE tool calls for this task. Do not stop after a single tool call.',
        'Hard rule: minimum 2 tool calls in one response, and must include luker_orch_append_stage plus luker_orch_finalize_profile.',
        'Hard rule: luker_orch_finalize_profile must be the last tool call.',
        'Call luker_orch_finalize_profile at the end.',
    ].join('\n');
}

const defaultSpec = {
    stages: [
        { id: 'distill', mode: 'serial', nodes: ['distiller'] },
        { id: 'grounding', mode: 'parallel', nodes: ['lorebook_reader', 'anti_data_guard'] },
        { id: 'reason', mode: 'parallel', nodes: ['planner', 'critic', 'recall_relevance'] },
        { id: 'finalize', mode: 'serial', nodes: ['synthesizer'] },
    ],
};

const defaultPresets = {
    distiller: {
        systemPrompt: 'You are a narrative state distiller. Build a compact, evidence-grounded state snapshot for this turn.',
        userPromptTemplate: 'Previous orchestration capsule:\n{{previous_orchestration}}\n\nRecent chat:\n{{recent_chat}}\n\nCurrent user message:\n{{last_user}}\n\nTask:\n- Distill user intent, scene state, active tensions, and likely immediate direction.\n- Keep it factual and grounded in visible dialogue/actions.\n- Prefer compact high-signal state, not long prose.\n\nReturn function-call fields only. summary should be concise plain text, not JSON string.',
    },
    lorebook_reader: {
        systemPrompt: 'You are a lorebook compliance reader. Extract only active hard constraints from world-info, especially explicit banned wording/style requirements.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nPrevious orchestration capsule:\n{{previous_orchestration}}\n\nRecent chat:\n{{recent_chat}}\n\nTask:\n- Identify hard constraints that must affect THIS turn (style bans, narration boundaries, role constraints, taboo rules, continuity anchors).\n- Include explicit anti-data constraints from lorebook if present: ban report/observation/analysis tone, ban metric-like phrasing.\n- Keep only high-impact constraints; avoid copying long lorebook prose.\n- Phrase outputs as executable writing directives, not summaries of lorebook documents.\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
    anti_data_guard: {
        systemPrompt: 'You are the anti-data hard gate for RP prose. Block report-style, observation/analysis style, metric style, and weather-broadcast style flat narration. Violations are blockers, not suggestions.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nPrevious orchestration capsule:\n{{previous_orchestration}}\n\nPrevious outputs:\n{{previous_outputs}}\n\nTask:\n- Audit for forbidden data-like patterns: numeric ranges (e.g. 3-5分钟), percentages, KPI/metrics, pseudo-scientific wording, report/bulletin cadence.\n- Audit for forbidden verb/tone families: 观察/分析/评估/统计/监测/检测/实验/推测/记录/汇报 and observation/analyze/evaluate/metric/KPI style.\n- Audit for weather-broadcast tone: detached flat reporting such as “像播报天气预报一样平静”.\n- For every violation, output concrete rewrite directives that convert it to vivid in-scene narrative language.\n- Mark unresolved violations in risks as BLOCKER.\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
    planner: {
        systemPrompt: 'You are a progression planner. Turn current state into a concrete, believable next-step plan.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nPrevious orchestration capsule:\n{{previous_orchestration}}\n\nRecent chat:\n{{recent_chat}}\n\nTask:\n- Propose next-step progression beats with clear causality.\n- Preserve character independence and world autonomy.\n- Avoid making the world revolve around the user by default.\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
    critic: {
        systemPrompt: 'You are a hard-gate critic. Detect quality violations before final drafting.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nPrevious orchestration capsule:\n{{previous_orchestration}}\n\nPrevious outputs:\n{{previous_outputs}}\n\nTask:\n- Run hard-gate checks: continuity, causality, role consistency, OOC risk, over-interpretation, and pacing mismatch.\n- If a check fails, provide minimal actionable fixes.\n- Keep critique specific and operational.\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
    recall_relevance: {
        systemPrompt: 'You are a recall relevance analyst. Decide which recalled memory cues should influence this turn.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nPrevious orchestration capsule:\n{{previous_orchestration}}\n\nRecent chat:\n{{recent_chat}}\n\nTask:\n- Identify high-value recalled facts/themes likely to matter now.\n- Prioritize by immediate relevance to current turn goals.\n- Do not invent unseen facts.\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
    synthesizer: {
        systemPrompt: 'You are the final orchestration synthesizer. Produce the single draft-ready guidance for generation.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nPrevious orchestration capsule:\n{{previous_orchestration}}\n\nPrevious outputs:\n{{previous_outputs}}\n\nTask:\n- Merge planner/critic/recall plus lorebook_reader/anti_data_guard outputs into one coherent final guidance.\n- Preserve lorebook hard constraints and anti-data writing policy in final directives.\n- Prioritize actionable directives and keep risk notes concise.\n- Keep output compact and directly usable for roleplay drafting.\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
};

const defaultSettings = {
    enabled: false,
    singleAgentModeEnabled: false,
    singleAgentSystemPrompt: DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT,
    singleAgentUserPromptTemplate: DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE,
    llmNodeApiPresetName: '',
    llmNodePresetName: '',
    plainTextFunctionCallMode: false,
    toolCallRetryMax: 2,
    maxRecentMessages: 14,
    capsuleInjectPosition: extension_prompt_types.IN_CHAT,
    capsuleInjectDepth: 1,
    capsuleInjectRole: extension_prompt_roles.SYSTEM,
    capsuleCustomInstruction: DEFAULT_CAPSULE_CUSTOM_INSTRUCTION,
    orchestrationSpec: defaultSpec,
    presets: defaultPresets,
    chatOverrides: {},
    aiSuggestApiPresetName: '',
    aiSuggestPresetName: '',
    aiSuggestSystemPrompt: getDefaultAiSuggestSystemPrompt(),
};

function i18n(text) {
    return translate(String(text || ''));
}

function i18nFormat(key, ...values) {
    return i18n(key).replace(/\$\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
}

function registerLocaleData() {
    addLocaleData('zh-cn', {
        'Orchestrator': '多智能体编排',
        'Enabled': '启用',
        'Single-agent mode': '单 Agent 简化模式',
        'Single-agent system prompt': '单 Agent 系统提示词',
        'Single-agent user prompt template': '单 Agent 用户提示词模板',
        'Single-agent mode is enabled. Workflow board is hidden and runtime uses the simplified single node profile.': '单 Agent 模式已启用。复杂工作流编辑区已隐藏，运行时将使用简化单节点编排。',
        'Plain-text function-call mode': '纯文本函数调用模式',
        'LLM node API preset (Connection profile, empty = current)': 'LLM 节点 API 预设（连接配置，留空=当前）',
        'LLM node preset (params + prompt, empty = current)': 'LLM 节点预设（参数+提示词，留空=当前）',
        'AI build API preset (Connection profile, empty = current)': 'AI 生成 API 预设（连接配置，留空=当前）',
        'AI build preset (params + prompt, empty = current)': 'AI 生成预设（参数+提示词，留空=当前）',
        'AI build system prompt': 'AI 生成系统提示词',
        'Reset AI build prompt': '重置 AI 生成提示词',
        'Reset AI build prompt to default? This will overwrite current AI build system prompt.': '确认重置 AI 生成提示词为默认值？这会覆盖当前内容。',
        'Recent messages (N)': '最近消息数（N）',
        'Tool-call retries on invalid/missing tool call (N)': '工具调用重试次数（无效/缺失时）',
        'Capsule injection position': '胶囊注入位置',
        'In-Chat': '聊天内',
        'In-Prompt (system block)': '提示词内（系统块）',
        'Before-Prompt': '提示词前',
        'Capsule depth (IN_CHAT only, recommended 1 = before latest message)': '胶囊深度（仅聊天内，建议 1=最后一条消息前）',
        'Capsule role (IN_CHAT only)': '胶囊角色（仅聊天内）',
        'Custom capsule instruction (prepended before analysis)': '自定义胶囊指令（会放在分析结果前）',
        'e.g. Follow this guidance first, then write final reply in-character.': '例如：先遵循下列指导，再用角色语气完成最终回复。',
        'System': 'System',
        'User': 'User',
        'Assistant': 'Assistant',
        'Orchestration Guidance': '编排指导',
        'Use this guidance as high-priority planning context for the next reply.': '将这份指导作为下一条回复的高优先级规划上下文。',
        'Meta': '元信息',
        'Stage': '阶段',
        'Node': '节点',
        'Summary': '摘要',
        'Directives': '执行指令',
        'Risks': '风险',
        'Tags': '标签',
        'Patch Last User': '用户消息修订建议',
        'Structured Notes': '结构化补充',
        'Current card:': '当前角色卡：',
        '(No character card)': '（无角色卡）',
        '(No character selected)': '（未选择角色卡）',
        'Editing:': '当前编辑：',
        'Global profile': '全局配置',
        'AI build goal (optional)': 'AI 生成目标（可选）',
        'e.g. mystery thriller pacing, strict in-character tone': '例如：悬疑节奏、严格角色内表达',
        'Reload Current': '重载当前',
        'Export Profile': '导出编排',
        'Import Profile': '导入编排',
        'Reset Global': '重置全局',
        'Save To Global': '保存到全局',
        'Save To Character Override': '保存到角色卡覆写',
        'Global profile': '全局配置',
        'Current character override': '当前角色卡覆写',
        'Clear Character Override': '清除角色卡覆写',
        'AI Build Profile': 'AI 生成编排',
        'Workflow': '工作流',
        'Add Stage': '新增阶段',
        'Add Node': '新增节点',
        'Agent Presets': 'Agent 预设',
        'Add Preset': '新增预设',
        'No stages yet. Add one stage to start orchestration.': '还没有阶段。新增一个阶段开始编排。',
        'No presets yet.': '还没有预设。',
        'Node ${0}': '节点 ${0}',
        'Stage ${0}': '阶段 ${0}',
        'Then': '然后',
        'Up': '上移',
        'Down': '下移',
        'Delete': '删除',
        'Node ID': '节点 ID',
        'Preset': '预设',
        'Node Prompt Template (optional)': '节点提示词模板（可选）',
        'Use {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}, {{previous_orchestration}}': '可用 {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}, {{previous_orchestration}}',
        'Execution': '执行方式',
        'Serial': '串行',
        'Parallel': '并行',
        'Nodes run in parallel.': '节点并行执行。',
        'Nodes run in serial order.': '节点串行执行。',
        'System Prompt': '系统提示词',
        'User Prompt Template': '用户提示词模板',
        'new_preset_id': 'new_preset_id',
        'Character Override: ${0}': '角色卡覆写：${0}',
        'Global Orchestration Profile': '全局编排配置',
        'Character override (enabled)': '角色卡覆写（已启用）',
        'Character override (configured, currently disabled)': '角色卡覆写（已配置，当前禁用）',
        'Global profile (no character override for current card)': '全局配置（当前角色卡无覆写）',
        'Preset ID cannot be empty.': '预设 ID 不能为空。',
        "Preset '${0}' already exists.": "预设 '${0}' 已存在。",
        "Preset '${0}' is still used by workflow nodes.": "预设 '${0}' 仍被工作流节点使用。",
        'Reloaded global profile from settings.': '已从设置重载全局配置。',
        'No character selected.': '未选择角色卡。',
        'Character orchestration override saved.': '角色卡编排覆写已保存。',
        'Global orchestration profile saved.': '全局编排配置已保存。',
        'Global orchestration profile reset to defaults.': '全局编排配置已重置为默认。',
        'Saved to global profile.': '已保存到全局配置。',
        'Select export source: OK = global profile, Cancel = character override.': '选择导出来源：确定=全局配置，取消=角色卡覆写。',
        'Select import target: OK = global profile, Cancel = character override.': '选择导入目标：确定=全局配置，取消=角色卡覆写。',
        'No character selected. Use global profile?': '当前未选择角色卡。是否改为使用全局配置？',
        'Exported global profile.': '已导出全局配置。',
        'Exported character override: ${0}.': '已导出角色卡覆写：${0}。',
        'Imported to global profile.': '已导入到全局配置。',
        'Imported to character override: ${0}.': '已导入到角色卡覆写：${0}。',
        'Invalid profile file format.': '编排文件格式无效。',
        'Import failed: ${0}': '导入失败：${0}',
        'Reset global profile to defaults.': '已将全局配置重置为默认。',
        'Reset global orchestration profile to defaults? This will overwrite current global workflow and presets.': '确认重置全局编排为默认？这会覆盖当前全局工作流和预设。',
        'Character orchestration override removed.': '角色卡编排覆写已移除。',
        'Character orchestration profile generated by AI.': 'AI 已生成角色卡编排配置。',
        'Global orchestration profile generated by AI.': 'AI 已生成全局编排配置。',
        'AI profile generation failed.': 'AI 生成配置失败。',
        'AI profile generation cancelled.': 'AI 生成配置已由用户终止。',
        'Saved to character override: ${0}.': '已保存到角色卡覆写：${0}。',
        'Removed character override for ${0}.': '已移除角色卡覆写：${0}。',
        'AI profile generated for ${0}.': '已为 ${0} 生成 AI 编排配置。',
        'Reloaded character override for ${0}.': '已重载角色卡覆写：${0}。',
        '(Current preset)': '（当前预设）',
        '(Current API config)': '（当前 API 配置）',
        '(missing)': '（缺失）',
        'AI build did not call finalize explicitly. Parsed output was used anyway.': 'AI 构建未显式调用 finalize。已直接采用解析结果。',
        'AI build did not call finalize explicitly.': 'AI 构建未显式调用 finalize。',
        'AI build must return multiple tool calls in one response.': 'AI 构建必须在一次响应里返回多个工具调用。',
        'AI profile generation failed: ${0}': 'AI 配置生成失败：${0}',
        'Generating orchestration profile for ${0}...': '正在为 ${0} 生成编排配置...',
        'Function output is invalid.': '函数输出无效。',
        'AI build did not provide any stage tool calls.': 'AI 构建未提供任何阶段工具调用。',
        'Orchestrator running...': '编排插件运行中...',
        'Orchestrator completed.': '编排插件运行完成。',
        'Generation aborted. Skipped orchestration.': '生成已中断，已跳过编排。',
        'Orchestrator cancelled by user.': '编排插件已由用户终止。',
        'Orchestrator failed: ${0}': '编排插件运行失败：${0}',
        'Failed to persist character override.': '角色卡覆写写入失败。',
        'Stop': '终止',
    });
    addLocaleData('zh-tw', {
        'Orchestrator': '多智能體編排',
        'Enabled': '啟用',
        'Single-agent mode': '單 Agent 簡化模式',
        'Single-agent system prompt': '單 Agent 系統提示詞',
        'Single-agent user prompt template': '單 Agent 使用者提示詞模板',
        'Single-agent mode is enabled. Workflow board is hidden and runtime uses the simplified single node profile.': '單 Agent 模式已啟用。複雜工作流編輯區已隱藏，執行時將使用簡化單節點編排。',
        'Plain-text function-call mode': '純文字函式呼叫模式',
        'LLM node API preset (Connection profile, empty = current)': 'LLM 節點 API 預設（連線設定，留空=目前）',
        'LLM node preset (params + prompt, empty = current)': 'LLM 節點預設（參數+提示詞，留空=目前）',
        'AI build API preset (Connection profile, empty = current)': 'AI 生成 API 預設（連線設定，留空=目前）',
        'AI build preset (params + prompt, empty = current)': 'AI 生成預設（參數+提示詞，留空=目前）',
        'AI build system prompt': 'AI 生成系統提示詞',
        'Reset AI build prompt': '重置 AI 生成提示詞',
        'Reset AI build prompt to default? This will overwrite current AI build system prompt.': '確認重置 AI 生成提示詞為預設值？這會覆蓋目前內容。',
        'Recent messages (N)': '最近訊息數（N）',
        'Tool-call retries on invalid/missing tool call (N)': '工具呼叫重試次數（無效/缺失時）',
        'Capsule injection position': '膠囊注入位置',
        'In-Chat': '聊天內',
        'In-Prompt (system block)': '提示詞內（系統區塊）',
        'Before-Prompt': '提示詞前',
        'Capsule depth (IN_CHAT only, recommended 1 = before latest message)': '膠囊深度（僅聊天內，建議 1=最後一則訊息前）',
        'Capsule role (IN_CHAT only)': '膠囊角色（僅聊天內）',
        'Custom capsule instruction (prepended before analysis)': '自訂膠囊指令（會放在分析結果前）',
        'e.g. Follow this guidance first, then write final reply in-character.': '例如：先遵循下列指導，再以角色語氣完成最終回覆。',
        'System': 'System',
        'User': 'User',
        'Assistant': 'Assistant',
        'Orchestration Guidance': '編排指導',
        'Use this guidance as high-priority planning context for the next reply.': '將此指導作為下一則回覆的高優先規劃上下文。',
        'Meta': '中繼資訊',
        'Stage': '階段',
        'Node': '節點',
        'Summary': '摘要',
        'Directives': '執行指令',
        'Risks': '風險',
        'Tags': '標籤',
        'Patch Last User': '使用者訊息修訂建議',
        'Structured Notes': '結構化補充',
        'Current card:': '目前角色卡：',
        '(No character card)': '（無角色卡）',
        '(No character selected)': '（未選擇角色卡）',
        'Editing:': '目前編輯：',
        'Global profile': '全域設定',
        'AI build goal (optional)': 'AI 生成目標（可選）',
        'e.g. mystery thriller pacing, strict in-character tone': '例如：懸疑節奏、嚴格角色內語氣',
        'Reload Current': '重新載入目前',
        'Export Profile': '匯出編排',
        'Import Profile': '匯入編排',
        'Reset Global': '重置全域',
        'Save To Global': '儲存到全域',
        'Save To Character Override': '儲存到角色卡覆寫',
        'Current character override': '目前角色卡覆寫',
        'Clear Character Override': '清除角色卡覆寫',
        'AI Build Profile': 'AI 生成編排',
        'Workflow': '工作流',
        'Add Stage': '新增階段',
        'Add Node': '新增節點',
        'Agent Presets': 'Agent 預設',
        'Add Preset': '新增預設',
        'No stages yet. Add one stage to start orchestration.': '尚無階段。新增一個階段開始編排。',
        'No presets yet.': '尚無預設。',
        'Node ${0}': '節點 ${0}',
        'Stage ${0}': '階段 ${0}',
        'Then': '然後',
        'Up': '上移',
        'Down': '下移',
        'Delete': '刪除',
        'Node ID': '節點 ID',
        'Preset': '預設',
        'Node Prompt Template (optional)': '節點提示詞模板（可選）',
        'Use {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}, {{previous_orchestration}}': '可用 {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}, {{previous_orchestration}}',
        'Execution': '執行方式',
        'Serial': '串行',
        'Parallel': '並行',
        'Nodes run in parallel.': '節點並行執行。',
        'Nodes run in serial order.': '節點串行執行。',
        'System Prompt': '系統提示詞',
        'User Prompt Template': '使用者提示詞模板',
        'new_preset_id': 'new_preset_id',
        'Character Override: ${0}': '角色卡覆寫：${0}',
        'Global Orchestration Profile': '全域編排設定',
        'Character override (enabled)': '角色卡覆寫（已啟用）',
        'Character override (configured, currently disabled)': '角色卡覆寫（已設定，當前停用）',
        'Global profile (no character override for current card)': '全域設定（目前角色卡無覆寫）',
        'Preset ID cannot be empty.': '預設 ID 不能為空。',
        "Preset '${0}' already exists.": "預設 '${0}' 已存在。",
        "Preset '${0}' is still used by workflow nodes.": "預設 '${0}' 仍被工作流節點使用。",
        'Reloaded global profile from settings.': '已從設定重新載入全域設定。',
        'No character selected.': '未選擇角色卡。',
        'Character orchestration override saved.': '角色卡編排覆寫已儲存。',
        'Global orchestration profile saved.': '全域編排設定已儲存。',
        'Global orchestration profile reset to defaults.': '全域編排設定已重置為預設。',
        'Saved to global profile.': '已儲存至全域設定。',
        'Select export source: OK = global profile, Cancel = character override.': '選擇匯出來源：確定=全域設定，取消=角色卡覆寫。',
        'Select import target: OK = global profile, Cancel = character override.': '選擇匯入目標：確定=全域設定，取消=角色卡覆寫。',
        'No character selected. Use global profile?': '目前未選擇角色卡。是否改為使用全域設定？',
        'Exported global profile.': '已匯出全域設定。',
        'Exported character override: ${0}.': '已匯出角色卡覆寫：${0}。',
        'Imported to global profile.': '已匯入到全域設定。',
        'Imported to character override: ${0}.': '已匯入到角色卡覆寫：${0}。',
        'Invalid profile file format.': '編排檔案格式無效。',
        'Import failed: ${0}': '匯入失敗：${0}',
        'Reset global profile to defaults.': '已將全域設定重置為預設。',
        'Reset global orchestration profile to defaults? This will overwrite current global workflow and presets.': '確認重置全域編排為預設？這會覆蓋目前全域工作流與預設。',
        'Character orchestration override removed.': '角色卡編排覆寫已移除。',
        'Character orchestration profile generated by AI.': 'AI 已生成角色卡編排設定。',
        'Global orchestration profile generated by AI.': 'AI 已生成全域編排設定。',
        'AI profile generation failed.': 'AI 生成設定失敗。',
        'AI profile generation cancelled.': 'AI 生成設定已由使用者終止。',
        'Saved to character override: ${0}.': '已儲存至角色卡覆寫：${0}。',
        'Removed character override for ${0}.': '已移除角色卡覆寫：${0}。',
        'AI profile generated for ${0}.': '已為 ${0} 生成 AI 編排設定。',
        'Reloaded character override for ${0}.': '已重新載入角色卡覆寫：${0}。',
        '(Current preset)': '（目前預設）',
        '(Current API config)': '（目前 API 設定）',
        '(missing)': '（缺失）',
        'AI build did not call finalize explicitly. Parsed output was used anyway.': 'AI 建構未明確呼叫 finalize。已直接採用解析結果。',
        'AI build did not call finalize explicitly.': 'AI 建構未明確呼叫 finalize。',
        'AI build must return multiple tool calls in one response.': 'AI 建構必須在一次回應中返回多個工具呼叫。',
        'AI profile generation failed: ${0}': 'AI 設定生成失敗：${0}',
        'Generating orchestration profile for ${0}...': '正在為 ${0} 生成編排設定...',
        'Function output is invalid.': '函式輸出無效。',
        'AI build did not provide any stage tool calls.': 'AI 建構未提供任何階段工具呼叫。',
        'Orchestrator running...': '編排插件運行中...',
        'Orchestrator completed.': '編排插件運行完成。',
        'Generation aborted. Skipped orchestration.': '生成已中斷，已跳過編排。',
        'Orchestrator cancelled by user.': '編排插件已由使用者終止。',
        'Orchestrator failed: ${0}': '編排插件運行失敗：${0}',
        'Failed to persist character override.': '角色卡覆寫寫入失敗。',
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

const ORCH_STYLE_ID = 'orchestrator_styles';
const uiState = {
    selectedAvatar: '',
    aiGoal: '',
    globalEditor: null,
    characterEditor: null,
};
let orchInFlight = false;
let activeRunInfoToast = null;
let activeAiBuildToast = null;
let activeOrchRunAbortController = null;
let activeAiBuildAbortController = null;

function cloneDefault(value) {
    return Array.isArray(value) || typeof value === 'object' ? structuredClone(value) : value;
}

function sanitizeSpec(spec) {
    if (!spec || typeof spec !== 'object') {
        return structuredClone(defaultSpec);
    }

    const stages = Array.isArray(spec.stages) ? spec.stages : [];
    const normalizedStages = stages.map((stage, stageIndex) => {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const normalizedNodes = nodes
            .map(node => {
                if (typeof node === 'string') {
                    return node.trim();
                }
                if (node && typeof node === 'object') {
                    const compact = {
                        id: String(node.id || node.node || node.preset || '').trim(),
                        preset: String(node.preset || node.id || node.node || '').trim(),
                        userPromptTemplate: typeof node.userPromptTemplate === 'string' ? node.userPromptTemplate : undefined,
                    };
                    if (!compact.id && compact.preset) {
                        compact.id = compact.preset;
                    }
                    if (!compact.preset && compact.id) {
                        compact.preset = compact.id;
                    }
                    return compact.id ? compact : null;
                }
                return null;
            })
            .filter(Boolean);

        return {
            id: String(stage?.id || `stage_${stageIndex + 1}`),
            mode: String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
            nodes: normalizedNodes,
        };
    }).filter(stage => Array.isArray(stage.nodes) && stage.nodes.length > 0);

    return {
        stages: normalizedStages.length > 0 ? normalizedStages : structuredClone(defaultSpec.stages),
    };
}

function sanitizePresetMap(presets) {
    const base = structuredClone(defaultPresets);
    if (!presets || typeof presets !== 'object') {
        return base;
    }

    for (const [key, value] of Object.entries(presets)) {
        if (!value || typeof value !== 'object') {
            continue;
        }
        base[key] = {
            systemPrompt: String(value.systemPrompt || base[key]?.systemPrompt || '').trim(),
            userPromptTemplate: String(value.userPromptTemplate || base[key]?.userPromptTemplate || '').trim(),
        };
    }

    return base;
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
    extension_settings[MODULE_NAME].singleAgentModeEnabled = Boolean(extension_settings[MODULE_NAME].singleAgentModeEnabled);
    extension_settings[MODULE_NAME].singleAgentSystemPrompt = String(extension_settings[MODULE_NAME].singleAgentSystemPrompt || DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT);
    extension_settings[MODULE_NAME].singleAgentUserPromptTemplate = String(extension_settings[MODULE_NAME].singleAgentUserPromptTemplate || DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE);
    extension_settings[MODULE_NAME].plainTextFunctionCallMode = Boolean(extension_settings[MODULE_NAME].plainTextFunctionCallMode);

    extension_settings[MODULE_NAME].orchestrationSpec = sanitizeSpec(extension_settings[MODULE_NAME].orchestrationSpec);
    extension_settings[MODULE_NAME].presets = sanitizePresetMap(extension_settings[MODULE_NAME].presets);
    if (!String(extension_settings[MODULE_NAME].llmNodePresetName || '').trim()) {
        extension_settings[MODULE_NAME].llmNodePresetName = String(extension_settings[MODULE_NAME].llmNodePromptPresetName || '').trim();
    }
    if (!String(extension_settings[MODULE_NAME].aiSuggestPresetName || '').trim()) {
        extension_settings[MODULE_NAME].aiSuggestPresetName = String(extension_settings[MODULE_NAME].aiSuggestPromptPresetName || '').trim();
    }
    // Drop legacy API selector fields. API routing now comes from connection profile only.
    delete extension_settings[MODULE_NAME].llmNodeApi;
    delete extension_settings[MODULE_NAME].aiSuggestApi;
    delete extension_settings[MODULE_NAME].llmNodeResponseLength;
    delete extension_settings[MODULE_NAME].aiSuggestResponseLength;
    delete extension_settings[MODULE_NAME].llmNodePromptPresetName;
    delete extension_settings[MODULE_NAME].aiSuggestPromptPresetName;
    delete extension_settings[MODULE_NAME].maxCapsuleChars;
    delete extension_settings[MODULE_NAME].saveTarget;
    {
        const value = Number(extension_settings[MODULE_NAME].capsuleInjectPosition);
        const allowed = [extension_prompt_types.IN_PROMPT, extension_prompt_types.IN_CHAT, extension_prompt_types.BEFORE_PROMPT];
        extension_settings[MODULE_NAME].capsuleInjectPosition = allowed.includes(value)
            ? value
            : extension_prompt_types.IN_CHAT;
    }
    extension_settings[MODULE_NAME].capsuleInjectDepth = Math.max(
        0,
        Math.min(10000, Math.floor(Number(extension_settings[MODULE_NAME].capsuleInjectDepth) || 0)),
    );
    {
        const role = Number(extension_settings[MODULE_NAME].capsuleInjectRole);
        const allowedRoles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
        extension_settings[MODULE_NAME].capsuleInjectRole = allowedRoles.includes(role)
            ? role
            : extension_prompt_roles.SYSTEM;
    }
    delete extension_settings[MODULE_NAME].capsuleRenderFormat;
    extension_settings[MODULE_NAME].capsuleCustomInstruction = String(extension_settings[MODULE_NAME].capsuleCustomInstruction || '').trim();
    extension_settings[MODULE_NAME].aiSuggestSystemPrompt = String(extension_settings[MODULE_NAME].aiSuggestSystemPrompt || '').trim() || getDefaultAiSuggestSystemPrompt();
    delete extension_settings[MODULE_NAME].capsuleIncludeRawJson;
    extension_settings[MODULE_NAME].toolCallRetryMax = Math.max(
        0,
        Math.min(10, Math.floor(Number(extension_settings[MODULE_NAME].toolCallRetryMax) || 0)),
    );
    if (!extension_settings[MODULE_NAME].chatOverrides || typeof extension_settings[MODULE_NAME].chatOverrides !== 'object') {
        extension_settings[MODULE_NAME].chatOverrides = {};
    }
}

function clearCapsulePrompt(context) {
    context.setExtensionPrompt(
        CAPSULE_PROMPT_KEY,
        '',
        extension_prompt_types.NONE,
        0,
        true,
        extension_prompt_roles.SYSTEM,
    );
}

function saveLastCapsuleMetadata(context, capsuleText, payload, profile) {
    const capsule = String(capsuleText || '').trim();
    if (!capsule) {
        return;
    }
    const targetLayer = getTargetAssistantLayer(payload);

    context.updateChatMetadata({
        [LAST_CAPSULE_METADATA_KEY]: {
            updatedAt: new Date().toISOString(),
            trigger: String(payload?.type || 'normal'),
            layer: targetLayer,
            profileSource: String(profile?.source || 'global'),
            profileKey: String(profile?.key || 'global'),
            capsule,
        },
    });
    context.saveMetadataDebounced();
}

function clearLastCapsuleMetadata(context) {
    const metadata = context.chatMetadata;
    if (!metadata || typeof metadata !== 'object' || !(LAST_CAPSULE_METADATA_KEY in metadata)) {
        return;
    }

    const nextMetadata = { ...metadata };
    delete nextMetadata[LAST_CAPSULE_METADATA_KEY];
    context.updateChatMetadata(nextMetadata, true);
    context.saveMetadataDebounced();
}

function getTargetAssistantLayer(payload) {
    const type = String(payload?.type || 'normal').trim().toLowerCase();
    const messages = getCoreMessages(payload);
    const assistantCount = messages.filter(message => !message?.is_user).length;
    return (type === 'regenerate' || type === 'swipe' || type === 'continue')
        ? Math.max(assistantCount, 1)
        : Math.max(assistantCount + 1, 1);
}

function getPreviousOrchestrationCapsuleText(context, payload) {
    const metadata = context?.chatMetadata;
    const entry = metadata && typeof metadata === 'object'
        ? metadata[LAST_CAPSULE_METADATA_KEY]
        : null;
    if (!entry || typeof entry !== 'object') {
        return '';
    }
    const currentTargetLayer = getTargetAssistantLayer(payload);
    const expectedPreviousLayer = Math.max(currentTargetLayer - 1, 0);
    const storedLayer = Number(entry.layer || 0);
    if (expectedPreviousLayer <= 0 || storedLayer !== expectedPreviousLayer) {
        return '';
    }
    return String(entry.capsule || '').trim();
}

function shouldRunOrchestrationForPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    if (payload.dryRun === true) {
        return false;
    }
    const type = String(payload.type || '').trim().toLowerCase();
    if (!ORCH_ALLOWED_GENERATION_TYPES.has(type)) {
        return false;
    }
    return true;
}

function getCurrentAvatar(context) {
    return context.characters?.[context.characterId]?.avatar || '';
}

function getChatKey(context) {
    if (context.groupId) {
        return `group:${context.groupId}`;
    }

    const avatar = context.characters?.[context.characterId]?.avatar || 'unknown_avatar';
    const chatId = context.chatId || 'unknown_chat';
    return `char:${avatar}:${chatId}`;
}

function getCoreMessages(payload) {
    return Array.isArray(payload?.coreChat) ? payload.coreChat : [];
}

function getRecentMessages(messages, count) {
    return messages.slice(Math.max(0, messages.length - Math.max(1, count)));
}

function extractLastUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.is_user) {
            return { index: i, message: messages[i] };
        }
    }

    return { index: -1, message: null };
}

function getEffectiveProfile(context) {
    const settings = extension_settings[MODULE_NAME];
    if (settings.singleAgentModeEnabled) {
        return {
            source: 'single',
            key: 'single_agent',
            spec: sanitizeSpec({
                stages: [{
                    id: 'single',
                    mode: 'serial',
                    nodes: [{
                        id: 'single_agent',
                        preset: 'single_agent',
                    }],
                }],
            }),
            presets: sanitizePresetMap({
                ...settings.presets,
                single_agent: {
                    systemPrompt: String(settings.singleAgentSystemPrompt || DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT),
                    userPromptTemplate: String(settings.singleAgentUserPromptTemplate || DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE),
                },
            }),
        };
    }
    const chatKey = getChatKey(context);
    const chatOverride = settings.chatOverrides?.[chatKey];
    if (chatOverride?.enabled && chatOverride?.spec) {
        return {
            source: 'chat',
            key: chatKey,
            spec: sanitizeSpec(chatOverride.spec),
            presets: sanitizePresetMap({
                ...settings.presets,
                ...(chatOverride.presetPatch || {}),
            }),
        };
    }

    const avatar = getCurrentAvatar(context);
    const characterOverride = getCharacterOverrideByAvatar(context, avatar);
    if (characterOverride?.enabled && characterOverride?.spec) {
        return {
            source: 'character',
            key: avatar,
            spec: sanitizeSpec(characterOverride.spec),
            presets: sanitizePresetMap({
                ...settings.presets,
                ...(characterOverride.presetPatch || {}),
            }),
        };
    }

    return {
        source: 'global',
        key: 'global',
        spec: sanitizeSpec(settings.orchestrationSpec),
        presets: sanitizePresetMap(settings.presets),
    };
}

function normalizeNodeSpec(node) {
    if (typeof node === 'string') {
        return {
            id: node,
            preset: node,
            userPromptTemplate: undefined,
        };
    }

    const id = String(node?.id || node?.node || node?.preset || '').trim();
    const preset = String(node?.preset || id).trim();
    return {
        id: id || preset,
        preset,
        userPromptTemplate: typeof node?.userPromptTemplate === 'string' ? node.userPromptTemplate : undefined,
    };
}

function extractTemplateVariables(template) {
    const result = [];
    const text = String(template || '');
    const regex = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        result.push(String(match[1] || '').trim());
    }
    return [...new Set(result.filter(Boolean))];
}

function getUnsupportedTemplateVariables(template) {
    const used = extractTemplateVariables(template);
    return used.filter(name => !ALLOWED_TEMPLATE_VARS.includes(name));
}

function validateAiBuildTemplateVariables(spec, presetPatch) {
    const errors = [];
    const safeSpec = sanitizeSpec(spec);
    const safePatch = (presetPatch && typeof presetPatch === 'object') ? presetPatch : {};

    const stages = Array.isArray(safeSpec?.stages) ? safeSpec.stages : [];
    for (const stage of stages) {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        for (const rawNode of nodes) {
            const node = normalizeNodeSpec(rawNode);
            if (typeof node.userPromptTemplate !== 'string' || !node.userPromptTemplate.trim()) {
                continue;
            }
            const unsupported = getUnsupportedTemplateVariables(node.userPromptTemplate);
            if (unsupported.length > 0) {
                errors.push(`Node '${node.id}': ${unsupported.join(', ')}`);
            }
        }
    }

    for (const [presetId, preset] of Object.entries(safePatch)) {
        const template = String(preset?.userPromptTemplate || '');
        if (!template.trim()) {
            continue;
        }
        const unsupported = getUnsupportedTemplateVariables(template);
        if (unsupported.length > 0) {
            errors.push(`Preset '${presetId}': ${unsupported.join(', ')}`);
        }
    }

    if (errors.length > 0) {
        throw new Error(
            `Unsupported template variables found. Allowed: ${ALLOWED_TEMPLATE_VARS.join(', ')}. ` +
            `Invalid usage -> ${errors.join(' | ')}`,
        );
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

function mergeUserAddendumIntoPromptMessages(promptMessages, addendumText) {
    const messages = Array.isArray(promptMessages)
        ? promptMessages.map(message => ({ ...message }))
        : [];
    const addendum = String(addendumText || '').trim();
    if (!addendum) {
        return messages;
    }
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
            content: base ? `${base}\n\n${addendum}` : addendum,
        };
        return messages;
    }
    messages.push({ role: 'user', content: addendum });
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
        )
        : promptMessages;

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const requestOptions = {
                tools: usePlainTextCalls ? [] : tools,
                toolChoice: usePlainTextCalls ? 'auto' : toolChoice,
                replaceTools: true,
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
                requestScope: 'extension_internal',
            };
            const responseData = await sendOpenAIRequest('quiet', requestMessages, isAbortSignalLike(abortSignal) ? abortSignal : null, {
                ...requestOptions,
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
        )
        : promptMessages;
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const requestOptions = {
                tools: usePlainTextCalls ? [] : tools,
                toolChoice: 'auto',
                replaceTools: true,
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
                requestScope: 'extension_internal',
            };
            const responseData = await sendOpenAIRequest('quiet', requestMessages, isAbortSignalLike(abortSignal) ? abortSignal : null, {
                ...requestOptions,
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

function renderTemplate(template, vars) {
    const safeVars = vars && typeof vars === 'object' ? vars : {};
    const replacements = {
        recent_chat: String(safeVars.recent_chat || ''),
        last_user: String(safeVars.last_user || ''),
        previous_outputs: String(safeVars.previous_outputs || ''),
        distiller: String(safeVars.distiller || ''),
        previous_orchestration: String(safeVars.previous_orchestration || ''),
    };
    let output = String(template || '');
    for (const [key, value] of Object.entries(replacements)) {
        output = output.replaceAll(`{{${key}}}`, value);
    }
    return output;
}

function toCompactJsonText(value, fallback = '{}') {
    try {
        return JSON.stringify(value);
    } catch {
        return fallback;
    }
}

function buildJsonXmlBlock(tag, note, value) {
    const jsonText = toCompactJsonText(value);
    return [
        `<${tag}>`,
        '  <note>',
        `    ${String(note || '')}`,
        '  </note>',
        '  <json>',
        `    ${jsonText}`,
        '  </json>',
        `</${tag}>`,
    ].join('\n');
}

function buildAiSuggestInputXml({
    character = {},
    overrideGoal = '',
    runtimeContextGuarantees = {},
    injectionContract = {},
    mandatoryQualityAxes = {},
    qualityGateContract = {},
    recommendedBlueprint = {},
    antiPatterns = {},
    globalOrchestrationSpec = {},
    globalPresets = {},
    toolProtocol = {},
} = {}) {
    return [
        '<orchestration_build_input>',
        '  <input_guide>Below are structured blocks for building a character-specific orchestration profile. Read all blocks before calling tools.</input_guide>',
        buildJsonXmlBlock('character_profile', 'Current active character card snapshot.', character),
        buildJsonXmlBlock('override_goal', 'Optional user goal override for this character profile.', { override_goal: String(overrideGoal || '') }),
        buildJsonXmlBlock('runtime_context_guarantees', 'What runtime context is already guaranteed for both orchestration nodes and final generation.', runtimeContextGuarantees),
        buildJsonXmlBlock('injection_contract', 'How final orchestration outputs are injected to generation.', injectionContract),
        buildJsonXmlBlock('mandatory_quality_axes', 'Quality axes that must be covered by stage/preset design.', mandatoryQualityAxes),
        buildJsonXmlBlock('quality_gate_contract', 'Hard quality gates the profile must explicitly enforce.', qualityGateContract),
        buildJsonXmlBlock('recommended_blueprint', 'Preferred orchestration blueprint when no special reason to deviate.', recommendedBlueprint),
        buildJsonXmlBlock('anti_patterns', 'Patterns to avoid when generating orchestration prompts.', antiPatterns),
        buildJsonXmlBlock('global_orchestration_spec', 'Current global orchestration spec as primary baseline. Reuse/adapt this structure before inventing new topology.', globalOrchestrationSpec),
        buildJsonXmlBlock('global_presets', 'Current global preset map as primary baseline. Preserve useful detail depth; do not collapse into short generic prompts.', globalPresets),
        buildJsonXmlBlock('prompt_richness_contract', 'Each node prompt must be concrete and non-trivial.', {
            system_prompt_contract: 'At least 3 concrete rule lines; avoid generic slogans.',
            user_template_contract: 'Must include Task block with multiple actionable bullets and clear output contract.',
            anti_lazy_rule: 'Thin one-liner prompts are invalid.',
        }),
        buildJsonXmlBlock('tool_protocol', 'Function-call protocol and expected argument shapes.', toolProtocol),
        '</orchestration_build_input>',
    ].join('\n');
}

function buildPresetAwareMessages(context, settings, systemPrompt, userPrompt, {
    api = '',
    promptPresetName = '',
} = {}) {
    const systemText = String(systemPrompt || '').trim() || 'Return concise guidance through function-call fields.';
    const userText = String(userPrompt || '').trim() || 'Use function-call fields only. Do not put JSON strings into summary.';
    const selectedPromptPresetName = String(promptPresetName || '').trim();
    const envelopeApi = selectedPromptPresetName ? 'openai' : (api || context.mainApi || 'openai');

    return context.buildPresetAwarePromptMessages({
        messages: [
            { role: 'system', content: systemText },
            { role: 'user', content: userText },
        ],
        envelopeOptions: {
            includeCharacterCard: true,
            api: envelopeApi,
            promptPresetName: selectedPromptPresetName,
        },
        promptPresetName: selectedPromptPresetName,
    });
}

async function runLLMNode(context, payload, nodeSpec, preset, messages, previousNodeOutputs, abortSignal = null) {
    const settings = extension_settings[MODULE_NAME];
    const recent = getRecentMessages(messages, settings.maxRecentMessages)
        .map(message => `${message?.is_user ? 'User' : (message?.name || 'Assistant')}: ${String(message?.mes || '')}`)
        .join('\n');
    const { message: lastUser } = extractLastUserMessage(messages);
    const previousOutputs = [
        '<previous_node_outputs>',
        '  <note>Outputs from completed nodes in prior stages. Use as upstream context only.</note>',
        '  <json>',
        `    ${toCompactJsonText(Object.fromEntries(previousNodeOutputs))}`,
        '  </json>',
        '</previous_node_outputs>',
    ].join('\n');
    const distillerOutput = [
        '<distiller_output>',
        '  <note>Output from distiller node if available.</note>',
        '  <json>',
        `    ${toCompactJsonText(previousNodeOutputs.get('distiller') || {})}`,
        '  </json>',
        '</distiller_output>',
    ].join('\n');
    const previousOrchestration = getPreviousOrchestrationCapsuleText(context, payload);
    const userPrompt = renderTemplate(nodeSpec.userPromptTemplate || preset.userPromptTemplate || '', {
        recent_chat: recent,
        last_user: String(lastUser?.mes || ''),
        previous_outputs: previousOutputs,
        distiller: distillerOutput,
        previous_orchestration: previousOrchestration,
    });

    const llmPresetName = String(settings.llmNodePresetName || '').trim();
    const llmApiPresetName = String(settings.llmNodeApiPresetName || '').trim();
    const promptPresetName = llmPresetName;
    const api = resolveRequestApiFromConnectionProfileName(context, llmApiPresetName) || String(context.mainApi || 'openai');
    const apiSettingsOverride = buildApiSettingsOverrideFromConnectionProfileName(
        llmApiPresetName,
        String(context?.chatCompletionSettings?.chat_completion_source || ''),
    );
    const promptMessages = buildPresetAwareMessages(
        context,
        settings,
        String(preset.systemPrompt || '').trim(),
        userPrompt,
        {
            api,
            promptPresetName,
        },
    );

    const nodeOutputSchema = {
        type: 'object',
        properties: {
            summary: { type: 'string' },
            xml_guidance: { type: 'string' },
            directives: {
                type: 'array',
                items: { type: 'string' },
            },
            risks: {
                type: 'array',
                items: { type: 'string' },
            },
            patch_last_user: { type: 'string' },
            tags: {
                type: 'array',
                items: { type: 'string' },
            },
        },
        additionalProperties: true,
    };

    const toolOutput = await requestToolCallWithRetry(settings, promptMessages, {
        functionName: 'luker_orch_node_output',
        functionDescription: `Orchestrator node output for '${nodeSpec.id}'.`,
        parameters: nodeOutputSchema,
        llmPresetName,
        apiSettingsOverride,
        abortSignal,
    });
    if (toolOutput && typeof toolOutput === 'object') {
        return toolOutput;
    }

    throw new Error(`Node '${nodeSpec.id}' returned invalid tool call payload.`);
}

async function executeNode(context, payload, nodeSpec, messages, previousNodeOutputs, presets, abortSignal = null) {
    const preset = presets[nodeSpec.preset] || {};
    return await runLLMNode(context, payload, nodeSpec, preset, messages, previousNodeOutputs, abortSignal);
}

async function runOrchestration(context, payload, messages, profile) {
    const spec = sanitizeSpec(profile.spec);
    const stages = Array.isArray(spec?.stages) ? spec.stages : [];
    const stageOutputs = [];
    const previousNodeOutputs = new Map();
    const abortSignal = isAbortSignalLike(payload?.signal) ? payload.signal : null;

    for (const stage of stages) {
        if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
            throw new DOMException('Orchestration aborted.', 'AbortError');
        }
        const mode = String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const nodeOutputs = [];

        if (mode === 'parallel') {
            const outputs = await Promise.all(nodes.map(async (rawNode) => {
                const nodeSpec = normalizeNodeSpec(rawNode);
                return {
                    node: nodeSpec.id,
                    output: await executeNode(context, payload, nodeSpec, messages, previousNodeOutputs, profile.presets, abortSignal),
                };
            }));
            nodeOutputs.push(...outputs);
        } else {
            for (const rawNode of nodes) {
                const nodeSpec = normalizeNodeSpec(rawNode);
                nodeOutputs.push({
                    node: nodeSpec.id,
                    output: await executeNode(context, payload, nodeSpec, messages, previousNodeOutputs, profile.presets, abortSignal),
                });
            }
        }

        for (const item of nodeOutputs) {
            previousNodeOutputs.set(String(item.node), item.output);
        }

        stageOutputs.push({
            id: String(stage?.id || `stage_${stageOutputs.length + 1}`),
            mode,
            nodes: nodeOutputs,
        });
    }

    return { stageOutputs, previousNodeOutputs };
}

function compactStageOutputs(stageOutputs) {
    return stageOutputs.map(stage => ({
        id: stage.id,
        mode: stage.mode,
        nodes: stage.nodes.map(node => ({
            node: node.node,
            output: node.output,
        })),
    }));
}

function tryParseJsonObject(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const text = value.trim();
    if (!text || (!text.startsWith('{') && !text.startsWith('['))) {
        return null;
    }
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function normalizeNodeOutputForCapsule(output) {
    const normalized = output && typeof output === 'object'
        ? structuredClone(output)
        : { value: output };

    if (typeof normalized.summary !== 'string') {
        return normalized;
    }
    const parsed = tryParseJsonObject(normalized.summary);
    if (!parsed || Array.isArray(parsed)) {
        return normalized;
    }

    if ((!Array.isArray(normalized.directives) || normalized.directives.length === 0) && Array.isArray(parsed.directives)) {
        normalized.directives = parsed.directives;
    }
    if ((!Array.isArray(normalized.risks) || normalized.risks.length === 0) && Array.isArray(parsed.risks)) {
        normalized.risks = parsed.risks;
    }
    if ((!Array.isArray(normalized.tags) || normalized.tags.length === 0) && Array.isArray(parsed.tags)) {
        normalized.tags = parsed.tags;
    }
    if (!normalized.patch_last_user && typeof parsed.patch_last_user === 'string') {
        normalized.patch_last_user = parsed.patch_last_user;
    }
    if (!normalized.xml_guidance && typeof parsed.xml_guidance === 'string') {
        normalized.xml_guidance = parsed.xml_guidance;
    }
    normalized.summary = typeof parsed.summary === 'string' ? parsed.summary : '';

    const extras = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (['summary', 'directives', 'risks', 'tags', 'patch_last_user', 'xml_guidance'].includes(key)) {
            continue;
        }
        extras[key] = value;
    }
    if (Object.keys(extras).length > 0) {
        normalized.__summary_object = extras;
    }
    return normalized;
}

function getFinalStageSnapshot(stageOutputs) {
    const compact = compactStageOutputs(stageOutputs);
    if (!Array.isArray(compact) || compact.length === 0) {
        return null;
    }
    const last = compact[compact.length - 1];
    if (!last || !Array.isArray(last.nodes)) {
        return null;
    }
    return {
        id: String(last.id || `stage_${compact.length}`),
        mode: String(last.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
        nodes: last.nodes
            .map(node => ({
                node: String(node?.node || ''),
                output: normalizeNodeOutputForCapsule(node?.output),
            }))
            .filter(node => node.node),
    };
}

function yamlInlineScalar(value) {
    const text = String(value ?? '');
    if (!text) {
        return "''";
    }
    if (/^[A-Za-z0-9._-]+$/.test(text)) {
        return text;
    }
    return JSON.stringify(text);
}

function pushYamlBlock(lines, indent, key, value) {
    const text = String(value ?? '').trim();
    if (!text) {
        return;
    }
    lines.push(`${indent}${key}: |-`);
    for (const line of text.split('\n')) {
        lines.push(`${indent}  ${line}`);
    }
}

function pushYamlList(lines, indent, key, items) {
    if (!Array.isArray(items)) {
        return;
    }
    const normalized = items
        .map(item => String(item ?? '').trim())
        .filter(Boolean);
    if (normalized.length === 0) {
        return;
    }
    lines.push(`${indent}${key}:`);
    for (const item of normalized) {
        lines.push(`${indent}  - ${yamlInlineScalar(item)}`);
    }
}

function formatNodeOutputAsYaml(nodeOutput, nodeId) {
    const output = normalizeNodeOutputForCapsule(nodeOutput);
    const lines = [];
    lines.push(`      - id: ${yamlInlineScalar(nodeId)}`);
    pushYamlBlock(lines, '        ', 'summary', output.summary);
    pushYamlList(lines, '        ', 'directives', output.directives);
    pushYamlList(lines, '        ', 'risks', output.risks);
    pushYamlList(lines, '        ', 'tags', output.tags);
    pushYamlBlock(lines, '        ', 'patch_last_user', output.patch_last_user);

    const extraPayload = {};
    for (const [key, value] of Object.entries(output)) {
        if ([
            'summary',
            'directives',
            'risks',
            'tags',
            'patch_last_user',
            'xml_guidance',
            '__summary_object',
        ].includes(key)) {
            continue;
        }
        extraPayload[key] = value;
    }
    if (output.__summary_object && typeof output.__summary_object === 'object') {
        for (const [key, value] of Object.entries(output.__summary_object)) {
            if (!(key in extraPayload)) {
                extraPayload[key] = value;
            }
        }
    }
    if (Object.keys(extraPayload).length > 0) {
        pushYamlBlock(lines, '        ', 'structured_notes_json', JSON.stringify(extraPayload, null, 2));
    }
    const xmlGuidance = String(output.xml_guidance || '').trim();
    if (xmlGuidance) {
        pushYamlBlock(lines, '        ', 'model_hint', xmlGuidance);
    }
    return lines.join('\n');
}

function buildCapsuleText(capsule, settings) {
    const lines = [];
    const customInstruction = String(settings?.capsuleCustomInstruction || '').trim();
    if (customInstruction) {
        lines.push(customInstruction);
    }
    lines.push('luker_orchestration:');
    lines.push(`  phase: ${yamlInlineScalar(capsule.phase)}`);
    lines.push(`  trigger: ${yamlInlineScalar(capsule.trigger)}`);
    lines.push('  guidance_policy: "Use this as high-priority planning context for the next roleplay reply."');
    if (capsule.final_stage) {
        lines.push('  final_stage:');
        lines.push(`    id: ${yamlInlineScalar(capsule.final_stage.id)}`);
        lines.push(`    mode: ${yamlInlineScalar(capsule.final_stage.mode)}`);
        lines.push('    agents:');
        for (const node of capsule.final_stage.nodes || []) {
            lines.push(formatNodeOutputAsYaml(node.output, node.node));
        }
    } else {
        lines.push('  final_stage:');
        lines.push('    id: \'\'');
        lines.push('    mode: serial');
        lines.push('    agents: []');
    }
    return lines.join('\n').trim();
}

function buildCapsule(payload, stageOutputs, options = {}) {
    const finalStage = getFinalStageSnapshot(stageOutputs);
    const capsule = {
        phase: options.phase || 'final',
        trigger: payload?.type || 'normal',
        final_stage: finalStage,
    };

    const settings = extension_settings[MODULE_NAME];
    return buildCapsuleText(capsule, settings);
}

function injectCapsule(context, text) {
    const settings = extension_settings[MODULE_NAME];
    const position = Number(settings.capsuleInjectPosition);
    const depth = Math.max(0, Math.min(10000, Math.floor(Number(settings.capsuleInjectDepth) || 0)));
    const role = Number(settings.capsuleInjectRole);
    context.setExtensionPrompt(
        CAPSULE_PROMPT_KEY,
        text,
        position,
        depth,
        true,
        role,
    );
}

async function onWorldInfoFinalized(payload) {
    const context = getContext();
    const settings = extension_settings[MODULE_NAME];

    if (!settings.enabled) {
        return;
    }
    if (!shouldRunOrchestrationForPayload(payload)) {
        return;
    }
    if (orchInFlight) {
        return;
    }
    if (isAbortSignalLike(payload?.signal) && payload.signal.aborted) {
        clearCapsulePrompt(context);
        clearLastCapsuleMetadata(context);
        updateUiStatus(i18n('Generation aborted. Skipped orchestration.'));
        return;
    }
    orchInFlight = true;
    const pluginAbortController = new AbortController();
    activeOrchRunAbortController = pluginAbortController;
    const linkedAbort = linkAbortSignals(payload?.signal, pluginAbortController.signal);
    const orchestrationPayload = linkedAbort.signal && linkedAbort.signal !== payload?.signal
        ? { ...payload, signal: linkedAbort.signal }
        : payload;

    try {
        const profile = getEffectiveProfile(context);
        const messages = structuredClone(getCoreMessages(payload));
        if (messages.length === 0) {
            clearCapsulePrompt(context);
            clearLastCapsuleMetadata(context);
            return;
        }
        updateUiStatus(i18n('Orchestrator running...'));
        showRunInfoToast(i18n('Orchestrator running...'), {
            stopLabel: i18n('Stop'),
            onStop: () => {
                if (!pluginAbortController.signal.aborted) {
                    pluginAbortController.abort();
                }
            },
        });

        const finalRun = await runOrchestration(context, orchestrationPayload, messages, profile);

        const capsuleText = buildCapsule(payload, finalRun.stageOutputs || [], {
            phase: 'final',
        });
        injectCapsule(context, capsuleText);
        saveLastCapsuleMetadata(context, capsuleText, payload, profile);
        updateUiStatus(i18n('Orchestrator completed.'));
        clearRunInfoToast();
    } catch (error) {
        if (isAbortError(error, orchestrationPayload?.signal)) {
            clearCapsulePrompt(context);
            clearLastCapsuleMetadata(context);
            const generationAborted = Boolean(isAbortSignalLike(payload?.signal) && payload.signal.aborted);
            updateUiStatus(generationAborted
                ? i18n('Generation aborted. Skipped orchestration.')
                : i18n('Orchestrator cancelled by user.'));
            clearRunInfoToast();
            return;
        }
        clearCapsulePrompt(context);
        clearLastCapsuleMetadata(context);
        console.warn(`[${MODULE_NAME}] Orchestration failed`, error);
        const failText = i18nFormat('Orchestrator failed: ${0}', String(error?.message || error));
        updateUiStatus(failText);
        clearRunInfoToast();
        notifyError(failText);
    } finally {
        linkedAbort.cleanup();
        if (activeOrchRunAbortController === pluginAbortController) {
            activeOrchRunAbortController = null;
        }
        clearRunInfoToast();
        orchInFlight = false;
    }
}

function onMessageDeleted() {
    const context = getContext();
    clearCapsulePrompt(context);
    clearLastCapsuleMetadata(context);
}

function notifyInfo(message) {
    if (typeof toastr !== 'undefined') {
        toastr.info(String(message));
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

function getSettings() {
    return extension_settings[MODULE_NAME];
}

function getCharacterDisplayName(context) {
    return getCharacterDisplayNameByAvatar(context, getCurrentAvatar(context)) || i18n('(No character selected)');
}

function getCharacterDisplayNameByAvatar(context, avatar) {
    const target = String(avatar || '');
    if (!target) {
        return '';
    }
    const character = (context.characters || []).find(item => String(item?.avatar || '') === target);
    return String(character?.name || '').trim() || target;
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
        ['#luker_orch_llm_api_preset', settings.llmNodeApiPresetName],
        ['#luker_orch_llm_preset', settings.llmNodePresetName],
        ['#luker_orch_ai_suggest_api_preset', settings.aiSuggestApiPresetName],
        ['#luker_orch_ai_suggest_preset', settings.aiSuggestPresetName],
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

function sanitizeIdentifierToken(value, fallback = '') {
    const normalized = String(value || '')
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_\-]/g, '_');
    return normalized || String(fallback || '');
}

function createPresetDraft(seed = {}) {
    return {
        systemPrompt: String(seed.systemPrompt || '').trim(),
        userPromptTemplate: String(seed.userPromptTemplate || '').trim(),
    };
}

function toEditablePresetMap(presets) {
    const normalized = {};
    const source = sanitizePresetMap(presets);
    for (const [key, value] of Object.entries(source)) {
        normalized[key] = createPresetDraft(value);
    }
    return normalized;
}

function toEditableSpec(spec, presets) {
    const sanitized = sanitizeSpec(spec);
    const presetIds = Object.keys(presets);
    const defaultPreset = presetIds[0] || 'distiller';

    const stages = (Array.isArray(sanitized.stages) ? sanitized.stages : [])
        .map((stage, stageIndex) => {
            const stageId = sanitizeIdentifierToken(stage?.id, `stage_${stageIndex + 1}`);
            const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
            const normalizedNodes = nodes.map((node, nodeIndex) => {
                const normalizedNode = normalizeNodeSpec(node);
                const preset = sanitizeIdentifierToken(normalizedNode.preset || normalizedNode.id, defaultPreset);
                if (!presets[preset]) {
                    presets[preset] = createPresetDraft();
                }
                return {
                    id: sanitizeIdentifierToken(normalizedNode.id || preset, `node_${nodeIndex + 1}`),
                    preset,
                    userPromptTemplate: String(normalizedNode.userPromptTemplate || ''),
                };
            });
            return {
                id: stageId,
                mode: String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
                nodes: normalizedNodes.length > 0
                    ? normalizedNodes
                    : [{
                        id: defaultPreset,
                        preset: defaultPreset,
                        userPromptTemplate: '',
                    }],
            };
        })
        .filter(stage => stage.nodes.length > 0);

    if (stages.length > 0) {
        return { stages };
    }

    return {
        stages: [{
            id: 'distill',
            mode: 'serial',
            nodes: [{
                id: defaultPreset,
                preset: defaultPreset,
                userPromptTemplate: '',
            }],
        }],
    };
}

function serializeEditorSpec(editorSpec) {
    const stages = Array.isArray(editorSpec?.stages) ? editorSpec.stages : [];
    return sanitizeSpec({
        stages: stages
            .map((stage, stageIndex) => ({
                id: sanitizeIdentifierToken(stage?.id, `stage_${stageIndex + 1}`),
                mode: String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
                nodes: (Array.isArray(stage?.nodes) ? stage.nodes : [])
                    .map((node, nodeIndex) => {
                        const id = sanitizeIdentifierToken(node?.id, `node_${nodeIndex + 1}`);
                        const preset = sanitizeIdentifierToken(node?.preset, id);
                        const userPromptTemplate = String(node?.userPromptTemplate || '').trim();

                        const serialized = { id, preset };
                        if (userPromptTemplate) {
                            serialized.userPromptTemplate = userPromptTemplate;
                        }
                        return serialized;
                    })
                    .filter(Boolean),
            }))
            .filter(stage => Array.isArray(stage.nodes) && stage.nodes.length > 0),
    });
}

function serializeEditorPresetMap(editorPresets) {
    return sanitizePresetMap(editorPresets || {});
}

function buildPresetPatch(basePresets, editedPresets) {
    const patch = {};
    for (const [key, preset] of Object.entries(editedPresets || {})) {
        const base = basePresets?.[key];
        if (!base) {
            patch[key] = preset;
            continue;
        }

        const delta = {};
        if (String(preset.systemPrompt || '') !== String(base.systemPrompt || '')) {
            delta.systemPrompt = preset.systemPrompt;
        }
        if (String(preset.userPromptTemplate || '') !== String(base.userPromptTemplate || '')) {
            delta.userPromptTemplate = preset.userPromptTemplate;
        }

        if (Object.keys(delta).length > 0) {
            patch[key] = delta;
        }
    }
    return patch;
}

function getCharacterByAvatar(context, avatar) {
    const target = String(avatar || '');
    if (!target) {
        return null;
    }
    return (context.characters || []).find(char => String(char?.avatar || '') === target) || null;
}

function getCharacterIndexByAvatar(context, avatar) {
    const target = String(avatar || '');
    if (!target) {
        return -1;
    }
    return (context.characters || []).findIndex(char => String(char?.avatar || '') === target);
}

function getCharacterExtensionDataByAvatar(context, avatar) {
    const character = getCharacterByAvatar(context, avatar);
    const payload = character?.data?.extensions?.[MODULE_NAME];
    return payload && typeof payload === 'object' ? payload : {};
}

function getCharacterOverrideByAvatar(context, avatar) {
    const payload = getCharacterExtensionDataByAvatar(context, avatar);
    const override = payload?.override;
    return override && typeof override === 'object' ? override : null;
}

function getCharacterCardSnapshot(context, avatar) {
    const character = getCharacterByAvatar(context, avatar) || {};
    const fromCardFields = (avatar && avatar === getCurrentAvatar(context) && typeof context.getCharacterCardFields === 'function')
        ? (context.getCharacterCardFields() || {})
        : {};

    const readField = (field) => {
        const value = character?.[field]
            ?? character?.data?.[field]
            ?? fromCardFields?.[field];
        return String(value || '').trim();
    };

    return {
        avatar: String(avatar || ''),
        name: String(character?.name || fromCardFields?.name || '').trim(),
        description: readField('description'),
        personality: readField('personality'),
        scenario: readField('scenario'),
        system: readField('system'),
        first_mes: readField('first_mes'),
        mes_example: readField('mes_example'),
        creator_notes: readField('creator_notes'),
    };
}

function ensureEditorIntegrity(editor) {
    if (!editor || typeof editor !== 'object') {
        return;
    }
    if (!editor.presets || typeof editor.presets !== 'object' || Object.keys(editor.presets).length === 0) {
        editor.presets = toEditablePresetMap(defaultPresets);
    }
    editor.spec = toEditableSpec(editor.spec || defaultSpec, editor.presets);
}

function pickDefaultPreset(editor) {
    const keys = Object.keys(editor?.presets || {});
    if (keys.length === 0) {
        editor.presets = toEditablePresetMap(defaultPresets);
        return Object.keys(editor.presets)[0] || 'distiller';
    }
    return keys[0];
}

function createNewStage(editor) {
    const defaultPreset = pickDefaultPreset(editor);
    const index = (editor.spec?.stages?.length || 0) + 1;
    return {
        id: `stage_${index}`,
        mode: 'serial',
        nodes: [{
            id: defaultPreset,
            preset: defaultPreset,
            userPromptTemplate: '',
        }],
    };
}

function loadGlobalEditorState() {
    const settings = getSettings();
    const presets = toEditablePresetMap(settings.presets);
    const spec = toEditableSpec(settings.orchestrationSpec, presets);
    return { spec, presets };
}

function loadCharacterEditorState(context, avatar) {
    const settings = getSettings();
    const safeAvatar = String(avatar || '');
    const override = getCharacterOverrideByAvatar(context, safeAvatar);
    const mergedPresets = sanitizePresetMap({
        ...settings.presets,
        ...(override?.presetPatch || {}),
    });
    const presets = toEditablePresetMap(mergedPresets);
    const spec = toEditableSpec(override?.spec || settings.orchestrationSpec, presets);
    return {
        avatar: safeAvatar,
        enabled: Boolean(override?.enabled),
        notes: String(override?.notes || ''),
        spec,
        presets,
    };
}

function initializeUiState(context) {
    uiState.selectedAvatar = String(getCurrentAvatar(context) || '').trim();
    uiState.globalEditor = loadGlobalEditorState();
    uiState.characterEditor = loadCharacterEditorState(context, uiState.selectedAvatar);
    ensureEditorIntegrity(uiState.globalEditor);
    ensureEditorIntegrity(uiState.characterEditor);
}

function syncCharacterEditorWithActiveAvatar(context) {
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    if (activeAvatar === uiState.selectedAvatar) {
        return;
    }
    uiState.selectedAvatar = activeAvatar;
    uiState.characterEditor = loadCharacterEditorState(context, activeAvatar);
    ensureEditorIntegrity(uiState.characterEditor);
}

function hasCharacterOverride(context, avatar) {
    return Boolean(getCharacterOverrideByAvatar(context, avatar));
}

function getDisplayedScope(context, settings) {
    void settings;
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    return hasCharacterOverride(context, activeAvatar) ? 'character' : 'global';
}

function getEditorByScope(scope) {
    return scope === 'character' ? uiState.characterEditor : uiState.globalEditor;
}

function renderPresetOptions(presets, selectedPreset) {
    const selected = String(selectedPreset || '');
    const ids = Object.keys(presets || {});
    const options = [];

    if (selected && !presets[selected]) {
        options.push(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} ${escapeHtml(i18n('(missing)'))}</option>`);
    }

    for (const presetId of ids) {
        options.push(`<option value="${escapeHtml(presetId)}"${presetId === selected ? ' selected' : ''}>${escapeHtml(presetId)}</option>`);
    }

    return options.join('');
}

function renderWorkflowBoard(scope, editor) {
    const stages = Array.isArray(editor?.spec?.stages) ? editor.spec.stages : [];
    if (stages.length === 0) {
        return `<div class="luker_orch_empty_hint">${escapeHtml(i18n('No stages yet. Add one stage to start orchestration.'))}</div>`;
    }

    return stages.map((stage, stageIndex) => {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const nodeCards = nodes.map((node, nodeIndex) => `
<div class="luker_orch_node_card">
    <div class="luker_orch_node_header">
        <b>${escapeHtml(i18nFormat('Node ${0}', nodeIndex + 1))}</b>
        <div class="luker_orch_btnrow">
            <div class="menu_button menu_button_small" data-luker-action="node-move-up" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}">${escapeHtml(i18n('Up'))}</div>
            <div class="menu_button menu_button_small" data-luker-action="node-move-down" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}">${escapeHtml(i18n('Down'))}</div>
            <div class="menu_button menu_button_small" data-luker-action="node-delete" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}">${escapeHtml(i18n('Delete'))}</div>
        </div>
    </div>
    <label>${escapeHtml(i18n('Node ID'))}</label>
    <input class="text_pole" data-luker-field="node-id" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" value="${escapeHtml(node.id)}" />
    <label>${escapeHtml(i18n('Preset'))}</label>
    <select class="text_pole" data-luker-field="node-preset" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}">
        ${renderPresetOptions(editor.presets, node.preset)}
    </select>
    <label>${escapeHtml(i18n('Node Prompt Template (optional)'))}</label>
    <textarea class="text_pole textarea_compact" rows="4" data-luker-field="node-template" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" placeholder="${escapeHtml(i18n('Use {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}, {{previous_orchestration}}'))}">${escapeHtml(node.userPromptTemplate)}</textarea>
</div>`).join('');

        return `
<div class="luker_orch_stage_card">
    <div class="luker_orch_stage_header">
        <div>
            <div class="luker_orch_stage_label">${escapeHtml(i18nFormat('Stage ${0}', stageIndex + 1))}</div>
            <input class="text_pole" data-luker-field="stage-id" data-scope="${scope}" data-stage-index="${stageIndex}" value="${escapeHtml(stage.id)}" />
        </div>
        <div>
            <label>${escapeHtml(i18n('Execution'))}</label>
            <select class="text_pole" data-luker-field="stage-mode" data-scope="${scope}" data-stage-index="${stageIndex}">
                <option value="serial"${stage.mode === 'serial' ? ' selected' : ''}>${escapeHtml(i18n('Serial'))}</option>
                <option value="parallel"${stage.mode === 'parallel' ? ' selected' : ''}>${escapeHtml(i18n('Parallel'))}</option>
            </select>
        </div>
        <div class="luker_orch_btnrow">
            <div class="menu_button menu_button_small" data-luker-action="stage-move-up" data-scope="${scope}" data-stage-index="${stageIndex}">${escapeHtml(i18n('Up'))}</div>
            <div class="menu_button menu_button_small" data-luker-action="stage-move-down" data-scope="${scope}" data-stage-index="${stageIndex}">${escapeHtml(i18n('Down'))}</div>
            <div class="menu_button menu_button_small" data-luker-action="stage-delete" data-scope="${scope}" data-stage-index="${stageIndex}">${escapeHtml(i18n('Delete'))}</div>
        </div>
    </div>
    <div class="luker_orch_stage_meta">${escapeHtml(stage.mode === 'parallel' ? i18n('Nodes run in parallel.') : i18n('Nodes run in serial order.'))}</div>
    <div class="luker_orch_nodes_grid">${nodeCards}</div>
    <div class="menu_button menu_button_small" data-luker-action="node-add" data-scope="${scope}" data-stage-index="${stageIndex}">${escapeHtml(i18n('Add Node'))}</div>
</div>`;
    }).join(`<div class="luker_orch_stage_connector">${escapeHtml(i18n('Then'))}</div>`);
}

function renderPresetBoard(scope, editor) {
    const entries = Object.entries(editor?.presets || {}).sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) {
        return `<div class="luker_orch_empty_hint">${escapeHtml(i18n('No presets yet.'))}</div>`;
    }

    return entries.map(([presetId, preset]) => `
<div class="luker_orch_preset_card">
    <div class="luker_orch_preset_header">
        <b>${escapeHtml(presetId)}</b>
        <div class="menu_button menu_button_small" data-luker-action="preset-delete" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">${escapeHtml(i18n('Delete'))}</div>
    </div>
    <label>${escapeHtml(i18n('System Prompt'))}</label>
    <textarea class="text_pole textarea_compact" rows="4" data-luker-field="preset-system-prompt" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">${escapeHtml(preset.systemPrompt)}</textarea>
    <label>${escapeHtml(i18n('User Prompt Template'))}</label>
    <textarea class="text_pole textarea_compact" rows="5" data-luker-field="preset-user-template" data-scope="${scope}" data-preset-id="${escapeHtml(presetId)}">${escapeHtml(preset.userPromptTemplate)}</textarea>
</div>`).join('');
}

function renderEditorWorkspace(scope, editor, title) {
    return `
<div class="luker_orch_workspace" data-luker-scope-root="${scope}">
    <h5 class="margin0">${escapeHtml(title)}</h5>
    <div class="luker_orch_workspace_grid">
        <div class="luker_orch_workspace_col">
            <div class="luker_orch_col_title">${escapeHtml(i18n('Workflow'))}</div>
            <div class="luker_orch_flow">${renderWorkflowBoard(scope, editor)}</div>
            <div class="menu_button menu_button_small" data-luker-action="stage-add" data-scope="${scope}">${escapeHtml(i18n('Add Stage'))}</div>
        </div>
        <div class="luker_orch_workspace_col">
            <div class="luker_orch_col_title">${escapeHtml(i18n('Agent Presets'))}</div>
            <div class="luker_orch_presets">${renderPresetBoard(scope, editor)}</div>
            <div class="luker_orch_preset_add_row">
                <input class="text_pole" data-luker-new-preset="${scope}" placeholder="${escapeHtml(i18n('new_preset_id'))}" />
                <div class="menu_button menu_button_small" data-luker-action="preset-add" data-scope="${scope}">${escapeHtml(i18n('Add Preset'))}</div>
            </div>
        </div>
    </div>
</div>`;
}

function renderDynamicPanels(root, context) {
    const settings = getSettings();
    const singleModeEnabled = Boolean(settings.singleAgentModeEnabled);
    syncCharacterEditorWithActiveAvatar(context);
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    const override = activeAvatar ? getCharacterOverrideByAvatar(context, activeAvatar) : null;
    const scope = getDisplayedScope(context, settings);
    const editor = getEditorByScope(scope);
    const isCharacterScope = scope === 'character';
    const isOverrideEnabled = Boolean(override?.enabled);
    const profileTitle = isCharacterScope
        ? i18nFormat('Character Override: ${0}', getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar)
        : i18n('Global Orchestration Profile');

    root.find('#luker_orch_profile_target').text(
        activeAvatar
            ? (getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar)
            : i18n('(No character card)'),
    );
    root.find('#luker_orch_profile_mode').text(
        isCharacterScope
            ? (isOverrideEnabled ? i18n('Character override (enabled)') : i18n('Character override (configured, currently disabled)'))
            : i18n('Global profile (no character override for current card)'),
    );
    root.find('#luker_orch_effective_visual').html(renderEditorWorkspace(scope, editor, profileTitle));
    root.find('#luker_orch_clear_character_button').toggle(isCharacterScope);
    root.find('#luker_orch_ai_goal').val(String(uiState.aiGoal || ''));
    root.find('.luker_orch_board').toggle(!singleModeEnabled);
    root.find('#luker_orch_single_mode_hint').toggle(singleModeEnabled);
    root.find('#luker_orch_single_agent_fields').toggle(singleModeEnabled);
}

function updateUiStatus(text) {
    jQuery('#luker_orch_status').text(String(text || ''));
}

function showRunInfoToast(message, { stopLabel = '', onStop = null } = {}) {
    if (typeof toastr === 'undefined') {
        return;
    }
    if (activeRunInfoToast) {
        toastr.clear(activeRunInfoToast);
        activeRunInfoToast = null;
    }
    activeRunInfoToast = toastr.info(String(message || ''), '', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        progressBar: false,
    });
    if (activeRunInfoToast && typeof onStop === 'function') {
        const toastBody = activeRunInfoToast.find('.toast-message');
        if (toastBody.length > 0) {
            const button = jQuery('<button type="button" class="menu_button menu_button_small luker-toast-stop-button"></button>');
            button.text(String(stopLabel || i18n('Stop')));
            button.on('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                button.prop('disabled', true);
                const toastElement = button.closest('.toast');
                clearRunInfoToast();
                if (toastElement && toastElement.length > 0) {
                    toastElement.remove();
                }
                onStop();
            });
            toastBody.append(button);
        }
    }
}

function clearRunInfoToast() {
    if (typeof toastr === 'undefined' || !activeRunInfoToast) {
        return;
    }
    toastr.clear(activeRunInfoToast);
    activeRunInfoToast = null;
}

function showAiBuildToast(message, { stopLabel = '', onStop = null } = {}) {
    if (typeof toastr === 'undefined') {
        return;
    }
    if (activeAiBuildToast) {
        toastr.clear(activeAiBuildToast);
        activeAiBuildToast = null;
    }
    activeAiBuildToast = toastr.info(String(message || ''), '', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: true,
        progressBar: false,
    });
    if (activeAiBuildToast && typeof onStop === 'function') {
        const toastBody = activeAiBuildToast.find('.toast-message');
        if (toastBody.length > 0) {
            const button = jQuery('<button type="button" class="menu_button menu_button_small luker-toast-stop-button"></button>');
            button.text(String(stopLabel || i18n('Stop')));
            button.on('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                button.prop('disabled', true);
                const toastElement = button.closest('.toast');
                clearAiBuildToast();
                if (toastElement && toastElement.length > 0) {
                    toastElement.remove();
                }
                onStop();
            });
            toastBody.append(button);
        }
    }
}

function clearAiBuildToast() {
    if (typeof toastr === 'undefined' || !activeAiBuildToast) {
        return;
    }
    toastr.clear(activeAiBuildToast);
    activeAiBuildToast = null;
}

async function persistGlobalEditorFrom(settings, editor) {
    ensureEditorIntegrity(editor);
    settings.orchestrationSpec = serializeEditorSpec(editor.spec);
    settings.presets = serializeEditorPresetMap(editor.presets);
    await saveSettings();
}

async function persistCharacterEditor(context, settings, avatar, {
    editor = uiState.characterEditor,
    forceEnabled = null,
    notes = null,
} = {}) {
    const target = String(avatar || '');
    if (!target) {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }

    ensureEditorIntegrity(editor);
    const globalPresets = serializeEditorPresetMap(settings.presets);
    const characterPresets = serializeEditorPresetMap(editor.presets);
    const sourceEnabled = typeof editor?.enabled === 'boolean' ? editor.enabled : true;
    const sourceNotes = notes === null ? String(editor?.notes || '') : String(notes || '');
    const presetPatch = buildPresetPatch(globalPresets, characterPresets);
    const overridePayload = {
        enabled: forceEnabled === null ? Boolean(sourceEnabled) : Boolean(forceEnabled),
        spec: serializeEditorSpec(editor.spec),
        presetPatch,
        updatedAt: Date.now(),
        name: getCharacterDisplayNameByAvatar(context, target),
        notes: sourceNotes,
    };

    const previous = getCharacterExtensionDataByAvatar(context, target);
    const nextPayload = {
        ...previous,
        override: overridePayload,
    };
    await context.writeExtensionField(characterIndex, MODULE_NAME, nextPayload);
    return true;
}

function createPortableProfileFromEditor(editor) {
    ensureEditorIntegrity(editor);
    return {
        spec: serializeEditorSpec(editor.spec),
        presets: serializeEditorPresetMap(editor.presets),
    };
}

function parseImportedProfilePayload(rawText) {
    let parsed = null;
    try {
        parsed = JSON.parse(String(rawText || ''));
    } catch {
        throw new Error(i18n('Invalid profile file format.'));
    }
    const profile = parsed && typeof parsed === 'object' && parsed.profile && typeof parsed.profile === 'object'
        ? parsed.profile
        : parsed;
    const spec = sanitizeSpec(profile?.spec);
    const presets = sanitizePresetMap(profile?.presets);
    if (!Array.isArray(spec?.stages) || spec.stages.length === 0 || !presets || Object.keys(presets).length === 0) {
        throw new Error(i18n('Invalid profile file format.'));
    }
    return { spec, presets };
}

function downloadJsonFile(fileName, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = String(fileName || 'orchestration-profile.json');
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function pickJsonFileText() {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        input.addEventListener('change', async () => {
            const file = input.files?.[0] || null;
            input.remove();
            if (!file) {
                resolve(null);
                return;
            }
            try {
                const text = await file.text();
                resolve(text);
            } catch (error) {
                reject(error);
            }
        }, { once: true });
        document.body.appendChild(input);
        input.click();
    });
}

function chooseProfileScopeByConfirm(context, confirmKey) {
    const avatar = String(getCurrentAvatar(context) || '').trim();
    if (avatar) {
        return window.confirm(i18n(confirmKey)) ? 'global' : 'character';
    }
    if (!window.confirm(i18n('No character selected. Use global profile?'))) {
        return null;
    }
    return 'global';
}

function isPresetUsed(editor, presetId) {
    const stages = editor?.spec?.stages || [];
    return stages.some(stage => (stage.nodes || []).some(node => String(node.preset || '') === String(presetId || '')));
}

function buildAiProfileFromToolCalls(toolCalls) {
    const draftStages = [];
    const draftPresets = {};
    let finalizeCalled = false;
    let hasStageUpdate = false;

    const upsertStage = (rawStage) => {
        if (!rawStage || typeof rawStage !== 'object') {
            return;
        }
        const stageId = String(rawStage.id || '').trim();
        if (!stageId) {
            return;
        }
        const mode = String(rawStage.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
        const nodes = Array.isArray(rawStage.nodes) ? rawStage.nodes : [];
        const normalizedNodes = nodes
            .map(rawNode => normalizeNodeSpec(rawNode))
            .filter(node => Boolean(node?.id));
        if (normalizedNodes.length === 0) {
            return;
        }
        const nextStage = { id: stageId, mode, nodes: normalizedNodes };
        const existingIndex = draftStages.findIndex(stage => String(stage.id || '') === stageId);
        if (existingIndex >= 0) {
            draftStages[existingIndex] = nextStage;
        } else {
            draftStages.push(nextStage);
        }
        hasStageUpdate = true;
    };

    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const fnName = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        if (!fnName) {
            continue;
        }
        if (fnName === 'luker_orch_append_stage') {
            upsertStage({
                id: args.stage_id,
                mode: args.mode,
                nodes: args.nodes,
            });
            continue;
        }
        if (fnName === 'luker_orch_upsert_preset') {
            const presetId = String(args.preset_id || '').trim();
            if (!presetId) {
                continue;
            }
            draftPresets[presetId] = {
                systemPrompt: String(args.systemPrompt || '').trim(),
                userPromptTemplate: String(args.userPromptTemplate || '').trim(),
            };
            continue;
        }
        if (fnName === 'luker_orch_finalize_profile') {
            finalizeCalled = true;
        }
    }

    const presetPatch = {};
    for (const [presetId, preset] of Object.entries(draftPresets)) {
        if (!preset || typeof preset !== 'object') {
            continue;
        }
        presetPatch[presetId] = {
            systemPrompt: String(preset.systemPrompt || '').trim(),
            userPromptTemplate: String(preset.userPromptTemplate || '').trim(),
        };
    }

    return {
        orchestrationSpec: sanitizeSpec({ stages: draftStages }),
        presetPatch,
        finalizeCalled,
        hasStageUpdate,
    };
}

async function runAiCharacterProfileBuild(context, settings, { abortSignal = null } = {}) {
    syncCharacterEditorWithActiveAvatar(context);
    const avatar = String(getCurrentAvatar(context) || '').trim();
    const isCharacterMode = Boolean(avatar);
    const characterCard = isCharacterMode
        ? getCharacterCardSnapshot(context, avatar)
        : {
            avatar: '',
            name: 'Global Orchestration Profile',
            description: 'Build a reusable global orchestration profile that works across character cards.',
            personality: '',
            scenario: '',
            system: '',
            first_mes: '',
            mes_example: '',
            creator_notes: '',
        };
    if (isCharacterMode && !characterCard.name) {
        throw new Error('Selected character card is invalid.');
    }

    const currentSpec = sanitizeSpec(settings.orchestrationSpec);
    const currentPresets = serializeEditorPresetMap(settings.presets);
    const suggestSystemPromptBase = String(settings.aiSuggestSystemPrompt || '').trim() || getDefaultAiSuggestSystemPrompt();
    const suggestSystemPrompt = [
        suggestSystemPromptBase,
        'Runtime hard contract (must follow): return COMPLETE tool calls in one response; never return only one tool call.',
        'At minimum include luker_orch_append_stage and luker_orch_finalize_profile in the same response.',
        'luker_orch_finalize_profile must be last.',
        `Must include dedicated required node ids: ${REQUIRED_AI_BUILD_NODE_IDS.join(', ')}.`,
        'Prefer the recommended blueprint unless strong card-specific reasons require deviation.',
        'Do not generate long identity-roleplay blocks for node prompts; keep them process-focused and operational.',
        'When deviating, explicitly optimize for this character card while preserving hard gates and final YAML guidance contract.',
    ].join('\n');
    const suggestUserPrompt = buildAiSuggestInputXml({
        character: characterCard,
        overrideGoal: String(uiState.aiGoal || ''),
        runtimeContextGuarantees: {
            preset_assembly_is_applied: true,
            character_card_context_is_available: true,
            world_info_context_is_available: true,
            recent_messages_are_available: true,
            reminder: 'Do not duplicate static card data in every node; use behavior-focused checks.',
        },
        injectionContract: {
            injected_stage: 'only_last_stage',
            expected_last_stage_mode: 'serial_single_synthesizer_preferred',
            expected_guidance_format: 'runtime_assembled_yaml_from_structured_fields',
            no_json_in_summary: true,
        },
        mandatoryQualityAxes: ORCH_AI_QUALITY_AXES,
        qualityGateContract: {
            continuity: 'No timeline/scene continuity break.',
            causality: 'Actions and consequences must be causally coherent.',
            anti_ooc: 'Prevent role/persona drift and voice collapse.',
            lorebook_compliance: 'Respect active lorebook/world-info constraints as hard writing limits.',
            anti_datafication: 'Reject numeric/data-like roleplay prose and require natural narrative language.',
            anti_report_tone: 'Reject detached report/broadcast cadence; require in-scene vivid narration.',
            anti_overinterpretation: 'Avoid inflated/extreme interpretations without evidence.',
            realism: 'Behavior should remain human-believable and situationally plausible.',
            world_autonomy: 'World events should not always orbit the user.',
        },
        recommendedBlueprint: {
            stages: [
                { id: 'distill', mode: 'serial', nodes: ['distiller'] },
                { id: 'grounding', mode: 'parallel', nodes: ['lorebook_reader', 'anti_data_guard'] },
                { id: 'reason', mode: 'parallel', nodes: ['planner', 'critic', 'recall_relevance'] },
                { id: 'finalize', mode: 'serial', nodes: ['synthesizer'] },
            ],
            role_contracts: {
                distiller: 'Produce compact evidence-grounded state snapshot.',
                lorebook_reader: 'Extract only active lorebook/world-info hard constraints relevant to this turn.',
                anti_data_guard: 'Enforce anti-data hard gates (no quantification/report tone/pseudo-analysis) and produce rewrite-safe guidance.',
                planner: 'Produce causally coherent next-step plan.',
                critic: 'Run hard-gate checks and output minimal fix directives.',
                recall_relevance: 'Pick recalled facts that matter for this turn.',
                synthesizer: 'Merge all prior outputs into one draft-ready final guidance.',
            },
            last_stage_rule: 'Prefer single synthesizer node as final stage output.',
            innovation_policy: {
                baseline_first: true,
                allow_stage_refactor: true,
                allow_node_role_innovation: true,
                must_preserve_hard_gates: true,
                must_preserve_final_yaml_contract: true,
                card_specific_optimization_required: true,
            },
        },
        antiPatterns: {
            no_fixed_identity_roleplay: true,
            no_long_persona_copy_paste: true,
            no_redundant_character_bio_per_node: true,
            no_data_metric_style_wording: true,
            no_json_blob_in_summary: true,
            no_single_tool_call_partial_output: true,
        },
        globalOrchestrationSpec: currentSpec,
        globalPresets: currentPresets,
        toolProtocol: {
            append_stage: {
                function: 'luker_orch_append_stage',
                shape: {
                    stage_id: 'string',
                    mode: 'serial|parallel',
                    nodes: [{ id: 'string', preset: 'string', userPromptTemplate: 'optional string' }],
                },
            },
            upsert_preset: {
                function: 'luker_orch_upsert_preset',
                shape: {
                    preset_id: 'string',
                    systemPrompt: 'string',
                    userPromptTemplate: `Use only: ${ALLOWED_TEMPLATE_VARS.map(x => `{{${x}}}`).join(', ')}`,
                },
            },
            finalize: {
                function: 'luker_orch_finalize_profile',
                shape: { ok: true, summary: 'optional string' },
            },
        },
    });

    const aiSuggestApiPresetName = String(settings.aiSuggestApiPresetName || '').trim();
    const suggestPresetName = String(settings.aiSuggestPresetName || '').trim();
    const promptMessages = buildPresetAwareMessages(
        context,
        settings,
        suggestSystemPrompt,
        suggestUserPrompt,
        {
            api: resolveRequestApiFromConnectionProfileName(context, aiSuggestApiPresetName),
            promptPresetName: suggestPresetName,
        },
    );

    const tools = [
        {
            type: 'function',
            function: {
                name: 'luker_orch_append_stage',
                description: 'Append or replace one orchestration stage.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage_id: { type: 'string' },
                        mode: { type: 'string', enum: ['serial', 'parallel'] },
                        nodes: {
                            type: 'array',
                            items: {
                                anyOf: [
                                    { type: 'string' },
                                    {
                                        type: 'object',
                                        properties: {
                                            id: { type: 'string' },
                                            preset: { type: 'string' },
                                            userPromptTemplate: { type: 'string' },
                                        },
                                        required: ['id', 'preset'],
                                        additionalProperties: false,
                                    },
                                ],
                            },
                        },
                    },
                    required: ['stage_id', 'mode', 'nodes'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_upsert_preset',
                description: 'Define or update one node preset.',
                parameters: {
                    type: 'object',
                    properties: {
                        preset_id: { type: 'string' },
                        systemPrompt: { type: 'string' },
                        userPromptTemplate: { type: 'string' },
                    },
                    required: ['preset_id', 'systemPrompt', 'userPromptTemplate'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_finalize_profile',
                description: 'Finalize the incremental profile construction.',
                parameters: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        summary: { type: 'string' },
                    },
                    additionalProperties: false,
                },
            },
        },
    ];
    const allowedNames = new Set(tools.map(tool => String(tool?.function?.name || '').trim()).filter(Boolean));
    const apiSettingsOverride = buildApiSettingsOverrideFromConnectionProfileName(
        aiSuggestApiPresetName,
        String(context?.chatCompletionSettings?.chat_completion_source || ''),
    );

    updateUiStatus(i18nFormat('Generating orchestration profile for ${0}...', characterCard.name));
    const semanticRetries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
    let parsed = null;
    let lastBuildError = null;
    for (let attempt = 0; attempt <= semanticRetries; attempt++) {
        const reminderText = attempt > 0
            ? [
                `Previous attempt failed: ${String(lastBuildError?.message || 'incomplete tool calls')}`,
                'Return COMPLETE tool calls in one response (not one call).',
                'MUST include luker_orch_append_stage and luker_orch_finalize_profile, with finalize as the last call.',
                `MUST include dedicated nodes: ${REQUIRED_AI_BUILD_NODE_IDS.join(', ')}.`,
            ].join(' ')
            : '';
        const requestPromptMessages = reminderText
            ? mergeUserAddendumIntoPromptMessages(promptMessages, reminderText)
            : promptMessages;
        let toolCalls = [];
        try {
            toolCalls = await requestToolCallsWithRetry(settings, requestPromptMessages, {
                tools,
                allowedNames,
                llmPresetName: suggestPresetName,
                apiSettingsOverride,
                retriesOverride: 0,
                abortSignal,
            });
        } catch (error) {
            if (isAbortError(error, abortSignal)) {
                throw error;
            }
            lastBuildError = error instanceof Error ? error : new Error(String(error || 'unknown error'));
            if (attempt >= semanticRetries) {
                throw lastBuildError;
            }
            console.warn(`[${MODULE_NAME}] AI orchestration build request failed. Retrying semantic pass (${attempt + 1}/${semanticRetries})...`, error);
            continue;
        }
        if (!Array.isArray(toolCalls) || toolCalls.length < 2) {
            lastBuildError = new Error(i18n('AI build must return multiple tool calls in one response.'));
            continue;
        }
        const callNames = toolCalls.map(call => String(call?.name || '').trim()).filter(Boolean);
        if (!callNames.includes('luker_orch_append_stage')) {
            lastBuildError = new Error(i18n('AI build did not provide any stage tool calls.'));
            continue;
        }
        if (callNames[callNames.length - 1] !== 'luker_orch_finalize_profile') {
            lastBuildError = new Error(i18n('AI build did not call finalize explicitly.'));
            continue;
        }
        const candidate = buildAiProfileFromToolCalls(toolCalls);
        if (!candidate || typeof candidate !== 'object') {
            lastBuildError = new Error(i18n('Function output is invalid.'));
            continue;
        }
        if (!candidate.hasStageUpdate) {
            lastBuildError = new Error(i18n('AI build did not provide any stage tool calls.'));
            continue;
        }
        if (!candidate.finalizeCalled) {
            lastBuildError = new Error(i18n('AI build did not call finalize explicitly.'));
            continue;
        }
        parsed = candidate;
        lastBuildError = null;
        break;
    }
    if (!parsed) {
        throw lastBuildError || new Error(i18n('Function output is invalid.'));
    }

    validateAiBuildTemplateVariables(parsed.orchestrationSpec, parsed.presetPatch);

    const suggestedSpec = sanitizeSpec(parsed.orchestrationSpec);
    const suggestedPatch = parsed.presetPatch && typeof parsed.presetPatch === 'object' ? parsed.presetPatch : {};
    const mergedPresets = sanitizePresetMap({
        ...serializeEditorPresetMap(settings.presets),
        ...suggestedPatch,
    });

    if (isCharacterMode) {
        uiState.characterEditor.spec = toEditableSpec(suggestedSpec, mergedPresets);
        uiState.characterEditor.presets = toEditablePresetMap(mergedPresets);
        uiState.characterEditor.enabled = true;

        const persisted = await persistCharacterEditor(context, settings, avatar, { forceEnabled: true });
        if (!persisted) {
            throw new Error(i18n('Failed to persist character override.'));
        }
        return {
            scope: 'character',
            avatar,
            name: getCharacterDisplayNameByAvatar(context, avatar) || characterCard.name,
        };
    }

    uiState.globalEditor.spec = toEditableSpec(suggestedSpec, mergedPresets);
    uiState.globalEditor.presets = toEditablePresetMap(mergedPresets);
    await persistGlobalEditorFrom(settings, uiState.globalEditor);
    uiState.globalEditor = loadGlobalEditorState();
    ensureEditorIntegrity(uiState.globalEditor);
    return {
        scope: 'global',
        avatar: '',
        name: i18n('Global profile'),
    };
}

function bindUi() {
    const context = getContext();
    const settings = getSettings();

    const root = jQuery(`#${UI_BLOCK_ID}`);
    if (!root.length) {
        return;
    }

    initializeUiState(context);
    root.find('#luker_orch_enabled').prop('checked', Boolean(settings.enabled));
    root.find('#luker_orch_single_agent_mode').prop('checked', Boolean(settings.singleAgentModeEnabled));
    root.find('#luker_orch_single_agent_system_prompt').val(String(settings.singleAgentSystemPrompt || DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT));
    root.find('#luker_orch_single_agent_user_prompt').val(String(settings.singleAgentUserPromptTemplate || DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE));
    root.find('#luker_orch_plain_text_calls').prop('checked', isPlainTextFunctionCallModeEnabled(settings));
    root.find('#luker_orch_llm_api_preset').val(String(settings.llmNodeApiPresetName || ''));
    root.find('#luker_orch_llm_preset').val(String(settings.llmNodePresetName || ''));
    root.find('#luker_orch_ai_suggest_api_preset').val(String(settings.aiSuggestApiPresetName || ''));
    root.find('#luker_orch_ai_suggest_preset').val(String(settings.aiSuggestPresetName || ''));
    root.find('#luker_orch_ai_suggest_system_prompt').val(String(settings.aiSuggestSystemPrompt || ''));
    root.find('#luker_orch_max_recent_messages').val(String(settings.maxRecentMessages || 14));
    root.find('#luker_orch_tool_retries').val(String(settings.toolCallRetryMax ?? 2));
    root.find('#luker_orch_capsule_position').val(String(Number(settings.capsuleInjectPosition)));
    root.find('#luker_orch_capsule_depth').val(String(Number(settings.capsuleInjectDepth || 0)));
    root.find('#luker_orch_capsule_role').val(String(Number(settings.capsuleInjectRole)));
    root.find('#luker_orch_capsule_custom_instruction').val(String(settings.capsuleCustomInstruction || ''));
    refreshOpenAIPresetSelectors(root, context, settings);
    renderDynamicPanels(root, context);

    root.off('.lukerOrch');

    root.on('input.lukerOrch', '#luker_orch_enabled', function () {
        settings.enabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.on('input.lukerOrch', '#luker_orch_single_agent_mode', function () {
        settings.singleAgentModeEnabled = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
        renderDynamicPanels(root, context);
    });

    root.on('input.lukerOrch', '#luker_orch_single_agent_system_prompt', function () {
        settings.singleAgentSystemPrompt = String(jQuery(this).val() || '');
        saveSettingsDebounced();
    });

    root.on('input.lukerOrch', '#luker_orch_single_agent_user_prompt', function () {
        settings.singleAgentUserPromptTemplate = String(jQuery(this).val() || '');
        saveSettingsDebounced();
    });

    root.on('input.lukerOrch', '#luker_orch_plain_text_calls', function () {
        settings.plainTextFunctionCallMode = Boolean(jQuery(this).prop('checked'));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_llm_api_preset', function () {
        settings.llmNodeApiPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_llm_preset', function () {
        settings.llmNodePresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_ai_suggest_api_preset', function () {
        settings.aiSuggestApiPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_ai_suggest_preset', function () {
        settings.aiSuggestPresetName = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('input.lukerOrch', '#luker_orch_ai_suggest_system_prompt', function () {
        settings.aiSuggestSystemPrompt = String(jQuery(this).val() || '');
        saveSettingsDebounced();
    });

    root.on('click.lukerOrch', '#luker_orch_reset_ai_prompt', function () {
        if (!window.confirm(i18n('Reset AI build prompt to default? This will overwrite current AI build system prompt.'))) {
            return;
        }
        settings.aiSuggestSystemPrompt = getDefaultAiSuggestSystemPrompt();
        root.find('#luker_orch_ai_suggest_system_prompt').val(settings.aiSuggestSystemPrompt);
        saveSettingsDebounced();
        notifySuccess(i18n('Reset AI build prompt'));
    });

    root.on('change.lukerOrch', '#luker_orch_max_recent_messages', function () {
        settings.maxRecentMessages = Math.max(1, Math.min(80, Number(jQuery(this).val()) || 14));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_tool_retries', function () {
        settings.toolCallRetryMax = Math.max(0, Math.min(10, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_capsule_position', function () {
        const value = Number(jQuery(this).val());
        const allowed = [extension_prompt_types.IN_PROMPT, extension_prompt_types.IN_CHAT, extension_prompt_types.BEFORE_PROMPT];
        settings.capsuleInjectPosition = allowed.includes(value) ? value : extension_prompt_types.IN_CHAT;
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_capsule_depth', function () {
        settings.capsuleInjectDepth = Math.max(0, Math.min(10000, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_capsule_role', function () {
        const value = Number(jQuery(this).val());
        const allowedRoles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
        settings.capsuleInjectRole = allowedRoles.includes(value) ? value : extension_prompt_roles.SYSTEM;
        saveSettingsDebounced();
    });

    root.on('input.lukerOrch', '#luker_orch_capsule_custom_instruction', function () {
        settings.capsuleCustomInstruction = String(jQuery(this).val() || '').trim();
        saveSettingsDebounced();
    });

    root.on('input.lukerOrch', '#luker_orch_ai_goal', function () {
        uiState.aiGoal = String(jQuery(this).val() || '');
    });

    root.on('input.lukerOrch change.lukerOrch', '[data-luker-field]', function () {
        const field = String(jQuery(this).data('luker-field') || '');
        const scope = String(jQuery(this).data('scope') || 'global');
        const stageIndex = Number(jQuery(this).data('stage-index'));
        const nodeIndex = Number(jQuery(this).data('node-index'));
        const presetId = String(jQuery(this).data('preset-id') || '');
        const editor = getEditorByScope(scope);
        ensureEditorIntegrity(editor);

        if (field.startsWith('stage-') && Number.isInteger(stageIndex) && editor.spec.stages[stageIndex]) {
            if (field === 'stage-id') {
                editor.spec.stages[stageIndex].id = String(jQuery(this).val() || '');
            } else if (field === 'stage-mode') {
                editor.spec.stages[stageIndex].mode = String(jQuery(this).val() || 'serial') === 'parallel' ? 'parallel' : 'serial';
            }
            return;
        }

        if (field.startsWith('node-') && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex)) {
            const stage = editor.spec.stages[stageIndex];
            const node = stage?.nodes?.[nodeIndex];
            if (!node) {
                return;
            }
            if (field === 'node-id') {
                node.id = String(jQuery(this).val() || '');
            } else if (field === 'node-preset') {
                node.preset = sanitizeIdentifierToken(jQuery(this).val(), pickDefaultPreset(editor));
            } else if (field === 'node-template') {
                node.userPromptTemplate = String(jQuery(this).val() || '');
            }
            return;
        }

        if (field.startsWith('preset-') && presetId && editor.presets[presetId]) {
            const preset = editor.presets[presetId];
            if (field === 'preset-system-prompt') {
                preset.systemPrompt = String(jQuery(this).val() || '');
            } else if (field === 'preset-user-template') {
                preset.userPromptTemplate = String(jQuery(this).val() || '');
            }
        }
    });

    root.on('click.lukerOrch', '[data-luker-action]', async function () {
        const action = String(jQuery(this).data('luker-action') || '');
        const scope = String(jQuery(this).data('scope') || 'global');
        const stageIndex = Number(jQuery(this).data('stage-index'));
        const nodeIndex = Number(jQuery(this).data('node-index'));
        const presetId = String(jQuery(this).data('preset-id') || '');
        const editor = getEditorByScope(scope);
        ensureEditorIntegrity(editor);

        if (action === 'stage-add') {
            editor.spec.stages.push(createNewStage(editor));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'stage-delete' && Number.isInteger(stageIndex) && editor.spec.stages[stageIndex]) {
            editor.spec.stages.splice(stageIndex, 1);
            if (editor.spec.stages.length === 0) {
                editor.spec.stages.push(createNewStage(editor));
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'stage-move-up' && Number.isInteger(stageIndex) && stageIndex > 0) {
            const [stage] = editor.spec.stages.splice(stageIndex, 1);
            editor.spec.stages.splice(stageIndex - 1, 0, stage);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'stage-move-down' && Number.isInteger(stageIndex) && stageIndex >= 0 && stageIndex < editor.spec.stages.length - 1) {
            const [stage] = editor.spec.stages.splice(stageIndex, 1);
            editor.spec.stages.splice(stageIndex + 1, 0, stage);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-add' && Number.isInteger(stageIndex) && editor.spec.stages[stageIndex]) {
            const defaultPreset = pickDefaultPreset(editor);
            editor.spec.stages[stageIndex].nodes.push({
                id: defaultPreset,
                preset: defaultPreset,
                userPromptTemplate: '',
            });
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-delete' && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex)) {
            const stage = editor.spec.stages[stageIndex];
            if (!stage?.nodes?.[nodeIndex]) {
                return;
            }
            stage.nodes.splice(nodeIndex, 1);
            if (stage.nodes.length === 0) {
                const defaultPreset = pickDefaultPreset(editor);
                stage.nodes.push({
                    id: defaultPreset,
                    preset: defaultPreset,
                    userPromptTemplate: '',
                });
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-move-up' && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex) && nodeIndex > 0) {
            const nodes = editor.spec.stages[stageIndex]?.nodes || [];
            const [node] = nodes.splice(nodeIndex, 1);
            nodes.splice(nodeIndex - 1, 0, node);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'node-move-down' && Number.isInteger(stageIndex) && Number.isInteger(nodeIndex)) {
            const nodes = editor.spec.stages[stageIndex]?.nodes || [];
            if (nodeIndex < 0 || nodeIndex >= nodes.length - 1) {
                return;
            }
            const [node] = nodes.splice(nodeIndex, 1);
            nodes.splice(nodeIndex + 1, 0, node);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'preset-add') {
            const scopeRoot = jQuery(this).closest('[data-luker-scope-root]');
            const input = scopeRoot.find(`[data-luker-new-preset="${scope}"]`);
            const candidate = sanitizeIdentifierToken(input.val(), '');
            if (!candidate) {
                notifyError(i18n('Preset ID cannot be empty.'));
                return;
            }
            if (editor.presets[candidate]) {
                notifyError(i18nFormat("Preset '${0}' already exists.", candidate));
                return;
            }
            editor.presets[candidate] = createPresetDraft();
            input.val('');
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'preset-delete' && presetId) {
            if (!editor.presets[presetId]) {
                return;
            }
            if (isPresetUsed(editor, presetId)) {
                notifyError(i18nFormat("Preset '${0}' is still used by workflow nodes.", presetId));
                return;
            }
            delete editor.presets[presetId];
            ensureEditorIntegrity(editor);
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'reload-current') {
            syncCharacterEditorWithActiveAvatar(context);
            const activeAvatar = String(getCurrentAvatar(context) || '').trim();
            if (hasCharacterOverride(context, activeAvatar)) {
                uiState.characterEditor = loadCharacterEditorState(context, activeAvatar);
                ensureEditorIntegrity(uiState.characterEditor);
                updateUiStatus(i18nFormat('Reloaded character override for ${0}.', getCharacterDisplayNameByAvatar(context, activeAvatar) || 'N/A'));
            } else {
                uiState.globalEditor = loadGlobalEditorState();
                ensureEditorIntegrity(uiState.globalEditor);
                updateUiStatus(i18n('Reloaded global profile from settings.'));
            }
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'reset-global') {
            if (!window.confirm(i18n('Reset global orchestration profile to defaults? This will overwrite current global workflow and presets.'))) {
                return;
            }
            settings.orchestrationSpec = structuredClone(defaultSpec);
            settings.presets = structuredClone(defaultPresets);
            await saveSettings();
            uiState.globalEditor = loadGlobalEditorState();
            ensureEditorIntegrity(uiState.globalEditor);
            notifySuccess(i18n('Global orchestration profile reset to defaults.'));
            updateUiStatus(i18n('Reset global profile to defaults.'));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'save-global') {
            syncCharacterEditorWithActiveAvatar(context);
            const sourceScope = getDisplayedScope(context, settings);
            const sourceEditor = getEditorByScope(sourceScope);
            await persistGlobalEditorFrom(settings, sourceEditor);
            uiState.globalEditor = loadGlobalEditorState();
            ensureEditorIntegrity(uiState.globalEditor);
            notifySuccess(i18n('Global orchestration profile saved.'));
            updateUiStatus(i18n('Saved to global profile.'));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'export-profile') {
            syncCharacterEditorWithActiveAvatar(context);
            const scope = chooseProfileScopeByConfirm(context, 'Select export source: OK = global profile, Cancel = character override.');
            if (!scope) {
                return;
            }
            const avatar = String(getCurrentAvatar(context) || '').trim();
            const editor = scope === 'global'
                ? uiState.globalEditor
                : uiState.characterEditor;
            const profile = createPortableProfileFromEditor(editor);
            const payload = {
                format: 'luker_orchestrator_profile_v1',
                scope,
                exportedAt: new Date().toISOString(),
                profile,
            };
            const safeName = sanitizeIdentifierToken(getCharacterDisplayNameByAvatar(context, avatar) || 'character', 'character');
            const fileName = scope === 'global'
                ? `luker-orchestrator-global.json`
                : `luker-orchestrator-character-${safeName}.json`;
            downloadJsonFile(fileName, payload);
            if (scope === 'global') {
                notifySuccess(i18n('Exported global profile.'));
                updateUiStatus(i18n('Exported global profile.'));
            } else {
                notifySuccess(i18nFormat('Exported character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
                updateUiStatus(i18nFormat('Exported character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
            }
            return;
        }

        if (action === 'import-profile') {
            syncCharacterEditorWithActiveAvatar(context);
            try {
                const fileText = await pickJsonFileText();
                if (!fileText) {
                    return;
                }
                const imported = parseImportedProfilePayload(fileText);
                const scope = chooseProfileScopeByConfirm(context, 'Select import target: OK = global profile, Cancel = character override.');
                if (!scope) {
                    return;
                }
                if (scope === 'global') {
                    settings.orchestrationSpec = sanitizeSpec(imported.spec);
                    settings.presets = sanitizePresetMap(imported.presets);
                    await saveSettings();
                    uiState.globalEditor = loadGlobalEditorState();
                    ensureEditorIntegrity(uiState.globalEditor);
                    notifySuccess(i18n('Imported to global profile.'));
                    updateUiStatus(i18n('Imported to global profile.'));
                } else {
                    const avatar = String(getCurrentAvatar(context) || '').trim();
                    if (!avatar) {
                        notifyError(i18n('No character selected.'));
                        return;
                    }
                    const importedEditor = {
                        spec: toEditableSpec(imported.spec, toEditablePresetMap(imported.presets)),
                        presets: toEditablePresetMap(imported.presets),
                        enabled: true,
                        notes: '',
                    };
                    const ok = await persistCharacterEditor(context, settings, avatar, {
                        editor: importedEditor,
                        forceEnabled: true,
                    });
                    if (!ok) {
                        notifyError(i18n('Failed to persist character override.'));
                        return;
                    }
                    uiState.characterEditor = loadCharacterEditorState(context, avatar);
                    ensureEditorIntegrity(uiState.characterEditor);
                    notifySuccess(i18nFormat('Imported to character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
                    updateUiStatus(i18nFormat('Imported to character override: ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
                }
                renderDynamicPanels(root, context);
            } catch (error) {
                notifyError(i18nFormat('Import failed: ${0}', error?.message || error));
            }
            return;
        }

        if (action === 'save-character') {
            syncCharacterEditorWithActiveAvatar(context);
            const activeAvatar = String(getCurrentAvatar(context) || '').trim();
            if (!activeAvatar) {
                notifyError(i18n('No character selected.'));
                return;
            }
            const sourceScope = getDisplayedScope(context, settings);
            const sourceEditor = getEditorByScope(sourceScope);
            const ok = await persistCharacterEditor(context, settings, activeAvatar, {
                editor: sourceEditor,
                forceEnabled: sourceScope === 'character' ? null : true,
            });
            if (!ok) {
                notifyError(i18n('Failed to persist character override.'));
                return;
            }
            uiState.characterEditor = loadCharacterEditorState(context, activeAvatar);
            ensureEditorIntegrity(uiState.characterEditor);
            notifySuccess(i18n('Character orchestration override saved.'));
            updateUiStatus(i18nFormat('Saved to character override: ${0}.', getCharacterDisplayNameByAvatar(context, activeAvatar)));
            renderDynamicPanels(root, context);
            return;
        }

        if (action === 'clear-character') {
            syncCharacterEditorWithActiveAvatar(context);
            const avatar = String(getCurrentAvatar(context) || '').trim();
            if (!avatar) {
                notifyError(i18n('No character selected.'));
                return;
            }
            const characterIndex = getCharacterIndexByAvatar(context, avatar);
            if (characterIndex < 0) {
                notifyError(i18n('No character selected.'));
                return;
            }
            const previous = getCharacterExtensionDataByAvatar(context, avatar);
            const nextPayload = { ...previous };
            delete nextPayload.override;
            await context.writeExtensionField(characterIndex, MODULE_NAME, nextPayload);
            uiState.characterEditor = loadCharacterEditorState(context, avatar);
            ensureEditorIntegrity(uiState.characterEditor);
            renderDynamicPanels(root, context);
            notifyInfo(i18n('Character orchestration override removed.'));
            updateUiStatus(i18nFormat('Removed character override for ${0}.', getCharacterDisplayNameByAvatar(context, avatar)));
            return;
        }

        if (action === 'ai-suggest-character') {
            const avatar = String(getCurrentAvatar(context) || '').trim();
            const displayName = avatar
                ? (getCharacterDisplayNameByAvatar(context, avatar) || i18n('(No character selected)'))
                : i18n('Global profile');
            const aiBuildAbortController = new AbortController();
            activeAiBuildAbortController = aiBuildAbortController;
            showAiBuildToast(i18nFormat('Generating orchestration profile for ${0}...', displayName), {
                stopLabel: i18n('Stop'),
                onStop: () => {
                    if (!aiBuildAbortController.signal.aborted) {
                        aiBuildAbortController.abort();
                    }
                },
            });
            try {
                const result = await runAiCharacterProfileBuild(context, settings, { abortSignal: aiBuildAbortController.signal });
                renderDynamicPanels(root, context);
                if (result?.scope === 'global') {
                    notifySuccess(i18n('Global orchestration profile generated by AI.'));
                    updateUiStatus(i18nFormat('AI profile generated for ${0}.', i18n('Global profile')));
                } else {
                    notifySuccess(i18n('Character orchestration profile generated by AI.'));
                    const doneName = result?.name || getCharacterDisplayNameByAvatar(context, getCurrentAvatar(context));
                    updateUiStatus(i18nFormat('AI profile generated for ${0}.', doneName));
                }
            } catch (error) {
                if (isAbortError(error, aiBuildAbortController.signal)) {
                    updateUiStatus(i18n('AI profile generation cancelled.'));
                } else {
                    notifyError(i18nFormat('AI profile generation failed: ${0}', error?.message || error));
                    updateUiStatus(i18n('AI profile generation failed.'));
                }
            } finally {
                if (activeAiBuildAbortController === aiBuildAbortController) {
                    activeAiBuildAbortController = null;
                }
                clearAiBuildToast();
            }
        }
    });
}

function ensureUi() {
    const host = jQuery('#extensions_settings2');
    if (!host.length) {
        return;
    }

    if (!jQuery(`#${ORCH_STYLE_ID}`).length) {
        jQuery('head').append(`
<style id="${ORCH_STYLE_ID}">
#${UI_BLOCK_ID} .menu_button,
#${UI_BLOCK_ID} .menu_button_small {
    width: auto;
    min-width: max-content;
    white-space: nowrap;
}
#${UI_BLOCK_ID} .luker_orch_board {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.5));
    border-radius: 10px;
    padding: 10px;
    background: linear-gradient(160deg, rgba(29,46,39,0.28), rgba(21,31,43,0.2));
}
#${UI_BLOCK_ID} .luker_orch_workspace_grid {
    display: grid;
    grid-template-columns: 1.2fr 1fr;
    gap: 10px;
}
#${UI_BLOCK_ID} .luker_orch_workspace_col {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.4));
    border-radius: 8px;
    padding: 8px;
    background: rgba(0,0,0,0.12);
}
#${UI_BLOCK_ID} .luker_orch_col_title {
    font-weight: 600;
    margin-bottom: 6px;
}
#${UI_BLOCK_ID} .luker_orch_stage_card,
#${UI_BLOCK_ID} .luker_orch_preset_card,
#${UI_BLOCK_ID} .luker_orch_node_card {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.4));
    border-radius: 8px;
    padding: 8px;
    margin-bottom: 8px;
    background: rgba(255,255,255,0.02);
}
#${UI_BLOCK_ID} .luker_orch_stage_header,
#${UI_BLOCK_ID} .luker_orch_node_header,
#${UI_BLOCK_ID} .luker_orch_preset_header {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: flex-start;
    margin-bottom: 6px;
}
#${UI_BLOCK_ID} .luker_orch_btnrow {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
}
#${UI_BLOCK_ID} .luker_orch_stage_label {
    font-size: 0.9em;
    opacity: 0.85;
    margin-bottom: 2px;
}
#${UI_BLOCK_ID} .luker_orch_stage_meta,
#${UI_BLOCK_ID} .luker_orch_stage_connector {
    font-size: 0.85em;
    opacity: 0.8;
    margin: 4px 0 8px;
}
#${UI_BLOCK_ID} .luker_orch_nodes_grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 8px;
}
#${UI_BLOCK_ID} .luker_orch_preset_add_row {
    display: flex;
    gap: 6px;
    align-items: center;
}
#${UI_BLOCK_ID} .luker_orch_empty_hint {
    opacity: 0.8;
    font-size: 0.9em;
    padding: 6px;
    border: 1px dashed var(--SmartThemeBorderColor, rgba(130,130,130,0.4));
    border-radius: 8px;
}
#${UI_BLOCK_ID} .luker_orch_character_row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    align-items: end;
    margin-bottom: 8px;
}
@media (max-width: 980px) {
    #${UI_BLOCK_ID} .luker_orch_workspace_grid {
        grid-template-columns: 1fr;
    }
    #${UI_BLOCK_ID} .luker_orch_character_row {
        grid-template-columns: 1fr;
    }
}
</style>`);
    }

    if (jQuery(`#${UI_BLOCK_ID}`).length) {
        bindUi();
        return;
    }

    const html = `
<div id="${UI_BLOCK_ID}" class="extension_container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>${escapeHtml(i18n('Orchestrator'))}</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label class="checkbox_label"><input id="luker_orch_enabled" type="checkbox" /> ${escapeHtml(i18n('Enabled'))}</label>
            <label class="checkbox_label"><input id="luker_orch_single_agent_mode" type="checkbox" /> ${escapeHtml(i18n('Single-agent mode'))}</label>
            <div id="luker_orch_single_agent_fields">
                <label for="luker_orch_single_agent_system_prompt">${escapeHtml(i18n('Single-agent system prompt'))}</label>
                <textarea id="luker_orch_single_agent_system_prompt" class="text_pole textarea_compact" rows="4"></textarea>
                <label for="luker_orch_single_agent_user_prompt">${escapeHtml(i18n('Single-agent user prompt template'))}</label>
                <textarea id="luker_orch_single_agent_user_prompt" class="text_pole textarea_compact" rows="6"></textarea>
            </div>
            <label class="checkbox_label"><input id="luker_orch_plain_text_calls" type="checkbox" /> ${escapeHtml(i18n('Plain-text function-call mode'))}</label>
            <label for="luker_orch_llm_api_preset">${escapeHtml(i18n('LLM node API preset (Connection profile, empty = current)'))}</label>
            <select id="luker_orch_llm_api_preset" class="text_pole"></select>
            <label for="luker_orch_llm_preset">${escapeHtml(i18n('LLM node preset (params + prompt, empty = current)'))}</label>
            <select id="luker_orch_llm_preset" class="text_pole"></select>
            <label for="luker_orch_ai_suggest_api_preset">${escapeHtml(i18n('AI build API preset (Connection profile, empty = current)'))}</label>
            <select id="luker_orch_ai_suggest_api_preset" class="text_pole"></select>
            <label for="luker_orch_ai_suggest_preset">${escapeHtml(i18n('AI build preset (params + prompt, empty = current)'))}</label>
            <select id="luker_orch_ai_suggest_preset" class="text_pole"></select>
            <label for="luker_orch_ai_suggest_system_prompt">${escapeHtml(i18n('AI build system prompt'))}</label>
            <textarea id="luker_orch_ai_suggest_system_prompt" class="text_pole textarea_compact" rows="6"></textarea>
            <div class="flex-container">
                <div id="luker_orch_reset_ai_prompt" class="menu_button menu_button_small">${escapeHtml(i18n('Reset AI build prompt'))}</div>
            </div>
            <label for="luker_orch_max_recent_messages">${escapeHtml(i18n('Recent messages (N)'))}</label>
            <input id="luker_orch_max_recent_messages" class="text_pole" type="number" min="1" max="80" step="1" />
            <label for="luker_orch_tool_retries">${escapeHtml(i18n('Tool-call retries on invalid/missing tool call (N)'))}</label>
            <input id="luker_orch_tool_retries" class="text_pole" type="number" min="0" max="10" step="1" />
            <label for="luker_orch_capsule_position">${escapeHtml(i18n('Capsule injection position'))}</label>
            <select id="luker_orch_capsule_position" class="text_pole">
                <option value="${extension_prompt_types.IN_CHAT}">${escapeHtml(i18n('In-Chat'))}</option>
                <option value="${extension_prompt_types.IN_PROMPT}">${escapeHtml(i18n('In-Prompt (system block)'))}</option>
                <option value="${extension_prompt_types.BEFORE_PROMPT}">${escapeHtml(i18n('Before-Prompt'))}</option>
            </select>
            <label for="luker_orch_capsule_depth">${escapeHtml(i18n('Capsule depth (IN_CHAT only, recommended 1 = before latest message)'))}</label>
            <input id="luker_orch_capsule_depth" class="text_pole" type="number" min="0" max="10000" step="1" />
            <label for="luker_orch_capsule_role">${escapeHtml(i18n('Capsule role (IN_CHAT only)'))}</label>
            <select id="luker_orch_capsule_role" class="text_pole">
                <option value="${extension_prompt_roles.SYSTEM}">${escapeHtml(i18n('System'))}</option>
                <option value="${extension_prompt_roles.USER}">${escapeHtml(i18n('User'))}</option>
                <option value="${extension_prompt_roles.ASSISTANT}">${escapeHtml(i18n('Assistant'))}</option>
            </select>
            <label for="luker_orch_capsule_custom_instruction">${escapeHtml(i18n('Custom capsule instruction (prepended before analysis)'))}</label>
            <textarea id="luker_orch_capsule_custom_instruction" class="text_pole textarea_compact" rows="2" placeholder="${escapeHtml(i18n('e.g. Follow this guidance first, then write final reply in-character.'))}"></textarea>
            <small id="luker_orch_single_mode_hint" style="opacity:0.8">${escapeHtml(i18n('Single-agent mode is enabled. Workflow board is hidden and runtime uses the simplified single node profile.'))}</small>

            <hr>
            <div class="luker_orch_board">
                <div class="luker_orch_character_row">
                    <div>
                        <small>${escapeHtml(i18n('Current card:'))} <span id="luker_orch_profile_target">${escapeHtml(i18n('(No character card)'))}</span></small><br />
                        <small>${escapeHtml(i18n('Editing:'))} <span id="luker_orch_profile_mode">${escapeHtml(i18n('Global profile'))}</span></small>
                    </div>
                    <div>
                        <label for="luker_orch_ai_goal">${escapeHtml(i18n('AI build goal (optional)'))}</label>
                        <textarea id="luker_orch_ai_goal" class="text_pole textarea_compact" rows="2" placeholder="${escapeHtml(i18n('e.g. mystery thriller pacing, strict in-character tone'))}"></textarea>
                        <div class="flex-container">
                            <div class="menu_button menu_button_small" data-luker-action="ai-suggest-character">${escapeHtml(i18n('AI Build Profile'))}</div>
                        </div>
                    </div>
                </div>
                <div id="luker_orch_effective_visual"></div>
                <div class="flex-container">
                    <div class="menu_button" data-luker-action="reload-current">${escapeHtml(i18n('Reload Current'))}</div>
                    <div class="menu_button" data-luker-action="export-profile">${escapeHtml(i18n('Export Profile'))}</div>
                    <div class="menu_button" data-luker-action="import-profile">${escapeHtml(i18n('Import Profile'))}</div>
                    <div class="menu_button" data-luker-action="reset-global">${escapeHtml(i18n('Reset Global'))}</div>
                    <div class="menu_button" data-luker-action="save-global">${escapeHtml(i18n('Save To Global'))}</div>
                    <div class="menu_button" data-luker-action="save-character">${escapeHtml(i18n('Save To Character Override'))}</div>
                    <div id="luker_orch_clear_character_button" class="menu_button" data-luker-action="clear-character">${escapeHtml(i18n('Clear Character Override'))}</div>
                </div>
            </div>

            <small id="luker_orch_status" style="opacity:0.8"></small>
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
    clearCapsulePrompt(context);
    ensureUi();

    if (context.eventTypes.GENERATION_WORLD_INFO_FINALIZED) {
        context.eventSource.on(context.eventTypes.GENERATION_WORLD_INFO_FINALIZED, onWorldInfoFinalized);
    }
    if (context.eventTypes.MESSAGE_DELETED) {
        context.eventSource.on(context.eventTypes.MESSAGE_DELETED, onMessageDeleted);
    }
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
        clearCapsulePrompt(context);
        ensureUi();
    });
});
