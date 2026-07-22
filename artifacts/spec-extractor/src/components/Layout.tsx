import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { FileText, Plus, Trash2, Zap, History, LogOut, PanelLeftClose, PanelLeftOpen, Menu, X } from "lucide-react";
import { useGetExtractionHistory, useDeleteExtraction, getGetExtractionHistoryQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { cn, formatDate } from "@/lib/utils";
import { draftKey, deleteDraft } from "@/lib/draft-store";
import { toast } from "sonner";
import { useAuth } from "./AuthProvider";
import { Button } from "./ui";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const { data: history, isLoading, error } = useGetExtractionHistory();
  const { mutate: deleteDoc, isPending: isDeleting } = useDeleteExtraction();
  const { username, logout } = useAuth();
  const queryClient = useQueryClient();
  const isSpecWorkspace = /^\/spec\/\d+/.test(location);
  const storageKey = isSpecWorkspace ? "ikio-sidebar-hidden-spec" : "ikio-sidebar-hidden-general";
  const [isSidebarHidden, setIsSidebarHidden] = useState(isSpecWorkspace);
  // Off-canvas drawer state for small screens (below md). Desktop uses isSidebarHidden.
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  useEffect(() => {
    if (error && typeof error === "object" && "status" in error && error.status === 401) {
      void logout();
    }
  }, [error, logout]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const savedState = window.localStorage.getItem(storageKey);
    if (savedState === null) {
      setIsSidebarHidden(isSpecWorkspace);
      return;
    }

    setIsSidebarHidden(savedState === "true");
  }, [isSpecWorkspace, storageKey]);

  // Close the mobile drawer whenever the route changes (e.g. after picking a doc).
  useEffect(() => {
    setIsMobileOpen(false);
  }, [location]);

  // Prevent the page behind the drawer from scrolling while it is open on mobile.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.style.overflow = isMobileOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [isMobileOpen]);

  const handleDelete = (e: React.MouseEvent, id: number) => {
    e.preventDefault();
    e.stopPropagation();
    deleteDoc({ id }, {
      onSuccess: () => {
        // Also clear the locally-cached editor draft (IndexedDB) so nothing stale remains.
        void deleteDraft(draftKey(id));
        toast.success("Extraction deleted successfully");
        queryClient.invalidateQueries({ queryKey: getGetExtractionHistoryQueryKey() });
        if (location === `/spec/${id}`) {
          setLocation("/");
        }
      },
      onError: () => toast.error("Failed to delete extraction")
    });
  };

  const updateSidebarHidden = (hidden: boolean) => {
    setIsSidebarHidden(hidden);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, String(hidden));
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-background md:flex-row">
      {/* Immersive background glow layer */}
      <div className="absolute inset-0 pointer-events-none z-0 overflow-hidden">
        <img
          src={`${import.meta.env.BASE_URL}images/bg-glow.png`}
          alt=""
          className="w-full h-full object-cover opacity-30 mix-blend-screen"
        />
        {/* Additional radial blurs for deep atmosphere */}
        <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-primary/5 blur-[120px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-blue-600/5 blur-[120px]" />
      </div>

      {isSidebarHidden && (
        <Button
          variant="outline"
          className="fixed left-4 top-4 z-30 hidden h-10 w-10 items-center justify-center rounded-xl border-border/70 bg-background/85 px-0 shadow-lg backdrop-blur-xl md:inline-flex"
          onClick={() => updateSidebarHidden(false)}
          aria-label="Show sidebar"
        >
          <PanelLeftOpen className="h-4 w-4 text-primary" />
        </Button>
      )}

      {/* Mobile top bar (below md) — hosts the logo and the drawer toggle */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-border/60 bg-background/85 px-4 py-3 backdrop-blur-xl md:hidden">
        <Link href="/" className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-tr from-primary to-blue-600 shadow-[0_0_20px_rgba(6,182,212,0.3)]">
            <Zap className="h-4 w-4 text-primary-foreground" fill="currentColor" />
          </div>
          <div className="min-w-0">
            <div className="truncate font-display text-sm font-bold leading-none tracking-tight text-foreground">IKIO TDS Generator</div>
            <div className="mt-1 text-[9px] font-bold uppercase tracking-[0.2em] text-primary opacity-80">IKIO LED Lighting</div>
          </div>
        </Link>
        <Button
          variant="outline"
          className="h-10 w-10 shrink-0 px-0"
          onClick={() => setIsMobileOpen(true)}
          aria-label="Open menu"
        >
          <Menu className="h-4 w-4 text-primary" />
        </Button>
      </header>

      {/* Backdrop for the mobile drawer */}
      {isMobileOpen && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={() => setIsMobileOpen(false)}
        />
      )}

      {/* Glassmorphic Sidebar — off-canvas drawer on mobile, collapsible column on md+ */}
      <aside className={cn(
        "flex flex-col bg-background/95 backdrop-blur-2xl shadow-[4px_0_24px_rgba(0,0,0,0.2)]",
        // Mobile: fixed off-canvas drawer that slides in from the left
        "fixed inset-y-0 left-0 z-50 h-full w-[86%] max-w-[340px] border-r border-border/80 transition-transform duration-300 ease-out",
        isMobileOpen ? "translate-x-0" : "-translate-x-full",
        // Desktop: in-flow sticky sidebar with width-collapse toggle
        "md:sticky md:top-0 md:z-20 md:h-screen md:max-w-none md:translate-x-0 md:shrink-0 md:overflow-hidden md:bg-background/60 md:transition-[width,transform,opacity,border-color] md:duration-300",
        isSidebarHidden
          ? "md:w-0 md:-translate-x-4 md:border-r-0 md:opacity-0 md:pointer-events-none"
          : "md:w-[320px] md:border-r md:opacity-100",
      )}>
        <div className="flex items-center justify-between border-b border-border/50 p-6">
          <Link href="/" className="flex items-center gap-3 group">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-primary to-blue-600 flex items-center justify-center shadow-[0_0_20px_rgba(6,182,212,0.3)] group-hover:shadow-[0_0_25px_rgba(6,182,212,0.5)] transition-all duration-300 group-hover:scale-105">
              <Zap className="w-5 h-5 text-primary-foreground" fill="currentColor" />
            </div>
            <div>
              <h1 className="font-display font-bold text-lg leading-none tracking-tight text-foreground">IKIO TDS Generator</h1>
              <p className="text-[10px] text-primary font-bold uppercase tracking-widest mt-1 opacity-80">IKIO LED LIGHTING</p>
            </div>
          </Link>
          <Button
            variant="ghost"
            className="hidden h-10 w-10 px-0 md:inline-flex"
            onClick={() => updateSidebarHidden(true)}
            aria-label="Hide sidebar"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            className="h-10 w-10 px-0 md:hidden"
            onClick={() => setIsMobileOpen(false)}
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-3 p-5">
          <Button
            onClick={() => setLocation("/")}
            className="w-full justify-start gap-2 h-12 border-border/50 shadow-sm"
            variant="outline"
          >
            <Plus className="w-4 h-4 text-primary" />
            New Extraction
          </Button>
          <div className="rounded-2xl border border-border/70 bg-card/40 px-4 py-3">
            <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
              Signed In
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">{username ?? "Authenticated User"}</div>
                <div className="text-xs text-muted-foreground">Protected extraction access</div>
              </div>
              <Button variant="ghost" className="h-9 px-3" onClick={() => void logout()}>
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 pt-0">
          <div className="flex items-center gap-2 mb-3 px-3 text-xs font-bold text-muted-foreground uppercase tracking-widest">
            <History className="w-3.5 h-3.5" />
            <span>Recent Processing</span>
          </div>

          <div className="space-y-1.5">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-16 rounded-xl bg-secondary/30 animate-pulse border border-border/20 mx-1" />
              ))
            ) : history?.length === 0 ? (
              <div className="text-center py-10 px-4 text-muted-foreground">
                <FileText className="w-10 h-10 mx-auto mb-3 opacity-20" />
                <p className="text-sm">No analyzed vendor PDFs yet.<br/>Processed files will appear here automatically.</p>
              </div>
            ) : (
              <AnimatePresence>
                {history?.map((item) => {
                  const isActive = location === `/spec/${item.id}`;
                  return (
                    <motion.div
                      key={item.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{ duration: 0.2 }}
                    >
                      <Link
                        href={`/spec/${item.id}`}
                        className={cn(
                          "group flex items-start gap-3 p-3 rounded-xl transition-all duration-300 border relative overflow-hidden",
                          isActive
                            ? "bg-primary/10 border-primary/30 shadow-[0_0_15px_rgba(6,182,212,0.1)]"
                            : "bg-transparent border-transparent hover:bg-secondary/40 hover:border-border/50"
                        )}
                      >
                        {isActive && (
                          <motion.div layoutId="active-indicator" className="absolute left-0 top-0 bottom-0 w-1 bg-primary shadow-[0_0_10px_rgba(6,182,212,0.8)]" />
                        )}
                        <div className={cn(
                          "w-9 h-9 rounded-lg flex flex-shrink-0 items-center justify-center mt-0.5 transition-colors",
                          isActive ? "bg-primary/20 text-primary" : "bg-secondary text-muted-foreground group-hover:text-foreground"
                        )}>
                          <FileText className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0 py-0.5">
                          <h3 className={cn(
                            "text-sm font-semibold truncate transition-colors",
                            isActive ? "text-primary" : "text-foreground group-hover:text-white"
                          )}>
                            {item.productName || item.filename}
                          </h3>
                          <p className="text-xs text-muted-foreground truncate mt-1 font-medium">
                            {formatDate(item.createdAt)}
                          </p>
                        </div>
                        <button
                          onClick={(e) => handleDelete(e, item.id)}
                          disabled={isDeleting}
                          className="opacity-0 group-hover:opacity-100 p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-all self-center disabled:opacity-50"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </Link>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="relative z-10 flex min-w-0 flex-1 flex-col md:h-screen md:overflow-y-auto">
        <div className={cn(
          "mx-auto flex-1 w-full min-w-0 max-w-[1760px] p-4 md:p-8 lg:p-10",
          isSidebarHidden && "md:pl-20",
        )}>
          <AnimatePresence mode="wait">
            {children}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
