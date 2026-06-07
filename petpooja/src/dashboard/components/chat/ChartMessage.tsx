"use client";

import ReactEChartsCore from "echarts-for-react/lib/core";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  CanvasRenderer,
]);

// ─────────────────────────────────────────────────────────────────────────────
// Chart message component — renders ECharts inside chat bubble
// ─────────────────────────────────────────────────────────────────────────────

interface ChartData {
  chartType: "bar" | "line" | "pie";
  title: string;
  data: { name: string; value: number }[];
  xKey?: string;
  yKey?: string;
}

export default function ChartMessage({ chartType, title, data }: ChartData) {
  const colors = [
    "#6366f1", "#8b5cf6", "#a78bfa", "#c4b5fd",
    "#818cf8", "#4f46e5", "#7c3aed", "#5b21b6",
  ];

  const getOption = () => {
    if (chartType === "pie") {
      return {
        title: { text: title, left: "center", top: 6, textStyle: { fontSize: 13, fontWeight: 700, color: "#1e293b" } },
        tooltip: { trigger: "item", formatter: "{b}: Rs.{c} ({d}%)" },
        series: [
          {
            type: "pie",
            radius: ["35%", "65%"],
            center: ["50%", "55%"],
            data: data.map((d, i) => ({ ...d, itemStyle: { color: colors[i % colors.length] } })),
            label: { fontSize: 11, color: "#475569" },
            emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0,0,0,0.15)" } },
          },
        ],
      };
    }

    if (chartType === "line") {
      return {
        title: { text: title, left: "center", top: 6, textStyle: { fontSize: 13, fontWeight: 700, color: "#1e293b" } },
        tooltip: { trigger: "axis" },
        grid: { left: 50, right: 20, top: 46, bottom: 30 },
        xAxis: {
          type: "category",
          data: data.map((d) => d.name),
          axisLabel: { fontSize: 10, rotate: 30, color: "#64748b" },
          axisLine: { lineStyle: { color: "#e2e8f0" } },
        },
        yAxis: {
          type: "value",
          axisLabel: { fontSize: 10, color: "#64748b" },
          splitLine: { lineStyle: { color: "#f1f5f9" } },
        },
        series: [
          {
            type: "line",
            data: data.map((d) => d.value),
            smooth: true,
            lineStyle: { color: "#6366f1", width: 2.5 },
            areaStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: "rgba(99,102,241,0.25)" },
                { offset: 1, color: "rgba(99,102,241,0.02)" },
              ]),
            },
            itemStyle: { color: "#6366f1" },
          },
        ],
      };
    }

    // bar
    return {
      title: { text: title, left: "center", top: 6, textStyle: { fontSize: 13, fontWeight: 700, color: "#1e293b" } },
      tooltip: { trigger: "axis" },
      grid: { left: 50, right: 20, top: 46, bottom: 60 },
      xAxis: {
        type: "category",
        data: data.map((d) => d.name),
        axisLabel: { fontSize: 10, rotate: 35, color: "#64748b", interval: 0 },
        axisLine: { lineStyle: { color: "#e2e8f0" } },
      },
      yAxis: {
        type: "value",
        axisLabel: { fontSize: 10, color: "#64748b" },
        splitLine: { lineStyle: { color: "#f1f5f9" } },
      },
      series: [
        {
          type: "bar",
          data: data.map((d, i) => ({ value: d.value, itemStyle: { color: colors[i % colors.length], borderRadius: [4, 4, 0, 0] } })),
          barMaxWidth: 36,
        },
      ],
    };
  };

  return (
    <div style={{ width: "100%", marginTop: 6 }}>
      <ReactEChartsCore
        echarts={echarts}
        option={getOption()}
        style={{ height: 260, width: "100%" }}
        notMerge
        lazyUpdate
      />
    </div>
  );
}
