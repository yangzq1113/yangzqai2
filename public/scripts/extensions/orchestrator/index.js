import { CONNECT_API_MAP, extension_prompt_roles, extension_prompt_types, saveSettings, saveSettingsDebounced } from '../../../script.js';
import { extension_settings, getContext } from '../../extensions.js';
import { addLocaleData, translate } from '../../i18n.js';
import { chat_completion_sources, proxies, sendOpenAIRequest } from '../../openai.js';

const MODULE_NAME = 'orchestrator';
const CAPSULE_PROMPT_KEY = 'luker_orchestrator_capsule';
const LAST_CAPSULE_METADATA_KEY = 'luker_orchestrator_last_capsule';
const UI_BLOCK_ID = 'orchestrator_settings';
const DEFAULT_CAPSULE_CUSTOM_INSTRUCTION = 'Follow the orchestration guidance below and prioritize it when drafting the next in-character reply.';
const ALLOWED_TEMPLATE_VARS = ['recent_chat', 'last_user', 'previous_outputs', 'distiller', 'wi_summary'];
const ORCH_ALLOWED_GENERATION_TYPES = new Set(['normal', 'continue', 'regenerate', 'swipe', 'impersonate']);
const ORCH_AI_QUALITY_AXES = {
    user_intent: 'Analyze user intent, emotional expectation, and implicit goals.',
    character_traits: 'Use character traits and card constraints without restating full biographies in every node.',
    character_independence: 'Preserve multi-character independence and avoid voice/agency collapse.',
    anti_ooc: 'Detect and prevent OOC behavior and persona drift.',
    latent_behavior: 'Infer plausible latent behavior, motivations, and next-step actions.',
    human_realism: 'Increase human-like behavior through natural uncertainty, bounded knowledge, and believable pacing.',
    world_autonomy: 'Keep the world autonomous; events should not always orbit the user.',
};

function getDefaultAiSuggestSystemPrompt() {
    return [
        'You design RP multi-agent orchestration profiles for a specific character card.',
        'Use tool calls only. Do not return plain JSON text.',
        'Call multiple functions in one response to build the profile incrementally.',
        'Keep stages concise, operational, and easy to run in a single request turn.',
        'Only the LAST stage outputs are injected into the final generation context.',
        'Therefore, design the last stage as PARALLEL multi-agent synthesis and put final actionable guidance there.',
        'Node outputs are returned via function fields. Do NOT embed JSON blobs inside summary.',
        'For last-stage nodes, use plain structured fields (summary, directives, risks, tags, patch_last_user).',
        'Runtime will assemble the final injected XML from those structured fields.',
        'Runtime context guarantee: both orchestration agents and final generation already see assembled preset context, character card context, and world-info activation context.',
        'Do NOT repeat full character biography in every node prompt. Prefer compact behavior policy and decision criteria.',
        'Each node must have a distinct role, concrete output focus, and minimal overlap.',
        'Prefer practical distiller/director/critic style agents and add custom presets only when necessary.',
        'Design for robust RP quality: user-intent understanding, character independence, anti-OOC, realism, and world autonomy.',
        `Allowed template placeholders ONLY: ${ALLOWED_TEMPLATE_VARS.map(x => `{{${x}}}`).join(', ')}.`,
        'Do not invent any other placeholder names.',
        'When designing prompts, encode checks and directives, not verbose restatements of the card.',
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
        { id: 'plan', mode: 'parallel', nodes: ['director', 'critic'] },
    ],
};

const defaultPresets = {
    distiller: {
        systemPrompt: 'You are a narrative distiller. Extract key story state and user intent.',
        userPromptTemplate: 'Recent chat:\n{{recent_chat}}\n\nCurrent user message:\n{{last_user}}\n\nReturn function-call fields only. summary should be concise plain text, not JSON string.',
    },
    director: {
        systemPrompt: 'You are a roleplay director. Produce concise tactical guidance for the next assistant reply.',
        userPromptTemplate: 'Distiller output:\n{{distiller}}\n\nRecent chat:\n{{recent_chat}}\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
    critic: {
        systemPrompt: 'You are an RP critic. Flag OOC, pacing, and consistency risks.',
        userPromptTemplate: 'Recent chat:\n{{recent_chat}}\n\nReturn function-call fields only. Keep summary/directives/risks/tags as plain text. Do not put JSON inside summary.',
    },
};

const defaultSettings = {
    enabled: false,
    llmNodeApiPresetName: '',
    llmNodePresetName: '',
    toolCallRetryMax: 2,
    maxRecentMessages: 14,
    includeWorldInfoSummary: true,
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
        'LLM node API preset (Connection profile, empty = current)': 'LLM 节点 API 预设（连接配置，留空=当前）',
        'LLM node preset (params + prompt, empty = current)': 'LLM 节点预设（参数+提示词，留空=当前）',
        'AI build API preset (Connection profile, empty = current)': 'AI 生成 API 预设（连接配置，留空=当前）',
        'AI build preset (params + prompt, empty = current)': 'AI 生成预设（参数+提示词，留空=当前）',
        'AI build system prompt': 'AI 生成系统提示词',
        'Reset AI build prompt': '重置 AI 生成提示词',
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
        'WI Summary': '世界书摘要',
        'World Info Activated': '已激活世界书',
        'Current card:': '当前角色卡：',
        '(No character card)': '（无角色卡）',
        '(No character selected)': '（未选择角色卡）',
        'Editing:': '当前编辑：',
        'Global profile': '全局配置',
        'AI build goal (optional)': 'AI 生成目标（可选）',
        'e.g. mystery thriller pacing, strict in-character tone': '例如：悬疑节奏、严格角色内表达',
        'Reload Current': '重载当前',
        'Save To Global': '保存到全局',
        'Save To Character Override': '保存到角色卡覆写',
        'Global profile': '全局配置',
        'Current character override': '当前角色卡覆写',
        'Clear Character Override': '清除角色卡覆写',
        'AI Build Character Override': 'AI 生成角色卡覆写',
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
        'Use {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}, {{wi_summary}}': '可用 {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}, {{wi_summary}}',
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
        'Saved to global profile.': '已保存到全局配置。',
        'Character orchestration override removed.': '角色卡编排覆写已移除。',
        'Character orchestration profile generated by AI.': 'AI 已生成角色卡编排配置。',
        'AI profile generation failed.': 'AI 生成配置失败。',
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
        'Function output is invalid.': '函数输出无效。',
        'AI build did not provide any stage tool calls.': 'AI 构建未提供任何阶段工具调用。',
        'Failed to persist character override.': '角色卡覆写写入失败。',
    });
    addLocaleData('zh-tw', {
        'Orchestrator': '多智能體編排',
        'Enabled': '啟用',
        'LLM node API preset (Connection profile, empty = current)': 'LLM 節點 API 預設（連線設定，留空=目前）',
        'LLM node preset (params + prompt, empty = current)': 'LLM 節點預設（參數+提示詞，留空=目前）',
        'AI build API preset (Connection profile, empty = current)': 'AI 生成 API 預設（連線設定，留空=目前）',
        'AI build preset (params + prompt, empty = current)': 'AI 生成預設（參數+提示詞，留空=目前）',
        'AI build system prompt': 'AI 生成系統提示詞',
        'Reset AI build prompt': '重置 AI 生成提示詞',
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
        'WI Summary': '世界書摘要',
        'World Info Activated': '已啟動世界書',
        'Current card:': '目前角色卡：',
        '(No character card)': '（無角色卡）',
        '(No character selected)': '（未選擇角色卡）',
        'Editing:': '目前編輯：',
        'Global profile': '全域設定',
        'AI build goal (optional)': 'AI 生成目標（可選）',
        'e.g. mystery thriller pacing, strict in-character tone': '例如：懸疑節奏、嚴格角色內語氣',
        'Reload Current': '重新載入目前',
        'Save To Global': '儲存到全域',
        'Save To Character Override': '儲存到角色卡覆寫',
        'Current character override': '目前角色卡覆寫',
        'Clear Character Override': '清除角色卡覆寫',
        'AI Build Character Override': 'AI 生成角色卡覆寫',
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
        'Use {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}, {{wi_summary}}': '可用 {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}, {{wi_summary}}',
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
        'Saved to global profile.': '已儲存至全域設定。',
        'Character orchestration override removed.': '角色卡編排覆寫已移除。',
        'Character orchestration profile generated by AI.': 'AI 已生成角色卡編排設定。',
        'AI profile generation failed.': 'AI 生成設定失敗。',
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
        'Function output is invalid.': '函式輸出無效。',
        'AI build did not provide any stage tool calls.': 'AI 建構未提供任何階段工具呼叫。',
        'Failed to persist character override.': '角色卡覆寫寫入失敗。',
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

    context.updateChatMetadata({
        [LAST_CAPSULE_METADATA_KEY]: {
            updatedAt: new Date().toISOString(),
            trigger: String(payload?.type || 'normal'),
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

function isRetryableToolCallError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('tool call');
}

async function requestToolCallWithRetry(settings, promptMessages, {
    functionName = '',
    functionDescription = '',
    parameters = {},
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
            const requestOptions = {
                tools,
                toolChoice,
                replaceTools: true,
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
            };
            const responseData = await sendOpenAIRequest('quiet', promptMessages, null, {
                ...requestOptions,
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
    llmPresetName = '',
    apiSettingsOverride = null,
    retriesOverride = null,
} = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error('Tools are required.');
    }

    const retriesSource = retriesOverride === null || retriesOverride === undefined
        ? Number(settings?.toolCallRetryMax)
        : Number(retriesOverride);
    const retries = Math.max(0, Math.min(10, Math.floor(retriesSource || 0)));
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const requestOptions = {
                tools,
                toolChoice: 'auto',
                replaceTools: true,
                llmPresetName: String(llmPresetName || '').trim(),
                apiSettingsOverride: apiSettingsOverride && typeof apiSettingsOverride === 'object' ? apiSettingsOverride : null,
            };
            const responseData = await sendOpenAIRequest('quiet', promptMessages, null, {
                ...requestOptions,
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

function renderTemplate(template, vars) {
    return String(template || '')
        .replaceAll('{{recent_chat}}', String(vars.recent_chat || ''))
        .replaceAll('{{last_user}}', String(vars.last_user || ''))
        .replaceAll('{{previous_outputs}}', String(vars.previous_outputs || ''))
        .replaceAll('{{distiller}}', String(vars.distiller || ''))
        .replaceAll('{{wi_summary}}', String(vars.wi_summary || ''));
}

function buildPresetAwareMessages(context, settings, systemPrompt, userPrompt, {
    api = '',
    promptPresetName = '',
    runtimePromptFields = {},
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
        runtimePromptFields: runtimePromptFields && typeof runtimePromptFields === 'object'
            ? runtimePromptFields
            : {},
    });
}

async function runLLMNode(context, payload, nodeSpec, preset, messages, previousNodeOutputs, wiHint = '') {
    const settings = extension_settings[MODULE_NAME];
    const recent = getRecentMessages(messages, settings.maxRecentMessages)
        .map(message => `${message?.is_user ? 'User' : (message?.name || 'Assistant')}: ${String(message?.mes || '')}`)
        .join('\n');
    const { message: lastUser } = extractLastUserMessage(messages);
    const previousOutputs = JSON.stringify(Object.fromEntries(previousNodeOutputs), null, 2);
    const userPrompt = renderTemplate(nodeSpec.userPromptTemplate || preset.userPromptTemplate || '', {
        recent_chat: recent,
        last_user: String(lastUser?.mes || ''),
        previous_outputs: previousOutputs,
        distiller: JSON.stringify(previousNodeOutputs.get('distiller') || {}, null, 2),
        wi_summary: wiHint,
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
            runtimePromptFields: {
                worldInfoBefore: String(payload?.worldInfoBefore || ''),
                worldInfoAfter: String(payload?.worldInfoAfter || ''),
            },
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
    });
    if (toolOutput && typeof toolOutput === 'object') {
        return toolOutput;
    }

    throw new Error(`Node '${nodeSpec.id}' returned invalid tool call payload.`);
}

async function executeNode(context, payload, nodeSpec, messages, previousNodeOutputs, presets, wiHint = '') {
    const preset = presets[nodeSpec.preset] || {};
    try {
        return await runLLMNode(context, payload, nodeSpec, preset, messages, previousNodeOutputs, wiHint);
    } catch (error) {
        console.warn(`[${MODULE_NAME}] LLM node '${nodeSpec.id}' failed`, error);
        return {
            error: String(error?.message || error || 'Node request failed'),
            directives: [],
            risks: ['Node execution failed'],
        };
    }
}

async function runOrchestration(context, payload, messages, profile, wiHint = '') {
    const spec = sanitizeSpec(profile.spec);
    const stages = Array.isArray(spec?.stages) ? spec.stages : [];
    const stageOutputs = [];
    const previousNodeOutputs = new Map();

    for (const stage of stages) {
        const mode = String(stage?.mode || 'serial').toLowerCase() === 'parallel' ? 'parallel' : 'serial';
        const nodes = Array.isArray(stage?.nodes) ? stage.nodes : [];
        const nodeOutputs = [];

        if (mode === 'parallel') {
            const outputs = await Promise.all(nodes.map(async (rawNode) => {
                const nodeSpec = normalizeNodeSpec(rawNode);
                return {
                    node: nodeSpec.id,
                    output: await executeNode(context, payload, nodeSpec, messages, previousNodeOutputs, profile.presets, wiHint),
                };
            }));
            nodeOutputs.push(...outputs);
        } else {
            for (const rawNode of nodes) {
                const nodeSpec = normalizeNodeSpec(rawNode);
                nodeOutputs.push({
                    node: nodeSpec.id,
                    output: await executeNode(context, payload, nodeSpec, messages, previousNodeOutputs, profile.presets, wiHint),
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

function escapeXml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&apos;');
}

function encodeCdata(value) {
    return String(value ?? '').replaceAll(']]>', ']]]]><![CDATA[>');
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

function formatNodeOutputAsXml(nodeOutput, nodeId) {
    const output = normalizeNodeOutputForCapsule(nodeOutput);
    const lines = [];
    lines.push(`    <agent id="${escapeXml(nodeId)}">`);

    if (typeof output.summary === 'string' && output.summary.trim()) {
        lines.push(`      <summary>${escapeXml(output.summary.trim())}</summary>`);
    }

    const pushList = (tagName, itemTagName, items) => {
        if (!Array.isArray(items) || items.length === 0) {
            return;
        }
        lines.push(`      <${tagName}>`);
        for (const item of items) {
            const text = String(item || '').trim();
            if (text) {
                lines.push(`        <${itemTagName}>${escapeXml(text)}</${itemTagName}>`);
            }
        }
        lines.push(`      </${tagName}>`);
    };

    pushList('directives', 'directive', output.directives);
    pushList('risks', 'risk', output.risks);
    pushList('tags', 'tag', output.tags);

    if (typeof output.patch_last_user === 'string' && output.patch_last_user.trim()) {
        lines.push(`      <patch_last_user>${escapeXml(output.patch_last_user.trim())}</patch_last_user>`);
    }

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
        lines.push(`      <structured_notes><![CDATA[${encodeCdata(JSON.stringify(extraPayload, null, 2))}]]></structured_notes>`);
    }
    const xmlGuidance = String(output.xml_guidance || '').trim();
    if (xmlGuidance) {
        lines.push(`      <model_xml_hint><![CDATA[${encodeCdata(xmlGuidance)}]]></model_xml_hint>`);
    }

    lines.push('    </agent>');
    return lines.join('\n');
}

function summarizeActivatedEntries(payload) {
    const result = [];
    const allActivated = payload?.worldInfoResolution?.allActivatedEntries;
    if (allActivated && typeof allActivated[Symbol.iterator] === 'function') {
        for (const entry of allActivated) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const label = String(entry.comment || entry.key || entry.content || '').trim();
            if (label) {
                result.push(label);
            }
            if (result.length >= 10) {
                break;
            }
        }
    }

    if (result.length === 0 && Array.isArray(payload?.worldInfoDepth) && payload.worldInfoDepth.length > 0) {
        for (const depthEntry of payload.worldInfoDepth.slice(0, 4)) {
            const depth = Number(depthEntry?.depth);
            const text = Array.isArray(depthEntry?.entries) ? depthEntry.entries.join(' ') : '';
            if (text) {
                result.push(`depth:${Number.isFinite(depth) ? depth : 0} ${String(text).trim()}`);
            }
        }
    }

    return result;
}

function buildCapsuleText(capsule, settings) {
    const lines = [];
    const customInstruction = String(settings?.capsuleCustomInstruction || '').trim();
    if (customInstruction) {
        lines.push(customInstruction);
    }
    lines.push(`<luker_orchestration phase="${escapeXml(capsule.phase)}" trigger="${escapeXml(capsule.trigger)}">`);
    lines.push('  <guidance_policy>Use this as high-priority planning context for the next roleplay reply.</guidance_policy>');
    if (capsule.final_stage) {
        lines.push(`  <final_stage id="${escapeXml(capsule.final_stage.id)}" mode="${escapeXml(capsule.final_stage.mode)}">`);
        for (const node of capsule.final_stage.nodes || []) {
            lines.push(formatNodeOutputAsXml(node.output, node.node));
        }
        lines.push('  </final_stage>');
    } else {
        lines.push('  <final_stage id="" mode="serial" />');
    }
    lines.push('</luker_orchestration>');
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
    orchInFlight = true;

    try {
        const profile = getEffectiveProfile(context);
        const messages = structuredClone(getCoreMessages(payload));
        if (messages.length === 0) {
            clearCapsulePrompt(context);
            clearLastCapsuleMetadata(context);
            return;
        }

        const wiActivated = summarizeActivatedEntries(payload);
        const wiHint = settings.includeWorldInfoSummary ? wiActivated.slice(0, 5).join('; ') : '';

        const finalRun = await runOrchestration(context, payload, messages, profile, wiHint);

        const capsuleText = buildCapsule(payload, finalRun.stageOutputs || [], {
            phase: 'final',
        });
        injectCapsule(context, capsuleText);
        saveLastCapsuleMetadata(context, capsuleText, payload, profile);
    } finally {
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
    <textarea class="text_pole textarea_compact" rows="4" data-luker-field="node-template" data-scope="${scope}" data-stage-index="${stageIndex}" data-node-index="${nodeIndex}" placeholder="${escapeHtml(i18n('Use {{recent_chat}}, {{last_user}}, {{distiller}}, {{previous_outputs}}, {{wi_summary}}'))}">${escapeHtml(node.userPromptTemplate)}</textarea>
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
}

function updateUiStatus(text) {
    jQuery('#luker_orch_status').text(String(text || ''));
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

async function runAiCharacterProfileBuild(context, settings) {
    syncCharacterEditorWithActiveAvatar(context);
    const avatar = String(getCurrentAvatar(context) || '').trim();
    if (!avatar) {
        throw new Error('No character selected.');
    }

    const characterCard = getCharacterCardSnapshot(context, avatar);
    if (!characterCard.name) {
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
    ].join('\n');
    const suggestUserPrompt = JSON.stringify({
        character: characterCard,
        override_goal: String(uiState.aiGoal || ''),
        runtime_context_guarantees: {
            preset_assembly_is_applied: true,
            character_card_context_is_available: true,
            world_info_context_is_available: true,
            recent_messages_are_available: true,
            reminder: 'Do not duplicate static card data in every node; use behavior-focused checks.',
        },
        injection_contract: {
            injected_stage: 'only_last_stage',
            expected_last_stage_mode: 'parallel',
            expected_guidance_format: 'runtime_assembled_xml_from_structured_fields',
            no_json_in_summary: true,
        },
        mandatory_quality_axes: ORCH_AI_QUALITY_AXES,
        global_orchestration_spec: currentSpec,
        global_presets: currentPresets,
        tool_protocol: {
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

    updateUiStatus(`Generating orchestration profile for ${characterCard.name}...`);
    const semanticRetries = Math.max(0, Math.min(10, Math.floor(Number(settings?.toolCallRetryMax) || 0)));
    let parsed = null;
    let lastBuildError = null;
    for (let attempt = 0; attempt <= semanticRetries; attempt++) {
        const reminder = attempt > 0
            ? [{
                role: 'user',
                content: 'Previous tool calls were incomplete. Return COMPLETE tool calls in one response (not one call). MUST include luker_orch_append_stage and luker_orch_finalize_profile, with finalize as the last call.',
            }]
            : [];
        const toolCalls = await requestToolCallsWithRetry(settings, [...promptMessages, ...reminder], {
            tools,
            allowedNames,
            llmPresetName: suggestPresetName,
            apiSettingsOverride,
            retriesOverride: 0,
        });
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

    uiState.characterEditor.spec = toEditableSpec(suggestedSpec, mergedPresets);
    uiState.characterEditor.presets = toEditablePresetMap(mergedPresets);
    uiState.characterEditor.enabled = true;

    const persisted = await persistCharacterEditor(context, settings, avatar, { forceEnabled: true });
    if (!persisted) {
        throw new Error(i18n('Failed to persist character override.'));
    }
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
            try {
                await runAiCharacterProfileBuild(context, settings);
                renderDynamicPanels(root, context);
                notifySuccess(i18n('Character orchestration profile generated by AI.'));
                updateUiStatus(i18nFormat('AI profile generated for ${0}.', getCharacterDisplayNameByAvatar(context, getCurrentAvatar(context))));
            } catch (error) {
                notifyError(i18nFormat('AI profile generation failed: ${0}', error?.message || error));
                updateUiStatus(i18n('AI profile generation failed.'));
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
                    </div>
                </div>
                <div id="luker_orch_effective_visual"></div>
                <div class="flex-container">
                    <div class="menu_button" data-luker-action="reload-current">${escapeHtml(i18n('Reload Current'))}</div>
                    <div class="menu_button" data-luker-action="save-global">${escapeHtml(i18n('Save To Global'))}</div>
                    <div class="menu_button" data-luker-action="save-character">${escapeHtml(i18n('Save To Character Override'))}</div>
                    <div id="luker_orch_clear_character_button" class="menu_button" data-luker-action="clear-character">${escapeHtml(i18n('Clear Character Override'))}</div>
                    <div class="menu_button" data-luker-action="ai-suggest-character">${escapeHtml(i18n('AI Build Character Override'))}</div>
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
