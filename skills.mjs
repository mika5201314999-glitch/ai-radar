/**
 * 技能（Agent Skill）识别与归类。
 *
 * 一个仓库算不算「技能」：它是给 agent 用的可复用能力包（SKILL.md / agent skills /
 * skill pack / market 之类），而不是普通库。归类维度是**这个技能作用于哪个 agent**——
 * 因为同一个「技能」写成 Claude Code 的 SKILL.md 还是 Cursor 的 rule，用法完全不同。
 *
 * 采集器（collect.mjs）和主进程（app/main.js）都 import 这个文件，避免两边规则漂移。
 * 注意：本文件必须零依赖，且能被 ESM 直接 import。
 */

/** 归类顺序即优先级：一句话里同时提到两个 agent 时，取靠前的那个。 */
export const SKILL_AGENTS = [
  { key: 'claude', label: 'Claude Code', note: 'SKILL.md 格式的源头，生态最大' },
  { key: 'codex', label: 'Codex / ChatGPT', note: 'AGENTS.md 与 Codex skills' },
  { key: 'cursor', label: 'Cursor', note: 'rules / mdc / commands' },
  { key: 'copilot', label: 'GitHub Copilot', note: 'instructions / prompt files' },
  { key: 'gemini', label: 'Gemini CLI', note: 'extensions / GEMINI.md' },
  { key: 'deepseek', label: 'DSH / DeepSeek', note: 'DSH 的 skill 目录' },
  { key: 'editor', label: '其它编辑器 agent', note: 'Cline / Roo / Windsurf / Aider / OpenCode' },
  { key: 'generic', label: '通用 Agent Skills', note: '跨 agent 的格式与合集' },
];

const AGENT_RULES = {
  claude: [/claude/, /anthropic/, /\bskill\.md\b/, /claude[-_ ]?code/],
  codex: [/\bcodex\b/, /openai[-_ ]?codex/, /\bagents\.md\b/],
  cursor: [/\bcursor\b/, /\.mdc\b/, /cursor[-_ ]?rules?/],
  copilot: [/copilot/, /github[-_ ]?copilot/, /prompt[-_ ]?files?/],
  gemini: [/gemini/, /google[-_ ]?gemini/, /gemini[-_ ]?cli/],
  deepseek: [/deepseek/, /\bdsh\b/, /deepseek[-_ ]?harness/],
  editor: [/\bcline\b/, /\broo\b/, /windsurf/, /\baider\b/, /continue\.dev/, /\bzed\b/, /opencode/, /\bkilo\b/, /trae/],
};

/** 明确不是技能：这些词出现时一律不归入技能栏（避免把普通库误判）。 */
const NOT_SKILL = [/skillion/, /skills?[-_ ]?gap/, /skill[-_ ]?tree/, /multi[-_ ]?skill/];

/** 说明它「是个技能包」的信号。至少命中一条才算——宁严勿松，否则满屏普通应用。 */
const SKILL_SIGNALS = [
  /skill\.md/i,
  /agent[-_ ]?skills?/i,
  /(claude|cursor|codex|gemini|copilot|dsh|deepseek)[-_ ]?skills?/i,
  /skills?[-_ ]?(pack|set|collection|library|market\w*|registry|hub|kit|plugin)/i,
  /awesome[-_ ]?skills?/i,
  /skill[-_ ]?(for|collection|marketplace)/i,
];

const TOPIC_SIGNALS = /^(skill|skills|agent-skill|agent-skills|claude-skills|claude-code-skills|codex-skills|mcp-skills|awesome-skills)$/i;

const hayOf = (r) =>
  [r.full_name, r.name, r.desc, r.description, (r.topics || []).join(' ')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

/** 判断一个仓库是否是给 agent 用的技能包。是则返回 true。 */
export function isSkillRepo(repo) {
  const hay = hayOf(repo);
  if (!hay.includes('skill')) return false;
  if (NOT_SKILL.some((re) => re.test(hay))) return false;

  const topics = (repo.topics || []).map((t) => String(t));
  if (topics.some((t) => TOPIC_SIGNALS.test(t))) return true;
  if (SKILL_SIGNALS.some((re) => re.test(hay))) return true;

  // 名字里带 skill（ip-as-logo-skill / handraw-style-skill…）基本就是技能，
  // 但描述里只是提一句 "skill" 的普通应用不算。
  const name = String(repo.full_name || repo.name || '');
  return /\bskills?\b/i.test(name) && !/\b(app|suite|platform|studio|server|runtime)\b/i.test(hay);
}

/** 归到哪个 agent。返回 SKILL_AGENTS 里的 key。 */
export function skillAgent(repo) {
  const hay = hayOf(repo);
  for (const agent of SKILL_AGENTS) {
    const rules = AGENT_RULES[agent.key];
    if (!rules) continue;
    if (rules.some((re) => re.test(hay))) return agent.key;
  }
  return 'generic';
}

export const AGENT_LABEL = Object.fromEntries(SKILL_AGENTS.map((a) => [a.key, a.label]));
export const AGENT_ORDER = Object.fromEntries(SKILL_AGENTS.map((a, i) => [a.key, i]));

/**
 * 从一堆仓库里挑出技能，按 agent 去重并排序。
 * 返回扁平数组，每项带 `agent` 与 `agent_label`；同仓库只保留一次。
 */
export function pickSkills(repos, { dedupe = true } = {}) {
  const out = [];
  const seen = new Set();
  for (const r of repos || []) {
    if (!r || !(r.full_name || r.name)) continue;
    if (!isSkillRepo(r)) continue;
    const key = String(r.full_name || r.name).toLowerCase();
    if (dedupe) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const agent = skillAgent(r);
    out.push({ ...r, agent, agent_label: AGENT_LABEL[agent] || '通用 Agent Skills' });
  }
  out.sort((a, b) => {
    const d = (AGENT_ORDER[a.agent] ?? 99) - (AGENT_ORDER[b.agent] ?? 99);
    if (d) return d;
    return (b.stars ?? 0) - (a.stars ?? 0);
  });
  return out;
}

/** 按 agent 分组，空组丢掉；组按固定顺序。返回 [{key,label,note,items}]。 */
export function groupSkills(items) {
  const by = new Map();
  for (const it of items || []) {
    const k = it.agent || 'generic';
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(it);
  }
  return SKILL_AGENTS
    .filter((a) => by.has(a.key))
    .map((a) => ({
      key: a.key,
      label: a.label,
      note: a.note,
      items: by.get(a.key)
        .slice()
        .sort((x, y) => (y.stars ?? 0) - (x.stars ?? 0)),
    }));
}
