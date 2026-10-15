import { NextResponse } from "next/server";
import { requireScope } from "@/lib/auth/require-scope";
import { listUsers, createUser } from "@/lib/users/admin";
import { validateCreate } from "@/lib/users/mutations";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// La forma de cada campo la valida validateCreate (lib/users/mutations.ts, con tests y mensajes
// propios); acá se garantiza un objeto. password nunca aparece en un mensaje de error.
const UserCreateBody = z.object({ email: z.unknown(), password: z.unknown(), scope: z.unknown(), role: z.unknown() });

export const runtime = "nodejs";

// Defensa en profundidad: el middleware ya exige alcance `configuracion` para /api/users, pero
// esta ruta escribe con la service-role key (bypassa RLS) y no puede depender de un solo gate.

export async function GET() {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;
  try {
    const users = await listUsers();
    return NextResponse.json({ users });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireScope("configuracion");
  if (!auth.ok) return auth.response;

  const input = await readJson(request, UserCreateBody);
  if (!input.ok) return input.response;
  const body = input.data;

  // El alcance es obligatorio: un usuario sin rol no entra a nada (lib/auth/roles.ts).
  const v = validateCreate(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });

  try {
    const user = await createUser(v.email, v.password, v.scope);
    return NextResponse.json({ ok: true, user });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
