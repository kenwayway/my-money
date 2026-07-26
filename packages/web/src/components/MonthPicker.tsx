import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y!, m! - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

interface Props {
  value: string;
  onChange: (month: string) => void;
  /** allow an empty value meaning "all months" (shows a clear option in the panel) */
  allowEmpty?: boolean;
}

export default function MonthPicker({ value, onChange, allowEmpty = false }: Props) {
  const now = new Date();
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const empty = value === "";
  const label = empty ? "All months" : new Date(`${value}-01T00:00:00`).toLocaleString("en", { month: "long", year: "numeric" });
  const [open, setOpen] = useState(false);
  const [panelYear, setPanelYear] = useState(() => Number((value || current).slice(0, 4)));
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setPanelYear(Number((value || current).slice(0, 4)));
  }, [open, value, current]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="month-picker" ref={rootRef}>
      <div className="month-picker-seg">
        <button aria-label="Previous month" onClick={() => onChange(empty ? current : shiftMonth(value, -1))}>
          <ChevronLeft size={15} />
        </button>
        <button className="month-picker-label" onClick={() => setOpen(!open)}>
          {label}
        </button>
        <button aria-label="Next month" disabled={empty || value >= current} onClick={() => onChange(shiftMonth(value, 1))}>
          <ChevronRight size={15} />
        </button>
      </div>
      {open && (
        <div className="month-panel">
          <div className="month-panel-head">
            <button aria-label="Previous year" onClick={() => setPanelYear(panelYear - 1)}>
              <ChevronLeft size={14} />
            </button>
            <span>{panelYear}</span>
            <button aria-label="Next year" disabled={panelYear >= now.getFullYear()} onClick={() => setPanelYear(panelYear + 1)}>
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="month-grid">
            {MONTHS.map((name, i) => {
              const key = `${panelYear}-${String(i + 1).padStart(2, "0")}`;
              return (
                <button
                  key={key}
                  className={`month-cell ${key === value ? "selected" : ""}`}
                  disabled={key > current}
                  onClick={() => {
                    onChange(key);
                    setOpen(false);
                  }}
                >
                  {name}
                </button>
              );
            })}
          </div>
          {allowEmpty && (
            <button
              className="month-clear"
              disabled={empty}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              All months
            </button>
          )}
        </div>
      )}
    </div>
  );
}
