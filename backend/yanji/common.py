"""全项目共用的小工具；不调用模型，也不持有数据库。"""

import copy
import json
import math
from datetime import datetime, timezone
from uuid import uuid4


def uid():
    return str(uuid4())


def now():
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def clone(value):
    return copy.deepcopy(value)


def dumps(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def finite(value):
    # Python 的 bool 是 int 的子类，但财务输入不能把 True 当成 1。
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def unique(values):
    return list(dict.fromkeys(values))


class AppError(Exception):
    """业务层给 HTTP/Agent 的可读错误；不在这里决定是否重试。"""

    def __init__(self, message, status=400, code="ERROR"):
        super().__init__(message)
        self.status, self.code = status, code


def error_data(error):
    return {"code": getattr(error, "code", type(error).__name__), "message": str(error)}
