import ReactDOM from "react-dom/client";
import App from "./App";
import Downloader from "./downloader/Downloader";
import { ScrollPanelApp } from "./components/ScrollPanelApp";

const hash = window.location.hash.replace("#", "");

// Tag <html> so scoped CSS in App.css can target each window independently.
// The main window stays transparent so libmpv can render behind the WebView.
// The downloader and scroll-panel windows need their own opaque backgrounds.
if (hash === "downloader") {
  document.documentElement.classList.add("downloader-window");
} else if (hash === "scroll-panel") {
  document.documentElement.classList.add("scroll-panel-window");
}

function rootComponent() {
  if (hash === "downloader")    return <Downloader />
  if (hash === "scroll-panel")  return <ScrollPanelApp />
  return <App />
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  rootComponent(),
);
