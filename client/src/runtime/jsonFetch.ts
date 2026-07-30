export async function fetchJson<T>(
  path: string,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const response = await fetcher(path);
  if (!response.ok) throw new Error(`failed to fetch ${path}: ${response.status}`);
  return response.json() as Promise<T>;
}
