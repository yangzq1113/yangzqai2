// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)
// Implementation source: Toolify: Empower any LLM with function calling capabilities. (https://github.com/funnycups/Toolify)

import { extension_prompt_roles, extension_prompt_types, getRequestHeaders, saveSettings, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { sendOpenAIRequest } from '../../openai.js';
import { getStringHash } from '../../utils.js';
import { wi_anchor_position, world_info_position } from '../../world-info.js';
import { getChatCompletionConnectionProfiles, resolveChatCompletionRequestProfile } from '../connection-manager/profile-resolver.js';
import {
    TOOL_PROTOCOL_STYLE,
    extractAllFunctionCalls,
    getResponseMessageContent,
    mergeUserAddendumIntoPromptMessages,
    validateParsedToolCalls,
} from '../function-call-runtime.js';
import { yaml } from '../../../lib.js';

const MODULE_NAME = 'orchestrator';
const CAPSULE_PROMPT_KEY = 'luker_orchestrator_capsule';
const UI_BLOCK_ID = 'orchestrator_settings';
const ORCH_CHAT_STATE_NAMESPACE = 'luker_orchestrator_state';
const ORCH_CHAT_STATE_VERSION = 1;
const DEFAULT_CAPSULE_CUSTOM_INSTRUCTION = 'Follow the orchestration guidance below and prioritize it when drafting the next in-character reply.';
const DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT = 'You are a single-agent orchestration planner for roleplay generation. Produce concise, actionable guidance for the next reply while preserving continuity, character consistency, and world constraints. Before function-call output, provide one concise <thought>...</thought> that reflects your role-specific reasoning.';
const DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE = [
    'Recent chat:',
    '{{recent_chat}}',
    '',
    'Current user message:',
    '{{last_user}}',
    '',
    'Task:',
    '- Use the auto-injected previous orchestration result above as continuity context.',
    '- Distill the immediate narrative state and user intent.',
    '- Provide concrete directives for next reply drafting.',
    '- List key risks to avoid (OOC, continuity breaks, data-like language).',
    '',
    'Return function-call fields only.',
    'Put final injected guidance in field `text` (string).',
    'The `text` content is injected directly as-is.',
].join('\n');
const TEMPLATE_PLACEHOLDER_VARS = ['recent_chat', 'last_user', 'previous_outputs', 'distiller'];
const AUTO_INJECTED_CONTEXT_VARS = ['previous_orchestration'];
const LEGACY_REMOVED_CONTEXT_VARS = ['previous_snapshot'];
const ALLOWED_TEMPLATE_VARS = [...TEMPLATE_PLACEHOLDER_VARS, ...AUTO_INJECTED_CONTEXT_VARS, ...LEGACY_REMOVED_CONTEXT_VARS];
const AI_VISIBLE_TEMPLATE_VARS = [...TEMPLATE_PLACEHOLDER_VARS];
const AUTO_INJECTED_PLACEHOLDER_RUNTIME_NOTE = '(auto-injected above)';
const AUTO_INJECTED_PLACEHOLDER_AI_NOTE = '(auto-injected by runtime before this template)';
const AUTO_INJECTED_PLACEHOLDER_REGEX = new RegExp(`{{\\s*(${AUTO_INJECTED_CONTEXT_VARS.join('|')})\\s*}}`, 'gi');
const LEGACY_REMOVED_PLACEHOLDER_REGEX = new RegExp(`{{\\s*(${LEGACY_REMOVED_CONTEXT_VARS.join('|')})\\s*}}`, 'gi');
const ORCH_ALLOWED_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe', 'impersonate']);
const ORCH_REUSE_GENERATION_TYPES = new Set(['continue', 'regenerate', 'swipe']);
const CAPSULE_INJECT_POSITION_SCHEMA_VERSION = 2;
const ORCH_NODE_TYPE_WORKER = 'worker';
const ORCH_NODE_TYPE_REVIEW = 'review';
const ORCH_REVIEW_TOOL_APPROVE = 'luker_orch_review_approve';
const ORCH_REVIEW_TOOL_RERUN = 'luker_orch_request_rerun';
const SUPPORTED_WORLD_INFO_POSITIONS = Object.freeze([
    world_info_position.before,
    world_info_position.after,
    world_info_position.ANTop,
    world_info_position.ANBottom,
    world_info_position.EMTop,
    world_info_position.EMBottom,
    world_info_position.atDepth,
]);
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

function getDefaultAiSuggestSystemPrompt() {
    return [
        'You design RP multi-agent orchestration profiles for a specific character card.',
        'Use tool calls only. Do not return plain JSON text.',
        'For each generated node preset, explicitly define whether <thought> is required based on that node\'s responsibility.',
        'Reasoning-heavy nodes (e.g. distiller/planner/critic/synthesizer) should require one concise <thought> before tool calls.',
        'Constraint-only or lookup-only nodes may keep <thought> minimal, but the policy must be explicit in prompt text.',
        'Call multiple functions in one response to build the profile incrementally.',
        'Keep stages concise, operational, and easy to run in a single request turn.',
        'Only the LAST stage outputs are injected into the final generation context.',
        'Design a clear pipeline: state distillation -> reasoning workers -> review gate -> final synthesis.',
        'Worker nodes before the final stage should return structured tool-call fields for machine processing.',
        'Review nodes inspect already-executed worker outputs, then either approve or request rerun of specific earlier worker node ids.',
        'Review nodes do not add downstream guidance of their own; later stages keep consuming passthrough worker outputs.',
        'Do not place review nodes in the final stage. Prefer a dedicated serial review stage after the workers it audits.',
        'Last-stage nodes must return function-call payload with a single field `text`.',
        'Runtime injects the `text` content directly as-is (no YAML wrapping).',
        'Do NOT hardcode any fixed narrator persona/identity/roleplay character in system prompts.',
        'Do NOT mirror long single-prompt identity blocks; focus on process quality and constraints.',
        'Runtime context guarantee: both orchestration agents and final generation already see assembled preset context, character card context, and world-info activation context.',
        'Do NOT repeat full character biography in every node prompt. Prefer compact behavior policy and decision criteria.',
        'Each node must have a distinct role, concrete output focus, and minimal overlap.',
        'Prefer practical distiller/planner/critic/synthesizer style agents and add custom presets only when necessary.',
        'Design for robust RP quality: user-intent understanding, character independence, anti-OOC, realism, and world autonomy.',
        'Require explicit hard-gate checks (consistency, OOC, causality, continuity, over-interpretation) in the critic review node.',
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
        `Allowed template placeholders ONLY: ${AI_VISIBLE_TEMPLATE_VARS.map(x => `{{${x}}}`).join(', ')}.`,
        'Do not invent any other placeholder names.',
        'Runtime auto-injects previous orchestration result before each node template.',
        'Do not use placeholders for auto-injected context. Encode how to use it in Task rules.',
        'Placeholder usage policy (must follow):',
        '- Every generated userPromptTemplate should include placeholders needed by that node role; avoid static templates that ignore runtime context.',
        '- Distiller/state nodes should include {{recent_chat}} and {{last_user}}.',
        '- Nodes depending on upstream reasoning should include {{distiller}} and/or {{previous_outputs}}.',
        '- Final synthesizer should generally include {{distiller}} and {{previous_outputs}}.',
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
        { id: 'reason', mode: 'parallel', nodes: ['planner', 'recall_relevance'] },
        { id: 'review', mode: 'serial', nodes: [{ id: 'critic', preset: 'critic', type: ORCH_NODE_TYPE_REVIEW }] },
        { id: 'finalize', mode: 'serial', nodes: ['synthesizer'] },
    ],
};

const defaultPresets = {
    distiller: {
        systemPrompt: 'You are a narrative state distiller. Build a compact, evidence-grounded state snapshot for this turn. Output one concise <thought>...</thought> before your function call.',
        userPromptTemplate: 'Recent chat:\n{{recent_chat}}\n\nCurrent user message:\n{{last_user}}\n\nTask:\n- Use the auto-injected previous orchestration result above as continuity context.\n- Distill user intent, scene state, active tensions, and likely immediate direction.\n- Keep it factual and grounded in visible dialogue/actions.\n- Prefer compact high-signal state, not long prose.\n\nReturn function-call fields only. summary should be concise plain text, not JSON string.',
    },
    lorebook_reader: {
        systemPrompt: 'You are a lorebook compliance reader. Extract only active hard constraints from world-info, especially explicit banned wording/style requirements. Output one concise <thought>...</thought> before your function call.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nRecent chat:\n{{recent_chat}}\n\nTask:\n- Use the auto-injected previous orchestration result above as continuity context.\n- Identify hard constraints that must affect THIS turn (style bans, narration boundaries, role constraints, taboo rules, continuity anchors).\n- Include explicit anti-data constraints from lorebook if present: ban report/observation/analysis tone, ban metric-like phrasing.\n- Keep only high-impact constraints; avoid copying long lorebook prose.\n- Phrase outputs as executable writing directives, not summaries of lorebook documents.\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
    anti_data_guard: {
        systemPrompt: 'You are the anti-data hard gate for RP prose. Block report-style, observation/analysis style, metric style, and weather-broadcast style flat narration. Violations are blockers, not suggestions. Output one concise <thought>...</thought> before your function call.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nPrevious outputs:\n{{previous_outputs}}\n\nTask:\n- Use the auto-injected previous orchestration result above as continuity context.\n- Audit for forbidden data-like patterns: numeric ranges (e.g. 3-5分钟), percentages, KPI/metrics, pseudo-scientific wording, report/bulletin cadence.\n- Audit for forbidden verb/tone families: 观察/分析/评估/统计/监测/检测/实验/推测/记录/汇报 and observation/analyze/evaluate/metric/KPI style.\n- Audit for weather-broadcast tone: detached flat reporting such as “像播报天气预报一样平静”.\n- For every violation, output concrete rewrite directives that convert it to vivid in-scene narrative language.\n- Mark unresolved violations in risks as BLOCKER.\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
    planner: {
        systemPrompt: 'You are a progression planner. Turn current state into a concrete, believable next-step plan. Output one concise <thought>...</thought> before your function call.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nRecent chat:\n{{recent_chat}}\n\nTask:\n- Use the auto-injected previous orchestration result above as continuity context.\n- Propose next-step progression beats with clear causality.\n- Preserve character independence and world autonomy.\n- Avoid making the world revolve around the user by default.\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
    critic: {
        systemPrompt: 'You are a hard-gate critic. Detect quality violations before final drafting. Output one concise <thought>...</thought> before your function call.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nPrevious outputs:\n{{previous_outputs}}\n\nTask:\n- Use the auto-injected previous orchestration result above as continuity context.\n- Review prior agent outputs for continuity, causality, role consistency, OOC risk, over-interpretation, and pacing mismatch.\n- If specific earlier agents must be recomputed, request rerun for only those agent ids.\n- If prior outputs are acceptable, approve immediately.\n- Do not produce any rewritten guidance, summaries, or synthesis of your own.\n\nReturn review tool calls only.',
    },
    recall_relevance: {
        systemPrompt: 'You are a recall relevance analyst. Decide which recalled memory cues should influence this turn. Output one concise <thought>...</thought> before your function call.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nRecent chat:\n{{recent_chat}}\n\nTask:\n- Use the auto-injected previous orchestration result above as continuity context.\n- Identify high-value recalled facts/themes likely to matter now.\n- Prioritize by immediate relevance to current turn goals.\n- Do not invent unseen facts.\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
    synthesizer: {
        systemPrompt: 'You are the final orchestration synthesizer. Produce the single draft-ready guidance for generation. Output one concise <thought>...</thought> before your function call.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nPrevious outputs:\n{{previous_outputs}}\n\nTask:\n- Use the auto-injected previous orchestration result above as continuity context.\n- Merge the approved worker outputs into one coherent final guidance.\n- Preserve lorebook hard constraints and anti-data writing policy in final directives.\n- Prioritize actionable directives and keep risk notes concise.\n- Keep output compact and directly usable for roleplay drafting.\n\nReturn function-call fields only.\nPut final injected guidance in field `text` (string).\nThe `text` content is injected directly as-is.',
    },
};

const defaultSettings = {
    enabled: false,
    singleAgentModeEnabled: false,
    singleAgentSystemPrompt: DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT,
    singleAgentUserPromptTemplate: DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE,
    llmNodeApiPresetName: '',
    llmNodePresetName: '',
    nodeIterationMaxRounds: 3,
    reviewRerunMaxRounds: 2,
    toolCallRetryMax: 2,
    agentTimeoutSeconds: 0,
    maxRecentMessages: 14,
    capsuleInjectPosition: world_info_position.atDepth,
    capsuleInjectDepth: 9999,
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

function normalizeCapsuleInjectPosition(value) {
    const numeric = Number(value);
    return SUPPORTED_WORLD_INFO_POSITIONS.includes(numeric) ? numeric : world_info_position.atDepth;
}

function normalizeCapsuleInjectRole(value) {
    const allowedRoles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
    const numeric = Number(value);
    return allowedRoles.includes(numeric) ? numeric : extension_prompt_roles.SYSTEM;
}

function migrateLegacyCapsuleInjectPosition(value) {
    switch (Number(value)) {
        case extension_prompt_types.BEFORE_PROMPT:
            return world_info_position.before;
        case extension_prompt_types.IN_PROMPT:
            return world_info_position.after;
        case extension_prompt_types.IN_CHAT:
            return world_info_position.atDepth;
        default:
            return world_info_position.atDepth;
    }
}

function appendUniqueWorldInfoBlock(text, block) {
    const existing = String(text || '').trim();
    const incoming = String(block || '').trim();
    if (!incoming) {
        return { text: existing, changed: false };
    }
    if (existing.includes(incoming)) {
        return { text: existing, changed: false };
    }
    return {
        text: [existing, incoming].filter(Boolean).join('\n\n').trim(),
        changed: true,
    };
}

function appendUniqueNoteEntry(targetList, block) {
    const incoming = String(block || '').trim();
    if (!incoming || !Array.isArray(targetList)) {
        return false;
    }
    if (targetList.includes(incoming)) {
        return false;
    }
    targetList.push(incoming);
    return true;
}

function appendUniqueWorldInfoExample(payload, anchorPosition, block) {
    const incoming = String(block || '').trim();
    if (!incoming) {
        return false;
    }
    if (!Array.isArray(payload.worldInfoExamples)) {
        payload.worldInfoExamples = [];
    }
    const normalizedPosition = Number(anchorPosition) === Number(wi_anchor_position.before)
        ? wi_anchor_position.before
        : wi_anchor_position.after;
    if (payload.worldInfoExamples.some((entry) => (
        Number(entry?.position) === Number(normalizedPosition)
        && String(entry?.content || '').trim() === incoming
    ))) {
        return false;
    }
    payload.worldInfoExamples.push({
        position: normalizedPosition,
        content: incoming,
    });
    return true;
}

function injectCapsuleToPayload(payload, text, settings = extension_settings[MODULE_NAME]) {
    if (!payload || typeof payload !== 'object') {
        return false;
    }
    const packet = String(text || '').trim();
    if (!packet) {
        return false;
    }
    const position = normalizeCapsuleInjectPosition(settings?.capsuleInjectPosition);
    if (position === world_info_position.before) {
        const next = appendUniqueWorldInfoBlock(payload.worldInfoBefore, packet);
        payload.worldInfoBefore = next.text;
        return next.changed;
    }
    if (position === world_info_position.after) {
        const next = appendUniqueWorldInfoBlock(payload.worldInfoAfter, packet);
        payload.worldInfoAfter = next.text;
        return next.changed;
    }
    if (position === world_info_position.ANTop) {
        if (!Array.isArray(payload.anBefore)) {
            payload.anBefore = [];
        }
        return appendUniqueNoteEntry(payload.anBefore, packet);
    }
    if (position === world_info_position.ANBottom) {
        if (!Array.isArray(payload.anAfter)) {
            payload.anAfter = [];
        }
        return appendUniqueNoteEntry(payload.anAfter, packet);
    }
    if (position === world_info_position.EMTop) {
        return appendUniqueWorldInfoExample(payload, wi_anchor_position.before, packet);
    }
    if (position === world_info_position.EMBottom) {
        return appendUniqueWorldInfoExample(payload, wi_anchor_position.after, packet);
    }
    const depth = Math.max(0, Math.min(10000, Math.floor(Number(settings?.capsuleInjectDepth) || 0)));
    const role = normalizeCapsuleInjectRole(settings?.capsuleInjectRole);
    if (!Array.isArray(payload.worldInfoDepth)) {
        payload.worldInfoDepth = [];
    }
    let target = payload.worldInfoDepth.find((entry) => (
        Math.max(0, Math.floor(Number(entry?.depth) || 0)) === depth
        && normalizeCapsuleInjectRole(entry?.role) === role
    ));
    if (!target) {
        target = { depth, role, entries: [] };
        payload.worldInfoDepth.push(target);
    } else if (!Array.isArray(target.entries)) {
        target.entries = [];
    }
    target.role = role;
    if (target.entries.includes(packet)) {
        return false;
    }
    target.entries.push(packet);
    return true;
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
        'LLM node preset (params + prompt, empty = current)': 'LLM 节点提示词预设（参数+提示词，留空=当前）',
        'AI build API preset (Connection profile, empty = current)': 'AI 生成 API 预设（连接配置，留空=当前）',
        'AI build preset (params + prompt, empty = current)': 'AI 生成提示词预设（参数+提示词，留空=当前）',
        'AI build system prompt': 'AI 生成系统提示词',
        'Reset AI build prompt': '重置 AI 生成提示词',
        'Reset AI build prompt to default? This will overwrite current AI build system prompt.': '确认重置 AI 生成提示词为默认值？这会覆盖当前内容。',
        'Recent assistant turns for orchestration (N)': '编排阶段可见最近 N 条 Assistant 回复',
        'Node tool iteration max rounds (N)': '节点工具迭代最大轮数（N）',
        'Review rerun max rounds (N)': 'Review 重跑最大轮数（N）',
        'Tool-call retries on invalid/missing tool call (N)': '工具调用重试次数（无效/缺失时）',
        'Per-agent timeout seconds (0 = disabled)': '单 Agent 超时秒数（0=禁用）',
        'Injection position': '注入位置',
        'Before Character Definitions': '角色定义前',
        'After Character Definitions': '角色定义后',
        "Before Author's Note": '作者注释前',
        "After Author's Note": '作者注释后',
        'Before Example Messages': '示例消息前',
        'After Example Messages': '示例消息后',
        'At Chat Depth': '聊天深度',
        'Injection depth (At Chat Depth only)': '注入深度（仅聊天深度位置）',
        'Injection role (At Chat Depth only)': '注入角色（仅聊天深度位置）',
        'Custom orchestration result instruction (prepended before analysis)': '自定义编排结果指令（会放在分析结果前）',
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
        'AI Quick Build': 'AI 快速生成',
        'Open AI Iteration Studio': '打开 AI 迭代工作台',
        'Open Orchestration Editor': '打开编排编辑器',
        'View Last Run': '查看最近一轮',
        'Latest Orchestration Result': '最近编排结果',
        'Edit Result': '编辑结果',
        'Edit latest orchestration result text.': '编辑最近一轮编排结果文本。',
        'Orchestration result cannot be empty.': '编排结果不能为空。',
        'Saved latest orchestration result.': '最近一轮编排结果已保存。',
        'No recent orchestration result available for this chat.': '当前聊天暂无最近编排结果。',
        'Created At': '创建时间',
        'Updated At': '更新时间',
        'AI Iteration Studio': 'AI 迭代工作台',
        'Iteration source: ${0}': '当前迭代来源：${0}',
        'Conversation': '对话',
        'Pending approval': '待审批',
        'Approve changes': '批准执行',
        'Reject changes': '拒绝执行',
        'Pending changes diff': '待审批变更详情',
        'Before': '变更前',
        'After': '变更后',
        'Line diff': '逐行差异',
        'Line diff (+${0} -${1})': '逐行差异（+${0} -${1}）',
        'Expand diff': '放大查看',
        'Close expanded diff': '关闭放大视图',
        '...(${0} more lines)': '...（还有 ${0} 行）',
        'Not set': '未设置',
        'Raw arguments': '原始参数',
        'Operation ${0}': '操作 ${0}',
        'AI suggested changes are waiting for approval.': 'AI 产出的变更正在等待审批。',
        'No editable operations were produced.': '没有产出可执行的变更。',
        'Changes approved and applied.': '已批准并执行变更。',
        'Changes approved and applied. Waiting for your next instruction.': '已批准并执行变更，等待你的下一条指令。',
        'Applying approved changes...': '正在执行已批准的变更...',
        'Running auto-continue...': '正在自动继续迭代...',
        'Changes rejected.': '已拒绝本次变更。',
        'Working profile': '当前编排',
        'Send to AI': '发送给 AI',
        'Stop': '终止',
        'Clear Session': '清空会话',
        'Apply to Global': '应用到全局',
        'Apply to Character': '应用到角色卡',
        'Input request for AI, for example: keep pacing tight and run a simulation with my custom scene...': '输入给 AI 的需求，例如：保持紧凑节奏，并用我提供的场景做一次模拟...',
        'No messages yet. Start by telling AI what you want to optimize.': '还没有对话。先告诉 AI 你希望优化什么。',
        'Auto simulation context (folded)': '自动模拟上下文（已折叠）',
        'Long message (${0} chars)': '长消息（${0} 字符）',
        'Preview': '预览',
        'No character selected. Cannot apply to character override.': '当前未选择角色卡，无法应用到角色卡覆写。',
        'Iteration session applied to global profile.': '迭代会话已应用到全局配置。',
        'Iteration session applied to character override: ${0}.': '迭代会话已应用到角色卡覆写：${0}。',
        'AI iteration is running...': 'AI 迭代处理中...',
        'AI iteration updated.': 'AI 迭代已更新。',
        'Iteration run cancelled.': '迭代已终止。',
        'Iteration run failed: ${0}': '迭代失败：${0}',
        'Iteration session reset.': '迭代会话已重置。',
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
        'Node Type': '节点类型',
        'Worker': '工作节点',
        'Review': '审查节点',
        'Node Prompt Template (optional)': '节点提示词模板（可选）',
        'Use {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}. Previous orchestration result is auto-injected.': '可用 {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}。上轮编排结果会自动注入。',
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
        'LLM node preset (params + prompt, empty = current)': 'LLM 節點提示詞預設（參數+提示詞，留空=目前）',
        'AI build API preset (Connection profile, empty = current)': 'AI 生成 API 預設（連線設定，留空=目前）',
        'AI build preset (params + prompt, empty = current)': 'AI 生成提示詞預設（參數+提示詞，留空=目前）',
        'AI build system prompt': 'AI 生成系統提示詞',
        'Reset AI build prompt': '重置 AI 生成提示詞',
        'Reset AI build prompt to default? This will overwrite current AI build system prompt.': '確認重置 AI 生成提示詞為預設值？這會覆蓋目前內容。',
        'Recent assistant turns for orchestration (N)': '編排階段可見最近 N 條 Assistant 回覆',
        'Node tool iteration max rounds (N)': '節點工具迭代最大輪數（N）',
        'Review rerun max rounds (N)': 'Review 重跑最大輪數（N）',
        'Tool-call retries on invalid/missing tool call (N)': '工具呼叫重試次數（無效/缺失時）',
        'Per-agent timeout seconds (0 = disabled)': '單 Agent 超時秒數（0=禁用）',
        'Injection position': '注入位置',
        'Before Character Definitions': '角色定義前',
        'After Character Definitions': '角色定義後',
        "Before Author's Note": '作者註釋前',
        "After Author's Note": '作者註釋後',
        'Before Example Messages': '示例訊息前',
        'After Example Messages': '示例訊息後',
        'At Chat Depth': '聊天深度',
        'Injection depth (At Chat Depth only)': '注入深度（僅聊天深度位置）',
        'Injection role (At Chat Depth only)': '注入角色（僅聊天深度位置）',
        'Custom orchestration result instruction (prepended before analysis)': '自訂編排結果指令（會放在分析結果前）',
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
        'AI Quick Build': 'AI 快速生成',
        'Open AI Iteration Studio': '開啟 AI 迭代工作台',
        'Open Orchestration Editor': '開啟編排編輯器',
        'View Last Run': '查看最近一輪',
        'Latest Orchestration Result': '最近編排結果',
        'Edit Result': '編輯結果',
        'Edit latest orchestration result text.': '編輯最近一輪編排結果文本。',
        'Orchestration result cannot be empty.': '編排結果不能為空。',
        'Saved latest orchestration result.': '最近一輪編排結果已儲存。',
        'No recent orchestration result available for this chat.': '目前聊天暫無最近編排結果。',
        'Created At': '建立時間',
        'Updated At': '更新時間',
        'AI Iteration Studio': 'AI 迭代工作台',
        'Iteration source: ${0}': '目前迭代來源：${0}',
        'Conversation': '對話',
        'Pending approval': '待審批',
        'Approve changes': '批准執行',
        'Reject changes': '拒絕執行',
        'Pending changes diff': '待審批變更詳情',
        'Before': '變更前',
        'After': '變更後',
        'Line diff': '逐行差異',
        'Line diff (+${0} -${1})': '逐行差異（+${0} -${1}）',
        'Expand diff': '放大查看',
        'Close expanded diff': '關閉放大視圖',
        '...(${0} more lines)': '...（還有 ${0} 行）',
        'Not set': '未設定',
        'Raw arguments': '原始參數',
        'Operation ${0}': '操作 ${0}',
        'AI suggested changes are waiting for approval.': 'AI 產出的變更正在等待審批。',
        'No editable operations were produced.': '沒有產出可執行的變更。',
        'Changes approved and applied.': '已批准並執行變更。',
        'Changes approved and applied. Waiting for your next instruction.': '已批准並執行變更，等待你的下一條指令。',
        'Applying approved changes...': '正在執行已批准的變更...',
        'Running auto-continue...': '正在自動繼續迭代...',
        'Changes rejected.': '已拒絕本次變更。',
        'Working profile': '目前編排',
        'Send to AI': '傳送給 AI',
        'Stop': '終止',
        'Clear Session': '清空會話',
        'Apply to Global': '套用到全域',
        'Apply to Character': '套用到角色卡',
        'Input request for AI, for example: keep pacing tight and run a simulation with my custom scene...': '輸入給 AI 的需求，例如：保持緊湊節奏，並用我提供的場景做一次模擬...',
        'No messages yet. Start by telling AI what you want to optimize.': '尚無對話。先告訴 AI 你希望優化什麼。',
        'Auto simulation context (folded)': '自動模擬上下文（已摺疊）',
        'Long message (${0} chars)': '長訊息（${0} 字符）',
        'Preview': '預覽',
        'No character selected. Cannot apply to character override.': '目前未選擇角色卡，無法套用到角色卡覆寫。',
        'Iteration session applied to global profile.': '迭代會話已套用到全域設定。',
        'Iteration session applied to character override: ${0}.': '迭代會話已套用到角色卡覆寫：${0}。',
        'AI iteration is running...': 'AI 迭代處理中...',
        'AI iteration updated.': 'AI 迭代已更新。',
        'Iteration run cancelled.': '迭代已終止。',
        'Iteration run failed: ${0}': '迭代失敗：${0}',
        'Iteration session reset.': '迭代會話已重置。',
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
        'Node Type': '節點類型',
        'Worker': '工作節點',
        'Review': '審查節點',
        'Node Prompt Template (optional)': '節點提示詞模板（可選）',
        'Use {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}. Previous orchestration result is auto-injected.': '可用 {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}。上輪編排結果會自動注入。',
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

const ORCH_STYLE_ID = 'orchestrator_styles';
const uiState = {
    selectedAvatar: '',
    aiGoal: '',
    globalEditor: null,
    characterEditor: null,
    aiIterationSession: null,
    orchEditorPopupContentId: '',
};
let orchInFlight = false;
let activeRunInfoToast = null;
let activeAiBuildToast = null;
let activeAiIterationAbortController = null;
let activeOrchRunAbortController = null;
let activeAiBuildAbortController = null;
let latestOrchestrationSnapshot = null;
let loadedChatStateKey = '';

function cloneDefault(value) {
    return Array.isArray(value) || typeof value === 'object' ? structuredClone(value) : value;
}

function normalizeNodeType(value) {
    return String(value || '').trim().toLowerCase() === ORCH_NODE_TYPE_REVIEW
        ? ORCH_NODE_TYPE_REVIEW
        : ORCH_NODE_TYPE_WORKER;
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
                        type: normalizeNodeType(node.type),
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
    if (!presets || typeof presets !== 'object') {
        return {};
    }

    const normalized = {};
    for (const [key, value] of Object.entries(presets)) {
        if (!value || typeof value !== 'object') {
            continue;
        }
        const presetId = sanitizeIdentifierToken(key, '');
        if (!presetId) {
            continue;
        }
        normalized[presetId] = {
            systemPrompt: String(value.systemPrompt || '').trim(),
            userPromptTemplate: String(value.userPromptTemplate || '').trim(),
        };
    }

    return normalized;
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
    delete extension_settings[MODULE_NAME].plainTextFunctionCallMode;

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
    const hasCapsuleInjectPositionSchemaVersion = Object.prototype.hasOwnProperty.call(
        extension_settings[MODULE_NAME],
        'capsuleInjectPositionSchemaVersion',
    );
    if (!hasCapsuleInjectPositionSchemaVersion) {
        extension_settings[MODULE_NAME].capsuleInjectPosition = migrateLegacyCapsuleInjectPosition(
            extension_settings[MODULE_NAME].capsuleInjectPosition,
        );
    }
    extension_settings[MODULE_NAME].capsuleInjectPosition = normalizeCapsuleInjectPosition(
        extension_settings[MODULE_NAME].capsuleInjectPosition,
    );
    extension_settings[MODULE_NAME].capsuleInjectPositionSchemaVersion = CAPSULE_INJECT_POSITION_SCHEMA_VERSION;
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
    extension_settings[MODULE_NAME].nodeIterationMaxRounds = Math.max(
        1,
        Math.min(20, Math.floor(Number(extension_settings[MODULE_NAME].nodeIterationMaxRounds) || 0)),
    );
    extension_settings[MODULE_NAME].reviewRerunMaxRounds = Math.max(
        0,
        Math.min(20, Math.floor(Number(extension_settings[MODULE_NAME].reviewRerunMaxRounds) || 0)),
    );
    extension_settings[MODULE_NAME].agentTimeoutSeconds = Math.max(
        0,
        Math.min(3600, Math.floor(Number(extension_settings[MODULE_NAME].agentTimeoutSeconds) || 0)),
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

function normalizeOrchestrationSnapshot(raw) {
    const source = raw && typeof raw === 'object' ? raw : null;
    if (!source) {
        return null;
    }
    const capsuleText = String(source.capsuleText || '').trim();
    if (!capsuleText) {
        return null;
    }
    return {
        chatKey: String(source.chatKey || '').trim(),
        anchorFloor: Number(source.anchorFloor || 0),
        anchorPlayableFloor: Number(source.anchorPlayableFloor || 0),
        anchorHash: String(source.anchorHash || '').trim(),
        capsuleText,
        updatedAt: String(source.updatedAt || '').trim(),
        targetLayer: Number(source.targetLayer || 0),
        stageOutputs: Array.isArray(source.stageOutputs) ? structuredClone(source.stageOutputs) : [],
    };
}

function normalizeOrchestratorChatState(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        version: Number(source.version || ORCH_CHAT_STATE_VERSION),
        snapshot: normalizeOrchestrationSnapshot(source.snapshot),
    };
}

async function loadOrchestratorChatState(context, { force = false } = {}) {
    const chatKey = getChatKey(context);
    if (!chatKey) {
        latestOrchestrationSnapshot = null;
        loadedChatStateKey = '';
        return;
    }
    if (!force && loadedChatStateKey === chatKey) {
        return;
    }

    let payload = null;
    if (typeof context?.getChatState === 'function') {
        payload = await context.getChatState(ORCH_CHAT_STATE_NAMESPACE, {});
    }
    const normalized = normalizeOrchestratorChatState(payload);
    latestOrchestrationSnapshot = normalized.snapshot;
    loadedChatStateKey = chatKey;
}

async function persistOrchestratorChatState(context) {
    const chatKey = getChatKey(context);
    if (!chatKey || typeof context?.updateChatState !== 'function') {
        return;
    }
    loadedChatStateKey = chatKey;
    const snapshot = normalizeOrchestrationSnapshot(latestOrchestrationSnapshot);
    await context.updateChatState(ORCH_CHAT_STATE_NAMESPACE, () => ({
        version: ORCH_CHAT_STATE_VERSION,
        snapshot,
    }), { maxOperations: 2000, maxRetries: 1 });
}

function getPreviousOrchestrationSnapshotText(context, payload) {
    const chatKey = getChatKey(context);
    const snapshot = normalizeOrchestrationSnapshot(latestOrchestrationSnapshot);
    if (!snapshot || String(snapshot.chatKey || '') !== String(chatKey || '')) {
        return '';
    }
    const currentTargetLayer = getTargetAssistantLayer(payload);
    const expectedPreviousLayer = Math.max(currentTargetLayer - 1, 0);
    const storedLayer = Number(snapshot.targetLayer || 0);
    if (expectedPreviousLayer <= 0 || storedLayer !== expectedPreviousLayer) {
        return '';
    }
    return toReadableYamlText({
        updated_at: String(snapshot.updatedAt || ''),
        stage_outputs: Array.isArray(snapshot.stageOutputs) ? snapshot.stageOutputs : [],
    }, '{}');
}

function getLatestOrchestrationEntry(context) {
    const chatKey = getChatKey(context);
    if (!latestOrchestrationSnapshot || typeof latestOrchestrationSnapshot !== 'object') {
        return null;
    }
    if (String(latestOrchestrationSnapshot.chatKey || '') !== String(chatKey || '')) {
        return null;
    }
    const injectedText = String(latestOrchestrationSnapshot.capsuleText || '').trim();
    if (!injectedText) {
        return null;
    }
    return {
        updatedAt: String(latestOrchestrationSnapshot.updatedAt || '').trim(),
        injectedText,
    };
}

function clearLastOrchestrationSnapshot(context, { persist = false } = {}) {
    const chatKey = getChatKey(context);
    if (!latestOrchestrationSnapshot || typeof latestOrchestrationSnapshot !== 'object') {
        return;
    }
    if (String(latestOrchestrationSnapshot.chatKey || '') === String(chatKey || '')) {
        latestOrchestrationSnapshot = null;
        if (persist) {
            void persistOrchestratorChatState(context);
        }
    }
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
    const chatKey = getChatKey(context);
    const snapshot = normalizeOrchestrationSnapshot(latestOrchestrationSnapshot);
    if (!snapshot) {
        return '';
    }
    if (String(snapshot.chatKey || '') !== String(chatKey || '')) {
        return '';
    }
    const currentTargetLayer = getTargetAssistantLayer(payload);
    const expectedPreviousLayer = Math.max(currentTargetLayer - 1, 0);
    const storedLayer = Number(snapshot.targetLayer || 0);
    if (expectedPreviousLayer <= 0 || storedLayer !== expectedPreviousLayer) {
        return '';
    }
    return String(snapshot.capsuleText || '').trim();
}

function formatReadableTimestamp(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return i18n('Not set');
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        return raw;
    }
    try {
        return parsed.toLocaleString();
    } catch {
        return raw;
    }
}

function renderLastOrchestrationResultHtml(context) {
    const entry = getLatestOrchestrationEntry(context);
    if (!entry || typeof entry !== 'object') {
        return `<div class="luker_orch_last_run_empty">${escapeHtml(i18n('No recent orchestration result available for this chat.'))}</div>`;
    }

    const updatedAt = String(entry.updatedAt || '').trim() || i18n('Not set');
    const injectedText = String(entry.injectedText || '').trim();

    return `
<div class="luker_orch_last_run_popup">
    <div class="luker_orch_last_run_meta"><b>${escapeHtml(i18n('Updated At'))}</b>：${escapeHtml(updatedAt)}</div>
    <pre class="luker_orch_last_run_capsule">${escapeHtml(injectedText || i18n('Not set'))}</pre>
</div>`;
}

async function editLastOrchestrationResult(context) {
    await loadOrchestratorChatState(context, { force: false });
    const entry = getLatestOrchestrationEntry(context);
    if (!entry || typeof entry !== 'object') {
        notifyError(i18n('No recent orchestration result available for this chat.'));
        return false;
    }

    const input = await context.callGenericPopup(
        i18n('Edit latest orchestration result text.'),
        context.POPUP_TYPE.INPUT,
        String(entry.injectedText || ''),
        {
            rows: 16,
            wide: true,
            wider: true,
            large: true,
            okButton: i18n('Save'),
            cancelButton: i18n('Cancel'),
        },
    );
    if (typeof input !== 'string') {
        return false;
    }

    const nextText = String(input || '').trim();
    if (!nextText) {
        notifyError(i18n('Orchestration result cannot be empty.'));
        return false;
    }

    const chatKey = getChatKey(context);
    if (!latestOrchestrationSnapshot || typeof latestOrchestrationSnapshot !== 'object') {
        notifyError(i18n('No recent orchestration result available for this chat.'));
        return false;
    }
    if (String(latestOrchestrationSnapshot.chatKey || '') !== String(chatKey || '')) {
        notifyError(i18n('No recent orchestration result available for this chat.'));
        return false;
    }

    latestOrchestrationSnapshot = {
        ...latestOrchestrationSnapshot,
        capsuleText: nextText,
        updatedAt: new Date().toISOString(),
    };
    clearCapsulePrompt(context);
    await persistOrchestratorChatState(context);
    notifySuccess(i18n('Saved latest orchestration result.'));
    updateUiStatus(i18n('Saved latest orchestration result.'));
    return true;
}

async function openLastOrchestrationResult(context) {
    await loadOrchestratorChatState(context, { force: false });
    const hasEntry = Boolean(getLatestOrchestrationEntry(context));
    const editButtonResult = context?.POPUP_RESULT?.CUSTOM1 ?? 2;
    const popupResult = await context.callGenericPopup(
        renderLastOrchestrationResultHtml(context),
        context.POPUP_TYPE.TEXT,
        i18n('Latest Orchestration Result'),
        {
            wide: true,
            wider: true,
            large: true,
            allowVerticalScrolling: true,
            okButton: i18n('Close'),
            customButtons: hasEntry
                ? [{ text: i18n('Edit Result'), result: editButtonResult, appendAtEnd: true }]
                : [],
        },
    );
    if (popupResult === editButtonResult) {
        const saved = await editLastOrchestrationResult(context);
        if (saved) {
            await openLastOrchestrationResult(context);
        }
    }
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

    const avatar = String(context.characters?.[context.characterId]?.avatar || '').trim();
    const chatId = String(context.chatId || context.getCurrentChatId?.() || '').trim();
    if (!avatar || !chatId) {
        return '';
    }
    return `char:${avatar}:${chatId}`;
}

function abortActiveOrchestratorRun() {
    if (activeOrchRunAbortController && !activeOrchRunAbortController.signal.aborted) {
        activeOrchRunAbortController.abort();
    }
    clearRunInfoToast();
}

function getCoreMessages(payload) {
    return Array.isArray(payload?.coreChat) ? payload.coreChat : [];
}

function getRecentMessages(messages, assistantTurns) {
    const source = Array.isArray(messages) ? messages : [];
    const targetTurns = Math.max(1, Math.floor(Number(assistantTurns) || 1));

    let matchedTurns = 0;
    let startIndex = -1;
    for (let i = source.length - 1; i >= 0; i -= 1) {
        const message = source[i];
        if (!message || message.is_system) {
            continue;
        }
        if (!message.is_user) {
            matchedTurns += 1;
            if (matchedTurns >= targetTurns) {
                startIndex = i;
                break;
            }
        }
    }

    if (startIndex < 0) {
        return source.slice();
    }

    // Include user message(s) immediately before the cutoff assistant turn.
    while (startIndex > 0) {
        const prev = source[startIndex - 1];
        if (!prev || prev.is_system || !prev.is_user) {
            break;
        }
        startIndex -= 1;
    }

    return source.slice(startIndex);
}

function extractLastUserMessage(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.is_user) {
            return { index: i, message: messages[i] };
        }
    }

    return { index: -1, message: null };
}

function buildAnchorHashSource(messages, endIndex) {
    return messages
        .slice(0, endIndex + 1)
        .filter(item => item && !item.is_system)
        .map((item, index) => JSON.stringify({
            playable_seq: index + 1,
            role: item.is_user ? 'user' : 'assistant',
            name: String(item.name ?? ''),
            text: String(item.mes ?? ''),
            type: String(item.extra?.type ?? ''),
            bias: String(item.extra?.bias ?? ''),
        }))
        .join('\n');
}

function buildLastUserAnchorFromMessages(messages) {
    const { index, message } = extractLastUserMessage(messages);
    if (index < 0 || !message) {
        return null;
    }
    const hashSource = buildAnchorHashSource(messages, index);
    const playableFloor = messages
        .slice(0, index + 1)
        .reduce((count, item) => count + (item && !item.is_system ? 1 : 0), 0);
    return {
        floor: index + 1,
        playableFloor,
        hash: String(getStringHash(hashSource)),
    };
}

function buildLastUserAnchor(context, payloadMessages) {
    const contextMessages = Array.isArray(context?.chat) ? context.chat : [];
    const contextAnchor = buildLastUserAnchorFromMessages(contextMessages);
    if (contextAnchor) {
        return contextAnchor;
    }

    return buildLastUserAnchorFromMessages(payloadMessages);
}

function canReuseLatestOrchestrationSnapshot(chatKey, anchor) {
    if (!latestOrchestrationSnapshot || typeof latestOrchestrationSnapshot !== 'object') {
        return false;
    }
    if (!anchor || typeof anchor !== 'object') {
        return false;
    }
    if (String(latestOrchestrationSnapshot.chatKey || '') !== String(chatKey || '')) {
        return false;
    }
    const storedFloor = Number(latestOrchestrationSnapshot.anchorFloor);
    const incomingFloor = Number(anchor.floor);
    const storedPlayableFloor = Number(latestOrchestrationSnapshot.anchorPlayableFloor);
    const incomingPlayableFloor = Number(anchor.playableFloor);
    const floorMatched = Number.isFinite(storedPlayableFloor) && Number.isFinite(incomingPlayableFloor)
        ? storedPlayableFloor === incomingPlayableFloor
        : storedFloor === incomingFloor;
    return floorMatched
        && String(latestOrchestrationSnapshot.anchorHash || '') === String(anchor.hash || '');
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
        const overridePresets = resolveOverridePresetMap(chatOverride, settings.presets);
        const editablePresets = toEditablePresetMap(overridePresets);
        const editableSpec = toEditableSpec(chatOverride.spec, editablePresets);
        return {
            source: 'chat',
            key: chatKey,
            spec: sanitizeSpec(editableSpec),
            presets: sanitizePresetMap(editablePresets),
        };
    }

    const avatar = getCurrentAvatar(context);
    const characterOverride = getCharacterOverrideByAvatar(context, avatar);
    if (characterOverride?.enabled && characterOverride?.spec) {
        const overridePresets = resolveOverridePresetMap(characterOverride, settings.presets);
        const editablePresets = toEditablePresetMap(overridePresets);
        const editableSpec = toEditableSpec(characterOverride.spec, editablePresets);
        return {
            source: 'character',
            key: avatar,
            spec: sanitizeSpec(editableSpec),
            presets: sanitizePresetMap(editablePresets),
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
            type: ORCH_NODE_TYPE_WORKER,
            userPromptTemplate: undefined,
        };
    }

    const id = String(node?.id || node?.node || node?.preset || '').trim();
    const preset = String(node?.preset || id).trim();
    return {
        id: id || preset,
        preset,
        type: normalizeNodeType(node?.type),
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

function createAbortError(message = 'Operation aborted.') {
    try {
        return new DOMException(String(message || 'Operation aborted.'), 'AbortError');
    } catch {
        const error = new Error(String(message || 'Operation aborted.'));
        error.name = 'AbortError';
        return error;
    }
}

function throwIfAborted(abortSignal, message = 'Operation aborted.') {
    if (isAbortSignalLike(abortSignal) && abortSignal.aborted) {
        throw createAbortError(message);
    }
}

function isNoToolCallExtractionError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (!message) {
        return false;
    }
    return message.includes('did not return any tool call')
        || message.includes('none matched expected function names')
        || message.includes('returned empty text response')
        || message.includes('did not contain parseable function calls json');
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

function getAgentTimeoutMs(settings) {
    const seconds = Math.max(0, Math.min(3600, Math.floor(Number(settings?.agentTimeoutSeconds) || 0)));
    return seconds > 0 ? seconds * 1000 : 0;
}

function createAttemptAbortController(baseAbortSignal = null, timeoutMs = 0) {
    const timeoutController = new AbortController();
    let didTimeout = false;
    let timeoutId = null;

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutId = setTimeout(() => {
            didTimeout = true;
            if (!timeoutController.signal.aborted) {
                timeoutController.abort();
            }
        }, timeoutMs);
    }

    const linked = linkAbortSignals(baseAbortSignal, timeoutController.signal);

    return {
        signal: linked.signal,
        didTimeout: () => didTimeout,
        cleanup: () => {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            linked.cleanup();
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
    applyAgentTimeout = true,
} = {}) {
    const fnName = String(functionName || '').trim();
    if (!fnName) {
        throw new Error('Function name is required.');
    }

    const retries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
    const timeoutMs = applyAgentTimeout ? getAgentTimeoutMs(settings) : 0;
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
        const attemptController = createAttemptAbortController(
            isAbortSignalLike(abortSignal) ? abortSignal : null,
            timeoutMs,
        );
        try {
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const requestOptions = {
                tools,
                toolChoice,
                replaceTools: true,
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
                requestScope: 'extension_internal',
                functionCallOptions: {
                    requiredFunctionName: fnName,
                    strictTwoPart: true,
                    protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
                },
            };
            const responseData = await sendOpenAIRequest('quiet', promptMessages, attemptController.signal, {
                ...requestOptions,
            });
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const calls = extractAllFunctionCalls(responseData, [fnName]);
            const validationError = validateParsedToolCalls(calls, tools);
            if (validationError) {
                throw new Error(validationError);
            }
            const matched = calls.find(call => String(call?.name || '') === fnName);
            if (!matched) {
                throw new Error(`Model returned tool call, but not '${fnName}'.`);
            }
            return matched.args;
        } catch (error) {
            const timedOut = attemptController.didTimeout();
            const sourceAborted = isAbortError(error, abortSignal);
            if (sourceAborted && !timedOut) {
                throw error;
            }
            const effectiveError = timedOut
                ? Object.assign(new Error(`Agent call '${fnName}' timed out after ${Math.floor(timeoutMs / 1000)}s.`), { name: 'TimeoutError' })
                : error;
            lastError = effectiveError;
            if (attempt >= retries) {
                throw effectiveError;
            }
            console.warn(`[${MODULE_NAME}] Tool call '${fnName}' failed. Retrying (${attempt + 1}/${retries})...`, effectiveError);
        } finally {
            attemptController.cleanup();
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
    includeAssistantText = false,
    allowNoToolCalls = false,
    applyAgentTimeout = true,
} = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error('Tools are required.');
    }

    const retriesSource = retriesOverride === null || retriesOverride === undefined
        ? Number(settings?.toolCallRetryMax)
        : Number(retriesOverride);
    const retries = Math.max(0, Math.min(10, Math.floor(retriesSource || 0)));
    const timeoutMs = applyAgentTimeout ? getAgentTimeoutMs(settings) : 0;
    const toolChoice = 'auto';
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const attemptController = createAttemptAbortController(
            isAbortSignalLike(abortSignal) ? abortSignal : null,
            timeoutMs,
        );
        try {
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const requestOptions = {
                tools,
                toolChoice,
                replaceTools: true,
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
                requestScope: 'extension_internal',
                functionCallOptions: {
                    strictTwoPart: true,
                    protocolStyle: TOOL_PROTOCOL_STYLE.JSON_SCHEMA,
                },
            };
            const responseData = await sendOpenAIRequest('quiet', promptMessages, attemptController.signal, {
                ...requestOptions,
            });
            throwIfAborted(abortSignal, 'Orchestration aborted.');
            const assistantText = getResponseMessageContent(responseData);
            let calls = [];
            try {
                calls = extractAllFunctionCalls(responseData, allowedNames);
            } catch (error) {
                if (allowNoToolCalls && assistantText && isNoToolCallExtractionError(error)) {
                    if (includeAssistantText) {
                        return {
                            toolCalls: [],
                            assistantText,
                            rawAssistantText: assistantText,
                        };
                    }
                    return [];
                }
                throw error;
            }
            const validationError = validateParsedToolCalls(calls, tools);
            if (validationError) {
                throw new Error(validationError);
            }
            if (includeAssistantText) {
                return {
                    toolCalls: calls,
                    assistantText,
                    rawAssistantText: assistantText,
                };
            }
            return calls;
        } catch (error) {
            const timedOut = attemptController.didTimeout();
            const sourceAborted = isAbortError(error, abortSignal);
            if (sourceAborted && !timedOut) {
                throw error;
            }
            const effectiveError = timedOut
                ? Object.assign(new Error(`Multi tool call request timed out after ${Math.floor(timeoutMs / 1000)}s.`), { name: 'TimeoutError' })
                : error;
            lastError = effectiveError;
            if (attempt >= retries) {
                throw effectiveError;
            }
            console.warn(`[${MODULE_NAME}] Multi tool call request failed. Retrying (${attempt + 1}/${retries})...`, effectiveError);
        } finally {
            attemptController.cleanup();
        }
    }
    throw lastError || new Error('Multi tool call request failed.');
}

function replaceAutoInjectedTemplatePlaceholders(template, replacement = '') {
    const source = String(template || '');
    if (!source) {
        return '';
    }
    return source.replace(AUTO_INJECTED_PLACEHOLDER_REGEX, String(replacement || ''));
}

function replaceLegacyRemovedTemplatePlaceholders(template, replacement = '') {
    const source = String(template || '');
    if (!source) {
        return '';
    }
    return source.replace(LEGACY_REMOVED_PLACEHOLDER_REGEX, String(replacement || ''));
}

function normalizeTemplateForRuntime(template) {
    const withAutoInjected = replaceAutoInjectedTemplatePlaceholders(template, AUTO_INJECTED_PLACEHOLDER_RUNTIME_NOTE);
    return replaceLegacyRemovedTemplatePlaceholders(withAutoInjected, '');
}

function normalizeTemplateForAiPrompt(template) {
    const withAutoInjected = replaceAutoInjectedTemplatePlaceholders(template, AUTO_INJECTED_PLACEHOLDER_AI_NOTE);
    return replaceLegacyRemovedTemplatePlaceholders(withAutoInjected, '');
}

function sanitizeProfileForAiPrompt(profile = null) {
    const safeSpec = sanitizeSpec(profile?.spec);
    const safePresets = sanitizePresetMap(profile?.presets);
    const stages = Array.isArray(safeSpec?.stages) ? safeSpec.stages : [];
    const sanitizedStages = stages.map((stage) => {
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const sanitizedNodes = nodes.map((rawNode) => {
            if (typeof rawNode === 'string') {
                return rawNode;
            }
            const node = normalizeNodeSpec(rawNode);
            const nextNode = {
                id: String(node?.id || '').trim(),
                preset: String(node?.preset || node?.id || '').trim(),
                type: normalizeNodeType(node?.type),
            };
            const template = String(node?.userPromptTemplate || '');
            if (template.trim()) {
                nextNode.userPromptTemplate = normalizeTemplateForAiPrompt(template);
            }
            return nextNode.id ? nextNode : null;
        }).filter(Boolean);
        return {
            id: String(stage?.id || '').trim(),
            mode: String(stage?.mode || '').toLowerCase() === 'parallel' ? 'parallel' : 'serial',
            nodes: sanitizedNodes,
        };
    });

    const sanitizedPresets = {};
    for (const [presetId, preset] of Object.entries(safePresets || {})) {
        sanitizedPresets[presetId] = {
            systemPrompt: String(preset?.systemPrompt || '').trim(),
            userPromptTemplate: normalizeTemplateForAiPrompt(String(preset?.userPromptTemplate || '').trim()),
        };
    }

    return {
        spec: { stages: sanitizedStages },
        presets: sanitizedPresets,
    };
}

function buildAutoInjectedNodePromptPrelude({
    previousOrchestration = '',
} = {}) {
    const orchestrationText = String(previousOrchestration || '').trim();
    const sections = [];
    if (orchestrationText) {
        sections.push([
            '## auto_injected_previous_orchestration_capsule',
            '```text',
            orchestrationText,
            '```',
        ].join('\n'));
    }
    return sections.join('\n\n');
}

function renderTemplate(template, vars) {
    const safeVars = vars && typeof vars === 'object' ? vars : {};
    const replacements = {
        recent_chat: String(safeVars.recent_chat || ''),
        last_user: String(safeVars.last_user || ''),
        previous_outputs: String(safeVars.previous_outputs || ''),
        distiller: String(safeVars.distiller || ''),
        previous_snapshot: String(safeVars.previous_snapshot || ''),
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

function toReadableYamlText(value, fallback = '{}') {
    try {
        const normalized = value === undefined ? null : value;
        const text = yaml.stringify(normalized, { indent: 2, lineWidth: 0 });
        const trimmed = String(text || '').trim();
        return trimmed || fallback;
    } catch {
        return toCompactJsonText(value, fallback);
    }
}

function buildYamlMarkdownBlock(title, note, value) {
    const yamlText = toReadableYamlText(value);
    return [
        `## ${title}`,
        String(note || '').trim(),
        '```yaml',
        yamlText,
        '```',
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
        '# Orchestration Build Input',
        'Read all sections before calling tools. Keep edits practical and implementation-oriented.',
        buildYamlMarkdownBlock('character_profile', 'Current active character card snapshot.', character),
        buildYamlMarkdownBlock('override_goal', 'Optional user goal override for this character profile.', { override_goal: String(overrideGoal || '') }),
        buildYamlMarkdownBlock('runtime_context_guarantees', 'What runtime context is already guaranteed for both orchestration nodes and final generation.', runtimeContextGuarantees),
        buildYamlMarkdownBlock('injection_contract', 'How final orchestration outputs are injected to generation.', injectionContract),
        buildYamlMarkdownBlock('mandatory_quality_axes', 'Quality axes that must be covered by stage/preset design.', mandatoryQualityAxes),
        buildYamlMarkdownBlock('quality_gate_contract', 'Hard quality gates the profile must explicitly enforce.', qualityGateContract),
        buildYamlMarkdownBlock('recommended_blueprint', 'Preferred orchestration blueprint when no special reason to deviate.', recommendedBlueprint),
        buildYamlMarkdownBlock('anti_patterns', 'Patterns to avoid when generating orchestration prompts.', antiPatterns),
        buildYamlMarkdownBlock('global_orchestration_spec', 'Current global orchestration spec as primary baseline. Reuse/adapt this structure before inventing new topology.', globalOrchestrationSpec),
        buildYamlMarkdownBlock('global_presets', 'Current global preset map as primary baseline. Preserve useful detail depth; do not collapse into short generic prompts.', globalPresets),
        buildYamlMarkdownBlock('prompt_richness_contract', 'Each node prompt must be concrete and non-trivial.', {
            system_prompt_contract: 'At least 3 concrete rule lines; avoid generic slogans.',
            user_template_contract: 'Must include Task block with multiple actionable bullets and clear output contract.',
            anti_lazy_rule: 'Thin one-liner prompts are invalid.',
        }),
        buildYamlMarkdownBlock('tool_protocol', 'Function-call protocol and expected argument shapes.', toolProtocol),
    ].join('\n');
}

function normalizeWorldInfoResolverMessages(messages = []) {
    if (!Array.isArray(messages)) {
        return [];
    }

    return messages.map((message) => {
        if (!message || typeof message !== 'object') {
            return message;
        }
        const next = { ...message };
        const rawRole = String(next.role || '').trim().toLowerCase();
        if (rawRole === 'system' || rawRole === 'user' || rawRole === 'assistant') {
            next.role = rawRole;
        } else if (next.is_system) {
            next.role = 'system';
        } else if (next.is_user) {
            next.role = 'user';
        } else {
            next.role = 'assistant';
        }
        if (next.content === undefined && Object.hasOwn(next, 'mes')) {
            next.content = String(next.mes ?? '');
        }
        return next;
    });
}

function rewriteDepthWorldInfoToAfter(payload = {}) {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }
    const depthEntries = Array.isArray(payload.worldInfoDepth) ? payload.worldInfoDepth : [];
    if (depthEntries.length === 0) {
        return payload;
    }

    const blocks = [];
    for (const entry of depthEntries) {
        const lines = Array.isArray(entry?.entries) ? entry.entries : [];
        for (const line of lines) {
            const content = String(line ?? '').trim();
            if (content) {
                blocks.push(content);
            }
        }
    }

    payload.worldInfoDepth = [];
    if (blocks.length === 0) {
        return payload;
    }

    const mergedDepthText = blocks.join('\n\n').trim();
    payload.worldInfoAfter = [String(payload.worldInfoAfter || '').trim(), mergedDepthText]
        .filter(Boolean)
        .join('\n\n')
        .trim();
    return payload;
}

async function buildPresetAwareMessages(context, settings, systemPrompt, userPrompt, {
    api = '',
    promptPresetName = '',
    worldInfoMessages = null,
    runtimeWorldInfo = null,
    forceWorldInfoResimulate = false,
    worldInfoType = 'quiet',
    abortSignal = null,
} = {}) {
    const systemText = String(systemPrompt || '').trim() || 'Return concise guidance through function-call fields.';
    const userText = String(userPrompt || '').trim() || 'Use function-call fields only. Do not put JSON strings into summary.';
    const selectedPromptPresetName = String(promptPresetName || '').trim();
    const envelopeApi = selectedPromptPresetName ? 'openai' : (api || context.mainApi || 'openai');
    throwIfAborted(abortSignal, 'Orchestration aborted.');
    let resolvedRuntimeWorldInfo = (!forceWorldInfoResimulate && hasEffectiveRuntimeWorldInfo(runtimeWorldInfo))
        ? normalizeRuntimeWorldInfo(runtimeWorldInfo)
        : null;
    const resolverMessages = normalizeWorldInfoResolverMessages(worldInfoMessages);
    if (!resolvedRuntimeWorldInfo && typeof context?.resolveWorldInfoForMessages === 'function' && resolverMessages.length > 0) {
        resolvedRuntimeWorldInfo = await context.resolveWorldInfoForMessages(resolverMessages, {
            type: String(worldInfoType || 'quiet'),
            fallbackToCurrentChat: false,
            postActivationHook: rewriteDepthWorldInfoToAfter,
        });
        throwIfAborted(abortSignal, 'Orchestration aborted.');
    }

    throwIfAborted(abortSignal, 'Orchestration aborted.');
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
        runtimeWorldInfo: resolvedRuntimeWorldInfo,
    });
}

function normalizeRuntimeWorldInfo(runtimeWorldInfo = null) {
    const source = runtimeWorldInfo && typeof runtimeWorldInfo === 'object' ? runtimeWorldInfo : {};
    return {
        worldInfoBefore: String(source.worldInfoBefore || ''),
        worldInfoAfter: String(source.worldInfoAfter || ''),
        worldInfoDepth: Array.isArray(source.worldInfoDepth) ? source.worldInfoDepth : [],
        outletEntries: source.outletEntries && typeof source.outletEntries === 'object' ? source.outletEntries : {},
        worldInfoExamples: Array.isArray(source.worldInfoExamples) ? source.worldInfoExamples : [],
        anBefore: Array.isArray(source.anBefore) ? source.anBefore : [],
        anAfter: Array.isArray(source.anAfter) ? source.anAfter : [],
    };
}

function hasEffectiveRuntimeWorldInfo(runtimeWorldInfo = null) {
    const normalized = normalizeRuntimeWorldInfo(runtimeWorldInfo);
    if (normalized.worldInfoBefore || normalized.worldInfoAfter) {
        return true;
    }
    if (normalized.worldInfoDepth.length > 0 || normalized.worldInfoExamples.length > 0) {
        return true;
    }
    if (normalized.anBefore.length > 0 || normalized.anAfter.length > 0) {
        return true;
    }
    return Object.keys(normalized.outletEntries).length > 0;
}

function buildRuntimeWorldInfoFromPayload(payload = null) {
    const candidate = normalizeRuntimeWorldInfo({
        worldInfoBefore: String(payload?.worldInfoBefore || ''),
        worldInfoAfter: String(payload?.worldInfoAfter || ''),
        worldInfoDepth: Array.isArray(payload?.worldInfoDepth) ? payload.worldInfoDepth : [],
        outletEntries: payload?.outletEntries && typeof payload.outletEntries === 'object' ? payload.outletEntries : {},
        worldInfoExamples: Array.isArray(payload?.worldInfoExamples) ? payload.worldInfoExamples : [],
        anBefore: Array.isArray(payload?.anBefore) ? payload.anBefore : [],
        anAfter: Array.isArray(payload?.anAfter) ? payload.anAfter : [],
    });
    const rewritten = normalizeRuntimeWorldInfo(rewriteDepthWorldInfoToAfter({
        ...candidate,
        worldInfoDepth: Array.isArray(candidate.worldInfoDepth)
            ? candidate.worldInfoDepth.map(entry => ({
                ...entry,
                entries: Array.isArray(entry?.entries) ? entry.entries.slice() : [],
            }))
            : [],
    }));
    return hasEffectiveRuntimeWorldInfo(rewritten) ? rewritten : null;
}

function getNodeIterationMaxRounds(settings = null) {
    const source = settings && typeof settings === 'object' ? settings : extension_settings[MODULE_NAME];
    return Math.max(1, Math.min(20, Math.floor(Number(source?.nodeIterationMaxRounds) || 0)));
}

function getReviewRerunMaxRounds(settings = null) {
    const source = settings && typeof settings === 'object' ? settings : extension_settings[MODULE_NAME];
    return Math.max(0, Math.min(20, Math.floor(Number(source?.reviewRerunMaxRounds) || 0)));
}

function isReviewNodeSpec(nodeSpec) {
    return normalizeNodeType(nodeSpec?.type) === ORCH_NODE_TYPE_REVIEW;
}

function getStageRuntimeMode(stage) {
    const mode = String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
    const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
    return nodes.some(node => isReviewNodeSpec(normalizeNodeSpec(node))) ? 'serial' : mode;
}

function buildNodeToolSet(nodeSpec, { isFinalStage = false } = {}) {
    if (isReviewNodeSpec(nodeSpec)) {
        return [
            {
                type: 'function',
                function: {
                    name: ORCH_REVIEW_TOOL_APPROVE,
                    description: 'Approve prior worker outputs and continue without adding any new output.',
                    parameters: {
                        type: 'object',
                        additionalProperties: false,
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: ORCH_REVIEW_TOOL_RERUN,
                    description: 'Request rerun for specific previously executed worker node ids.',
                    parameters: {
                        type: 'object',
                        properties: {
                            target_node_ids: {
                                type: 'array',
                                items: { type: 'string' },
                                minItems: 1,
                            },
                            reason: { type: 'string' },
                        },
                        required: ['target_node_ids'],
                        additionalProperties: false,
                    },
                },
            },
        ];
    }

    return [isFinalStage
        ? {
            type: 'function',
            function: {
                name: 'luker_orch_final_guidance',
                description: 'Final orchestration guidance to inject into generation context.',
                parameters: {
                    type: 'object',
                    properties: {
                        text: { type: 'string' },
                    },
                    required: ['text'],
                    additionalProperties: false,
                },
            },
        }
        : {
            type: 'function',
            function: {
                name: 'luker_orch_node_output',
                description: 'Orchestrator node output with concise structured guidance.',
                parameters: {
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
                        tags: {
                            type: 'array',
                            items: { type: 'string' },
                        },
                    },
                    additionalProperties: true,
                },
            },
        }];
}

function buildNodeIterationContractText(nodeSpec, { isFinalStage = false } = {}) {
    if (isReviewNodeSpec(nodeSpec)) {
        return [
            '## node_iteration_contract',
            `- If prior worker outputs are acceptable, call ${ORCH_REVIEW_TOOL_APPROVE} exactly once.`,
            `- If specific prior worker nodes must be recomputed, call ${ORCH_REVIEW_TOOL_RERUN} exactly once with target_node_ids.`,
            '- Do not emit any summaries, rewritten outputs, or synthesis of your own.',
        ].join('\n');
    }

    const outputName = isFinalStage ? 'luker_orch_final_guidance' : 'luker_orch_node_output';
    return [
        '## node_iteration_contract',
        `- When the node result is ready, call ${outputName} exactly once.`,
        '- Do not output plain prose outside function-call payload.',
    ].join('\n');
}

function makeRuntimeToolCallId() {
    return `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function serializeToolResultContent(result) {
    if (typeof result === 'string') {
        return result;
    }
    if (result === null || result === undefined) {
        return '';
    }
    try {
        return JSON.stringify(result, null, 2);
    } catch {
        return String(result);
    }
}

function appendStandardToolRoundMessages(targetMessages, executedCalls, assistantText = '') {
    if (!Array.isArray(targetMessages) || !Array.isArray(executedCalls) || executedCalls.length === 0) {
        return;
    }

    const toolCalls = executedCalls.map((call) => {
        const id = String(call?.id || '').trim() || makeRuntimeToolCallId();
        const name = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        return {
            id,
            type: 'function',
            function: {
                name,
                arguments: JSON.stringify(args),
            },
            _result: call?.result,
        };
    }).filter(call => call.function.name);

    if (toolCalls.length === 0) {
        return;
    }

    targetMessages.push({
        role: 'assistant',
        content: String(assistantText || ''),
        tool_calls: toolCalls.map(({ _result, ...toolCall }) => toolCall),
    });

    for (const toolCall of toolCalls) {
        targetMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: serializeToolResultContent(toolCall._result),
        });
    }
}

function buildPreviousOutputsMarkdown(previousNodeOutputs = new Map()) {
    return [
        '## previous_node_outputs',
        'Outputs from completed worker nodes currently available to downstream execution.',
        '```yaml',
        toReadableYamlText(Object.fromEntries(previousNodeOutputs), '{}'),
        '```',
    ].join('\n');
}

function buildDistillerOutputMarkdown(previousNodeOutputs = new Map()) {
    return [
        '## distiller_output',
        'Output from distiller node if available.',
        '```yaml',
        toReadableYamlText(previousNodeOutputs.get('distiller') || {}, '{}'),
        '```',
    ].join('\n');
}

function createStageOutputSnapshot(stage, stageWorkerOutputs = new Map()) {
    const nodes = (Array.isArray(stage?.nodes) ? stage.nodes : [])
        .map(rawNode => normalizeNodeSpec(rawNode))
        .filter(nodeSpec => !isReviewNodeSpec(nodeSpec))
        .map((nodeSpec) => {
            if (!stageWorkerOutputs.has(nodeSpec.id)) {
                return null;
            }
            return {
                node: nodeSpec.id,
                output: stageWorkerOutputs.get(nodeSpec.id),
            };
        })
        .filter(Boolean);

    return {
        id: String(stage?.id || ''),
        mode: getStageRuntimeMode(stage),
        nodes,
    };
}

function buildNodeOutputMapFromStageOutputs(stageOutputs = []) {
    const result = new Map();
    for (const stage of Array.isArray(stageOutputs) ? stageOutputs : []) {
        for (const node of Array.isArray(stage?.nodes) ? stage.nodes : []) {
            const nodeId = String(node?.node || '').trim();
            if (!nodeId) {
                continue;
            }
            result.set(nodeId, node?.output);
        }
    }
    return result;
}

function buildStageWorkerOutputMap(stageOutput = null) {
    const result = new Map();
    for (const node of Array.isArray(stageOutput?.nodes) ? stageOutput.nodes : []) {
        const nodeId = String(node?.node || '').trim();
        if (!nodeId) {
            continue;
        }
        result.set(nodeId, node?.output);
    }
    return result;
}

function mergeNodeOutputMaps(...maps) {
    const merged = new Map();
    for (const map of maps) {
        if (!(map instanceof Map)) {
            continue;
        }
        for (const [key, value] of map.entries()) {
            merged.set(key, value);
        }
    }
    return merged;
}

function collectPriorNodeEntries(stages, currentStageIndex, currentNodeIndex) {
    const entries = [];
    for (let stageIndex = 0; stageIndex <= currentStageIndex; stageIndex++) {
        const stage = stages[stageIndex];
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const stopIndex = stageIndex === currentStageIndex ? currentNodeIndex : nodes.length;
        for (let nodeIndex = 0; nodeIndex < stopIndex; nodeIndex++) {
            const nodeSpec = normalizeNodeSpec(nodes[nodeIndex]);
            if (!nodeSpec.id) {
                continue;
            }
            entries.push({
                stageIndex,
                stageId: String(stage?.id || `stage_${stageIndex + 1}`),
                nodeIndex,
                nodeId: nodeSpec.id,
                preset: nodeSpec.preset,
                type: normalizeNodeType(nodeSpec.type),
            });
        }
    }
    return entries;
}

function resolveReviewTargetEntries(stages, currentStageIndex, currentNodeIndex, targetNodeIds) {
    const priorEntries = collectPriorNodeEntries(stages, currentStageIndex, currentNodeIndex)
        .filter(entry => entry.type !== ORCH_NODE_TYPE_REVIEW);
    const counts = new Map();
    for (const entry of priorEntries) {
        counts.set(entry.nodeId, Number(counts.get(entry.nodeId) || 0) + 1);
    }
    const index = new Map(priorEntries.map(entry => [entry.nodeId, entry]));
    const resolved = [];
    for (const rawTarget of Array.isArray(targetNodeIds) ? targetNodeIds : []) {
        const targetNodeId = sanitizeIdentifierToken(rawTarget, '');
        if (!targetNodeId) {
            continue;
        }
        if (Number(counts.get(targetNodeId) || 0) > 1) {
            throw new Error(`Review rerun target '${targetNodeId}' is ambiguous. Node ids must be unique among prior worker nodes.`);
        }
        const entry = index.get(targetNodeId);
        if (!entry) {
            throw new Error(`Review rerun target '${targetNodeId}' is not a valid prior worker node.`);
        }
        if (!resolved.some(item => item.nodeId === entry.nodeId)) {
            resolved.push(entry);
        }
    }
    if (resolved.length === 0) {
        throw new Error('Review rerun requested without valid target_node_ids.');
    }
    return resolved;
}

function buildReviewRuntimeContextText({
    currentNodeId = '',
    priorEntries = [],
    rerunUsed = 0,
    rerunMax = 0,
} = {}) {
    const priorExecutionOrder = priorEntries.map((entry) => ({
        stage_id: entry.stageId,
        node_id: entry.nodeId,
        preset: entry.preset,
        type: entry.type,
    }));
    const rerunCandidates = priorEntries
        .filter(entry => entry.type !== ORCH_NODE_TYPE_REVIEW)
        .map(entry => entry.nodeId);
    return [
        '## review_runtime_context',
        '```yaml',
        toReadableYamlText({
            current_review_node: String(currentNodeId || ''),
            rerun_budget: {
                used: Number(rerunUsed || 0),
                remaining: Math.max(Number(rerunMax || 0) - Number(rerunUsed || 0), 0),
                max: Number(rerunMax || 0),
            },
            prior_execution_order: priorExecutionOrder,
            rerun_candidates: rerunCandidates,
        }, '{}'),
        '```',
    ].join('\n');
}

function extractReviewDecision(toolCalls = [], nodeId = '') {
    let approveCall = null;
    let rerunCall = null;

    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const name = String(call?.name || '').trim();
        if (name === ORCH_REVIEW_TOOL_APPROVE && !approveCall) {
            approveCall = call;
        }
        if (name === ORCH_REVIEW_TOOL_RERUN && !rerunCall) {
            rerunCall = call;
        }
    }

    if (approveCall && rerunCall) {
        throw new Error(`Review node '${nodeId}' returned both approve and rerun.`);
    }

    if (rerunCall) {
        const rawTargets = Array.isArray(rerunCall?.args?.target_node_ids) ? rerunCall.args.target_node_ids : [];
        const targetNodeIds = [...new Set(rawTargets.map(item => sanitizeIdentifierToken(item, '')).filter(Boolean))];
        if (targetNodeIds.length === 0) {
            throw new Error(`Review node '${nodeId}' requested rerun without target_node_ids.`);
        }
        return {
            action: 'rerun',
            targetNodeIds,
            reason: String(rerunCall?.args?.reason || '').trim(),
        };
    }

    if (approveCall) {
        return { action: 'approve' };
    }

    throw new Error(`Review node '${nodeId}' did not return a review decision tool call.`);
}

async function runWorkerNode(context, payload, nodeSpec, preset, messages, previousNodeOutputs, abortSignal = null, options = {}) {
    throwIfAborted(abortSignal, 'Orchestration aborted.');
    const isFinalStage = Boolean(options?.isFinalStage);
    const settings = extension_settings[MODULE_NAME];
    const recent = getRecentMessages(messages, settings.maxRecentMessages)
        .map(message => `${message?.is_user ? 'User' : (message?.name || 'Assistant')}: ${String(message?.mes || '')}`)
        .join('\n');
    const { message: lastUser } = extractLastUserMessage(messages);
    const previousOutputs = buildPreviousOutputsMarkdown(previousNodeOutputs);
    const distillerOutput = buildDistillerOutputMarkdown(previousNodeOutputs);
    const previousOrchestration = getPreviousOrchestrationCapsuleText(context, payload);
    const autoInjectedPrelude = buildAutoInjectedNodePromptPrelude({
        previousOrchestration,
    });

    const runtimeTemplate = normalizeTemplateForRuntime(nodeSpec.userPromptTemplate || preset.userPromptTemplate || '');
    const baseUserPrompt = renderTemplate(runtimeTemplate, {
        recent_chat: recent,
        last_user: String(lastUser?.mes || ''),
        previous_outputs: previousOutputs,
        distiller: distillerOutput,
        previous_snapshot: '',
        previous_orchestration: AUTO_INJECTED_PLACEHOLDER_RUNTIME_NOTE,
    });

    const llmPresetName = String(settings.llmNodePresetName || '').trim();
    const llmApiPresetName = String(settings.llmNodeApiPresetName || '').trim();
    const promptPresetName = llmPresetName;
    const llmProfileResolution = resolveChatCompletionRequestProfile({
        profileName: llmApiPresetName,
        defaultApi: String(context?.mainApi || 'openai').trim() || 'openai',
        defaultSource: String(context?.chatCompletionSettings?.chat_completion_source || ''),
    });
    const api = llmProfileResolution.requestApi || String(context.mainApi || 'openai');
    const apiSettingsOverride = llmProfileResolution.apiSettingsOverride;
    const tools = buildNodeToolSet(nodeSpec, { isFinalStage });
    const allowedNames = new Set(tools.map(tool => String(tool?.function?.name || '').trim()).filter(Boolean));
    const maxRounds = getNodeIterationMaxRounds(settings);
    const outputToolName = isFinalStage ? 'luker_orch_final_guidance' : 'luker_orch_node_output';
    const runtimeToolMessages = [];

    for (let round = 1; round <= maxRounds; round++) {
        throwIfAborted(abortSignal, 'Orchestration aborted.');
        const iterationPrompt = [
            autoInjectedPrelude,
            baseUserPrompt,
            buildNodeIterationContractText(nodeSpec, { isFinalStage }),
            '## node_iteration_round',
            `${round}/${maxRounds}`,
        ].filter(Boolean).join('\n\n');

        const basePromptMessages = await buildPresetAwareMessages(
            context,
            settings,
            String(preset.systemPrompt || '').trim(),
            iterationPrompt,
            {
                api,
                promptPresetName,
                worldInfoMessages: messages,
                worldInfoType: String(payload?.type || 'quiet'),
                runtimeWorldInfo: buildRuntimeWorldInfoFromPayload(payload),
                forceWorldInfoResimulate: Boolean(payload?.forceWorldInfoResimulate),
                abortSignal,
            },
        );
        throwIfAborted(abortSignal, 'Orchestration aborted.');
        const promptMessages = basePromptMessages.concat(runtimeToolMessages.map(message => structuredClone(message)));

        const detailed = await requestToolCallsWithRetry(settings, promptMessages, {
            tools,
            allowedNames,
            llmPresetName,
            apiSettingsOverride,
            abortSignal,
            includeAssistantText: true,
            allowNoToolCalls: false,
            applyAgentTimeout: true,
        });
        throwIfAborted(abortSignal, 'Orchestration aborted.');
        const calls = Array.isArray(detailed?.toolCalls) ? detailed.toolCalls : [];
        if (calls.length === 0) {
            throw new Error(`Node '${nodeSpec.id}' did not return tool calls.`);
        }

        let finalizedOutput = null;
        for (const call of calls) {
            const name = String(call?.name || '').trim();
            if (!name) {
                continue;
            }
            if (name === outputToolName && finalizedOutput === null) {
                finalizedOutput = call?.args && typeof call.args === 'object' ? call.args : {};
                continue;
            }
        }

        if (finalizedOutput !== null) {
            if (isFinalStage) {
                const finalText = String(finalizedOutput?.text ?? '');
                if (!finalText.trim()) {
                    throw new Error(`Node '${nodeSpec.id}' returned empty final guidance text.`);
                }
                return finalText;
            }
            if (finalizedOutput && typeof finalizedOutput === 'object') {
                return finalizedOutput;
            }
            throw new Error(`Node '${nodeSpec.id}' returned invalid tool call payload.`);
        }

        throw new Error(`Node '${nodeSpec.id}' did not return the required output tool '${outputToolName}'.`);
    }

    throw new Error(`Node '${nodeSpec.id}' exceeded max iteration rounds (${maxRounds}) without ${outputToolName}.`);
}

async function replayStagesToReview(context, payload, messages, profile, runtime, {
    currentStageIndex,
    currentNodeIndex,
    targetEntries,
    currentStageWorkerOutputs,
}, abortSignal = null) {
    const stages = Array.isArray(runtime?.stages) ? runtime.stages : [];
    const earliestStageIndex = Math.min(...targetEntries.map(entry => entry.stageIndex));
    const existingStageOutputs = Array.isArray(runtime?.stageOutputs) ? runtime.stageOutputs.slice() : [];
    const rerunTargetsByStage = new Map();
    for (const entry of targetEntries) {
        if (!rerunTargetsByStage.has(entry.stageIndex)) {
            rerunTargetsByStage.set(entry.stageIndex, new Set());
        }
        rerunTargetsByStage.get(entry.stageIndex).add(entry.nodeId);
    }

    runtime.stageOutputs = existingStageOutputs.slice(0, earliestStageIndex);
    let previousNodeOutputs = buildNodeOutputMapFromStageOutputs(runtime.stageOutputs);

    for (let stageIndex = earliestStageIndex; stageIndex < currentStageIndex; stageIndex++) {
        const stageResult = await executeStage(context, payload, messages, profile, runtime, stageIndex, previousNodeOutputs, abortSignal, {
            rerunNodeIds: stageIndex === earliestStageIndex
                ? (rerunTargetsByStage.get(stageIndex) || null)
                : null,
            seedStageWorkerOutputs: stageIndex === earliestStageIndex
                ? buildStageWorkerOutputMap(existingStageOutputs[stageIndex])
                : null,
        });
        previousNodeOutputs = mergeNodeOutputMaps(stageResult.previousNodeOutputs, stageResult.stageWorkerOutputs);
        runtime.stageOutputs.push(createStageOutputSnapshot(stages[stageIndex], stageResult.stageWorkerOutputs));
    }

    const currentStagePrefix = await executeStage(context, payload, messages, profile, runtime, currentStageIndex, previousNodeOutputs, abortSignal, {
        stopBeforeNodeIndex: currentNodeIndex,
        rerunNodeIds: earliestStageIndex === currentStageIndex
            ? (rerunTargetsByStage.get(currentStageIndex) || null)
            : null,
        seedStageWorkerOutputs: earliestStageIndex === currentStageIndex
            ? mergeNodeOutputMaps(currentStageWorkerOutputs instanceof Map ? currentStageWorkerOutputs : new Map())
            : null,
    });

    return {
        previousNodeOutputs: currentStagePrefix.previousNodeOutputs,
        currentStageWorkerOutputs: currentStagePrefix.stageWorkerOutputs,
        result: {
            rerun_round: Number(runtime.reviewRerunCount || 0),
            rerun_remaining: Math.max(getReviewRerunMaxRounds() - Number(runtime.reviewRerunCount || 0), 0),
            restart_stage_id: String(stages[earliestStageIndex]?.id || ''),
            target_node_ids: targetEntries.map(entry => entry.nodeId),
        },
    };
}

async function runReviewNode(context, payload, nodeSpec, preset, messages, previousNodeOutputs, currentStageWorkerOutputs, abortSignal = null, options = {}) {
    throwIfAborted(abortSignal, 'Orchestration aborted.');
    if (Boolean(options?.isFinalStage)) {
        throw new Error(`Review node '${nodeSpec.id}' cannot be used in the final stage.`);
    }

    const settings = extension_settings[MODULE_NAME];
    const maxReruns = getReviewRerunMaxRounds(settings);
    const maxRounds = Math.max(1, getNodeIterationMaxRounds(settings) + maxReruns + 1);
    const recent = getRecentMessages(messages, settings.maxRecentMessages)
        .map(message => `${message?.is_user ? 'User' : (message?.name || 'Assistant')}: ${String(message?.mes || '')}`)
        .join('\n');
    const { message: lastUser } = extractLastUserMessage(messages);
    const previousOrchestration = getPreviousOrchestrationCapsuleText(context, payload);
    const autoInjectedPrelude = buildAutoInjectedNodePromptPrelude({
        previousOrchestration,
    });
    const runtimeTemplate = normalizeTemplateForRuntime(nodeSpec.userPromptTemplate || preset.userPromptTemplate || '');
    const llmPresetName = String(settings.llmNodePresetName || '').trim();
    const llmApiPresetName = String(settings.llmNodeApiPresetName || '').trim();
    const promptPresetName = llmPresetName;
    const llmProfileResolution = resolveChatCompletionRequestProfile({
        profileName: llmApiPresetName,
        defaultApi: String(context?.mainApi || 'openai').trim() || 'openai',
        defaultSource: String(context?.chatCompletionSettings?.chat_completion_source || ''),
    });
    const api = llmProfileResolution.requestApi || String(context.mainApi || 'openai');
    const apiSettingsOverride = llmProfileResolution.apiSettingsOverride;
    const tools = buildNodeToolSet(nodeSpec);
    const allowedNames = new Set(tools.map(tool => String(tool?.function?.name || '').trim()).filter(Boolean));
    const runtimeToolMessages = [];
    let currentPreviousNodeOutputs = mergeNodeOutputMaps(previousNodeOutputs);
    let currentStageOutputs = mergeNodeOutputMaps(currentStageWorkerOutputs);

    for (let round = 1; round <= maxRounds; round++) {
        throwIfAborted(abortSignal, 'Orchestration aborted.');
        const availableOutputs = mergeNodeOutputMaps(currentPreviousNodeOutputs, currentStageOutputs);
        const priorEntries = collectPriorNodeEntries(options?.runtime?.stages || [], Number(options?.stageIndex || 0), Number(options?.nodeIndex || 0));
        const baseUserPrompt = renderTemplate(runtimeTemplate, {
            recent_chat: recent,
            last_user: String(lastUser?.mes || ''),
            previous_outputs: buildPreviousOutputsMarkdown(availableOutputs),
            distiller: buildDistillerOutputMarkdown(availableOutputs),
            previous_snapshot: '',
            previous_orchestration: AUTO_INJECTED_PLACEHOLDER_RUNTIME_NOTE,
        });
        const iterationPrompt = [
            autoInjectedPrelude,
            baseUserPrompt,
            buildReviewRuntimeContextText({
                currentNodeId: nodeSpec.id,
                priorEntries,
                rerunUsed: Number(options?.runtime?.reviewRerunCount || 0),
                rerunMax: maxReruns,
            }),
            buildNodeIterationContractText(nodeSpec),
            '## node_iteration_round',
            `${round}/${maxRounds}`,
        ].filter(Boolean).join('\n\n');

        const basePromptMessages = await buildPresetAwareMessages(
            context,
            settings,
            String(preset.systemPrompt || '').trim(),
            iterationPrompt,
            {
                api,
                promptPresetName,
                worldInfoMessages: messages,
                worldInfoType: String(payload?.type || 'quiet'),
                runtimeWorldInfo: buildRuntimeWorldInfoFromPayload(payload),
                forceWorldInfoResimulate: Boolean(payload?.forceWorldInfoResimulate),
                abortSignal,
            },
        );
        const promptMessages = basePromptMessages.concat(runtimeToolMessages.map(message => structuredClone(message)));
        const detailed = await requestToolCallsWithRetry(settings, promptMessages, {
            tools,
            allowedNames,
            llmPresetName,
            apiSettingsOverride,
            abortSignal,
            includeAssistantText: true,
            allowNoToolCalls: false,
            applyAgentTimeout: true,
        });
        const decision = extractReviewDecision(detailed?.toolCalls || [], nodeSpec.id);
        if (decision.action === 'approve') {
            return {
                previousNodeOutputs: currentPreviousNodeOutputs,
                currentStageWorkerOutputs: currentStageOutputs,
            };
        }

        if (Number(options?.runtime?.reviewRerunCount || 0) >= maxReruns) {
            throw new Error(`Review rerun limit reached (${maxReruns}).`);
        }

        const targetEntries = resolveReviewTargetEntries(
            options?.runtime?.stages || [],
            Number(options?.stageIndex || 0),
            Number(options?.nodeIndex || 0),
            decision.targetNodeIds,
        );
        options.runtime.reviewRerunCount = Number(options.runtime.reviewRerunCount || 0) + 1;
        const replay = await replayStagesToReview(context, payload, messages, profile, options.runtime, {
            currentStageIndex: Number(options?.stageIndex || 0),
            currentNodeIndex: Number(options?.nodeIndex || 0),
            targetEntries,
            currentStageWorkerOutputs: currentStageOutputs,
        }, abortSignal);
        currentPreviousNodeOutputs = replay.previousNodeOutputs;
        currentStageOutputs = replay.currentStageWorkerOutputs;
        appendStandardToolRoundMessages(runtimeToolMessages, [{
            name: ORCH_REVIEW_TOOL_RERUN,
            args: {
                target_node_ids: targetEntries.map(entry => entry.nodeId),
                reason: decision.reason,
            },
            result: replay.result,
        }], detailed?.assistantText || '');
    }

    throw new Error(`Review node '${nodeSpec.id}' exceeded max rounds (${maxRounds}).`);
}

async function executeStage(context, payload, messages, profile, runtime, stageIndex, previousNodeOutputs, abortSignal = null, options = {}) {
    const stage = runtime?.stages?.[stageIndex];
    const nodes = (Array.isArray(stage?.nodes) ? stage.nodes : []).map(rawNode => normalizeNodeSpec(rawNode));
    const stopBeforeNodeIndex = Number.isInteger(options?.stopBeforeNodeIndex)
        ? Math.max(0, Math.min(nodes.length, Number(options.stopBeforeNodeIndex)))
        : null;
    const seedStageWorkerOutputs = options?.seedStageWorkerOutputs instanceof Map
        ? mergeNodeOutputMaps(options.seedStageWorkerOutputs)
        : new Map();
    const rerunNodeIds = options?.rerunNodeIds instanceof Set
        ? new Set([...options.rerunNodeIds].map(nodeId => sanitizeIdentifierToken(nodeId, '')).filter(Boolean))
        : null;
    const shouldRunWorkerNode = (nodeId) => !(rerunNodeIds instanceof Set) || rerunNodeIds.has(nodeId);
    const effectiveMode = getStageRuntimeMode(stage);
    const isFullStage = stopBeforeNodeIndex === null;
    const isFinalStage = isFullStage && stageIndex === Number(runtime?.stages?.length || 0) - 1;

    if (effectiveMode === 'parallel' && isFullStage) {
        const stageWorkerOutputs = mergeNodeOutputMaps(seedStageWorkerOutputs);
        const outputs = await Promise.all(nodes
            .filter(nodeSpec => shouldRunWorkerNode(nodeSpec.id) || !stageWorkerOutputs.has(nodeSpec.id))
            .map(async (nodeSpec) => {
                if (isReviewNodeSpec(nodeSpec)) {
                    throw new Error(`Review node '${nodeSpec.id}' cannot run in a parallel execution stage.`);
                }
                return [
                    nodeSpec.id,
                    await runWorkerNode(context, payload, nodeSpec, profile.presets[nodeSpec.preset] || {}, messages, previousNodeOutputs, abortSignal, {
                        isFinalStage,
                    }),
                ];
            }));
        for (const [nodeId, output] of outputs) {
            stageWorkerOutputs.set(nodeId, output);
        }
        return {
            previousNodeOutputs: mergeNodeOutputMaps(previousNodeOutputs),
            stageWorkerOutputs,
        };
    }

    let currentPreviousNodeOutputs = mergeNodeOutputMaps(previousNodeOutputs);
    let currentStageWorkerOutputs = mergeNodeOutputMaps(seedStageWorkerOutputs);
    const limit = stopBeforeNodeIndex === null ? nodes.length : stopBeforeNodeIndex;

    for (let nodeIndex = 0; nodeIndex < limit; nodeIndex++) {
        const nodeSpec = nodes[nodeIndex];
        const preset = profile.presets[nodeSpec.preset] || {};
        if (isReviewNodeSpec(nodeSpec)) {
            const reviewResult = await runReviewNode(
                context,
                payload,
                nodeSpec,
                preset,
                messages,
                currentPreviousNodeOutputs,
                currentStageWorkerOutputs,
                abortSignal,
                {
                    isFinalStage,
                    stageIndex,
                    nodeIndex,
                    runtime,
                },
            );
            currentPreviousNodeOutputs = reviewResult.previousNodeOutputs;
            currentStageWorkerOutputs = reviewResult.currentStageWorkerOutputs;
            continue;
        }

        if (!shouldRunWorkerNode(nodeSpec.id) && currentStageWorkerOutputs.has(nodeSpec.id)) {
            continue;
        }
        const output = await runWorkerNode(context, payload, nodeSpec, preset, messages, currentPreviousNodeOutputs, abortSignal, {
            isFinalStage,
        });
        currentStageWorkerOutputs.set(nodeSpec.id, output);
        throwIfAborted(abortSignal, 'Orchestration aborted.');
    }

    return {
        previousNodeOutputs: currentPreviousNodeOutputs,
        stageWorkerOutputs: currentStageWorkerOutputs,
    };
}

async function runOrchestration(context, payload, messages, profile) {
    const spec = sanitizeSpec(profile.spec);
    const stages = Array.isArray(spec?.stages) ? spec.stages : [];
    const runtime = {
        stages,
        stageOutputs: [],
        reviewRerunCount: 0,
    };
    let previousNodeOutputs = new Map();
    const abortSignal = isAbortSignalLike(payload?.signal) ? payload.signal : null;
    throwIfAborted(abortSignal, 'Orchestration aborted.');

    for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
        throwIfAborted(abortSignal, 'Orchestration aborted.');
        const stage = stages[stageIndex];
        const stageResult = await executeStage(context, payload, messages, profile, runtime, stageIndex, previousNodeOutputs, abortSignal);
        previousNodeOutputs = mergeNodeOutputMaps(stageResult.previousNodeOutputs, stageResult.stageWorkerOutputs);
        runtime.stageOutputs.push(createStageOutputSnapshot(stage, stageResult.stageWorkerOutputs));
    }

    return { stageOutputs: runtime.stageOutputs, previousNodeOutputs };
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

function normalizeNodeOutputForSnapshot(output) {
    if (typeof output === 'string') {
        return output;
    }
    if (output && typeof output === 'object') {
        return structuredClone(output);
    }
    return output;
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
                output: normalizeNodeOutputForSnapshot(node?.output),
            }))
            .filter(node => node.node),
    };
}

function extractNodeInjectionText(nodeOutput) {
    if (typeof nodeOutput === 'string') {
        const text = String(nodeOutput);
        return text.trim() ? text : '';
    }
    return '';
}

function buildCapsule(stageOutputs) {
    const finalStage = getFinalStageSnapshot(stageOutputs);
    const settings = extension_settings[MODULE_NAME];
    const customInstruction = String(settings?.capsuleCustomInstruction || '').trim();
    const finalTexts = Array.isArray(finalStage?.nodes)
        ? finalStage.nodes
            .map(node => extractNodeInjectionText(node?.output))
            .filter(Boolean)
        : [];
    const body = finalTexts.length <= 1
        ? (finalTexts[0] || '')
        : finalTexts.join('\n\n');
    if (!body) {
        return '';
    }
    if (!customInstruction) {
        return body;
    }
    return `${customInstruction}\n\n${body}`;
}

function reapplyLatestCapsuleInjection(context) {
    const chatKey = getChatKey(context);
    if (!latestOrchestrationSnapshot || typeof latestOrchestrationSnapshot !== 'object') {
        return;
    }
    if (String(latestOrchestrationSnapshot.chatKey || '') !== String(chatKey || '')) {
        return;
    }
    const rebuiltText = buildCapsule(Array.isArray(latestOrchestrationSnapshot.stageOutputs) ? latestOrchestrationSnapshot.stageOutputs : []);
    const nextText = String(rebuiltText || latestOrchestrationSnapshot.capsuleText || '').trim();
    latestOrchestrationSnapshot = {
        ...latestOrchestrationSnapshot,
        capsuleText: nextText,
        updatedAt: new Date().toISOString(),
    };
    clearCapsulePrompt(context);
    void persistOrchestratorChatState(context);
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
        await loadOrchestratorChatState(context, { force: false });
        clearCapsulePrompt(context);
        clearLastOrchestrationSnapshot(context, { persist: true });
        updateUiStatus(i18n('Generation aborted. Skipped orchestration.'));
        return;
    }
    orchInFlight = true;
    const pluginAbortController = new AbortController();
    activeOrchRunAbortController = pluginAbortController;
    const linkedAbort = linkAbortSignals(payload?.signal, pluginAbortController.signal);
    const orchestrationPayload = linkedAbort.signal && linkedAbort.signal !== payload?.signal
        ? {
            ...payload,
            signal: linkedAbort.signal,
            __lukerOrchGenerationSignal: payload?.signal || null,
        }
        : payload;
    let stopRequestedByUser = false;
    let resolveStopRequest = null;
    const stopRequestPromise = new Promise((resolve) => {
        resolveStopRequest = () => {
            if (stopRequestedByUser) {
                return;
            }
            stopRequestedByUser = true;
            if (!pluginAbortController.signal.aborted) {
                pluginAbortController.abort();
            }
            resolve({ stopped: true });
        };
    });

    try {
        await loadOrchestratorChatState(context, { force: false });
        throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');
        const profile = getEffectiveProfile(context);
        const messages = structuredClone(getCoreMessages(payload));
        if (messages.length === 0) {
            clearCapsulePrompt(context);
            clearLastOrchestrationSnapshot(context, { persist: true });
            return;
        }
        const generationType = String(payload?.type || '').trim().toLowerCase();
        const chatKey = getChatKey(context);
        const anchor = buildLastUserAnchor(context, messages);
        if (ORCH_REUSE_GENERATION_TYPES.has(generationType) && canReuseLatestOrchestrationSnapshot(chatKey, anchor)) {
            const capsuleText = String(latestOrchestrationSnapshot.capsuleText || '').trim();
            if (capsuleText) {
                injectCapsuleToPayload(payload, capsuleText, settings);
                latestOrchestrationSnapshot = {
                    ...latestOrchestrationSnapshot,
                    chatKey,
                    updatedAt: new Date().toISOString(),
                    targetLayer: getTargetAssistantLayer(payload),
                };
                await persistOrchestratorChatState(context);
                throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');
                updateUiStatus(i18n('Orchestrator completed.'));
                clearRunInfoToast();
                return;
            }
        }
        updateUiStatus(i18n('Orchestrator running...'));
        showRunInfoToast(i18n('Orchestrator running...'), {
            stopLabel: i18n('Stop'),
            onStop: () => {
                resolveStopRequest?.();
            },
        });

        const orchestrationTask = runOrchestration(context, orchestrationPayload, messages, profile);
        void orchestrationTask.catch((error) => {
            if (!stopRequestedByUser) {
                return;
            }
            if (!isAbortError(error, orchestrationPayload?.signal)) {
                console.warn(`[${MODULE_NAME}] Orchestration finished after user stop`, error);
            }
        });
        const raced = await Promise.race([
            orchestrationTask.then(finalRun => ({ stopped: false, finalRun })),
            stopRequestPromise,
        ]);
        if (raced?.stopped) {
            clearCapsulePrompt(context);
            clearLastOrchestrationSnapshot(context, { persist: true });
            updateUiStatus(i18n('Orchestrator cancelled by user.'));
            return;
        }
        const finalRun = raced?.finalRun;
        throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');

        const capsuleText = buildCapsule(finalRun.stageOutputs || []);
        throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');
        injectCapsuleToPayload(payload, capsuleText, settings);
        latestOrchestrationSnapshot = {
            chatKey,
            anchorFloor: Number(anchor?.floor || 0),
            anchorPlayableFloor: Number(anchor?.playableFloor || 0),
            anchorHash: String(anchor?.hash || ''),
            capsuleText,
            updatedAt: new Date().toISOString(),
            targetLayer: getTargetAssistantLayer(payload),
            stageOutputs: compactStageOutputs(finalRun.stageOutputs || []),
        };
        await persistOrchestratorChatState(context);
        throwIfAborted(orchestrationPayload?.signal, 'Orchestration aborted.');
        updateUiStatus(i18n('Orchestrator completed.'));
        clearRunInfoToast();
    } catch (error) {
        if (isAbortError(error, orchestrationPayload?.signal)) {
            clearCapsulePrompt(context);
            clearLastOrchestrationSnapshot(context, { persist: true });
            const generationAborted = Boolean(isAbortSignalLike(payload?.signal) && payload.signal.aborted);
            updateUiStatus(generationAborted
                ? i18n('Generation aborted. Skipped orchestration.')
                : i18n('Orchestrator cancelled by user.'));
            clearRunInfoToast();
            return;
        }
        clearCapsulePrompt(context);
        clearLastOrchestrationSnapshot(context, { persist: true });
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

function onMessageDeleted(_chatLength, details) {
    const context = getContext();
    if (!latestOrchestrationSnapshot || typeof latestOrchestrationSnapshot !== 'object') {
        clearCapsulePrompt(context);
        return;
    }

    const chatKey = getChatKey(context);
    if (String(latestOrchestrationSnapshot.chatKey || '') !== String(chatKey || '')) {
        clearCapsulePrompt(context);
        return;
    }

    const anchorPlayableFloor = Number(latestOrchestrationSnapshot.anchorPlayableFloor);
    const deletedFrom = Number(details?.deletedPlayableSeqFrom);
    const deletedTo = Number(details?.deletedPlayableSeqTo);

    // Regenerate/swipe-style tail deletion removes only assistant content after last user.
    // Keep snapshot in that case so reuse can still hit on the next generation.
    const deletedStrictlyAfterAnchor = Number.isFinite(anchorPlayableFloor)
        && anchorPlayableFloor > 0
        && Number.isFinite(deletedFrom)
        && Number.isFinite(deletedTo)
        && deletedFrom > anchorPlayableFloor
        && deletedTo > anchorPlayableFloor;

    if (deletedStrictlyAfterAnchor) {
        clearCapsulePrompt(context);
        return;
    }

    clearCapsulePrompt(context);
    clearLastOrchestrationSnapshot(context, { persist: true });
}

function onMessageEdited(_messageId) {
    const context = getContext();
    if (!latestOrchestrationSnapshot || typeof latestOrchestrationSnapshot !== 'object') {
        clearCapsulePrompt(context);
        return;
    }

    const chatKey = getChatKey(context);
    if (String(latestOrchestrationSnapshot.chatKey || '') !== String(chatKey || '')) {
        clearCapsulePrompt(context);
        return;
    }

    const currentAnchor = buildLastUserAnchor(context, Array.isArray(context?.chat) ? context.chat : []);
    if (currentAnchor && canReuseLatestOrchestrationSnapshot(chatKey, currentAnchor)) {
        return;
    }

    clearCapsulePrompt(context);
    clearLastOrchestrationSnapshot(context, { persist: true });
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
    return getChatCompletionConnectionProfiles();
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
    if (!presets[defaultPreset]) {
        presets[defaultPreset] = createPresetDraft();
    }

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
                    type: normalizeNodeType(normalizedNode.type),
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
                        type: ORCH_NODE_TYPE_WORKER,
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
                type: ORCH_NODE_TYPE_WORKER,
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

                        const serialized = { id, preset, type: normalizeNodeType(node?.type) };
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

function resolveOverridePresetMap(override, basePresets = {}) {
    if (override?.presets && typeof override.presets === 'object') {
        return sanitizePresetMap(override.presets);
    }
    // Legacy compatibility: older overrides stored only presetPatch.
    if (override?.presetPatch && typeof override.presetPatch === 'object') {
        return sanitizePresetMap({
            ...sanitizePresetMap(basePresets),
            ...sanitizePresetMap(override.presetPatch),
        });
    }
    return {};
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
        editor.presets = {};
    }
    editor.spec = toEditableSpec(editor.spec || defaultSpec, editor.presets);
    editor.presets = toEditablePresetMap(editor.presets);
}

function pickDefaultPreset(editor) {
    const keys = Object.keys(editor?.presets || {});
    if (keys.length === 0) {
        const presetId = 'distiller';
        editor.presets = {
            [presetId]: createPresetDraft(),
        };
        return presetId;
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
            type: ORCH_NODE_TYPE_WORKER,
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
    const presets = override
        ? toEditablePresetMap(resolveOverridePresetMap(override, settings.presets))
        : toEditablePresetMap(settings.presets);
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
    <label>${escapeHtml(i18n('Node Type'))}</label>
    <select class="text_pole" data-luker-field="node-type" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}">
        <option value="${ORCH_NODE_TYPE_WORKER}"${normalizeNodeType(node.type) === ORCH_NODE_TYPE_WORKER ? ' selected' : ''}>${escapeHtml(i18n('Worker'))}</option>
        <option value="${ORCH_NODE_TYPE_REVIEW}"${normalizeNodeType(node.type) === ORCH_NODE_TYPE_REVIEW ? ' selected' : ''}>${escapeHtml(i18n('Review'))}</option>
    </select>
    <label>${escapeHtml(i18n('Node Prompt Template (optional)'))}</label>
    <textarea class="text_pole textarea_compact" rows="4" data-luker-field="node-template" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" placeholder="${escapeHtml(i18n('Use {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}. Previous orchestration result is auto-injected.'))}">${escapeHtml(node.userPromptTemplate)}</textarea>
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
    root.find('[data-luker-ai-goal-input]').val(String(uiState.aiGoal || ''));
    root.find('.luker_orch_board').toggle(!singleModeEnabled);
    root.find('#luker_orch_single_mode_hint').toggle(singleModeEnabled);
    root.find('#luker_orch_single_agent_fields').toggle(singleModeEnabled);
    refreshOrchestrationEditorPopup(context, settings);
}

function buildOrchestrationEditorPopupPanelHtml(context, settings) {
    syncCharacterEditorWithActiveAvatar(context);
    const activeAvatar = String(getCurrentAvatar(context) || '').trim();
    const scope = getDisplayedScope(context, settings);
    const editor = getEditorByScope(scope);
    const isCharacterScope = scope === 'character';
    const profileTitle = isCharacterScope
        ? i18nFormat('Character Override: ${0}', getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar)
        : i18n('Global Orchestration Profile');
    return `
<div class="luker_orch_editor_popup">
    <div class="luker_orch_board">
        <div class="luker_orch_character_row">
            <div>
                <small>${escapeHtml(i18n('Current card:'))} <span>${escapeHtml(activeAvatar ? (getCharacterDisplayNameByAvatar(context, activeAvatar) || activeAvatar) : i18n('(No character card)'))}</span></small><br />
                <small>${escapeHtml(i18n('Editing:'))} <span>${escapeHtml(isCharacterScope ? i18n('Current character override') : i18n('Global profile'))}</span></small>
            </div>
            <div>
                <label>${escapeHtml(i18n('AI build goal (optional)'))}</label>
                <textarea class="text_pole textarea_compact" rows="2" data-luker-ai-goal-input placeholder="${escapeHtml(i18n('e.g. mystery thriller pacing, strict in-character tone'))}">${escapeHtml(String(uiState.aiGoal || ''))}</textarea>
                <div class="flex-container">
                    <div class="menu_button menu_button_small" data-luker-action="ai-suggest-character">${escapeHtml(i18n('AI Quick Build'))}</div>
                    <div class="menu_button menu_button_small" data-luker-action="ai-iterate-open">${escapeHtml(i18n('Open AI Iteration Studio'))}</div>
                </div>
            </div>
        </div>
        <div class="flex-container">
            <div class="menu_button" data-luker-action="reload-current">${escapeHtml(i18n('Reload Current'))}</div>
            <div class="menu_button" data-luker-action="export-profile">${escapeHtml(i18n('Export Profile'))}</div>
            <div class="menu_button" data-luker-action="import-profile">${escapeHtml(i18n('Import Profile'))}</div>
            <div class="menu_button" data-luker-action="reset-global">${escapeHtml(i18n('Reset Global'))}</div>
            <div class="menu_button" data-luker-action="save-global">${escapeHtml(i18n('Save To Global'))}</div>
            <div class="menu_button" data-luker-action="save-character">${escapeHtml(i18n('Save To Character Override'))}</div>
            ${isCharacterScope ? `<div class="menu_button" data-luker-action="clear-character">${escapeHtml(i18n('Clear Character Override'))}</div>` : ''}
        </div>
        <div id="luker_orch_effective_visual">${renderEditorWorkspace(scope, editor, profileTitle)}</div>
    </div>
</div>`;
}

function refreshOrchestrationEditorPopup(context, settings) {
    const contentId = String(uiState.orchEditorPopupContentId || '');
    if (!contentId) {
        return;
    }
    const mount = jQuery(`#${contentId}`);
    if (!mount.length) {
        uiState.orchEditorPopupContentId = '';
        return;
    }
    mount.html(buildOrchestrationEditorPopupPanelHtml(context, settings));
}

async function openOrchestrationEditorPopup(context, settings) {
    ensureStyles();
    const contentId = `luker_orch_editor_popup_mount_${Date.now()}`;
    uiState.orchEditorPopupContentId = contentId;
    const popupHtml = `<div id="${contentId}"></div>`;
    const popupPromise = context.callGenericPopup(
        popupHtml,
        context.POPUP_TYPE.TEXT,
        i18n('Orchestrator'),
        {
            okButton: i18n('Close'),
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        },
    );
    refreshOrchestrationEditorPopup(context, settings);
    await popupPromise;
    if (uiState.orchEditorPopupContentId === contentId) {
        uiState.orchEditorPopupContentId = '';
    }
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
    void settings;
    const target = String(avatar || '');
    if (!target) {
        return false;
    }
    const characterIndex = getCharacterIndexByAvatar(context, target);
    if (characterIndex < 0) {
        return false;
    }

    ensureEditorIntegrity(editor);
    const characterPresets = serializeEditorPresetMap(editor.presets);
    const sourceEnabled = typeof editor?.enabled === 'boolean' ? editor.enabled : true;
    const sourceNotes = notes === null ? String(editor?.notes || '') : String(notes || '');
    const overridePayload = {
        enabled: forceEnabled === null ? Boolean(sourceEnabled) : Boolean(forceEnabled),
        spec: serializeEditorSpec(editor.spec),
        presets: characterPresets,
        updatedAt: Date.now(),
        name: getCharacterDisplayNameByAvatar(context, target),
        notes: sourceNotes,
    };

    const previous = getCharacterExtensionDataByAvatar(context, target);
    const nextPayload = {
        ...previous,
        override: overridePayload,
    };
    return await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
}

async function persistOrchestratorCharacterExtension(context, characterIndex, modulePayload) {
    const id = Number(characterIndex);
    const character = Number.isInteger(id) ? context?.characters?.[id] : null;
    if (!character) {
        return false;
    }

    const nextExtensions = structuredClone(character?.data?.extensions ?? {});
    if (modulePayload && typeof modulePayload === 'object') {
        nextExtensions[MODULE_NAME] = modulePayload;
    } else {
        delete nextExtensions[MODULE_NAME];
    }

    character.data = character.data || {};
    character.data.extensions = nextExtensions;

    if (Number(context?.characterId) === id && character.json_data) {
        try {
            const jsonData = JSON.parse(character.json_data);
            jsonData.data = jsonData.data || {};
            jsonData.data.extensions = nextExtensions;
            character.json_data = JSON.stringify(jsonData);
            jQuery('#character_json_data').val(character.json_data);
        } catch {
            // Ignore malformed json_data snapshots.
        }
    }

    const response = await fetch('/api/characters/edit-attribute', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            ch_name: String(character.name || '').trim() || 'character',
            avatar_url: character.avatar,
            field: 'extensions',
            value: nextExtensions,
        }),
    });

    if (!response.ok) {
        console.error('Failed to persist orchestrator extension data to character card', response.statusText);
    }
    return response.ok;
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
    return isPresetReferencedInSpec(editor?.spec, presetId);
}

function isPresetReferencedInSpec(spec, presetId) {
    const targetPresetId = sanitizeIdentifierToken(presetId, '');
    if (!targetPresetId) {
        return false;
    }
    const stages = Array.isArray(spec?.stages) ? spec.stages : [];
    return stages.some(stage =>
        (stage?.nodes || []).some(node => {
            const normalizedNode = normalizeNodeSpec(node);
            const nodePresetId = sanitizeIdentifierToken(normalizedNode?.preset || normalizedNode?.id, '');
            return nodePresetId === targetPresetId;
        }));
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
            .map((rawNode) => {
                const node = normalizeNodeSpec(rawNode);
                if (!node?.id) {
                    return null;
                }
                const nextNode = {
                    id: String(node.id || '').trim(),
                    preset: String(node.preset || node.id || '').trim(),
                    type: normalizeNodeType(node.type),
                };
                const template = String(node.userPromptTemplate || '');
                if (template.trim()) {
                    nextNode.userPromptTemplate = normalizeTemplateForRuntime(template);
                }
                return nextNode.id ? nextNode : null;
            })
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
                userPromptTemplate: normalizeTemplateForRuntime(String(args.userPromptTemplate || '').trim()),
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
    const aiVisibleGlobalProfile = sanitizeProfileForAiPrompt({
        spec: currentSpec,
        presets: currentPresets,
    });
    const suggestSystemPromptBase = normalizeTemplateForAiPrompt(String(settings.aiSuggestSystemPrompt || '').trim()) || getDefaultAiSuggestSystemPrompt();
    const suggestSystemPrompt = [
        suggestSystemPromptBase,
        'Hard output rule: follow each node prompt\'s explicit thought policy.',
        'Reasoning-heavy node prompts should explicitly require one <thought>...</thought> before tool calls.',
        'Do not add extra narrative/body text outside the required output contract.',
        'Runtime hard contract (must follow): return COMPLETE tool calls in one response; never return only one tool call.',
        'At minimum include luker_orch_append_stage and luker_orch_finalize_profile in the same response.',
        'luker_orch_finalize_profile must be last.',
        `Must include dedicated required node ids: ${REQUIRED_AI_BUILD_NODE_IDS.join(', ')}.`,
        'Prefer the recommended blueprint unless strong card-specific reasons require deviation.',
        'Do not generate long identity-roleplay blocks for node prompts; keep them process-focused and operational.',
        'Runtime prepends previous orchestration result before node template text; do not add placeholders for that context.',
        'If you use a critic/reviewer, model it as a review node that approves or requests rerun of earlier worker node ids.',
        'Review nodes do not emit synthesis. Downstream stages must continue from passthrough worker outputs.',
        'When deviating, explicitly optimize for this character card while preserving hard gates and final function-call text contract.',
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
            expected_guidance_format: 'function_call_text_direct_injection',
            no_json_or_markup_in_final_output: true,
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
                { id: 'reason', mode: 'parallel', nodes: ['planner', 'recall_relevance'] },
                { id: 'review', mode: 'serial', nodes: [{ id: 'critic', preset: 'critic', type: ORCH_NODE_TYPE_REVIEW }] },
                { id: 'finalize', mode: 'serial', nodes: ['synthesizer'] },
            ],
            role_contracts: {
                distiller: 'Produce compact evidence-grounded state snapshot.',
                lorebook_reader: 'Extract only active lorebook/world-info hard constraints relevant to this turn.',
                anti_data_guard: 'Enforce anti-data hard gates (no quantification/report tone/pseudo-analysis) and produce rewrite-safe guidance.',
                planner: 'Produce causally coherent next-step plan.',
                critic: 'Audit prior worker outputs, then either approve or request rerun of specific earlier worker nodes. Do not emit synthesis.',
                recall_relevance: 'Pick recalled facts that matter for this turn.',
                synthesizer: 'Merge the approved worker outputs into one draft-ready final guidance.',
            },
            last_stage_rule: 'Prefer single synthesizer node as final stage output.',
            innovation_policy: {
                baseline_first: true,
                allow_stage_refactor: true,
                allow_node_role_innovation: true,
                must_preserve_hard_gates: true,
                must_preserve_review_passthrough: true,
                must_preserve_final_plain_text_contract: true,
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
        globalOrchestrationSpec: aiVisibleGlobalProfile.spec,
        globalPresets: aiVisibleGlobalProfile.presets,
        toolProtocol: {
            review_node_contract: {
                type_field: `Set node.type to "${ORCH_NODE_TYPE_REVIEW}" for review nodes. Omit or use "${ORCH_NODE_TYPE_WORKER}" for normal worker nodes.`,
                runtime_behavior: 'Review nodes inspect current available worker outputs, may request rerun of specific earlier worker node ids, and produce no downstream output of their own.',
                topology_rule: 'Prefer a dedicated serial review stage after the worker stage being audited. Do not place review nodes in the final stage.',
            },
            append_stage: {
                function: 'luker_orch_append_stage',
                shape: {
                    stage_id: 'string',
                    mode: 'serial|parallel',
                    nodes: [{ id: 'string', preset: 'string', type: 'optional worker|review', userPromptTemplate: 'optional string' }],
                },
            },
            upsert_preset: {
                function: 'luker_orch_upsert_preset',
                shape: {
                    preset_id: 'string',
                    systemPrompt: 'string',
                    userPromptTemplate: `Use only: ${AI_VISIBLE_TEMPLATE_VARS.map(x => `{{${x}}}`).join(', ')}`,
                },
                placeholder_policy: {
                    general: 'Template should consume dynamic runtime context via placeholders where needed.',
                    distiller_like: 'Prefer {{recent_chat}} + {{last_user}}.',
                    reasoning_like: 'Prefer {{distiller}} and/or {{previous_outputs}}.',
                    auto_injected_context: 'Previous orchestration result is prepended automatically before template text.',
                    synthesizer_like: 'Prefer {{distiller}} + {{previous_outputs}}, then synthesize with auto-injected orchestration result context.',
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
    const worldInfoMessages = normalizeWorldInfoResolverMessages(
        getRecentMessages(Array.isArray(context?.chat) ? context.chat : [], settings.maxRecentMessages),
    );
    const aiSuggestProfileResolution = resolveChatCompletionRequestProfile({
        profileName: aiSuggestApiPresetName,
        defaultApi: String(context?.mainApi || 'openai').trim() || 'openai',
        defaultSource: String(context?.chatCompletionSettings?.chat_completion_source || ''),
    });
    const promptMessages = await buildPresetAwareMessages(
        context,
        settings,
        suggestSystemPrompt,
        suggestUserPrompt,
        {
            api: aiSuggestProfileResolution.requestApi,
            promptPresetName: suggestPresetName,
            worldInfoMessages,
            worldInfoType: 'quiet',
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
                                            type: { type: 'string', enum: [ORCH_NODE_TYPE_WORKER, ORCH_NODE_TYPE_REVIEW] },
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
    const apiSettingsOverride = aiSuggestProfileResolution.apiSettingsOverride;

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
                applyAgentTimeout: false,
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

function trimAiIterationMessages(session) {
    if (!session) {
        return;
    }
    if (!Array.isArray(session.messages)) {
        session.messages = [];
    }
}

function trimAiIterationToolHistory(session) {
    if (!session) {
        return;
    }
    if (!Array.isArray(session.toolHistory)) {
        session.toolHistory = [];
    }
}

function recordAiIterationToolHistory(session, toolCalls, executionResult, source = 'approved') {
    if (!session) {
        return;
    }
    if (!Array.isArray(session.toolHistory)) {
        session.toolHistory = [];
    }
    const safeCalls = Array.isArray(toolCalls)
        ? toolCalls.map(call => ({
            name: String(call?.name || '').trim(),
            args: call?.args && typeof call.args === 'object' ? structuredClone(call.args) : {},
        }))
        : [];
    session.toolHistory.push({
        at: Date.now(),
        source: String(source || 'approved'),
        toolCalls: safeCalls,
        summary: buildFriendlyIterationExecutionSummary(executionResult),
        finalized: Boolean(executionResult?.finalized),
        changed: Boolean(executionResult?.changed),
    });
    trimAiIterationToolHistory(session);
}

function stringifyIterationSimulationForPrompt(simulation) {
    if (!simulation || typeof simulation !== 'object') {
        return '(none)';
    }
    try {
        return JSON.stringify({
            ok: Boolean(simulation.ok),
            summary: String(simulation.summary || ''),
            detail: simulation.detail && typeof simulation.detail === 'object' ? simulation.detail : {},
        });
    } catch {
        return String(simulation.summary || '(simulation)');
    }
}

function stringifyIterationSimulationListForPrompt(simulations) {
    const list = Array.isArray(simulations) ? simulations : [];
    if (list.length === 0) {
        return '(none)';
    }
    try {
        return JSON.stringify(list.map(item => ({
            ok: Boolean(item?.ok),
            summary: String(item?.summary || ''),
            detail: item?.detail && typeof item.detail === 'object' ? item.detail : {},
        })));
    } catch {
        return list.map(item => String(item?.summary || '(simulation)')).join('\n');
    }
}

function buildAiIterationAutoContinuePrompt(executionResult) {
    const simulationText = stringifyIterationSimulationListForPrompt(executionResult?.simulations);
    return [
        'AUTO CONTINUE',
        'Previous tool execution is complete. Review the result and continue iteration.',
        '',
        buildFriendlyIterationExecutionSummary(executionResult),
        '',
        '<simulation_results>',
        simulationText,
        '</simulation_results>',
        '',
        'If all requested work is complete, call luker_orch_finalize_iteration.',
        'Otherwise, emit the next focused tool calls.',
    ].join('\n');
}

function cloneWorkingProfileFromEditor(editor) {
    ensureEditorIntegrity(editor);
    return {
        spec: sanitizeSpec(serializeEditorSpec(editor.spec)),
        presets: sanitizePresetMap(serializeEditorPresetMap(editor.presets)),
    };
}

function createIterationEditorFromWorkingProfile(workingProfile) {
    const safeSpec = sanitizeSpec(workingProfile?.spec);
    const safePresets = sanitizePresetMap(workingProfile?.presets);
    return {
        spec: toEditableSpec(safeSpec, toEditablePresetMap(safePresets)),
        presets: toEditablePresetMap(safePresets),
    };
}

function createAiIterationSession(context, settings) {
    syncCharacterEditorWithActiveAvatar(context);
    const scope = getDisplayedScope(context, settings);
    const editor = getEditorByScope(scope);
    const avatar = String(getCurrentAvatar(context) || '').trim();
    const sourceName = scope === 'character'
        ? (getCharacterDisplayNameByAvatar(context, avatar) || avatar || i18n('(No character card)'))
        : i18n('Global profile');
    return {
        id: `session_${Date.now()}`,
        chatKey: getChatKey(context),
        sourceScope: scope,
        sourceAvatar: avatar,
        sourceName,
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workingProfile: cloneWorkingProfileFromEditor(editor),
        messages: [],
        toolHistory: [],
        lastSimulation: null,
        pendingApproval: null,
    };
}

function ensureAiIterationSession(context, settings, { forceNew = false } = {}) {
    if (!uiState.aiIterationSession || forceNew) {
        uiState.aiIterationSession = createAiIterationSession(context, settings);
        return uiState.aiIterationSession;
    }
    const currentChatKey = getChatKey(context);
    if (String(uiState.aiIterationSession.chatKey || '') !== String(currentChatKey || '')) {
        uiState.aiIterationSession = createAiIterationSession(context, settings);
        return uiState.aiIterationSession;
    }
    return uiState.aiIterationSession;
}

function summarizeStageForUi(stage) {
    const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
    const nodeSummary = nodes.map((node) => {
        const type = normalizeNodeType(node?.type);
        return `${String(node?.id || '')}→${String(node?.preset || '')}${type === ORCH_NODE_TYPE_REVIEW ? ' [review]' : ''}`;
    }).filter(Boolean).join(' | ');
    return {
        id: String(stage?.id || ''),
        mode: String(stage?.mode || 'serial') === 'parallel' ? 'parallel' : 'serial',
        nodeSummary,
    };
}

const ITERATION_MESSAGE_FOLD_CHAR_THRESHOLD = 1200;
const ITERATION_MESSAGE_FOLD_LINE_THRESHOLD = 18;

function isIterationMessageLikelySimulationContext(text) {
    const source = String(text || '');
    if (!source) {
        return false;
    }
    return source.includes('<simulation_results>')
        || source.includes('"all_stage_outputs"')
        || source.includes('"final_stage_id"')
        || source.includes('AUTO CONTINUE')
        || source.includes('Previous tool execution is complete. Review the result and continue iteration.');
}

function renderAiIterationMessageBodyHtml(content, { auto = false } = {}) {
    const text = stripIterationThoughtForDisplay(content || '');
    if (!text) {
        return escapeHtml('(empty)');
    }
    const lineCount = text.split('\n').length;
    const simulationLike = isIterationMessageLikelySimulationContext(text);
    const tooLong = text.length > ITERATION_MESSAGE_FOLD_CHAR_THRESHOLD || lineCount > ITERATION_MESSAGE_FOLD_LINE_THRESHOLD;
    const shouldFold = simulationLike || tooLong;
    if (!shouldFold) {
        return escapeHtml(text);
    }

    const summary = simulationLike && auto
        ? i18n('Auto simulation context (folded)')
        : i18nFormat('Long message (${0} chars)', text.length);
    const preview = text.slice(0, 280).trim();

    return `
<details class="luker_orch_iter_msg_folded">
    <summary>${escapeHtml(summary)}</summary>
    ${preview ? `<div class="luker_orch_iter_msg_preview"><b>${escapeHtml(i18n('Preview'))}:</b> ${escapeHtml(preview)}${text.length > preview.length ? ' ...' : ''}</div>` : ''}
    <pre class="luker_orch_iter_msg_full">${escapeHtml(text)}</pre>
</details>`;
}

function renderAiIterationConversation(session, { loading = false, loadingText = '' } = {}) {
    const items = Array.isArray(session?.messages) ? session.messages : [];
    if (items.length === 0 && !loading) {
        return `<div class="luker_orch_iter_empty">${escapeHtml(i18n('No messages yet. Start by telling AI what you want to optimize.'))}</div>`;
    }
    const html = items.map((item) => {
        const role = String(item?.role || 'assistant').toLowerCase();
        const auto = Boolean(item?.auto);
        const label = auto ? 'AUTO' : (role === 'user' ? 'You' : 'AI');
        const bubbleClass = role === 'user' ? 'user' : 'assistant';
        const bodyHtml = renderAiIterationMessageBodyHtml(item?.content || '', { auto });
        return `
<div class="luker_orch_iter_msg ${bubbleClass}">
    <div class="luker_orch_iter_msg_head">${escapeHtml(label)}</div>
    <div class="luker_orch_iter_msg_body">${bodyHtml}</div>
</div>`;
    }).join('');
    if (!loading) {
        return html;
    }
    const label = String(loadingText || i18n('AI iteration is running...'));
    return `${html}
<div class="luker_orch_iter_msg assistant loading">
    <div class="luker_orch_iter_msg_body"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ${escapeHtml(label)}</div>
</div>`;
}

const AI_ITERATION_EDITABLE_TOOL_NAMES = new Set([
    'luker_orch_set_stage',
    'luker_orch_remove_stage',
    'luker_orch_set_node',
    'luker_orch_remove_node',
    'luker_orch_set_preset',
    'luker_orch_remove_preset',
]);

function isAiIterationEditableToolCallName(name) {
    return AI_ITERATION_EDITABLE_TOOL_NAMES.has(String(name || '').trim());
}

function splitAiIterationToolCallsForApproval(toolCalls) {
    const all = Array.isArray(toolCalls) ? toolCalls : [];
    const approvalCalls = [];
    for (const call of all) {
        const name = String(call?.name || '').trim();
        if (isAiIterationEditableToolCallName(name)) {
            approvalCalls.push(call);
            continue;
        }
    }
    return {
        allCalls: all,
        approvalCalls,
    };
}

function summarizeIterationToolCalls(toolCalls) {
    const counts = {
        stage_set: 0,
        stage_remove: 0,
        node_set: 0,
        node_remove: 0,
        preset_set: 0,
        preset_remove: 0,
        other: 0,
    };
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const name = String(call?.name || '').trim();
        if (name === 'luker_orch_set_stage') counts.stage_set += 1;
        else if (name === 'luker_orch_remove_stage') counts.stage_remove += 1;
        else if (name === 'luker_orch_set_node') counts.node_set += 1;
        else if (name === 'luker_orch_remove_node') counts.node_remove += 1;
        else if (name === 'luker_orch_set_preset') counts.preset_set += 1;
        else if (name === 'luker_orch_remove_preset') counts.preset_remove += 1;
        else counts.other += 1;
    }
    const lines = [];
    if (counts.stage_set > 0) lines.push(`更新阶段 ${counts.stage_set}`);
    if (counts.stage_remove > 0) lines.push(`删除阶段 ${counts.stage_remove}`);
    if (counts.node_set > 0) lines.push(`更新节点 ${counts.node_set}`);
    if (counts.node_remove > 0) lines.push(`删除节点 ${counts.node_remove}`);
    if (counts.preset_set > 0) lines.push(`更新预设 ${counts.preset_set}`);
    if (counts.preset_remove > 0) lines.push(`删除预设 ${counts.preset_remove}`);
    if (counts.other > 0) lines.push(`其他操作 ${counts.other}`);
    return lines;
}

function stripIterationThoughtForDisplay(value) {
    const text = String(value ?? '');
    if (!text) {
        return '';
    }
    const withoutBlocks = text.replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/gi, '');
    const withoutTags = withoutBlocks.replace(/<\/?thought\b[^>]*>/gi, '');
    return withoutTags.replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeDiffPlaceholderValue(value) {
    const text = String(value ?? '');
    const normalized = text.trim();
    if (!normalized) {
        return '';
    }
    const notSetTokens = new Set([
        'Not set',
        '未设置',
        '未設定',
    ]);
    return notSetTokens.has(normalized) ? '' : text;
}

function formatDiffValue(value) {
    return sanitizeDiffPlaceholderValue(value);
}

const LINE_DIFF_LONG_CHAR_THRESHOLD = 900;
const LINE_DIFF_LONG_LINE_THRESHOLD = 18;
const LINE_DIFF_LCS_MAX_CELLS = 240000;

function splitLineDiffText(text) {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n');
    return normalized.length > 0 ? normalized.split('\n') : [];
}

function buildLineDiffOperations(beforeLines, afterLines) {
    const a = Array.isArray(beforeLines) ? beforeLines : [];
    const b = Array.isArray(afterLines) ? afterLines : [];
    if (a.length === 0 && b.length === 0) {
        return [];
    }
    if (a.length === 0) {
        return [{ type: 'insert', lines: b.slice() }];
    }
    if (b.length === 0) {
        return [{ type: 'delete', lines: a.slice() }];
    }
    if ((a.length * b.length) > LINE_DIFF_LCS_MAX_CELLS) {
        return [
            { type: 'delete', lines: a.slice() },
            { type: 'insert', lines: b.slice() },
        ];
    }

    const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j]
                ? (dp[i + 1][j + 1] + 1)
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const operations = [];
    const push = (type, line) => {
        const last = operations[operations.length - 1];
        if (last && last.type === type) {
            last.lines.push(line);
            return;
        }
        operations.push({ type, lines: [line] });
    };

    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            push('equal', a[i]);
            i += 1;
            j += 1;
            continue;
        }
        if (dp[i + 1][j] >= dp[i][j + 1]) {
            push('delete', a[i]);
            i += 1;
            continue;
        }
        push('insert', b[j]);
        j += 1;
    }
    while (i < a.length) {
        push('delete', a[i]);
        i += 1;
    }
    while (j < b.length) {
        push('insert', b[j]);
        j += 1;
    }
    return operations;
}

function buildLineDiffRows(beforeValue, afterValue) {
    const beforeText = String(beforeValue ?? '');
    const afterText = String(afterValue ?? '');
    const operations = buildLineDiffOperations(splitLineDiffText(beforeText), splitLineDiffText(afterText));
    const stats = { added: 0, removed: 0, unchanged: 0 };

    for (const operation of operations) {
        const type = String(operation?.type || 'equal');
        const lines = Array.isArray(operation?.lines) ? operation.lines : [];
        for (const line of lines) {
            if (type === 'insert') {
                stats.added += 1;
                continue;
            }
            if (type === 'delete') {
                stats.removed += 1;
                continue;
            }
            stats.unchanged += 1;
        }
    }

    const maxChars = Math.max(beforeText.length, afterText.length);
    const lineCount = stats.added + stats.removed + stats.unchanged;
    const isLong = lineCount > LINE_DIFF_LONG_LINE_THRESHOLD || maxChars > LINE_DIFF_LONG_CHAR_THRESHOLD;

    return {
        operations,
        added: stats.added,
        removed: stats.removed,
        unchanged: stats.unchanged,
        openByDefault: !isLong,
    };
}

function splitInlineDiffTokens(text) {
    const source = String(text ?? '');
    return source.length > 0 ? (source.match(/\s+|[^\s]+/g) || []) : [];
}

function renderInlineDiffHtml(beforeText, afterText, mode = 'old') {
    const beforeTokens = splitInlineDiffTokens(beforeText);
    const afterTokens = splitInlineDiffTokens(afterText);
    if (beforeTokens.length === 0 && afterTokens.length === 0) {
        return '&nbsp;';
    }
    if ((beforeTokens.length * afterTokens.length) > LINE_DIFF_LCS_MAX_CELLS) {
        const fallback = escapeHtml(mode === 'new' ? String(afterText ?? '') : String(beforeText ?? ''));
        return fallback.length > 0 ? fallback : '&nbsp;';
    }
    const operations = buildLineDiffOperations(beforeTokens, afterTokens);
    const chunks = [];
    for (const operation of operations) {
        const type = String(operation?.type || 'equal');
        const tokenText = escapeHtml(String((Array.isArray(operation?.lines) ? operation.lines : []).join('')));
        if (!tokenText) {
            continue;
        }
        if (type === 'equal') {
            chunks.push(tokenText);
            continue;
        }
        if (type === 'delete') {
            if (mode === 'old') {
                chunks.push(`<span class="luker_orch_line_diff_word_del">${tokenText}</span>`);
            }
            continue;
        }
        if (type === 'insert') {
            if (mode === 'new') {
                chunks.push(`<span class="luker_orch_line_diff_word_add">${tokenText}</span>`);
            }
        }
    }
    return chunks.length > 0 ? chunks.join('') : '&nbsp;';
}

function buildIterationLineDiffVisualRows(operations) {
    const rows = [];
    let beforeLineNo = 1;
    let afterLineNo = 1;
    const appendRow = (rowType, oldLine, oldHtml, newLine, newHtml) => {
        rows.push({
            rowType: String(rowType || ''),
            oldLine: String(oldLine || ''),
            oldHtml: String(oldHtml || '&nbsp;'),
            newLine: String(newLine || ''),
            newHtml: String(newHtml || '&nbsp;'),
        });
    };

    const safeOperations = Array.isArray(operations) ? operations : [];
    for (let index = 0; index < safeOperations.length; index++) {
        const operation = safeOperations[index];
        const type = String(operation?.type || 'equal');
        const lines = Array.isArray(operation?.lines) ? operation.lines : [];
        const nextOperation = safeOperations[index + 1];
        if (type === 'delete' && String(nextOperation?.type || '') === 'insert') {
            const insertLines = Array.isArray(nextOperation?.lines) ? nextOperation.lines : [];
            const pairCount = Math.min(lines.length, insertLines.length);
            for (let i = 0; i < pairCount; i++) {
                const beforeLine = String(lines[i] ?? '');
                const afterLine = String(insertLines[i] ?? '');
                appendRow(
                    'luker_orch_line_diff_row_mod',
                    String(beforeLineNo),
                    renderInlineDiffHtml(beforeLine, afterLine, 'old'),
                    String(afterLineNo),
                    renderInlineDiffHtml(beforeLine, afterLine, 'new'),
                );
                beforeLineNo += 1;
                afterLineNo += 1;
            }
            for (let i = pairCount; i < lines.length; i++) {
                const text = escapeHtml(String(lines[i] ?? '')) || '&nbsp;';
                appendRow('luker_orch_line_diff_row_del', String(beforeLineNo), text, '', '&nbsp;');
                beforeLineNo += 1;
            }
            for (let i = pairCount; i < insertLines.length; i++) {
                const text = escapeHtml(String(insertLines[i] ?? '')) || '&nbsp;';
                appendRow('luker_orch_line_diff_row_add', '', '&nbsp;', String(afterLineNo), text);
                afterLineNo += 1;
            }
            index += 1;
            continue;
        }
        for (const rawLine of lines) {
            const text = String(rawLine ?? '');
            const escapedText = text.length > 0 ? escapeHtml(text) : '&nbsp;';
            if (type === 'insert') {
                appendRow('luker_orch_line_diff_row_add', '', '&nbsp;', String(afterLineNo), escapedText);
                afterLineNo += 1;
                continue;
            }
            if (type === 'delete') {
                appendRow('luker_orch_line_diff_row_del', String(beforeLineNo), escapedText, '', '&nbsp;');
                beforeLineNo += 1;
                continue;
            }
            appendRow('luker_orch_line_diff_row_eq', String(beforeLineNo), escapedText, String(afterLineNo), escapedText);
            beforeLineNo += 1;
            afterLineNo += 1;
        }
    }
    if (rows.length === 0) {
        appendRow('luker_orch_line_diff_row_eq', '', '&nbsp;', '', '&nbsp;');
    }
    return rows;
}

function renderIterationLineDiffSideRowsHtml(rows, side = 'old') {
    const safeRows = Array.isArray(rows) ? rows : [];
    const isOldSide = side !== 'new';
    return safeRows.map((row) => `
<tr class="luker_orch_line_diff_row ${escapeHtml(String(row?.rowType || ''))}">
    <td class="luker_orch_line_diff_ln ${isOldSide ? 'old' : 'new'}">${isOldSide ? escapeHtml(String(row?.oldLine || '')) : escapeHtml(String(row?.newLine || ''))}</td>
    <td class="luker_orch_line_diff_text ${isOldSide ? 'old' : 'new'}"><div class="luker_orch_line_diff_text_inner">${isOldSide ? String(row?.oldHtml || '&nbsp;') : String(row?.newHtml || '&nbsp;')}</div></td>
</tr>`).join('');
}

function renderIterationLineDiffHtml(beforeValue, afterValue, fileLabel = 'field') {
    const payload = buildLineDiffRows(
        sanitizeDiffPlaceholderValue(beforeValue),
        sanitizeDiffPlaceholderValue(afterValue),
    );
    const summary = i18nFormat('Line diff (+${0} -${1})', payload.added, payload.removed);
    const safeLabel = escapeHtml(String(fileLabel || 'field'));
    const renderedRows = buildIterationLineDiffVisualRows(payload.operations);
    const expandLabel = escapeHtml(i18n('Expand diff'));
    const resizeLabel = escapeHtml(i18n('Resize diff columns'));
    return `
<details class="luker_orch_line_diff"${payload.openByDefault ? ' open' : ''}>
    <summary>
        <span class="luker_orch_line_diff_summary_main">
            <span>${escapeHtml(summary)}</span>
            <span class="luker_orch_line_diff_meta">=${escapeHtml(String(payload.unchanged))}</span>
        </span>
        <button type="button" class="menu_button menu_button_small luker_orch_line_diff_expand_btn" data-luker-orch-action="expand-line-diff" title="${expandLabel}" aria-label="${expandLabel}">
            <i class="fa-solid fa-up-right-and-down-left-from-center" aria-hidden="true"></i>
        </button>
    </summary>
    <div class="luker_orch_line_diff_pre" data-luker-orch-diff-label="${safeLabel}">
        <div class="luker_orch_line_diff_dual" role="group">
            <div class="luker_orch_line_diff_side old">
                <div class="luker_orch_line_diff_side_scroll">
                    <table class="luker_orch_line_diff_table old" role="grid">
                        <tbody>${renderIterationLineDiffSideRowsHtml(renderedRows, 'old')}</tbody>
                    </table>
                </div>
            </div>
            <div class="luker_orch_line_diff_splitter" role="separator" aria-orientation="vertical" aria-label="${resizeLabel}" title="${resizeLabel}"></div>
            <div class="luker_orch_line_diff_side new">
                <div class="luker_orch_line_diff_side_scroll">
                    <table class="luker_orch_line_diff_table new" role="grid">
                        <tbody>${renderIterationLineDiffSideRowsHtml(renderedRows, 'new')}</tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</details>`;
}

function closeOrchExpandedDiff(rootElement) {
    const root = rootElement instanceof Element ? rootElement : null;
    if (!(root instanceof HTMLElement)) {
        return;
    }
    root.querySelectorAll('.luker_orch_line_diff_zoom_overlay').forEach((overlay) => overlay.remove());
}

function openOrchExpandedDiff(rootElement, triggerElement) {
    const root = rootElement instanceof Element ? rootElement : null;
    const trigger = triggerElement instanceof Element ? triggerElement : null;
    const diffRoot = trigger?.closest?.('.luker_orch_line_diff');
    const diffBody = diffRoot?.querySelector?.('.luker_orch_line_diff_pre');
    if (!(root instanceof HTMLElement) || !(diffBody instanceof HTMLElement)) {
        return;
    }

    closeOrchExpandedDiff(root);

    const diffLabel = String(diffBody.getAttribute('data-luker-orch-diff-label') || i18n('Line diff'));
    const closeLabel = escapeHtml(i18n('Close expanded diff'));
    const overlay = document.createElement('div');
    overlay.className = 'luker_orch_line_diff_zoom_overlay';
    overlay.innerHTML = `
<div class="luker_orch_line_diff_zoom_backdrop" data-luker-orch-action="close-line-diff-zoom"></div>
<div class="luker_orch_line_diff_zoom_dialog" role="dialog" aria-modal="true">
    <div class="luker_orch_line_diff_zoom_header">
        <div class="luker_orch_line_diff_zoom_title">${escapeHtml(diffLabel)}</div>
        <button type="button" class="menu_button menu_button_small luker_orch_line_diff_zoom_close" data-luker-orch-action="close-line-diff-zoom" title="${closeLabel}" aria-label="${closeLabel}">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
    </div>
    <div class="luker_orch_line_diff_zoom_body"></div>
</div>`;

    const zoomBody = overlay.querySelector('.luker_orch_line_diff_zoom_body');
    if (zoomBody instanceof HTMLElement) {
        zoomBody.append(diffBody.cloneNode(true));
    }

    root.append(overlay);
}

function beginOrchLineDiffResize(splitterElement, pointerEvent) {
    const splitter = splitterElement instanceof HTMLElement ? splitterElement : null;
    const pointer = pointerEvent instanceof PointerEvent ? pointerEvent : null;
    const dual = splitter?.closest?.('.luker_orch_line_diff_dual');
    if (!(splitter instanceof HTMLElement) || !(pointer instanceof PointerEvent) || !(dual instanceof HTMLElement)) {
        return;
    }

    pointer.preventDefault();
    pointer.stopPropagation();

    const bounds = dual.getBoundingClientRect();
    if (!Number.isFinite(bounds.width) || bounds.width <= 0) {
        return;
    }

    const minPercent = 15;
    const maxPercent = 85;
    const pointerId = pointer.pointerId;

    const applySplitAt = (clientX) => {
        const nextPercent = ((clientX - bounds.left) / bounds.width) * 100;
        const clampedPercent = Math.max(minPercent, Math.min(maxPercent, nextPercent));
        dual.style.setProperty('--luker-orch-split-left', `${clampedPercent}%`);
    };

    const cleanup = () => {
        splitter.classList.remove('active');
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerUp);
        try {
            splitter.releasePointerCapture(pointerId);
        } catch {
            // Ignore release errors when capture was not acquired.
        }
    };

    const handlePointerMove = (moveEvent) => {
        if (!(moveEvent instanceof PointerEvent) || moveEvent.pointerId !== pointerId) {
            return;
        }
        moveEvent.preventDefault();
        applySplitAt(moveEvent.clientX);
    };

    const handlePointerUp = (upEvent) => {
        if (!(upEvent instanceof PointerEvent) || upEvent.pointerId !== pointerId) {
            return;
        }
        upEvent.preventDefault();
        cleanup();
    };

    splitter.classList.add('active');
    applySplitAt(pointer.clientX);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    try {
        splitter.setPointerCapture(pointerId);
    } catch {
        // Pointer capture may fail in some browsers and is optional here.
    }
}

function buildAiIterationPendingDiffState(session, pending) {
    const entries = [];
    const workingProfile = structuredClone(session?.workingProfile || { spec: { stages: [] }, presets: {} });
    const stages = Array.isArray(workingProfile?.spec?.stages) ? workingProfile.spec.stages : [];
    const presets = (workingProfile?.presets && typeof workingProfile.presets === 'object') ? workingProfile.presets : {};
    const pendingPresetRemovalEntries = new Map();

    for (const call of Array.isArray(pending?.toolCalls) ? pending.toolCalls : []) {
        const name = String(call?.name || '').trim();
        if (!isAiIterationEditableToolCallName(name)) {
            continue;
        }
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        const item = {
            name,
            summary: '',
            fields: [],
            rawArgs: args,
        };

        if (name === 'luker_orch_set_stage') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const mode = String(args.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
            if (!stageId) {
                item.summary = 'Stage update skipped (missing stage_id)';
                entries.push(item);
                continue;
            }
            const before = stages.find(stage => String(stage?.id || '') === stageId) || null;
            const beforeMode = before ? String(before.mode || 'serial') : '';
            const beforePosition = before ? stages.findIndex(stage => String(stage?.id || '') === stageId) : -1;

            let target = before;
            if (!target) {
                target = { id: stageId, mode, nodes: [] };
                stages.push(target);
            }
            target.mode = mode;
            const afterPositionTarget = stages.findIndex(stage => String(stage?.id || '') === stageId);
            applyIndexReorder(stages, afterPositionTarget, Number.isInteger(args.position) ? Number(args.position) : NaN);
            const afterPosition = stages.findIndex(stage => String(stage?.id || '') === stageId);

            item.summary = stageId
                ? `Stage "${stageId}" ${before ? 'updated' : 'created'}`
                : 'Stage updated';
            item.fields.push({ label: 'mode', before: formatDiffValue(beforeMode), after: formatDiffValue(mode) });
            if (beforePosition !== afterPosition && beforePosition >= 0 && afterPosition >= 0) {
                item.fields.push({ label: 'position', before: String(beforePosition), after: String(afterPosition) });
            }
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_remove_stage') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            if (!stageId) {
                item.summary = 'Stage removal skipped (missing stage_id)';
                entries.push(item);
                continue;
            }
            const index = stages.findIndex(stage => String(stage?.id || '') === stageId);
            const removed = index >= 0 ? structuredClone(stages[index]) : null;
            if (index >= 0) {
                stages.splice(index, 1);
            }
            item.summary = stageId
                ? `Stage "${stageId}" ${removed ? 'removed' : 'remove skipped'}`
                : 'Stage remove requested';
            item.fields.push({
                label: 'result',
                before: removed ? 'exists' : '',
                after: removed ? '' : 'unchanged',
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_set_node') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const nodeId = sanitizeIdentifierToken(args.node_id, '');
            if (!stageId || !nodeId) {
                item.summary = 'Node update skipped (missing stage_id or node_id)';
                entries.push(item);
                continue;
            }
            const stage = resolveIterationStage({ workingProfile }, stageId, true);
            if (!stage) {
                item.summary = `Node "${nodeId}" update skipped (stage "${stageId}" invalid)`;
                entries.push(item);
                continue;
            }
            const nodes = Array.isArray(stage.nodes) ? stage.nodes : [];
            stage.nodes = nodes;
            const existingIndex = nodes.findIndex(node => String(node?.id || '') === nodeId);
            const beforeNode = existingIndex >= 0 ? structuredClone(nodes[existingIndex]) : null;
            const presetId = sanitizeIdentifierToken(args.preset, nodeId || 'distiller') || 'distiller';
            const nextNodeType = typeof args.type === 'string'
                ? normalizeNodeType(args.type)
                : normalizeNodeType(beforeNode?.type);
            const afterUserPromptTemplate = typeof args.userPromptTemplate === 'string'
                ? normalizeTemplateForRuntime(args.userPromptTemplate)
                : (beforeNode ? String(beforeNode.userPromptTemplate || '') : '');
            const nextNode = {
                id: nodeId,
                preset: presetId,
                type: nextNodeType,
                userPromptTemplate: afterUserPromptTemplate,
            };
            if (existingIndex >= 0) {
                nodes[existingIndex] = nextNode;
                applyIndexReorder(nodes, existingIndex, Number.isInteger(args.position) ? Number(args.position) : NaN);
            } else {
                nodes.push(nextNode);
                applyIndexReorder(nodes, nodes.length - 1, Number.isInteger(args.position) ? Number(args.position) : NaN);
            }

            item.summary = `Node "${nodeId}" in stage "${stageId}" ${beforeNode ? 'updated' : 'created'}`;
            item.fields.push({
                label: 'preset',
                before: formatDiffValue(beforeNode?.preset || ''),
                after: formatDiffValue(presetId),
            });
            item.fields.push({
                label: 'type',
                before: formatDiffValue(normalizeNodeType(beforeNode?.type)),
                after: formatDiffValue(nextNodeType),
            });
            item.fields.push({
                label: 'userPromptTemplate',
                before: formatDiffValue(beforeNode?.userPromptTemplate || ''),
                after: formatDiffValue(afterUserPromptTemplate),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_remove_node') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const nodeId = sanitizeIdentifierToken(args.node_id, '');
            if (!stageId || !nodeId) {
                item.summary = 'Node removal skipped (missing stage_id or node_id)';
                entries.push(item);
                continue;
            }
            const stage = resolveIterationStage({ workingProfile }, stageId, false);
            const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
            const index = nodes.findIndex(node => String(node?.id || '') === nodeId);
            const removed = index >= 0 ? structuredClone(nodes[index]) : null;
            if (index >= 0) {
                nodes.splice(index, 1);
            }
            item.summary = `Node "${nodeId}" in stage "${stageId}" ${removed ? 'removed' : 'remove skipped'}`;
            item.fields.push({
                label: 'result',
                before: removed ? 'exists' : '',
                after: removed ? '' : 'unchanged',
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_set_preset') {
            const presetId = sanitizeIdentifierToken(args.preset_id, '');
            if (!presetId) {
                item.summary = 'Preset update skipped (missing preset_id)';
                entries.push(item);
                continue;
            }
            const queuedRemovalEntries = pendingPresetRemovalEntries.get(presetId) || [];
            for (const queuedItem of queuedRemovalEntries) {
                queuedItem.summary = `Preset "${presetId}" removal skipped (overridden by later preset update)`;
                queuedItem.fields = [{
                    label: 'result',
                    before: '',
                    after: 'unchanged',
                }];
            }
            pendingPresetRemovalEntries.delete(presetId);
            const beforePreset = presets[presetId] && typeof presets[presetId] === 'object'
                ? structuredClone(presets[presetId])
                : null;
            const afterPreset = {
                systemPrompt: String(args.systemPrompt || '').trim(),
                userPromptTemplate: normalizeTemplateForRuntime(String(args.userPromptTemplate || '').trim()),
            };
            presets[presetId] = afterPreset;
            item.summary = `Preset "${presetId}" ${beforePreset ? 'updated' : 'created'}`;
            item.fields.push({
                label: 'systemPrompt',
                before: formatDiffValue(beforePreset?.systemPrompt || ''),
                after: formatDiffValue(afterPreset.systemPrompt),
            });
            item.fields.push({
                label: 'userPromptTemplate',
                before: formatDiffValue(beforePreset?.userPromptTemplate || ''),
                after: formatDiffValue(afterPreset.userPromptTemplate),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_remove_preset') {
            const presetId = sanitizeIdentifierToken(args.preset_id, '');
            if (!presetId) {
                item.summary = 'Preset removal skipped (missing preset_id)';
                entries.push(item);
                continue;
            }
            item.summary = `Preset "${presetId}" removal requested`;
            item.fields.push({
                label: 'result',
                before: '',
                after: 'pending',
            });
            if (!pendingPresetRemovalEntries.has(presetId)) {
                pendingPresetRemovalEntries.set(presetId, []);
            }
            pendingPresetRemovalEntries.get(presetId).push(item);
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_simulate') {
            item.summary = 'Run simulation';
            item.fields.push({
                label: 'input',
                before: '',
                after: formatDiffValue(args.input || ''),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_finalize_iteration') {
            item.summary = 'Finalize iteration';
            item.fields.push({
                label: 'summary',
                before: '',
                after: formatDiffValue(args.summary || ''),
            });
            entries.push(item);
            continue;
        }

        if (name === 'luker_orch_continue_iteration') {
            item.summary = 'Continue iteration';
            item.fields.push({
                label: 'note',
                before: '',
                after: formatDiffValue(args.note || ''),
            });
            entries.push(item);
            continue;
        }

        item.summary = name || 'Unknown operation';
        entries.push(item);
    }

    for (const [presetId, queuedEntries] of pendingPresetRemovalEntries.entries()) {
        const presetExists = Boolean(presets[presetId] && typeof presets[presetId] === 'object');
        const inUse = isPresetReferencedInSpec(workingProfile?.spec, presetId);
        let summary = '';
        let before = '';
        let after = '';
        if (!presetExists) {
            summary = `Preset "${presetId}" remove skipped`;
            after = 'unchanged';
        } else if (inUse) {
            summary = `Preset "${presetId}" removal skipped (preset is still used by nodes)`;
            before = 'exists';
            after = 'unchanged';
        } else {
            delete presets[presetId];
            summary = `Preset "${presetId}" removed`;
            before = 'exists';
        }
        for (const queuedItem of queuedEntries) {
            queuedItem.summary = summary;
            queuedItem.fields = [{
                label: 'result',
                before,
                after,
            }];
        }
    }

    return {
        entries,
        projectedProfile: workingProfile,
    };
}

function renderAiIterationDiffEntriesHtml(entries) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) {
        return '';
    }
    return list.map((entry, index) => `
<div class="luker_orch_iter_diff_item">
    <div class="luker_orch_iter_diff_title">${escapeHtml(i18nFormat('Operation ${0}', index + 1))}: ${escapeHtml(String(entry.summary || entry.name || ''))}</div>
    <div class="luker_orch_iter_diff_fields">
        ${(entry.fields || []).map(field => `
<div class="luker_orch_iter_diff_field">
    <div class="luker_orch_iter_diff_label">${escapeHtml(String(field?.label || 'field'))}</div>
    ${renderIterationLineDiffHtml(field?.before ?? '', field?.after ?? '', String(field?.label || 'field'))}
</div>`).join('')}
    </div>
    <details class="luker_orch_iter_diff_raw">
        <summary>${escapeHtml(i18n('Raw arguments'))}</summary>
        <pre>${escapeHtml(JSON.stringify(entry.rawArgs || {}, null, 2))}</pre>
    </details>
</div>`).join('');
}

function renderAiIterationPendingApproval(session, popupId, pendingEntries = []) {
    const pending = session?.pendingApproval;
    if (!pending) {
        return '';
    }
    const summaryLines = summarizeIterationToolCalls(pending.toolCalls || []);
    const assistantText = stripIterationThoughtForDisplay(pending.assistantText || '');
    return `
<div class="luker_orch_iter_pending_block">
    <div class="luker_orch_iter_col_title">${escapeHtml(i18n('Pending approval'))}</div>
    <div class="luker_orch_iter_pending_hint">${escapeHtml(i18n('AI suggested changes are waiting for approval.'))}</div>
    ${assistantText ? `<div class="luker_orch_iter_pending_text">${escapeHtml(assistantText)}</div>` : ''}
    <div class="luker_orch_iter_pending_ops">
        ${summaryLines.length > 0 ? summaryLines.map(item => `<div class="luker_orch_iter_pending_op">${escapeHtml(item)}</div>`).join('') : `<div class="luker_orch_iter_pending_op">${escapeHtml(i18n('No editable operations were produced.'))}</div>`}
    </div>
    ${Array.isArray(pendingEntries) && pendingEntries.length > 0 ? `
    <details class="luker_orch_iter_pending_diff_inline" open>
        <summary>${escapeHtml(i18n('Pending changes diff'))}</summary>
        <div class="luker_orch_iter_diff_popup">
            ${renderAiIterationDiffEntriesHtml(pendingEntries)}
        </div>
    </details>` : ''}
    <div class="luker_orch_iter_actions">
        <div id="${popupId}_approve" class="menu_button">${escapeHtml(i18n('Approve changes'))}</div>
        <div id="${popupId}_reject" class="menu_button">${escapeHtml(i18n('Reject changes'))}</div>
    </div>
</div>`;
}

function renderAiIterationWorkingProfile(session, { profileOverride = null, previewPending = false } = {}) {
    const profile = profileOverride && typeof profileOverride === 'object'
        ? profileOverride
        : (session?.workingProfile || {});
    const stages = Array.isArray(profile?.spec?.stages) ? profile.spec.stages : [];
    const stageCards = stages.map((stage) => {
        const info = summarizeStageForUi(stage);
        return `
<div class="luker_orch_iter_stage">
    <div class="luker_orch_iter_stage_title">${escapeHtml(info.id || '(stage)')}</div>
    <div class="luker_orch_iter_stage_mode">${escapeHtml(info.mode)}</div>
    <div class="luker_orch_iter_stage_nodes">${escapeHtml(info.nodeSummary || '(no nodes)')}</div>
</div>`;
    }).join('');
    const presetIds = Object.keys(profile?.presets || {}).sort();
    const presetSummary = presetIds.length > 0 ? presetIds.join(', ') : '(none)';
    const simulationSummary = session?.lastSimulation
        ? `${i18n('Simulation')}: ${String(session.lastSimulation.summary || '')}`
        : '';
    return `
<div class="luker_orch_iter_profile_meta">
    <div><b>${escapeHtml(i18nFormat('Iteration source: ${0}', session?.sourceName || i18n('Global profile')))}</b></div>
    <div>${escapeHtml(`Revision #${Number(session?.revision || 1)}`)}</div>
    ${previewPending ? `<div>${escapeHtml(i18n('AI suggested changes are waiting for approval.'))}</div>` : ''}
    ${simulationSummary ? `<div>${escapeHtml(simulationSummary)}</div>` : ''}
</div>
<div class="luker_orch_iter_stage_list">${stageCards || `<div class="luker_orch_iter_empty">(no stages)</div>`}</div>
<div class="luker_orch_iter_preset_line"><b>Presets:</b> ${escapeHtml(presetSummary)}</div>`;
}

function buildAiIterationSystemPrompt(settings) {
    const base = normalizeTemplateForAiPrompt(String(settings.aiSuggestSystemPrompt || '').trim()) || getDefaultAiSuggestSystemPrompt();
    return [
        base,
        '',
        'Iteration mode contract:',
        '- You are editing an existing orchestration profile incrementally (diff-style).',
        '- Prefer targeted edits. Do not rebuild everything unless the user explicitly asks.',
        '- Think through what to change and why before issuing tool calls; output format follows the current prompt policy.',
        '- Runtime prepends previous orchestration result before node template text; do not use placeholders for that context.',
        '- Nodes can be worker or review. Review nodes inspect already-executed worker outputs, may rerun specific earlier worker node ids, and do not generate downstream guidance.',
        '- Keep approved worker outputs as passthrough context after review; do not invent critic summaries to replace them.',
        '- Prefer dedicated serial review stages after the worker stages they audit. Do not place review nodes in the final stage.',
        `- Use luker_orch_set_node.type to set "${ORCH_NODE_TYPE_REVIEW}" when a node should behave as a reviewer.`,
        '- If user asks to test, call luker_orch_simulate with suitable input.',
        '- If you need one more autonomous step right after current execution, call luker_orch_continue_iteration.',
        '- If you need user decision or clarification, do not call continue/finalize. Stop and wait for user.',
        '- When iteration is complete, call luker_orch_finalize_iteration.',
        '- Keep output practical and concise for real RP usage.',
    ].join('\n');
}

function getGlobalIterationBaselineProfile(settings) {
    return {
        spec: sanitizeSpec(settings?.orchestrationSpec),
        presets: sanitizePresetMap(settings?.presets),
    };
}

function buildAiIterationUserPrompt(session, userInputText, {
    globalProfile = null,
    sourceScope = '',
    sourceName = '',
} = {}) {
    const recentConversation = (Array.isArray(session?.messages) ? session.messages : [])
        .map(item => `${String(item?.role || 'assistant').toUpperCase()}: ${String(item?.content || '')}`)
        .join('\n\n');
    const workingProfileValue = {
        spec: session?.workingProfile?.spec || { stages: [] },
        presets: session?.workingProfile?.presets || {},
    };
    const globalProfileValue = {
        spec: globalProfile?.spec || { stages: [] },
        presets: globalProfile?.presets || {},
    };
    const aiVisibleWorkingProfile = sanitizeProfileForAiPrompt(workingProfileValue);
    const aiVisibleGlobalProfile = sanitizeProfileForAiPrompt(globalProfileValue);
    const latestSimulationText = stringifyIterationSimulationForPrompt(session?.lastSimulation);
    const latestSnapshotText = toReadableYamlText(normalizeOrchestrationSnapshot(latestOrchestrationSnapshot) || {}, '{}');
    return [
        '# iteration_input',
        'You are in a multi-turn orchestration iteration session.',
        'Apply focused edits through tools only. Keep edits minimal and high-impact.',
        'If source_scope is character, treat global_profile_baseline as canonical reference and keep character edits as targeted overrides.',
        '',
        '## source_scope',
        String(sourceScope || session?.sourceScope || 'global'),
        '',
        '## source_name',
        String(sourceName || session?.sourceName || ''),
        '',
        '## global_profile_baseline',
        '```yaml',
        toReadableYamlText(aiVisibleGlobalProfile, '{}'),
        '```',
        '',
        '## working_profile',
        '```yaml',
        toReadableYamlText(aiVisibleWorkingProfile, '{}'),
        '```',
        '',
        '## review_node_contract',
        '```yaml',
        toReadableYamlText({
            type_field: {
                worker: ORCH_NODE_TYPE_WORKER,
                review: ORCH_NODE_TYPE_REVIEW,
            },
            runtime_behavior: 'Review nodes inspect currently available worker outputs, request rerun for specific earlier worker node ids when needed, and otherwise approve without adding new output.',
            downstream_behavior: 'Later stages keep receiving passthrough worker outputs; critic/review nodes do not replace them with summaries.',
            topology_rule: 'Prefer dedicated serial review stages after the workers being audited. Do not place review nodes in the final stage.',
        }, '{}'),
        '```',
        '',
        '## conversation_history',
        '```text',
        recentConversation || '(empty)',
        '```',
        '',
        '## latest_simulation',
        '```text',
        latestSimulationText,
        '```',
        '',
        '## latest_orchestration_snapshot',
        '```yaml',
        latestSnapshotText,
        '```',
        '',
        '## user_request',
        String(userInputText || '').trim(),
    ].join('\n');
}

function buildAiIterationToolSet() {
    return [
        {
            type: 'function',
            function: {
                name: 'luker_orch_set_stage',
                description: 'Create or update one stage. Optional position can reorder it.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage_id: { type: 'string' },
                        mode: { type: 'string', enum: ['serial', 'parallel'] },
                        position: { type: 'integer' },
                    },
                    required: ['stage_id', 'mode'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_remove_stage',
                description: 'Remove one stage by id.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage_id: { type: 'string' },
                    },
                    required: ['stage_id'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_set_node',
                description: 'Create or update one node inside a stage. Optional position can reorder it.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage_id: { type: 'string' },
                        node_id: { type: 'string' },
                        preset: { type: 'string' },
                        type: { type: 'string', enum: [ORCH_NODE_TYPE_WORKER, ORCH_NODE_TYPE_REVIEW] },
                        userPromptTemplate: { type: 'string' },
                        position: { type: 'integer' },
                    },
                    required: ['stage_id', 'node_id'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_remove_node',
                description: 'Remove one node from a stage.',
                parameters: {
                    type: 'object',
                    properties: {
                        stage_id: { type: 'string' },
                        node_id: { type: 'string' },
                    },
                    required: ['stage_id', 'node_id'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_set_preset',
                description: 'Create or update one preset.',
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
                name: 'luker_orch_remove_preset',
                description: 'Remove one preset by id. Preset in use by nodes cannot be removed.',
                parameters: {
                    type: 'object',
                    properties: {
                        preset_id: { type: 'string' },
                    },
                    required: ['preset_id'],
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_simulate',
                description: 'Run orchestration simulation against recent chat messages or a custom user message.',
                parameters: {
                    type: 'object',
                    properties: {
                        recent_messages_n: { type: 'integer' },
                        simulation_text: { type: 'string' },
                        trigger: { type: 'string', enum: ['normal', 'regenerate', 'continue'] },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_continue_iteration',
                description: 'Request one automatic follow-up round after current tool execution.',
                parameters: {
                    type: 'object',
                    properties: {
                        note: { type: 'string' },
                    },
                    additionalProperties: false,
                },
            },
        },
        {
            type: 'function',
            function: {
                name: 'luker_orch_finalize_iteration',
                description: 'Finalize this iteration turn with a concise summary.',
                parameters: {
                    type: 'object',
                    properties: {
                        summary: { type: 'string' },
                    },
                    additionalProperties: false,
                },
            },
        },
    ];
}

function getChatMessagesForSimulation(context, recentMessagesN) {
    const all = Array.isArray(context?.chat) ? context.chat : [];
    const n = Math.max(1, Math.min(60, Math.floor(Number(recentMessagesN) || 12)));
    return normalizeWorldInfoResolverMessages(all.slice(Math.max(0, all.length - n)));
}

async function runAiIterationSimulation(context, session, args = {}, abortSignal = null) {
    await loadOrchestratorChatState(context, { force: false });
    const snapshotBefore = normalizeOrchestrationSnapshot(latestOrchestrationSnapshot);
    const simulationMessages = getChatMessagesForSimulation(context, args.recent_messages_n);
    const customText = String(args.simulation_text || '').trim();
    if (customText) {
        simulationMessages.push({
            role: 'user',
            is_user: true,
            name: String(context?.name1 || 'User'),
            mes: customText,
            content: customText,
        });
    }
    if (simulationMessages.length === 0) {
        return {
            ok: false,
            summary: 'No messages available for simulation.',
            detail: {},
        };
    }
    const profile = {
        spec: sanitizeSpec(session?.workingProfile?.spec),
        presets: sanitizePresetMap(session?.workingProfile?.presets),
    };
    const payload = {
        type: String(args?.trigger || 'normal').trim().toLowerCase() || 'normal',
        coreChat: simulationMessages,
        signal: abortSignal,
        forceWorldInfoResimulate: true,
    };
    let run = null;
    try {
        run = await runOrchestration(context, payload, structuredClone(simulationMessages), profile);
    } finally {
        latestOrchestrationSnapshot = snapshotBefore ? structuredClone(snapshotBefore) : null;
    }
    const allStageOutputs = compactStageOutputs(run?.stageOutputs || []);
    const finalStage = getFinalStageSnapshot(run?.stageOutputs || []);
    const finalNodes = Array.isArray(finalStage?.nodes) ? finalStage.nodes : [];
    return {
        ok: true,
        summary: `Simulated ${Number(run?.stageOutputs?.length || 0)} stages with ${finalNodes.length} final outputs.`,
        detail: {
            stage_count: Number(run?.stageOutputs?.length || 0),
            final_stage_id: String(finalStage?.id || ''),
            final_stage_mode: String(finalStage?.mode || 'serial'),
            all_stage_outputs: allStageOutputs,
            input: {
                recent_messages_n: Math.max(1, Math.min(60, Math.floor(Number(args?.recent_messages_n) || 12))),
                simulation_text_used: Boolean(customText),
            },
        },
    };
}

function resolveIterationStage(session, stageId, createIfMissing = false) {
    const safeId = sanitizeIdentifierToken(stageId, '');
    if (!safeId) {
        return null;
    }
    const stages = session?.workingProfile?.spec?.stages || [];
    let stage = stages.find(item => String(item?.id || '') === safeId) || null;
    if (!stage && createIfMissing) {
        stage = { id: safeId, mode: 'serial', nodes: [] };
        stages.push(stage);
    }
    return stage;
}

function applyIndexReorder(list, currentIndex, position) {
    if (!Array.isArray(list) || currentIndex < 0 || currentIndex >= list.length) {
        return;
    }
    if (!Number.isInteger(position)) {
        return;
    }
    const targetIndex = Math.max(0, Math.min(list.length - 1, position));
    if (targetIndex === currentIndex) {
        return;
    }
    const [item] = list.splice(currentIndex, 1);
    list.splice(targetIndex, 0, item);
}

function buildFriendlyIterationExecutionSummary(result) {
    const lines = [];
    const actionCount = Array.isArray(result?.actions) ? result.actions.length : 0;
    if (actionCount > 0) {
        lines.push(`已执行 ${actionCount} 项操作。`);
    }
    const simulations = Array.isArray(result?.simulations) ? result.simulations : [];
    if (simulations.length > 0) {
        for (const sim of simulations) {
            lines.push(String(sim?.summary || '模拟已执行。'));
        }
    }
    if (result?.finalizeSummary) {
        lines.push(`总结：${String(result.finalizeSummary)}`);
    }
    return lines.join('\n').trim() || '已执行。';
}

async function executeAiIterationToolCalls(context, session, toolCalls, abortSignal = null) {
    const actions = [];
    const simulations = [];
    let finalized = false;
    let finalizeSummary = '';
    let continueRequested = false;
    let changed = false;
    const allowedPresetFallback = Object.keys(session?.workingProfile?.presets || {})[0] || 'distiller';
    const pendingPresetRemovalActions = new Map();
    for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const name = String(call?.name || '').trim();
        const args = call?.args && typeof call.args === 'object' ? call.args : {};
        if (!name) {
            continue;
        }
        if (name === 'luker_orch_set_stage') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            if (!stageId) {
                actions.push('Skipped stage update: missing stage_id.');
                continue;
            }
            const mode = String(args.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
            const stage = resolveIterationStage(session, stageId, true);
            stage.mode = mode;
            if (!Array.isArray(stage.nodes)) {
                stage.nodes = [];
            }
            const stages = session.workingProfile.spec.stages;
            const index = stages.findIndex(item => String(item?.id || '') === stageId);
            applyIndexReorder(stages, index, Number.isInteger(args.position) ? Number(args.position) : NaN);
            actions.push(`Stage "${stageId}" updated (${mode}).`);
            changed = true;
            continue;
        }
        if (name === 'luker_orch_remove_stage') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const stages = session?.workingProfile?.spec?.stages || [];
            const index = stages.findIndex(item => String(item?.id || '') === stageId);
            if (index >= 0) {
                stages.splice(index, 1);
                actions.push(`Stage "${stageId}" removed.`);
                changed = true;
            } else {
                actions.push(`Skipped stage removal: "${stageId}" not found.`);
            }
            continue;
        }
        if (name === 'luker_orch_set_node') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const nodeId = sanitizeIdentifierToken(args.node_id, '');
            if (!stageId || !nodeId) {
                actions.push('Skipped node update: missing stage_id or node_id.');
                continue;
            }
            const stage = resolveIterationStage(session, stageId, true);
            const presetId = sanitizeIdentifierToken(args.preset, nodeId || allowedPresetFallback) || allowedPresetFallback;
            if (!session.workingProfile.presets[presetId]) {
                session.workingProfile.presets[presetId] = createPresetDraft();
            }
            const nodes = Array.isArray(stage.nodes) ? stage.nodes : [];
            const existingIndex = nodes.findIndex(item => String(item?.id || '') === nodeId);
            const nextNodeType = typeof args.type === 'string'
                ? normalizeNodeType(args.type)
                : normalizeNodeType(existingIndex >= 0 ? nodes[existingIndex]?.type : ORCH_NODE_TYPE_WORKER);
            const nextNode = {
                id: nodeId,
                preset: presetId,
                type: nextNodeType,
                userPromptTemplate: typeof args.userPromptTemplate === 'string'
                    ? normalizeTemplateForRuntime(args.userPromptTemplate)
                    : (existingIndex >= 0 ? String(nodes[existingIndex]?.userPromptTemplate || '') : ''),
            };
            if (existingIndex >= 0) {
                nodes[existingIndex] = nextNode;
                applyIndexReorder(nodes, existingIndex, Number.isInteger(args.position) ? Number(args.position) : NaN);
                actions.push(`Node "${nodeId}" updated in stage "${stageId}".`);
            } else {
                nodes.push(nextNode);
                applyIndexReorder(nodes, nodes.length - 1, Number.isInteger(args.position) ? Number(args.position) : NaN);
                actions.push(`Node "${nodeId}" added to stage "${stageId}".`);
            }
            stage.nodes = nodes;
            changed = true;
            continue;
        }
        if (name === 'luker_orch_remove_node') {
            const stageId = sanitizeIdentifierToken(args.stage_id, '');
            const nodeId = sanitizeIdentifierToken(args.node_id, '');
            const stage = resolveIterationStage(session, stageId, false);
            if (!stage || !Array.isArray(stage.nodes)) {
                actions.push(`Skipped node removal: stage "${stageId}" not found.`);
                continue;
            }
            const index = stage.nodes.findIndex(item => String(item?.id || '') === nodeId);
            if (index >= 0) {
                stage.nodes.splice(index, 1);
                actions.push(`Node "${nodeId}" removed from stage "${stageId}".`);
                changed = true;
            } else {
                actions.push(`Skipped node removal: "${nodeId}" not found in stage "${stageId}".`);
            }
            continue;
        }
        if (name === 'luker_orch_set_preset') {
            const presetId = sanitizeIdentifierToken(args.preset_id, '');
            if (!presetId) {
                actions.push('Skipped preset update: missing preset_id.');
                continue;
            }
            const queuedRemovalActionIndexes = pendingPresetRemovalActions.get(presetId) || [];
            for (const actionIndex of queuedRemovalActionIndexes) {
                if (Number.isInteger(actionIndex) && actionIndex >= 0 && actionIndex < actions.length) {
                    actions[actionIndex] = `Skipped preset removal: "${presetId}" overridden by later preset update.`;
                }
            }
            pendingPresetRemovalActions.delete(presetId);
            session.workingProfile.presets[presetId] = {
                systemPrompt: String(args.systemPrompt || '').trim(),
                userPromptTemplate: normalizeTemplateForRuntime(String(args.userPromptTemplate || '').trim()),
            };
            actions.push(`Preset "${presetId}" updated.`);
            changed = true;
            continue;
        }
        if (name === 'luker_orch_remove_preset') {
            const presetId = sanitizeIdentifierToken(args.preset_id, '');
            if (!presetId) {
                actions.push(`Skipped preset removal: "${presetId}" not found.`);
                continue;
            }
            if (!pendingPresetRemovalActions.has(presetId)) {
                pendingPresetRemovalActions.set(presetId, []);
            }
            actions.push(`Preset "${presetId}" removal requested.`);
            pendingPresetRemovalActions.get(presetId).push(actions.length - 1);
            continue;
        }
        if (name === 'luker_orch_simulate') {
            const simulation = await runAiIterationSimulation(context, session, args, abortSignal);
            simulations.push(simulation);
            session.lastSimulation = simulation;
            actions.push(simulation.ok
                ? `Simulation finished: ${simulation.summary}`
                : `Simulation failed: ${simulation.summary}`);
            continue;
        }
        if (name === 'luker_orch_continue_iteration') {
            continueRequested = true;
            const note = String(args.note || '').trim();
            actions.push(`Continue requested.${note ? ` ${note}` : ''}`);
            continue;
        }
        if (name === 'luker_orch_finalize_iteration') {
            finalized = true;
            finalizeSummary = String(args.summary || '').trim();
            actions.push(`Iteration finalized.${finalizeSummary ? ` ${finalizeSummary}` : ''}`);
            continue;
        }
        actions.push(`Ignored unknown action: ${name}`);
    }

    for (const [presetId, actionIndexes] of pendingPresetRemovalActions.entries()) {
        const presetExists = Boolean(session?.workingProfile?.presets?.[presetId]);
        const inUse = isPresetReferencedInSpec(session?.workingProfile?.spec, presetId);
        let message = '';
        if (!presetExists) {
            message = `Skipped preset removal: "${presetId}" not found.`;
        } else if (inUse) {
            message = `Skipped preset removal: "${presetId}" is still used by nodes.`;
        } else {
            delete session.workingProfile.presets[presetId];
            message = `Preset "${presetId}" removed.`;
            changed = true;
        }
        for (const actionIndex of actionIndexes) {
            if (Number.isInteger(actionIndex) && actionIndex >= 0 && actionIndex < actions.length) {
                actions[actionIndex] = message;
            }
        }
    }

    session.workingProfile.spec = sanitizeSpec(session.workingProfile.spec);
    session.workingProfile.presets = sanitizePresetMap(session.workingProfile.presets);
    session.revision = Number(session.revision || 0) + (changed ? 1 : 0);
    session.updatedAt = Date.now();
    trimAiIterationMessages(session);

    return {
        actions,
        simulations,
        finalized,
        finalizeSummary,
        continueRequested,
        changed,
    };
}

async function runAiIterationTurn(context, settings, session, userText, abortSignal = null, { auto = false, appendUserMessage = true } = {}) {
    const text = String(userText || '').trim();
    if (!text) {
        return { ok: false, message: 'empty_input' };
    }
    if (appendUserMessage) {
        session.messages.push({ role: 'user', content: text, auto: Boolean(auto), at: Date.now() });
        trimAiIterationMessages(session);
    }

    const aiSuggestApiPresetName = String(settings.aiSuggestApiPresetName || '').trim();
    const suggestPresetName = String(settings.aiSuggestPresetName || '').trim();
    const aiSuggestProfileResolution = resolveChatCompletionRequestProfile({
        profileName: aiSuggestApiPresetName,
        defaultApi: String(context?.mainApi || 'openai').trim() || 'openai',
        defaultSource: String(context?.chatCompletionSettings?.chat_completion_source || ''),
    });
    const api = aiSuggestProfileResolution.requestApi;
    const apiSettingsOverride = aiSuggestProfileResolution.apiSettingsOverride;
    const tools = buildAiIterationToolSet();
    const allowedNames = new Set(tools.map(tool => String(tool?.function?.name || '').trim()).filter(Boolean));
    const globalBaseline = getGlobalIterationBaselineProfile(settings);

    const promptMessages = await buildPresetAwareMessages(
        context,
        settings,
        buildAiIterationSystemPrompt(settings),
        buildAiIterationUserPrompt(session, text, {
            globalProfile: globalBaseline,
            sourceScope: String(session?.sourceScope || ''),
            sourceName: String(session?.sourceName || ''),
        }),
        {
            api,
            promptPresetName: suggestPresetName,
            worldInfoMessages: session.messages,
        },
    );
    const detailed = await requestToolCallsWithRetry(settings, promptMessages, {
        tools,
        allowedNames,
        llmPresetName: suggestPresetName,
        apiSettingsOverride,
        abortSignal,
        includeAssistantText: true,
        allowNoToolCalls: true,
        applyAgentTimeout: false,
    });
    const toolCalls = Array.isArray(detailed?.toolCalls) ? detailed.toolCalls : [];
    const assistantText = stripIterationThoughtForDisplay(detailed?.assistantText || '');
    if (toolCalls.length === 0) {
        if (assistantText) {
            session.messages.push({
                role: 'assistant',
                content: assistantText,
                auto: false,
                at: Date.now(),
            });
            trimAiIterationMessages(session);
            session.pendingApproval = null;
            session.updatedAt = Date.now();
            return { ok: true, pending: false, textOnly: true };
        }
        throw new Error(i18n('Function output is invalid.'));
    }
    const split = splitAiIterationToolCallsForApproval(toolCalls);
    if (split.approvalCalls.length > 0) {
        session.pendingApproval = {
            assistantText,
            toolCalls: split.approvalCalls,
            executionToolCalls: split.allCalls,
            createdAt: Date.now(),
        };
        session.updatedAt = Date.now();
        return { ok: true, pending: true };
    }

    if (assistantText) {
        session.messages.push({
            role: 'assistant',
            content: assistantText,
            auto: false,
            at: Date.now(),
        });
    }
    const executionResult = await executeAiIterationToolCalls(context, session, split.allCalls, abortSignal);
    recordAiIterationToolHistory(session, split.allCalls, executionResult, 'auto');
    session.messages.push({
        role: 'assistant',
        content: buildFriendlyIterationExecutionSummary(executionResult),
        auto: false,
        at: Date.now(),
    });
    trimAiIterationMessages(session);
    session.pendingApproval = null;
    session.updatedAt = Date.now();
    return {
        ok: true,
        pending: false,
        autoApplied: true,
        executionResult,
    };
}

async function applyAiIterationSessionToGlobal(context, settings, session, root) {
    settings.orchestrationSpec = sanitizeSpec(session?.workingProfile?.spec);
    settings.presets = sanitizePresetMap(session?.workingProfile?.presets);
    await saveSettings();
    uiState.globalEditor = loadGlobalEditorState();
    ensureEditorIntegrity(uiState.globalEditor);
    renderDynamicPanels(root, context);
    notifySuccess(i18n('Iteration session applied to global profile.'));
    updateUiStatus(i18n('Iteration session applied to global profile.'));
}

async function applyAiIterationSessionToCharacter(context, settings, session, root) {
    const avatar = String(getCurrentAvatar(context) || '').trim();
    if (!avatar) {
        notifyError(i18n('No character selected. Cannot apply to character override.'));
        return;
    }
    const importedEditor = createIterationEditorFromWorkingProfile(session?.workingProfile || {});
    const ok = await persistCharacterEditor(context, settings, avatar, {
        editor: {
            ...importedEditor,
            enabled: true,
            notes: '',
        },
        forceEnabled: true,
    });
    if (!ok) {
        notifyError(i18n('Failed to persist character override.'));
        return;
    }
    uiState.characterEditor = loadCharacterEditorState(context, avatar);
    ensureEditorIntegrity(uiState.characterEditor);
    renderDynamicPanels(root, context);
    const name = getCharacterDisplayNameByAvatar(context, avatar) || avatar;
    notifySuccess(i18nFormat('Iteration session applied to character override: ${0}.', name));
    updateUiStatus(i18nFormat('Iteration session applied to character override: ${0}.', name));
}

function buildAiIterationPopupHtml(popupId, session) {
    return `
<div id="${popupId}" class="luker_orch_iter_popup">
    <div class="luker_orch_iter_head">
        <div class="luker_orch_iter_title">${escapeHtml(i18n('AI Iteration Studio'))}</div>
        <div class="luker_orch_iter_sub">${escapeHtml(i18nFormat('Iteration source: ${0}', session?.sourceName || i18n('Global profile')))}</div>
    </div>
    <div class="luker_orch_iter_grid">
        <div class="luker_orch_iter_col">
            <div class="luker_orch_iter_col_title">${escapeHtml(i18n('Conversation'))}</div>
            <div id="${popupId}_conversation" class="luker_orch_iter_conversation"></div>
            <div id="${popupId}_pending"></div>
            <textarea id="${popupId}_input" class="text_pole textarea_compact" rows="4" placeholder="${escapeHtml(i18n('Input request for AI, for example: keep pacing tight and run a simulation with my custom scene...'))}"></textarea>
            <div class="luker_orch_iter_actions">
                <div id="${popupId}_send" class="menu_button">${escapeHtml(i18n('Send to AI'))}</div>
                <div id="${popupId}_stop" class="menu_button">${escapeHtml(i18n('Stop'))}</div>
                <div id="${popupId}_clear" class="menu_button">${escapeHtml(i18n('Clear Session'))}</div>
            </div>
        </div>
        <div class="luker_orch_iter_col">
            <div class="luker_orch_iter_col_title">${escapeHtml(i18n('Working profile'))}</div>
            <div id="${popupId}_profile" class="luker_orch_iter_profile"></div>
            <div class="luker_orch_iter_actions">
                <div id="${popupId}_apply_global" class="menu_button">${escapeHtml(i18n('Apply to Global'))}</div>
                <div id="${popupId}_apply_character" class="menu_button">${escapeHtml(i18n('Apply to Character'))}</div>
            </div>
        </div>
    </div>
</div>`;
}

async function openAiIterationStudio(context, settings, root) {
    ensureStyles();
    const session = ensureAiIterationSession(context, settings, { forceNew: false });
    const popupId = `luker_orch_iter_popup_${Date.now()}`;
    const namespace = `.lukerOrchIter_${popupId}`;
    const selector = `#${popupId}`;
    const popupHtml = buildAiIterationPopupHtml(popupId, session);
    let isRunning = false;

    const rerender = () => {
        const popupRoot = jQuery(selector);
        if (!popupRoot.length) {
            return;
        }
        const pendingState = buildAiIterationPendingDiffState(session, session?.pendingApproval);
        popupRoot.find(`#${popupId}_conversation`).html(renderAiIterationConversation(session, {
            loading: isRunning,
            loadingText: i18n('AI iteration is running...'),
        }));
        popupRoot.find(`#${popupId}_pending`).html(renderAiIterationPendingApproval(session, popupId, pendingState.entries));
        popupRoot.find(`#${popupId}_profile`).html(renderAiIterationWorkingProfile(session, {
            profileOverride: null,
            previewPending: Boolean(session?.pendingApproval),
        }));
    };

    const setStatus = (text) => {
        const popupRoot = jQuery(selector);
        if (!popupRoot.length) {
            return;
        }
        popupRoot.find(`#${popupId}_status`).text(String(text || ''));
    };

    const maybeRunAutoContinue = async (executionResult, controller, source = 'approved') => {
        if (!executionResult || typeof executionResult !== 'object') {
            return false;
        }
        if (executionResult.finalized) {
            setStatus(source === 'approved'
                ? i18n('Changes approved and applied.')
                : i18n('AI iteration updated.'));
            rerender();
            return true;
        }
        if (executionResult.continueRequested || (Array.isArray(executionResult.simulations) && executionResult.simulations.length > 0)) {
            setStatus(i18n('Running auto-continue...'));
            const autoPrompt = buildAiIterationAutoContinuePrompt(executionResult);
            const followUp = await runAiIterationTurn(context, settings, session, autoPrompt, controller.signal, {
                auto: true,
                appendUserMessage: false,
            });
            setStatus(followUp?.pending ? i18n('AI suggested changes are waiting for approval.') : i18n('AI iteration updated.'));
            rerender();
            return true;
        }
        return false;
    };

    const popupPromise = context.callGenericPopup(
        popupHtml,
        context.POPUP_TYPE.TEXT,
        i18n('AI Iteration Studio'),
        {
            okButton: i18n('Close'),
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        },
    );

    jQuery(document).off(namespace);
    rerender();

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_send`, async function () {
        const popupRoot = jQuery(selector);
        if (!popupRoot.length) {
            return;
        }
        const input = popupRoot.find(`#${popupId}_input`);
        const text = String(input.val() || '').trim();
        if (!text) {
            return;
        }
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return;
        }
        const controller = new AbortController();
        activeAiIterationAbortController = controller;
        session.messages.push({ role: 'user', content: text, auto: false, at: Date.now() });
        trimAiIterationMessages(session);
        input.val('');
        isRunning = true;
        rerender();
        setStatus(i18n('AI iteration is running...'));
        try {
            const result = await runAiIterationTurn(context, settings, session, text, controller.signal, { appendUserMessage: false });
            if (result?.pending) {
                setStatus(i18n('AI suggested changes are waiting for approval.'));
            } else if (result?.autoApplied) {
                const didHandle = await maybeRunAutoContinue(result.executionResult, controller, 'auto');
                if (!didHandle) {
                    setStatus(i18n('AI iteration updated.'));
                }
            } else {
                setStatus(i18n('AI iteration updated.'));
            }
            rerender();
        } catch (error) {
            if (isAbortError(error, controller.signal)) {
                setStatus(i18n('Iteration run cancelled.'));
            } else {
                setStatus(i18nFormat('Iteration run failed: ${0}', String(error?.message || error)));
            }
        } finally {
            if (activeAiIterationAbortController === controller) {
                activeAiIterationAbortController = null;
            }
            isRunning = false;
            rerender();
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_stop`, function () {
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            activeAiIterationAbortController.abort();
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_clear`, function () {
        uiState.aiIterationSession = createAiIterationSession(context, settings);
        const nextSession = uiState.aiIterationSession;
        session.id = nextSession.id;
        session.chatKey = nextSession.chatKey;
        session.sourceScope = nextSession.sourceScope;
        session.sourceAvatar = nextSession.sourceAvatar;
        session.sourceName = nextSession.sourceName;
        session.revision = nextSession.revision;
        session.createdAt = nextSession.createdAt;
        session.updatedAt = nextSession.updatedAt;
        session.workingProfile = nextSession.workingProfile;
        session.messages = [];
        session.toolHistory = [];
        session.lastSimulation = null;
        session.pendingApproval = null;
        setStatus(i18n('Iteration session reset.'));
        rerender();
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="expand-line-diff"]`, function (event) {
        event.preventDefault();
        event.stopPropagation();
        const rootElement = document.querySelector(selector);
        openOrchExpandedDiff(rootElement, this);
    });

    jQuery(document).on(`click${namespace}`, `${selector} [data-luker-orch-action="close-line-diff-zoom"], ${selector} .luker_orch_line_diff_zoom_backdrop`, function (event) {
        event.preventDefault();
        event.stopPropagation();
        const rootElement = document.querySelector(selector);
        closeOrchExpandedDiff(rootElement);
    });

    jQuery(document).on(`keydown${namespace}`, function (event) {
        if (event.key !== 'Escape') {
            return;
        }
        const rootElement = document.querySelector(selector);
        const overlay = rootElement?.querySelector?.('.luker_orch_line_diff_zoom_overlay');
        if (!(overlay instanceof HTMLElement)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        closeOrchExpandedDiff(rootElement);
    });

    jQuery(document).on(`pointerdown${namespace}`, `${selector} .luker_orch_line_diff_splitter`, function (event) {
        beginOrchLineDiffResize(this, event.originalEvent || event);
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_approve`, async function () {
        const pending = session?.pendingApproval;
        if (!pending) {
            return;
        }
        if (activeAiIterationAbortController && !activeAiIterationAbortController.signal.aborted) {
            return;
        }
        const controller = new AbortController();
        activeAiIterationAbortController = controller;
        isRunning = true;
        rerender();
        const pendingSnapshot = {
            assistantText: String(pending.assistantText || ''),
            toolCalls: Array.isArray(pending.toolCalls) ? structuredClone(pending.toolCalls) : [],
            executionToolCalls: Array.isArray(pending.executionToolCalls) ? structuredClone(pending.executionToolCalls) : [],
            createdAt: Number(pending.createdAt || Date.now()),
        };
        session.pendingApproval = null;
        rerender();
        setStatus(i18n('Applying approved changes...'));
        try {
            if (pendingSnapshot.assistantText) {
                session.messages.push({
                    role: 'assistant',
                    content: pendingSnapshot.assistantText,
                    auto: false,
                    at: Date.now(),
                });
            }
            const executionToolCalls = pendingSnapshot.executionToolCalls.length > 0
                ? pendingSnapshot.executionToolCalls
                : pendingSnapshot.toolCalls;
            const result = await executeAiIterationToolCalls(context, session, executionToolCalls, controller.signal);
            recordAiIterationToolHistory(session, executionToolCalls, result, 'approved');
            session.messages.push({
                role: 'assistant',
                content: buildFriendlyIterationExecutionSummary(result),
                auto: false,
                at: Date.now(),
            });
            trimAiIterationMessages(session);
            const didHandle = await maybeRunAutoContinue(result, controller, 'approved');
            if (!didHandle) {
                setStatus(i18n('Changes approved and applied. Waiting for your next instruction.'));
                rerender();
            }
        } catch (error) {
            if (!session.pendingApproval) {
                session.pendingApproval = pendingSnapshot;
                rerender();
            }
            if (isAbortError(error, controller.signal)) {
                setStatus(i18n('Iteration run cancelled.'));
            } else {
                setStatus(i18nFormat('Iteration run failed: ${0}', String(error?.message || error)));
            }
        } finally {
            if (activeAiIterationAbortController === controller) {
                activeAiIterationAbortController = null;
            }
            isRunning = false;
            rerender();
        }
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_reject`, function () {
        if (!session?.pendingApproval) {
            return;
        }
        session.pendingApproval = null;
        session.messages.push({
            role: 'assistant',
            content: i18n('Changes rejected.'),
            auto: false,
            at: Date.now(),
        });
        trimAiIterationMessages(session);
        setStatus(i18n('Changes rejected.'));
        rerender();
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_apply_global`, async function () {
        await applyAiIterationSessionToGlobal(context, settings, session, root);
        rerender();
    });

    jQuery(document).on(`click${namespace}`, `${selector} #${popupId}_apply_character`, async function () {
        await applyAiIterationSessionToCharacter(context, settings, session, root);
        rerender();
    });

    await popupPromise;
    jQuery(document).off(namespace);
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
    root.find('#luker_orch_llm_api_preset').val(String(settings.llmNodeApiPresetName || ''));
    root.find('#luker_orch_llm_preset').val(String(settings.llmNodePresetName || ''));
    root.find('#luker_orch_ai_suggest_api_preset').val(String(settings.aiSuggestApiPresetName || ''));
    root.find('#luker_orch_ai_suggest_preset').val(String(settings.aiSuggestPresetName || ''));
    root.find('#luker_orch_ai_suggest_system_prompt').val(String(settings.aiSuggestSystemPrompt || ''));
    root.find('#luker_orch_max_recent_messages').val(String(settings.maxRecentMessages || 14));
    root.find('#luker_orch_node_iterations').val(String(settings.nodeIterationMaxRounds || 3));
    root.find('#luker_orch_review_reruns').val(String(settings.reviewRerunMaxRounds ?? 2));
    root.find('#luker_orch_tool_retries').val(String(settings.toolCallRetryMax ?? 2));
    root.find('#luker_orch_agent_timeout').val(String(settings.agentTimeoutSeconds ?? 0));
    root.find('#luker_orch_capsule_position').val(String(Number(settings.capsuleInjectPosition)));
    root.find('#luker_orch_capsule_depth').val(String(Number(settings.capsuleInjectDepth || 0)));
    root.find('#luker_orch_capsule_role').val(String(Number(settings.capsuleInjectRole)));
    root.find('#luker_orch_capsule_custom_instruction').val(String(settings.capsuleCustomInstruction || ''));
    refreshOpenAIPresetSelectors(root, context, settings);
    renderDynamicPanels(root, context);

    root.off('.lukerOrch');
    jQuery(document).off('.lukerOrchEditor');

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

    root.on('change.lukerOrch', '#luker_orch_node_iterations', function () {
        settings.nodeIterationMaxRounds = Math.max(1, Math.min(20, Math.floor(Number(jQuery(this).val()) || 3)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_review_reruns', function () {
        settings.reviewRerunMaxRounds = Math.max(0, Math.min(20, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_tool_retries', function () {
        settings.toolCallRetryMax = Math.max(0, Math.min(10, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_agent_timeout', function () {
        settings.agentTimeoutSeconds = Math.max(0, Math.min(3600, Math.floor(Number(jQuery(this).val()) || 0)));
        saveSettingsDebounced();
    });

    root.on('change.lukerOrch', '#luker_orch_capsule_position', function () {
        settings.capsuleInjectPosition = normalizeCapsuleInjectPosition(jQuery(this).val());
        jQuery(this).val(String(settings.capsuleInjectPosition));
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
        reapplyLatestCapsuleInjection(getContext());
        saveSettingsDebounced();
    });

    jQuery(document).on('input.lukerOrchEditor', `#${UI_BLOCK_ID} [data-luker-ai-goal-input], .luker_orch_editor_popup [data-luker-ai-goal-input]`, function () {
        uiState.aiGoal = String(jQuery(this).val() || '');
    });

    jQuery(document).on('input.lukerOrchEditor change.lukerOrchEditor', `#${UI_BLOCK_ID} [data-luker-field], .luker_orch_editor_popup [data-luker-field]`, function () {
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
            } else if (field === 'node-type') {
                node.type = normalizeNodeType(jQuery(this).val());
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

    jQuery(document).on('click.lukerOrchEditor', `#${UI_BLOCK_ID} [data-luker-action], .luker_orch_editor_popup [data-luker-action]`, async function () {
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
                type: ORCH_NODE_TYPE_WORKER,
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
                    type: ORCH_NODE_TYPE_WORKER,
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
            const ok = await persistOrchestratorCharacterExtension(context, characterIndex, nextPayload);
            if (!ok) {
                notifyError(i18n('Failed to persist character override.'));
                return;
            }
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
            return;
        }

        if (action === 'ai-iterate-open') {
            await openAiIterationStudio(context, settings, root);
            return;
        }

        if (action === 'view-last-run') {
            await openLastOrchestrationResult(context);
            return;
        }

        if (action === 'open-orch-editor') {
            await openOrchestrationEditorPopup(context, settings);
            return;
        }
    });
}

function ensureStyles() {
    if (jQuery(`#${ORCH_STYLE_ID}`).length) {
        return;
    }
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
.luker_orch_editor_popup .luker_orch_board {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.5));
    border-radius: 10px;
    padding: 10px;
    background: linear-gradient(160deg, rgba(29,46,39,0.28), rgba(21,31,43,0.2));
}
.luker_orch_editor_popup .menu_button,
.luker_orch_editor_popup .menu_button_small {
    width: auto;
    min-width: max-content;
    white-space: nowrap;
    writing-mode: horizontal-tb;
    text-orientation: mixed;
}
.luker_orch_iter_popup {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.luker_orch_iter_head {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.luker_orch_iter_title {
    font-size: 1.05rem;
    font-weight: 600;
}
.luker_orch_iter_sub {
    opacity: 0.82;
    font-size: 0.9rem;
}
.luker_orch_iter_grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
}
.luker_orch_iter_col {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.4));
    border-radius: 8px;
    padding: 8px;
    background: rgba(0,0,0,0.16);
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 420px;
}
.luker_orch_iter_col_title {
    font-weight: 600;
}
.luker_orch_iter_conversation,
.luker_orch_iter_profile {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 8px;
    background: rgba(0,0,0,0.18);
    overflow: auto;
}
.luker_orch_iter_conversation,
.luker_orch_iter_msg,
.luker_orch_iter_msg_head,
.luker_orch_iter_msg_body,
.luker_orch_iter_pending_text { text-align: left; }
.luker_orch_iter_conversation {
    min-height: 260px;
    max-height: 420px;
}
.luker_orch_iter_profile {
    min-height: 350px;
    max-height: 460px;
}
.luker_orch_iter_actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.luker_orch_iter_pending_block {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 8px;
    background: rgba(255,255,255,0.03);
    display: grid;
    gap: 6px;
}
.luker_orch_iter_pending_hint {
    opacity: 0.86;
    font-size: 0.88rem;
}
.luker_orch_iter_pending_text {
    white-space: pre-wrap;
    word-break: break-word;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.3));
    border-radius: 6px;
    padding: 6px 8px;
    background: rgba(0,0,0,0.18);
}
.luker_orch_iter_pending_ops {
    display: grid;
    gap: 4px;
}
.luker_orch_iter_pending_op {
    font-size: 0.9rem;
    opacity: 0.92;
}
.luker_orch_iter_pending_diff_inline {
    margin-top: 2px;
    border-top: 1px dashed var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    padding-top: 8px;
}
.luker_orch_iter_pending_diff_inline > summary {
    cursor: pointer;
    font-weight: 600;
    opacity: 0.9;
    margin-bottom: 6px;
}
.luker_orch_iter_diff_popup {
    display: grid;
    gap: 10px;
    max-height: 72vh;
    overflow: auto;
    padding-right: 2px;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-y;
}
.luker_orch_iter_diff_item {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    background: rgba(0,0,0,0.16);
    padding: 8px;
    display: grid;
    gap: 8px;
}
.luker_orch_iter_diff_title {
    font-weight: 600;
    line-height: 1.35;
}
.luker_orch_iter_diff_fields {
    display: grid;
    gap: 8px;
}
.luker_orch_iter_diff_field {
    display: grid;
    gap: 6px;
}
.luker_orch_iter_diff_label {
    font-size: 0.92rem;
    opacity: 0.86;
}
.luker_orch_line_diff {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.3));
    border-radius: 6px;
    background: rgba(0,0,0,0.2);
}
.luker_orch_line_diff > summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    font-size: 0.9rem;
}
.luker_orch_line_diff_summary_main {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.luker_orch_line_diff_meta {
    opacity: 0.78;
    font-size: 0.88rem;
}
.luker_orch_line_diff_expand_btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.2em;
    width: 2.2em;
    padding: 0;
    line-height: 1;
}
.luker_orch_line_diff_expand_btn i { pointer-events: none; }
.luker_orch_line_diff_pre {
    margin: 0;
    padding: 6px;
    border-top: 1px dashed var(--SmartThemeBorderColor, rgba(130,130,130,0.3));
    max-height: 320px;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
}
.luker_orch_iter_grid,
.luker_orch_iter_col,
.luker_orch_iter_diff_popup,
.luker_orch_iter_diff_item,
.luker_orch_iter_diff_fields,
.luker_orch_iter_diff_field,
.luker_orch_line_diff,
.luker_orch_line_diff_pre { min-width: 0; max-width: 100%; box-sizing: border-box; }
.luker_orch_iter_conversation,
.luker_orch_iter_profile { -webkit-overflow-scrolling: touch; touch-action: pan-y; }
.luker_orch_line_diff_dual { --luker-orch-split-left: 50%; --luker-orch-splitter-width: 12px; display: grid; grid-template-columns: minmax(0, var(--luker-orch-split-left)) var(--luker-orch-splitter-width) minmax(0, calc(100% - var(--luker-orch-split-left) - var(--luker-orch-splitter-width))); gap: 0; width: 100%; min-width: 0; align-items: stretch; }
.luker_orch_line_diff_splitter { position: relative; cursor: col-resize; touch-action: none; user-select: none; background: transparent; }
.luker_orch_line_diff_splitter::before { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; transform: translateX(-50%); border-radius: 999px; background: color-mix(in oklab, var(--SmartThemeBodyColor) 20%, transparent); transition: background-color .12s ease; }
.luker_orch_line_diff_splitter:hover::before,
.luker_orch_line_diff_splitter.active::before { background: color-mix(in oklab, var(--SmartThemeBodyColor) 38%, transparent); }
.luker_orch_line_diff_side { border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.32)); border-radius: 6px; background: rgba(0,0,0,0.12); min-width: 0; overflow: hidden; }
.luker_orch_line_diff_side_scroll { overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; touch-action: auto; }
.luker_orch_line_diff_table {
    width: max-content;
    min-width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 0.82rem;
}
.luker_orch_line_diff_pre,
.luker_orch_line_diff_table,
.luker_orch_line_diff_row td,
.luker_orch_line_diff_text,
.luker_orch_line_diff_text_inner { text-align: left; }
.luker_orch_line_diff_row td {
    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.24));
    padding: 2px 6px;
    vertical-align: top;
}
.luker_orch_line_diff_row:last-child td { border-bottom: none; }
.luker_orch_line_diff_ln {
    width: 3.8em;
    text-align: right;
    color: color-mix(in oklab, var(--SmartThemeBodyColor) 72%, transparent);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    position: sticky;
    left: 0;
    z-index: 3;
    background-color: var(--SmartThemeBlurTintColor);
    box-shadow: 1px 0 0 var(--SmartThemeBorderColor);
    background-image: none;
    opacity: 1;
}
.luker_orch_line_diff_text {
    width: auto;
    min-width: 0;
}
.luker_orch_line_diff_text_inner {
    white-space: pre;
    word-break: normal;
    overflow-wrap: normal;
    user-select: text;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    min-width: max-content;
}
.luker_orch_line_diff_word_add {
    background: color-mix(in oklab, #4caf50 30%, transparent);
    border-radius: 3px;
    padding: 0 1px;
}
.luker_orch_line_diff_word_del {
    background: color-mix(in oklab, #d9534f 30%, transparent);
    border-radius: 3px;
    padding: 0 1px;
}
.luker_orch_line_diff_row_add .luker_orch_line_diff_text.new { background: color-mix(in oklab, #4caf50 12%, transparent); }
.luker_orch_line_diff_row_del .luker_orch_line_diff_text.old { background: color-mix(in oklab, #d9534f 12%, transparent); }
.luker_orch_line_diff_row_mod .luker_orch_line_diff_text.old { background: color-mix(in oklab, #d9534f 10%, transparent); }
.luker_orch_line_diff_row_mod .luker_orch_line_diff_text.new { background: color-mix(in oklab, #4caf50 10%, transparent); }
.luker_orch_line_diff_zoom_overlay {
    position: fixed;
    inset: 0;
    z-index: 10010;
    display: flex;
    align-items: center;
    justify-content: center;
}
.luker_orch_line_diff_zoom_backdrop {
    position: absolute;
    inset: 0;
    background: color-mix(in oklab, #000 70%, transparent);
}
.luker_orch_line_diff_zoom_dialog {
    position: relative;
    z-index: 1;
    width: min(1280px, 95vw);
    height: min(92vh, 920px);
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 10px;
    background: var(--SmartThemeBlurTintColor);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 12px 36px rgba(0,0,0,0.45);
}
.luker_orch_line_diff_zoom_header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.24));
}
.luker_orch_line_diff_zoom_title {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.luker_orch_line_diff_zoom_close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.2em;
    width: 2.2em;
    padding: 0;
    line-height: 1;
}
.luker_orch_line_diff_zoom_body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 10px;
}
.luker_orch_line_diff_zoom_body .luker_orch_line_diff_pre { max-height: none; height: auto; }
.luker_orch_iter_diff_raw summary {
    cursor: pointer;
    font-size: 0.9rem;
    opacity: 0.9;
}
.luker_orch_iter_diff_raw pre {
    margin-top: 6px;
    margin-bottom: 0;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow: auto;
    font-size: 0.84rem;
}
.luker_orch_last_run_popup {
    display: grid;
    gap: 10px;
}
.luker_orch_last_run_meta {
    display: grid;
    gap: 4px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 8px;
    background: rgba(0,0,0,0.16);
}
.luker_orch_last_run_capsule_title {
    font-weight: 600;
}
.luker_orch_last_run_capsule {
    margin: 0;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 8px;
    background: rgba(0,0,0,0.2);
    max-height: 60vh;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.35;
}
.luker_orch_last_run_empty {
    opacity: 0.85;
    padding: 8px;
}
.luker_orch_kb_popup {
    display: grid;
    gap: 10px;
}
.luker_orch_kb_list {
    display: grid;
    gap: 10px;
}
.luker_orch_kb_card {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 10px;
    background: rgba(0,0,0,0.16);
    display: grid;
    gap: 8px;
}
.luker_orch_kb_card_header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}
.luker_orch_kb_card_title {
    font-weight: 600;
    line-height: 1.35;
}
.luker_orch_kb_meta_grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 6px 10px;
    font-size: 0.9rem;
    opacity: 0.92;
}
.luker_orch_kb_section {
    display: grid;
    gap: 6px;
}
.luker_orch_kb_section_title {
    font-weight: 600;
    font-size: 0.92rem;
}
.luker_orch_kb_tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.luker_orch_kb_tag {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(39, 117, 215, 0.16);
    border: 1px solid rgba(39, 117, 215, 0.35);
    font-size: 0.82rem;
}
.luker_orch_kb_empty {
    opacity: 0.8;
    font-size: 0.9rem;
}
.luker_orch_kb_sources {
    margin: 0;
    padding-left: 1.1em;
    display: grid;
    gap: 4px;
}
.luker_orch_kb_content {
    margin: 0;
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 8px;
    background: rgba(0,0,0,0.2);
    max-height: 260px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.38;
}
.luker_orch_iter_popup .menu_button,
.luker_orch_iter_popup .menu_button_small {
    width: auto;
    min-width: max-content;
    white-space: nowrap;
    writing-mode: horizontal-tb;
    text-orientation: mixed;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.luker_orch_iter_msg {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 6px 8px;
    margin-bottom: 8px;
}
.luker_orch_iter_msg.user {
    background: rgba(43, 95, 190, 0.15);
}
.luker_orch_iter_msg.assistant {
    background: rgba(38, 135, 93, 0.15);
}
.luker_orch_iter_msg_head {
    font-weight: 600;
    opacity: 0.9;
    margin-bottom: 4px;
}
.luker_orch_iter_msg_body {
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.4;
}
.luker_orch_iter_msg_folded {
    margin: 0;
}
.luker_orch_iter_msg_folded > summary {
    cursor: pointer;
    font-weight: 600;
    opacity: 0.9;
}
.luker_orch_iter_msg_preview {
    margin-top: 6px;
    opacity: 0.92;
}
.luker_orch_iter_msg_full {
    margin-top: 6px;
    max-height: 260px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    background: rgba(0,0,0,0.14);
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 6px;
    padding: 8px;
}
.luker_orch_iter_msg.loading .luker_orch_iter_msg_body {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    opacity: 0.92;
}
.luker_orch_iter_empty {
    opacity: 0.8;
    font-size: 0.92rem;
}
.luker_orch_iter_profile_meta {
    display: grid;
    gap: 4px;
    margin-bottom: 8px;
}
.luker_orch_iter_stage_list {
    display: grid;
    gap: 8px;
}
.luker_orch_iter_stage {
    border: 1px solid var(--SmartThemeBorderColor, rgba(130,130,130,0.35));
    border-radius: 8px;
    padding: 8px;
    background: rgba(255,255,255,0.02);
}
.luker_orch_iter_stage_title {
    font-weight: 600;
}
.luker_orch_iter_stage_mode {
    font-size: 0.82rem;
    opacity: 0.8;
    margin: 2px 0 4px;
}
.luker_orch_iter_stage_nodes {
    white-space: pre-wrap;
    word-break: break-word;
}
.luker_orch_iter_preset_line {
    margin-top: 10px;
    white-space: pre-wrap;
    word-break: break-word;
}
@media (max-width: 980px) {
    #${UI_BLOCK_ID} .luker_orch_workspace_grid {
        grid-template-columns: 1fr;
    }
    #${UI_BLOCK_ID} .luker_orch_character_row {
        grid-template-columns: 1fr;
    }
    .luker_orch_editor_popup .luker_orch_workspace_grid {
        grid-template-columns: 1fr;
    }
    .luker_orch_iter_grid {
        grid-template-columns: 1fr;
    }
    .luker_orch_iter_col {
        min-height: 320px;
    }
    .luker_orch_line_diff_ln {
        width: 3.2em;
    }
}
</style>`);
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
            <label for="luker_orch_max_recent_messages">${escapeHtml(i18n('Recent assistant turns for orchestration (N)'))}</label>
            <input id="luker_orch_max_recent_messages" class="text_pole" type="number" min="1" max="80" step="1" />
            <label for="luker_orch_node_iterations">${escapeHtml(i18n('Node tool iteration max rounds (N)'))}</label>
            <input id="luker_orch_node_iterations" class="text_pole" type="number" min="1" max="20" step="1" />
            <label for="luker_orch_review_reruns">${escapeHtml(i18n('Review rerun max rounds (N)'))}</label>
            <input id="luker_orch_review_reruns" class="text_pole" type="number" min="0" max="20" step="1" />
            <label for="luker_orch_tool_retries">${escapeHtml(i18n('Tool-call retries on invalid/missing tool call (N)'))}</label>
            <input id="luker_orch_tool_retries" class="text_pole" type="number" min="0" max="10" step="1" />
            <label for="luker_orch_agent_timeout">${escapeHtml(i18n('Per-agent timeout seconds (0 = disabled)'))}</label>
            <input id="luker_orch_agent_timeout" class="text_pole" type="number" min="0" max="3600" step="1" />
            <label for="luker_orch_capsule_position">${escapeHtml(i18n('Injection position'))}</label>
            <select id="luker_orch_capsule_position" class="text_pole">
                <option value="${world_info_position.before}">${escapeHtml(i18n('Before Character Definitions'))}</option>
                <option value="${world_info_position.after}">${escapeHtml(i18n('After Character Definitions'))}</option>
                <option value="${world_info_position.ANTop}">${escapeHtml(i18n("Before Author's Note"))}</option>
                <option value="${world_info_position.ANBottom}">${escapeHtml(i18n("After Author's Note"))}</option>
                <option value="${world_info_position.EMTop}">${escapeHtml(i18n('Before Example Messages'))}</option>
                <option value="${world_info_position.EMBottom}">${escapeHtml(i18n('After Example Messages'))}</option>
                <option value="${world_info_position.atDepth}">${escapeHtml(i18n('At Chat Depth'))}</option>
            </select>
            <label for="luker_orch_capsule_depth">${escapeHtml(i18n('Injection depth (At Chat Depth only)'))}</label>
            <input id="luker_orch_capsule_depth" class="text_pole" type="number" min="0" max="10000" step="1" />
            <label for="luker_orch_capsule_role">${escapeHtml(i18n('Injection role (At Chat Depth only)'))}</label>
            <select id="luker_orch_capsule_role" class="text_pole">
                <option value="${extension_prompt_roles.SYSTEM}">${escapeHtml(i18n('System'))}</option>
                <option value="${extension_prompt_roles.USER}">${escapeHtml(i18n('User'))}</option>
                <option value="${extension_prompt_roles.ASSISTANT}">${escapeHtml(i18n('Assistant'))}</option>
            </select>
            <label for="luker_orch_capsule_custom_instruction">${escapeHtml(i18n('Custom orchestration result instruction (prepended before analysis)'))}</label>
            <textarea id="luker_orch_capsule_custom_instruction" class="text_pole textarea_compact" rows="2" placeholder="${escapeHtml(i18n('e.g. Follow this guidance first, then write final reply in-character.'))}"></textarea>
            <small id="luker_orch_single_mode_hint" style="opacity:0.8">${escapeHtml(i18n('Single-agent mode is enabled. Workflow board is hidden and runtime uses the simplified single node profile.'))}</small>

            <hr>
            <div class="luker_orch_board">
                <div>
                    <small>${escapeHtml(i18n('Current card:'))} <span id="luker_orch_profile_target">${escapeHtml(i18n('(No character card)'))}</span></small><br />
                    <small>${escapeHtml(i18n('Editing:'))} <span id="luker_orch_profile_mode">${escapeHtml(i18n('Global profile'))}</span></small>
                </div>
                <div class="flex-container">
                    <div class="menu_button" data-luker-action="open-orch-editor">${escapeHtml(i18n('Open Orchestration Editor'))}</div>
                    <div class="menu_button" data-luker-action="view-last-run">${escapeHtml(i18n('View Last Run'))}</div>
                    <div class="menu_button" data-luker-action="ai-suggest-character">${escapeHtml(i18n('AI Quick Build'))}</div>
                    <div class="menu_button" data-luker-action="ai-iterate-open">${escapeHtml(i18n('Open AI Iteration Studio'))}</div>
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
    void loadOrchestratorChatState(context, { force: true }).finally(() => ensureUi());

    if (context.eventTypes.GENERATION_WORLD_INFO_FINALIZED) {
        context.eventSource.on(context.eventTypes.GENERATION_WORLD_INFO_FINALIZED, onWorldInfoFinalized);
    }
    if (context.eventTypes.MESSAGE_DELETED) {
        context.eventSource.on(context.eventTypes.MESSAGE_DELETED, onMessageDeleted);
    }
    if (context.eventTypes.MESSAGE_EDITED) {
        context.eventSource.on(context.eventTypes.MESSAGE_EDITED, onMessageEdited);
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
        const liveContext = getContext();
        abortActiveOrchestratorRun();
        loadedChatStateKey = '';
        latestOrchestrationSnapshot = null;
        clearCapsulePrompt(liveContext);
        void loadOrchestratorChatState(liveContext, { force: true }).finally(() => ensureUi());
    });
});
