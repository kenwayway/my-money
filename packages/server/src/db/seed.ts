import { db, tx } from "./connection.js";

interface SeedCategory {
  name: string;
  type: "income" | "expense";
  color: string;
  icon: string;
  system?: boolean;
}

const DEFAULT_CATEGORIES: SeedCategory[] = [
  { name: "Groceries", type: "expense", color: "#22c55e", icon: "shopping-cart" },
  { name: "Dining", type: "expense", color: "#f97316", icon: "utensils" },
  { name: "Coffee", type: "expense", color: "#a16207", icon: "coffee" },
  { name: "Transit", type: "expense", color: "#0ea5e9", icon: "bus" },
  { name: "Gas", type: "expense", color: "#64748b", icon: "fuel" },
  { name: "Shopping", type: "expense", color: "#ec4899", icon: "shopping-bag" },
  { name: "Entertainment", type: "expense", color: "#8b5cf6", icon: "clapperboard" },
  { name: "Subscriptions", type: "expense", color: "#6366f1", icon: "repeat" },
  { name: "Rent", type: "expense", color: "#ef4444", icon: "home" },
  { name: "Utilities", type: "expense", color: "#eab308", icon: "zap" },
  { name: "Phone & Internet", type: "expense", color: "#14b8a6", icon: "wifi" },
  { name: "Health", type: "expense", color: "#f43f5e", icon: "heart-pulse" },
  { name: "Insurance", type: "expense", color: "#78716c", icon: "shield" },
  { name: "Education", type: "expense", color: "#3b82f6", icon: "graduation-cap" },
  { name: "Travel", type: "expense", color: "#06b6d4", icon: "plane" },
  { name: "Fees & Charges", type: "expense", color: "#94a3b8", icon: "receipt" },
  { name: "Other", type: "expense", color: "#9ca3af", icon: "circle-ellipsis" },
  { name: "Salary", type: "income", color: "#16a34a", icon: "banknote" },
  { name: "Interest", type: "income", color: "#65a30d", icon: "percent" },
  { name: "Refund", type: "income", color: "#84cc16", icon: "rotate-ccw" },
  { name: "Other Income", type: "income", color: "#4ade80", icon: "plus-circle" },
  // system categories — undeletable, excluded from spending charts appropriately
  { name: "Transfer", type: "expense", color: "#a1a1aa", icon: "arrow-left-right", system: true },
  { name: "Uncategorized", type: "expense", color: "#d4d4d8", icon: "help-circle", system: true },
];

const DEFAULT_SETTINGS: Record<string, string> = {
  theme: "light",
  default_currency: "CAD",
};

export function seedDb(): void {
  const catCount = (db.prepare("SELECT COUNT(*) AS c FROM categories").get() as { c: number }).c;
  if (catCount === 0) {
    const ins = db.prepare(
      "INSERT INTO categories (name, type, color, icon, sort_order, is_system) VALUES (?, ?, ?, ?, ?, ?)"
    );
    tx(() => {
      DEFAULT_CATEGORIES.forEach((c, i) => {
        ins.run(c.name, c.type, c.color, c.icon, i, c.system ? 1 : 0);
      });
    });
  }

  const insSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

  // leftover from the abandoned built-in-AI direction; scrub from existing DBs
  db.prepare("DELETE FROM settings WHERE key = 'ai_enabled'").run();
}
