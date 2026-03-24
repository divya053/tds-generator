import { useRoute } from "wouter";
import { motion } from "framer-motion";
import { useGetExtraction } from "@workspace/api-client-react";
import { Download, Building2, Tag, CheckCircle2, AlertTriangle, Lightbulb } from "lucide-react";
import { Button, Badge, Card } from "@/components/ui";

export default function SpecDetail() {
  const [, params] = useRoute("/spec/:id");
  const id = params?.id ? parseInt(params.id, 10) : 0;

  const { data: spec, isLoading, error } = useGetExtraction(id, {
    query: { enabled: !!id }
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-[70vh]">
        <div className="relative w-24 h-24 mb-6">
          <div className="absolute inset-0 rounded-full border-t-2 border-primary animate-spin" style={{ animationDuration: '1.5s' }} />
          <Lightbulb className="w-8 h-8 text-primary absolute inset-0 m-auto animate-pulse" />
        </div>
        <h2 className="text-2xl font-bold text-foreground mb-2">Loading Spec Data</h2>
        <p className="text-muted-foreground font-medium">Retrieving structured information...</p>
      </div>
    );
  }

  if (error || !spec) {
    return (
      <div className="flex flex-col items-center justify-center h-[70vh] text-center max-w-md mx-auto">
        <div className="w-20 h-20 rounded-3xl bg-destructive/10 border border-destructive/20 text-destructive flex items-center justify-center mb-6 shadow-inner">
          <AlertTriangle className="w-10 h-10" />
        </div>
        <h2 className="text-3xl font-display font-bold text-foreground mb-3">Extraction Not Found</h2>
        <p className="text-lg text-muted-foreground">The requested specification document could not be loaded or may have been deleted.</p>
      </div>
    );
  }

  const handleDownload = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(spec, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", `${spec.productName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_specs.json`);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const staggerContainer = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.1 }
    }
  };

  const fadeUp = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 24 } }
  };

  return (
    <motion.div
      key={`spec-${id}`}
      variants={staggerContainer}
      initial="hidden"
      animate="show"
      className="space-y-8 pb-12"
    >
      {/* Premium Header */}
      <motion.div variants={fadeUp} className="flex flex-col lg:flex-row lg:items-start justify-between gap-6 pb-8 border-b border-border/50 relative">
        <div className="absolute -left-12 -top-12 w-64 h-64 bg-primary/10 rounded-full blur-[80px] pointer-events-none" />
        
        <div className="relative z-10 flex-1">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <Badge variant="primary" className="uppercase tracking-widest px-3">Analyzed</Badge>
            <span className="text-sm font-medium text-muted-foreground bg-secondary/50 px-3 py-1 rounded-full border border-border/50">{spec.filename}</span>
          </div>
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-display font-extrabold text-foreground mb-3 leading-tight">
            {spec.productName}
          </h1>
          {spec.alternateName && (
            <p className="text-xl md:text-2xl text-primary font-medium">
              {spec.alternateName}
            </p>
          )}
        </div>
        
        <div className="relative z-10 shrink-0 lg:mt-4">
          <Button onClick={handleDownload} className="w-full sm:w-auto h-12 px-6 gap-2 text-base shadow-[0_0_20px_rgba(6,182,212,0.25)]">
            <Download className="w-5 h-5" />
            Export JSON Data
          </Button>
        </div>
      </motion.div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        {/* Main Content Column */}
        <div className="xl:col-span-2 space-y-8">
          
          {/* Description */}
          {spec.productDescription && (
            <motion.section variants={fadeUp}>
              <h3 className="text-2xl font-display font-bold mb-5 flex items-center gap-3 text-foreground">
                <span className="w-8 h-1 bg-primary rounded-full" />
                Product Description
              </h3>
              <div className="text-lg text-slate-300 leading-relaxed bg-card/30 backdrop-blur-sm p-6 md:p-8 rounded-[1.5rem] border border-border/60 shadow-lg shadow-black/10 font-medium">
                {spec.productDescription}
              </div>
            </motion.section>
          )}

          {/* Technical Specs Premium Table */}
          {spec.technicalSpecs && spec.technicalSpecs.length > 0 && (
            <motion.section variants={fadeUp}>
              <h3 className="text-2xl font-display font-bold mb-5 flex items-center gap-3 text-foreground">
                <span className="w-8 h-1 bg-blue-500 rounded-full" />
                Technical Specifications
              </h3>
              <div className="overflow-hidden rounded-[1.5rem] border border-border/80 bg-card/60 backdrop-blur-md shadow-2xl shadow-black/20">
                <table className="w-full text-left">
                  <thead className="bg-secondary/80 text-muted-foreground border-b border-border/80">
                    <tr>
                      <th className="px-6 py-5 font-bold uppercase tracking-widest text-xs w-1/3">Parameter</th>
                      <th className="px-6 py-5 font-bold uppercase tracking-widest text-xs">Value / Detail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
                    {spec.technicalSpecs.map((s, idx) => (
                      <tr key={idx} className="hover:bg-primary/5 transition-colors group">
                        <td className="px-6 py-4 font-semibold text-foreground group-hover:text-primary transition-colors">{s.parameter}</td>
                        <td className="px-6 py-4 text-slate-300 font-medium">{s.specification}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </motion.section>
          )}

          {/* Notes Callouts */}
          {spec.notes && spec.notes.length > 0 && (
            <motion.section variants={fadeUp}>
              <h3 className="text-xl font-display font-bold mb-5 text-muted-foreground">Additional Notes</h3>
              <div className="space-y-4">
                {spec.notes.map((note, i) => (
                  <div key={i} className="p-5 rounded-2xl bg-gradient-to-r from-blue-900/20 to-transparent border-l-4 border-l-blue-500 border border-y-border/50 border-r-border/50 text-blue-100 flex gap-4 shadow-lg">
                    <Lightbulb className="w-6 h-6 text-blue-400 shrink-0" />
                    <p className="font-medium text-lg leading-snug">{note}</p>
                  </div>
                ))}
              </div>
            </motion.section>
          )}
        </div>

        {/* Sidebar Column */}
        <div className="space-y-6">
          
          {/* Key Features List */}
          {spec.productFeatures && spec.productFeatures.length > 0 && (
            <motion.div variants={fadeUp}>
              <Card className="p-6 md:p-8 bg-gradient-to-b from-card/80 to-background/80">
                <h3 className="text-xl font-display font-bold mb-6 text-foreground">Key Features</h3>
                <ul className="space-y-5">
                  {spec.productFeatures.map((feature, i) => (
                    <li key={i} className="flex gap-4 items-start group">
                      <div className="mt-0.5 w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                        <CheckCircle2 className="w-4 h-4 text-primary" />
                      </div>
                      <span className="leading-relaxed text-slate-300 font-medium group-hover:text-foreground transition-colors">{feature}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </motion.div>
          )}

          {/* Applications Badges */}
          {spec.applicationAreas && spec.applicationAreas.length > 0 && (
            <motion.div variants={fadeUp}>
              <Card className="p-6 md:p-8">
                <h3 className="text-xl font-display font-bold mb-6 text-foreground">Applications</h3>
                <div className="flex flex-wrap gap-2.5">
                  {spec.applicationAreas.map((area, i) => (
                    <Badge key={i} variant="outline" className="bg-secondary/40 hover:bg-secondary/80 text-sm py-1.5 px-4 border-border/60 hover:border-primary/50 transition-colors">
                      <Tag className="w-3.5 h-3.5 mr-2 text-primary opacity-80" />
                      {area}
                    </Badge>
                  ))}
                </div>
              </Card>
            </motion.div>
          )}

          {/* Vendor Details */}
          {spec.vendorInfo && (spec.vendorInfo.vendorName || spec.vendorInfo.vendorContact) && (
            <motion.div variants={fadeUp}>
              <Card className="p-6 md:p-8 border-primary/20 bg-gradient-to-br from-primary/5 to-transparent relative overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-10">
                  <Building2 className="w-24 h-24" />
                </div>
                <h3 className="text-xl font-display font-bold mb-6 flex items-center gap-3 text-foreground relative z-10">
                  <Building2 className="w-6 h-6 text-primary" />
                  Vendor Details
                </h3>
                <div className="space-y-5 relative z-10">
                  {spec.vendorInfo.vendorName && (
                    <div>
                      <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1.5">Company Name</div>
                      <div className="text-lg font-semibold text-foreground">{spec.vendorInfo.vendorName}</div>
                    </div>
                  )}
                  {spec.vendorInfo.vendorContact && (
                    <div>
                      <div className="text-xs font-bold text-muted-foreground uppercase tracking-widest mb-1.5">Contact Information</div>
                      <div className="text-base text-slate-300 font-medium">{spec.vendorInfo.vendorContact}</div>
                    </div>
                  )}
                </div>
              </Card>
            </motion.div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
