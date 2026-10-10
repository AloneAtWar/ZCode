// 设备清单持久化：localStorage。注意 —— 远程链接即设备凭据，
// 这里按用户显式"添加设备"的动作保存在本机浏览器/桌面窗口，不写入任何日志。
import { parseRemoteConnectionUrl } from "@zcode/relay-client";

export interface StoredDevice {
  /** 取设备 sid，天然稳定且唯一。 */
  id: string;
  name: string;
  url: string;
  addedAt: number;
}

const STORAGE_KEY = "zcode-remote-devices";

export function loadDevices(): StoredDevice[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is StoredDevice =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as StoredDevice).id === "string" &&
        typeof (item as StoredDevice).url === "string",
    );
  } catch {
    return [];
  }
}

function saveDevices(devices: StoredDevice[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
}

/** 校验并添加设备；链接非法返回 null，同设备重复添加时更新链接（凭据可能已轮换）。 */
export function addDevice(rawUrl: string): StoredDevice | null {
  const params = parseRemoteConnectionUrl(rawUrl);
  if (!params) return null;
  const devices = loadDevices();
  const device: StoredDevice = {
    id: params.deviceSid,
    name: params.deviceName ?? params.deviceSid,
    url: params.sourceUrl,
    addedAt: Date.now(),
  };
  const index = devices.findIndex((item) => item.id === device.id);
  if (index >= 0) {
    devices[index] = device;
  } else {
    devices.push(device);
  }
  saveDevices(devices);
  return device;
}

export function removeDevice(id: string): void {
  saveDevices(loadDevices().filter((item) => item.id !== id));
}
