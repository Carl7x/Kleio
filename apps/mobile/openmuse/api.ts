import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { clientFetch, getServerURL, serverURL, setTransport } from "../src/transport";
import { readApiPayload } from "./api-response";

function configuredURL(): string {
  if (Platform.OS === "web") return globalThis.location?.origin ?? "";
  if (process.env.EXPO_PUBLIC_API_URL) return serverURL(process.env.EXPO_PUBLIC_API_URL);
  const developmentHost = Constants.expoConfig?.hostUri;
  if (developmentHost) return serverURL(`http://${new URL(`http://${developmentHost}`).hostname}:4317`);
  return "http://localhost:4317";
}
export const API_URL = configuredURL();
const savedKey = "kleio.connection.v1";
let deviceToken = "";
let bootstrapped: Promise<void> | undefined;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      clientFetch(path, { ...init, signal: controller.signal }).then(response => readApiPayload<T>(response)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("工作台无响应。请确认服务器可达后再试。"));
          controller.abort();
        }, 15_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function bootstrap(): Promise<void> {
  if (Platform.OS === "web") {
    const fragment = new URLSearchParams(globalThis.location.hash.slice(1));
    const ticket = fragment.get("ticket");
    if (ticket) {
      globalThis.history.replaceState(null, "", globalThis.location.pathname + globalThis.location.search);
      await request("/api/session", json({ ticket }));
    }
    return;
  }
  setTransport(API_URL);
  const saved = await SecureStore.getItemAsync(savedKey);
  if (!saved) return;
  try {
    const value = JSON.parse(saved) as { url: string; token: string };
    if (serverURL(value.url) === API_URL && typeof value.token === "string" && value.token.length >= 24) {
      deviceToken = value.token;
      setTransport(API_URL, deviceToken);
    }
  } catch { /* An invalid saved connection falls back to the original workspace access gate. */ }
}

export class MuseApi {
  constructor(readonly token: string) {}
  request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const multipart = typeof FormData !== "undefined" && body instanceof FormData;
    return request(path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      ...(body === undefined || multipart ? {} : { headers: { "Content-Type": "application/json" } }),
      body: body === undefined ? undefined : multipart ? body as FormData : JSON.stringify(body),
    });
  }
  url(path: string): string {
    return path.startsWith("http") ? path : `${getServerURL() || API_URL}${path}`;
  }
}

/** Public/remote web uses the Kleio access token (KLEIO_TOKEN) once to mint an HttpOnly browser session. */
export async function createSession(accessKey?: string): Promise<{ token: string; mode: "live" }> {
  await (bootstrapped ??= bootstrap()).catch(error => { bootstrapped = undefined; throw error; });
  if (accessKey?.trim()) {
    if (Platform.OS === "web") {
      const issued = await request<{ ticket: string }>("/api/session-tickets", {
        ...json({}), headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessKey.trim()}` },
      });
      await request("/api/session", json(issued));
    } else {
      setTransport(API_URL, accessKey.trim());
      try {
        const issued = await request<{ code: string }>("/api/device-pairing", json({}));
        const paired = await request<{ token: string }>("/api/devices/pair", json({ code: issued.code, name: "iPhone", client: "native" }));
        if (!paired.token) throw new Error("工作台未授予设备会话。");
        deviceToken = paired.token;
        await SecureStore.setItemAsync(savedKey, JSON.stringify({ url: API_URL, token: deviceToken }), {
          keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        });
      } finally { setTransport(API_URL, deviceToken); }
    }
  }
  await request("/api/status");
  return { token: Platform.OS === "web" ? "browser-session" : deviceToken, mode: "live" };
}
