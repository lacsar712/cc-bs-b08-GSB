# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

## 异常噪声滤波（可开关）

顶栏「噪声滤波」进入专页，含**开关、窗口长度、阈值倍数、过滤流水**，顶栏与专页各有一盏同源状态灯。

- 开启后，服务端对同跨段最近 **窗口长度** 笔已入账读数取**中位数**；新读数偏差 `|x - median|` 超过 `阈值倍数 × median` 时**整笔挡回**：读数以 `status='blocked'`、结论「异常噪声」入账，并写入过滤流水。
- 挡回的**入账与流水在同一数据库事务**落库，任一失败整笔回滚。
- 关闭后**立即不再新增拦截**，已有流水保留；`blocked` 读数不会进入后台工人队列。
- 滤波判定、写口、专页开关灯**同源**读取单行配置表 `filter_settings`，提交口以 `SELECT … FOR UPDATE` 锁定该行，既取配置又把临界并发提交串行化（两笔突变同时撞车至多一笔入队）。
- **复核员只读**：可读列表与流水，开关与参数修改一律 403；仅测量员可改。

| 接口 | 方法 | 权限 | 说明 |
|------|------|------|------|
| `/api/filter/settings` | GET | 登录 | 读取开关/窗口/倍数（同源真源） |
| `/api/filter/settings` | PUT | 测量员 | 更新开关、`window_size`(1~200)、`threshold_multiplier`(>0) |
| `/api/filter/logs` | GET | 登录 | 过滤流水（最近 200 条） |

突变读数提交被挡回时返回 `202` 且 `blocked:true`；正常入队返回 `201`。

## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python Sanic + psycopg（异步连接池） |
| 工人 | `worker.py`（psycopg 同步，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Mithril.js + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3198 |
| 接口 | http://localhost:8198 |
| PostgreSQL | localhost:54398（库名 `bridgestrain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| surveyor | surv123456 | 测量员，可提交读数 |
| reviewer | rev123456 | 复核员，只读列表 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

## 种子数据

| 跨段 | 微应变 | 结论 |
|------|--------|------|
| 跨中S1 | 150 με | 合格 |
| 支座S2 | 40 με | 越界 |

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
