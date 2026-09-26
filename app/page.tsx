import { redirect } from "next/navigation";

export default function RootPage() {
  // Middleware already redirects unauthenticated visitors away from
  // /dashboard, so it's safe to always point "/" there.
  redirect("/dashboard");
}
