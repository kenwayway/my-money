import { useEffect, useState } from "react";
import { LayoutDashboard, CreditCard, FileCheck2, List, Settings as SettingsIcon, Wallet, Moon, Sun } from "lucide-react";
import Dashboard from "./pages/Dashboard";
import Accounts from "./pages/Accounts";
import Transactions from "./pages/Transactions";
import Statements from "./pages/Statements";
import Settings from "./pages/Settings";
import { api } from "./api";

type Page = "dashboard" | "accounts" | "transactions" | "statements" | "settings";
const PAGES = new Set<Page>(["dashboard", "accounts", "transactions", "statements", "settings"]);

function pageFromHash(): Page {
  const hash = location.hash.slice(1);
  if (hash === "import") return "statements";
  return PAGES.has(hash as Page) ? (hash as Page) : "dashboard";
}

const NAV: { key: Page; label: string; icon: React.ReactNode }[] = [
  { key: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={17} /> },
  { key: "accounts", label: "Accounts", icon: <CreditCard size={17} /> },
  { key: "transactions", label: "Transactions", icon: <List size={17} /> },
  { key: "statements", label: "Statements", icon: <FileCheck2 size={17} /> },
  { key: "settings", label: "Settings", icon: <SettingsIcon size={17} /> },
];

export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [theme, setTheme] = useState<string>(localStorage.getItem("theme") ?? "light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
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
          <span className="brand-mark">
            <Wallet size={17} />
          </span>
          <span>
            <div className="brand-name">my-money</div>
            <div className="brand-sub">local · private</div>
          </span>
        </div>
        <hr className="sidebar-rule" />
        {NAV.map((n) => (
          <button key={n.key} className={`nav-item ${page === n.key ? "active" : ""}`} onClick={() => nav(n.key)}>
            {n.icon} {n.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="nav-item" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />} {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </nav>
      <main className="main">
        {page === "dashboard" && <Dashboard onNavigate={(p) => nav(p as Page)} />}
        {page === "accounts" && <Accounts />}
        {page === "transactions" && <Transactions />}
        {page === "statements" && <Statements />}
        {page === "settings" && <Settings />}
      </main>
    </div>
  );
}
