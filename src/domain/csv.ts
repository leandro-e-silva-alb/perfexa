import Papa from "papaparse";
import { z } from "zod";
import type { ValidationIssue } from "./types";

export interface CsvParseResult<T> {
  rows: T[];
  issues: ValidationIssue[];
}

export function parseCsvRows<T>(
  file: string,
  text: string,
  requiredColumns: string[],
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
): CsvParseResult<T> {
  const issues: ValidationIssue[] = [];
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
    transform: (value) => value.trim()
  });

  for (const error of parsed.errors) {
    issues.push({
      severity: "error",
      file,
      path: error.row === undefined ? undefined : `${file}:${error.row + 2}`,
      message: error.message
    });
  }

  const fields = parsed.meta.fields ?? [];
  for (const column of requiredColumns) {
    if (!fields.includes(column)) {
      issues.push({
        severity: "error",
        file,
        message: `Missing required column "${column}".`
      });
    }
  }

  const rows: T[] = [];
  parsed.data.forEach((row, index) => {
    if ("__parsed_extra" in row) {
      issues.push({
        severity: "warning",
        file,
        path: `${file}:${index + 2}`,
        message: "Row has more cells than headers. Extra values were ignored."
      });
    }

    const result = schema.safeParse(row);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({
          severity: "error",
          file,
          path: `${file}:${index + 2}:${issue.path.join(".")}`,
          message: issue.message
        });
      }
      return;
    }
    rows.push(result.data);
  });

  return { rows, issues };
}
