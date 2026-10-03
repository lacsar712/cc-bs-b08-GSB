"""用内存假游标驱动真实 filter.submit_reading，验证：
1. 挡回入账与过滤流水同事务（流水写失败→读数回滚，少一边整题失败）
2. 并发临界提交被 FOR UPDATE 串行化，结果与串行执行一致（至多一笔入队语义）
3. 开关同源：关闭后同类突变读数可入队
"""
import asyncio
import importlib.util
import os
import statistics

spec = importlib.util.spec_from_file_location(
    "filter_under_test", os.path.join(os.path.dirname(__file__), "filter.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
submit_reading = mod.submit_reading

# 先验证真实的中位实现
assert mod._median([150]) == 150
assert mod._median([100, 200]) == 150
assert mod._median([1, 2, 600]) == 2


class FakeDB:
    def __init__(self, fail_log=False):
        self.readings = []  # 已提交读数
        self.logs = []
        self.cfg = {"enabled": True, "window_size": 5, "factor": 3.0}
        self.lock = asyncio.Lock()  # 代理 FOR UPDATE 行锁
        self.next_reading_id = 1
        self.next_log_id = 1
        self.fail_log = fail_log

    def conn(self):
        return FakeConn(self)


class FakeConn:
    def __init__(self, db):
        self.db = db
        self._cur = None
        self.staged_readings = 0
        self.staged_logs = 0
        self.locked = False

    def cursor(self):
        self._cur = FakeCur(self)
        return _ctx(self._cur)

    async def commit(self):
        # 提交：暂存转正，释放配置行锁
        self.staged_readings = 0
        self.staged_logs = 0
        if self.locked:
            self.db.lock.release()
            self.locked = False

    async def rollback(self):
        # 回滚：抹掉本事务写入，流水/读数都不留
        for _ in range(self.staged_readings):
            self.db.readings.pop()
        for _ in range(self.staged_logs):
            self.db.logs.pop()
        self.db.next_reading_id -= self.staged_readings
        self.db.next_log_id -= self.staged_logs
        self.staged_readings = 0
        self.staged_logs = 0
        if self.locked:
            self.db.lock.release()
            self.locked = False


class _ctx:
    def __init__(self, obj):
        self.obj = obj

    async def __aenter__(self):
        return self.obj

    async def __aexit__(self, *a):
        return False


class FakeCur:
    def __init__(self, conn):
        self.conn = conn
        self.db = conn.db
        self._one = None
        self._all = None

    async def execute(self, sql, params=None):
        self._one = None
        self._all = None
        s = " ".join(sql.split())
        if "noise_filter_config" in s and "FOR UPDATE" in s:
            # 真实语义：拿不到行锁即阻塞至前一事务提交/回滚
            await self.db.lock.acquire()
            self.conn.locked = True
            self._one = dict(self.db.cfg)
        elif "FROM strain_readings" in s:
            limit = params[0]
            vals = [
                r["microstrain"]
                for r in reversed(self.db.readings)
                if r["status"] != "blocked"
            ][:limit]
            self._all = [{"microstrain": v} for v in vals]
        elif "INSERT INTO strain_readings" in s:
            (span_code, microstrain, status, verdict, reason, username, _) = params
            rid = self.db.next_reading_id
            self.db.next_reading_id += 1
            row = {
                "id": rid,
                "span_code": span_code,
                "microstrain": microstrain,
                "status": status,
                "verdict": verdict,
                "reason": reason,
                "created_by": username,
                "created_at": "t",
                "processed_at": "t" if status == "blocked" else None,
            }
            self.db.readings.append(row)
            self.conn.staged_readings += 1
            self._one = dict(row)
        elif "INSERT INTO noise_filter_logs" in s:
            if self.db.fail_log:
                raise RuntimeError("模拟流水写入失败")
            log_id = self.db.next_log_id
            self.db.next_log_id += 1
            self.db.logs.append({"id": log_id, "reading_id": params[0]})
            self.conn.staged_logs += 1

    async def fetchone(self):
        return self._one

    async def fetchall(self):
        return self._all or []


async def submit(db, span, val, user="surveyor", expect_fail=False):
    conn = db.conn()
    async with conn.cursor() as cur:
        try:
            res = await submit_reading(cur, span, float(val), user)
        except Exception:
            await conn.rollback()
            if expect_fail:
                return None
            raise
        else:
            await conn.commit()
            return res


def seed(db, vals):
    for v in vals:
        db.readings.append(
            {
                "id": db.next_reading_id,
                "microstrain": float(v),
                "status": "done",
            }
        )
        db.next_reading_id += 1


async def main():
    # --- 1. 开启时极大读数被挡回，读数与流水同时存在 ---
    db = FakeDB()
    seed(db, [150, 151, 149, 150, 152])
    r = await submit(db, "跨中S9", 99999)
    assert r["blocked"] is True, "极大读数应挡回"
    assert r["row"]["status"] == "blocked"
    assert len(db.readings) == 6 and db.readings[-1]["status"] == "blocked"
    assert len(db.logs) == 1 and db.logs[0]["reading_id"] == r["row"]["id"]
    print("T1 开启滤波：极大读数整笔挡回，入账与流水同事务落库 OK")

    # --- 2. 正常读数入队，不写流水 ---
    r = await submit(db, "跨中S9", 160)
    assert r["blocked"] is False and r["row"]["status"] == "pending"
    assert len(db.logs) == 1
    print("T2 开启滤波：正常读数入队且不产生流水 OK")

    # --- 3. 关闭后同类极大读数可入队（同源配置即时生效）---
    db.cfg["enabled"] = False
    r = await submit(db, "跨中S9", 99999)
    assert r["blocked"] is False and r["row"]["status"] == "pending"
    assert len(db.logs) == 1  # 不新增拦截，历史流水保留
    print("T3 关闭滤波：立刻不再拦截，同类读数入队，历史流水保留 OK")

    # --- 4. 流水写失败 → 读数一起回滚（少一边整题失败）---
    db2 = FakeDB(fail_log=True)
    seed(db2, [150, 150, 150, 150, 150])
    before = len(db2.readings)
    r = await submit(db2, "跨中S9", 99999, expect_fail=True)
    assert r is None
    assert len(db2.readings) == before, "挡回读数必须随流水失败一起回滚"
    assert len(db2.logs) == 0
    print("T4 同事务原子性：流水写失败则挡回入账一并回滚 OK")

    # --- 5. 并发临界撞车：与串行结果一致，每笔挡回都有流水，无重复入队 ---
    db3 = FakeDB()
    db3.cfg["window_size"] = 3
    seed(db3, [150, 150, 150])
    # 两笔极端读数几乎同时提交
    ra, rb = await asyncio.gather(
        submit(db3, "跨中S9", 99999),
        submit(db3, "跨中S9", 99998),
    )
    blocked = [x for x in (ra, rb) if x["blocked"]]
    pending = [x for x in (ra, rb) if not x["blocked"]]
    assert len(pending) <= 1, f"临界撞车至多一笔入队，实际 {len(pending)}"
    # 串行参照：两笔都应被挡回（挡回记录不进窗口）
    assert len(blocked) == 2
    assert len(db3.logs) == 2, "每笔挡回必须有流水"
    log_rids = {l["reading_id"] for l in db3.logs}
    blocked_rids = {x["row"]["id"] for x in blocked}
    assert log_rids == blocked_rids
    print("T5 并发临界突变：行锁串行化，至多一笔入队，挡回/流水一一对应 OK")

    # --- 6. 配置翻转与提交并发：每笔事务读到的都是完整一致快照 ---
    db4 = FakeDB()
    seed(db4, [150, 150, 150, 150, 150])

    async def toggle():
        async with db4.lock:  # 代理写配置端点对同一行加锁
            db4.cfg["enabled"] = False
            await asyncio.sleep(0)

    results = await asyncio.gather(
        submit(db4, "跨中S9", 99999),
        toggle(),
    )
    # 无论先后，只可能有两种一致结果，不允许出现"判定开但按关写入"之类撕裂
    r = results[0]
    assert r["blocked"] is True or r["row"]["status"] == "pending"
    if r["blocked"]:
        assert len(db4.logs) == 1
    print("T6 提交与开关翻转并发：事务串行、状态一致 OK")

    print("\nALL TESTS PASSED")


asyncio.run(main())
