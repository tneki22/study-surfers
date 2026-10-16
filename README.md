# Study Surfers

3D-раннер для подготовки к экзамену. Персонаж бежит по трём-четырём путям, на табло появляется вопрос, а над путями — варианты ответа. Чтобы ответить, нужно перебежать на путь с верным вариантом до ворот.

![Study Surfers](frontend/public/previews/world-classic.webp)

- Колоду можно собрать из своих материалов: загрузите PDF, DOCX, TXT, MD, TeX или Typst, и ИИ сделает карточки с вариантами ответа. Подходит любой OpenAI-совместимый провайдер, включая локальные LM Studio и Ollama.
- Есть импорт готовых карточек из Anki (`.apkg`, `.colpkg`) и таблиц (`.csv`, `.tsv`, `.txt`).
- Для пробы есть демо-колода, ИИ для неё не нужен.
- Два мира: дневной город и «Ночная магистраль».
- Формулы, жизни, комбо, а после забега — разбор ошибок.

Игра работает локально: сервер запускается на вашем компьютере, а все данные хранятся в папке `data/` проекта.

## Установка

Понадобятся:

- [Python](https://www.python.org/downloads/) 3.12 или 3.13;
- [Node.js](https://nodejs.org/) 22 или новее;
- [Git](https://git-scm.com/downloads) (можно и без него — скачайте ZIP через **Code → Download ZIP**).

```bash
git clone https://github.com/tneki22/study-surfers.git
cd study-surfers
```

Первый запуск занимает несколько минут: скрипт сам создаёт окружение Python, ставит зависимости и собирает интерфейс. Последующие запуски проходят быстро. Когда игра будет готова, откроется браузер с адресом http://127.0.0.1:8765.

### Windows

Дважды щёлкните **`Study Surfers.cmd`**.

При установке Python отметьте пункт **Add python.exe to PATH**.

### macOS и Linux

**1. Поставьте зависимости** (один раз). Проверить, что всё на месте:

```bash
python3 --version   # 3.12 или 3.13
node --version      # v22 или новее
git --version
```

Если чего-то нет:

- macOS (через [Homebrew](https://brew.sh/)):

  ```bash
  brew install python@3.12 node git
  ```

- Debian / Ubuntu:

  ```bash
  sudo apt update
  sudo apt install python3 python3-venv python3-pip git curl
  ```

  Node.js 22 в стандартных репозиториях часто старый — поставьте через [nvm](https://github.com/nvm-sh/nvm) или с [nodejs.org](https://nodejs.org/). Если `python3 --version` показывает не 3.12/3.13, установите `python3.12` и `python3.12-venv` (на Ubuntu 22.04 — из PPA deadsnakes).

- Fedora:

  ```bash
  sudo dnf install python3.12 nodejs git
  ```

- Arch:

  ```bash
  sudo pacman -S python nodejs npm git
  ```

**2. Скачайте проект и запустите:**

```bash
git clone https://github.com/tneki22/study-surfers.git
cd study-surfers
./start.sh
```

Скрипт сам создаст окружение `backend/.venv`, поставит Python-зависимости (`pip`), соберёт интерфейс (`npm ci` и `npm run build`) и откроет браузер на http://127.0.0.1:8765. Первый запуск идёт несколько минут, потом — несколько секунд: зависимости и сборка обновляются только при изменениях.

Если после скачивания ZIP скрипт не запускается с «Permission denied», сделайте его исполняемым: `chmod +x start.sh`.

**Параметры `start.sh`:**

| Команда | Что делает |
|---|---|
| `./start.sh` | собирает интерфейс и запускает игру на http://127.0.0.1:8765 |
| `./start.sh --no-browser` | то же, но без автоматического открытия браузера (удобно на сервере или по SSH) |
| `./start.sh --dev` | режим разработки с горячей перезагрузкой на http://127.0.0.1:5180 |

Чтобы остановить игру, нажмите `Ctrl+C` в терминале (Windows: закройте окно консоли).

<details>
<summary>Запуск вручную, без <code>start.sh</code></summary>

Из корня проекта:

```bash
# 1. Python-окружение и зависимости
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt

# 2. Сборка интерфейса
cd frontend
npm ci
npm run build

# 3. Запуск сервера (раздаёт собранный интерфейс)
cd ../backend
PYTHONUTF8=1 .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8765 --loop app.event_loop:loop_factory
```

После этого откройте http://127.0.0.1:8765.

</details>

**Если что-то не работает:**

- `нужен Python 3.12 или 3.13` — у `python3` другая версия; поставьте нужную и запустите заново (скрипт сам найдёт `python3.12` или `python3.13`).
- `не получилось создать окружение` — на Debian/Ubuntu не хватает `python3-venv` (см. выше).
- `нужен Node.js 22 или новее` — обновите Node.js; проверьте, что `npm` доступен в `PATH`.
- Порт `8765` или `5180` занят — закройте программу, которая его использует (`lsof -i :8765`), и запустите заново.
- Сборка сломалась на полпути — удалите `frontend/dist` и `frontend/node_modules` и запустите `./start.sh` снова.

## Управление

| Действие | Клавиши |
|---|---|
| Сменить путь | `←` `→` или `A` `D`, либо `1`–`4` |
| Прыжок | `↑`, `W`, `Пробел` |
| Подкат | `↓`, `S` |
| Пауза | `Esc`, `P` |
| Музыка вкл/выкл | `M` |

## Генерация карточек ИИ

Откройте **Параметры → ИИ** и выберите провайдера. Для облачного провайдера понадобится API-ключ; LM Studio и Ollama работают без ключа. Ключи хранятся в зашифрованном виде в `data/`.

## Режим разработки

Режим с горячей перезагрузкой интерфейса доступен по адресу http://127.0.0.1:5180:

- Windows — `dev.cmd`;
- macOS и Linux — `./start.sh --dev`.

Как собрать отдельное приложение для Windows (`.exe` без Python и Node.js), описано в [docs/WINDOWS_EXE.md](docs/WINDOWS_EXE.md).

## Лицензии ассетов

Модели и звуки взяты из наборов KayKit и Kenney (CC0), список — в [docs/ASSETS.md](docs/ASSETS.md). Город, поезда, музыка и остальная графика создаются кодом.
