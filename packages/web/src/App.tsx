import { useEffect, useState } from "react";
import { LayoutDashboard, CreditCard, List, Upload, Settings as SettingsIcon, Wallet } from "lucide-react";
import Dashboard from "./pages/Dashboard";
import Accounts from "./pages/Accounts";
import Transactions from "./pages/Transactions";
import ImportWizard from "./pages/ImportWizard";
import Settings from "./pages/Settings";
import { api } from "./api";

type Page = "dashboard" | "accounts" | "transactions" | "import" | "settings";

const NAV: { key: Page; label: string; icon: React.ReactNode }[] = [
  { key: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={17} /> },
  { key: "accounts", label: "Accounts", icon: <CreditCard size={17} /> },
  { key: "transactions", label: "Transactions", icon: <List size={17} /> },
  { key: "import", label: "Import", icon: <Upload size={17} /> },
  { key: "settings", label: "Settings", icon: <SettingsIcon size={17} /> },
];

export default function App() {
  const [page, setPage] = useState<Page>((location.hash.slice(1) as Page) || "dashboard");
  const [theme, setTheme] = useState<string>(localStorage.getItem("theme") ?? "light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    const onHash = () => setPage((location.hash.slice(1) as Page) || "dashboard");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    // pick up server-side theme preference once
    api.get<Record<string, string>>("/settings").then((s) => {
      if (s.theme && !localStorage.getItem("theme")) setTheme(s.theme);
    }).catch(() => {});
  }, []);

  const nav = (p: Page) => {
    setPage(p);
    location.hash = p;
  };

  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="brand">
          <Wallet size={20} /> my-money
        </div>
        {NAV.map((n) => (
          <button key={n.key} className={`nav-item ${page === n.key ? "active" : ""}`} onClick={() => nav(n.key)}>
            {n.icon} {n.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="nav-item" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? "☀️ Light" : "🌙 Dark"}
        </button>
      </nav>
      <main className="main">
        {page === "dashboard" && <Dashboard onNavigate={(p) => nav(p as Page)} />}
        {page === "accounts" && <Accounts />}
        {page === "transactions" && <Transactions />}
        {page === "import" && <ImportWizard onDone={() => nav("transactions")} />}
        {page === "settings" && <Settings />}
      </main>
    </div>
  );
}
