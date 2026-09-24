import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { CrashScreen } from "./app/CrashScreen";
import "./index.css";

const container = document.getElementById("root");
if (container == null) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>,
);
