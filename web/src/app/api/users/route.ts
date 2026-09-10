import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getScope, isScope, type Scope } from "@/lib/auth/roles";
import { listUsers, createUser } from "@/lib/users/admin";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Defensa en profundidad: el middleware ya exige alcance `configuracion` para
// /api/users, pero esta ruta escribe con la service-role key (bypassa RLS) y no
// puede depender de que un solo gate esté bien configurado.
async function requireConfiguracion() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (getScope(user) !== "configuracion")
    return {
      error: NextResponse.json({ error: "forbidden: requiere alcance configuracion" }, { status: 403 }),
    };
  return { user };
}

export async function GET() {
  const gate = await requireConfiguracion();
  if (gate.error) return gate.error;
  try {
    const users = await listUsers();
    return NextResponse.json({ users });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const gate = await requireConfiguracion();
  if (gate.error) return gate.error;

  let body: { email?: unknown; password?: unknown; scope?: unknown; role?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");

  // `role` se acepta como alias heredado para no romper a quien llame esta API
  // con el vocabulario viejo. Nada nuevo lo escribe.
  const pedido = body.scope ?? body.role;
  let scope: Scope;
  if (isScope(pedido)) scope = pedido;
  else if (pedido === "admin") scope = "configuracion";
  else if (pedido === "editor") scope = "contenido";
  else
    return NextResponse.json(
      { error: "scope debe ser 'operacion', 'contenido' o 'configuracion'" },
      { status: 400 }
    );

  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Email inválido" }, { status: 400 });
  if (password.length < 8)
    return NextResponse.json({ error: "La contraseña debe tener al menos 8 caracteres" }, { status: 400 });

  try {
    const user = await createUser(email, password, scope);
    return NextResponse.json({ ok: true, user });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
