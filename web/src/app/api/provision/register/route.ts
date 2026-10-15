// INVARIANT: this route MUST NOT import @/lib/runtime-config or
// @/lib/supabase/service. It uses the provision lib layer only.
// INVARIANT: email_confirm:true must always be passed to createMasterUser.
// INVARIANT: 409 returned if any user already exists (first-run lock).
// INVARIANT: el maestro nace con app_metadata.role = "configuracion" (createMasterUser) y, recién
// creado, se CIERRA el registro público de Supabase Auth (disable_signup) y se verifica.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { listUsersHead, createMasterUser } from "@/lib/provision/admin";
import { provisionRef, RECOVERY_HINT } from "@/lib/provision/gate-logic";
import { claimProvisioned, releaseProvisioned } from "@/lib/provision/provisioned";
import { validateProjectToken } from "@/lib/provision/project-token";
import { lockPublicSignup, SIGNUP_LOCK_MANUAL_STEP } from "@/lib/provision/signup-lock";
import { z } from "zod";
import { readJson } from "@/lib/api/body";

// Contraseña y token sbp_: secretos; los errores de forma nunca incluyen sus valores.
const RegisterBody = z.object({
  email: z.string().optional(),
  password: z.string().optional(),
  confirm: z.string().optional(),
  accessToken: z.string().optional(),
});

// ─── Simple email format check ────────────────────────────────────────────────
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function POST(request: Request): Promise<Response> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { ok: false, error: "Supabase env not configured" },
      { status: 503 }
    );
  }

  const input = await readJson(request, RegisterBody);
  if (!input.ok) return input.response;
  const body = input.data;

  const email = body.email?.trim() ?? "";
  const password = body.password ?? "";
  const confirm = body.confirm ?? "";
  // El token sbp_ que el wizard acaba de recibir (paso Inicializar): con él se cierra el registro
  // público. Es el del body, nunca el guardado: esta ruta corre sin sesión.
  const accessToken = body.accessToken?.trim() ?? "";

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

  if (!accessToken) {
    fieldErrors.accessToken = "Pegá tu token de Supabase (sbp_…): con él se cierra el registro público";
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

  // ── Secreto de arranque: el token sbp_ de la cuenta DUEÑA de este proyecto ─────
  // En un despliegue recién creado cualquiera podría llamar esta ruta antes que el operador y
  // quedarse con el panel como maestro. Solo quien tiene acceso al proyecto de Supabase tiene un
  // token con el que la Management API pueda LEER este ref (el ref sale de NEXT_PUBLIC_SUPABASE_URL,
  // nunca del body). Un token ajeno o inventado no pasa: 403, sin crear nada.
  const ref = provisionRef(supabaseUrl);
  const tokenCheck = await validateProjectToken(ref, accessToken);
  if (!tokenCheck.ok) {
    return NextResponse.json({ ok: false, error: tokenCheck.error }, { status: tokenCheck.status });
  }

  // ── Marcador «provisionada»: se RECLAMA de forma atómica antes de crear al maestro ───────────
  // (clave primaria en _app_secrets): dos registros concurrentes no pueden crear dos maestros, y una
  // instalación ya provisionada que quedó sin usuarios NO se reabre desde acá (recuperación manual).
  const claim = await claimProvisioned(supabaseUrl, serviceRoleKey);
  if (!claim.ok) {
    if (claim.reason === "already") {
      return NextResponse.json({ ok: false, error: `Esta instalación ya fue provisionada. ${RECOVERY_HINT}` }, { status: 409 });
    }
    return NextResponse.json(
      {
        ok: false,
        error:
          claim.reason === "no-table"
            ? "Todavía no se aplicaron las migraciones: completá el paso «Inicializar» antes de crear el usuario."
            : `No se pudo reservar el primer arranque: ${claim.error ?? "error desconocido"}`,
      },
      { status: claim.reason === "no-table" ? 409 : 502 }
    );
  }

  // ── Create user ────────────────────────────────────────────────────────────
  // email_confirm:true y role=configuracion los fija createMasterUser() (INVARIANT)
  try {
    await createMasterUser(supabaseUrl, serviceRoleKey, email, password);
  } catch (err) {
    // El maestro no se creó: se libera el marcador para que el operador pueda reintentar.
    await releaseProvisioned(supabaseUrl, serviceRoleKey);
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[provision/register] Error creating user:", msg);
    return NextResponse.json(
      { ok: false, error: `Error al crear el usuario: ${msg}` },
      { status: 502 }
    );
  }

  // ── Cerrar el registro público (y verificarlo) ─────────────────────────────
  // El usuario ya existe: si esto falla NO se deshace el alta, pero tampoco se calla. La respuesta
  // lo marca y el wizard muestra el paso manual antes de seguir; health-scan abre además el
  // incidente `registro_abierto` mientras siga abierto.
  const lock = await lockPublicSignup(ref, accessToken);
  if (!lock.ok) {
    console.error("[provision/register] signup lock failed:", lock.error);
    return NextResponse.json({
      ok: true,
      signupDisabled: false,
      signupError: lock.error,
      manualStep: SIGNUP_LOCK_MANUAL_STEP,
    });
  }
  return NextResponse.json({ ok: true, signupDisabled: true });
}
