"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Quick Action buttons — always visible above the input area
// ─────────────────────────────────────────────────────────────────────────────

const ACTIONS = [
  { label: "Top Items", prompt: "What are my top 5 selling items?" },
  { label: "Revenue Trend", prompt: "Show revenue trend" },
  { label: "Hidden Gold", prompt: "Which items are hidden gold?" },
  { label: "Upsell", prompt: "Which items should I upsell tonight?" },
  { label: "Best Combos", prompt: "What combos should I promote?" },
  { label: "Peak Hours", prompt: "Show peak order hours" },
  { label: "Margins", prompt: "Show top 5 highest margin items" },
  { label: "Veg Items", prompt: "Show all vegetarian items" },
];

interface QuickActionsProps {
  onSend: (text: string) => void;
  disabled?: boolean;
}

export default function QuickActions({ onSend, disabled }: QuickActionsProps) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        padding: "8px 0",
        flexShrink: 0,
      }}
    >
      {ACTIONS.map((a) => (
        <button
          key={a.label}
          onClick={() => onSend(a.prompt)}
          disabled={disabled}
          style={{
            padding: "5px 12px",
            fontSize: 12,
            fontWeight: 500,
            borderRadius: 16,
            border: "1px solid #e2e8f0",
            background: "#fff",
            color: "#475569",
            cursor: disabled ? "not-allowed" : "pointer",
            transition: "all 0.15s",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}
          onMouseEnter={(e) => {
            if (disabled) return;
            e.currentTarget.style.background = "#fef5f4";
            e.currentTarget.style.borderColor = "#B22234";
            e.currentTarget.style.color = "#B22234";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "#fff";
            e.currentTarget.style.borderColor = "#e2e8f0";
            e.currentTarget.style.color = "#475569";
          }}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
