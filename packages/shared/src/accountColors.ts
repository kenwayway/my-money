import type { AccountType } from "./types.js";

export const ACCOUNT_TYPE_COLORS: Record<AccountType, string> = {
  chequing: "#4d6f9c",
  savings: "#3f7f86",
  credit: "#8a5e80",
  prepaid: "#718486",
  cash: "#807970",
  investment: "#747d76",
};

export function defaultAccountColor(type: AccountType): string {
  return ACCOUNT_TYPE_COLORS[type];
}

export function isDefaultAccountColor(color: string): boolean {
  return Object.values(ACCOUNT_TYPE_COLORS).includes(color.toLowerCase());
}
