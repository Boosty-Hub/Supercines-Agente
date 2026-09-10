import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getScope, isScope, type Scope } from "@/lib/auth/roles";
import { listUsers, updateUser, deleteUser } from "@/lib/users/admin";

export const runtime = "nodejs";

// Ver la nota de /api/users/route.ts: el middleware ya gatea este prefijo, esto
// es la segunda capa porque abajo se escribe con service-role.
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

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const gate = await requireConfiguracion();
  if (gate.error) return gate.error;

  let body: { scope?: unknown; role?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const patch: { scope?: Scope; password?: string } = {};

  const pedido = body.scope ?? body.role;
  if (pedido !== undefined) {
    if (isScope(pedido)) patch.scope = pedido;
    else if (pedido === "admin") patch.scope = "configuracion";
    else if (pedido === "editor") patch.scope = "contenido";
    else
      return NextResponse.json(
        { error: "scope debe ser 'operacion', 'contenido' o 'configuracion'" },
        { status: 400 }
      );
  }

  if (body.password !== undefined) {
    const pw = String(body.password);
    if (pw.length < 8)
      return NextResponse.json({ error: "La contraseña debe tener al menos 8 caracteres" }, { status: 400 });
    patch.password = pw;
  }
  if (patch.scope === undefined && patch.password === undefined)
    return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });

  if (patch.scope !== undefined && patch.scope !== "configuracion") {
    // No auto-degradarse: quien se baja el alcance a sí mismo pierde el acceso
    // a esta misma pantalla en el siguiente request y no puede deshacerlo.
    if (gate.user!.id === params.id)
      return NextResponse.json({ error: "No podés bajarte el alcance a vos mismo" }, { status: 400 });

    // No dejar el panel sin nadie que pueda entrar a Configuración: sin eso, la
    // única salida sería la Admin API de Supabase con la service-role key.
    const users = await listUsers();
    const target = users.find((u) => u.id === params.id);
    const admins = users.filter((u) => u.scope === "configuracion");
    if (target?.scope === "configuracion" && admins.length <= 1)
      return NextResponse.json(
        { error: "No podés degradar al último administrador" },
        { status: 400 }
      );
  }

  try {
    const user = await updateUser(params.id, patch);
    return NextResponse.json({ ok: true, user });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const gate = await requireConfiguracion();
  if (gate.error) return gate.error;

  // Guard: no auto-borrado ni borrar al último con alcance configuracion.
  if (gate.user!.id === params.id)
    return NextResponse.json({ error: "No podés borrarte a vos mismo" }, { status: 400 });

  const users = await listUsers();
  const target = users.find((u) => u.id === params.id);
  const admins = users.filter((u) => u.scope === "configuracion");
  if (target?.scope === "configuracion" && admins.length <= 1)
    return NextResponse.json({ error: "No podés borrar al último administrador" }, { status: 400 });

  try {
    await deleteUser(params.id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
