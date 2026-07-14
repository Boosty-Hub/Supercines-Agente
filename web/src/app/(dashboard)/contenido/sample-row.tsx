"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, ConfirmDialog } from "@/components/ui";

export default function SampleRow({
  id,
  type,
  title,
  chunkCount,
  ingestedAt,
}: {
  id: string;
  type: string;
  title: string;
  chunkCount: number;
  ingestedAt: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    const res = await fetch(`/api/voz/sample/${id}`, { method: "DELETE" });
    setDeleting(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "error");
      setConfirming(false);
      return;
    }
    setConfirming(false);
    startTransition(() => router.refresh());
  }

  return (
    <tr className={"hover:bg-neutral-50 " + (pending ? "opacity-50" : "")}>
      <td className="px-4 py-3">
        <Badge color="neutral">{type}</Badge>
      </td>
      <td className="px-4 py-3 font-medium text-neutral-900">{title}</td>
      <td className="px-4 py-3 text-neutral-600">{chunkCount}</td>
      <td className="px-4 py-3 text-neutral-600">
        {ingestedAt ? new Date(ingestedAt).toLocaleString() : "—"}
      </td>
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-4">
          <a
            href={`/api/voz/sample/${id}`}
            download
            className="text-xs font-medium text-neutral-700 transition-colors hover:text-neutral-900 hover:underline"
          >
            Descargar
          </a>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(true)}
            disabled={pending}
            className="text-red-600 hover:text-red-700"
          >
            Borrar
          </Button>
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
        <ConfirmDialog
          open={confirming}
          title={`Borrar muestra de voz`}
          description={`Se eliminarán "${title}" y sus ${chunkCount} fragmentos de memoria. Esta acción no se puede deshacer.`}
          confirmLabel="Borrar"
          tone="danger"
          busy={deleting}
          onConfirm={handleDelete}
          onCancel={() => setConfirming(false)}
        />
      </td>
    </tr>
  );
}
