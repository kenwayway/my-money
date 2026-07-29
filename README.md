# my-money

本地个人财务应用：追踪多张银行卡（debit / credit / prepaid）的余额与每月分类支出。

**应用本身不内置 AI、不需要任何 API key。** 它同时是一个 **MCP server**：你先在 Web 界面上传银行账单 PDF 或 CSV，之后让 Claude Code / Claude Desktop 通过 MCP 读取文件、判断所属账户、解析并写入交易；应用负责原件存储、去重、对账、统计和可视化。数据和账单文件都只保存在本机。

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

把示例路径替换为仓库在你机器上的绝对路径。

## Statement Inbox 工作流

1. 先在 **Accounts** 建好对应账户。
2. 打开 **Statements**，点击 **Upload PDF or CSV**，直接上传文件，不需要选择账户。
3. 上传后文件会出现在 **Statement Inbox**。点击 **Copy AI prompt**，或在已连接 MCP 的 AI 对话中直接说：

   > 处理 my-money 里待导入的 statements，帮我分类，并用账单期末余额对账。

4. AI 会调用 `list_statement_documents` 找到待处理文件，通过 `statement://documents/{id}` resource 读取 PDF 或 CSV，自行选择账户，再调用 `import_transactions` 写入并关联原件。若账单印有 statement period，AI 会同时保存准确的起止日期。
5. 回到浏览器时页面会自动刷新。成功导入的文件会离开 Inbox，并出现在 Statement history 和月度覆盖矩阵中。

Web App 不会主动唤醒或自动运行 AI；上传和解析是两个明确步骤。Statement Inbox 中：

- **Pending**：尚未成功导入
- **Needs re-import**：之前的导入已 Undo，原件仍保留
- 新上传文件保持未分配账户状态，直到 AI 成功导入；上传但未处理的文件不计入月度 statement coverage
- PDF 必须有真实 `%PDF-` 文件头；CSV 必须是 UTF-8，并包含逗号、Tab 或分号分隔字段
- 单份文件上限 20 MiB；相同内容会按 SHA-256 拒绝重复上传
- 已处理文件可在 statement 详情中查看、下载或独立删除；删除原件不会删除交易
- 过去已经导入但没有原件的记录，可在 Statement history 打开详情后点击 **Attach original file** 补上传 PDF 或 CSV；这不会重新解析或修改既有交易与对账结果
- Statement 详情中的 **Edit statement period** 可手动修改账单印刷的起止日期；修改后会重算已有余额校验，但不会改动交易

如果你不走 Statement Inbox，也仍然可以像以前一样把交易数据直接交给 AI，例如：

> 这是我 RBC 七月的账单 CSV（粘贴/附上文件），帮我导入到 RBC Chequing，顺便分类。

AI 会调用这些工具：

| 工具 | 作用 |
|---|---|
| `list_accounts` / `create_account` | 查看/创建账户（credit 自动记为负债） |
| `list_statement_documents` | 查看 Statement Inbox 中待处理的 PDF/CSV；AI 读取原件后自行选择账户 |
| `list_categories` | 分类名列表（AI 分类时用这些名字） |
| `import_transactions` | **核心**：批量写入交易（带符号整数分，+收入/−支出）。自动去重——重叠账单随便重复导入；AI 给的分类会记成商户规则，下次同商户自动分类。可传 `statement_document_id`、`statement_start_date` 和 `statement_end_date`，把文件分配给选定账户、保存真实账期并自动对账；不一致时默认整批回滚 |
| `list_transactions` | 按账户/月份/分类/关键词查询 |
| `set_category` | 修正分类（生成用户规则，可批量应用到同商户） |
| `set_note` | 给交易加备注（账单描述看不出是什么时用） |
| `mark_transfer` | 标记转账（信用卡还款、自转账），不计入支出 |
| `link_transfer_pair` | 把两笔交易配对成同一笔内部转账的两侧（参考 `get_summary` 的配对建议） |
| `link_refund_pair` / `unlink_refund_pair` | 把正数退款/室友分摊款关联到原消费；支持部分退款，冲减原消费月份和分类，不算收入 |
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

- **Dashboard**：财务收件箱（未分类、疑似转账、汇率与投资快照提醒）+ 净资产、月度分类支出、6 个月收支趋势
- **Accounts**：卡片管理
- **Transactions**：筛选、改分类（提示批量应用规则）、标记转账
- **Statements**：上传并本地保存原始 PDF/CSV；待处理文件组成 Statement Inbox。AI 通过 MCP 读取、选择账户，成功导入后自动关联原件。12 个月 coverage 同时表达账单周期与跨月部分：statement 结束所在月算完整 cycle，落在其他日历月的部分显示覆盖天数；日期可在详情中手动修正。页面同时提供余额异常、历史明细与整批撤销
- **Settings**：MCP 接入说明、汇率、备份、商户规则、分类管理、暗色主题

## 数据保障

- 金额全部为**带符号整数分**，无浮点误差
- 非 CAD 账户缺少汇率时，CAD 汇总会明确显示不可用，不会静默按 1:1 计算
- 去重两层：逐行指纹（含同日同额同商户的序号）+ 数据库 UNIQUE 约束
- MCP 写入的每份账单都是一个批次，可在 Statement Center 整体撤销；Undo 不删除原件，文件会回到待处理状态
- 分类规则：你的手动修正（user）永远优先于 AI 写入的规则（ai）

## 技术栈

TypeScript monorepo（npm workspaces）：

| 包 | 内容 |
|---|---|
| `packages/server` | Hono HTTP API（端口 4321）+ MCP server（stdio，`npm run mcp`）+ Node 内置 `node:sqlite` |
| `packages/web` | React 19 + Vite + Recharts，CSS 变量主题（明/暗） |
| `packages/shared` | 共享类型 + zod schema |

数据库：`data/money.db`（`MY_MONEY_DB` 环境变量可改路径）。原始 PDF/CSV 默认保存在数据库同级的
`statements/` 目录，可用 `MY_MONEY_STATEMENTS_DIR` 改路径。账单文件与数据库一样是本地明文财务数据。

备份请在 Settings 点击 **Download full backup**。下载的 ZIP 包含一致的 SQLite 快照、所有已登记
账单原件和恢复说明，运行时下载也安全。手动恢复前必须同时停止 Web 和 MCP server；运行中直接复制
`money.db` 可能漏掉仍在 WAL 中的已提交数据。

完整备份的结构：

```text
my-money-YYYYMMDD-HHmmss.zip
├── money.db
├── statements/
│   ├── <sha256>.pdf
│   └── <sha256>.csv
└── RESTORE.txt
```
