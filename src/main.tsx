import { Suspense, StrictMode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initTheme, useThemeStore } from "./store/themeStore";
import { useLocaleStore } from "./store/localeStore";
import "./index.css";

const initial = initTheme();
useThemeStore.setState({ mode: initial });

async function bootstrap() {
  await useLocaleStore.getState().init();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <Suspense fallback={null}>
        <App />
      </Suspense>
    </StrictMode>,
  );
}

void bootstrap();
