import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { WindowResizeHandles } from "./layout/WindowResizeHandles";
import "./styles/tokens.css";
import "./styles/global.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <WindowResizeHandles />
  </React.StrictMode>,
);
