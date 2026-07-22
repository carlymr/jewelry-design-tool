// Shared-secret guard for the API routes. The token ships in the client
// bundle (NEXT_PUBLIC_), so this is not real auth — it stops drive-by
// scanners and scripted abuse of the Anthropic-spending endpoints, nothing
// more. Replace with real auth when accounts are added. If the env var is
// unset (e.g. bare local dev), the routes allow all requests.
export function isAuthorized(request: Request): boolean {
  const token = process.env.NEXT_PUBLIC_API_TOKEN;
  return !token || request.headers.get("x-app-token") === token;
}

export function apiHeaders(): Record<string, string> {
  const token = process.env.NEXT_PUBLIC_API_TOKEN;
  return {
    "Content-Type": "application/json",
    ...(token ? { "x-app-token": token } : {}),
  };
}
