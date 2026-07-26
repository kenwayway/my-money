import { z } from "zod";

/**
 * ImportSpec — the single source of truth describing how to parse one bank's
 * CSV format. Produced by Claude (format detection) or by the user (manual
 * column mapping), cached per format fingerprint, and applied locally to the
 * full file. The AI only ever sees the header + a few sample rows.
 */
export const ImportSpecSchema = z.object({
  bank_guess: z.string().nullable().describe("Best guess at the bank/institution, e.g. 'RBC', 'Tangerine', or null"),
  delimiter: z.enum([",", ";", "\t"]).describe("Field delimiter used in the file"),
  has_header: z.boolean().describe("false for headerless files like RBC exports"),
  skip_rows: z
    .number()
    .int()
    .describe("Number of preamble lines before the data (or before the header if has_header). 0 for most files"),
  date: z.object({
    column: z.number().int().describe("0-based column index of the transaction date"),
    format: z
      .string()
      .describe("date-fns format tokens, e.g. 'M/d/yyyy', 'yyyy-MM-dd', 'MM/dd/yyyy'. Uppercase MM = month."),
  }),
  description_columns: z
    .array(z.number().int())
    .describe("0-based indexes of description columns, joined with a space (some banks split across 2 columns)"),
  amount: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("single"),
      column: z.number().int().describe("0-based column index of the signed amount"),
      sign_convention: z
        .enum(["outflow_negative", "outflow_positive"])
        .describe(
          "outflow_negative: spending appears negative (typical chequing). outflow_positive: spending appears positive (typical credit-card exports)."
        ),
    }),
    z.object({
      mode: z.literal("debit_credit"),
      debit_column: z.number().int().describe("0-based column with outflow amounts (may be empty on inflow rows)"),
      credit_column: z.number().int().describe("0-based column with inflow amounts (may be empty on outflow rows)"),
    }),
  ]),
  balance_column: z
    .number()
    .int()
    .nullable()
    .describe("0-based column index of the running balance if present, else null"),
  currency_guess: z.string().nullable().describe("ISO 4217 currency if determinable from the file, else null"),
  parentheses_negative: z.boolean().describe("true if negative amounts are written like (45.00)"),
  thousands_separator: z.enum([",", " ", "none"]).describe("Thousands separator used inside amount values"),
});

export type ImportSpec = z.infer<typeof ImportSpecSchema>;

export const CategorizationSchema = z.object({
  assignments: z.array(
    z.object({
      merchant: z.string().describe("The merchant string exactly as given in the input list"),
      category: z.string().describe("One of the provided category names, exactly as given"),
      confidence: z.enum(["high", "medium", "low"]),
    })
  ),
});

export type Categorization = z.infer<typeof CategorizationSchema>;
