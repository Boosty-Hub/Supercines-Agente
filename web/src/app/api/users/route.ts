import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getRole, type Role } from "@/lib/auth/roles";
import { listUsers, createUser } from "@/lib/users/admin";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requireAdmin() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (getRole(user) !== "admin")
    return { error: NextResponse.json({ error: "forbidden: requiere rol admin" }, { status: 403 }) };
  return { user };
}

export async function GET() {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  try {
    const users = await listUsers();
    return NextResponse.json({ users });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  let body: { email?: unknown; password?: unknown; role?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const role: Role = body.role === "editor" ? "editor" : "admin";

  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Email inválido" }, { status: 400 });
  if (password.length < 8)
    return NextResponse.json({ error: "La contraseña debe tener al menos 8 caracteres" }, { status: 400 });

  try {
    const user = await createUser(email, password, role);
    return NextResponse.json({ ok: true, user });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
