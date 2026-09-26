"use client";

import { useState } from "react";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { publicEnv } from "@/lib/env";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function ResetPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const supabase = createSupabaseBrowserClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(
      email,
      { redirectTo: `${publicEnv.NEXT_PUBLIC_APP_URL}/dashboard` }
    );

    setIsSubmitting(false);

    if (resetError) {
      setError(resetError.message);
      return;
    }

    setSent(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Recuperar senha</CardTitle>
          <CardDescription>
            Enviaremos um link para redefinir sua senha
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <p className="text-sm text-muted-foreground">
              Se existir uma conta com o e-mail {email}, você receberá um link em breve.
            </p>
          ) : (
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
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Enviando..." : "Enviar link"}
              </Button>
            </form>
          )}
          <div className="mt-4 text-sm text-muted-foreground">
            <Link href="/login" className="hover:underline">
              Voltar para o login
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
