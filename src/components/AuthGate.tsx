import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";

export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="grid-backdrop flex min-h-screen items-center justify-center bg-background px-4">
        <form
          className="console-panel w-full max-w-sm space-y-4 p-6"
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            const { error } = await supabase.auth.signInWithPassword({ email, password });
            setLoading(false);
            if (error) toast.error(error.message);
          }}
        >
          <div>
            <h1 className="font-display text-lg font-semibold">SWOT·TOWS Strategy Console</h1>
            <p className="mt-1 text-sm text-muted-foreground">Sign in to continue.</p>
          </div>
          <div className="space-y-1.5">
            <p className="label-caps">Email</p>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              placeholder="jane.smith@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <p className="label-caps">Password</p>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="size-3.5 animate-spin" />}
            Sign in
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            Demo accounts share the password <span className="font-mono">SwotDemo2026!</span> — try
            jane.smith@example.com
          </p>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}
