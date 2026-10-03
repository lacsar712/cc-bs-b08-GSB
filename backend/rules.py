"""桥梁微应变判定：80～220 με 为合格，否则越界。"""

from statistics import median


def judge_microstrain(microstrain: float) -> tuple[str, str]:
    if 80 <= microstrain <= 220:
        return "合格", "微应变处于 80～220 με 设计允许范围内"
    if microstrain < 80:
        return "越界", "微应变低于 80 με 设计下限"
    return "越界", "微应变高于 220 με 设计上限"


def median_of(values: list[float]) -> float | None:
    """最近窗口读数的中位数；窗口为空时返回 None（不拦截）。"""
    if not values:
        return None
    return float(median(values))


def is_abrupt_spike(
    microstrain: float,
    baseline: float | None,
    threshold_multiplier: float,
) -> tuple[bool, float | None, float | None]:
    """
    判定新读数相对窗口中位是否构成突变噪声。

    突变定义为偏差超过“窗口中位数的若干倍”：|x - median| > multiplier * median。
    基线为空（窗口内尚无已入账读数）时不拦截，返回 (False, None, None)。
    """
    if baseline is None:
        return False, None, None
    deviation = abs(microstrain - baseline)
    limit = threshold_multiplier * baseline
    if limit <= 0:
        return False, deviation, limit
    return deviation > limit, deviation, limit
