// INVARIANT: this route MUST NOT import @/lib/runtime-config or
// @/lib/supabase/service. It uses the provision lib layer only.
// INVARIANT: email_confirm:true must always be passed to createUser.
// INVARIANT: 409 returned if any user already exists (first-run lock).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { listUsersHead, createUser } from "@/lib/provision/admin";

// ─── Simple email format check ────────────────────────────────────────────────
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function POST(request: Request): Promise<NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { ok: false, error: "Supabase env not configured" },
      { status: 503 }
    );
  }

  let body: { email?: string; password?: string; confirm?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const confirm = typeof body.confirm === "string" ? body.confirm : "";

  // ── Server-side validation ────────────────────────────────────────────────
  const fieldErrors: Record<string, string> = {};

  if (!email || !isValidEmail(email)) {
    fieldErrors.email = "Email inválido";
  }

  if (!password || password.length < 8) {
    fieldErrors.password = "La contraseña debe tener al menos 8 caracteres";
  }

  if (password !== confirm) {
    fieldErrors.confirm = "Las contraseñas no coinciden";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(
      { ok: false, fieldErrors },
      { status: 400 }
    );
  }

  // ── First-run lock: reject if any user already exists ────────────────────
  try {
    const page = await listUsersHead(supabaseUrl, serviceRoleKey);
    if (page.users.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "Ya existe un usuario. El registro está cerrado.",
        },
        { status: 409 }
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `Error verificando usuarios existentes: ${msg}` },
      { status: 502 }
    );
  }

  // ── Create user ────────────────────────────────────────────────────────────
  // email_confirm:true is enforced inside createUser() (INVARIANT)
  try {
    await createUser(supabaseUrl, serviceRoleKey, email, password);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[provision/register] Error creating user:", msg);
    return NextResponse.json(
      { ok: false, error: `Error al crear el usuario: ${msg}` },
      { status: 502 }
    );
  }
}
