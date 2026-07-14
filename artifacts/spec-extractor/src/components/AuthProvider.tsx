import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import { fetchJson } from "@/lib/http";

type SessionResponse = {
  authenticated: true;
  username: string;
  sessionTtlMs: number;
};

type AuthContextValue = {
  isAuthenticated: boolean;
  isLoading: boolean;
  username: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [isLoading, setIsLoading] = useState(true);
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    setAuthTokenGetter(null);
  }, []);

  useEffect(() => {
    let active = true;

    fetchJson<SessionResponse>("/api/auth/session")
      .then((session) => {
        if (!active) return;
        setUsername(session.username);
        setIsLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setUsername(null);
        setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const login = async (nextUsername: string, password: string) => {
    const session = await fetchJson<SessionResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: nextUsername, password }),
    });
    queryClient.clear();
    setUsername(session.username);
  };

  const logout = async () => {
    try {
      await fetchJson("/api/auth/logout", { method: "POST" });
    } catch {
      // Clear the local session state even if the server-side logout request fails.
    } finally {
      queryClient.clear();
      setUsername(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: Boolean(username),
        isLoading,
        username,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }

  return context;
}
