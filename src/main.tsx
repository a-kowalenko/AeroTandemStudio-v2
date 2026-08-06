import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initTheme, useThemeStore } from "./store/themeStore";
import "./index.css";

const initial = initTheme();
useThemeStore.setState({ mode: initial });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
