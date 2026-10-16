from app.core.errors import DomainError


class AiGatewayError(DomainError):
    def __init__(
        self, detail: str, *, code: str, status: int = 409, context: dict | None = None
    ) -> None:
        super().__init__(status, code, detail, context)


def provider_status(code: str) -> int:
    return {
        "ai_invalid_credentials": 401,
        "ai_rate_limited": 429,
        "ai_provider_unavailable": 503,
        "ai_timeout": 504,
        "ai_subscription_limit": 429,
        "ai_subscription_auth_required": 401,
        "ai_subscription_cli_missing": 409,
        "ai_subscription_unavailable": 503,
        "ai_subscription_timeout": 504,
    }.get(code, 502)
