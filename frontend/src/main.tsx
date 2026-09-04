import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.js";
import "./styles/index.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("找不到 #root 挂载点（index.html）");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
