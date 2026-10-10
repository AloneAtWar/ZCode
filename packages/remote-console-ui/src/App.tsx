import { useState } from "react";
import { DeviceHome } from "./DeviceHome.js";
import { DeviceView } from "./DeviceView.js";
import { ConversationView } from "./ConversationView.js";
import type { StoredDevice } from "./deviceStore.js";
import type { ConversationTarget } from "./types.js";

type View =
  | { kind: "home" }
  | { kind: "device"; device: StoredDevice }
  | { kind: "conversation"; device: StoredDevice; target: ConversationTarget };

export function App() {
  const [view, setView] = useState<View>({ kind: "home" });

  switch (view.kind) {
    case "home":
      return <DeviceHome onOpenDevice={(device) => setView({ kind: "device", device })} />;
    case "device":
      return (
        <DeviceView
          device={view.device}
          onOpenConversation={(target) =>
            setView({ kind: "conversation", device: view.device, target })
          }
          onBack={() => setView({ kind: "home" })}
        />
      );
    case "conversation":
      return (
        <ConversationView
          device={view.device}
          target={view.target}
          onBack={() => setView({ kind: "device", device: view.device })}
        />
      );
  }
}
