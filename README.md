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
        ├── types/{plot,tree,regen,recheck,roundArchive}.ts
        ├── stores/{plot,tree,regen,round}Store.ts
        ├── components/common/{PlotCard,TreeTable,GrowthDiffTable,RoundTag,ArchiveTimeline,SnapshotViewer}.tsx
        ├── hooks/{usePlotFilter,useTreeStats,useArchiveData}.ts
        ├── pages/{PlotList,TreeEntry,RegenView,RecheckView,PlotSummary}.tsx
        └── utils/{db,dbSync,forestCalc,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/plots` | 样地台账：按地点/林型/复查期次/郁闭度区间筛选，显示面积、优势树种、已录样木数，可锁定往期 | Plot |
| `/plots/:id/trees` | 样木录入与清单：径阶分组快速录入、行内改胸径、树种联想、胸径异常提示 | TreeRecord |
| `/plots/:id/regen` | 更新苗与灌木样方记录，按高度级与株数分组合计 | RegenShrub |
| `/plots/:id/recheck` | 复查比对：逐株两期胸径/树高与生长量，标记缺失与状态变化，保存比对结果 | RecheckDiff、TreeRecord |
| `/summary/:plotId` | 林分因子汇总：每公顷株数、平均胸径、断面积、郁闭度、更新密度，可导出调查记录文本 | Plot、TreeRecord、RegenShrub |

`/` 重定向到 `/plots`，未匹配路由同样兜底到 `/plots`。

## 数据存储说明

- 数据库名 `gbforestplot`，当前结构版本 **v3**（`localStorage['gbforestplot:db-version']` 记录）。
- 五张表：`plots`（样地）、`trees`（样木活动行）、`regens`（更新层活动行）、`rechecks`（复查比对活动行）、`rounds`（期次档案）。
- **期次档案（RoundArchive）**：每期一份，状态为「未发布草稿 / 原期已发布 / 修订期已发布」。
  - 发布时在同一事务内把当时的**样木、更新层、复查比对结果**定格进快照，活动行随即收编；已发布档案只读。
  - 修改已发布期必须对该期「以此期修订」：系统从原快照克隆出一份同号修订草稿（标明来源期 `sourceRoundId`），原快照永久保留可查。
  - 「开始下一期」只以**最近一次已发布快照**为底克隆；未发布草稿不会混入。有草稿时禁止再开新期，配合在途锁，连续点击也不会多出期次。
  - 每份档案带乐观锁 `version`：样木/更新层/比对结果的每次写入都在事务内做版本 CAS，两个终端先后提交时后到一方收到冲突提示而不是静默覆盖；标签页之间通过 BroadcastChannel 实时同步。
- v2 → v3 迁移：旧库按「期」为每个样地补齐发布快照，旧 `locked` 状态与历史两期比对结果原样收编进快照，活动行收编后删除（要改旧期走修订流程）。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范样地：FP-4102 第 1 期已发布锁定、第 2 期为在录草稿；FP-4115 第 1 期已发布，便于直接体验复查比对与修订流程。

## 功能要点

- **期次档案**：草稿可改、发布即定格（样木+更新层+复查结果进快照）；已发布期只读，更正走「修订期」并标明来源；下一期只取最近已发布快照；乐观锁 + 在途锁防并发覆盖与重复建期。
- **径阶归组**：按「6/8/12/16/20/24/28/32+」cm 径阶自动归组，表格内联展示各径阶株数。
- **胸径异常提示**：数值超出 0~200 cm 或与本树种同期均值偏离 >60% 时标黄并给出提示。
- **复查比对**：任选上下两期生成逐株差值表，标记「本期未复测（疑似采伐或倒伏）」与「本期新增进界木」，生长率为负或缺失行高亮，并计算保留木生长率。
- **林分因子**：每公顷株数、平均胸径/树高、断面积与每公顷断面积、冠幅折算郁闭度、更新苗/灌木密度。
- **导出**：复查比对结果写入本地档案库；林分汇总可复制或导出调查记录 txt。
