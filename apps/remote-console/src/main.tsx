import { createRoot } from "react-dom/client";
import "@zcode/ui/styles.css";
import "@zcode/remote-console-ui/styles.css";
import { applyStoredTheme, RemoteConsoleApp } from "@zcode/remote-console-ui";

applyStoredTheme();

createRoot(document.getElementById("root")!).render(<RemoteConsoleApp />);
