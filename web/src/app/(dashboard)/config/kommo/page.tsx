// La configuración de Kommo se unificó en Ajustes → Conexiones.

import { redirect } from "next/navigation";

export default function KommoRedirect() {
  redirect("/settings?tab=conexiones");
}
