// lib/provision/management.ts
// Supabase Management API client helpers.
//
// All functions use plain fetch with a Bearer token from a Supabase Personal
// Access Token (PAT). This module MUST NOT import runtime-config.ts or
// service.ts — it is called from provision routes that run before or
// independently of the full app config.

const MGMT_BASE = "https://api.supabase.com";

// ─── QUERY ───────────────────────────────────────────────────────────────────

/**
 * Run a SQL query against a Supabase project via the Management API.
 */
export async function runQuery(
  ref: string,
  token: string,
  sql: string
): Promise<unknown> {
  const res = await fetch(
    `${MGMT_BASE}/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: sql }),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Management API query failed (${res.status}): ${text}`
    );
  }

  return res.json();
}

// ─── FUNCTIONS LIST ──────────────────────────────────────────────────────────

export interface MgmtFunction {
  id: string;
  slug: string;
  name: string;
  status: string;
  verify_jwt: boolean;
  version: number;
}

/**
 * List all Edge Functions deployed in a project.
 */
export async function listFunctions(
  ref: string,
  token: string
): Promise<MgmtFunction[]> {
  const res = await fetch(`${MGMT_BASE}/v1/projects/${ref}/functions`, {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Management API listFunctions failed (${res.status}): ${text}`
    );
  }

  return res.json() as Promise<MgmtFunction[]>;
}

// ─── DEPLOY FUNCTION ─────────────────────────────────────────────────────────

export interface FunctionFile {
  path: string;
  body: string;
}

/**
 * Deploy (or redeploy) a single Edge Function via multipart FormData.
 *
 * INVARIANT: verify_jwt is ALWAYS false in the metadata — Kommo and cron
 * callers post without JWT. config.toml enforces this for CLI deploys; here
 * we enforce it programmatically for in-app deploys.
 */
export async function deployFunction(
  ref: string,
  token: string,
  slug: string,
  files: FunctionFile[],
  entrypoint: string
): Promise<unknown> {
  const form = new FormData();

  // Metadata part — verify_jwt: false is the critical invariant
  const metadata = {
    name: slug,
    entrypoint_path: entrypoint,
    verify_jwt: false, // INVARIANT: always false
  };
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" })
  );

  // File parts — each file is a Blob with type application/typescript
  for (const file of files) {
    form.append(
      "file",
      new Blob([file.body], { type: "application/typescript" }),
      file.path
    );
  }

  const res = await fetch(
    `${MGMT_BASE}/v1/projects/${ref}/functions/deploy?slug=${encodeURIComponent(slug)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        // NOTE: do NOT set Content-Type manually — fetch sets multipart boundary automatically
      },
      body: form,
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Management API deployFunction '${slug}' failed (${res.status}): ${text}`
    );
  }

  return res.json();
}
