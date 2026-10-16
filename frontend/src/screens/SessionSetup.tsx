import { ArrowLeft, Pencil, Play, RotateCcw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { Difficulty, ItemsFilter } from "../api/types";
import { useRunLauncher } from "../app/launch";
import { useSkipSetup } from "../app/skipSetup";
import { useSession } from "../app/stores";
import { Button, ErrorState, LoadingState, SegmentedTabs, Switch } from "../components/ui";
import {
  DEFAULT_SETTINGS,
  DIFFICULTY_LABEL,
  PACE_LABEL,
  parseItemsFilter,
  type ItemCount,
  type Lives,
  type Pace,
  type SessionSettings,
} from "../game/engine/settings";
import { scoreRules } from "../game/engine/scoring";
import { useLoad } from "../hooks/useLoad";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { DeckTitle } from "./deck/DeckTitle";
import { RunCards } from "./deck/RunCards";

const tabs = <T extends string>(entries: [T, string][]) => entries.map(([value, label]) => ({ value, label }));

const DIFFICULTY_HINT: Record<Difficulty, string> = {
  easy: "Верный ответ + два явно неверных; на 4 треках ещё один похожий",
  medium: "Верный + один явно неверный, остальные похожие",
  hard: "Все варианты похожи на верный, но неточны",
};

const PACE_HINT: Record<Pace, string> = {
  calm: "8–12 секунд на вопрос",
  normal: "5–10 секунд, по длине текста",
  fast: "4–7 секунд",
  custom: "Сколько выберешь",
};

/** На ПК настройки встают в две колонки и целиком помещаются в экран; на телефоне — одна колонка. */
const TWO_COLUMNS_QUERY = "(min-width: 1024px)";

const factorFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <span className="setting-row-label">{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}

export function SessionSetup() {
  const { deckId = "" } = useParams();
  const [params] = useSearchParams();
  const launcher = useRunLauncher();
  const saved = useSession((state) => state.settings);
  // `?filter=weak|last_mistakes` (из «Истории») ложится поверх сохранённых настроек, не меняя остальные.
  const urlFilter = parseItemsFilter(params.get("filter"));
  const [settings, setSettings] = useState<SessionSettings>(() => (urlFilter ? { ...saved, filter: urlFilter } : saved));
  useEffect(() => {
    if (urlFilter) setSettings((current) => (current.filter === urlFilter ? current : { ...current, filter: urlFilter }));
  }, [urlFilter]);
  const skipSetup = useSkipSetup((state) => state.deckIds.includes(deckId));
  const setSkip = useSkipSetup((state) => state.setSkip);
  const deck = useLoad(() => api.getDeck(deckId), [deckId]);
  const twoColumns = useMediaQuery(TWO_COLUMNS_QUERY);
  const set = <K extends keyof SessionSettings>(key: K, value: SessionSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));

  if (deck.error) return <div className="screen-narrow"><ErrorState message={deck.error} /></div>;
  if (!deck.data) return <LoadingState label="Загружаю колоду" placement="page" />;

  const available = deck.data.enabled_item_count;

  const worldPicker = (
    <fieldset className="world-picker">
      <legend>Мир забега</legend>
      {([
        ["classic", "Дневной город", "Поезда, солнечный город и бегун", "Классика"],
        ["night-maglev", "Ночной город", "Магнитный путь и ховербайк", "W / ↑ — разгон, S / ↓ — торможение"],
      ] as const).map(([world, name, description, badge]) => (
        <label key={world} className={`world-card world-card--${world} ${settings.world === world ? "is-selected" : ""}`}>
          <input type="radio" name="world" value={world} checked={settings.world === world} onChange={() => set("world", world)} />
          <img className="world-preview" src={`${import.meta.env.BASE_URL}previews/world-${world}.webp`} alt="" loading="lazy" decoding="async" />
          <span className="world-card-content"><small>{badge}</small><strong>{name}</strong><span>{description}</span></span>
        </label>
      ))}
    </fieldset>
  );
  const questionsCard = (
    <div className="settings-card">
      <SettingRow label="Сколько вопросов">
        <SegmentedTabs
          label="Сколько вопросов"
          value={String(settings.count)}
          tabs={tabs([["10", "10"], ["20", "20"], ["30", "30"], ["all", "Все"]])}
          onChange={(value) => set("count", (value === "all" ? "all" : Number(value)) as ItemCount)}
        />
      </SettingRow>
      <SettingRow label="Какие" hint={settings.filter === "weak" ? `Слабых сейчас: ${deck.data.weak_count}` : undefined}>
        <SegmentedTabs<ItemsFilter>
          label="Какие карточки"
          value={settings.filter}
          tabs={tabs<ItemsFilter>([["all", "Все"], ["weak", "Слабые"], ["last_mistakes", "Ошибки прошлого"]])}
          onChange={(value) => set("filter", value)}
        />
      </SettingRow>
      <SettingRow label="Порядок" hint={settings.order === "program"
        ? "Порядок исходных вопросов. Если генерация ещё идёт, забег дождётся её окончания"
        : "Случайный порядок; новые карточки смешиваются с оставшейся очередью"}>
        <SegmentedTabs
          label="Порядок"
          value={settings.order}
          tabs={tabs<SessionSettings["order"]>([["shuffle", "Вперемешку"], ["program", "По программе"]])}
          onChange={(value) => set("order", value)}
        />
      </SettingRow>
    </div>
  );
  const gameplayCard = (
    <div className="settings-card">
      <SettingRow label="Треки">
        <SegmentedTabs
          label="Количество треков"
          value={String(settings.lanes)}
          tabs={tabs([["3", "3"], ["4", "4"]])}
          onChange={(value) => set("lanes", Number(value) as 3 | 4)}
        />
      </SettingRow>
      <SettingRow label="Сложность" hint={DIFFICULTY_HINT[settings.difficulty]}>
        <SegmentedTabs<Difficulty>
          label="Сложность"
          value={settings.difficulty}
          tabs={tabs<Difficulty>([["easy", DIFFICULTY_LABEL.easy], ["medium", DIFFICULTY_LABEL.medium], ["hard", DIFFICULTY_LABEL.hard]])}
          onChange={(value) => set("difficulty", value)}
        />
      </SettingRow>
      <SettingRow label="Темп" hint={PACE_HINT[settings.pace]}>
        <SegmentedTabs<Pace>
          label="Темп"
          value={settings.pace}
          tabs={tabs<Pace>([["calm", PACE_LABEL.calm], ["normal", PACE_LABEL.normal], ["fast", PACE_LABEL.fast], ["custom", PACE_LABEL.custom]])}
          onChange={(value) => set("pace", value)}
        />
      </SettingRow>
      {settings.pace === "custom" && (
        <SettingRow label={`Секунд на вопрос: ${settings.customSeconds}`}>
          <input
            type="range"
            min={3}
            max={20}
            value={settings.customSeconds}
            onChange={(event) => set("customSeconds", Number(event.target.value))}
            aria-label="Секунд на вопрос"
            className="range-input"
          />
        </SettingRow>
      )}
      <SettingRow label="Жизни" hint={settings.lives ? "Забег закончится, когда жизни кончатся" : "Ошибки только снимают очки"}>
        <SegmentedTabs
          label="Жизни"
          value={String(settings.lives)}
          tabs={tabs([["0", "Выкл"], ["3", "3"], ["5", "5"]])}
          onChange={(value) => set("lives", Number(value) as Lives)}
        />
      </SettingRow>
      <p className="setting-score-factor">
        Цена ответа <strong>×{factorFormat.format(scoreRules(settings).factor)}</strong> — растёт со сложностью, темпом и числом треков
      </p>
    </div>
  );
  const togglesCard = (
    <div className="settings-card">
      <Switch
        label="Препятствия"
        hint={settings.world === "night-maglev"
          ? (settings.obstacles ? "Ремонтные роботы и магнитные сбои. Пробел — прыжок, Shift — снижение. Перед ответом путь свободен" : "Свободная магистраль. Ускорение и торможение доступны")
          : settings.obstacles
          ? "Барьеры — перепрыгивай (W, ↑, пробел), балки — подкатом (S, ↓). Каждый трек проходим на месте"
          : "Только вопросы и треки — без прыжков и подкатов"}
        checked={settings.obstacles}
        onCheckedChange={(value) => set("obstacles", value)}
      />
      {settings.obstacles && (
        <Switch
          label="Больше препятствий"
          hint={settings.moreObstacles
            ? "Вдвое чаще и сложнее: лесенки, двойки, прыжок с нырком. Тренировка внимания под нагрузкой"
            : "Обычная плотность: препятствия не мешают читать вопрос и выбирать ответ"}
          checked={Boolean(settings.moreObstacles)}
          onCheckedChange={(value) => set("moreObstacles", value)}
        />
      )}
      <Switch
        label="Модификаторы"
        hint={settings.world === "night-maglev"
          ? "Магнит, фазовый ход и импульсный щит. Усиления на 6 секунд, даже без препятствий"
          : "Джетпак и гравикроссы на 6 секунд. Можно собирать на земле и в воздухе"}
        checked={settings.modifiers}
        onCheckedChange={(value) => set("modifiers", value)}
      />
      <Switch
        label="Возвращать ошибки в этот забег"
        hint="Дополнительный повтор через 3–5 вопросов. Ошибки в конце — в разборе после финиша"
        checked={settings.retryMistakes}
        onCheckedChange={(value) => set("retryMistakes", value)}
      />
    </div>
  );
  const aiCard = (
    <div className="settings-card">
      <Switch
        label="Карточки «ответ ИИ»"
        hint="Ответы, которых не было в твоих материалах, — с пометкой на табло"
        checked={settings.includeAiItems}
        onCheckedChange={(value) => set("includeAiItems", value)}
      />
    </div>
  );
  const skipCard = (
    <div className="settings-card">
      <Switch
        label="Запомнить и больше не показывать настройку перед стартом"
        hint="«Бежать» у этой колоды будет сразу начинать забег с последними настройками. Вернуться сюда можно кнопкой настроек у колоды"
        checked={skipSetup}
        onCheckedChange={(value) => setSkip(deckId, value)}
      />
    </div>
  );
  const actions = (
    <div className="session-setup-actions">
      <Button variant="ghost" onClick={() => setSettings(DEFAULT_SETTINGS)}>
        <RotateCcw size={16} aria-hidden="true" /> По умолчанию
      </Button>
      <Button
        className="cta-button"
        disabled={available === 0}
        onClick={() => launcher.start(deckId, { settings, live: params.get("live") === "1" || deck.data?.status === "generating" })}
      >
        <Play size={18} aria-hidden="true" fill="currentColor" /> Бежать!
      </Button>
    </div>
  );
  const viewCards = (
    <Link to={`/decks/${deckId}`} className="secondary-button view-cards-button">
      <Pencil size={16} aria-hidden="true" /> Редактировать карточки
    </Link>
  );
  const runCards = <RunCards deckId={deckId} settings={settings} />;

  return (
    <div className={twoColumns ? "screen-wide session-setup session-setup--columns" : "screen-narrow session-setup"}>
      <Link to="/" className="back-link"><ArrowLeft size={16} aria-hidden="true" /> На главную</Link>
      <div className="session-setup-head">
        <h1>
          <DeckTitle
            title={deck.data.title}
            onRename={async (title) => { await api.renameDeck(deckId, title); deck.reload(); }}
          />
        </h1>
        <p className="screen-lead">Настройки забега · доступно карточек: {available}</p>
      </div>

      {twoColumns ? (
        <div className="session-setup-columns">
          <div className="session-setup-column session-setup-body">{worldPicker}{questionsCard}{skipCard}{aiCard}</div>
          <div className="session-setup-column session-setup-body">{gameplayCard}{togglesCard}</div>
          <div className="session-setup-column">{viewCards}</div>
          <div className="session-setup-column">{actions}</div>
        </div>
      ) : (
        <>{worldPicker}{questionsCard}{gameplayCard}{togglesCard}{aiCard}{skipCard}{viewCards}{actions}</>
      )}
      {runCards}
    </div>
  );
}
