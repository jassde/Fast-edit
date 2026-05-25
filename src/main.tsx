import ReactDOM from "react-dom/client";
import App from "./App";
import Downloader from "./downloader/Downloader";

const hash = window.location.hash.replace("#", "");

// The main window is transparent so libmpv can render behind the WebView.
// The downloader window has no mpv layer, so it needs an opaque body.
// Tag <html> here and let downloader.css scope its background rule to it —
// otherwise downloader.css's html/body rule would leak into the main window
// (Vite bundles CSS globally) and hide the video.
if (hash === "downloader") {
  document.documentElement.classList.add("downloader-window");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  hash === "downloader" ? <Downloader /> : <App />,
);
