
import { useState } from "react";
import {
  Download,
  Shield,
  Eye,
  MessageSquare,
  Compass,
  Zap,
  KeyRound,
  Github,
  ExternalLink,
} from "lucide-react";

const GITHUB_REPO = "https://github.com/akshaypalivela/web-helper";

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
  {
    icon: MessageSquare,
    title: "Natural language",
    description:
      "Describe what you want to do next. Gemini Vision reads your viewport and suggests one action at a time.",
  },
  {
    icon: Eye,
    title: "Ghost marker",
    description:
      "A pulsing highlight on the control to click next—so you learn the real UI, not a generic walkthrough.",
  },
  {
    icon: Compass,
    title: "Cross-site",
    description:
      "Works on the sites you already use in the browser—not locked to one vendor’s help chat.",
  },
  {
    icon: Zap,
    title: "Gemini (+ optional Firecrawl)",
    description:
      "Live tab capture by default. If live capture isn’t available, you can use a Firecrawl key for a scraped page view—see the extension.",
  },
  {
    icon: KeyRound,
    title: "Your keys, locally",
    description:
      "API keys stay in the extension. Requests still go to your chosen providers (e.g. Google) when you analyze—no separate backend from this project.",
  },
];

const steps = [
  { num: "01", text: "Download the zip and unzip the extension folder" },
  { num: "02", text: "Open chrome://extensions and enable Developer mode" },
  { num: "03", text: "Click Load unpacked and select the extension folder" },
  { num: "04", text: "Add your Gemini API key in Settings (optional: Firecrawl if you use that path)" },
];

const Index = () => {
  const [hoveredFeature, setHoveredFeature] = useState<number | null>(null);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-primary/10 via-transparent to-transparent" />
        <div className="relative max-w-4xl mx-auto px-6 pt-24 pb-16 text-center">
          <div className="flex flex-col items-center gap-3 mb-8">
            <span className="inline-flex items-center justify-center gap-2 bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30 px-4 py-1.5 rounded-full text-xs font-medium text-center max-w-[min(100%,28rem)]">
              Work in progress — accuracy and behavior will change
            </span>
            <span className="inline-flex items-center justify-center gap-2 bg-secondary px-4 py-1.5 rounded-full text-xs text-muted-foreground text-center max-w-[min(100%,28rem)]">
              <Shield className="w-3.5 h-3.5 shrink-0 text-primary" />
              Teacher, not autopilot — you stay in control
            </span>
          </div>
          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight leading-[1.1] mb-6">
            Integration<span className="block text-primary">Guide</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto mb-4 leading-relaxed">
            A browser sidebar that points to the <strong className="text-foreground font-semibold">next click</strong> on the page you’re already on—so you learn the UI instead of handing the whole flow to an agent.
          </p>
          <p className="text-sm text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed">
            Between “do everything for me” and a single product’s help bot: <strong className="text-foreground">one step at a time</strong>, on the <strong className="text-foreground">live</strong> screen.
          </p>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-3 w-full max-w-md sm:max-w-none mx-auto">
            <button
              type="button"
              onClick={downloadExtension}
              className="inline-flex items-center justify-center gap-2.5 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold px-8 py-4 rounded-2xl text-base transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-primary/25 min-h-[3.5rem] w-full sm:w-auto"
            >
              <Download className="w-5 h-5 shrink-0" />
              Download extension (zip)
            </button>
            <a
              href={GITHUB_REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground border border-border rounded-2xl px-6 py-4 transition-colors hover:bg-secondary/80 min-h-[3.5rem] w-full sm:w-auto"
            >
              <Github className="w-5 h-5 shrink-0" />
              Source on GitHub
              <ExternalLink className="w-3.5 h-3.5 shrink-0 opacity-70" />
            </a>
          </div>
        </div>
      </section>

      <section className="max-w-4xl mx-auto px-6 py-20">
        <div className="grid sm:grid-cols-2 gap-4">
          {features.map((f, i) => (
            <div
              key={f.title}
              className={`bg-card border border-border rounded-2xl p-6 transition-all duration-300 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5 cursor-default ${i === features.length - 1 ? "sm:col-span-2 sm:max-w-2xl sm:mx-auto sm:w-full" : ""}`}
              onMouseEnter={() => setHoveredFeature(i)}
              onMouseLeave={() => setHoveredFeature(null)}
            >
              <div
                className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 transition-colors ${hoveredFeature === i ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}
              >
                <f.icon className="w-5 h-5" />
              </div>
              <h3 className="font-semibold mb-2">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="max-w-4xl mx-auto px-6 py-20 border-t border-border">
        <h2 className="text-2xl font-bold mb-10 text-center">Get started</h2>
        <div className="grid sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
          {steps.map((s) => (
            <div key={s.num} className="flex items-start gap-4 bg-card border border-border rounded-xl p-4">
              <span className="text-primary font-bold text-lg">{s.num}</span>
              <p className="text-sm text-muted-foreground pt-0.5">{s.text}</p>
            </div>
          ))}
        </div>
        <div className="text-center mt-10">
          <div className="inline-flex items-center gap-2 text-xs text-muted-foreground bg-secondary px-4 py-2 rounded-full">
            <Shield className="w-3.5 h-3.5" />
            Chromium browsers: Chrome, Edge, Brave, Arc, Opera
          </div>
        </div>
      </section>

      <footer className="border-t border-border py-8 px-6 text-xs text-muted-foreground">
        <div className="max-w-2xl mx-auto flex flex-col items-center gap-3 text-center">
          <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 leading-relaxed">
            <a
              href={GITHUB_REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-1.5 font-medium"
            >
              <Github className="w-3.5 h-3.5 shrink-0" />
              akshaypalivela/web-helper
            </a>
            <span className="text-border select-none hidden sm:inline" aria-hidden>
              ·
            </span>
            <span className="text-muted-foreground sm:max-w-none max-w-[20rem]">
              Read the README on GitHub for philosophy, privacy, and limitations.
            </span>
          </p>
          <p className="text-muted-foreground/90">Powered by Gemini Vision · Optional Firecrawl · Experimental software</p>
        </div>
      </footer>
    </div>
  );
};

export default Index;
