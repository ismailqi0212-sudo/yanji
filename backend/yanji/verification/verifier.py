"""可替换的提交前验证钩子；默认实现不代表金融判断已正确。"""

from ..common import AppError


class NoopVerifier:
    """执行流水线调用；默认放行，确定性业务校验仍由各业务模块执行。"""

    async def verify(self, observation, context):
        return {"accepted": True}


class VerificationRejected(AppError):
    def __init__(self, reason="验证未通过"):
        super().__init__(reason, code="VERIFICATION_REJECTED")
