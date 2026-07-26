# my-money

本地个人财务应用：追踪多张银行卡（debit / credit / prepaid）的余额与每月分类支出。

**应用本身不内置 AI、不需要任何 API key。** 它同时是一个 **MCP server**——你在 Claude Code / Claude Desktop 里把银行账单丢给 AI，AI 解析后通过 MCP 工具把交易写进来；应用负责存储、去重、统计和可视化。所有数据存在本地 SQLite（`data/money.db`）。

## 快速开始

```bash
npm install
npm run build     # 构建前端
npm start         # 启动 http://localhost:4321 并自动打开浏览器
```

开发模式（前端热更新）：`npm run dev`

## MCP：让 AI 帮你记账

项目根目录已有 `.mcp.json`，**用 Claude Code 打开本项目时 MCP server 自动可用**。要在其他项目/全局使用：

```bash
claude mcp add --scope user my-money -- npx tsx G:/Things/my-money/packages/server/src/mcp.ts
```

然后在对话里直接说，比如：

> 这是我 RBC 七月的账单 CSV（粘贴/附上文件），帮我导入到 RBC Chequing，顺便分类。

AI 会调用这些工具：

| 工具 | 作用 |
|---|---|
| `list_accounts` / `create_account` | 查看/创建账户（credit 自动记为负债） |
| `list_categories` | 分类名列表（AI 分类时用这些名字） |
| `import_transactions` | **核心**：批量写入交易（带符号整数分，+收入/−支出）。自动去重——重叠账单随便重复导入；AI 给的分类会记成商户规则，下次同商户自动分类。可传账单期末余额（`statement_end_balance_cents`）自动对账，符号解析错误当场发现 |
| `list_transactions` | 按账户/月份/分类/关键词查询 |
| `set_category` | 修正分类（生成用户规则，可批量应用到同商户） |
| `set_note` | 给交易加备注（账单描述看不出是什么时用） |
| `mark_transfer` | 标记转账（信用卡还款、自转账），不计入支出 |
| `link_transfer_pair` | 把两笔交易配对成同一笔内部转账的两侧（参考 `get_summary` 的配对建议） |
| `get_summary` | 净资产（折 CAD）+ 月度分类支出 + 转账配对建议 |
| `list_imports` / `undo_import` | 导入历史 / 一键撤销整批 |
| `set_fx_rate` | 设置非 CAD 货币汇率 |
| `set_balance_snapshot` / `list_balance_snapshots` | **投资/退休账户**（Wealthsimple、IBKR、RRSP/TFSA）：市值不走流水，定期记快照。跟 AI 说一句"我 TFSA 现在 $24,100"即可；净资产取最新快照 |

## 投资 / 退休账户

股票和退休账户不导交易流水（市值会自己波动，流水账模型不适用），用**快照模型**：

- 建账户时选 `investment` 类型
- 每月（或想起来时）更新一次当前市值——对 AI 说一句，或在 Accounts 页点 "Update value"
- 净资产 = 最新快照；快照有历史，能看到市值变化
- 从 chequing 转入的入金在 chequing 侧标为 Transfer（不算消费）；收益率等分析请用券商自己的界面，本工具只回答"总共有多少钱"

MCP server 和 Web 界面共用同一个数据库（WAL 模式），可以同时运行——AI 导入完，刷新浏览器就能看到。

## Web 界面

- **Dashboard**：净资产（多货币折 CAD，负债红色）、月度分类支出 donut、6 个月收支趋势
- **Accounts**：卡片管理
- **Transactions**：筛选、改分类（提示批量应用规则）、标记转账
- **Import**：不用 AI 的手动导入——新格式做一次列映射（之后按格式指纹记住，全自动）
- **Settings**：MCP 接入说明、汇率、导入历史（可撤销）、商户规则、分类管理、暗色主题

## 数据保障

- 金额全部为**带符号整数分**，无浮点误差
- 去重三层：整文件哈希警告、逐行指纹（含同日同额同商户的序号）、数据库 UNIQUE 约束
- 每次导入（Web 或 MCP）都是一个批次，可整体撤销
- 分类规则：你的手动修正（user）永远优先于 AI 写入的规则（ai）

## 技术栈

TypeScript monorepo（npm workspaces）：

| 包 | 内容 |
|---|---|
| `packages/server` | Hono HTTP API（端口 4321）+ MCP server（stdio，`npm run mcp`）+ Node 内置 `node:sqlite` |
| `packages/web` | React 19 + Vite + Recharts，CSS 变量主题（明/暗） |
| `packages/shared` | 共享类型 + zod schema |

数据库：`data/money.db`（备份 = 复制文件；`MY_MONEY_DB` 环境变量可改路径）。
