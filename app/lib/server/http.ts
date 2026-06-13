// Shared helpers for API route handlers.

export function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Normalize unknown thrown values into a readable message. Env-var errors
 * are configuration problems (500 with the variable name); everything else
 * keeps its message so failures are never silent.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Body must be a JSON object");
    }
    return body as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid JSON body: ${errorMessage(err)}`);
  }
}
