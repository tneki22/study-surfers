/*
 * Типы API — тонкий фасад над contract/api-types.ts, который генерирует бэкенд
 * (`npm run generate:contract`). Экраны и игра импортируют отсюда: если бэкенд
 * поменяет схему, расхождение поймает tsc, а не пользователь.
 */
import type { components } from "../../../contract/api-types";

type S = components["schemas"];
export type Subscription = S["SubscriptionRead"];
export type SubscriptionLogin = S["SubscriptionLoginRead"];
export type SubscriptionKind = Subscription["kind"];
export type McpSetup = S["McpSetupRead"];
export type McpInstall = S["McpInstallRead"];

// --- Карточки ---
export type Distractor = S["Distractor"];
export type DistractorKind = Distractor["kind"];
export type ItemStats = S["StatsRead"];
export type QuizItem = S["QuizItemRead"];
export type ItemSource = QuizItem["source"];
export type ItemsPage = S["ItemPage"];
export type ItemsFilter = NonNullable<S["RunSettings"]["filter"]>;
export type ItemPatchBody = S["ItemPatch"];
export type RegenerateMode = S["RegenerateItem"]["mode"];

// --- Колоды ---
export type DeckSummary = S["DeckSummary"];
export type DeckDetail = S["DeckDetail"];
export type DeckStatus = DeckSummary["status"];
export type DeckSourceKind = DeckSummary["source_kind"];
export type DeckSource = S["SourceRead"];
export type DocRole = DeckSource["role"];
export type DeckQuestion = S["QuestionRead"];
export type DeckStats = S["DeckStats"];
export type DeckFile = S["DeckFile"];

// --- Быстрый импорт и задачи ---
export type ItemsPerQuestion = "auto" | 1 | 3 | 5;

/** Поле `options` формы POST /imports/quick (JSON-строкой, схема ImportOptions бэкенда). */
export interface QuickImportOptions {
  title?: string;
  /** Без title: модель придумает название колоды после разбора вопросов. */
  auto_title?: boolean;
  items_per_question: ItemsPerQuestion;
  /** Пожелания к карточкам (уровень, акценты). Без поля — пресет по умолчанию. */
  learner_prompt?: string;
  deck_id?: string;
  confirm_cost?: boolean;
  /** Роль документа по имени файла; без неё бэкенд определяет роль сам. */
  roles?: Record<string, DocRole>;
}

export type ImportStarted = S["ImportRead"];
export type LearnerPresets = S["LearnerPresetsRead"];
export type DryRun = S["DryRunRead"];
export type Job = S["JobRead"];
export type JobState = Job["state"];
export type JobWarning = S["WarningRead"];
export type JobEstimate = S["EstimateRead"];

// --- Флеш-карточки: Anki, Quizlet, CSV ---
export type FieldMapping = S["FieldMapping"];
export type FlashcardPreview = S["FlashcardPreview"];
export type FlashcardNoteType = S["NoteTypeRead"];
export type FlashcardSample = S["PlannedCardRead"];
export type FlashcardImported = S["FlashcardImportRead"];
export type FlashcardMode = "auto" | "local" | "ai";
export type FlashcardPromptStyle = "auto" | "meaning" | "translate";

/** Поле `options` формы POST /imports/flashcards (JSON-строкой, схема FlashcardOptions бэкенда). */
export interface FlashcardOptions {
  title?: string;
  mode?: FlashcardMode;
  /** Поля по id типа заметок; без записи бэкенд подбирает их по именам. */
  mappings?: Record<string, FieldMapping>;
  excluded_note_types?: string[];
  /** Только эти колоды Anki; без поля — все. */
  decks?: string[] | null;
  reverse?: boolean;
  prompt_style?: FlashcardPromptStyle;
}

/** Формат выгрузки колоды: своя полная копия или таблица для Anki и Quizlet. */
export type ExportFormat = "ssdeck" | "anki";

// --- Забеги ---
export type RunSettings = S["RunSettings"];
export type Difficulty = RunSettings["difficulty"];
export type RunAnswerIn = S["AnswerCreate"];
export type ChosenKind = RunAnswerIn["chosen_kind"];
export type RunIn = S["RunCreate"];
export type RunMistake = S["MistakeRead"];
export type RunSummary = S["RunSummary"];
export type RunDetail = S["RunDetail"];

export type Health = S["Health"];
export type ApiErrorBody = S["ErrorResponse"];

// --- ИИ ---
export type AiSettings = S["AiSettingsRead"];
export type AiGlobalSettingsWrite = S["AiGlobalSettingsWrite"];
export type AiProvider = S["AiProviderRead"];
export type AiProviderWrite = S["AiProviderWrite"];
export type AiProviderTest = S["AiProviderTestRead"];
export type AiPreset = S["AiPresetRead"];
export type AiModel = S["AiModelRead"];
export type AiCatalogModel = S["AiCatalogModelRead"];
export type AiCatalogModelWrite = S["AiCatalogModelWrite"];
export type AiManualModelWrite = S["AiManualModelWrite"];
export type AiModelSelection = S["AiModelSelection"];
export type AiModelTest = S["AiModelTestRead"];
export type AiRole = S["AiRoleRead"];
export type AiRoleWrite = S["AiRoleWrite"];

// --- Tentex ---
export type TentexStatus = S["TentexStatus"];
export type TentexProject = S["TentexProject"];
export type TentexProjectImport = S["TentexProjectImport"];
export type TentexImportResult = S["TentexImportResult"];
export type TentexProvider = S["TentexProvider"];
export type TentexProvidersImport = S["TentexProvidersImport"];
