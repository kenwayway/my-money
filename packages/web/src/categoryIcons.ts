// Cute emoji for each category icon name stored in the DB (lucide icon keys).
// User-created categories default to "tag".
const ICON_EMOJI: Record<string, string> = {
  "shopping-cart": "🛒",
  utensils: "🍜",
  coffee: "☕",
  bus: "🚌",
  fuel: "⛽",
  "shopping-bag": "🛍️",
  clapperboard: "🎬",
  repeat: "🔁",
  home: "🏠",
  zap: "⚡",
  wifi: "📶",
  "heart-pulse": "🩺",
  shield: "🛡️",
  "graduation-cap": "🎓",
  plane: "✈️",
  receipt: "🧾",
  "circle-ellipsis": "✨",
  banknote: "💵",
  percent: "🪙",
  "rotate-ccw": "↩️",
  "plus-circle": "💰",
  "arrow-left-right": "🔄",
  "help-circle": "❓",
  "paw-print": "🐾",
  shirt: "👕",
  tag: "🏷️",
};

export function catEmoji(icon?: string | null): string {
  return (icon && ICON_EMOJI[icon]) || "🏷️";
}
