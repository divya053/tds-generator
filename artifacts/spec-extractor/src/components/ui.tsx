import * as React from "react";
import { cn } from "@/lib/utils";

// Beautiful interactive Button
export const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'secondary' | 'ghost' }>(
  ({ className, variant = 'default', ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center rounded-xl text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:pointer-events-none disabled:opacity-50 h-11 px-6 py-2 active:scale-[0.98]",
          variant === 'default' && "bg-gradient-to-r from-primary to-blue-500 text-primary-foreground hover:shadow-[0_0_20px_rgba(6,182,212,0.4)] border border-primary/50 hover:border-primary",
          variant === 'outline' && "border border-border bg-transparent hover:bg-secondary/80 hover:border-border text-foreground hover:shadow-lg",
          variant === 'secondary' && "bg-secondary text-secondary-foreground hover:bg-secondary/80 border border-transparent",
          variant === 'ghost' && "bg-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/50",
          className
        )}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

// Card with glass depth
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-2xl border border-border/60 bg-card/40 backdrop-blur-md text-card-foreground shadow-xl shadow-black/20", className)}
      {...props}
    />
  );
}

// Crisp Badges
export function Badge({ className, variant = 'default', ...props }: React.HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'primary' | 'outline' }) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
        variant === 'default' && "bg-secondary text-secondary-foreground",
        variant === 'primary' && "bg-primary/10 text-primary border border-primary/30 shadow-[0_0_10px_rgba(6,182,212,0.15)]",
        variant === 'outline' && "text-muted-foreground border border-border/80",
        className
      )}
      {...props}
    />
  );
}
