# sologsb-1121 森林样地调查记录台（gbforestplot）

面向森林资源调查员的固定样地工作台：为样地建档，逐株记录胸径、树高、枝下高与检尺位置，登记更新幼苗与灌木层，并在复查期与上一期数据逐株比对生长量、计算林分因子。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21821**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | Ant Design 5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 本地存储 | IndexedDB（Dexie 4），含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1121/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── index.css
        ├── router/index.tsx
        ├── types/{plot,tree,regen,recheck,archive}.ts
        ├── stores/{plot,tree,regen,archive}Store.ts
        ├── components/common/{PlotCard,TreeTable,GrowthDiffTable,RoundTag}.tsx
        ├── hooks/{usePlotFilter,useTreeStats}.ts
        ├── pages/{PlotList,TreeEntry,RegenView,RecheckView,PlotSummary,RoundArchives}.tsx
        ├── scripts/verify-{archives,migration,concurrent}.ts
        └── utils/{db,forestCalc,id,recheck,roundData,stats}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/plots` | 样地台账：按地点/林型/复查期次/郁闭度区间筛选，显示面积、优势树种、已录样木数，可锁定往期 | Plot、RoundArchive |
| `/plots/:id/trees` | 样木录入与清单：径阶分组快速录入、行内改胸径、树种联想、胸径异常提示；已发布期只读 | RoundArchive、TreeRecord |
| `/plots/:id/regen` | 更新苗与灌木样方记录，按高度级与株数分组合计；已发布期只读 | RoundArchive、RegenShrub |
| `/plots/:id/recheck` | 复查比对：逐株两期胸径/树高与生长量，标记缺失与状态变化，保存/冻结比对结果 | RoundArchive、RecheckDiff、TreeRecord |
| `/plots/:id/archives` | 期次档案：发布当期、新开下一期、从已发布期生成修订期、查看任意期冻结快照 | RoundArchive |
| `/summary/:plotId` | 林分因子汇总：按期次切换，每公顷株数、平均胸径、断面积、郁闭度、更新密度，可导出调查记录文本 | RoundArchive、TreeRecord、RegenShrub |

`/` 重定向到 `/plots`，未匹配路由同样兜底到 `/plots`。

## 数据存储说明

- 数据库名 `gbforestplot`，当前结构版本 **v3**（`localStorage['gbforestplot:db-version']` 记录）。
- 五张表：`plots`（样地）、`trees`（样木，按期次分行）、`regens`（更新苗与灌木样方）、`rechecks`（复查逐株比对）、`archives`（期次档案，`&[plotId+round]` 唯一）。
- v1 → v2 迁移：为老样地补 `locked`、`surveyRound`，为老样木补 `round`、`measuredAt`，并新增索引。
- v2 → v3 迁移：按历史轮次为每个样地补齐**已发布**期次快照（样木、更新层、按 `targetRound` 归集的两期比对结果、样地元信息与原 `locked` 状态）；只有当前期完全无数据时才补空草稿。原 `trees/regens/rechecks` 行原样保留。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范样地、11 条样木（含第 1/2 两期，便于直接做复查比对）、4 条样方记录，以及第 1/2 期已发布档案（第 2 期带冻结的复查比对）。

## 期次档案（发布 / 修订 / 追溯）

每期每个样地有一条 `RoundArchive`：

- **草稿（draft）**：新开下一期或生成修订期时产生，可继续录入、删除、重算复查；**不参与**「最近一次已发布快照」取值，页面明确标黄。
- **已发布（published）**：发布动作在一个读写事务里冻结当时的样木、更新层、复查逐株结果与样地元信息（含原锁定状态），此后只读；store 层对已发布期的增改删直接抛错。
- **新开下一期**：只以**最近一次已发布快照**为底稿拷贝工作行（采伐木不延续）；未发布草稿绝不混入。已有草稿时再点直接复用同一条。
- **修订**：对已发布期的更正只能「生成修订期」——从该期快照复制出新期号草稿，档案上记录 `sourceRound / sourceArchiveId`，原快照永久可查、逐页标注「修订自第 N 期」。
- **并发与连点**：所有动作都有单飞锁（按钮同时 loading 禁用）+ IndexedDB 事务内复查 + `&[plotId+round]` 唯一索引三重保障；连点或两个终端先后提交都只会得到同一期，不会多期、不会互相覆盖。发布对已发布期幂等，重放返回原快照。

逻辑校验脚本（fake-indexeddb，无需浏览器）：

```bash
npm run verify            # 依次跑：发布冻结 / v2→v3 迁移 / 两终端并发
```

## 功能要点

- **径阶归组**：按「6/8/12/16/20/24/28/32+」cm 径阶自动归组，表格内联展示各径阶株数。
- **胸径异常提示**：数值超出 0~200 cm 或与本树种同期均值偏离 >60% 时标黄并给出提示。
- **复查比对**：任选上下两期生成逐株差值表，标记「本期未复测（疑似采伐或倒伏）」与「本期新增进界木」，生长率为负或缺失行高亮，并计算保留木生长率。
- **林分因子**：每公顷株数、平均胸径/树高、断面积与每公顷断面积、冠幅折算郁闭度、更新苗/灌木密度。
- **导出**：复查比对结果写入本地档案库；林分汇总可复制或导出调查记录 txt。
