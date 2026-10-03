import "@primer/primitives/dist/css/functional/themes/light.css";
import "@primer/primitives/dist/css/functional/themes/dark.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { EditorActionsProvider } from "./history";
import "./index.css";
import { AppProvider } from "./state";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <EditorActionsProvider>
        <App />
      </EditorActionsProvider>
    </AppProvider>
  </StrictMode>,
);