# dsh-tool-lazy

DSH 插件：把低频工具（MCP / 插件工具）从每次请求的工具定义里摘掉，只保留一份常用核心集；
模型需要时用 `tool_search` 找到、`tool_load` 挂上。目标是把常驻工具定义从 ~58K token 压到 3K–8K，
且**不减少实际可用能力**。

## 机制

- 用宿主原生 `agent.ctx.tools.restrict({ deny })`（作用域限制层），按 agent 隐藏工具；
  隐藏的工具不再产生任何 schema 成本。
- `deny` 是 fail-open：只点名要隐藏的工具，原生工具（pwsh/read/write/edit/grep/glob…）永远不会被误伤。
- 元工具注册在 **agent 自己的作用域层**，不受限制影响，因此永远不会被自己掩掉。
- 目录缓存 + 幂等：名单不变就不重建限制，避免打断 prompt 缓存。

## 元工具

| 工具 | 作用 |
| --- | --- |
| `tool_search(query)` | BM25 检索隐藏工具，返回完整参数 schema（最多 5 个 / 预算内） |
| `tool_load(names \| server)` | 把工具或整组揭示到本会话，之后即可正常调用 |
| `tool_status()` | 报告可见/隐藏数量、估算 token、隐藏分组、占窗口比例 |

## 配置（config.json）

| 键 | 说明 |
| --- | --- |
| `mode` | `mask`（默认）/ `off`（立即恢复全量工具） |
| `core` | 常驻白名单（支持 `mcp__server__*` 通配） |
| `protect` | 额外豁免，永不被隐藏 |
| `autoLoadServers` | 会话创建时自动加载的工具分组 |
| `searchMaxResults` / `searchMaxChars` | 检索返回条数与字符预算 |
| `searchBudgetRatio` / `contextWindow` | 按上下文窗口比例动态收紧检索预算 |
| `loadMaxChars` / `descriptionMaxChars` / `maxSchemaChars` | 输出与 schema 的裁剪上限 |

配置在插件加载时读取：改完需重载插件（或重启 DSH）才生效。

## 测试

```
node --check lib/index.js
node tests/mock.mjs     # 11 条用例，覆盖掩码/检索/揭示/幂等/失败退让
```

## 安装/卸载

- 安装：profile `package.json` 的 `dsh.profile.bundles` 加 `dsh-tool-lazy`，`dependencies` 加 `link:<本目录>`。
- 卸载：把 `mode` 设为 `off`（立即恢复全量工具），或从 bundles/dependencies 移除后重启。

## 使用与二次分发

本项目以 MIT 许可发布：可自由使用、修改、再分发。

**要求**：如果你把本项目的代码（含修改后的版本）用到别的项目或再发布，请注明来源：

- 原项目：`dsh-tool-lazy`
- 作者：lokic7123-star
- 仓库：https://github.com/lokic7123-star/dsh-tool-lazy

一句话的形式即可，例如「本插件基于 lokic7123-star 的 dsh-tool-lazy 修改」。