"""异常噪声滤波：同一事务内完成"配置同源读取 → 窗口中位判定 → 入队或挡回+流水"。

并发约束：临界突变两笔几乎同时到达时，先对 noise_filter_config 单行取
FOR UPDATE 行锁，把两个提交串行化，使至多一笔入队。
"""


def _median(values):
    vals = sorted(values)
    n = len(vals)
    mid = n // 2
    if n % 2 == 1:
        return float(vals[mid])
    return (float(vals[mid - 1]) + float(vals[mid])) / 2.0


async def submit_reading(cur, span_code: str, microstrain: float, username: str) -> dict:
    """在调用方给定的事务/游标内提交一笔读数。

    返回 {"row": ..., "blocked": bool, "config": ...}。任一步失败抛出异常，
    由调用方 ROLLBACK，保证"挡回入账 + 过滤流水"少一边整题失败。
    """
    # 1) 锁配置行：滤波判定、写口、专页开关灯同源；FOR UPDATE 串行化并发提交
    await cur.execute(
        """
        SELECT enabled, window_size, factor
        FROM noise_filter_config
        WHERE id = 1
        FOR UPDATE
        """
    )
    cfg = await cur.fetchone()
    enabled = bool(cfg["enabled"])
    window_size = int(cfg["window_size"])
    factor = float(cfg["factor"])

    decision = None
    if enabled:
        # 窗口中位取最近 N 笔"已正常入账"的读数（排除挡回记录，避免被污染）
        await cur.execute(
            """
            SELECT microstrain
            FROM strain_readings
            WHERE status <> 'blocked'
            ORDER BY id DESC
            LIMIT %s
            """,
            (window_size,),
        )
        history = [float(r["microstrain"]) for r in await cur.fetchall()]
        if history:
            median = _median(history)
            deviation = abs(microstrain - median)
            threshold = median * factor
            if median > 0 and deviation > threshold:
                decision = {
                    "median": median,
                    "deviation": deviation,
                    "threshold": threshold,
                }

    # 2) 写入读数主表（挡回则 blocked，正常则 pending 入队）
    blocked = decision is not None
    status = "blocked" if blocked else "pending"
    reason = None
    if blocked:
        reason = (
            "异常噪声：突变 {:.1f} 超过窗口中位 {:.1f} 的 {:.1f} 倍".format(
                decision["deviation"], decision["median"], factor
            )
        )
    await cur.execute(
        """
        INSERT INTO strain_readings
            (span_code, microstrain, status, verdict, reason,
             created_by, created_at, processed_at)
        VALUES (%s, %s, %s, %s, %s, %s, now(),
                CASE WHEN %s = 'blocked' THEN now() END)
        RETURNING id, span_code, microstrain, verdict, reason, status,
                  created_by, created_at, processed_at
        """,
        (
            span_code,
            microstrain,
            status,
            "已挡回" if blocked else None,
            reason,
            username,
            status,
        ),
    )
    row = await cur.fetchone()

    # 3) 挡回：同一事务追加过滤流水，与挡回入账共生死
    if blocked:
        await cur.execute(
            """
            INSERT INTO noise_filter_logs
                (reading_id, span_code, microstrain, median, deviation,
                 threshold, window_size, factor, reason, created_by, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
            """,
            (
                row["id"],
                span_code,
                microstrain,
                decision["median"],
                decision["deviation"],
                decision["threshold"],
                window_size,
                factor,
                reason,
                username,
            ),
        )

    return {
        "row": row,
        "blocked": blocked,
        "config": {
            "enabled": enabled,
            "window_size": window_size,
            "factor": factor,
        },
    }
