import type { SVGProps } from "react";

/**
 * 内联 SVG 图标集（16×16 网格，1.6 描边，currentColor）。
 * 只收录界面实际用到的图形；装饰性使用时 aria-hidden，独立承载语义时由调用方给 aria-label。
 */

export type IconName =
  | "document"
  | "grid"
  | "gear"
  | "sun"
  | "moon"
  | "monitor"
  | "plus"
  | "chevron-right"
  | "chevron-down"
  | "link"
  | "file-pdf"
  | "clock"
  | "download"
  | "play"
  | "refresh"
  | "alert-circle"
  | "alert-triangle"
  | "info-circle"
  | "minus-circle"
  | "check-circle"
  | "more"
  | "edit"
  | "search"
  | "filter"
  | "sort"
  | "quote"
  | "book"
  | "list"
  | "upload"
  | "archive"
  | "external"
  | "hash"
  | "cpu"
  | "layers";

const PATHS: Record<IconName, string> = {
  document: "M4 2h6l3 3v9H4z M10 2v3h3 M6.5 8.5h4 M6.5 11h3",
  grid: "M2.5 2.5h4.5v4.5H2.5z M9 2.5h4.5v4.5H9z M2.5 9h4.5v4.5H2.5z M9 9h4.5v4.5H9z",
  gear: "M8 10.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z M13.2 9.6l-.9-.5a4.6 4.6 0 0 0 0-2.2l.9-.5-1-1.7-.9.5a4.6 4.6 0 0 0-1.9-1.1V3H7.5v1.1a4.6 4.6 0 0 0-1.9 1.1l-.9-.5-1 1.7.9.5a4.6 4.6 0 0 0 0 2.2l-.9.5 1 1.7.9-.5a4.6 4.6 0 0 0 1.9 1.1V13h1.9v-1.1a4.6 4.6 0 0 0 1.9-1.1l.9.5z",
  sun: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M8 1.5v1.6 M8 12.9v1.6 M1.5 8h1.6 M12.9 8h1.6 M3.4 3.4l1.1 1.1 M11.5 11.5l1.1 1.1 M3.4 12.6l1.1-1.1 M11.5 4.5l1.1-1.1",
  moon: "M13.3 9.7A5.6 5.6 0 0 1 6.3 2.7a5.6 5.6 0 1 0 7 7z",
  monitor: "M2 3h12v8H2z M6 14h4 M8 11v3",
  plus: "M8 3v10 M3 8h10",
  "chevron-right": "M6 3.5 10.5 8 6 12.5",
  "chevron-down": "M3.5 6 8 10.5 12.5 6",
  link: "M6.5 9.5 9.5 6.5 M7 4.5l1.3-1.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8 M9 11.5l-1.3 1.3a2.5 2.5 0 0 1-3.5-3.5L5.5 8",
  "file-pdf": "M4 2h6l3 3v9H4z M10 2v3h3 M5.5 12v-4h1.4a1.3 1.3 0 0 1 0 2.6H5.5 M9 12V8h2 M9 10h1.6",
  clock: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z M8 4.8V8l2.2 1.4",
  download: "M8 2.5v8 M4.8 7.3 8 10.5l3.2-3.2 M3 13h10",
  play: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z M6.6 5.6v4.8L10.4 8z",
  refresh: "M13 8a5 5 0 0 1-8.6 3.5 M3 8a5 5 0 0 1 8.6-3.5 M11.5 2v2.8h-2.8 M4.5 14v-2.8h2.8",
  "alert-circle": "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z M8 5v3.6 M8 11h.01",
  "alert-triangle": "M8 2.5 14 13H2z M8 6.5v3 M8 11.4h.01",
  "info-circle": "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z M8 7.4V11 M8 5h.01",
  "minus-circle": "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z M5.2 8h5.6",
  "check-circle": "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z M5.3 8.2 7.2 10l3.5-3.8",
  more: "M3.5 8h.01 M8 8h.01 M12.5 8h.01",
  edit: "M11.5 2.5l2 2L5 13H3v-2z",
  search: "M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10z M10.6 10.6 14 14",
  filter: "M2 3h12L9.5 8.5V13l-3-1.5V8.5z",
  sort: "M5 3v10 M2.5 10.5 5 13l2.5-2.5 M11 13V3 M8.5 5.5 11 3l2.5 2.5",
  quote: "M5.5 4.5H3v3.5h2.5V10c0 .8-.6 1.5-1.5 1.5 M12.5 4.5H10v3.5h2.5V10c0 .8-.6 1.5-1.5 1.5",
  book: "M2.5 3.5c1.8-.8 3.7-.8 5.5 0v9c-1.8-.8-3.7-.8-5.5 0z M13.5 3.5c-1.8-.8-3.7-.8-5.5 0v9c1.8-.8 3.7-.8 5.5 0z",
  list: "M5.5 4h8 M5.5 8h8 M5.5 12h8 M2.5 4h.01 M2.5 8h.01 M2.5 12h.01",
  upload: "M8 10.5v-8 M4.8 5.7 8 2.5l3.2 3.2 M3 13h10",
  archive: "M2.5 3h11v3h-11z M3.5 6v7h9V6 M6.5 9h3",
  external: "M9 2.5h4.5V7 M13.5 2.5 7.5 8.5 M11.5 9.5v4h-9v-9h4",
  hash: "M6 2.5 4.5 13.5 M11.5 2.5 10 13.5 M2.5 6h11 M2 10h11",
  cpu: "M4.5 4.5h7v7h-7z M6.5 6.5h3v3h-3z M8 1.5v3 M8 11.5v3 M1.5 8h3 M11.5 8h3",
  layers: "M8 2.5 14 5.5 8 8.5 2 5.5z M2 8.5l6 3 6-3 M2 11.5l6 3 6-3",
};

export function Icon({ name, className, ...rest }: { name: IconName } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`icon${className !== undefined ? ` ${className}` : ""}`}
      aria-hidden={rest["aria-label"] === undefined ? true : undefined}
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
