"""用重构前Node实现生成的固定样本核对Python结果，不依赖在线数据。"""

import json
from pathlib import Path
import pytest
from yanji.tools.documents import calculate
from yanji.tools.finance import normalize_symbol
from yanji.research.artifacts import scenario_result
from yanji.research.metrics import align_operating_facts
from yanji.agent.router import resolve_source_policy

CASES = json.loads((Path(__file__).parent / "fixtures/node_baseline.json").read_text())
FUNCTIONS = dict(
    symbol=normalize_symbol,
    calculate=calculate,
    scenario=scenario_result,
    align=align_operating_facts,
    source=lambda i: resolve_source_policy(
        {"documents": [{}] if i["docs"] else []}, i["question"]
    ),
)


def equivalent(actual, expected):
    if isinstance(expected, dict):
        assert set(actual) == set(expected)
        for key in expected:
            equivalent(actual[key], expected[key])
    elif isinstance(expected, list):
        assert len(actual) == len(expected)
        for a, e in zip(actual, expected):
            equivalent(a, e)
    elif isinstance(expected, (float, int)) and not isinstance(expected, bool):
        assert actual == pytest.approx(expected, rel=1e-11, abs=1e-10)
    else:
        assert actual == expected


@pytest.mark.parametrize(
    "case", CASES, ids=lambda c: c["kind"] + ":" + str(c["input"])[:80]
)
def test_node_python_parity(case):
    if "error" in case:
        with pytest.raises(Exception):
            FUNCTIONS[case["kind"]](case["input"])
    else:
        equivalent(FUNCTIONS[case["kind"]](case["input"]), case["expected"])
