// Página de quien tiene sesión pero NINGÚN alcance (usuario sin rol: ver «SIN ROL = SIN ACCESO»
// en lib/auth/roles.ts). El middleware no le deja ver otra cosa; acá solo puede cerrar sesión.
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getScope, SIN_ACCESO } from "@/lib/auth/roles";
import { Button } from "@/components/ui/button";
import { rolesMigrationApplied } from "@/lib/provision/gate";
import { LegacyUpdate } from "./legacy-update";

export const dynamic = "force-dynamic";

export default async function SinAccesoPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (getScope(user) !== SIN_ACCESO) redirect("/inbox");

  // Transición: sin la migración de roles aplicada, el maestro viejo (sin rol) puede aplicarla.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const legacy = url && key ? (await rolesMigrationApplied(url, key)) === false : false;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-50 p-6">
      <div className="w-full max-w-sm space-y-4 rounded-2xl border border-neutral-200 bg-white p-8 shadow-modal">
        <div className="space-y-1">
          <h1 className="text-[15px] font-semibold tracking-tight text-neutral-900">Tu usuario no tiene acceso</h1>
          <p className="text-sm text-neutral-500">
            Iniciaste sesión como <span className="font-medium text-neutral-700">{user.email}</span>, pero nadie te
            asignó un alcance. Pedile a un administrador que te lo asigne en Usuarios.
          </p>
        </div>
        {legacy && <LegacyUpdate />}
        <form action="/auth/signout" method="post">
          <Button type="submit" className="w-full justify-center">
            Cerrar sesión
          </Button>
        </form>
      </div>
    </main>
  );
}
