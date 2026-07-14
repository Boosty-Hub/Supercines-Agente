import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getRole, type Role } from "@/lib/auth/roles";
import { listUsers, updateUser, deleteUser } from "@/lib/users/admin";

export const runtime = "nodejs";

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

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  let body: { role?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const patch: { role?: Role; password?: string } = {};
  if (body.role !== undefined) {
    if (body.role !== "admin" && body.role !== "editor")
      return NextResponse.json({ error: "role debe ser 'admin' o 'editor'" }, { status: 400 });
    patch.role = body.role;
  }
  if (body.password !== undefined) {
    const pw = String(body.password);
    if (pw.length < 8)
      return NextResponse.json({ error: "La contraseña debe tener al menos 8 caracteres" }, { status: 400 });
    patch.password = pw;
  }
  if (patch.role === undefined && patch.password === undefined)
    return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });

  // Guard: no dejar el sistema sin admins al degradar al último admin.
  if (patch.role === "editor") {
    const users = await listUsers();
    const target = users.find((u) => u.id === params.id);
    const admins = users.filter((u) => u.role === "admin");
    if (target?.role === "admin" && admins.length <= 1)
      return NextResponse.json({ error: "No podés degradar al último admin" }, { status: 400 });
  }

  try {
    const user = await updateUser(params.id, patch);
    return NextResponse.json({ ok: true, user });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  // Guard: no auto-borrado ni borrar al último admin.
  if (gate.user!.id === params.id)
    return NextResponse.json({ error: "No podés borrarte a vos mismo" }, { status: 400 });

  const users = await listUsers();
  const target = users.find((u) => u.id === params.id);
  const admins = users.filter((u) => u.role === "admin");
  if (target?.role === "admin" && admins.length <= 1)
    return NextResponse.json({ error: "No podés borrar al último admin" }, { status: 400 });

  try {
    await deleteUser(params.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
