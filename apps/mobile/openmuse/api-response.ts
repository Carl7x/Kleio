/**
 * Read an API response without assuming every route answers with JSON.
 * Plain-text 404s, proxy HTML pages and empty bodies must not surface as
 * "Unexpected token" parse errors in the UI.
 */
export async function readApiPayload<T>(response: Response, fallback?: string): Promise<T> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const error =
      payload && typeof payload === "object" ? (payload as { error?: unknown }).error : undefined;
    throw new Error(
      typeof error === "string" ? error : (fallback ?? `请求失败（${response.status}）`),
    );
  }
  if (payload === undefined)
    throw new Error(`服务器返回了无法解析的响应（${response.status}）。`);
  return payload as T;
}
