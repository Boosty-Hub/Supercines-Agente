import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getScope } from "@/lib/auth/roles";
import { listUsers, type ManagedUser } from "@/lib/users/admin";
import { PageShell } from "@/components/ui";
import UsersTable from "./users-table";

export const dynamic = "force-dynamic";

export default async function UsuariosPage() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Defensa en profundidad: el middleware ya exige alcance `configuracion` para
  // /usuarios, pero esta página lista usuarios con la service-role key.
  if (!user || getScope(user) !== "configuracion") redirect("/inbox");

  let users: ManagedUser[] = [];
  let loadError: string | null = null;
  try {
    users = await listUsers();
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  return (
    <PageShell
      title="Usuarios"
      description="Quién puede entrar al panel y hasta dónde. Los alcances son acumulativos: Operación atiende conversaciones; Contenido agrega contenido y calidad; Administrador agrega credenciales, encendido del agente y esta misma pantalla."
    >
      <UsersTable initialUsers={users} currentUserId={user.id} loadError={loadError} />
    </PageShell>
  );
}
