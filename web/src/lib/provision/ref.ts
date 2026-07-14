// lib/provision/ref.ts
// Derives the Supabase project ref from a Supabase URL host.
//
// Example: 'https://abcxyz123.supabase.co' → 'abcxyz123'
//
// INVARIANT: this module MUST NOT import runtime-config.ts or service.ts.
// It constructs values from environment variables directly or from a
// caller-supplied URL, so it is safe to use before DB is initialized.

/**
 * Extract the project ref from a Supabase URL.
 *
 * @param supabaseUrl - Optional override. Defaults to NEXT_PUBLIC_SUPABASE_URL.
 * @returns The project ref (first segment of the host before .supabase.co).
 * @throws Error if the URL is missing or the format is unexpected.
 */
export function getRef(supabaseUrl?: string): string {
  const url = supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL not set — cannot derive Supabase project ref"
    );
  }

  try {
    const { hostname } = new URL(url);
    // hostname is e.g. 'abcxyz123.supabase.co'
    const ref = hostname.split(".")[0];
    if (!ref) {
      throw new Error(`Unexpected Supabase URL format: ${url}`);
    }
    return ref;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Unexpected")) throw err;
    throw new Error(`Invalid Supabase URL: ${url}`);
  }
}
