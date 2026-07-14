import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageShell, EmptyState } from "@/components/ui";
import { VerticalRow, NewVerticalForm } from "./vertical-editor";

export const dynamic = "force-dynamic";

type Vertical = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  system_prompt: string;
  auto_reply: boolean;
  requires_review: boolean;
  ignore: boolean;
};

export default async function VerticalesPage() {
  const supabase = createSupabaseServerClient();
  const { data: verticals } = await supabase
    .from("verticals")
    .select("id, slug, name, description, system_prompt, auto_reply, requires_review, ignore")
    .order("slug");

  const verticalList = (verticals ?? []) as Vertical[];

  return (
    <PageShell
      title="Verticales"
      description="Categorías de mensajes. El clasificador usa la descripción para asignar la vertical; el agente usa el prompt específico como instrucción por vertical."
      actions={<NewVerticalForm />}
    >
      {verticalList.length === 0 ? (
        <EmptyState
          title="Sin verticales configuradas"
          description="Agregá una vertical para que el clasificador pueda categorizar los mensajes entrantes."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="sticky top-0 bg-neutral-50/60 text-left">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Identificador</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Nombre</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Respuesta automática</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Revisión humana</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">No clasificar</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400 text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {verticalList.map((v) => (
                  <VerticalRow key={v.id} vertical={v} />
                ))}
              </tbody>
            </table>
          </div>
          {/* Pie de tabla */}
          <div className="border-t border-neutral-100 px-4 py-2.5 text-xs text-neutral-500">
            {verticalList.length} {verticalList.length === 1 ? "vertical" : "verticales"} en total
          </div>
        </div>
      )}
    </PageShell>
  );
}
