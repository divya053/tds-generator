import { useEffect } from "react";
import { useRoute } from "wouter";
import { useGetExtraction } from "@workspace/api-client-react";
import { AlertTriangle, Lightbulb } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { SpecSheetEditor } from "@/components/SpecSheetEditor";

export default function SpecDetail() {
  const [, params] = useRoute("/spec/:id");
  const id = params?.id ? parseInt(params.id, 10) : 0;

  const { data: spec, isLoading, error } = useGetExtraction(id);
  const { logout } = useAuth();

  useEffect(() => {
    if (error && typeof error === "object" && "status" in error && error.status === 401) {
      void logout();
    }
  }, [error, logout]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-[70vh]">
        <div className="relative w-24 h-24 mb-6">
          <div
            className="absolute inset-0 rounded-full border-t-2 border-primary animate-spin"
            style={{ animationDuration: "1.5s" }}
          />
          <Lightbulb className="w-8 h-8 text-primary absolute inset-0 m-auto animate-pulse" />
        </div>
        <h2 className="text-2xl font-bold text-foreground mb-2">Loading Spec Data</h2>
        <p className="text-muted-foreground font-medium">
          Building the editable sheet preview...
        </p>
      </div>
    );
  }

  if (error || !spec) {
    return (
      <div className="flex flex-col items-center justify-center h-[70vh] text-center max-w-md mx-auto">
        <div className="w-20 h-20 rounded-3xl bg-destructive/10 border border-destructive/20 text-destructive flex items-center justify-center mb-6 shadow-inner">
          <AlertTriangle className="w-10 h-10" />
        </div>
        <h2 className="text-3xl font-display font-bold text-foreground mb-3">
          Extraction Not Found
        </h2>
        <p className="text-lg text-muted-foreground">
          The requested specification document could not be loaded or may have
          been deleted.
        </p>
      </div>
    );
  }

  return <SpecSheetEditor spec={spec} />;
}
