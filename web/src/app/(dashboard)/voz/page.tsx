import { redirect } from "next/navigation";

export default function VozRedirect() {
  redirect("/contenido?tab=voz");
}
