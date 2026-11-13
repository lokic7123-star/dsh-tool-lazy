/**
 * dsh-tool-lazy v2 — 工具懒加载（掩码式）
 *
 * 机制（全部走公开 API，本机实测 0.2.2-rc.1 可用）：
 *   1. `agent.ctx.tools.restrict({ deny })` 按 agent 作用域掩码全局工具；被掩码的工具
 *      不进入该 agent 的 system prompt 与 schema 投影（官方文档原话：
 *      "隐藏工具的限制会为该 agent 移除其全部 schema 成本"）。
 *   2. 元工具 tool_search / tool_load / tool_status 注册在 **agent 自己的作用域层**：
 *      restrict 只作用于继承面，自己层的注册永不被掩，所以这三个工具总是可见。
 *   3. 每次重算掩码都先 dispose 旧限制 → 读**未掩码的完整视图**（tools.schemas(agent)）
 *      → 再 restrict，保证目录不会因自身掩码而提前收敛。
 *   4. 揭示只增不减（tool_load 才会收缩 deny），掩码字节稳定以保护 prompt cache。
 *   5. fail-open：任何 restrict/register 故障只写日志并让该 agent 保持完整工具集，
 *      绝不阻断回合，也绝不留下半个掩码。
 *
 * 配置见同目录 config.json（支持 `mcp__*` 这类前缀通配）。
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const META_TOOLS = ['tool_search', 'tool_load', 'tool_status']
/** 硬保护：restrict() 明令不得命名保留传输 run_code，一旦进入 deny 整个掩码直接抛错失效。 */
const ALWAYS_PROTECT = ['run_code', ...META_TOOLS]

const DEFAULTS = {
  mode: 'mask',
  logFile: 'lazy.log',
  core: ['pwsh', 'read', 'write', 'edit', 'grep', 'glob', 'web_search', 'web_fetch'],
  protect: [],
  autoLoadServers: [],
  searchMaxResults: 5,
  searchMaxChars: 24000,
  searchBudgetRatio: 0.05,
  contextWindow: 0,
  loadMaxChars: 32000,
  descriptionMaxChars: 600,
  maxSchemaChars: 6000,
}

/** 把外部传入的数字收进 [min, max]；类型不对就用 fallback。 */
function boundedInt(raw, fallback, min, max) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(raw)))
}

/** 清洗字符串数组：只要出现非字符串或空项，整份退回 fallback（配置宁可用默认，也不要半截生效）。 */
function cleanStringList(raw, fallback) {
  if (!Array.isArray(raw)) return fallback.slice()
  const cleaned = []
  for (const item of raw) {
    if (typeof item !== 'string') return fallback.slice()
    const trimmed = item.trim()
    if (trimmed.length === 0) return fallback.slice()
    cleaned.push(trimmed)
  }
  return cleaned
}

/** 读同目录 config.json 并归一化；任何非法字段回落默认值，永不抛错。 */
export function loadConfig(overrides) {
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(join(PLUGIN_DIR, 'config.json'), 'utf8'))
  } catch {
    raw = {}
  }
  const src = { ...(raw && typeof raw === 'object' ? raw : {}), ...(overrides && typeof overrides === 'object' ? overrides : {}) }
  return {
    mode: src.mode === 'off' ? 'off' : 'mask',
    logFile: typeof src.logFile === 'string' && src.logFile ? src.logFile : DEFAULTS.logFile,
    core: cleanStringList(src.core, DEFAULTS.core),
    protect: cleanStringList(src.protect, DEFAULTS.protect),
    autoLoadServers: cleanStringList(src.autoLoadServers, DEFAULTS.autoLoadServers),
    searchMaxResults: boundedInt(src.searchMaxResults, DEFAULTS.searchMaxResults, 1, 20),
    searchMaxChars: boundedInt(src.searchMaxChars, DEFAULTS.searchMaxChars, 2000, 200000),
    searchBudgetRatio: typeof src.searchBudgetRatio === 'number' && Number.isFinite(src.searchBudgetRatio) && src.searchBudgetRatio > 0 && src.searchBudgetRatio <= 0.5
      ? src.searchBudgetRatio
      : DEFAULTS.searchBudgetRatio,
    contextWindow: boundedInt(src.contextWindow, DEFAULTS.contextWindow, 0, 10_000_000),
    loadMaxChars: boundedInt(src.loadMaxChars, DEFAULTS.loadMaxChars, 2000, 400000),
    descriptionMaxChars: boundedInt(src.descriptionMaxChars, DEFAULTS.descriptionMaxChars, 80, 4000),
    maxSchemaChars: boundedInt(src.maxSchemaChars, DEFAULTS.maxSchemaChars, 400, 200000),
  }
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`
  try {
    appendFileSync(join(PLUGIN_DIR, cfgForLog.logFile), line, 'utf8')
  } catch {
    /* 日志失败不影响主流程 */
  }
}
let cfgForLog = { logFile: DEFAULTS.logFile }

/** 工具名 → 归属分组：mcp__github__x → github；douyin_open → douyin；其余取首段。 */
export function groupOf(name) {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name)
  if (mcp) return mcp[1]
  const cut = name.indexOf('_')
  return cut > 0 ? name.slice(0, cut) : name
}

/** 中英混排粗略估算：CJK 约 1 token/字，其余约 1 token/4 字符。 */
export function estimateTokens(text) {
  let cjk = 0
  for (const ch of text) if (ch.codePointAt(0) > 0x2e80) cjk++
  return Math.round(cjk + (text.length - cjk) / 4)
}

const patternCache = new Map()

/** 把配置键编译成整串正则：`*` 可出现在任意位置，`*` 单独出现即匹配一切。 */
function compilePattern(pattern) {
  let compiled = patternCache.get(pattern)
  if (compiled === undefined) {
    const literal = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    compiled = new RegExp(`^(?:${literal})$`)
    patternCache.set(pattern, compiled)
  }
  return compiled
}

/** 配置键匹配：统一走正则，不再为「全匹配/前缀/精确」分别写分支。 */
export function matchesPattern(name, pattern) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (typeof pattern !== 'string' || pattern.length === 0) return false
  return compilePattern(pattern).test(name)
}

export function matchesAny(name, patterns) {
  return patterns.some((pattern) => matchesPattern(name, pattern))
}

const CJK_CHAR = /[\u3400-\u9fff]/
const WORD_SPLIT = /[^0-9A-Za-z\u3400-\u9fff]+/
const CAMEL = /([a-z0-9])([A-Z])/g

/** 分词：拉丁词按非字母数字与 camelCase 切；CJK 同时产出单字与二元组（无词典也能召回）。 */
export function tokenize(text) {
  const tokens = []
  for (const word of String(text ?? '').split(WORD_SPLIT)) {
    if (!word) continue
    if (CJK_CHAR.test(word)) {
      const chars = Array.from(word)
      chars.forEach((ch, index) => {
        tokens.push(ch)
        const next = chars[index + 1]
        if (next) tokens.push(ch + next)
      })
      continue
    }
    tokens.push(word.toLowerCase())
    const split = word.replace(CAMEL, '$1 $2')
    if (split !== word) {
      for (const piece of split.split(' ')) {
        if (piece.length > 1) tokens.push(piece.toLowerCase())
      }
    }
  }
  return tokens
}

/**
 * BM25 排序（Codex CLI 的 search_tool 同样用 BM25，比关键词全匹配更耐口语化查询）。
 * docs: [{ name, tokens }] → 按分数降序。
 */
export function rankBM25(docs, terms) {
  const total = docs.length || 1
  const docFreq = new Map()
  const prepared = docs.map((doc) => {
    const freq = new Map()
    for (const token of doc.tokens) freq.set(token, (freq.get(token) ?? 0) + 1)
    for (const token of freq.keys()) docFreq.set(token, (docFreq.get(token) ?? 0) + 1)
    return { ...doc, freq, length: doc.tokens.length }
  })
  const avgLength = prepared.reduce((sum, doc) => sum + doc.length, 0) / total || 1
  const k1 = 1.2
  const b = 0.75
  const unique = [...new Set(terms)]
  const scored = []
  for (const doc of prepared) {
    let score = 0
    for (const term of unique) {
      const freq = doc.freq.get(term) ?? 0
      if (!freq) continue
      const df = docFreq.get(term) ?? 0
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
      score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * doc.length) / avgLength)))
    }
    if (score > 0) scored.push({ ...doc, score })
  }
  return scored.sort((a, b2) => b2.score - a.score || a.name.localeCompare(b.name))
}

const CUT_NOTE = '…[超出预算已截断]'

/** 让返回值不超过预算：超预算就把尾部换成标记，标记本身也占预算。 */
export function clip(text, maxChars) {
  const raw = String(text ?? '')
  const budget = Number(maxChars)
  if (!Number.isFinite(budget) || raw.length <= budget) return raw
  if (budget < 1) return ''
  const keep = budget - CUT_NOTE.length
  return keep < 1 ? raw.slice(0, budget) : `${raw.slice(0, keep)}${CUT_NOTE}`
}

/** 渲染参数 schema；超大 schema 只给头部 + 顶层字段名，避免单条把上下文打爆。 */
export function renderSchema(schema, maxSchemaChars) {
  let text
  try {
    text = JSON.stringify(schema ?? {})
  } catch {
    text = '{}'
  }
  if (text.length <= maxSchemaChars) return text
  const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object'
    ? Object.keys(schema.properties)
    : []
  const required = Array.isArray(schema?.required) ? schema.required : []
  return text.slice(0, maxSchemaChars)
    + `\n…[schema 共 ${text.length} 字符已截断；顶层字段：${props.join(', ') || '（无）'}`
    + (required.length ? `；必填：${required.join(', ')}` : '')
    + ']'
}

export const name = 'dsh-tool-lazy'
export const inject = ['tools']

export function apply(ctx, pluginConfig) {
  cfgForLog = loadConfig(pluginConfig)
  const cfg = cfgForLog
  log(`apply: mode=${cfg.mode} core=${cfg.core.length} protect=${cfg.protect.length}`)
  if (cfg.mode === 'off') return
  try {
    ctx.inject(['tools'], (toolsCtx) => {
      try {
        mount(toolsCtx, cfg)
      } catch (err) {
        log(`mount failed: ${err?.message ?? err}`)
      }
    })
  } catch (err) {
    log(`inject failed: ${err?.message ?? err}`)
  }
}

function mount(ctx, cfg) {
  const tools = ctx.tools
  /** 输出尾部预留：留给「还有 N 个 / 已省略」这类提示。 */
  const TAIL_ROOM = 96
  /** 检索预算：固定上限与上下文窗口占比取小，避免小窗口模型上检索结果打爆上下文。 */
  const searchBudget = () => (cfg.contextWindow > 0
    ? Math.min(cfg.searchMaxChars, Math.max(2000, Math.round(cfg.contextWindow * cfg.searchBudgetRatio)))
    : cfg.searchMaxChars)

  /** 跨实例共享运行态：宿主热重载会留下旧实例，各实例私有状态会互相踩掩码。 */
  const shared = (globalThis.__dshToolLazy ??= {})
  if (!(shared.agents instanceof Map)) shared.agents = new Map()
  // 兼容旧版实例留下的状态形状（loaded/deny/disposer），避免热重载后掩码失联。
  if (shared.states instanceof Map) {
    for (const [agent, old] of shared.states) {
      if (shared.agents.has(agent)) continue
      shared.agents.set(agent, {
        agent,
        revealed: old.loaded instanceof Set ? old.loaded : new Set(),
        catalog: old.catalog instanceof Map ? old.catalog : undefined,
        hidden: Array.isArray(old.deny) ? old.deny : [],
        visible: new Set(),
        undo: old.disposer,
        error: old.error,
        lastPlan: undefined,
        stale: true,
      })
    }
    delete shared.states
  }
  if (typeof shared.busy !== 'boolean') shared.busy = false
  if (!Number.isFinite(shared.serial)) shared.serial = 0
  /** 供其它插件（dsh-skill-lazy）按名/按分组放开工具：失败只记日志，不影响调用方。
  每次挂载都覆盖：热重载后旧实例闭包已失效，必须让桥指向最新实例。
  返回值：`{ opened: [...], unknown: [...] }`（逐条回报，不再用单个布尔代表全部）——
  调用方据此分别列出「已放开」与「未找到」，避免部分成功被报成全部成功。 */
  shared.reveal = (agent, names) => {
      try {
        const wanted = (Array.isArray(names) ? names : []).map((raw) => String(raw)).filter((token) => token !== '')
        if (!wanted.length) return { opened: [], unknown: [] }
        const state = track(agent)
        if (!state) return { opened: [], unknown: wanted }
        // 分组名（如 github）不是工具名，必须先在全量目录里展开成具体工具名。
        releaseMask(state)
        const catalog = snapshot(agent)
        state.catalog = catalog
        state.stale = false
        const resolved = []
        const opened = []
        const unknown = []
        for (const token of wanted) {
          if (catalog.has(token) || token.includes('*')) {
            resolved.push(token)
            opened.push(token)
            continue
          }
          const members = [...catalog.keys()].filter((name) => groupOf(name) === token)
          if (members.length > 0) {
            resolved.push(...members)
            opened.push(token)
          } else {
            unknown.push(token)
          }
        }
        if (resolved.length > 0) reconcile(agent, resolved)
        if (unknown.length) log('reveal: unknown ' + unknown.join(', '))
        return { opened, unknown }
      } catch (err) {
        log('reveal failed: ' + (err && err.message ? err.message : err))
        return false
      }
  }
  const serial = shared.serial++
  const states = shared.agents
  log(`mount: serial=${serial} tracked=${states.size}`)
  // 新实例接管：旧实例留下的目录缓存一律作废，下一轮重新读全量视图。
  for (const state of states.values()) state.stale = true

  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }

  const stateOf = (agent) => states.get(agent)

  /** 摘掉本实例先前挂上的限制（只动自己那一层）。返回是否真的摘了。 */
  function releaseMask(state) {
    const undo = state.undo
    state.undo = undefined
    if (typeof undo !== 'function') return false
    try {
      undo()
    } catch (err) {
      log(`release mask failed: ${err?.message ?? err}`)
    }
    return true
  }

  /** 需要隐藏的名单 = 全量目录 -（硬保护 / protect / core / 已揭示）。 */
  function hiddenOf(names, revealed) {
    const hidden = []
    for (const toolName of names) {
      if (ALWAYS_PROTECT.includes(toolName)) continue
      if (matchesAny(toolName, cfg.protect)) continue
      if (matchesAny(toolName, cfg.core)) continue
      if (revealed.has(toolName)) continue
      hidden.push(toolName)
    }
    return hidden
  }

  /** 登记一个 agent（幂等）：元工具注册在它自己的作用域层，因此永不被掩码。 */
  function track(agent) {
    if (!agent?.ctx?.tools) return undefined
    const known = states.get(agent)
    if (known) return known
    const state = {
      agent,
      revealed: new Set(),
      catalog: undefined,
      hidden: [],
      visible: new Set(),
      undo: undefined,
      error: undefined,
      lastPlan: undefined,
      stale: true,
    }
    states.set(agent, state)
    try {
      agent.ctx.effect(() => () => {
        states.delete(agent)
        releaseMask(state)
      }, 'dsh-tool-lazy.mask')
    } catch (err) {
      log(`agent effect failed: ${err?.message ?? err}`)
    }
    if (cfg.autoLoadServers.length > 0) {
      for (const toolName of allNames()) {
        if (cfg.autoLoadServers.includes(groupOf(toolName))) state.revealed.add(toolName)
      }
    }
    registerMetaTools(agent)
    return state
  }

  /** 全局层当前注册的全部工具名（不受掩码影响的调用方用）。 */
  function allNames() {
    try {
      return (tools.definitions() ?? []).map((definition) => definition?.name).filter(Boolean)
    } catch (err) {
      log(`definitions() failed: ${err?.message ?? err}`)
      return []
    }
  }

  /**
   * 读全量目录。**必须在 releaseMask 之后调用**：限制生效时 definitions() 与
   * view(agent).restrictableNames 都收敛成「可见集」，此时读会把自己越掩越小。
   */
  function snapshot(agent) {
    const catalog = new Map()
    try {
      for (const definition of tools.definitions() ?? []) {
        if (definition?.name) catalog.set(definition.name, definition)
      }
    } catch (err) {
      log(`definitions() failed: ${err?.message ?? err}`)
    }
    try {
      for (const toolName of tools.view(agent)?.restrictableNames ?? []) {
        if (!catalog.has(toolName)) catalog.set(toolName, { name: toolName, description: '', parameters: {} })
      }
    } catch (err) {
      log(`view(agent) failed: ${err?.message ?? err}`)
    }
    return catalog
  }

  /** 两个名单是否等价（顺序无关）。 */
  function sameList(a, b) {
    if (a.length !== b.length) return false
    const seen = new Set(b)
    return a.every((item) => seen.has(item))
  }

  /** 校验单个揭示请求：返回问题原因，或 undefined 表示可以揭示。 */
  function revealProblem(state, raw, seen) {
    const toolName = String(raw)
    if (seen.has(toolName)) return '重复请求'
    seen.add(toolName)
    if (state.revealed.has(toolName)) return '已加载'
    if (!state.catalog.has(toolName)) return '不是可加载的工具'
    return undefined
  }

  /**
   * 收敛一个 agent 的掩码。**全程同步**（内部不许 await）。
   * 目录只在必要时重读（首次 / tool_load 的新名字 / tools/change）：其余用缓存，
   * 避免每步都摘掩码重挂，打断 prompt cache。
   */
  function reconcile(agent, requested) {
    if (shared.busy) {
      const current = states.get(agent)
      return current ? { state: current, plan: current.lastPlan } : undefined
    }
    shared.busy = true
    try {
      const state = track(agent)
      if (!state) return undefined
      const wants = Array.isArray(requested) ? requested : []
      // 刷新条件：没有目录 / 被标脏 / 请求的名字在当前目录里查不到（可能是新注册的工具或分组）。
      let stale = !state.catalog || state.stale
      if (!stale && wants.length > 0) {
        stale = wants.some((raw) => {
          const token = String(raw)
          if (state.catalog.has(token) || token.includes('*')) return false
          for (const name of state.catalog.keys()) if (groupOf(name) === token) return false
          return true
        })
      }
      if (stale) {
        releaseMask(state)
        state.catalog = snapshot(agent)
        state.stale = false
      }
      const names = [...state.catalog.keys()]

      if (wants.length > 0) {
        const plan = { revealed: [], skipped: [] }
        const seen = new Set()
        for (const raw of wants) {
          const problem = revealProblem(state, raw, seen)
          if (problem) {
            plan.skipped.push({ name: String(raw), problem })
            continue
          }
          const toolName = String(raw)
          state.revealed.add(toolName)
          plan.revealed.push(toolName)
        }
        state.lastPlan = plan
      }

      const hidden = hiddenOf(names, state.revealed)
      // 名单没变就不重挂限制：掩码字节稳定，prompt cache 才不会被反复打断。
      const stable = Boolean(state.undo) && sameList(hidden, state.hidden)
      if (!stable) {
        releaseMask(state)
        if (hidden.length > 0) {
          try {
            state.undo = agent.ctx.tools.restrict({ deny: hidden })
            state.error = undefined
          } catch (err) {
            // 掩码失败就整体放弃掩码：宁可工具全开，也不要留下没有元工具的半残状态。
            state.undo = undefined
            state.error = err?.message ?? String(err)
            log(`restrict() refused, leaving tools unmasked: ${state.error}`)
          }
        } else {
          state.error = undefined
        }
      }
      state.hidden = hidden
      state.visible = new Set(names.filter((name) => !hidden.includes(name)))
      log(
        `reconcile: agent=${agent.id ?? '?'} known=${names.length} hidden=${hidden.length} revealed=${state.revealed.size}`
        + ` visibleTokens≈${estimateTokens(JSON.stringify([...state.visible].map((name) => state.catalog.get(name))))}`
        + ` allTokens≈${estimateTokens(JSON.stringify([...state.catalog.values()].map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }))))}`
        + (state.error ? ` error=${state.error}` : ''),
      )
      return { state, plan: state.lastPlan }
    } finally {
      shared.busy = false
    }
  }

  /** 元工具定义（手写 JSON Schema，避免对 @deepseek-ai/* 的运行时依赖）。 */
  function metaDefinitions(agent) {
    const search = {
      name: 'tool_search',
      description:
        '在隐藏的工具里检索，返回名字、描述与完整 schema。空 query 只列名字。'
        + '命中后用 tool_load 揭示，下一步生效。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词；留空只列名字' },
          limit: { type: 'integer', description: '最多几个命中（上限 20）' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute(args) {
        const result = reconcile(agent)
        if (!result) return '[tool-lazy] 当前调用没有 agent 上下文。'
        const state = result.state
        const maxChars = searchBudget()
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (!query) {
          const names = state.hidden
          const head = `[tool-lazy] 当前隐藏 ${names.length} 个工具（只有名字，没有 schema）。`
            + '用关键词检索可拿到完整参数 schema，再 tool_load 揭示。\n'
          const room = Math.max(200, maxChars - head.length - TAIL_ROOM)
          const shown = []
          let width = 0
          for (const toolName of names) {
            const cost = toolName.length + 1
            if (width + cost > room) break
            shown.push(toolName)
            width += cost
          }
          const rest = names.length - shown.length
          return head + shown.join('\n') + (rest > 0 ? `\n…[${rest} 个未列出，用关键词缩小范围]` : '')
        }
        const terms = tokenize(query)
        if (!terms.length) return '没有解析出检索词，请换用工具名或功能描述里的词。'
        const docs = []
        for (const [toolName, schema] of state.catalog) {
          if (!state.hidden.includes(toolName)) continue
          const nameTokens = tokenize(toolName)
          const descTokens = tokenize(schema.description ?? '')
          docs.push({
            name: toolName,
            schema,
            // 名字权重 ≈3 倍：工具名比描述更能代表能力。
            tokens: [...nameTokens, ...nameTokens, ...nameTokens, ...descTokens],
          })
        }
        const lowered = query.toLowerCase()
        const scored = rankBM25(docs, terms).map((hit) => ({
          ...hit,
          score: hit.score + (hit.name.toLowerCase() === lowered ? 50 : hit.name.toLowerCase().includes(lowered) ? 12 : 0),
        })).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        if (!scored.length) return `没有匹配“${query}”的隐藏工具。试试空 query 列全部名字，或用 tool_status 看分组。`
        const limit = boundedInt(args?.limit, cfg.searchMaxResults, 1, 20)
        const picked = scored.slice(0, limit)
        const head = `[tool-lazy] “${query}” 命中 ${scored.length} 个隐藏工具，显示前 ${picked.length} 个（schema 完整可用）：\n`
        const room = maxChars - head.length - TAIL_ROOM
        const parts = []
        const dropped = []
        let spent = 0
        for (const hit of picked) {
          const part = '\n### ' + hit.name
            + '\ndescription: ' + clip(String(hit.schema.description ?? '').replace(/\s+/g, ' '), cfg.descriptionMaxChars)
            + '\nparameters:\n' + renderSchema(hit.schema.parameters ?? {}, cfg.maxSchemaChars)
          if (spent + part.length > room) {
            dropped.push(hit.name)
            continue
          }
          spent += part.length
          parts.push(part)
        }
        const note = dropped.length > 0
          ? `\n\n…[${dropped.length} 个命中因预算省略：${dropped.join(', ')}；缩小关键词或提高 searchMaxChars]`
          : ''
        return head + parts.join('') + note + '\n\n加载：tool_load({ names: ["..."] })。'
      },
    }

    const load = {
      name: 'tool_load',
      description:
        '按名字或分组揭示隐藏的工具，返回完整 schema。只增不减，下一步生效。',
      parameters: {
        type: 'object',
        properties: {
          names: { type: 'array', items: { type: 'string' }, description: '工具名' },
          server: { type: 'string', description: '分组名，如 github / playwright / openviking' },
        },
        additionalProperties: false,
      },
      output: textOutput,
      isConcurrencySafe: () => false,
      async execute(args) {
        const current = stateOf(agent)
        const catalog = current?.catalog ?? new Map()
        const requested = []
        const unknown = []
        for (const raw of Array.isArray(args?.names) ? args.names : []) {
          const toolName = String(raw)
          if (catalog.has(toolName)) requested.push(toolName)
          else unknown.push(toolName)
        }
        let groupHit = 0
        if (args?.server) {
          for (const toolName of catalog.keys()) {
            if (groupOf(toolName) === args.server) { requested.push(toolName); groupHit++ }
          }
          if (!groupHit) return `没有名为 ${args.server} 的工具分组（tool_status 可看全部分组）。`
        }
        if (!requested.length && !unknown.length) return '没有指定要加载的工具名或分组。'
        const result = reconcile(agent, requested)
        if (!result) return '[tool-lazy] 当前调用没有 agent 上下文。'
        const state = result.state
        const plan = result.plan ?? { revealed: [], skipped: [] }
        const lines = []
        lines.push(plan.revealed.length > 0
          ? `已加载 ${plan.revealed.length} 个工具：${plan.revealed.join(', ')}（下一步生效，可直接调用）。`
          : '没有新加载的工具。')
        lines.push(`本会话已加载 ${state.revealed.size} 个；仍隐藏 ${state.hidden.length} 个。`)
        if (unknown.length > 0) lines.push(`未找到：${unknown.join(', ')}（用 tool_search 确认名字）`)
        const notes = plan.skipped.filter((item) => item.problem !== '已加载')
        if (notes.length > 0) lines.push(`忽略：${notes.map((item) => `${item.name}（${item.problem}）`).join(', ')}`)
        if (state.error) lines.push(`掩码未生效（工具全开）：${state.error}`)
        const budget = cfg.loadMaxChars - TAIL_ROOM
        let used = lines.join('\n').length
        const sections = []
        for (const toolName of plan.revealed) {
          const section = '\n### ' + toolName + '\nparameters:\n' + renderSchema(state.catalog.get(toolName)?.parameters ?? {}, cfg.maxSchemaChars)
          if (used + section.length > budget) {
            sections.push(`\n…[${toolName} 的 schema 因预算省略，用 tool_search "${toolName}" 查看]`)
            continue
          }
          used += section.length
          sections.push(section)
        }
        return [...lines, ...sections].join('\n')
      },
    }

    const status = {
      name: 'tool_status',
      description: '报告懒加载状态：本会话可见/隐藏的工具数、估算 token 占用与隐藏分组。用于核对优化效果。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: textOutput,
      isConcurrencySafe: () => true,
      async execute() {
        // 诊断调用：先标脏再收敛，强制读一次全量目录，避免读到被自己掩码污染的缓存。
        const existing = stateOf(agent)
        if (existing) existing.stale = true
        const result = reconcile(agent)
        const state = result?.state ?? stateOf(agent)
        if (!state) return '[tool-lazy] 当前调用没有 agent 上下文。'
        const groups = new Map()
        for (const toolName of state.hidden) {
          const group = groupOf(toolName)
          groups.set(group, (groups.get(group) ?? 0) + 1)
        }
        const visible = [...state.visible]
        const visibleTokens = estimateTokens(JSON.stringify(visible.map((n) => state.catalog.get(n))))
        const allTokens = estimateTokens(JSON.stringify([...state.catalog.values()]))
        // 逐工具成本：定 core 白名单时按数据删，而不是凭感觉删。
        const heaviest = visible
          .map((toolName) => ({ toolName, cost: estimateTokens(JSON.stringify(state.catalog.get(toolName) ?? {})) }))
          .sort((a, b) => b.cost - a.cost)
          .slice(0, 12)
          .map((item) => `${item.toolName}(≈${item.cost})`)
          .join(' ')
        const groupText = [...groups.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g}(${n})`).join(' ')
        const ratio = cfg.contextWindow > 0
          ? `占窗口：可见 ≈${((visibleTokens / cfg.contextWindow) * 100).toFixed(1)}% / 全量 ≈${((allTokens / cfg.contextWindow) * 100).toFixed(1)}%`
            + (visibleTokens / cfg.contextWindow > 0.1 ? '（可见部分已超窗口的 10%，考虑精简 core 白名单）' : '')
          : ''
        return [
          `模式：${cfg.mode} / 策略：deny（fail-open）`,
          `可掩码工具总数：${state.catalog.size}；本会话可见：${visible.length}；隐藏：${state.hidden.length}；已加载：${state.revealed.size}`,
          `估算 token（可见/全量）：≈${visibleTokens} / ≈${allTokens}`,
          `最重可见工具：${heaviest || '（无）'}`,
          ratio,
          `隐藏分组：${groupText || '（无）'}`,
          state.error ? `掩码未生效原因：${state.error}` : '',
        ].filter(Boolean).join('\n')
      },
    }

    return [search, load, status]
  }

  /** 注册元工具到 agent 自己的作用域；重复调用安全。 */
  function registerMetaTools(agent) {
    for (const definition of metaDefinitions(agent)) {
      try {
        agent.ctx.tools.register(definition)
      } catch (err) {
        log(`register ${definition.name} failed: ${err?.message ?? err}`)
      }
    }
  }

  // 已有 agent（插件加载前就创建的会话）不会收到 agent/created，靠 tools/change + pre-step 兜住。
  ctx.on('agent/created', (payload) => {
    try {
      reconcile(payload?.agent)
    } catch (err) {
      log(`agent/created failed: ${err?.message ?? err}`)
    }
  })

  ctx.on('tools/change', () => {
    if (shared.busy) return
    // 工具注册表变了：目录缓存作废，下一次收敛重新读全量视图。
    for (const state of states.values()) state.stale = true
    for (const agent of [...states.keys()]) {
      try {
        reconcile(agent)
      } catch (err) {
        log(`tools/change resync failed: ${err?.message ?? err}`)
      }
    }
  })

  ctx.on('agent/pre-step', (payload, next) => {
    try {
      const agent = payload?.agent
      if (agent) reconcile(agent)
    } catch (err) {
      log(`pre-step failed: ${err?.message ?? err}`)
    }
    return typeof next === 'function' ? next() : undefined
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent)
    if (state) lift(state)
    states.delete(agent)
  })
}

export default { name, inject, apply }
