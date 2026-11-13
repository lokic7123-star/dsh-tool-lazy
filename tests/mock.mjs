/**
 * dsh-tool-lazy 离线自测：用最小 mock 复刻宿主 tools 服务语义。
 * 只验证插件自身逻辑（掩码/揭示/检索/预算/降级），不替代宿主真机验收。
 * 运行：node tests/mock.mjs
 */
import assert from 'node:assert/strict'
import { apply, groupOf, estimateTokens, matchesPattern, tokenize } from '../lib/index.js'

const META = ['tool_search', 'tool_load', 'tool_status']

const ALL_TOOLS = [
  // 原生核心工具（宿主注册在全局层）
  { name: 'pwsh', description: 'Run a PowerShell command' },
  { name: 'read', description: 'Read a text file' },
  { name: 'write', description: 'Write a text file' },
  { name: 'edit', description: 'Edit a file' },
  { name: 'grep', description: 'Search file contents' },
  { name: 'glob', description: 'Find files' },
  { name: 'web_search', description: 'Search the web' },
  { name: 'run_code', description: 'Programmatic tool calling transport' },
  // MCP / 插件工具（应被掩码）
  { name: 'mcp__github__search_repositories', description: 'Search GitHub repositories by keyword' },
  { name: 'mcp__github__create_pull_request', description: 'Create a pull request in a GitHub repository' },
  { name: 'mcp__playwright__browser_click', description: 'Click an element in the browser page' },
  { name: 'mcp__douyin__video_transcript', description: '把抖音视频转写为文字并返回字幕' },
  { name: 'mcp__magpie-web-search__web_search', description: 'Search the web through magpie' },
  { name: 'mcp__time__get_current_time', description: 'Get current time in a timezone' },
  { name: 'mcp__openviking__remember', description: 'Submit information for OpenViking long-term memory' },
  { name: 'mcp__openviking__search', description: 'Retrieval with session context from OpenViking memory' },
]
  .map((tool) => ({ ...tool, parameters: { type: 'object', properties: { q: { type: 'string' } } } }))

function makeHost() {
  const globalTools = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]))
  const handlers = new Map()
  const restrictCalls = []
  const disposers = []
  let restrictThrows = false
  let released = 0

  const tools = {
    register(definition) {
      globalTools.set(definition.name, definition)
      return () => globalTools.delete(definition.name)
    },
    definitions() {
      return [...globalTools.values()]
    },
    view() {
      return { restrictableNames: [...globalTools.keys()] }
    },
    schemas() {
      return [...globalTools.values()]
    },
    restrict(filter) {
      if (restrictThrows) throw new Error('restrict exploded')
      restrictCalls.push(filter)
      return () => { released += 1 }
    },
  }

  const ctx = {
    tools,
    inject(_deps, callback) {
      callback(ctx)
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    effect(factory, label) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push({ label, dispose })
      return () => {}
    },
  }
  return {
    ctx,
    handlers,
    restrictCalls,
    disposers,
    globalTools,
    releasedCount: () => released,
    setRestrictThrows: (value) => { restrictThrows = value },
  }
}

function makeAgent(host, id) {
  const agentTools = new Map()
  // 宿主语义：agent.ctx.tools 是该 agent 作用域下的 tools 服务（restrict 走 agent 作用域，
  // register 落到自己这一层，故元工具永不被自己掩码）。
  const agent = {
    id,
    tools: agentTools,
    ctx: {
      tools: {
        register(definition) {
          agentTools.set(definition.name, definition)
          return () => agentTools.delete(definition.name)
        },
        restrict: (filter) => host.ctx.tools.restrict(filter),
        definitions: () => host.ctx.tools.definitions(),
        view: (scope) => host.ctx.tools.view(scope),
      },
      effect(factory) {
        factory()
      },
    },
  }
  return agent
}

const tests = []
const test = (label, fn) => tests.push({ label, fn })

test('配置：按 agent 掩码时只 deny 非核心工具', () => {
  const host = makeHost()
  apply(host.ctx, { core: ['pwsh', 'read', 'write', 'edit', 'grep', 'glob', 'web_search', 'mcp__magpie-web-search__web_search'] })
  const agent = makeAgent(host, 'a1')
  host.handlers.get('agent/created')({ agent })
  assert.equal(host.restrictCalls.length, 1)
  const deny = host.restrictCalls[0].deny
  assert.ok(Array.isArray(deny), '应使用 deny 策略')
  assert.ok(!deny.includes('pwsh'), '核心工具不得被掩码')
  assert.ok(!deny.includes('run_code'), 'run_code 是保留名，绝不能进 deny')
  assert.ok(deny.includes('mcp__github__search_repositories'), 'MCP 工具应被掩码')
  assert.ok(deny.includes('mcp__time__get_current_time'))
  assert.ok(!deny.includes('mcp__github__search_repositories'.replace('search_repositories', 'nope')))
})

test('元工具注册在 agent 作用域（不受掩码影响）', () => {
  const host = makeHost()
  apply(host.ctx, { core: ['pwsh'] })
  const agent = makeAgent(host, 'a2')
  host.handlers.get('agent/created')({ agent })
  for (const toolName of META) assert.ok(agent.tools.has(toolName), `${toolName} 应注册在 agent 作用域`)
})

test('tool_search：命中隐藏工具，只给参数签名不给完整 schema', async () => {
  const host = makeHost()
  apply(host.ctx, { core: ['pwsh'] })
  const agent = makeAgent(host, 'a3')
  host.handlers.get('agent/created')({ agent })
  const search = agent.tools.get('tool_search')
  const output = await search.execute({ query: 'github pull request' })
  assert.match(output, /create_pull_request/)
  assert.match(output, /参数：/)
  assert.ok(!output.includes('"type":"object"'), '检索结果不应携带完整 schema（那是 tool_load 揭示后的事）')
  assert.match(output, /tool_load/)
})

test('tool_search：空 query 只列名字，不含 schema', async () => {
  const host = makeHost()
  apply(host.ctx, { core: ['pwsh'] })
  const agent = makeAgent(host, 'a4')
  host.handlers.get('agent/created')({ agent })
  const output = await agent.tools.get('tool_search').execute({ query: '' })
  assert.match(output, /当前隐藏 \d+ 个工具/)
  assert.match(output, /mcp__github__search_repositories/)
  assert.ok(!output.includes('"type":"object"'), '空 query 不应付 schema 成本')
})

test('tool_search：CJK 查询能召回', async () => {
  const host = makeHost()
  apply(host.ctx, { core: ['pwsh'] })
  const agent = makeAgent(host, 'a5')
  host.handlers.get('agent/created')({ agent })
  const output = await agent.tools.get('tool_search').execute({ query: '抖音 视频转写' })
  assert.match(output, /video_transcript/)
})

test('tool_load：按名揭示后 deny 收缩，且核心工具保留', async () => {
  const host = makeHost()
  apply(host.ctx, { core: ['pwsh', 'read'] })
  const agent = makeAgent(host, 'a6')
  host.handlers.get('agent/created')({ agent })
  const before = host.restrictCalls.at(-1).deny.length
  const output = await agent.tools.get('tool_load').execute({ names: ['mcp__github__search_repositories'] })
  assert.match(output, /已加载 1 个工具/)
  assert.match(output, /parameters:/)
  const after = host.restrictCalls.at(-1).deny
  assert.ok(after.length < before, '揭示后 deny 应变小')
  assert.ok(!after.includes('mcp__github__search_repositories'), '已加载工具不再被掩码')
  assert.ok(!after.includes('pwsh'))
})

test('tool_load：按分组整组揭示 + 未知名字提示', async () => {
  const host = makeHost()
  apply(host.ctx, { core: ['pwsh'] })
  const agent = makeAgent(host, 'a7')
  host.handlers.get('agent/created')({ agent })
  const load = agent.tools.get('tool_load')
  const grouped = await load.execute({ server: 'github' })
  assert.match(grouped, /已加载 2 个工具/)
  const unknown = await load.execute({ names: ['mcp__nope__x'] })
  assert.match(unknown, /未找到/)
  const empty = await load.execute({})
  assert.match(empty, /没有指定要加载/)
})

test('揭示单调增长：重复加载不再新建掩码', async () => {
  const host = makeHost()
  apply(host.ctx, { core: ['pwsh'] })
  const agent = makeAgent(host, 'a8')
  host.handlers.get('agent/created')({ agent })
  const load = agent.tools.get('tool_load')
  await load.execute({ names: ['mcp__time__get_current_time'] })
  const callsAfterFirst = host.restrictCalls.length
  const again = await load.execute({ names: ['mcp__time__get_current_time'] })
  assert.match(again, /已加载/)
  assert.equal(host.restrictCalls.length, callsAfterFirst, '名单不变时不应重复 restrict')
})

test('tool_status：报可见/隐藏/估算 token，并按窗口占比告警', async () => {
  const host = makeHost()
  apply(host.ctx, { core: ['pwsh'], contextWindow: 128000 })
  const agent = makeAgent(host, 'a9')
  host.handlers.get('agent/created')({ agent })
  const output = await agent.tools.get('tool_status').execute({})
  assert.match(output, /策略：deny/)
  assert.match(output, /估算 token（可见\/全量）/)
  assert.match(output, /占窗口：可见 ≈\d+\.\d%/)
  assert.match(output, /隐藏分组：/)
})

test('fail-open：restrict 抛错时记录原因并保持工具全开', async () => {
  const host = makeHost()
  apply(host.ctx, { core: ['pwsh'] })
  const agent = makeAgent(host, 'a10')
  host.setRestrictThrows(true)
  host.handlers.get('agent/created')({ agent })
  const output = await agent.tools.get('tool_status').execute({})
  assert.match(output, /掩码未生效原因：restrict exploded/)
})

test('reconcile 桥：逐条回报 opened / unknown（供 dsh-skill-lazy 分别回执）', () => {
  const host = makeHost()
  apply(host.ctx, { core: ['pwsh'] })
  const agent = makeAgent(host, 'a11')
  host.handlers.get('agent/created')({ agent })
  const hub = globalThis.__dshToolLazy
  assert.equal(typeof hub?.reveal, 'function', '应暴露共享桥')
  const receipt = hub.reveal(agent, ['github', '不存在的组xyz'])
  assert.deepEqual(receipt.opened, ['github'], '有效分组应进 opened')
  assert.deepEqual(receipt.unknown, ['不存在的组xyz'], '未知名字应进 unknown')
  assert.deepEqual(hub.reveal(agent, []), { opened: [], unknown: [] })
  assert.ok(host.restrictCalls.some((call) => call.deny && !call.deny.includes('mcp__github__search_repositories')),
    '揭示后 github 工具不应再出现在 deny 里')
})

test('生命周期：agent/disposed 不抛错，释放掩码并清掉状态', () => {
  const host = makeHost()
  apply(host.ctx, { core: ['pwsh'] })
  const agent = makeAgent(host, 'a12')
  host.handlers.get('agent/created')({ agent })
  const before = globalThis.__dshToolLazy.agents.size
  assert.ok(before >= 1, '创建后应有状态')
  const releasedBefore = host.releasedCount()
  assert.doesNotThrow(() => host.handlers.get('agent/disposed')({ agent }))
  assert.equal(globalThis.__dshToolLazy.agents.size, before - 1, '销毁后状态应被清理')
  assert.ok(host.releasedCount() > releasedBefore, '销毁时应摘掉掩码')
})

test('插件卸载：摘掉本实例的掩码并让共享桥失效', () => {
  const host = makeHost()
  apply(host.ctx, { core: ['pwsh'] })
  const agent = makeAgent(host, 'a13')
  host.handlers.get('agent/created')({ agent })
  assert.equal(typeof globalThis.__dshToolLazy?.reveal, 'function')
  const lifecycle = host.disposers.find((item) => item.label === 'dsh-tool-lazy.lifecycle')
  assert.ok(lifecycle, '应注册生命周期清理 effect')
  const releasedBefore = host.releasedCount()
  lifecycle.dispose()
  assert.equal(globalThis.__dshToolLazy.reveal, undefined, '卸载后桥应失效')
  assert.ok(host.releasedCount() > releasedBefore, '卸载时应摘掉掩码')
  assert.equal(globalThis.__dshToolLazy.agents.size, 0, '卸载后状态应清空')
})

test('工具函数：分组/通配/分词/估算', () => {
  assert.equal(groupOf('mcp__github__search_code'), 'github')
  assert.equal(groupOf('mcp__magpie-web-search__web_search'), 'magpie-web-search')
  assert.equal(groupOf('terminal_send'), 'terminal')
  assert.ok(matchesPattern('mcp__github__x', 'mcp__github__*'))
  assert.ok(matchesPattern('anything', '*'))
  assert.ok(!matchesPattern('x', 'y*'))
  const tokens = tokenize('searchGitHub 抖音视频')
  assert.ok(tokens.includes('search'), 'camelCase 应拆开')
  assert.ok(tokenize('GitHub').includes('github'), '整词应保留小写形式')
  assert.ok(tokens.includes('视频'), 'CJK 应产出二元组')
  assert.ok(estimateTokens('中文中文') >= 4)
})

let failed = 0
for (const { label, fn } of tests) {
  try {
    await fn()
    console.log(`ok   ${label}`)
  } catch (err) {
    failed++
    console.log(`FAIL ${label}\n     ${err?.message ?? err}`)
  }
}
console.log(failed === 0 ? `\nmock tests passed (${tests.length})` : `\n${failed} failed / ${tests.length}`)
process.exitCode = failed === 0 ? 0 : 1