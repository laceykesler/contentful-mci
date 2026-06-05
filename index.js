/**
 * contentful-audit-mcp
 * A Model Context Protocol server for auditing Contentful content model health.
 *
 * Tools exposed:
 *   1. audit_content_model   — field coverage, required vs optional, empty types
 *   2. find_orphaned_entries — entries with no incoming references
 *   3. find_missing_fields   — entries missing required or commonly-expected fields
 *
 * Author: Lacey Kesler / Visual Dev School
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as contentful from "contentful";
import contentfulManagement from "contentful-management";
import { z } from "zod";

const {
  CONTENTFUL_SPACE_ID,
  CONTENTFUL_ENVIRONMENT = "master",
  CONTENTFUL_DELIVERY_TOKEN,
  CONTENTFUL_MANAGEMENT_TOKEN,
} = process.env;

function requireEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function getDeliveryClient() {
  return contentful.createClient({
    space: requireEnv("CONTENTFUL_SPACE_ID"),
    accessToken: requireEnv("CONTENTFUL_DELIVERY_TOKEN"),
    environment: CONTENTFUL_ENVIRONMENT,
  });
}

async function getManagementEnvironment() {
  const client = contentfulManagement.createClient({
    accessToken: requireEnv("CONTENTFUL_MANAGEMENT_TOKEN"),
  });
  const space = await client.getSpace(requireEnv("CONTENTFUL_SPACE_ID"));
  return space.getEnvironment(CONTENTFUL_ENVIRONMENT);
}

function formatTable(rows, headers) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length))
  );
  const sep = widths.map((w) => "─".repeat(w + 2)).join("┼");
  const fmt = (row) =>
    widths.map((w, i) => String(row[i] ?? "").padEnd(w)).join(" │ ");
  return [fmt(headers), sep, ...rows.map(fmt)].join("\n");
}

function severity(level) {
  return { error: "🔴", warn: "🟡", ok: "🟢" }[level] ?? "⚪";
}

async function auditContentModel({ content_type_id }) {
  const env = await getManagementEnvironment();
  const types = content_type_id
    ? [await env.getContentType(content_type_id)]
    : (await env.getContentTypes({ limit: 200 })).items;

  const results = [];

  for (const ct of types) {
    const fields = ct.fields ?? [];
    const total = fields.length;
    const required = fields.filter((f) => f.required).length;
    const disabled = fields.filter((f) => f.disabled).length;
    const omitted = fields.filter((f) => f.omitted).length;
    const localized = fields.filter((f) => f.localized).length;

    const issues = [];
    if (total === 0) issues.push({ level: "error", msg: "No fields defined" });
    if (required === 0) issues.push({ level: "warn", msg: "No required fields — all entries will be structurally valid even if empty" });
    if (disabled > 0) issues.push({ level: "warn", msg: `${disabled} disabled field(s) still in schema (dead weight)` });
    if (omitted > 0) issues.push({ level: "warn", msg: `${omitted} omitted field(s) hidden from Delivery API but still stored` });

    const hasTitle = fields.some((f) =>
      ["title", "name", "heading", "label"].includes(f.id.toLowerCase())
    );
    if (!hasTitle) issues.push({ level: "warn", msg: "No title/name field detected — content may be unidentifiable in references" });

    const hasSlug = fields.some((f) => f.id.toLowerCase() === "slug");
    const isLikelyPage = ct.name.toLowerCase().match(/page|post|article|blog|entry/);
    if (isLikelyPage && !hasSlug) {
      issues.push({ level: "warn", msg: "Page-like content type has no slug field" });
    }

    results.push({ id: ct.sys.id, name: ct.name, fields: { total, required, disabled, omitted, localized }, issues });
  }

  const lines = [];
  lines.push(`# Content Model Audit`);
  lines.push(`Space: ${requireEnv("CONTENTFUL_SPACE_ID")} · Environment: ${CONTENTFUL_ENVIRONMENT}`);
  lines.push(`Scanned ${results.length} content type(s)\n`);

  for (const r of results) {
    const worstLevel = r.issues.some((i) => i.level === "error") ? "error"
      : r.issues.some((i) => i.level === "warn") ? "warn" : "ok";
    lines.push(`${severity(worstLevel)} **${r.name}** (\`${r.id}\`)`);
    lines.push(`   Fields: ${r.fields.total} total · ${r.fields.required} required · ${r.fields.localized} localized · ${r.fields.disabled} disabled · ${r.fields.omitted} omitted`);
    if (r.issues.length === 0) {
      lines.push(`   ✓ No issues detected`);
    } else {
      for (const issue of r.issues) lines.push(`   ${severity(issue.level)} ${issue.msg}`);
    }
    lines.push("");
  }

  const errorCount = results.filter((r) => r.issues.some((i) => i.level === "error")).length;
  const warnCount = results.filter((r) => r.issues.some((i) => i.level === "warn")).length;
  const okCount = results.length - errorCount - warnCount;
  lines.push("---");
  lines.push(`**Summary:** 🔴 ${errorCount} errors · 🟡 ${warnCount} warnings · 🟢 ${okCount} clean`);
  return lines.join("\n");
}

async function findOrphanedEntries({ content_type_id, limit = 50 }) {
  const delivery = getDeliveryClient();

  const params = { limit, include: 0 };
  if (content_type_id) params.content_type = content_type_id;
  const allEntries = await delivery.getEntries(params);
  const allIds = new Set(allEntries.items.map((e) => e.sys.id));

  const referenced = new Set();
  let skip = 0;
  let total = Infinity;
  while (skip < total) {
    const page = await delivery.getEntries({ limit: 200, skip, include: 1 });
    total = page.total;
    for (const entry of page.items) {
      for (const locale of Object.values(entry.fields ?? {})) {
        const val = Array.isArray(locale) ? locale : [locale];
        for (const v of val) {
          if (v?.sys?.type === "Entry") referenced.add(v.sys.id);
          if (Array.isArray(v)) {
            for (const item of v) {
              if (item?.sys?.type === "Entry") referenced.add(item.sys.id);
            }
          }
        }
      }
    }
    skip += 200;
    if (skip >= 1000) break;
  }

  const orphans = allEntries.items.filter((e) => !referenced.has(e.sys.id));

  const lines = [];
  lines.push(`# Orphaned Entry Report`);
  lines.push(`Content type filter: ${content_type_id ?? "all"}`);
  lines.push(`Scanned ${allEntries.total} entries · Found **${orphans.length} orphans** (no incoming references)\n`);

  if (orphans.length === 0) {
    lines.push("🟢 No orphaned entries found.");
  } else {
    const rows = orphans.map((e) => {
      const titleField = Object.values(e.fields ?? {})[0];
      const title = typeof titleField === "string" ? titleField : titleField?.["en-US"] ?? "(untitled)";
      return [e.sys.id, e.sys.contentType?.sys?.id ?? "unknown", String(title).slice(0, 48), new Date(e.sys.updatedAt).toLocaleDateString()];
    });
    lines.push(formatTable(rows, ["Entry ID", "Content Type", "Title", "Last Updated"]));
    lines.push("");
    lines.push(`> These entries exist in the space but are not linked from any other entry.`);
  }
  return lines.join("\n");
}

async function findMissingFields({ content_type_id, limit = 100 }) {
  const delivery = getDeliveryClient();
  const management = await getManagementEnvironment();

  if (!content_type_id) {
    return "⚠️ content_type_id is required for find_missing_fields.";
  }

  const ct = await management.getContentType(content_type_id);
  const entries = await delivery.getEntries({ content_type: content_type_id, limit });
  const problems = [];

  for (const entry of entries.items) {
    const missingRequired = [];
    const emptyOptional = [];

    for (const field of ct.fields) {
      if (field.disabled || field.omitted) continue;
      const value = entry.fields?.[field.id];
      const isEmpty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
      if (field.required && isEmpty) missingRequired.push(field.id);
      else if (!field.required && isEmpty) emptyOptional.push(field.id);
    }

    if (missingRequired.length > 0) {
      problems.push({ id: entry.sys.id, severity: "error", missing: missingRequired, empty: emptyOptional, updated: new Date(entry.sys.updatedAt).toLocaleDateString() });
    } else if (emptyOptional.length > ct.fields.filter(f => f.required).length) {
      problems.push({ id: entry.sys.id, severity: "warn", missing: [], empty: emptyOptional, updated: new Date(entry.sys.updatedAt).toLocaleDateString() });
    }
  }

  const lines = [];
  lines.push(`# Missing Fields Report`);
  lines.push(`Content type: **${ct.name}** (\`${content_type_id}\`)`);
  lines.push(`Scanned ${entries.items.length} of ${entries.total} entries\n`);

  const errors = problems.filter((p) => p.severity === "error");
  const warnings = problems.filter((p) => p.severity === "warn");

  if (problems.length === 0) {
    lines.push("🟢 All scanned entries pass field completeness checks.");
  } else {
    if (errors.length > 0) {
      lines.push(`### 🔴 ${errors.length} entries missing required fields`);
      for (const p of errors) {
        lines.push(`- \`${p.id}\` (updated ${p.updated})`);
        lines.push(`  Missing: ${p.missing.map((f) => `\`${f}\``).join(", ")}`);
      }
      lines.push("");
    }
    if (warnings.length > 0) {
      lines.push(`### 🟡 ${warnings.length} entries with sparse optional field coverage`);
      for (const p of warnings) {
        lines.push(`- \`${p.id}\` — empty: ${p.empty.map((f) => `\`${f}\``).join(", ")}`);
      }
    }
  }
  return lines.join("\n");
}

const server = new McpServer({ name: "contentful-audit", version: "1.0.0" });

server.tool(
  "audit_content_model",
  "Audit the health of your Contentful content model: field coverage, required vs optional ratios, disabled/omitted fields, missing title or slug fields.",
  {
    content_type_id: z.string().optional().describe("Content type ID to audit. Omit to audit all content types."),
  },
  async ({ content_type_id }) => ({
    content: [{ type: "text", text: await auditContentModel({ content_type_id }) }],
  })
);

server.tool(
  "find_orphaned_entries",
  "Find entries that exist in Contentful but are not referenced by any other entry.",
  {
    content_type_id: z.string().optional().describe("Filter to a specific content type. Omit to check all."),
    limit: z.number().int().min(1).max(200).optional().default(50).describe("Max entries to scan."),
  },
  async ({ content_type_id, limit }) => ({
    content: [{ type: "text", text: await findOrphanedEntries({ content_type_id, limit }) }],
  })
);

server.tool(
  "find_missing_fields",
  "Scan entries of a content type and report missing required fields or sparse optional coverage.",
  {
    content_type_id: z.string().describe("The content type ID to scan. Required."),
    limit: z.number().int().min(1).max(200).optional().default(100).describe("Max entries to scan."),
  },
  async ({ content_type_id, limit }) => ({
    content: [{ type: "text", text: await findMissingFields({ content_type_id, limit }) }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);