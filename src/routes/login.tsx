import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({ component: LoginPage });

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) return toast.error(error.message);
    navigate({ to: "/dashboard" });
  };

  const onGoogle = async () => {
    const result = await lovable.auth.signInWithOAuth("google", { redirect_uri: window.location.origin + "/dashboard" });
    if (result.error) toast.error(result.error.message);
    if (!result.redirected && !result.error) navigate({ to: "/dashboard" });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <Link to="/" className="inline-flex items-center gap-2 font-semibold">
            <div className="size-8 rounded-lg" style={{ background: "var(--gradient-primary)" }} />
            NiNi Digital Solutions
          </Link>
          <h1 className="mt-6 text-2xl font-semibold">Welcome back</h1>
        </div>
        <Button variant="outline" className="w-full" onClick={onGoogle}>Continue with Google</Button>
        <div className="relative text-center text-xs text-muted-foreground"><span className="bg-background px-2 relative z-10">or</span><div className="absolute inset-x-0 top-1/2 h-px bg-border" /></div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div><Label htmlFor="email">Email</Label><Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div><Label htmlFor="password">Password</Label><Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          <Button type="submit" className="w-full" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</Button>
        </form>
        <p className="text-center text-sm text-muted-foreground">No account? <Link to="/signup" className="text-primary hover:underline">Sign up</Link></p>
      </div>
    </div>
  );
}