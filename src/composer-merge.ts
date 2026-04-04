export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function parseComposerHeadersBlob(raw: string | undefined): {
  allComposers: Array<Record<string, unknown>>;
} {
  if (!raw) {
    return { allComposers: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>).allComposers)
    ) {
      return {
        allComposers: (parsed as { allComposers: Array<Record<string, unknown>> }).allComposers,
      };
    }
  } catch {}
  return { allComposers: [] };
}

export function getComposerId(record: Record<string, unknown>): string {
  const id = record.composerId;
  return typeof id === "string" && id.length > 0 ? id : "";
}

function mergeComposerHeadersAdditive(
  existing: { allComposers: Array<Record<string, unknown>> },
  imported: Record<string, unknown>
): { allComposers: Array<Record<string, unknown>> } {
  const byId = new Map<string, Record<string, unknown>>();
  for (const c of existing.allComposers) {
    const id = getComposerId(c);
    if (id) {
      byId.set(id, { ...c });
    }
  }
  const importedList = Array.isArray(imported.allComposers) ? imported.allComposers : [];
  for (const c of importedList) {
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      continue;
    }
    const rec = c as Record<string, unknown>;
    const id = getComposerId(rec);
    if (!id) {
      continue;
    }
    if (byId.has(id)) {
      byId.set(id, { ...byId.get(id)!, ...rec });
    } else {
      byId.set(id, { ...rec });
    }
  }
  // Ensure every entry has the required `type` field — Cursor ignores entries without it
  const result = [...byId.values()].map((entry) => {
    if (!entry.type) {
      return { ...entry, type: "head" };
    }
    return entry;
  });
  return { allComposers: result };
}

export function mergeComposerHeadersChain(
  existingRaw: string | undefined,
  importedPayloads: Array<Record<string, unknown>>
): { allComposers: Array<Record<string, unknown>> } {
  let acc = parseComposerHeadersBlob(existingRaw);
  for (const imp of importedPayloads) {
    acc = mergeComposerHeadersAdditive(acc, imp);
  }
  return acc;
}

export function extractComposerHeadersPayload(
  parsed: Record<string, unknown>
): Record<string, unknown> | undefined {
  const ch = parsed.composerHeaders;
  if (ch && typeof ch === "object" && !Array.isArray(ch)) {
    return ch as Record<string, unknown>;
  }
  const cr = parsed.composerHeadersRestore;
  if (cr && typeof cr === "object" && !Array.isArray(cr)) {
    return cr as Record<string, unknown>;
  }
  const rows = parsed.matchedItemTableRows;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        continue;
      }
      const rec = row as Record<string, unknown>;
      if (rec.key !== "composer.composerHeaders") {
        continue;
      }
      const v = rec.value;
      if (typeof v === "string") {
        const t = v.trim();
        if (t.endsWith("…") || t.endsWith("...")) {
          return undefined;
        }
        try {
          const parsedInner = JSON.parse(t) as unknown;
          if (parsedInner && typeof parsedInner === "object" && !Array.isArray(parsedInner)) {
            return parsedInner as Record<string, unknown>;
          }
        } catch {
          return undefined;
        }
      }
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return v as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

export function extractComposerDataPayload(
  parsed: Record<string, unknown>
): Record<string, unknown> | undefined {
  const direct = parsed.composerData;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }
  const restore = parsed.composerDataRestore;
  if (restore && typeof restore === "object" && !Array.isArray(restore)) {
    return restore as Record<string, unknown>;
  }
  const rows = parsed.matchedItemTableRows;
  if (!Array.isArray(rows)) {
    return undefined;
  }
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const rec = row as Record<string, unknown>;
    if (rec.key !== "composer.composerData") {
      continue;
    }
    const v = rec.value;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    if (typeof v !== "string") {
      continue;
    }
    const t = v.trim();
    if (t.endsWith("…") || t.endsWith("...")) {
      return undefined;
    }
    try {
      const parsedInner = JSON.parse(t) as unknown;
      if (parsedInner && typeof parsedInner === "object" && !Array.isArray(parsedInner)) {
        return parsedInner as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function mergeComposerDataAdditive(
  existingRaw: string | undefined,
  importedPayloads: Array<Record<string, unknown>>
): Record<string, unknown> {
  const parseBlob = (raw: string | undefined): Record<string, unknown> => {
    if (!raw || raw.trim().length === 0) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
    return {};
  };

  const mergeComposerArray = (
    baseValue: unknown,
    importedValue: unknown
  ): Array<Record<string, unknown>> | undefined => {
    if (!Array.isArray(baseValue) || !Array.isArray(importedValue)) {
      return undefined;
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const entry of baseValue) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const rec = entry as Record<string, unknown>;
      const id = getComposerId(rec);
      if (id) {
        byId.set(id, { ...rec });
      }
    }
    for (const entry of importedValue) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const rec = entry as Record<string, unknown>;
      const id = getComposerId(rec);
      if (!id) {
        continue;
      }
      if (byId.has(id)) {
        byId.set(id, { ...byId.get(id)!, ...rec });
      } else {
        byId.set(id, { ...rec });
      }
    }
    return [...byId.values()];
  };

  let merged = parseBlob(existingRaw);
  for (const imported of importedPayloads) {
    const next: Record<string, unknown> = { ...merged };
    for (const [key, value] of Object.entries(imported)) {
      if (!(key in next)) {
        next[key] = value;
        continue;
      }
      const mergedArray = mergeComposerArray(next[key], value);
      if (mergedArray) {
        next[key] = mergedArray;
      }
    }
    merged = next;
  }
  return merged;
}

export function deriveComposerHeadersPayloadFromSidebarSnapshot(
  parsed: Record<string, unknown>
): Record<string, unknown> | undefined {
  const conversationId = parsed.conversationId;
  if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
    return undefined;
  }
  const title =
    typeof parsed.title === "string" && parsed.title.trim().length > 0
      ? parsed.title
      : conversationId;
  const subtitle = typeof parsed.subtitle === "string" ? parsed.subtitle : "";
  const rawTimestamp = parsed.lastUpdatedAt;
  // Cursor expects epoch milliseconds as NUMBER, not ISO string
  let timestamp: number;
  if (typeof rawTimestamp === "number") {
    timestamp = rawTimestamp;
  } else if (typeof rawTimestamp === "string" && rawTimestamp.trim().length > 0) {
    const parsedDate = Date.parse(rawTimestamp);
    timestamp = isNaN(parsedDate) ? Date.now() : parsedDate;
  } else {
    timestamp = Date.now();
  }
  // CRITICAL: Always include type: "head" - Cursor ignores entries without this
  return {
    allComposers: [
      {
        type: "head",
        composerId: conversationId,
        name: title,
        subtitle,
        lastUpdatedAt: timestamp,
        lastOpenedAt: timestamp,
        createdAt: timestamp,
        hasUnreadMessages: false,
        isArchived: false,
        isDraft: false,
        unifiedMode: "agent",
        forceMode: "edit",
      },
    ],
  };
}
