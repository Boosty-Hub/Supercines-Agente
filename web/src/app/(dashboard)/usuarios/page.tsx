import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getRole } from "@/lib/auth/roles";
import { listUsers, type ManagedUser } from "@/lib/users/admin";
import { PageShell } from "@/components/ui";
import UsersTable from "./users-table";

export const dynamic = "force-dynamic";

export default async function UsuariosPage() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Defensa en profundidad: el middleware ya bloquea a los editores, pero re-chequeamos.
  if (!user || getRole(user) !== "admin") redirect("/inbox");

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
      description="Quién puede entrar al panel. Los admin ven todo; los editores operan (Inbox, Leads, drafts) y editan contenido, pero no tocan credenciales, encendido del agente ni usuarios."
    >
      <UsersTable initialUsers={users} currentUserId={user.id} loadError={loadError} />
    </PageShell>
  );
}
