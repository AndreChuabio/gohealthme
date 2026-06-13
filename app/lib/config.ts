/**
 * Build-time client configuration. NEXT_PUBLIC_ values are inlined by Next
 * at build time, so these flags let components render visible configuration
 * errors instead of crashing when an integration is not wired up yet.
 */

export const DYNAMIC_CONFIGURED: boolean =
  (process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID ?? "") !== "";

const rawWorldAppId = process.env.NEXT_PUBLIC_WORLD_APP_ID ?? "";

export const WORLD_APP_ID: `app_${string}` | null = rawWorldAppId.startsWith(
  "app_",
)
  ? (rawWorldAppId as `app_${string}`)
  : null;

export const WORLD_ACTION_ID: string =
  process.env.NEXT_PUBLIC_WORLD_ACTION_ID ?? "join-pool";
