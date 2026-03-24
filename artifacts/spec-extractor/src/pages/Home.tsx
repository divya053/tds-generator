import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { motion, AnimatePresence } from "framer-motion";
import { UploadCloud, FileType, CheckCircle2, Sparkles } from "lucide-react";
import { useExtractSpec, getGetExtractionHistoryQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const { mutate: extract, isPending } = useExtractSpec();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setFile(acceptedFiles[0]);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf']
    },
    maxFiles: 1,
    disabled: isPending
  });

  const handleExtract = () => {
    if (!file) return;

    extract({ data: { file } }, {
      onSuccess: (data) => {
        toast.success("Spec sheet processed successfully!");
        queryClient.invalidateQueries({ queryKey: getGetExtractionHistoryQueryKey() });
        setLocation(`/spec/${data.id}`);
      },
      onError: (err) => {
        toast.error(err.error?.error || "Failed to extract specifications");
        setFile(null); // Reset on error so they can try again
      }
    });
  };

  return (
    <motion.div
      key="home-page"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="max-w-4xl mx-auto mt-8 md:mt-16"
    >
      <div className="text-center mb-16">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.1 }}
          className="inline-flex items-center justify-center px-4 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-bold tracking-wide mb-8 border border-primary/20 shadow-[0_0_15px_rgba(6,182,212,0.15)]"
        >
          <Sparkles className="w-4 h-4 mr-2" />
          GLM-4.6 AI ENGINE ACTIVE
        </motion.div>
        
        <h1 className="text-5xl md:text-7xl font-display font-bold text-foreground mb-6 leading-[1.1]">
          Automate Your <br className="hidden md:block" />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary via-blue-400 to-indigo-500 filter drop-shadow-lg">
            Lighting Specs
          </span>
        </h1>
        <p className="text-xl text-muted-foreground max-w-2xl mx-auto font-medium leading-relaxed">
          Upload any vendor specification sheet. Our AI instantly extracts product details, technical parameters, and application areas into structured data.
        </p>
      </div>

      <div className="relative max-w-2xl mx-auto">
        {/* Ambient Glowing border behind dropzone */}
        <div className="absolute -inset-1.5 bg-gradient-to-r from-primary/50 to-blue-600/50 rounded-[2rem] blur-xl opacity-40 animate-pulse" />

        <div
          {...getRootProps()}
          className={cn(
            "relative p-12 md:p-16 rounded-[1.5rem] border-2 border-dashed bg-card/60 backdrop-blur-xl transition-all duration-500 text-center cursor-pointer overflow-hidden shadow-2xl shadow-black/50",
            isDragActive ? "border-primary bg-primary/10 scale-[1.02]" : "border-border hover:border-primary/50 hover:bg-card/80",
            isDragReject && "border-destructive bg-destructive/10",
            isPending && "pointer-events-none opacity-100 border-primary shadow-[0_0_30px_rgba(6,182,212,0.2)]"
          )}
        >
          <input {...getInputProps()} />

          {/* Scanning Animation */}
          <AnimatePresence>
            {isPending && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 pointer-events-none overflow-hidden rounded-[1.5rem]"
              >
                <div className="absolute inset-0 bg-primary/5" />
                <motion.div
                  className="absolute left-0 right-0 h-1 bg-primary shadow-[0_0_20px_4px_rgba(6,182,212,0.8)] z-10 top-0"
                  animate={{ top: ["0%", "100%", "0%"] }}
                  transition={{ duration: 2.5, repeat: Infinity, ease: "linear" }}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="relative z-10 flex flex-col items-center justify-center min-h-[160px]">
            {isPending ? (
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center"
              >
                <div className="w-24 h-24 relative mb-6">
                  <div className="absolute inset-0 rounded-full border-t-2 border-primary animate-spin" style={{ animationDuration: '2s' }} />
                  <div className="absolute inset-2 rounded-full border-r-2 border-blue-400 animate-spin" style={{ animationDirection: 'reverse', animationDuration: '1.5s' }} />
                  <div className="absolute inset-4 rounded-full border-b-2 border-indigo-400 animate-spin" style={{ animationDuration: '1s' }} />
                  <FileType className="w-8 h-8 text-primary absolute inset-0 m-auto animate-pulse" />
                </div>
                <h3 className="text-2xl font-bold text-foreground mb-2">Analyzing Document...</h3>
                <p className="text-primary font-medium">Extracting complex technical parameters</p>
              </motion.div>
            ) : file ? (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-center w-full"
              >
                <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-primary/20 to-blue-500/20 border border-primary/30 text-primary flex items-center justify-center mb-5 shadow-[0_0_15px_rgba(6,182,212,0.2)]">
                  <CheckCircle2 className="w-10 h-10" />
                </div>
                <h3 className="text-2xl font-bold text-foreground mb-2 truncate max-w-full px-4">{file.name}</h3>
                <p className="text-muted-foreground font-medium mb-8 bg-secondary px-3 py-1 rounded-full">
                  {(file.size / 1024 / 1024).toFixed(2)} MB • PDF Document
                </p>
                <div className="flex flex-col sm:flex-row gap-4 w-full max-w-sm justify-center">
                  <Button
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                    }}
                    className="w-full sm:w-auto"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleExtract();
                    }}
                    className="gap-2 w-full sm:w-auto shadow-lg shadow-primary/30 text-base h-12"
                  >
                    <Sparkles className="w-5 h-5" />
                    Extract Specifications
                  </Button>
                </div>
              </motion.div>
            ) : (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex flex-col items-center"
              >
                <div className="w-24 h-24 rounded-3xl bg-secondary/80 border border-border flex items-center justify-center mb-6 shadow-inner group-hover:scale-110 transition-transform duration-300">
                  <UploadCloud className="w-12 h-12 text-muted-foreground group-hover:text-primary transition-colors duration-300" />
                </div>
                <h3 className="text-2xl font-bold text-foreground mb-3">
                  {isDragActive ? "Drop PDF here" : "Drag & drop vendor PDF"}
                </h3>
                <p className="text-lg text-muted-foreground mb-8">
                  or click to browse from your computer
                </p>
                <Button variant="outline" className="pointer-events-none h-12 px-8 rounded-full border-border/80">
                  Select File
                </Button>
              </motion.div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
