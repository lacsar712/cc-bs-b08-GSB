# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

顶栏可进入 **噪声滤波** 专页：异常噪声滤波可开关，开启后服务端对突变超过"最近窗口中位数 × 倍数"的新报送读数整笔挡回（不入处理队列）；挡回入账与过滤流水同事务落库。关闭后立即不再新增拦截，已有流水保留。

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

## 异常噪声滤波

| 项 | 说明 |
|----|------|
| 入口 | 顶栏「噪声滤波」按钮，按钮上的灯与专页灯位同源 |
| 配置 | 开关（默认关）、窗口长度（默认 10 笔）、过滤倍数（默认 ×3） |
| 判定 | `abs(新读数 − 窗口中位) > 窗口中位 × 倍数`，窗口取最近 N 笔**未挡回**读数；窗口为空（如首笔）不拦截 |
| 挡回 | 读数以 `status=blocked`、结论「已挡回」落库，工人不认领；接口返回 **202** |
| 关闭 | PUT 置 `enabled=false` 后下一笔提交即不再拦截；`noise_filter_logs` 历史流水保留 |
| 权限 | 仅测量员（writer）可改配置；复核员（reader）专页控件禁用，PUT 返回 403 |

一致性要点：

- 配置只有库内一行（`noise_filter_config` 单行表），滤波判定、写口、专页开关灯全部现读该行，无缓存。
- 挡回的读数入账与 `noise_filter_logs` 流水写入在**同一事务**，任一失败整笔回滚。
- 提交事务先对配置行 `SELECT … FOR UPDATE`，并发临界突变被串行化，至多一笔入队；挡回记录不进窗口，连发极端读数都会逐笔挡回。

接口：

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/noise-filter/config` | 登录 | 读开关/窗口/倍数（灯位同源） |
| PUT | `/api/noise-filter/config` | 测量员 | 改 `enabled` / `window_size` / `factor` |
| GET | `/api/noise-filter/logs` | 登录 | 最近 200 条挡回流水 |

挡回时 `POST /api/readings` 返回示例：

```json
{"status": "blocked", "verdict": "已挡回",
 "reason": "异常噪声：突变 99849.0 超过窗口中位 150.0 的 3.0 倍",
 "message": "读数突变超过窗口中位若干倍，已被噪声滤波整笔挡回"}
```

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
