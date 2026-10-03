import os
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty
from filter import submit_reading

SECRET = os.environ.get("JWT_SECRET", "bridge-strain-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "surveyor": {"role": "writer", "password_hash": pwd.hash("surv123456")},
    "reviewer": {"role": "reader", "password_hash": pwd.hash("rev123456")},
}

app = Sanic("bridge-strain-shift")


def _auth_header(request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def _require_user(request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        return None
    return user


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


@app.before_server_start
async def setup(_app, _loop):
    pool = await create_pool()
    _app.ctx.pool = pool
    await ensure_schema(pool)
    await seed_if_empty(pool)


@app.after_server_stop
async def teardown(_app, _loop):
    pool = _app.ctx.pool
    if pool:
        await pool.close()


@app.get("/api/health")
async def health(_request):
    return sanic_json({"status": "ok", "service": "bridge-strain-shift"})


@app.post("/api/auth/login")
async def login(request):
    body = request.json or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        return sanic_json({"detail": "用户名或密码错误"}, status=401)
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return sanic_json(
        {"access_token": token, "username": username, "role": user["role"]}
    )


@app.get("/api/readings")
async def list_readings(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, span_code, microstrain, verdict, reason, status,
                       created_by, created_at, processed_at
                FROM strain_readings
                ORDER BY id DESC
                """
            )
            rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "span_code": r["span_code"],
                "microstrain": r["microstrain"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": _iso(r["created_at"]),
                "processed_at": _iso(r["processed_at"]),
            }
        )
    return sanic_json(out)


@app.post("/api/readings")
async def create_reading(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可提交应变读数"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    try:
        microstrain = float(body.get("microstrain"))
    except (TypeError, ValueError):
        return sanic_json({"detail": "微应变必须是数字"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            # 配置读取、突变判定、入队/挡回+流水全部在同一事务内
            try:
                result = await submit_reading(
                    cur, span_code, microstrain, user["username"]
                )
            except Exception as exc:  # 少一边即整题失败
                await conn.rollback()
                raise
            row = result["row"]
            blocked = result["blocked"]
        await conn.commit()

    payload = {
        "id": row["id"],
        "span_code": row["span_code"],
        "microstrain": row["microstrain"],
        "verdict": row["verdict"],
        "reason": row["reason"],
        "status": row["status"],
        "created_by": row["created_by"],
        "created_at": _iso(row["created_at"]),
        "processed_at": _iso(row["processed_at"]),
    }
    if blocked:
        payload["message"] = "读数突变超过窗口中位若干倍，已被噪声滤波整笔挡回"
        return sanic_json(payload, status=202)
    payload["message"] = "已入队，后台工人将认领并判定"
    return sanic_json(payload, status=201)


@app.get("/api/noise-filter/config")
async def get_noise_filter_config(request):
    # 开关灯与提交口判定同源：直接读库内唯一配置行，不做缓存
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT enabled, window_size, factor, updated_by, updated_at
                FROM noise_filter_config WHERE id = 1
                """
            )
            cfg = await cur.fetchone()
    return sanic_json(
        {
            "enabled": cfg["enabled"],
            "window_size": cfg["window_size"],
            "factor": cfg["factor"],
            "updated_by": cfg["updated_by"],
            "updated_at": _iso(cfg["updated_at"]),
        }
    )


@app.put("/api/noise-filter/config")
async def update_noise_filter_config(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    # 复核员只读，不能改开关与参数
    if user["role"] != "writer":
        return sanic_json({"detail": "仅测量员可修改噪声滤波配置"}, status=403)

    body = request.json or {}
    fields = {}
    if "enabled" in body:
        if not isinstance(body["enabled"], bool):
            return sanic_json({"detail": "enabled 必须是布尔值"}, status=400)
        fields["enabled"] = body["enabled"]
    if "window_size" in body:
        try:
            window_size = int(body["window_size"])
        except (TypeError, ValueError):
            return sanic_json({"detail": "窗口长度必须是正整数"}, status=400)
        if window_size <= 0:
            return sanic_json({"detail": "窗口长度必须是正整数"}, status=400)
        fields["window_size"] = window_size
    if "factor" in body:
        try:
            factor = float(body["factor"])
        except (TypeError, ValueError):
            return sanic_json({"detail": "过滤倍数必须是正数"}, status=400)
        if factor <= 0:
            return sanic_json({"detail": "过滤倍数必须是正数"}, status=400)
        fields["factor"] = factor
    if not fields:
        return sanic_json({"detail": "没有需要更新的字段"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            sets = ", ".join(f"{k} = %s" for k in fields)
            params = list(fields.values())
            params.append(user["username"])
            await cur.execute(
                f"""
                UPDATE noise_filter_config
                SET {sets}, updated_by = %s, updated_at = now()
                WHERE id = 1
                RETURNING enabled, window_size, factor, updated_by, updated_at
                """,
                params,
            )
            cfg = await cur.fetchone()
        await conn.commit()
    return sanic_json(
        {
            "enabled": cfg["enabled"],
            "window_size": cfg["window_size"],
            "factor": cfg["factor"],
            "updated_by": cfg["updated_by"],
            "updated_at": _iso(cfg["updated_at"]),
        }
    )


@app.get("/api/noise-filter/logs")
async def list_noise_filter_logs(request):
    # 过滤流水保留：关闭滤波后历史流水仍可查
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, reading_id, span_code, microstrain, median, deviation,
                       threshold, window_size, factor, reason, created_by, created_at
                FROM noise_filter_logs
                ORDER BY id DESC
                LIMIT 200
                """
            )
            rows = await cur.fetchall()
    out = [
        {
            "id": r["id"],
            "reading_id": r["reading_id"],
            "span_code": r["span_code"],
            "microstrain": r["microstrain"],
            "median": r["median"],
            "deviation": r["deviation"],
            "threshold": r["threshold"],
            "window_size": r["window_size"],
            "factor": r["factor"],
            "reason": r["reason"],
            "created_by": r["created_by"],
            "created_at": _iso(r["created_at"]),
        }
        for r in rows
    ]
    return sanic_json(out)
