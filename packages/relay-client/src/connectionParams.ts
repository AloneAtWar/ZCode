// 远程链接解析：`https://<endpoint>/remote/v4?sid=…&hash=…&t=…&mid=…&name=…`
// 参照 ZLinker lib/protocol/connection_params.dart。链接即设备凭据，禁止写入日志。

export interface RemoteConnectionParams {
  readonly deviceSid: string;
  readonly passHash: string;
  readonly timestamp: number;
  readonly deviceMid: string | null;
  readonly deviceName: string | null;
  readonly appVersion: string | null;
  /** 原始链接的 origin（https://zcode.z.ai），relay ws 地址由它推导。 */
  readonly endpointOrigin: string;
  /** `wss://<host>/ws[?mid=…]`，relay 握手地址。 */
  readonly relayWsUrl: string;
  /** 原始链接原文，用于本地持久化（设备凭据）。 */
  readonly sourceUrl: string;
}

export function parseRemoteConnectionUrl(raw: string): RemoteConnectionParams | null {
  let uri: URL;
  try {
    uri = new URL(raw.trim());
  } catch {
    return null;
  }
  const get = (key: string): string | null => {
    const value = uri.searchParams.get(key)?.trim();
    return value ? value : null;
  };
  const deviceSid = get("sid");
  const passHash = get("hash");
  const timestamp = Number(get("t"));
  if (!deviceSid || !passHash || !Number.isFinite(timestamp)) {
    return null;
  }
  const deviceMid = get("mid");
  const secure = uri.protocol === "https:" || uri.protocol === "wss:";
  const relay = new URL(`${secure ? "wss" : "ws"}://${uri.host}/ws`);
  if (deviceMid) {
    relay.searchParams.set("mid", deviceMid);
  }
  return {
    deviceSid,
    passHash,
    timestamp,
    deviceMid,
    deviceName: get("name"),
    appVersion: get("app_version"),
    endpointOrigin: uri.origin,
    relayWsUrl: relay.toString(),
    sourceUrl: raw.trim(),
  };
}
