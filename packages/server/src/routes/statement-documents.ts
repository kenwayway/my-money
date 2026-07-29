import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  MAX_STATEMENT_FILE_BYTES,
  StatementDocumentError,
  createStatementDocument,
  deleteStatementDocument,
  listStatementDocuments,
  readStatementDocument,
  withStatementStorageLock,
} from "../services/statement-documents.js";

function errorResponse(c: Context, error: unknown) {
  if (error instanceof StatementDocumentError) {
    return c.json({ error: error.message }, error.status);
  }
  return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
}

function contentDisposition(originalName: string, download: boolean): string {
  const asciiFallback =
    originalName
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_")
      .slice(0, 150) || "statement.pdf";
  return `${download ? "attachment" : "inline"}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(originalName)}`;
}

export const statementDocumentsRoute = new Hono()
  .use(
    "*",
    bodyLimit({
      maxSize: MAX_STATEMENT_FILE_BYTES + 1024 * 1024,
      onError: (c) =>
        c.json({ error: "statement file exceeds the 20 MiB limit" }, 413),
    })
  )
  .get("/", (c) => {
    const filter = c.req.query("status") === "all" ? "all" : "pending";
    return c.json(listStatementDocuments(filter));
  })
  .post("/", async (c) => {
    try {
      const form = await c.req.formData();
      const file = form.get("file");
      const accountIdRaw = form.get("account_id");
      const accountId =
        typeof accountIdRaw === "string" && accountIdRaw !== ""
          ? Number(accountIdRaw)
          : null;
      const importIdRaw = form.get("import_id");
      const importId =
        typeof importIdRaw === "string" && importIdRaw !== ""
          ? Number(importIdRaw)
          : undefined;
      if (!(file instanceof File)) {
        return c.json({ error: "one PDF or CSV file is required" }, 400);
      }
      if (
        accountId !== null &&
        (!Number.isInteger(accountId) || accountId <= 0)
      ) {
        return c.json({ error: "account_id must be a positive integer" }, 400);
      }
      if (importId !== undefined && (!Number.isInteger(importId) || importId <= 0)) {
        return c.json({ error: "import_id must be a positive integer" }, 400);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const document = await withStatementStorageLock(() =>
        createStatementDocument(accountId, file.name, bytes, importId)
      );
      return c.json(document, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .get("/:id/file", (c) => {
    try {
      const { document, bytes } = readStatementDocument(Number(c.req.param("id")));
      return c.body(new Uint8Array(bytes), 200, {
        "Content-Type": document.mime_type,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": contentDisposition(
          document.original_name,
          c.req.query("download") === "1"
        ),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  })
  .delete("/:id", async (c) => {
    try {
      const deleted = await withStatementStorageLock(() =>
        deleteStatementDocument(Number(c.req.param("id")))
      );
      return c.json({ deleted: true, document: deleted });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
