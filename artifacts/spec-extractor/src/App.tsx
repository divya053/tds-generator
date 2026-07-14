import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/Layout";
import { AuthProvider, useAuth } from "@/components/AuthProvider";
import Home from "@/pages/Home";
import LoginPage from "@/pages/Login";
import SpecDetail from "@/pages/SpecDetail";

// Configure react-query client with reasonable defaults
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5 * 60 * 1000,
    },
  },
});

function Router() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-16 w-16 rounded-full border-t-2 border-primary animate-spin" />
          <div className="text-sm font-medium uppercase tracking-[0.24em] text-muted-foreground">
            Loading Session
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <Layout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/spec/:id" component={SpecDetail} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
      </AuthProvider>
      <Toaster 
        theme="dark" 
        position="bottom-right"
        toastOptions={{
          className: "bg-card border-border/80 text-foreground font-sans rounded-xl shadow-2xl",
        }} 
      />
    </QueryClientProvider>
  );
}

export default App;
