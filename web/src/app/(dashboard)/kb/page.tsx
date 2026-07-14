import { redirect } from "next/navigation";

export default function KBRedirect() {
  redirect("/contenido?tab=kb");
}
