"use client";

import { useState } from "react";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const supabase = createSupabaseBrowserClient();
    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
    });

    setIsSubmitting(false);

    if (signUpError) {
      setError(signUpError.message);
      return;
    }

    // Workspace creation for new users happens server-side in Phase 1's
    // dashboard bootstrap (see app/dashboard/page.tsx), not here, so that a
    // partially-completed sign-up never leaves an orphaned workspace.
    setSuccess(true);
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Verifique seu e-mail</CardTitle>
            <CardDescription>
              Enviamos um link de confirmação para {email}.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Criar conta</CardTitle>
          <CardDescription>Comece a usar a plataforma</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">E-mail</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Senha</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Criando..." : "Criar conta"}
            </Button>
          </form>
          <div className="mt-4 text-sm text-muted-foreground">
            <Link href="/login" className="hover:underline">
              Já tenho uma conta
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
