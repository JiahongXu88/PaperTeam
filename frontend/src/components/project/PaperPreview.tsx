/** Decorative document cover, deliberately labelled: this is not a rendered PDF page. */
export function PaperPreview({ title, compact = false }: { title: string; compact?: boolean }) {
  return <div className={`paper-preview${compact ? " paper-preview-compact" : ""}`} role="img" aria-label="论文封面示意，非 PDF 原页">
    <div className="paper-preview-sheet" aria-hidden="true">
      <span className="paper-preview-rule" />
      <strong data-title={title} />
      <span className="paper-preview-byline" />
      <div className="paper-preview-abstract" />
      <div className="paper-preview-columns"><i /><i /></div>
      <span className="paper-preview-number">1</span>
    </div>
    {!compact && <span className="paper-preview-caption">PDF · 文档示意</span>}
  </div>;
}
