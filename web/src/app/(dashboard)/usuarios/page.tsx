import { requirePageScope } from "@/lib/auth/require-scope";
import { listUsers, type ManagedUser } from "@/lib/users/admin";
import { PageShell } from "@/components/ui";
import UsersTable from "./users-table";
import { SIN_ACCESO } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

export default async function UsuariosPage() {
  // Defensa en profundidad: el middleware ya exige alcance `configuracion` para
  // /usuarios, pero esta página lista usuarios con la service-role key.
  const { user } = await requirePageScope("configuracion");

  let users: ManagedUser[] = [];
  let loadError: string | null = null;
  try {
    users = await listUsers();
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e);
  }

  const sinAcceso = users.filter((u) => u.scope === SIN_ACCESO);

  return (
    <PageShell
      title="Usuarios"
      description="Quién puede entrar al panel y hasta dónde. Los alcances son acumulativos: Operación atiende conversaciones; Contenido agrega contenido y calidad; Administrador agrega credenciales, encendido del agente y esta misma pantalla."
    >
      {sinAcceso.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-medium">
            {sinAcceso.length === 1 ? "Hay 1 usuario sin acceso" : `Hay ${sinAcceso.length} usuarios sin acceso`}: no tienen rol
            asignado, así que no pueden entrar a nada del panel.
          </p>
          <p className="mt-1">
            Asignales un alcance si los reconocés. Si no los reconocés (por ejemplo, cuentas creadas por un registro
            público que estuvo abierto), borralos.
          </p>
        </div>
      )}
      <UsersTable initialUsers={users} currentUserId={user.id} loadError={loadError} />
    </PageShell>
  );
}
