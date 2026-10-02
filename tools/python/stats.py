"""Descriptive statistics tool.

Packaged into execution images and invoked with JSON on stdin; writes JSON to stdout.
Uses only the Python standard library so the toolchain is reproducible.
"""

from __future__ import annotations

import json
import math
import statistics
import sys

MAX_VALUES = 100_000


def describe(values: list[float]) -> dict[str, float | int | None]:
    count = len(values)
    ordered = sorted(values)
    quartiles = statistics.quantiles(ordered, n=4, method="inclusive") if count >= 2 else [ordered[0]] * 3
    return {
        "count": count,
        "mean": statistics.fmean(ordered),
        "median": statistics.median(ordered),
        "stdev": statistics.stdev(ordered) if count >= 2 else None,
        "min": ordered[0],
        "max": ordered[-1],
        "p25": quartiles[0],
        "p75": quartiles[2],
        "sum": math.fsum(ordered),
    }


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except json.JSONDecodeError:
        print("input must be JSON", file=sys.stderr)
        return 2
    values = request.get("values") if isinstance(request, dict) else None
    if not isinstance(values, list) or not values or len(values) > MAX_VALUES:
        print(f"values must be a non-empty list of at most {MAX_VALUES} numbers", file=sys.stderr)
        return 2
    numbers: list[float] = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            print("values must contain only finite numbers", file=sys.stderr)
            return 2
        numbers.append(float(value))
    result = {"label": request.get("label"), "python": sys.version.split()[0], **describe(numbers)}
    json.dump(result, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
