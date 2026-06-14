// Shared helpers for API route handlers.

export function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Normalize unknown thrown values into a readable message. Walks the `.cause`
 * chain so wrapped errors never hide the real failure — e.g. the Unlink SDK's
 * `CapabilityError("token provider failed")` carries the actual engine error
 * (HTTP status/body) in `.cause`, which is the part we actually need to see.
 */
export function errorMessage(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.length > 0 ? parts.join(" — caused by: ") : String(err);
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
