from typing import Any


class DomainError(Exception):
    def __init__(
        self, status_code: int, code: str, detail: str, context: dict[str, Any] | None = None
    ):
        super().__init__(detail)
        self.status_code = status_code
        self.status = status_code
        self.code = code
        self.detail = detail
        self.context = context or {}


class ProjectDomainError(DomainError):
    def __init__(
        self, detail: str, *, status: int, code: str, context: dict[str, Any] | None = None
    ):
        super().__init__(status, code, detail, context)


def not_found(detail: str = "Объект не найден") -> DomainError:
    return DomainError(404, "not_found", detail)
