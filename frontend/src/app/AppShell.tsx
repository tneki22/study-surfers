import { ArrowLeft, History, Settings2 } from "lucide-react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "../api/client";
import studyRobot from "../assets/home/study-robot.png";
import { StatusBadge } from "../components/ui";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { ThemeToggle } from "./ThemeToggle";
import { GenerationStatus } from "./GenerationStatus";

export function BrandMark({ size = 42 }: { size?: number }) {
  return (
    <img className="brand-mark" src={`${import.meta.env.BASE_URL}branding/icon-192.png`}
      width={size} height={size} alt="" aria-hidden="true" />
  );
}

/** Уже этой ширины ссылки верхней полосы остаются иконками; подписи читают скринридеры и подсказка. */
const COMPACT_NAV_QUERY = "(max-width: 520px)";

/** Оболочка меню: небо на фоне, верхняя полоса и экран. Сам забег идёт без неё, на весь экран. */
export function AppShell() {
  const { pathname, key } = useLocation();
  const navigate = useNavigate();
  // Экран карточек колоды: «Обратно» возвращает на открытую до этого страницу, при прямом заходе — на главную.
  const isDeck = /^\/decks\/[^/]+\/?$/.test(pathname);
  const isHome = pathname === "/";
  const isSettings = pathname === "/settings";
  // Иллюстрация города у главной и у истории; оформление главной (робот, подложки) — только у главной.
  const hasScene = isHome || pathname === "/history";
  const compactNav = useMediaQuery(isSettings ? "(max-width: 640px)" : COMPACT_NAV_QUERY);

  return (
    <div className={`app-shell${hasScene ? " app-shell--scene" : ""}${isHome ? " app-shell--home" : ""}${isSettings ? " app-shell--settings" : ""}`}>
      <div className="app-sky" aria-hidden="true">
        <span className="cloud cloud-1" />
        <span className="cloud cloud-2" />
        <span className="cloud cloud-3" />
        {isHome && (
          <div className="study-robot-flight">
            <img className="study-robot" src={studyRobot} alt="" width={1254} height={1254} />
          </div>
        )}
      </div>
      <header className="app-topbar">
        <NavLink to="/" className="brand" aria-label="Study Surfers — на главную">
          <BrandMark />
          <span>Study Surfers</span>
        </NavLink>
        <div className="app-topbar-center">
          {isSettings && (
            <Link to="/" className="primary-button topbar-back">
              <ArrowLeft size={18} aria-hidden="true" /> Обратно
            </Link>
          )}
          {isDeck && (
            <button type="button" className="primary-button topbar-back" onClick={() => (key === "default" ? navigate("/") : navigate(-1))}>
              <ArrowLeft size={18} aria-hidden="true" /> Обратно
            </button>
          )}
          {api.mock && <StatusBadge tone="warning">демо-режим без сервера</StatusBadge>}
          <GenerationStatus />
        </div>
        <nav className={`app-nav${compactNav ? " app-nav--compact" : ""}`}>
          <NavLink to="/settings" className="app-nav-link" title={compactNav ? "Параметры" : undefined}>
            <Settings2 size={16} aria-hidden="true" />
            <span className="app-nav-label">Параметры</span>
          </NavLink>
          <NavLink to="/history" className="app-nav-link" title={compactNav ? "История" : undefined}>
            <History size={16} aria-hidden="true" />
            <span className="app-nav-label">История</span>
          </NavLink>
          <ThemeToggle />
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
