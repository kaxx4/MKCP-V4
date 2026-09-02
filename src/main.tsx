import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./index.css";
// Must load after index.css — the bento layer wins on specificity, but source
// order decides ties. Canonical copy lives in the web-dashboard; keep in sync.
import "./theme-bento.css";
import App from "./App";

document.documentElement.setAttribute("data-theme", "bento");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
