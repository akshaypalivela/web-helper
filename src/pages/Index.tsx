import { useState } from "react";
import { Download, Shield, Eye, MessageSquare, Compass, Zap, Lock } from "lucide-react";

const downloadExtension = () => {
  fetch("/integration-guide.zip")
    .then((res) => {
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      return res.blob();
    })
    .then((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "integration-guide.zip";
      a.click();
      URL.revokeObjectURL(a.href);
    })
    .catch((err) => alert(err.message));
};

const features = [
  { icon: MessageSquare, title: "Natural Language Chat", description: "Describe what you want to integrate — Gemini Vision analyzes the page and guides you." },
  { icon: Eye, title: "Ghost Mouse", description: "A pulsing orange marker appears on the exact button you need to click next." },
  { icon: Compass, title: "Cross-Domain Journey", description: "Tracks progress as you navigate between tools and services." },
  { icon: Zap, title: "Gemini + Firecrawl", description: "Screenshots the page with Firecrawl, then Gemini Vision identifies the right element." },
  { icon: Lock, title: "100% Local-First", description: "Your API keys and data never leave your browser. No external servers." },
];

const steps = [
  { num: "01", text: "Download & unzip the extension" },
  { num: "02", text: "Open chrome://extensions and enable Developer Mode" },
  { num: "03", text: "Click 'Load unpacked' and select the folder" },
  { num: "04", text: "Add your Firecrawl + Gemini API keys in Settings" },
];

const Index = () => {
  const [hoveredFeature, setHoveredFeature] = useState<number | null>(null);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-primary/10 via-transparent to-transparent" />
        <div className="relative max-w-4xl mx-auto px-6 pt-24 pb-16 text-center">
          <div className="inline-flex items-center gap-2 bg-secondary px-4 py-1.5 rounded-full text-xs text-muted-foreground mb-8">
            <Shield className="w-3.5 h-3.5 text-primary" />
            100% Local-First · No Backend
          </div>
          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight leading-[1.1] mb-6">
            Integration<span className="block text-primary">Guide</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto mb-10 leading-relaxed">
            An AI sidebar that highlights exactly where to click. Your keys stay in your browser.
          </p>
          <button
            onClick={downloadExtension}
            className="inline-flex items-center gap-2.5 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold px-8 py-4 rounded-2xl text-base transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-primary/25"
          >
            <Download className="w-5 h-5" />
            Download Extension
          </button>
        </div>
      </section>

      <section className="max-w-4xl mx-auto px-6 py-20">
        <div className="grid sm:grid-cols-2 gap-4">
          {features.map((f, i) => (
            <div
              key={i}
              className={`bg-card border border-border rounded-2xl p-6 transition-all duration-300 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5 cursor-default ${i === features.length - 1 ? 'sm:col-span-2' : ''}`}
              onMouseEnter={() => setHoveredFeature(i)}
              onMouseLeave={() => setHoveredFeature(null)}
            >
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 transition-colors ${hoveredFeature === i ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>
                <f.icon className="w-5 h-5" />
              </div>
              <h3 className="font-semibold mb-2">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="max-w-4xl mx-auto px-6 py-20 border-t border-border">
        <h2 className="text-2xl font-bold mb-10 text-center">Get Started</h2>
        <div className="grid sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
          {steps.map((s, i) => (
            <div key={i} className="flex items-start gap-4 bg-card border border-border rounded-xl p-4">
              <span className="text-primary font-bold text-lg">{s.num}</span>
              <p className="text-sm text-muted-foreground pt-0.5">{s.text}</p>
            </div>
          ))}
        </div>
        <div className="text-center mt-10">
          <div className="inline-flex items-center gap-2 text-xs text-muted-foreground bg-secondary px-4 py-2 rounded-full">
            <Shield className="w-3.5 h-3.5" />
            Works in Chrome, Edge, Brave, Arc & Opera
          </div>
        </div>
      </section>

      <footer className="border-t border-border py-8 text-center text-xs text-muted-foreground">
        Integration Guide · 100% Local-First · Powered by Gemini + Firecrawl
      </footer>
    </div>
  );
};

export default Index;
