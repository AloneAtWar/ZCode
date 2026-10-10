// RelayDevice 实例缓存：跨视图共享，页面切换不销毁连接；
// 仅在用户显式"断开/删除设备"时 dispose。
import { connectRelayDevice, type RelayDevice } from "@zcode/relay-client";
import type { StoredDevice } from "./deviceStore.js";

const cache = new Map<string, RelayDevice>();

export function getOrCreateRelayDevice(stored: StoredDevice): RelayDevice {
  let device = cache.get(stored.id);
  if (!device) {
    device = connectRelayDevice(stored.url, { clientName: "remote-console" });
    cache.set(stored.id, device);
  }
  return device;
}

export function disposeRelayDevice(id: string): void {
  const device = cache.get(id);
  if (device) {
    cache.delete(id);
    device.dispose();
  }
}
