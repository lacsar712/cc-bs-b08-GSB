import os

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from rules import judge_microstrain

DSN = os.environ.get(
    "DATABASE_URL", "postgresql://app:app@localhost:54398/bridgestrain"
)

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS strain_readings (
    id serial PRIMARY KEY,
    span_code text NOT NULL,
    microstrain double precision NOT NULL,
    verdict text,
    reason text,
    status text NOT NULL DEFAULT 'pending',
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_strain_readings_status ON strain_readings (status, id);

-- 异常噪声滤波配置：全表单行（id = 1），是开关灯 / 判定 / 写口的唯一真源。
CREATE TABLE IF NOT EXISTS filter_settings (
    id smallint PRIMARY KEY DEFAULT 1,
    enabled boolean NOT NULL DEFAULT false,
    window_size integer NOT NULL DEFAULT 5,
    threshold_multiplier double precision NOT NULL DEFAULT 3.0,
    updated_by text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT filter_settings_singleton CHECK (id = 1)
);
INSERT INTO filter_settings (id, enabled, window_size, threshold_multiplier)
VALUES (1, false, 5, 3.0)
ON CONFLICT (id) DO NOTHING;

-- 噪声过滤流水：每一笔挡回都与入账在同一事务落库。
CREATE TABLE IF NOT EXISTS filter_log (
    id serial PRIMARY KEY,
    reading_id integer NOT NULL REFERENCES strain_readings(id),
    span_code text NOT NULL,
    microstrain double precision NOT NULL,
    baseline_median double precision,
    deviation double precision,
    threshold_multiplier double precision NOT NULL,
    window_size integer NOT NULL,
    reason text NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_filter_log_reading ON filter_log (reading_id);
"""


async def create_pool() -> AsyncConnectionPool:
    pool = AsyncConnectionPool(
        conninfo=DSN,
        min_size=1,
        max_size=5,
        kwargs={"row_factory": dict_row},
        open=False,
    )
    await pool.open()
    return pool


async def ensure_schema(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        await conn.execute(SCHEMA_SQL)
        await conn.commit()


async def seed_if_empty(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT COUNT(*) AS n FROM strain_readings")
            row = await cur.fetchone()
            if row["n"] > 0:
                return
            samples = [
                ("跨中S1", 150.0),
                ("支座S2", 40.0),
            ]
            for span_code, microstrain in samples:
                verdict, reason = judge_microstrain(microstrain)
                await cur.execute(
                    """
                    INSERT INTO strain_readings
                        (span_code, microstrain, verdict, reason, status, created_by, processed_at)
                    VALUES (%s, %s, %s, %s, 'done', 'surveyor', now())
                    """,
                    (span_code, microstrain, verdict, reason),
                )
        await conn.commit()


def connect_sync():
    import psycopg

    return psycopg.connect(DSN, row_factory=dict_row)


def ensure_schema_sync(conn) -> None:
    conn.execute(SCHEMA_SQL)


def seed_if_empty_sync(conn) -> None:
    row = conn.execute("SELECT COUNT(*) AS n FROM strain_readings").fetchone()
    if row["n"] > 0:
        return
    samples = [
        ("跨中S1", 150.0),
        ("支座S2", 40.0),
    ]
    for span_code, microstrain in samples:
        verdict, reason = judge_microstrain(microstrain)
        conn.execute(
            """
            INSERT INTO strain_readings
                (span_code, microstrain, verdict, reason, status, created_by, processed_at)
            VALUES (%s, %s, %s, %s, 'done', 'surveyor', now())
            """,
            (span_code, microstrain, verdict, reason),
        )
    conn.commit()
