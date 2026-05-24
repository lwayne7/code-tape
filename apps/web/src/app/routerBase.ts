export function normalizeRouterBasename(baseUrl: string): string | undefined {
  const normalized = baseUrl.trim();
  if (!normalized || normalized === "/") return undefined;
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export const routerBasename = normalizeRouterBasename(import.meta.env.BASE_URL);
