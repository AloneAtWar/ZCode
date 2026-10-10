import { useState } from "react";
import { Button } from "@zcode/ui/replay";
import { addDevice, loadDevices, removeDevice, type StoredDevice } from "./deviceStore.js";
import { disposeRelayDevice } from "./deviceCache.js";

interface DeviceHomeProps {
  onOpenDevice: (device: StoredDevice) => void;
}

export function DeviceHome({ onOpenDevice }: DeviceHomeProps) {
  const [devices, setDevices] = useState<StoredDevice[]>(() => loadDevices());
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const device = addDevice(trimmed);
    if (!device) {
      setError("无法识别的远程链接：需要 https://…/remote/v4?sid=…&hash=…&t=… 形式");
      return;
    }
    setError(null);
    setUrl("");
    setDevices(loadDevices());
  };

  const handleRemove = (id: string) => {
    disposeRelayDevice(id);
    removeDevice(id);
    setDevices(loadDevices());
  };

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 bg-background px-6 py-10 text-foreground">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">ZCode 远程控制台</h1>
        <p className="text-sm text-muted-foreground">
          在桌面端 ZCode 的「远程控制」里生成链接，粘贴到这里即可连接。
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground"
            placeholder="粘贴远程链接 https://zcode.z.ai/remote/v4?…"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleAdd();
            }}
          />
          <Button onClick={handleAdd}>添加设备</Button>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>

      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有设备，先粘贴一个远程链接。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {devices.map((device) => (
            <li
              key={device.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{device.name}</div>
                <div className="truncate text-xs text-muted-foreground">{device.id}</div>
              </div>
              <Button size="sm" onClick={() => onOpenDevice(device)}>
                连接
              </Button>
              <Button size="sm" variant="ghost" onClick={() => handleRemove(device.id)}>
                删除
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
