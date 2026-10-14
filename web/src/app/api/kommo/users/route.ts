import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { fetchUsers } from "@/lib/kommo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  try {
    const { configured, users } = await fetchUsers();
    return NextResponse.json({ ok: true, configured, users });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
