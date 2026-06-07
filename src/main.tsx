import ReactDOM from "react-dom/client";
import App from "./App";
import Downloader from "./downloader/Downloader";
import { ScrollPanelApp } from "./components/ScrollPanelApp";
import {
  ACCENT_COLORS,
  DEFAULT_ACCENT_COLOR,
  SETTINGS_STORAGE_KEY,
  AccentColor,
} from "./constants";

const hash = window.location.hash.replace("#", "");

// Tag <html> so scoped CSS in App.css can target each window independently.
// The main window stays transparent so libmpv can render behind the WebView.
// The downloader and scroll-panel windows need their own opaque backgrounds.
if (hash === "downloader") {
  document.documentElement.classList.add("downloader-window");
} else if (hash === "scroll-panel") {
  document.documentElement.classList.add("scroll-panel-window");
}

// Apply the persisted accent color BEFORE React mounts so the first paint
// already uses the right palette (no red→user-pick flash). All windows share
// the same localStorage and the same App.css palette selectors.
(() => {
  let accent: AccentColor = DEFAULT_ACCENT_COLOR;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.accentColor === "string" &&
        (ACCENT_COLORS as readonly string[]).includes(parsed.accentColor)
      ) {
        accent = parsed.accentColor as AccentColor;
      }
    }
  } catch {
    /* fall through to default */
  }
  document.documentElement.dataset.accent = accent;
})();

function rootComponent() {
  if (hash === "downloader")    return <Downloader />
  if (hash === "scroll-panel")  return <ScrollPanelApp />
  return <App />
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  rootComponent(),
);
