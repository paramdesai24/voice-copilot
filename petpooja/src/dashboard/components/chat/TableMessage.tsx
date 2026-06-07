"use client";

import { useState, useMemo } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Sortable Table — renders structured data inside chat bubble
// ─────────────────────────────────────────────────────────────────────────────

interface TableMessageProps {
  title: string;
  rows: Record<string, string | number>[];
}

export default function TableMessage({ title, rows }: TableMessageProps) {
  const columns = useMemo(() => {
    if (rows.length === 0) return [];
    return Object.keys(rows[0]);
  }, [rows]);

  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortAsc, setSortAsc] = useState(true);

  const sorted = useMemo(() => {
    if (!sortCol) return rows;
    return [...rows].sort((a, b) => {
      const va = a[sortCol];
      const vb = b[sortCol];
      if (typeof va === "number" && typeof vb === "number") {
        return sortAsc ? va - vb : vb - va;
      }
      return sortAsc
        ? String(va).localeCompare(String(vb))
        : String(vb).localeCompare(String(va));
    });
  }, [rows, sortCol, sortAsc]);

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
  };

  if (rows.length === 0) return null;

  return (
    <div style={{ width: "100%", marginTop: 6 }}>
      {title && (
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1e293b", marginBottom: 6 }}>
          {title}
        </div>
      )}
      <div style={{ overflowX: "auto", borderRadius: 8, border: "1px solid #e2e8f0" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, lineHeight: 1.5 }}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                  style={{
                    textAlign: "left",
                    padding: "7px 10px",
                    borderBottom: "2px solid #e2e8f0",
                    fontWeight: 700,
                    color: "#374151",
                    whiteSpace: "nowrap",
                    background: "#f8fafc",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  {col}
                  {sortCol === col ? (sortAsc ? " \u25B2" : " \u25BC") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, ri) => (
              <tr key={ri} style={{ background: ri % 2 === 0 ? "#fff" : "#f9fafb" }}>
                {columns.map((col) => (
                  <td
                    key={col}
                    style={{
                      padding: "6px 10px",
                      borderBottom: "1px solid #f1f5f9",
                      whiteSpace: "nowrap",
                      color: "#1e293b",
                    }}
                  >
                    {row[col]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
