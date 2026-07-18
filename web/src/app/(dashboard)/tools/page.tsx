// Las herramientas se unificaron en Ajustes → Herramientas.

import { redirect } from "next/navigation";

export default function ToolsRedirect() {
  redirect("/settings?tab=herramientas");
}
