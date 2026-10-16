import "@fontsource-variable/onest";
import "@fontsource-variable/unbounded";
import "@fontsource/rubik-wet-paint/cyrillic-400.css";
import "@fontsource/rubik-wet-paint/latin-400.css";
import "@fontsource-variable/shantell-sans";
import "katex/dist/katex.min.css";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
/* Порядок важен: значения → сброс → примитивы кита → разметка → оболочка → экраны → игра */
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui-kit.css";
import "./styles/markdown.css";
import "./styles/app.css";
import "./styles/screens.css";
import "./styles/graffiti.css";
import "./styles/history.css";
import "./styles/game.css";

const container = document.getElementById("root");
if (!container) throw new Error("Не найден #root");

createRoot(container).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
