import { useState } from "react";
import { motion } from "framer-motion";
import { LockKeyhole, ShieldCheck, Zap } from "lucide-react";
import { Button, Card } from "@/components/ui";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/components/AuthProvider";
import { HttpError } from "@/lib/http";

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin123");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await login(username, password);
    } catch (err) {
      if (err instanceof HttpError) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Login failed");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-10">
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
        className="w-full max-w-5xl"
      >
        <div className="grid gap-8 lg:grid-cols-[0.5fr_520px]">
          <div>
            
           
            
           
          </div>

          <Card className="overflow-hidden border-primary/10 bg-card/80">
            <div className="border-b border-border/60 px-7 py-6">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-tr from-primary to-blue-500 text-primary-foreground shadow-[0_0_24px_rgba(6,182,212,0.28)]">
                  <Zap className="h-5 w-5" fill="currentColor" />
                </div>
                <div>
                  <div className="text-lg font-display font-bold text-foreground">Account Login</div>
                  <div className="text-sm text-muted-foreground">Enter your configured credentials</div>
                </div>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5 px-7 py-7">
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  Username
                </label>
                <Input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="Username"
                  autoComplete="username"
                  disabled={isSubmitting}
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
                  Password
                </label>
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Password"
                  autoComplete="current-password"
                  disabled={isSubmitting}
                />
              </div>

              {error ? (
                <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <Button type="submit" className="h-12 w-full gap-2 text-base" disabled={isSubmitting}>
                <LockKeyhole className="h-4 w-4" />
                {isSubmitting ? "Signing In..." : "Sign In"}
              </Button>
            </form>
          </Card>
        </div>
      </motion.div>
    </div>
  );
}
