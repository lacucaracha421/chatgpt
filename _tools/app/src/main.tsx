import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { WindowResizeHandles } from "./layout/WindowResizeHandles";
import { initialWorkspaceView } from "./app/workspaceNavigation";
import { LaunchSplash, releaseLaunchSplash } from "./shared/launch/LaunchSplash";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/controls.css";

// The app opens on Home, which ends the launch splash when it is ready; only a design preview
// can open elsewhere, and it has no Home to wait for.
if (initialWorkspaceView().kind !== "home") releaseLaunchSplash();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
    <LaunchSplash />
    <WindowResizeHandles />
  </React.StrictMode>,
);
