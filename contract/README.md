# Контракт API

Источник истины — `openapi.json`, его генерирует бэкенд (`python backend/scripts/export_contract.py`). TS-типы: `npx openapi-typescript contract/openapi.json -o contract/api-types.ts`.

## Соглашения
- Префикс `/api`, JSON, время — UTC ISO-8601, id — UUID-строки.
- Ошибка: `{"detail": "<по-русски>", "code": "<snake_code>", "context": {}}`.
- Прогресс задач — опрос `GET /jobs/{id}` раз в ~1 с. Новые карточки во время генерации — `GET /decks/{id}/items?since=<next_since>` раз в 3–5 с.
- `POST /runs` идемпотентен по `id`, который генерирует клиент: повторная отправка возвращает 200 и не удваивает статистику.
- `settings.pace` принимает строку интерфейса (`calm`, `normal`, `fast`, `custom:8`) или положительное число. `lives: null` и `lives: 0` означают забег без ограничения жизней.

## Коды ошибок
| code | HTTP | Когда |
|---|---|---|
| `validation_error` | 422 | Тело или параметры не прошли валидацию FastAPI; `context.errors` |
| `not_found` | 404 | Колода, карточка, забег или задача не найдены |
| `frontend_not_built` | 404 | Интерфейс не собран; запуск через Study Surfers.cmd |
| `http_error` | 4xx | HTTP-запрос не может быть выполнен |
| `untrusted_host` | 403 | Host не является loopback или явно настроенным `SS_PUBLIC_HOST` |
| `request_origin_forbidden` | 403 | Запрос к API пришёл со сторонней веб-страницы |
| `item_invalid` | 422 | Правка карточки нарушает правила; `context.issues[]` |
| `import_empty` | 422 | Нет ни файлов, ни текста |
| `import_too_large` | 413 | Превышен лимит запроса, числа файлов, размера документа/распакованного содержимого или таблицы |
| `import_unsupported_type` | 415 | Неподдерживаемый формат; для `.doc` — подсказка сохранить как DOCX |
| `import_file_invalid` | 422 | Повреждённый документ или нечитаемая кодировка; `context.filename` |
| `import_pdf_password` | 422 | PDF защищён паролем; нужно загрузить копию без пароля |
| `import_question_limit` | 422 | Более 400 вопросов в одном импорте |
| `import_no_questions` | 422 | Не найдены вопросы или учебный материал; также ошибка задачи |
| `ai_operation_limit` | 409 | Фактический расход операции достиг лимита; следующий вызов запрещён |
| `ai_model_not_configured` | 409 | Роль `generate` не разрешается в модель |
| `job_state_conflict` | 409 | Действие с задачей недопустимо в её состоянии |
| `run_invalid` | 422 | Карточка забега не из этой колоды |
| `deck_file_invalid` | 422 | Файл колоды не прошёл проверку; `context.errors` |
| `deck_file_version_unsupported` | 422 | Неизвестная версия формата колоды |
| `flashcards_file_invalid` | 422 | Пакет Anki повреждён, без коллекции или таблица пустая |
| `flashcards_too_many` | 422 | В файле флеш-карточек больше 20 000 заметок либо слишком много служебных записей |
| `flashcards_nothing` | 422 | Импорт флеш-карточек: ни одна карточка не подошла |
| `tentex_not_found` | 404 | Не найдена папка или БД Tentex |
| `tentex_running` | 409 | Tentex запущен (есть WAL); повторить с `?force=true` |
| `tentex_secret_missing` | 409 | Нет ключа шифрования Tentex |
| `tentex_secret_mismatch` | 409 | Ключ Tentex не подходит к сохранённым ключам провайдеров |
| `tentex_project_not_found` | 404 | Проект Tentex не найден |
| `tentex_project_empty` | 422 | В проекте нет вопросов |
| `tentex_provider_not_found` | 404 | Запрошенное подключение Tentex не найдено |
| `tentex_database_invalid` | 422 | Повреждённая структура БД, неверный UUID или цикл программы |
| `import_too_many_questions` | 422 | Более 400 вопросов при импорте Tentex |

ИИ-ошибки — коды Tentex (`backend/app/ai/provider.py` `normalize_provider_error`): `ai_invalid_credentials`, `ai_rate_limited`, `ai_provider_unavailable`, `ai_timeout`, `ai_request_rejected`, `ai_empty_response`, `ai_invalid_structured_output`, `ai_operation_limit`. HTTP-статусы — как в Tentex. Бэкенд дополняет таблицу по мере реализации.

## Настройки и транспорт ИИ (B3)

| code | HTTP | Когда |
|---|---|---|
| `ai_disabled`, `ai_role_disabled` | 409 | ИИ или функция выключены |
| `ai_credentials_missing`, `ai_connection_not_configured` | 409 | Для облачного подключения нет ключа или адреса |
| `ai_provider_in_use`, `ai_model_in_use` | 409 | Подключение или модель используется в настройках |
| `ai_provider_label_exists` | 409 | Имя подключения уже занято |
| `ai_provider_not_found`, `ai_role_not_found` | 404 | Подключение или роль не найдены |
| `ai_base_url_invalid`, `ai_base_url_credentials_forbidden`, `ai_base_url_https_required` | 422 | Неверный адрес, ключ в URL или HTTP для облака |
| `ai_credentials_empty` | 422 | Попытка сохранить пустой ключ |
| `ai_fx_snapshot_incomplete` | 422 | Курс и дата курса должны задаваться вместе |
| `ai_model_not_in_catalog`, `ai_model_modality_unsupported` | 422 | Модели нет в каталоге или она не поддерживает текст |
| `ai_model_override_forbidden` | 409 | Роль не допускает переопределение модели |
| `ai_role_selection_incomplete`, `ai_role_parameters_invalid` | 422 | Неполная пара провайдер/модель или неверные параметры |
| `ai_response_schema_missing` | 422 | Для запроса не заданы роль, сообщения или схема |
| `ai_invalid_credentials` | 401 | Провайдер отверг ключ |
| `ai_rate_limited` | 429 | Лимит запросов провайдера |
| `ai_provider_unavailable` | 503 | Провайдер временно недоступен |
| `ai_timeout` | 504 | Истёк таймаут |
| `ai_empty_response`, `ai_request_rejected`, `ai_invalid_structured_output` | 502 | Пустой ответ, отклонённый запрос или некорректный JSON |
| `ai_secret_invalid`, `ai_secret_mismatch` | 500 | Ключ установки повреждён или не подходит |

`GET /settings/ai` сохраняет форму Tentex с `default_speech: null`, `chat_preset: null`.
Секреты в HTTP не возвращаются. Для LM Studio/Ollama ключ не нужен. Сработавший
режим `json_schema` → `json_object` → `prompt` сохраняется для каждой модели.

## Генерация и задачи (B5)

`POST /imports/quick` принимает оба имени multipart-поля: `files[]` и `files`.
Обычный импорт возвращает 202 `{deck_id, job_id}`; `dry_run=true` — 200
с документами, их ролями и вопросами, без генерации карточек. Без модели генерации
обычный импорт сразу отвечает 409 `ai_model_not_configured` и не создаёт колоду.

После отмены и рестарта готовые карточки сохраняются. `resume` работает для
`cancelled`, `interrupted`, `failed`; `confirm` — для `awaiting_confirm`.
`generation_empty` и `generation_failed` встречаются в `Job.error`, а не как HTTP-ошибки.
`questions_without_answer`, `quote_downgraded`, `pdf_no_text_layer` — предупреждения.
Быстрый импорт принимает также исходники Typst (`.typ`) и LaTeX (`.tex`).
Заголовки исходников используются для разделения материала; формулы Typst сохраняются
дословно в блоках `typst` и переводятся моделью в LaTeX при генерации карточек.
Документы не компилируются: внешние файлы не подтягиваются, пользовательские команды
не исполняются. Такие зависимости вызывают `source_requires_review`.

Проблемы чтения возвращаются в `warnings`: `pdf_no_text_layer` (текста нет),
`pdf_text_incomplete` (мало текста или большая картинка на странице),
`document_no_text` (пустой файл или только изображения), `document_text_unreadable`
(испорченные символы), `document_images_skipped` (картинки и встроенные объекты DOCX),
`formulas_invalid` (испорченные символы, незакрытые границы или скобки), `pdf_formulas_need_review`
(возможная потеря структуры формул PDF). Это эвристики: смысл и полнота формул
автоматически не гарантируются. Контекст содержит `filename`, для PDF — `pages`,
а также `recovery_steps` (OCR или другая модель) и `formula_help` (сохранение LaTeX).
Предупреждения сохраняются в источнике колоды и задаче, видны в `dry_run` и прогрессе.
Порог готовности по умолчанию 8 карточек; завершённая задача играбельна с одной.
Курсор `seq` не используется повторно после удаления карточек.
Одновременно выполняются до 4 облачных вызовов или 1 локального; уже отправленные
облачные вызовы могут закончиться после пересечения ценового лимита.

## Подписки (B16)

`AiProviderRead.executor_kind`: `api` (прежние подключения), `codex` или `claude`.
У подписки `base_url` пуст: это официальный локальный клиент, а не HTTP-провайдер.
`GET /settings/ai/subscriptions` проверяет установку и режим входа, не расходуя запрос к модели.
`POST /subscriptions/{kind}/login` запускает официальный вход, `/login/cancel` прекращает ожидание,
`/connect` идемпотентно добавляет подключение и обновляет модели в общем каталоге.
Каталог не гарантирует доступ к каждой модели; `models/test` проверяет реальное выполнение.
Все вызовы одного клиента выполняются последовательно. Из окружения исключаются API-ключи
и альтернативные способы авторизации. Запросы не подменяются платным API.
Выбор моделей закрепляется за задачей, включая разбор и название; при подписочной генерации
раньше выбранный API для разбора заменяется той же подпиской. При продолжении выбор сохраняется.
Стоимость подписки неизвестна (`null`), денежные пороги API к ней не применяются.

Ошибки: `ai_subscription_cli_missing` (409), `ai_subscription_auth_required` (401/409 при подключении),
`ai_subscription_limit` (429), `ai_subscription_timeout` (504), `ai_subscription_unavailable` (503),
`ai_subscription_protocol` (502), `ai_subscription_models_missing` (409),
`ai_subscription_login_failed` (409), `ai_subscription_managed` (409).
Остановка сохраняет готовые карточки; продолжение использует существующий конвейер без дублей.

## Локальный MCP (B17)

STDIO-сервер `backend/mcp_server.py` подключается к существующему FastAPI на 8765,
без второй БД, фонового менеджера или TCP-порта. `/api/mcp/*` требует локальный Bearer
из `data/mcp.token`. Настройки выдаются через `/settings/ai/mcp`, установка официальным
CLI — `/install/{codex|claude}`, локальный пакет Claude Desktop — `/extension`.
Токен в настройки и пакет не включается. POST настройки входа/MCP проверяют Origin.

`awaiting_executor` — активное состояние ожидания чата, блокирует редактирование как
обычная генерация. При перезапуске становится `interrupted`; завершённые задания
сохраняются. MCP `create_import` принимает текст или `source_deck_id`; `control_job(use_chat)`
передаёт незавершённый импорт текущему чату. Внутреннее подключение `mcp` скрыто из
общего каталога настроек. Обычные API/подписочные импорты интерфейса работают как раньше.

`tasks/next` возвращает одно задание с JSON Schema, версией и арендой 10 минут.
`tasks/submit` проверяет аренду, состояние, размер и схему; одинаковый повтор безопасен.
Проверки содержания, ремонта, цитат, порядка и записи выполняет общий конвейер.
Ошибки: `mcp_unauthorized` (401), `local_origin_required` (403), `mcp_lease_stale` (409),
`mcp_result_conflict` (409), `mcp_result_invalid` (422), `mcp_result_too_large` (413),
`mcp_task_not_found` (404), `mcp_install_failed` (409), `mcp_name_conflict` (409).

## Tentex (B6)

Чтение закрытого Tentex использует `mode=ro&immutable=1` и не создаёт WAL/SHM.
При непустом WAL обычные запросы отвечают 409 `tentex_running`; `force=true`
явно разрешает `mode=ro`. `/tentex/status` в этом случае сообщает `running=true`,
`projects_count=0` и не открывает БД.
Ключи подключений расшифровываются ключом Tentex и шифруются ключом Study Surfers.
Повторный перенос провайдеров обновляет существующие подключения.
Карточки Tentex преобразуются в игровые карточки через модель генерации.
