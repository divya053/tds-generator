import { Link } from "wouter";
import { motion } from "framer-motion";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui";

export default function NotFound() {
  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex flex-col items-center justify-center min-h-[70vh] text-center"
    >
      <div className="relative">
        <div className="absolute inset-0 bg-primary/20 rounded-full blur-3xl animate-pulse" />
        <div className="relative w-24 h-24 bg-card border border-border/80 rounded-3xl flex items-center justify-center mb-8 shadow-2xl">
          <FileQuestion className="w-12 h-12 text-muted-foreground" />
        </div>
      </div>
      
      <h1 className="text-6xl font-display font-extrabold text-foreground mb-4 tracking-tight">404</h1>
      <h2 className="text-2xl font-bold text-muted-foreground mb-4">Page Not Found</h2>
      <p className="text-lg text-slate-400 mb-10 max-w-md font-medium">
        The document or page you are looking for doesn't exist or has been moved.
      </p>
      
      <Link href="/" className="inline-flex items-center justify-center rounded-xl text-base font-semibold transition-all duration-200 h-14 px-8 bg-gradient-to-r from-primary to-blue-500 text-primary-foreground hover:shadow-[0_0_20px_rgba(6,182,212,0.4)] border border-primary/50">
        Return to Dashboard
      </Link>
    </motion.div>
  );
}
