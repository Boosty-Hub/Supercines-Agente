import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { userDeps } from "@/lib/users/admin";
import { applyUserDelete, applyUserUpdate, validatePatch } from "@/lib/users/mutations";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// La forma de cada campo la valida validatePatch (lib/users/mutations.ts, con tests y mensajes
// propios); acá se garantiza un objeto. password nunca aparece en un mensaje de error.
const UserPatchBody = z.object({ scope: z.unknown(), role: z.unknown(), password: z.unknown() });

export const runtime = "nodejs";

// Ver /api/users/route.ts: el middleware ya gatea este prefijo; esto es la segunda capa porque
// abajo se escribe con service-role. Bajar el alcance o borrar revoca las sesiones del usuario
// (lib/users/mutations.ts).

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  const input = await readJson(request, UserPatchBody);
  if (!input.ok) return input.response;
  const body = input.data;
  const v = validatePatch(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });

  try {
    const r = await applyUserUpdate(userDeps, { actorId: auth.user.id, targetId: params.id, patch: v.patch });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true, user: r.user, revoked: r.revoked });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  try {
    const r = await applyUserDelete(userDeps, { actorId: auth.user.id, targetId: params.id });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
