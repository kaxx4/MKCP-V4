import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
/* Both typefaces are bundled with the app (nothing is fetched at start), so the window looks the same on an office PC with no internet.
   If a font file ever failed to load, the stacks in styles/tokens.css fall back to the system's own sans-serif. */
import "@fontsource-variable/geist";
import "@fontsource-variable/outfit";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
