import ReactDOM from "react-dom/client";
import App from "./App";
import Downloader from "./downloader/Downloader";

const hash = window.location.hash.replace("#", "");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  hash === "downloader" ? <Downloader /> : <App />,
);
