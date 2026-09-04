/** 本地时间格式化：`YYYY-MM-DD HH:mm`；非法输入原样返回 */
export function formatDateTime(iso: string | undefined): string | undefined {
  if (iso === undefined || iso === "") {
    return undefined;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
